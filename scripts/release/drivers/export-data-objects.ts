import https from "node:https";
import { S3Client, CreateBucketCommand, GetBucketTaggingCommand, HeadBucketCommand, PutBucketTaggingCommand, PutObjectCommand, ListObjectsV2Command, GetObjectCommand, DeleteObjectCommand, DeleteBucketCommand } from "@aws-sdk/client-s3";
import type { DataLeg, LegContext, LegEndpoint } from "./export-data-leg";
import { assertEqualContent, knownData, objectWitness, pinnedFixtureImages } from "./export-data-plan";

const ownerTag = "zenith-owner";
const bucketFor = (ctx: LegContext, tenant: "a" | "b") => `drv4-${ctx.runId}-data-${tenant}`;
const tenantEndpoint = (endpoint: LegEndpoint, ctx: LegContext, tenant: "a" | "b"): LegEndpoint => ({ ...endpoint, bucket: bucketFor(ctx, tenant) });
function clientFor(endpoint: LegEndpoint, ctx: LegContext): S3Client {
  knownData(ctx.runId, ctx.tenant);
  const url = new URL(endpoint.url);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.pathname !== "/" || url.search || url.hash
    || !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) || !url.port
    || endpoint.bucket !== bucketFor(ctx, ctx.tenant)
    || !endpoint.user || !endpoint.password || ctx.ownerLabel !== `DRV4-DATA:${ctx.runId}`) throw new Error("Invalid owned object-store endpoint");
  return new S3Client({ endpoint: url.origin, region: "us-east-1", forcePathStyle: true,
    credentials: { accessKeyId: endpoint.user, secretAccessKey: endpoint.password },
    requestHandler: { connectionTimeout: 5_000, requestTimeout: 60_000, httpsAgent: new https.Agent({ rejectUnauthorized: true }) },
  });
}
function missing(error: unknown): boolean {
  return (error as { name?: string })?.name === "NoSuchBucket";
}
async function owned(client: S3Client, endpoint: LegEndpoint, ctx: LegContext): Promise<void> {
  const result = await client.send(new GetBucketTaggingCommand({ Bucket: endpoint.bucket })).catch(async (error: unknown) => {
    // Current MinIO answers NoSuchTagSet for an absent bucket too (AWS answers NoSuchBucket): HeadBucket decides.
    // Absent stays "missing"; an existing but untagged bucket is not ours.
    if ((error as { name?: string })?.name !== "NoSuchTagSet") throw error;
    const absent = await client.send(new HeadBucketCommand({ Bucket: endpoint.bucket })).then(() => false,
      (head: unknown) => { if ((head as { name?: string; $metadata?: { httpStatusCode?: number } })?.$metadata?.httpStatusCode === 404) return true; throw head; });
    if (absent) throw Object.assign(new Error("Object-store bucket is absent"), { name: "NoSuchBucket" });
    throw new Error("Object-store bucket ownership mismatch");
  });
  if (!result.TagSet?.some(tag => tag.Key === ownerTag && tag.Value === ctx.ownerLabel)) throw new Error("Object-store bucket ownership mismatch");
}
async function keys(client: S3Client, endpoint: LegEndpoint): Promise<string[]> {
  const result: string[] = [];
  const seen = new Set<string>();
  let token: string | undefined;
  do {
    const page = await client.send(new ListObjectsV2Command({ Bucket: endpoint.bucket, ContinuationToken: token }));
    for (const object of page.Contents ?? []) {
      if (object.Key === undefined || result.includes(object.Key)) throw new Error("Invalid object-store listing");
      result.push(object.Key);
    }
    token = page.IsTruncated ? page.NextContinuationToken : undefined;
    if (page.IsTruncated && (!token || seen.has(token))) throw new Error("Invalid object-store pagination");
    if (token) seen.add(token);
  } while (token);
  return result;
}
async function withClient<T>(endpoint: LegEndpoint, ctx: LegContext, action: (client: S3Client) => Promise<T>): Promise<T> {
  const client = clientFor(endpoint, ctx);
  try { return await action(client); } finally { client.destroy(); }
}
async function read(client: S3Client, endpoint: LegEndpoint, ctx: LegContext) {
  await owned(client, endpoint, ctx);
  const objects = [];
  for (const key of await keys(client, endpoint)) {
    const object = await client.send(new GetObjectCommand({ Bucket: endpoint.bucket, Key: key }));
    if (!object.Body || !object.ContentType) throw new Error("Incomplete object-store readback");
    objects.push({ key, bytes: Buffer.from(await object.Body.transformToByteArray()), contentType: object.ContentType });
  }
  return objectWitness(objects);
}

/** Source seeding and independent target readback only; product export/import runs elsewhere.
 * LIFE-11 exports whole buckets: tenants must never share a source bucket.
 * The orchestrator provisions both empty target buckets with the zenith-owner tag.
 */
export const objectStoreLeg: DataLeg = {
  kind: "object_store",
  image: env => pinnedFixtureImages(env).object_store,
  seedSource: ctx => withClient(ctx.source, ctx, async source => withClient(ctx.target, ctx, async target => {
    // Inspect every export unit before writing any customer data. Never overwrite prepopulation.
    for (const tenant of ["a", "b"] as const) {
      const endpoint = tenantEndpoint(ctx.target, ctx, tenant);
      await owned(target, endpoint, ctx);
      if ((await keys(target, endpoint)).length) throw new Error("Object-store target bucket is not empty");
    }
    for (const tenant of ["a", "b"] as const) {
      const endpoint = tenantEndpoint(ctx.source, ctx, tenant);
      try { await owned(source, endpoint, ctx); }
      catch (error) {
        if (!missing(error)) throw error;
        await source.send(new CreateBucketCommand({ Bucket: endpoint.bucket }));
        await source.send(new PutBucketTaggingCommand({ Bucket: endpoint.bucket, Tagging: { TagSet: [{ Key: ownerTag, Value: ctx.ownerLabel }] } }));
      }
      await owned(source, endpoint, ctx);
      if ((await keys(source, endpoint)).length) throw new Error("Object-store source bucket is not empty");
    }
    for (const tenant of ["a", "b"] as const) {
      const endpoint = tenantEndpoint(ctx.source, ctx, tenant);
      for (const object of knownData(ctx.runId, tenant).objects) {
        await source.send(new PutObjectCommand({ Bucket: endpoint.bucket, Key: object.key, Body: object.bytes, ContentType: object.contentType }));
      }
      assertEqualContent(objectWitness(knownData(ctx.runId, tenant).objects), await read(source, endpoint, ctx));
    }
    return read(source, ctx.source, ctx);
  })),
  readTarget: ctx => withClient(ctx.target, ctx, client => read(client, ctx.target, ctx)),
  assertNoForeignTenant: ctx => withClient(ctx.target, ctx, async client => {
    assertEqualContent(objectWitness(knownData(ctx.runId, ctx.tenant).objects), await read(client, ctx.target, ctx));
    const foreign = tenantEndpoint(ctx.target, ctx, ctx.tenant === "a" ? "b" : "a");
    await owned(client, foreign, ctx);
    if ((await keys(client, foreign)).length) throw new Error("Foreign tenant target bucket is not empty");
  }),
  cleanup: async ctx => {
    const errors: unknown[] = [];
    for (const base of [ctx.target, ctx.source]) for (const tenant of ["b", "a"] as const) {
      const endpoint = tenantEndpoint(base, ctx, tenant);
      try {
        await withClient(endpoint, { ...ctx, tenant }, async client => {
          try { await owned(client, endpoint, ctx); } catch (error) { if (missing(error)) return; throw error; }
          for (const key of await keys(client, endpoint)) await client.send(new DeleteObjectCommand({ Bucket: endpoint.bucket, Key: key }));
          await client.send(new DeleteBucketCommand({ Bucket: endpoint.bucket }));
          try { await owned(client, endpoint, ctx); } catch (error) { if (missing(error)) return; throw error; }
          throw new Error("Owned object-store bucket survived cleanup");
        });
      } catch (error) { errors.push(error); }
    }
    if (errors.length) throw new AggregateError(errors, "Owned object-store cleanup failed");
  },
};
