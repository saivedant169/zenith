/**
 * Opt-in live check of the S3 backup target — a real round trip against a real
 * endpoint (LocalStack by default).
 *
 * Run:
 *   npm run localstack:up
 *   npx tsx --env-file-if-exists=.env.local scripts/hosted/backup-live-check.ts
 *   npx tsx scripts/hosted/backup-live-check.ts --bucket=zenith-backups --endpoint=http://localhost:4566 --create-bucket
 *
 * **This is a script, not a test, on purpose.** A test that skipped itself
 * when LocalStack was not running would report green for a code path nobody
 * exercised, and "the S3 target works" would end up resting on nothing. So the
 * automated suite covers `S3Target` against an injected client double — the
 * command shapes and the ETag guard — and this script is the only thing that
 * claims a live endpoint answered.
 *
 * Exit codes: 0 every check passed, 1 a check failed, 2 the endpoint could not
 * be reached or the arguments were wrong.
 *
 * It writes objects under `live-check/<uuid>/` and leaves them there; the
 * `BackupTarget` contract has no delete, and inventing one for a diagnostic
 * would put a delete path in a module whose job is not losing data.
 *
 * **What it can and cannot establish.** It proves this endpoint accepted a
 * put, returned the same bytes, listed the key and appended two ledger lines.
 * The last check asks the one question that actually matters for the
 * revocation ledger: does this endpoint honour `If-Match`? An endpoint that
 * ignores it turns a guarded append into last-writer-wins, and two control
 * processes appending at once would lose a revocation. LocalStack Community
 * has historically been inconsistent here, which is exactly why the answer is
 * measured rather than assumed.
 */
import { randomUUID } from "node:crypto";
import { S3Target, backupS3Region } from "@/lib/hosted/backup";
import { hostedConfig } from "@/lib/hosted/config";
import { env } from "@/lib/env";

const option = (name: string): string | undefined =>
  process.argv.find((arg) => arg.startsWith(`--${name}=`))?.split("=").slice(1).join("=");
const flag = (name: string): boolean => process.argv.includes(`--${name}`);

interface Check {
  id: string;
  ok: boolean;
  detail: string;
}

const checks: Check[] = [];
const record = (id: string, ok: boolean, detail: string): void => {
  checks.push({ id, ok, detail });
  process.stderr.write(`${ok ? "ok  " : "FAIL"} ${id}: ${detail}\n`);
};

function unreachable(detail: string, fix: string): never {
  process.stderr.write(`\nThe S3 endpoint could not be used: ${detail}\nFix: ${fix}\n`);
  process.exit(2);
}

async function main(): Promise<void> {
  const cfg = hostedConfig();
  const bucket = option("bucket") ?? cfg.ZENITH_BACKUP_S3_BUCKET;
  const endpoint = option("endpoint") ?? cfg.ZENITH_BACKUP_S3_ENDPOINT ?? env().ZENITH_LOCALSTACK_ENDPOINT;
  if (!bucket)
    unreachable(
      "no bucket was named.",
      "Pass --bucket=<name>, or set ZENITH_BACKUP_S3_BUCKET in .env.local."
    );

  // LocalStack accepts any credentials and the SDK refuses to send none. Only
  // filled in for a loopback endpoint, so this can never quietly point a real
  // AWS account at throwaway keys.
  const loopback = /^https?:\/\/(localhost|127\.0\.0\.1|host\.docker\.internal)(:\d+)?$/i.test(endpoint);
  if (loopback && !process.env.AWS_ACCESS_KEY_ID) {
    process.env.AWS_ACCESS_KEY_ID = "test";
    process.env.AWS_SECRET_ACCESS_KEY = "test";
    process.env.AWS_REGION ??= "us-east-1";
    process.stderr.write(`Using LocalStack's throwaway credentials for ${endpoint}.\n`);
  }

  // The same region the backup target uses. Without one the SDK would talk to us-east-1, which fails for a bucket elsewhere.
  const region = backupS3Region({ ZENITH_BACKUP_S3_REGION: cfg.ZENITH_BACKUP_S3_REGION, AWS_REGION: process.env.AWS_REGION, AWS_DEFAULT_REGION: process.env.AWS_DEFAULT_REGION });
  if (!region && !endpoint)
    unreachable(
      "no region was named for the bucket.",
      "Set ZENITH_BACKUP_S3_REGION to the bucket's region, for example ap-south-1, or AWS_REGION."
    );

  const s3 = await import("@aws-sdk/client-s3");
  const client = new s3.S3Client({
    region: region ?? "us-east-1",
    endpoint,
    forcePathStyle: true,
    maxAttempts: 1,
    requestHandler: { connectionTimeout: 3_000, requestTimeout: 15_000 },
  });

  try {
    await client.send(new s3.HeadBucketCommand({ Bucket: bucket }));
    record("bucket_reachable", true, `HEAD ${bucket} at ${endpoint} answered.`);
  } catch (error) {
    // A connection failure from the SDK often carries an empty message, so the
    // name is what makes the line readable at all.
    const detail =
      error instanceof Error ? `${error.name}${error.message ? `: ${error.message}` : " (no detail)"}` : String(error);
    if (!flag("create-bucket"))
      unreachable(
        `HEAD on bucket "${bucket}" at ${endpoint} failed: ${detail}`,
        loopback
          ? "Start LocalStack with `npm run localstack:up`, then re-run with --create-bucket to have this script create the bucket."
          : `Create the bucket "${bucket}" and give this process credentials that can read and write it.`
      );
    try {
      await client.send(new s3.CreateBucketCommand({ Bucket: bucket }));
      record("bucket_reachable", true, `Created bucket ${bucket} at ${endpoint}.`);
    } catch (createError) {
      unreachable(
        `bucket "${bucket}" could not be created at ${endpoint}: ${createError instanceof Error ? createError.message : String(createError)}`,
        "Start LocalStack (`npm run localstack:up`) or create the bucket by hand, then run this again."
      );
    }
  }

  const run = randomUUID();
  const target = new S3Target({ bucket, endpoint, region, client: client as unknown as { send(c: unknown): Promise<unknown> } });
  const objectKey = `live-check/${run}/bundle.zbk`;
  const ledgerKey = `live-check/${run}/revocations.jsonl`;
  const payload = Buffer.from(`zenith-live-check ${run} ${"x".repeat(4096)}`, "utf8");

  try {
    await target.put(objectKey, payload);
    const read = await target.get(objectKey);
    const same = read !== null && read.equals(payload);
    record("put_get_roundtrip", same, same ? `${payload.length} bytes written and read back unchanged.` : "The object read back is not the object written.");

    const listed = await target.list(`live-check/${run}/`);
    record("list", listed.includes(objectKey), listed.includes(objectKey) ? `list() found ${listed.length} key(s) under the run prefix.` : `list() did not return ${objectKey}.`);

    await target.append(ledgerKey, JSON.stringify({ seq: 1, note: "live check" }));
    await target.append(ledgerKey, JSON.stringify({ seq: 2, note: "live check" }));
    const ledger = (await target.get(ledgerKey))?.toString("utf8") ?? "";
    const lines = ledger.split("\n").filter((line) => line.trim() !== "");
    record("append_twice", lines.length === 2, `The ledger holds ${lines.length} line(s) after two appends (expected 2).`);

    record(...(await conditionalWriteCheck(s3, client, bucket, `live-check/${run}/etag-probe`)));
  } catch (error) {
    record("round_trip", false, error instanceof Error ? error.message : String(error));
  }

  const failed = checks.filter((check) => !check.ok);
  process.stdout.write(`${JSON.stringify({ endpoint, bucket, prefix: `live-check/${run}/`, checks }, null, 2)}\n`);
  process.stderr.write(
    failed.length === 0
      ? `\nAll ${checks.length} live checks passed against ${endpoint}. Objects were left under live-check/${run}/.\n`
      : `\n${failed.length} of ${checks.length} live checks failed against ${endpoint}.\n`
  );
  process.exit(failed.length === 0 ? 0 : 1);
}

/**
 * Does this endpoint honour `If-Match`?
 *
 * Write an object, keep its ETag, overwrite it so the ETag is stale, then try
 * a conditional write with the stale ETag. A `412` means the guard works and
 * the ledger's read-modify-write append is safe against a concurrent writer.
 * Anything else means it does not, and this says so rather than passing.
 */
async function conditionalWriteCheck(
  s3: typeof import("@aws-sdk/client-s3"),
  client: import("@aws-sdk/client-s3").S3Client,
  bucket: string,
  key: string
): Promise<[string, boolean, string]> {
  try {
    const first = await client.send(new s3.PutObjectCommand({ Bucket: bucket, Key: key, Body: Buffer.from("one") }));
    const staleEtag = first.ETag;
    if (!staleEtag) return ["conditional_write", false, "The endpoint returned no ETag on a put, so a guarded append cannot be built on it."];
    await client.send(new s3.PutObjectCommand({ Bucket: bucket, Key: key, Body: Buffer.from("two") }));
    try {
      await client.send(
        new s3.PutObjectCommand({ Bucket: bucket, Key: key, Body: Buffer.from("three"), IfMatch: staleEtag })
      );
      return [
        "conditional_write",
        false,
        "A conditional write with a STALE ETag succeeded: this endpoint ignores If-Match, so two processes appending to the revocation ledger at the same moment can lose a line. Run one control process, or use a filesystem target.",
      ];
    } catch (error) {
      const status = (error as { $metadata?: { httpStatusCode?: number } })?.$metadata?.httpStatusCode;
      const refused = status === 412 || status === 409;
      return [
        "conditional_write",
        refused,
        refused
          ? `A conditional write with a stale ETag was refused with ${status}, so the ledger's guarded append is safe against a concurrent writer here.`
          : `A conditional write with a stale ETag failed with an unexpected ${status ?? "error"}: ${error instanceof Error ? error.message : String(error)}`,
      ];
    }
  } catch (error) {
    return ["conditional_write", false, `The probe could not run: ${error instanceof Error ? error.message : String(error)}`];
  }
}

main().catch((error) => {
  process.stderr.write(`\n${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
  process.exit(1);
});
