/**
 * PROD-OPS-07: the retention archive against a real S3-compatible object store (a disposable local MinIO), through the
 * production S3 target and AWS SDK: sealed objects under retention/<workspace>/<class>/, verifyArchive, a staging
 * restore with read-back, and pruning that removes only the archived rows. Gated by ZENITH_TEST_RETENTION_S3=1 with
 * ZENITH_TEST_RETENTION_S3_BUCKET (an empty, disposable bucket) plus either ZENITH_TEST_RETENTION_S3_ENDPOINT (emulator
 * such as MinIO) or ZENITH_TEST_RETENTION_S3_REGION (a real AWS bucket in that region). The SDK's standard credentials
 * (AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY, or its usual provider chain) apply. Skips with a printed reason otherwise.
 * PGlite by default; real PostgreSQL with
 * ZENITH_TEST_RETENTION_PG=1 and an owned disposable ZENITH_TEST_PLATFORM_PG_URL.
 */
import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ListObjectsV2Command, S3Client } from "@aws-sdk/client-s3";
import { openPlatformDb, type PlatformDbHandle } from "@/lib/controlplane/db";
import * as repos from "@/lib/controlplane/db/repos";
import { archiveTargetFromEnv, type ArchiveTarget } from "@/lib/retention/archive";
import { retentionPass, type RetentionOptions } from "@/lib/retention/job";
import { parseRetentionPolicy, type PolicyLoad } from "@/lib/retention/policy";
import { restoreArchive, verifyArchive } from "@/lib/retention/restore";
import { listArchives } from "@/lib/retention/store";
import { newWorkspace, seedApprovedOperation, uid } from "../controlplane/_support/harness";

const endpoint = process.env.ZENITH_TEST_RETENTION_S3_ENDPOINT;
const bucket = process.env.ZENITH_TEST_RETENTION_S3_BUCKET;
const region = process.env.ZENITH_TEST_RETENTION_S3_REGION;
const skipReason = process.env.ZENITH_TEST_RETENTION_S3 !== "1" ? "ZENITH_TEST_RETENTION_S3=1 is not set"
  : !bucket ? "ZENITH_TEST_RETENTION_S3_BUCKET is not set"
  : !endpoint && !region ? "neither ZENITH_TEST_RETENTION_S3_ENDPOINT (emulator) nor ZENITH_TEST_RETENTION_S3_REGION (real bucket) is set"
  : undefined;
if (skipReason) console.warn(`[retention archive-s3 engine suite] skipped: ${skipReason}`);
const enabled = !skipReason;
const nativePostgres = process.env.ZENITH_TEST_RETENTION_PG === "1";
const PUBKEY = "A".repeat(43);
const KEY = randomBytes(32);
const APPLY = { ZENITH_RETENTION_APPLY: "1" };
const LOAD: PolicyLoad = {
  ok: true, source: "inline", digest: "0".repeat(64),
  policy: parseRetentionPolicy({ version: 1, classes: { runner_job_logs: { archiveAfterDays: 30, pruneAfterDays: 90 } },
    approval: { decision: "DEC-RETENTION", approvedBy: "test-operator", approvedAt: "2026-10-01T00:00:00.000Z" } }),
};

describe.skipIf(!enabled)("retention archive on a real S3-compatible store (ZENITH_TEST_RETENTION_S3=1)", () => {
  let db: PlatformDbHandle;
  let target: ArchiveTarget;
  beforeAll(async () => {
    const pgUrl = process.env.ZENITH_TEST_PLATFORM_PG_URL;
    if (nativePostgres && !pgUrl) throw new Error("Explicit retention PostgreSQL gate requires an owned disposable ZENITH_TEST_PLATFORM_PG_URL.");
    db = await openPlatformDb(nativePostgres ? { kind: "postgres", url: pgUrl!, max: 2 } : { kind: "pglite" });
    const choice = archiveTargetFromEnv({ ZENITH_RETENTION_ARCHIVE_TARGET: "s3", ZENITH_RETENTION_ARCHIVE_S3_BUCKET: bucket, ZENITH_RETENTION_ARCHIVE_S3_ENDPOINT: endpoint, ZENITH_RETENTION_ARCHIVE_S3_REGION: region });
    if (!choice.ok) throw new Error(choice.reason);
    expect(choice.kind).toBe("s3");
    target = choice.target;
  }, 60_000);
  afterAll(async () => { await db?.close(); });

  const run = (o: Partial<RetentionOptions> = {}) => retentionPass(db, { maxBatches: 100, maxPrunes: 100, key: KEY, recheckMs: 0, env: APPLY, load: LOAD, target, ...o });
  async function workspaceWithLogs(ageDays: number, lines: number) {
    const ws = newWorkspace();
    const { tokenHash } = repos.runners.generateRegistrationToken("runner");
    await repos.runners.createRegistrationToken(db, { workspaceId: ws, kind: "runner", createdBy: "admin", tokenHash });
    const { id: runnerId } = await repos.runners.registerRunner(db, { tokenHash, name: "r", publicKey: PUBKEY, capabilities: ["tofu.run"] });
    const { operation } = await seedApprovedOperation(db, ws);
    const jobId = uid("job");
    await repos.jobs.enqueue(db, { id: jobId, workspaceId: ws, runnerId, operationId: operation.id, kind: "tofu.run", capability: "infrastructure.apply", envelope: "eyJhbGciOiJFZERTQSJ9.payload.signature" });
    await repos.jobs.claimNext(db, { workspaceId: ws, runnerId, max: 1 });
    await repos.jobs.settle(db, { workspaceId: ws, runnerId, jobId, status: "succeeded", result: { exitCode: 0 } });
    for (let i = 0; i < lines; i++) {
      await db.query(`insert into platform.runner_job_logs (job_id, workspace_id, batch_seq, line_no, ts, stream, line, recorded_at)
        values ($1, $2, 0, $3, clock_timestamp(), 'stdout', $4, clock_timestamp() - ($5::int * interval '1 day'))`, [jobId, ws, i, `line-${i}-${randomBytes(6).toString("hex")}`, ageDays]);
    }
    return { ws, jobId };
  }
  const logCount = async (ws: string) => (await db.query<{ n: number }>("select count(*)::int as n from platform.runner_job_logs where workspace_id = $1", [ws]))[0].n;

  it("archives sealed objects to the bucket, verifies and restores them, and prunes only archived rows", async () => {
    const old = await workspaceWithLogs(150, 3);
    const recent = await workspaceWithLogs(5, 2);
    await run();
    await run();
    // Sealed objects are in the real bucket under the workspace's class prefix.
    const s3 = new S3Client({ region: region ?? "us-east-1", ...(endpoint ? { endpoint, forcePathStyle: true } : {}) });
    const listed = await s3.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: `retention/${old.ws}/runner_job_logs/` }));
    expect((listed.Contents ?? []).length).toBeGreaterThan(0);
    const [archive] = (await listArchives(db, { workspaceId: old.ws })).filter((a) => a.dataClass === "runner_job_logs");
    expect(archive).toBeDefined();
    expect((listed.Contents ?? []).some((o) => o.Key === archive.objectKey || o.Key?.endsWith(archive.objectKey))).toBe(true);
    // Verify and restore read back from the bucket.
    const deps = { operator: target };
    expect(await verifyArchive(db, archive.id, { deps, key: KEY })).toMatchObject({ ok: true, rows: 3 });
    expect((await verifyArchive(db, archive.id, { deps, key: randomBytes(32) })).ok).toBe(false);
    const suffix = randomBytes(4).toString("hex");
    const restored = await restoreArchive(db, { archiveId: archive.id, mode: "staging", stagingSuffix: suffix, actor: "op" }, { deps, key: KEY });
    expect(restored).toMatchObject({ verdict: "verified", mode: "staging", selected: 3, inserted: 3 });
    // Pruned exactly the archived rows; the recent workspace (inside its window) keeps everything.
    expect(await logCount(old.ws)).toBe(0);
    expect(await logCount(recent.ws)).toBe(2);
    expect(await listArchives(db, { workspaceId: recent.ws })).toHaveLength(0);
  }, 120_000);
});
