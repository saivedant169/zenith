/**
 * PROD-OPS-04 local rehearsal: a REAL clean-host restore on real PostgreSQL (pg_dump / pg_restore) and, when the
 * Temporal CLI is available, a real Temporal dev server.
 *
 * Gating (like the existing real-engine suites): needs ZENITH_TEST_PLATFORM_PG_URL (with CREATEDB) and matching
 * pg_dump / pg_restore client tools (ZENITH_TEST_PG_DUMP_BIN / ZENITH_TEST_PG_RESTORE_BIN, absolute, optional).
 * Without them the tests skip with the reason; ZENITH_TEST_RECOVERY_REQUIRED=1 turns a missing prerequisite into a
 * failure. The Temporal part needs the Temporal CLI (findTemporalCli) and the same switch
 * (ZENITH_TEST_RECOVERY_REQUIRED=1 or ZENITH_TEST_TEMPORAL=1) makes its absence a failure.
 *
 * The story: a source database holds work in every interesting state. A backup is taken. The lost timeline then
 * consumes an approval after the snapshot. The backup is restored into a brand-new empty database, and the restored
 * control plane must refuse to let that consumed approval run again, keep the effect that may have happened
 * uncertain, and hand every in-flight item to a person.
 */
import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it, type TestContext } from "vitest";
import { Client } from "@temporalio/client";
import { TestWorkflowEnvironment } from "@temporalio/testing";
import { DefaultLogger, Runtime, makeTelemetryFilterString } from "@temporalio/worker";
import * as repos from "@/lib/controlplane/db/repos";
import { openPlatformDb, type PlatformDbHandle } from "@/lib/controlplane/db";
import { currentRecoveryEpoch, decideItem, listRecoveryItems, type RecoveryItem } from "@/lib/controlplane/recovery";
import { enqueueIntent } from "@/lib/controlplane/outbox";
import { captureBackup, type BackupOptions } from "@/lib/ops/recovery/backup";
import { MANIFEST_FILE, verifyBackupDirectory, type BackupManifest } from "@/lib/ops/recovery/manifest";
import { execRunner, toolsFromEnv, type Tools } from "@/lib/ops/recovery/process";
import { runRestore, type RestoreDeps, type RestoreOptions } from "@/lib/ops/recovery/restore";
import { PG_URL, approve, seedApprovedOperation, seedAwaitingApproval, user, expectCode } from "../controlplane/_support/harness";
import { openEmptyScratchDatabase, openMigratedScratchDatabase, type ScratchDb } from "../controlplane/_support/scratch-db";
import { findTemporalCli } from "../workflows/support";

const run = promisify(execFile);
const REQUIRED = process.env.ZENITH_TEST_RECOVERY_REQUIRED === "1";
const KEY = { purpose: "enc:vault", keyId: "rehearsal-key", role: "current" } as const;

let skipReason: string | undefined;
let tools: Tools;
let work: string;
let source: ScratchDb | undefined;
let backupDir: string;
let manifest: BackupManifest;
const seeded: { approved?: Awaited<ReturnType<typeof seedAwaitingApproval>>; running?: string; withEffect?: string; effectId?: string; workspaceId?: string; intentId?: string } = {};

async function probeTools(): Promise<string | undefined> {
  if (!PG_URL) return "ZENITH_TEST_PLATFORM_PG_URL is not set (a real PostgreSQL with CREATEDB is required).";
  try {
    tools = toolsFromEnv(process.env);
    const dump = (await run(tools.pgDump, ["--version"])).stdout.match(/(\d+)\.?\d*/)?.[1];
    const restore = (await run(tools.pgRestore, ["--version"])).stdout.match(/(\d+)\.?\d*/)?.[1];
    const probe = await openPlatformDb({ kind: "postgres", url: PG_URL, migrate: false, max: 1 });
    const server = String(Math.floor(Number((await probe.query<{ v: string }>("select current_setting('server_version_num') as v"))[0]?.v) / 10000));
    await probe.close();
    if (dump !== restore || dump !== server) return `pg_dump ${dump}, pg_restore ${restore} and the server (${server}) must share a major version.`;
  } catch (error) {
    return `pg_dump / pg_restore are not usable: ${(error as Error).message.slice(0, 120)}`;
  }
  return undefined;
}

const skipOrFail = (ctx: TestContext): void => {
  if (!skipReason) return;
  if (REQUIRED) throw new Error(skipReason);
  ctx.skip(skipReason);
};

function backupOptions(over: Partial<BackupOptions> & { outDir: string }): BackupOptions {
  return {
    platformUrl: source!.url,
    product: { kind: "not_applicable", note: "rehearsal: product store is not used" },
    hosted: { kind: "not_applicable", note: "rehearsal: hosted mode is off" },
    keys: [KEY],
    ...over,
  };
}

function restoreOptions(url: string, over: Partial<RestoreOptions> = {}): RestoreOptions {
  return {
    backupDir, targetUrl: url, runId: `rehearsal-${randomUUID()}`, actor: "operator:rehearsal", reason: "restore rehearsal", confirmCustomerState: true,
    keysAvailable: [KEY], reportFile: path.join(work, `report-${randomUUID()}.json`), ...over,
  };
}

const restoreDeps = (over: Partial<RestoreDeps> = {}): RestoreDeps => ({
  run: execRunner, tools,
  openTarget: (url, o) => openPlatformDb({ kind: "postgres", url, max: 3, migrate: o.migrate }),
  ...over,
});

beforeAll(async () => {
  skipReason = await probeTools();
  if (skipReason) return;
  work = await mkdtemp(path.join(os.tmpdir(), "zenith-rehearsal-"));
  backupDir = path.join(work, "backup");
  source = await openMigratedScratchDatabase();
  const db = source.db;

  // Work in every interesting state, in ONE workspace.
  const awaiting = await seedAwaitingApproval(db);
  await approve(db, awaiting, user("approver-1"));
  seeded.approved = awaiting;
  seeded.workspaceId = awaiting.workspaceId;
  const running = await seedApprovedOperation(db, awaiting.workspaceId);
  await repos.operations.claimForExecution(db, { workspaceId: running.workspaceId, id: running.operation.id, expectedDigest: running.operation.proposalDigest, holder: "worker:lost", leaseMs: 600_000 });
  seeded.running = running.operation.id;
  const withEffect = await seedApprovedOperation(db, awaiting.workspaceId);
  seeded.withEffect = withEffect.operation.id;
  const effect = await repos.externalEffects.begin(db, { workspaceId: awaiting.workspaceId, family: "build_launch", operationId: withEffect.operation.id, provider: "aws", dedupKey: "svc:web", requestDigest: "e".repeat(64), idempotencySupported: false, actor: "rehearsal" });
  seeded.effectId = effect.effect.effectId;
  seeded.intentId = (await enqueueIntent(db, { workspaceId: awaiting.workspaceId, operationId: awaiting.operation.id, kind: "workflow_signal", idempotencyKey: "approval:1", payload: { signal: "approvalRecorded" } })).id;

  manifest = await captureBackup({ db, run: execRunner, tools }, backupOptions({ outDir: backupDir }));

  // The lost timeline carries on after the snapshot: it consumes the approval and runs the operation.
  await repos.operations.claimForExecution(db, { workspaceId: awaiting.workspaceId, id: awaiting.operation.id, expectedDigest: awaiting.operation.proposalDigest, holder: "worker:lost-2" });
}, 240_000);

afterAll(async () => {
  await source?.close();
  if (work) await rm(work, { recursive: true, force: true });
}, 60_000);

describe("backup", () => {
  it("captures the platform store with a manifest that names every component and verifies", async (ctx) => {
    skipOrFail(ctx);
    const verified = await verifyBackupDirectory(backupDir);
    expect(verified).toMatchObject({ ok: true });
    expect(manifest.components.map((c) => `${c.id}:${c.status}`)).toEqual([
      "platform:captured", "source:covered", "plan_artifacts:covered", "agent:not_applicable", "product:not_applicable", "hosted:not_applicable",
      "artifacts:not_applicable", "temporal:not_applicable", "customer_state:referenced", "keys:captured",
    ]);
    const platform = manifest.components[0]!;
    expect(platform.files[0]?.path).toBe("database.dump");
    expect(platform.facts["rows.operations"]).toBe(3);
    expect(platform.facts["rows.approvals"]).toBe(1);
    expect(platform.facts["rows.external_effects"]).toBe(1);
    expect(manifest.platform).toMatchObject({ recoveryEpoch: 0 });
    expect(manifest.platform.schemaVersion).toBeGreaterThanOrEqual(44);
    expect(Date.parse(manifest.platform.snapshotAt)).toBeLessThanOrEqual(Date.parse(manifest.finishedAt));
  });

  it("writes no connection string, password or key material", async (ctx) => {
    skipOrFail(ctx);
    const text = await readFile(path.join(backupDir, MANIFEST_FILE), "utf8");
    const url = new URL(PG_URL!);
    expect(text).not.toContain("postgres://");
    if (url.password) expect(text).not.toContain(decodeURIComponent(url.password));
    expect(JSON.parse(text).keys).toEqual([KEY]);
  });

  it("refuses to write into a directory that already holds a backup", async (ctx) => {
    skipOrFail(ctx);
    await expect(captureBackup({ db: source!.db, run: execRunner, tools }, backupOptions({ outDir: backupDir }))).rejects.toMatchObject({ code: "refused" });
  });
});

describe("clean-host restore", () => {
  let target: Awaited<ReturnType<typeof openEmptyScratchDatabase>> | undefined;
  let restored: PlatformDbHandle | undefined;
  const runIdForTarget = `rehearsal-main-${randomUUID()}`;
  afterAll(async () => { await restored?.close(); await target?.close(); }, 60_000);

  it("a tampered backup restores nothing and leaves the target empty", async (ctx) => {
    skipOrFail(ctx);
    const empty = await openEmptyScratchDatabase();
    try {
      const damaged = path.join(work, "damaged");
      await mkdir(damaged, { recursive: true });
      for (const f of ["database.dump", MANIFEST_FILE]) await copyFile(path.join(backupDir, f), path.join(damaged, f));
      const bytes = await readFile(path.join(damaged, "database.dump"));
      bytes[bytes.length - 1] = bytes[bytes.length - 1]! ^ 0xff;
      await writeFile(path.join(damaged, "database.dump"), bytes);
      const report = await runRestore(restoreDeps(), restoreOptions(empty.url, { backupDir: damaged }));
      expect(report.ok).toBe(false);
      expect(report.steps.at(-1)).toMatchObject({ id: "verify", status: "refused" });
      const probe = await openPlatformDb({ kind: "postgres", url: empty.url, migrate: false, max: 1 });
      expect((await probe.query<{ n: number }>("select count(*)::int as n from information_schema.tables where table_schema = 'platform'"))[0]?.n).toBe(0);
      await probe.close();
    } finally { await empty.close(); }
  }, 120_000);

  it("refuses a host that lacks the backup's keys before touching the target", async (ctx) => {
    skipOrFail(ctx);
    const empty = await openEmptyScratchDatabase();
    try {
      const report = await runRestore(restoreDeps(), restoreOptions(empty.url, { keysAvailable: [] }));
      expect(report.steps.at(-1)).toMatchObject({ id: "keys", status: "refused" });
      expect(report.steps.map((s) => s.id)).not.toContain("restore");
    } finally { await empty.close(); }
  }, 120_000);

  it("restores atomically, verifies the counts, bumps the epoch and opens the work list", async (ctx) => {
    skipOrFail(ctx);
    target = await openEmptyScratchDatabase();
    const incidentAt = new Date(Date.parse(manifest.platform.snapshotAt) + 90_000).toISOString();
    const options = restoreOptions(target.url, { runId: runIdForTarget, incidentAt, observedEpoch: 2 });
    const report = await runRestore(restoreDeps({ env: {} }), options);
    expect(report.steps.map((s) => `${s.id}:${s.status}`)).toEqual(expect.arrayContaining(["verify:ok", "gates:ok", "keys:ok", "empty:ok", "restore:ok", "migrate:ok", "facts:ok", "epoch:ok"]));
    expect(report.ok).toBe(true);
    expect(report.epoch).toBe(3);
    expect(report.counts).toMatchObject({ operationsMadeUncertain: 1, operationsHeld: 2, effectsMadeUncertain: 1, intentsHeld: 1 });
    expect(report.needsPerson.join(" ")).toMatch(/decide each/);
    // measured, not asserted
    expect(report.measurement).toMatchObject({ rpoSeconds: 90, incidentAt });
    expect(report.measurement!.restoreDurationSeconds).toBeGreaterThan(0);
    expect(report.measurement!.targets.status).toBe("target");
    expect(report.continuation).toMatchObject({ epoch: 3, opened: 5, pending: 5 });
    const written = JSON.parse(await readFile(options.reportFile, "utf8")) as { ok: boolean; runId: string };
    expect(written).toMatchObject({ ok: true, runId: runIdForTarget });
    expect(JSON.stringify(written)).not.toContain("postgres://");

    restored = await openPlatformDb({ kind: "postgres", url: target.url, migrate: false, max: 3 });
    expect(await currentRecoveryEpoch(restored)).toBe(3);
    const epochRow = (await restored.query<{ manifest_digest: string; backup_id: string; prior_epoch: number; observed_epoch: number }>("select manifest_digest, backup_id, prior_epoch, observed_epoch from platform.recovery_epochs where epoch = 3"))[0]!;
    expect(epochRow).toMatchObject({ manifest_digest: manifest.digest, backup_id: manifest.backupId, prior_epoch: 0, observed_epoch: 2 });
  }, 240_000);

  it("the approval the lost timeline consumed cannot run again; only a fresh approval in the new epoch can, once", async (ctx) => {
    skipOrFail(ctx);
    const ws = seeded.workspaceId!, op = seeded.approved!.operation.id, digest = seeded.approved!.operation.proposalDigest;
    // as restored, the approval looks unconsumed and the operation approved: exactly the resurrection hazard
    expect((await repos.operations.get(restored!, ws, op))?.status).toBe("approved");
    const stale = await expectCode(repos.operations.claimForExecution(restored!, { workspaceId: ws, id: op, expectedDigest: digest, holder: "worker:new" }), "invalid_state");
    expect(stale).toMatchObject({ reason: "recovery_epoch_stale" });

    const item = (await listRecoveryItems(restored!, ws, { limit: 100 })).find((i) => i.kind === "operation" && i.ref === op) as RecoveryItem;
    expect(item.allowed).toEqual(["resume", "abandon"]);
    await decideItem(restored!, { workspaceId: ws, itemId: item.id, decision: "resume", actor: "user:admin-1", reason: "reviewed after the rehearsal restore", bindingDigest: item.bindingDigest });
    await repos.approvals.record(restored!, { workspaceId: ws, operationId: op, approver: user("approver-2"), approverRole: "editor", decision: "approve", proposalDigest: digest, policyVersion: "a".repeat(64) });
    expect((await repos.operations.claimForExecution(restored!, { workspaceId: ws, id: op, expectedDigest: digest, holder: "worker:new" })).status).toBe("running");
    await expectCode(repos.operations.claimForExecution(restored!, { workspaceId: ws, id: op, expectedDigest: digest, holder: "worker:other" }), "invalid_state");
  }, 120_000);

  it("the running operation and the pending effect stay uncertain; the effect is never created twice", async (ctx) => {
    skipOrFail(ctx);
    const ws = seeded.workspaceId!;
    expect((await repos.operations.get(restored!, ws, seeded.running!))?.status).toBe("uncertain");
    const effect = await repos.externalEffects.begin(restored!, { workspaceId: ws, family: "build_launch", operationId: seeded.withEffect!, provider: "aws", dedupKey: "svc:web", requestDigest: "e".repeat(64), idempotencySupported: false, actor: "rehearsal" });
    expect(effect).toMatchObject({ created: false });
    expect(effect.effect).toMatchObject({ effectId: seeded.effectId, state: "uncertain" });
  });

  it("running the restore again with the same run id is idempotent; a different run id is refused as non-empty", async (ctx) => {
    skipOrFail(ctx);
    const again = await runRestore(restoreDeps(), restoreOptions(target!.url, { runId: runIdForTarget }));
    expect(again.ok).toBe(true);
    expect(again).toMatchObject({ replayed: true, epoch: 3 });
    const other = await runRestore(restoreDeps(), restoreOptions(target!.url));
    expect(other.ok).toBe(false);
    expect(other.steps.at(-1)).toMatchObject({ id: "empty", status: "refused" });
    expect(await currentRecoveryEpoch(restored!)).toBe(3);
  }, 120_000);
});

describe("temporal", () => {
  let env: TestWorkflowEnvironment | undefined;
  let temporalSkip: string | undefined;
  const namespace = `zenith-recovery-${randomUUID()}`;
  beforeAll(async () => {
    if (skipReason) return;
    const cli = findTemporalCli();
    if (!cli) { temporalSkip = "The Temporal CLI is unavailable."; return; }
    try { Runtime.install({ logger: new DefaultLogger("ERROR"), telemetryOptions: { logging: { filter: makeTelemetryFilterString({ core: "ERROR", other: "ERROR" }), forward: {} } } }); } catch { /* the process may already have a Runtime */ }
    env = await TestWorkflowEnvironment.createLocal({ server: { executable: { type: "existing-path", path: cli }, ip: "127.0.0.1", namespace } });
    if (/:7233$/.test(env.address)) { await env.teardown(); env = undefined; throw new Error("The rehearsal refuses the default Temporal port."); }
    tools = { ...tools, temporal: cli };
  }, 240_000);
  afterAll(async () => { await env?.teardown(); }, 60_000);

  it("inventories open workflows in the backup and terminates the lost timeline's operation workflows at restore", async (ctx) => {
    skipOrFail(ctx);
    if (!env) {
      if (REQUIRED || process.env.ZENITH_TEST_TEMPORAL === "1") throw new Error(temporalSkip ?? "No Temporal server.");
      return ctx.skip(temporalSkip);
    }
    const client: Client = env.client;
    const workflowId = `op-rehearsal-${randomUUID()}`;
    // No worker polls this queue: the workflow is Running, which is exactly "in flight in the lost timeline".
    const handle = await client.workflow.start("rehearsalWorkflowWithoutWorker", { taskQueue: `no-worker-${randomUUID()}`, workflowId });
    const address = env.address;
    const listOpen = async (): Promise<number> => {
      const out = await execRunner(tools.temporal, ["workflow", "list", "--address", address, "--namespace", namespace, "--query", `WorkflowId="${workflowId}" AND ExecutionStatus="Running"`, "--output", "json"]);
      try { const parsed = JSON.parse(out.stdout || "[]") as unknown; return Array.isArray(parsed) ? parsed.length : 0; } catch { return 0; }
    };
    for (let i = 0; i < 40 && (await listOpen()) === 0; i++) await new Promise((r) => setTimeout(r, 250));

    const temporalBackup = path.join(work, "backup-temporal");
    const m = await captureBackup({ db: source!.db, run: execRunner, tools }, backupOptions({ outDir: temporalBackup, temporal: { namespace, address, required: true } }));
    const component = m.components.find((c) => c.id === "temporal")!;
    expect(component).toMatchObject({ status: "captured" });
    expect(Number(component.facts.openWorkflows)).toBeGreaterThanOrEqual(1);
    expect(component.files.map((f) => f.path)).toEqual(["temporal/open-workflows.json", "temporal/namespace.json"]);
    expect(createHash("sha256").update(await readFile(path.join(temporalBackup, "temporal/open-workflows.json"))).digest("hex")).toBe(component.files[0]!.sha256);

    const empty = await openEmptyScratchDatabase();
    try {
      const report = await runRestore(restoreDeps({ tools }), restoreOptions(empty.url, { backupDir: temporalBackup, temporal: { namespace, address, terminate: true } }));
      expect(report.ok).toBe(true);
      expect(report.steps.find((s) => s.id === "temporal")).toMatchObject({ status: "ok" });
      const description = await handle.describe();
      expect(description.status.name).toBe("TERMINATED");
    } finally { await empty.close(); }
  }, 300_000);
});
