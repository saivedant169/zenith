/**
 * PROD-DUR-06: the S3 state adapter against a REAL S3-compatible server (MinIO) in an owned, disposable container.
 * Gated by ZENITH_TEST_MINIO=1. The store is built through s3StoreFromSession; the session hands it the real AWS SDK
 * client pointed at MinIO (path-style, 127.0.0.1). Nothing is faked here. Where MinIO lacks a feature the adapter
 * needs, that case fails and is reported; it is not simulated. No delete command is ever sent by this suite.
 */
import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as sdk from "@aws-sdk/client-s3";
import { s3StoreFromSession, type StateBackendStore } from "@/lib/tofu/state-backend-s3";

// Pinned MinIO image. Not resolved yet: the minio/minio Docker Hub repository does not exist from this host and
// quay.io requires authentication. Set ZENITH_TEST_MINIO_IMAGE to a digest-pinned ref (minio/minio@sha256:...) until
// a digest is recorded here.
const DEFAULT_MINIO_IMAGE = "";
const DOCKER = process.env.ZENITH_TEST_DOCKER ?? "docker";
const REGION = "us-east-1";
const PORT = Number(process.env.ZENITH_TEST_MINIO_PORT ?? 55451);
const BASE = `zenith/ws_1/env_${randomBytes(3).toString("hex")}`;
const KEY_MAIN = `${BASE}/main/terraform.tfstate`;
const KEY_RACE = `${BASE}/race/terraform.tfstate`;
const KEY_LOCK = `${BASE}/lock/terraform.tfstate`;

const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");
const bytesOf = (serial: number) => Buffer.from(`{"serial":${serial}}`);

type Command = { constructor: { name: string }; input: Record<string, unknown> };
type S3Ctor = new (config: Record<string, unknown>) => sdk.S3Client;

let container: string | undefined;
let endpoint = "";
let credentials = { accessKeyId: "", secretAccessKey: "" };
const commands: string[] = [];
let versionedBucket = "";
let unversionedBucket = "";
let admin: sdk.S3Client;

function docker(args: string[], env: Record<string, string> = {}): string {
  return execFileSync(DOCKER, args, { encoding: "utf8", env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] }).trim();
}

/**
 * A session in the shape the production broker hands out: client(ctor, overrides) builds the real SDK client. Every
 * send is recorded by command name; `beforeSend` lets one case inject a concurrent writer at an exact point.
 */
function session(beforeSend?: (command: Command) => Promise<void>) {
  return {
    client<C>(ctor: new (config: Record<string, unknown>) => C, overrides?: { region?: string }): C {
      const raw = new ctor({ region: overrides?.region ?? REGION, endpoint, forcePathStyle: true, credentials }) as unknown as { send(command: unknown): Promise<unknown> };
      const send = raw.send.bind(raw);
      raw.send = async (command: unknown) => {
        commands.push((command as Command).constructor.name);
        await beforeSend?.(command as Command);
        return send(command);
      };
      return raw as unknown as C;
    },
  };
}

function store(bucket: string, key: string, beforeSend?: (command: Command) => Promise<void>): Promise<StateBackendStore> {
  return s3StoreFromSession(session(beforeSend), { kind: "s3", bucket }, REGION, key);
}

async function waitHealthy(timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      if ((await fetch(`${endpoint}/minio/health/live`)).ok) return;
    } catch { /* not listening yet */ }
    if (Date.now() > deadline) throw new Error("MinIO did not become healthy in time");
    await new Promise(resolve => setTimeout(resolve, 500));
  }
}

async function createBucket(name: string, versioned: boolean): Promise<void> {
  await admin.send(new sdk.CreateBucketCommand({ Bucket: name }));
  if (versioned) await admin.send(new sdk.PutBucketVersioningCommand({ Bucket: name, VersioningConfiguration: { Status: "Enabled" } }));
  await admin.send(new sdk.PutBucketEncryptionCommand({ Bucket: name, ServerSideEncryptionConfiguration: { Rules: [{ ApplyServerSideEncryptionByDefault: { SSEAlgorithm: "AES256" } }] } }));
}

async function put(bucket: string, key: string, body: Buffer): Promise<{ VersionId?: string; ETag?: string }> {
  return admin.send(new sdk.PutObjectCommand({ Bucket: bucket, Key: key, Body: body, ContentType: "application/json" }));
}

describe.skipIf(process.env.ZENITH_TEST_MINIO !== "1")("S3 state adapter against MinIO", () => {
  let v1 = "";
  let v1Etag = "";

  beforeAll(async () => {
    const image = process.env.ZENITH_TEST_MINIO_IMAGE || DEFAULT_MINIO_IMAGE;
    if (!image) throw new Error("ZENITH_TEST_MINIO=1 but no MinIO image is pinned: set ZENITH_TEST_MINIO_IMAGE or DEFAULT_MINIO_IMAGE.");
    if (!Number.isInteger(PORT) || PORT < 55450 || PORT > 55460) throw new Error("ZENITH_TEST_MINIO_PORT must be within 55450-55460.");
    const name = `zenith-minio-test-${randomBytes(4).toString("hex")}`;
    const root = { user: `zen${randomBytes(6).toString("hex")}`, password: randomBytes(24).toString("hex") };
    // SSE-S3 needs a local KMS key on MinIO. Passed through the environment so it never appears in argv.
    const kmsKey = `zenith-test:${randomBytes(32).toString("base64")}`;
    docker(["run", "-d", "--name", name, "-p", `127.0.0.1:${PORT}:9000`, "-e", "MINIO_ROOT_USER", "-e", "MINIO_ROOT_PASSWORD", "-e", "MINIO_KMS_SECRET_KEY", image, "server", "/data"],
      { MINIO_ROOT_USER: root.user, MINIO_ROOT_PASSWORD: root.password, MINIO_KMS_SECRET_KEY: kmsKey });
    container = name;
    endpoint = `http://127.0.0.1:${PORT}`;
    credentials = { accessKeyId: root.user, secretAccessKey: root.password };
    await waitHealthy(60_000);
    admin = session().client(sdk.S3Client as unknown as S3Ctor, { region: REGION });
    versionedBucket = `zenith-state-v-${randomBytes(4).toString("hex")}`;
    unversionedBucket = `zenith-state-u-${randomBytes(4).toString("hex")}`;
    await createBucket(versionedBucket, true);
    await createBucket(unversionedBucket, false);
    // v1 of the main state object: written by a plain client, before the adapter is involved.
    v1 = (await put(versionedBucket, KEY_MAIN, bytesOf(1))).VersionId ?? "";
    v1Etag = (await admin.send(new sdk.HeadObjectCommand({ Bucket: versionedBucket, Key: KEY_MAIN }))).ETag ?? "";
  }, 180_000);

  afterAll(() => {
    if (container) docker(["rm", "-f", container]);
  });

  it("admission: a versioned SSE-S3 bucket is restore-ready; an unversioned one is refused", async () => {
    const ready = await (await store(versionedBucket, KEY_MAIN)).probe();
    expect(ready).toMatchObject({ backendKind: "s3", versioning: "enabled", encryption: "sse_s3", lockObject: "absent", currentVersionId: v1, restoreReady: true, refusals: [] });

    await put(unversionedBucket, KEY_MAIN, bytesOf(1));
    const refused = await (await store(unversionedBucket, KEY_MAIN)).probe();
    expect(refused).toMatchObject({ versioning: "disabled", encryption: "sse_s3", restoreReady: false });
    expect(refused.refusals).toEqual(["Bucket versioning is disabled."]);
  });

  it("conditional write: the current ETag succeeds as v2; a stale ETag is refused and v2 stays latest", async () => {
    const s = await store(versionedBucket, KEY_MAIN);
    const written = await s.writeRestored(bytesOf(2), { currentEtag: v1Etag });
    const v2 = written.versionId;
    expect(v2).not.toBe(v1);
    await expect(s.writeRestored(bytesOf(3), { currentEtag: v1Etag })).rejects.toMatchObject({ code: "state_changed" });
    const current = await s.readCurrent();
    expect(current.versionId).toBe(v2);
    expect(current.bytes.equals(bytesOf(2))).toBe(true);
  });

  it("server-side IfMatch: a write that loses a race after the adapter's check is refused by MinIO, not by the adapter", async () => {
    await put(versionedBucket, KEY_RACE, bytesOf(1));
    const etag = (await admin.send(new sdk.HeadObjectCommand({ Bucket: versionedBucket, Key: KEY_RACE }))).ETag ?? "";
    // A concurrent writer lands between the adapter's HEAD check and its PutObject, so only IfMatch can refuse it.
    let raced = false;
    const racing = await store(versionedBucket, KEY_RACE, async (command) => {
      if (!raced && command.constructor.name === "PutObjectCommand") {
        raced = true;
        await put(versionedBucket, KEY_RACE, bytesOf(9));
      }
    });
    await expect(racing.writeRestored(bytesOf(2), { currentEtag: etag })).rejects.toMatchObject({ code: "state_changed" });
    expect(raced).toBe(true);
    expect((await racing.readCurrent()).bytes.equals(bytesOf(9))).toBe(true);
  });

  it("lists both versions and reads v1 with its digest", async () => {
    const s = await store(versionedBucket, KEY_MAIN);
    const versions = await s.listVersions(10);
    expect(versions.map(v => v.versionId)).toHaveLength(2);
    expect(versions[0]).toMatchObject({ isLatest: true });
    expect(versions[1]).toMatchObject({ versionId: v1, isLatest: false });
    const read = await s.readVersion(v1);
    expect(read.bytes.equals(bytesOf(1))).toBe(true);
    expect(read.sha256).toBe(sha(bytesOf(1)));
  });

  it("restore of v1 writes a NEW latest version equal to v1; v2 remains as a noncurrent version", async () => {
    const s = await store(versionedBucket, KEY_MAIN);
    const earlier = await s.readVersion(v1);
    const current = await s.readCurrent();
    const restored = await s.writeRestored(earlier.bytes, { currentEtag: current.etag ?? "" });
    const readback = await s.readCurrent();
    expect(readback.versionId).toBe(restored.versionId);
    expect(readback.sha256).toBe(earlier.sha256);

    const versions = await s.listVersions(10);
    expect(versions).toHaveLength(3);
    expect(versions.filter(v => v.isLatest).map(v => v.versionId)).toEqual([restored.versionId]);
    const v2 = versions.find(v => !v.isLatest && v.versionId !== v1)?.versionId ?? "";
    expect(v2).not.toBe("");
    expect((await s.readVersion(v2)).bytes.equals(bytesOf(2))).toBe(true);
  });

  it("lock: a second holder of the conditional-create lock object is refused, and the probe refuses restore while it is held", async () => {
    await put(versionedBucket, KEY_LOCK, bytesOf(1));
    const lockKey = `${KEY_LOCK}.tflock`;
    await admin.send(new sdk.PutObjectCommand({ Bucket: versionedBucket, Key: lockKey, Body: Buffer.from("holder-a"), IfNoneMatch: "*" }));
    await expect(admin.send(new sdk.PutObjectCommand({ Bucket: versionedBucket, Key: lockKey, Body: Buffer.from("holder-b"), IfNoneMatch: "*" })))
      .rejects.toMatchObject({ $metadata: { httpStatusCode: 412 } });
    const verdict = await (await store(versionedBucket, KEY_LOCK)).probe();
    expect(verdict).toMatchObject({ lockObject: "present", restoreReady: false });
  });

  it("never sends a delete command across the whole suite", () => {
    expect(commands).toContain("PutObjectCommand");
    expect(commands.filter(name => /^Delete/.test(name))).toEqual([]);
  });
});
