/**
 * ProductScenarioPort for PROD-OPS-07 in the retention-s3 live scenario (owner decisions D1-D4).
 *
 * The product runs on the stack the workflow started on the runner: its archive pass, verify, restore and prune are
 * host child processes (`npx tsx scripts/...`), so AWS credentials never enter containers. Each step either proves
 * its claim by an independent readback (SQL on the platform store, or S3 through the guarded `call`) or fails closed
 * with a specific reason. Child output is never evidence; exit codes only route the flow, readbacks decide.
 *
 * Gates exercised, labelled honestly: the built-in DEC-RETENTION baseline (`DEFAULT_RETENTION_POLICY`), the operator
 * apply switch (ZENITH_RETENTION_APPLY=1) and one legal hold. No in-product proposal or approval is involved here.
 *
 * Seams: `sql` (platform store, defaults to ZENITH_LIVE_PRODUCT_DATABASE_URL) and `run` (host child process).
 * Tests inject both; the default implementations are the only code paths that touch the database or spawn a process.
 */
import { execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { promisify } from "node:util";
import type { Sql } from "@/lib/controlplane/types";
import { DEFAULT_RETENTION_POLICY } from "@/lib/retention/policy";
import { createHold } from "@/lib/retention/store";
import type { EnvLike } from "../../config";
import type { Call, Plan, ProductScenarioPort } from "../contracts";

type Requirement = Plan["requirements"][number];
export interface ProductCommand { script: string; args: readonly string[]; env: Record<string, string>; timeoutMs: number }
/** `failure`: the child's own type-and-code line (e.g. "HostedError:policy_unavailable"), when it printed one. */
export interface ProductRun { code: number | null; timedOut: boolean; stdout: string; failure?: string }
export interface RetentionS3Seams {
  sql?: Sql;
  run?: (command: ProductCommand, cwd: string) => Promise<ProductRun>;
}

const DAY_MS = 86_400_000;
const ARCHIVE_TIMEOUT_MS = 300_000;
const CHECK_TIMEOUT_MS = 120_000;
const HOLD_ACTOR = "live-acceptance-automated-operator";
/** Tables whose rows an apply-gated prune must never change (NEVER_PRUNABLE audit, receipt and ledger tables). */
const AUDIT_TABLES = [
  "platform.events", "platform.evidence", "platform.policy_decisions", "platform.approvals", "platform.agent_effect_receipts",
  "platform.external_effects", "platform.operations", "platform.runner_jobs", "platform.machine_requests", "platform.legal_holds",
  "platform.retention_archives", "platform.retention_restores",
] as const;

/** A fail-closed stop. The message is ours and safe to report; anything else is withheld. */
class Refusal extends Error {}
function refuse(message: string): never { throw new Refusal(message); }

const execFileAsync = promisify(execFile);
/** Host child process: `npx tsx <script>` in the product checkout. Output is returned for routing only. */
async function hostRun(command: ProductCommand, cwd: string): Promise<ProductRun> {
  try {
    const { stdout } = await execFileAsync("npx", ["tsx", command.script, ...command.args], { cwd, env: command.env as NodeJS.ProcessEnv, timeout: command.timeoutMs, maxBuffer: 1 << 20, killSignal: "SIGKILL", windowsHide: true, encoding: "utf8" });
    return { code: 0, timedOut: false, stdout: String(stdout) };
  } catch (error) {
    const e = error as { code?: unknown; killed?: unknown; stdout?: unknown; stderr?: unknown };
    // Only the fixed-format failure line our scripts print is kept; nothing else from stderr leaves.
    const kind = typeof e.stderr === "string" ? /^(?:Data retention failed|Retention archive command failed) \(([A-Za-z]{1,40}(?::[A-Za-z0-9_]{1,40})?(?:<[A-Za-z]{1,40}(?::[A-Za-z0-9_]{1,40})?){0,2})\)/m.exec(e.stderr)?.[1] : undefined;
    return { code: typeof e.code === "number" ? e.code : null, timedOut: e.killed === true, stdout: typeof e.stdout === "string" ? e.stdout : "", ...(kind ? { failure: kind } : {}) };
  }
}

/** Only the session credentials, the product's own settings, and the per-run archive key. Nothing else from the harness. */
function childEnv(env: EnvLike, cfg: { region: string; bucket: string; databaseUrl: string; backupKey: string; apply: boolean }): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of ["PATH", "HOME", "TMPDIR", "LANG", "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN"]) if (env[name]) out[name] = env[name]!;
  Object.assign(out, {
    AWS_REGION: cfg.region, ZENITH_PLATFORM_DB_URL: cfg.databaseUrl, ZENITH_BACKUP_KEY: cfg.backupKey,
    ZENITH_RETENTION_ARCHIVE_TARGET: "s3", ZENITH_RETENTION_ARCHIVE_S3_BUCKET: cfg.bucket, ZENITH_RETENTION_ARCHIVE_S3_REGION: cfg.region,
  });
  if (cfg.apply) out.ZENITH_RETENTION_APPLY = "1";
  return out;
}

/** The last stdout line of a product script is its JSON result. Parsed only to route; never returned as evidence. */
function jsonLine(stdout: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(stdout.trim().split("\n").pop() ?? "");
    return parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : null;
  } catch { return null; }
}

interface Seeded { runnerOld: string[]; runnerHeld: string; runnerRecent: string[]; machineOld: string[]; machineRecent: string[] }

/**
 * Seeds one workspace (the run id) through the platform store: a settled runner job and a settled machine request
 * (parents, with the operation they belong to), old log lines that the 30-day baseline archives, one old log line
 * under a legal hold placed after the unheld ones (so the archive stops at it), and in-window log lines.
 */
async function seed(sql: Sql, workspace: string, now: Date): Promise<Seeded> {
  const iso = (ms: number) => new Date(ms).toISOString();
  const oldAt = (i: number) => now.getTime() - 40 * DAY_MS + i * 1000;
  const heldAt = now.getTime() - 35 * DAY_MS;
  const recentAt = (i: number) => now.getTime() - 5 * DAY_MS + i * 1000;
  const expires = iso(now.getTime() + DAY_MS);
  const sha = (label: string) => createHash("sha256").update(`${workspace}:${label}`).digest("hex");
  const operation = `live-op-${workspace}`, runner = `live-runner-${workspace}`, machine = `live-machine-${workspace}`;
  const job = (name: string) => `live-job-${name}-${workspace}`, request = (name: string) => `live-req-${name}-${workspace}`;
  const seeded = await sql.tx(async (tx) => {
    await tx.query("insert into platform.operations (id, workspace_id, capability, principal, status, proposal, proposal_digest, input_digest, correlation_id, created_at, finished_at, expires_at) values ($1, $2, 'live.acceptance.retention', '{}'::jsonb, 'succeeded', '{}'::jsonb, $3, $4, $5, $6::timestamptz, $6::timestamptz, $7::timestamptz)",
      [operation, workspace, sha("proposal"), sha("input"), workspace, iso(oldAt(0)), expires]);
    await tx.query("insert into platform.runners (id, workspace_id, name, public_key) values ($1, $2, 'live acceptance runner', $3)", [runner, workspace, "A".repeat(43)]);
    await tx.query("insert into platform.machines (id, workspace_id, name, transport, target_id) values ($1, $2, 'live acceptance machine', 'zenithd', 'live-acceptance')", [machine, workspace]);
    const at = iso(oldAt(0));
    await tx.query("insert into platform.runner_jobs (id, runner_id, workspace_id, operation_id, kind, capability, envelope, status, created_at, settled_at, expires_at) values ($1, $2, $3, $4, 'live.acceptance', 'live.acceptance.retention', 'live-acceptance-seed', 'succeeded', $5::timestamptz, $5::timestamptz, $6::timestamptz)",
      [job("old"), runner, workspace, operation, at, expires]);
    await tx.query("insert into platform.runner_jobs (id, runner_id, workspace_id, operation_id, kind, capability, envelope, status, created_at, settled_at, expires_at) values ($1, $2, $3, $4, 'live.acceptance', 'live.acceptance.retention', 'live-acceptance-seed', 'succeeded', $5::timestamptz, $5::timestamptz, $6::timestamptz)",
      [job("recent"), runner, workspace, operation, iso(recentAt(0)), expires]);
    await tx.query("insert into platform.machine_requests (id, machine_id, workspace_id, operation_id, operation, capability, envelope, status, created_at, settled_at, expires_at) values ($1, $2, $3, $4, 'observe', 'live.acceptance.retention', 'live-acceptance-seed', 'succeeded', $5::timestamptz, $5::timestamptz, $6::timestamptz)",
      [request("old"), machine, workspace, operation, at, expires]);
    await tx.query("insert into platform.machine_requests (id, machine_id, workspace_id, operation_id, operation, capability, envelope, status, created_at, settled_at, expires_at) values ($1, $2, $3, $4, 'observe', 'live.acceptance.retention', 'live-acceptance-seed', 'succeeded', $5::timestamptz, $5::timestamptz, $6::timestamptz)",
      [request("recent"), machine, workspace, operation, iso(recentAt(0)), expires]);
    const line = async (table: "runner_job_logs" | "machine_request_logs", parent: string, ts: number, n: number): Promise<string> => {
      const col = table === "runner_job_logs" ? "job_id" : "request_id";
      const rows = await tx.query<{ id: string }>(`insert into platform.${table} (${col}, workspace_id, batch_seq, line_no, ts, stream, line, recorded_at) values ($1, $2, 0, $3, $4::timestamptz, 'stdout', $5, $4::timestamptz) returning id::text as id`,
        [parent, workspace, n, iso(ts), `live acceptance line ${n}`]);
      return rows[0].id;
    };
    const runnerOld = [await line("runner_job_logs", job("old"), oldAt(0), 0), await line("runner_job_logs", job("old"), oldAt(1), 1), await line("runner_job_logs", job("old"), oldAt(2), 2)];
    const runnerHeld = await line("runner_job_logs", job("old"), heldAt, 3);
    const runnerRecent = [await line("runner_job_logs", job("recent"), recentAt(0), 0), await line("runner_job_logs", job("recent"), recentAt(1), 1)];
    const machineOld = [await line("machine_request_logs", request("old"), oldAt(0), 0), await line("machine_request_logs", request("old"), oldAt(1), 1), await line("machine_request_logs", request("old"), oldAt(2), 2)];
    const machineRecent = [await line("machine_request_logs", request("recent"), recentAt(0), 0), await line("machine_request_logs", request("recent"), recentAt(1), 1)];
    return { runnerOld, runnerHeld, runnerRecent, machineOld, machineRecent };
  });
  // The hold is created through the product's own store function. It covers exactly the one held timestamp.
  const heldIso = iso(heldAt);
  await createHold(sql, { workspaceId: workspace, dataClass: "runner_job_logs", timeFrom: heldIso, timeTo: heldIso, reason: "PROD-OPS-07 live acceptance: legal hold must block archive and prune", actor: HOLD_ACTOR });
  const matched = await sql.query<{ n: number }>("select count(*)::int as n from platform.runner_job_logs where workspace_id = $1 and recorded_at = $2::timestamptz", [workspace, heldIso]);
  if (Number(matched[0]?.n) !== 1) refuse("the legal hold did not match exactly the one seeded row");
  return seeded;
}

const sortedIds = (ids: readonly string[]): string[] => [...ids].sort();
const sameIds = (a: readonly string[], b: readonly string[]): boolean => { const x = sortedIds(a), y = sortedIds(b); return x.length === y.length && x.every((v, i) => v === y[i]); };

async function presentLogs(sql: Sql, workspace: string): Promise<{ runner: string[]; machine: string[] }> {
  const runner = await sql.query<{ id: string }>("select id::text as id from platform.runner_job_logs where workspace_id = $1", [workspace]);
  const machine = await sql.query<{ id: string }>("select id::text as id from platform.machine_request_logs where workspace_id = $1", [workspace]);
  return { runner: runner.map(r => r.id), machine: machine.map(r => r.id) };
}

async function auditCounts(sql: Sql, workspace: string): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const table of AUDIT_TABLES) {
    const rows = await sql.query<{ n: number }>(`select count(*)::int as n from ${table} where workspace_id = $1`, [workspace]);
    out[table] = Number(rows[0]?.n);
  }
  return out;
}

interface ArchiveRow { id: string; data_class: string; object_key: string; row_count: number; first_row_id: string; last_row_id: string; pruned_rows: number }

/** PROD-OPS-07 only. Every other requirement is refused by name. Never throws. */
export function retentionS3Port(env: EnvLike = process.env, seams: RetentionS3Seams = {}): ProductScenarioPort {
  return {
    async verify(requirement: Requirement, { plan, call }: { plan: Plan; commit: string; call: (c: Call) => Promise<Record<string, unknown>> }) {
      if (requirement.id !== "PROD-OPS-07") return { complete: false, reason: `${requirement.id}: not implemented by this port` };
      let step = "preconditions";
      let handle: Sql | undefined, closeOpened: (() => Promise<void>) | undefined, stage: string | undefined;
      try {
        if (env.ZENITH_LIVE_PRODUCT !== "1") refuse("ZENITH_LIVE_PRODUCT=1 is not set; no product scenario ran");
        const databaseUrl = env.ZENITH_LIVE_PRODUCT_DATABASE_URL?.trim(), cwd = env.ZENITH_LIVE_PRODUCT_DIR?.trim();
        if (!databaseUrl || !cwd) refuse("ZENITH_LIVE_PRODUCT_DATABASE_URL and ZENITH_LIVE_PRODUCT_DIR are required");
        if (!env.AWS_ACCESS_KEY_ID || !env.AWS_SECRET_ACCESS_KEY || !env.AWS_SESSION_TOKEN) refuse("the AWS session must be in the process environment (OIDC path); the session-file mode is not supported");
        if (plan.settings.scenario !== "retention-s3") refuse("the plan is not the retention-s3 scenario");
        const s3 = plan.fixtures.find(f => f.family === "s3");
        const bucket = s3?.setup.find(c => c.id === "s3-create")?.input.Bucket;
        if (typeof bucket !== "string" || !bucket.startsWith(`zenith-${plan.settings.runId}-`)) refuse("the plan has no owned run bucket");
        const readback = (id: string): Call => s3?.product?.find(c => c.id === id) ?? refuse("the plan has no independent S3 readback call");
        const workspace = plan.settings.runId, region = plan.settings.region;
        const backupKey = randomBytes(32).toString("hex");
        const sql = seams.sql ?? await (async () => {
          const { openPlatformDb } = await import("@/lib/controlplane/db");
          const db = await openPlatformDb({ kind: "postgres", url: databaseUrl!, max: 1, migrate: false });
          closeOpened = () => db.close();
          return db;
        })();
        handle = sql;
        const run = seams.run ?? hostRun;
        const pass = (apply: boolean) => run({ script: "scripts/data-retention.ts", args: [], env: childEnv(env, { region, bucket, databaseUrl: databaseUrl!, backupKey, apply }), timeoutMs: ARCHIVE_TIMEOUT_MS }, cwd!);
        const archiveCli = (args: readonly string[], key: string) => run({ script: "scripts/retention-archive.ts", args, env: childEnv(env, { region, bucket, databaseUrl: databaseUrl!, backupKey: key, apply: false }), timeoutMs: CHECK_TIMEOUT_MS }, cwd!);

        step = "seed";
        const now = new Date();
        const seeded = await seed(sql, workspace, now);

        step = "archive pass";
        const archived = await pass(false);
        if (archived.code !== 0 || archived.timedOut) refuse(`the archive pass did not complete (${archived.timedOut ? "timed out" : archived.failure ?? "no failure kind reported"}; no completion claim)`);
        const archives = await sql.query<ArchiveRow>("select id, data_class, object_key, row_count, first_row_id, last_row_id, pruned_rows from platform.retention_archives where workspace_id = $1 order by data_class", [workspace]);
        const runnerArchive = archives.find(a => a.data_class === "runner_job_logs"), machineArchive = archives.find(a => a.data_class === "machine_request_logs");
        if (archives.length !== 2 || !runnerArchive || !machineArchive) refuse("the archive pass did not record one archive per log class");
        if (runnerArchive.row_count !== seeded.runnerOld.length || String(runnerArchive.first_row_id) !== seeded.runnerOld[0] || String(runnerArchive.last_row_id) !== seeded.runnerOld.at(-1)
          || machineArchive.row_count !== seeded.machineOld.length || String(machineArchive.first_row_id) !== seeded.machineOld[0] || String(machineArchive.last_row_id) !== seeded.machineOld.at(-1)) {
          refuse("the archive records do not match the seeded unheld out-of-window rows");
        }
        if (BigInt(runnerArchive.last_row_id) >= BigInt(seeded.runnerHeld)) refuse("the runner archive reached the legal-hold row");

        step = "S3 readback";
        const listed = async (id: string) => {
          const response = await call(readback(id));
          if (response.IsTruncated === true) refuse("the S3 readback listing was truncated");
          const contents = Array.isArray(response.Contents) ? response.Contents : [];
          return contents.map(item => (item as { Key?: unknown }).Key);
        };
        const runnerKeys = await listed("s3-retention-readback-runner"), machineKeys = await listed("s3-retention-readback-machine");
        // Exactly one archive object per class: the listing under the class prefix must be that object and nothing else.
        const keysMatch = (keys: unknown[], archive: ArchiveRow) => keys.length === 1 && keys[0] === archive.object_key;
        if (!keysMatch(runnerKeys, runnerArchive)) refuse("the runner archive object is not listed under its class prefix exactly as recorded");
        if (!keysMatch(machineKeys, machineArchive)) refuse("the machine archive object is not listed under its class prefix exactly as recorded");

        step = "integrity";
        const rightKey = await archiveCli(["verify", runnerArchive.id], backupKey);
        const rightMachine = await archiveCli(["verify", machineArchive.id], backupKey);
        const rightRunner = jsonLine(rightKey.stdout), rightMachineJson = jsonLine(rightMachine.stdout);
        if (rightKey.code !== 0 || rightRunner?.ok !== true || rightRunner.rows !== seeded.runnerOld.length) refuse("verify with the archive key did not pass for the runner archive");
        if (rightMachine.code !== 0 || rightMachineJson?.ok !== true || rightMachineJson.rows !== seeded.machineOld.length) refuse("verify with the archive key did not pass for the machine archive");
        const wrongKey = await archiveCli(["verify", runnerArchive.id], randomBytes(32).toString("hex"));
        if (wrongKey.code === 0 || jsonLine(wrongKey.stdout)?.ok === true) refuse("verify with a wrong key was not refused");
        const suffix = `live_${workspace.toLowerCase().replace(/[^a-z0-9_]/g, "_")}`;
        stage = `retention_stage_${suffix}`;
        const restoredRunner = await archiveCli(["restore", runnerArchive.id, "--staging", suffix], backupKey);
        const restoredMachine = await archiveCli(["restore", machineArchive.id, "--staging", suffix], backupKey);
        if (jsonLine(restoredRunner.stdout)?.verdict !== "verified" || jsonLine(restoredMachine.stdout)?.verdict !== "verified") refuse("the staging restore did not verify");
        const stagedRunner = await sql.query<{ id: string }>(`select id::text as id from "${stage}".runner_job_logs where workspace_id = $1`, [workspace]);
        const stagedMachine = await sql.query<{ id: string }>(`select id::text as id from "${stage}".machine_request_logs where workspace_id = $1`, [workspace]);
        if (!sameIds(stagedRunner.map(r => r.id), seeded.runnerOld) || !sameIds(stagedMachine.map(r => r.id), seeded.machineOld)) refuse("the staging restore ids do not match the seeded unheld out-of-window rows");

        step = "prune gate closed";
        const beforeClosed = await presentLogs(sql, workspace);
        const expectedAll = { runner: [...seeded.runnerOld, seeded.runnerHeld, ...seeded.runnerRecent], machine: [...seeded.machineOld, ...seeded.machineRecent] };
        if (!sameIds(beforeClosed.runner, expectedAll.runner) || !sameIds(beforeClosed.machine, expectedAll.machine)) refuse("the seeded rows changed before the prune gate check");
        const closed = await pass(false);
        if (closed.code !== 0 || closed.timedOut) refuse(`the pass with the apply switch unset did not complete (${closed.timedOut ? "timed out" : closed.failure ?? "no failure kind reported"})`);
        const afterClosed = await presentLogs(sql, workspace);
        if (!sameIds(afterClosed.runner, expectedAll.runner) || !sameIds(afterClosed.machine, expectedAll.machine)) refuse("rows were removed with the apply switch unset");

        step = "prune gate open";
        const auditBefore = await auditCounts(sql, workspace);
        const opened1 = await pass(true);
        if (opened1.code !== 0 || opened1.timedOut) refuse(`the pass with the apply switch set did not complete (${opened1.timedOut ? "timed out" : opened1.failure ?? "no failure kind reported"})`);
        const afterOpen = await presentLogs(sql, workspace);
        if (!sameIds(afterOpen.runner, [seeded.runnerHeld, ...seeded.runnerRecent]) || !sameIds(afterOpen.machine, seeded.machineRecent)) {
          refuse("the prune did not remove exactly the archived unheld out-of-window rows");
        }
        const auditAfter = await auditCounts(sql, workspace);
        const changed = AUDIT_TABLES.filter(t => auditBefore[t] !== auditAfter[t]);
        if (changed.length) refuse("an audit or receipt table row count changed during the prune");
        const pruned = await sql.query<{ n: number }>("select coalesce(sum(pruned_rows), 0)::int as n from platform.retention_archives where workspace_id = $1", [workspace]);
        if (Number(pruned[0]?.n) !== seeded.runnerOld.length + seeded.machineOld.length) refuse("the archive records do not account for the pruned rows");

        const counts = `${seeded.runnerOld.length + seeded.machineOld.length} archived unheld rows removed; 1 legal-hold row and ${seeded.runnerRecent.length + seeded.machineRecent.length} in-window rows kept`;
        return {
          complete: true,
          reason: `PROD-OPS-07 proven by independent readback: sealed objects are listed under retention/${workspace}/ for both classes and match their archive records; verify passes with the archive key and refuses a wrong key; the staging restore returns the unheld out-of-window ids; with ZENITH_RETENTION_APPLY unset nothing is removed; with it set, ${counts}; audit and receipt row counts are unchanged. Gates: built-in DEC-RETENTION baseline (approval recorded for ${DEFAULT_RETENTION_POLICY.approval?.approvedBy ?? "unknown"}), the apply switch, and one legal hold. No in-product proposal or approval was used in this flow.`,
        };
      } catch (error) {
        if (error instanceof Refusal) return { complete: false, reason: `PROD-OPS-07 not proven at ${step}: ${error.message}` };
        return { complete: false, reason: `PROD-OPS-07 not proven at ${step}: unexpected failure (details withheld; no completion claim)` };
      } finally {
        // Our own staging schema from this run only; its restore is already proven and audited.
        if (stage && handle) await handle.query(`drop schema if exists "${stage}" cascade`).catch(() => undefined);
        await closeOpened?.().catch(() => undefined);
      }
    },
  };
}
