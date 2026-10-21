/**
 * The clean-host restore runbook, as code (PROD-OPS-04).
 *
 * Each step either passes, is refused with a reason, or is handed to a named human; none is "best effort". The
 * order is the one that keeps the lost timeline from acting on the restored one:
 *
 *  1. verify    manifest digest and every file's size and SHA-256. A damaged backup restores nothing.
 *  2. gates     skipped components, the customer-state confirmation and the hosted bundle are explicit decisions.
 *  3. keys      the target host must already hold every key id the backup needs (OPS-05 registry); ids only.
 *  4. empty     the target database must hold none of the stores being restored. Never an in-place overwrite.
 *  5. restore   one atomic pg_restore (--single-transaction --exit-on-error), then forward-migrate to this build.
 *  6. facts     restored row counts must equal the counts recorded under the backup's snapshot.
 *  7. epoch     bump the recovery epoch (idempotent per run id): leases expired, fences lifted, running operations
 *               uncertain, grants revoked, jobs closed, pending effects uncertain, in-flight work listed for a human.
 *  8. temporal  terminate open operation workflows (the lost timeline's) so none acts on the restored ledger.
 *  9. report    RPO/RTO from recorded timestamps, the open continuation count, and what still needs a person.
 *
 * Nothing destructive happens by default: the runbook only ever writes into an empty target. The one terminating
 * action (Temporal) requires `--terminate-temporal` and an address.
 */
import { copyFile, mkdir, readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import type { PlatformDb } from "@/lib/controlplane/types";
import { bumpRecoveryEpoch, type BumpResult } from "@/lib/controlplane/recovery";
import {
  COMPONENT_IDS, verifyBackupDirectory, sha256File, type BackupManifest, type ComponentId, type KeyRequirement, type ManifestComponent,
} from "./manifest";
import { RecoveryToolError, mustRun, pgArgs, scrub, temporalConnectionArgs, type CommandRunner, type TemporalCliTls, type Tools } from "./process";
import { RECOVERY_REPORT_FORMAT, fileSink, deliverReport, measureContinuation, measureRecovery, targetsFromEnv, type ContinuationMeasurement, type RecoveryMeasurement } from "./report";

export type StepStatus = "ok" | "refused" | "handed_off" | "skipped" | "not_run";
export interface RestoreStep { readonly id: string; readonly status: StepStatus; readonly detail: string; readonly at: string }

export interface RestoreOptions {
  backupDir: string;
  /** direct connection string of the EMPTY target database; never recorded */
  targetUrl: string;
  /** stable per restore attempt: a re-run after a crash passes the same id and never bumps twice */
  runId: string;
  actor: string;
  reason: string;
  /** highest epoch the lost system is known to have reached, if the operator knows it */
  observedEpoch?: number;
  incidentAt?: string;
  noPrivileges?: boolean;
  /** components the operator knowingly accepts as missing (by name) */
  acceptSkipped?: readonly ComponentId[];
  confirmCustomerState?: boolean;
  /** key ids available on THIS host (from the key registry); ids and roles only */
  keysAvailable: readonly KeyRequirement[];
  /** where to place the product file store and the hosted bundle, when they were captured */
  productDataDir?: string;
  hostedBundleOut?: string;
  artifactDir?: string;
  temporal?: { address?: string; tls?: TemporalCliTls; namespace: string; terminate: boolean };
  reportFile: string;
}

export interface RestoreDeps {
  run: CommandRunner;
  tools: Tools;
  /** open the restored database; `migrate: true` brings it forward to this build */
  openTarget(url: string, options: { migrate: boolean }): Promise<PlatformDb>;
  now?: () => Date;
  env?: Readonly<Record<string, string | undefined>>;
}

export interface RestoreReport {
  readonly format: typeof RECOVERY_REPORT_FORMAT;
  readonly runId: string;
  readonly backupId: string;
  readonly manifestDigest: string;
  readonly ok: boolean;
  readonly steps: readonly RestoreStep[];
  readonly epoch: number | null;
  readonly counts: BumpResult["counts"] | null;
  readonly replayed: boolean;
  readonly measurement: RecoveryMeasurement | null;
  readonly continuation: ContinuationMeasurement | null;
  /** what a person must still do before the install is operationally recovered */
  readonly needsPerson: readonly string[];
}

const MIGRATED_STORES = ["platform", "agent", "hosted"] as const;
const TEMPORAL_OPEN_WORKFLOW_QUERY = '(WorkflowId STARTS_WITH "op-" OR WorkflowId STARTS_WITH "reconcile-") AND ExecutionStatus="Running"';
const TEMPORAL_MAX_OPEN_WORKFLOWS = 1_000;
const TEMPORAL_TIMEOUT_MS = 120_000;
const TEMPORAL_MAX_OUTPUT_BYTES = 1_048_576;

interface TemporalWorkflowExecution { workflowId: string; runId: string }

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function parseTemporalRunningList(stdout: string): TemporalWorkflowExecution[] {
  let value: unknown;
  try { value = JSON.parse(stdout); } catch { throw new RecoveryToolError("refused", "Temporal workflow list returned invalid JSON."); }
  if (!Array.isArray(value) || value.length > TEMPORAL_MAX_OPEN_WORKFLOWS) throw new RecoveryToolError("refused", "Temporal workflow list returned an invalid or oversized execution inventory.");
  const seen = new Set<string>();
  return value.map((item) => {
    const entry = object(item);
    const execution = object(entry?.execution);
    const workflowId = execution?.workflowId;
    const runId = execution?.runId;
    if (!execution || Object.keys(execution).sort().join(",") !== "runId,workflowId" || typeof workflowId !== "string" || !workflowId || typeof runId !== "string" || !runId || entry?.status !== "WORKFLOW_EXECUTION_STATUS_RUNNING")
      throw new RecoveryToolError("refused", "Temporal workflow list returned an incomplete or unexpected execution identity.");
    if (!workflowId.startsWith("op-") && !workflowId.startsWith("reconcile-")) throw new RecoveryToolError("refused", "Temporal workflow list returned an execution outside the recovery workflow prefixes.");
    const identity = `${workflowId}\0${runId}`;
    if (seen.has(identity)) throw new RecoveryToolError("refused", "Temporal workflow list returned a duplicate execution identity.");
    seen.add(identity);
    return { workflowId, runId };
  });
}

function requireTerminatedDescribe(stdout: string, expected: TemporalWorkflowExecution): void {
  let value: unknown;
  try { value = JSON.parse(stdout); } catch { throw new RecoveryToolError("refused", "Temporal workflow describe returned invalid JSON."); }
  const info = object(object(value)?.workflowExecutionInfo);
  const execution = object(info?.execution);
  if (!execution || Object.keys(execution).sort().join(",") !== "runId,workflowId" || execution.workflowId !== expected.workflowId || execution.runId !== expected.runId)
    throw new RecoveryToolError("refused", "Temporal workflow describe did not confirm the requested execution identity.");
  if (info?.status !== "WORKFLOW_EXECUTION_STATUS_TERMINATED") throw new RecoveryToolError("refused", "Temporal workflow describe did not confirm termination.");
}

/** Terminate each observed execution synchronously, then prove its status and the recovery query's empty postcondition. */
export async function terminateOpenTemporalWorkflows(run: CommandRunner, temporal: string, namespace: string, address?: string, tls?: TemporalCliTls): Promise<number> {
  const deadline = Date.now() + TEMPORAL_TIMEOUT_MS;
  const addressArgs = temporalConnectionArgs(address, tls);
  const runCommand = (label: string, args: readonly string[]) => {
    const timeoutMs = deadline - Date.now();
    if (timeoutMs <= 0) throw new RecoveryToolError("refused", "Temporal recovery termination exceeded its time limit.");
    return mustRun(run, label, temporal, args, { timeoutMs, maxBuffer: TEMPORAL_MAX_OUTPUT_BYTES });
  };
  const list = async () => parseTemporalRunningList((await runCommand("temporal workflow list", ["workflow", "list", ...addressArgs, "--namespace", namespace, "--query", TEMPORAL_OPEN_WORKFLOW_QUERY, "--output", "json"])).stdout);
  const observed = await list();
  for (const execution of observed) {
    await runCommand("temporal workflow terminate", ["workflow", "terminate", ...addressArgs, "--namespace", namespace, "--workflow-id", execution.workflowId, "--run-id", execution.runId, "--reason", "platform store restored (recovery epoch)"]);
    const described = await runCommand("temporal workflow describe", ["workflow", "describe", ...addressArgs, "--namespace", namespace, "--workflow-id", execution.workflowId, "--run-id", execution.runId, "--output", "json"]);
    requireTerminatedDescribe(described.stdout, execution);
  }
  if ((await list()).length !== 0) throw new RecoveryToolError("refused", "Temporal still has open recovery workflows after the observed executions were terminated.");
  return observed.length;
}

export async function runRestore(deps: RestoreDeps, options: RestoreOptions): Promise<RestoreReport> {
  const now = deps.now ?? (() => new Date());
  const startedAt = now().toISOString();
  const steps: RestoreStep[] = [];
  const needsPerson: string[] = [];
  const step = (id: string, status: StepStatus, detail: string): void => { steps.push({ id, status, detail, at: now().toISOString() }); };
  // Assigned once, after the closure below (finish) that reads it is defined.
  // eslint-disable-next-line prefer-const
  let manifest: BackupManifest | undefined;
  let epoch: number | null = null;
  let counts: BumpResult["counts"] | null = null;
  let replayed = false;
  let continuation: ContinuationMeasurement | null = null;
  let measurement: RecoveryMeasurement | null = null;
  let ok = false;
  let databaseFinishedAt: string | undefined;

  const finish = async (): Promise<RestoreReport> => {
    const finishedAt = now().toISOString();
    if (manifest) {
      measurement = measureRecovery({
        backupSnapshotAt: manifest.platform.snapshotAt, backupFinishedAt: manifest.finishedAt, restoreStartedAt: startedAt, restoreFinishedAt: databaseFinishedAt ?? finishedAt,
        incidentAt: options.incidentAt, targets: targetsFromEnv(deps.env ?? process.env),
      });
    }
    const report: RestoreReport = {
      format: RECOVERY_REPORT_FORMAT, runId: options.runId, backupId: manifest?.backupId ?? "unknown", manifestDigest: manifest?.digest ?? "unknown",
      ok, steps, epoch, counts, replayed, measurement, continuation, needsPerson,
    };
    const delivery = await deliverReport(report as unknown as Record<string, unknown>, options.reportFile);
    if (delivery.failed.length) {
      needsPerson.push(`Recovery measurement delivery failed: ${delivery.failed.join(", ")}. The restore report is not SLO publication evidence.`);
      // Persist the failure without retrying external sinks or publishing duplicate measurements.
      try { await fileSink(options.reportFile).record(report as unknown as Record<string, unknown>); } catch { /* The original delivery failure remains explicit in the returned hand-off. */ }
    }
    return report;
  };
  const refuse = async (id: string, detail: string): Promise<RestoreReport> => { step(id, "refused", detail); return finish(); };

  // 1. verify
  const verification = await verifyBackupDirectory(options.backupDir);
  if (!verification.ok || !verification.manifest)
    return refuse("verify", `The backup failed its integrity check: ${verification.problems.slice(0, 5).map((p) => `${p.code}${p.file ? ` (${p.file})` : ""}`).join(", ")}.`);
  manifest = verification.manifest;
  step("verify", "ok", `${verification.filesChecked} file(s) match the manifest; manifest digest ${manifest.digest.slice(0, 12)}.`);

  // 2. gates
  const byId = new Map<ComponentId, ManifestComponent>(manifest.components.map((c) => [c.id, c]));
  for (const id of COMPONENT_IDS) if (!byId.has(id)) return refuse("gates", `The manifest has no entry for ${id}; this backup predates the component list and cannot be trusted to be complete.`);
  const accepted = new Set(options.acceptSkipped ?? []);
  for (const c of manifest.components) {
    if (c.status === "skipped" && !accepted.has(c.id)) return refuse("gates", `${c.id} was skipped when the backup was taken (${c.note || "no reason recorded"}). Accept that gap by name with --accept-skipped ${c.id}, or take a complete backup.`);
  }
  if (!options.confirmCustomerState) return refuse("gates", "Customer OpenTofu state lives in the customer's own storage and is not in this backup. Confirm its versioning is intact with --confirm-customer-state.");
  if (manifest.components.find((c) => c.id === "product")?.status === "captured" && !options.productDataDir) return refuse("gates", "The product file store was captured; name an empty --product-data-dir to restore it into.");
  step("gates", "ok", "Every component is captured, covered, not applicable, or explicitly accepted or confirmed.");

  // 3. keys
  const have = new Set(options.keysAvailable.map((k) => `${k.purpose}|${k.keyId}`));
  const missing = manifest.keys.filter((k) => !have.has(`${k.purpose}|${k.keyId}`));
  if (missing.length > 0) return refuse("keys", `This host lacks ${missing.length} key id(s) the backup needs: ${missing.slice(0, 8).map((k) => `${k.purpose}:${k.keyId} (${k.role})`).join(", ")}. Restore the keys from your secret manager first; sealed data is unreadable without them.`);
  step("keys", "ok", `All ${manifest.keys.length} key id(s) the backup needs are configured on this host.`);

  // 4. empty target
  const conn = pgArgs(options.targetUrl);
  const platform = byId.get("platform")!;
  const schemas = String(platform.facts.schemas ?? "platform").split(",").filter(Boolean);
  let target: PlatformDb | undefined;
  try {
    target = await deps.openTarget(options.targetUrl, { migrate: false });
    const stores = schemas.filter((s) => (MIGRATED_STORES as readonly string[]).includes(s));
    const tables = await target.query<{ schema_name: string; n: number | string }>(
      `select table_schema as schema_name, count(*)::int as n from information_schema.tables where table_schema = any($1::text[]) group by table_schema`, [`{${stores.join(",")}}`]);
    const busy = tables.filter((t) => Number(t.n) > 0);
    if (busy.length > 0) {
      // A re-run of the SAME run id after a crash finds the restored stores: allow it only when this run already bumped the epoch.
      if (!(await alreadyBumped(target, options.runId))) return refuse("empty", `The target database already holds ${busy.map((t) => t.schema_name).join(", ")}. A restore only writes into an empty database; it never overwrites.`);
      step("empty", "ok", "The stores are already restored by this run id; continuing idempotently.");
    } else {
      step("empty", "ok", `The target holds none of: ${stores.join(", ")}.`);
      // 5. restore
      const dump = platform.files[0];
      await mustRun(deps.run, "pg_restore", deps.tools.pgRestore, [
        ...conn.args, "--no-owner", ...(options.noPrivileges ? ["--no-privileges"] : []), "--exit-on-error", "--single-transaction", path.join(options.backupDir, dump.path),
      ], { env: conn.env });
      step("restore", "ok", `Restored ${schemas.join(", ")} atomically from ${dump.path}.`);
    }
    await target.close();
    target = undefined;

    target = await deps.openTarget(options.targetUrl, { migrate: true });
    const version = Number((await target.query<{ v: number | string }>("select max(version) as v from platform.schema_migrations"))[0]?.v ?? 0);
    step("migrate", "ok", `Schema version ${manifest.platform.schemaVersion} brought forward to ${version}.`);

    // 6. facts
    const mismatched: string[] = [];
    const rerun = await alreadyBumped(target, options.runId);
    for (const [key, expected] of Object.entries(platform.facts)) {
      if (!key.startsWith("rows.") || typeof expected !== "number") continue;
      const table = key.slice(5);
      if (!/^[a-z_]{1,63}$/.test(table)) continue;
      const exists = (await target.query<{ ok: boolean }>("select to_regclass($1) is not null as ok", [`platform.${table}`]))[0]?.ok;
      if (!exists) { mismatched.push(`${table}: table missing`); continue; }
      const actual = Number((await target.query<{ n: number | string }>(`select count(*)::bigint as n from platform."${table}"`))[0]?.n ?? 0);
      // A re-run after the bump has opened items and (for recovery tables) rows; compare only what the bump never writes.
      if (table === "recovery_epochs" || table === "recovery_items" || table === "key_custody_keys") continue;
      if (!rerun && actual !== expected) mismatched.push(`${table}: ${actual} restored, ${expected} recorded`);
    }
    if (mismatched.length > 0) return refuse("facts", `Restored row counts differ from the backup's snapshot: ${mismatched.slice(0, 6).join("; ")}.`);
    step("facts", "ok", "Restored row counts equal the counts recorded under the backup snapshot.");

    // 7. epoch
    const bump = await bumpRecoveryEpoch(target, {
      restoreRunId: options.runId, actor: options.actor, reason: options.reason, manifestDigest: manifest.digest, backupId: manifest.backupId,
      backupTakenAt: manifest.platform.snapshotAt, observedEpoch: options.observedEpoch, manifestEpoch: manifest.platform.recoveryEpoch,
    });
    epoch = bump.epoch; counts = bump.counts; replayed = bump.replayed;
    step("epoch", "ok", `${bump.replayed ? "Already at" : "Advanced to"} recovery epoch ${bump.epoch} (was ${bump.priorEpoch}); ${bump.counts.itemsOpened} in-flight item(s) need a decision.`);
    if (bump.counts.itemsOpened > 0) needsPerson.push(`${bump.counts.itemsOpened} operation/intent/effect item(s) were in flight at the backup: decide each (npm run ops:recovery -- continue list / resume / abandon / keep, or POST /api/platform/v1/recovery/items/:id/decide).`);
    continuation = await measureContinuation(target, bump.epoch);
    databaseFinishedAt = now().toISOString();
  } catch (error) {
    if (target) await target.close().catch(() => undefined);
    const detail = error instanceof RecoveryToolError ? error.message : `Unexpected failure: ${scrub(error instanceof Error ? error.message : "unknown")}`;
    return refuse(steps.length ? `after_${steps[steps.length - 1].id}` : "restore", detail);
  }
  if (target) await target.close().catch(() => undefined);

  // product file store and hosted bundle
  try {
    const product = byId.get("product")!;
    if (product.status === "captured" && options.productDataDir) {
      await requireEmptyOrMissing(options.productDataDir);
      for (const f of product.files) {
        const out = path.join(options.productDataDir, f.path.replace(/^product\//, ""));
        await mkdir(path.dirname(out), { recursive: true });
        await copyFile(path.join(options.backupDir, f.path), out);
        if ((await sha256File(out)).sha256 !== f.sha256) throw new RecoveryToolError("integrity", "A restored product file differs from the manifest.");
      }
      step("product", "ok", `Restored ${product.files.length} product file(s) into the data directory.`);
    }
    const hosted = byId.get("hosted")!;
    if (hosted.status === "captured") {
      if (options.hostedBundleOut) {
        await mkdir(path.dirname(options.hostedBundleOut), { recursive: true });
        await copyFile(path.join(options.backupDir, hosted.files[0].path), options.hostedBundleOut);
      }
      step("hosted", "handed_off", "The hosted bundle is sealed: restore it with `npm run hosted:restore` (it reconciles revocations and leaves apps recovering), then reopen each app with `npm run hosted:reopen`.");
      needsPerson.push("Restore the hosted bundle with hosted:restore and reopen apps with hosted:reopen; apps stay closed until then.");
    }
    const artifacts = byId.get("artifacts")!;
    if (artifacts.status === "captured" && options.artifactDir) {
      const index = JSON.parse(await readFile(path.join(options.backupDir, "artifacts-index.json"), "utf8")) as { files: { path: string; bytes: number; sha256: string }[] };
      let missingCount = 0;
      for (const f of index.files) {
        const target2 = path.join(options.artifactDir, f.path);
        const backed = artifacts.files.find((x) => x.path === `artifacts/${f.path}`);
        if (backed && !(await fileExists(target2))) { await mkdir(path.dirname(target2), { recursive: true }); await copyFile(path.join(options.backupDir, backed.path), target2); }
        if (!(await fileExists(target2)) || (await sha256File(target2)).sha256 !== f.sha256) missingCount++;
      }
      step("artifacts", missingCount === 0 ? "ok" : "handed_off", missingCount === 0 ? `All ${index.files.length} artifact(s) match the index.` : `${missingCount} artifact(s) are missing or differ from the index; they are content-addressed, so re-publish or rebuild them from source.`);
      if (missingCount > 0) needsPerson.push(`${missingCount} hosted artifact(s) must be restored or rebuilt.`);
    }
  } catch (error) {
    return refuse("files", error instanceof RecoveryToolError ? error.message : `Unexpected failure: ${scrub(error instanceof Error ? error.message : "unknown")}`);
  }

  // 8. temporal
  const t = options.temporal;
  if (t?.terminate) {
    try {
      const open = await terminateOpenTemporalWorkflows(deps.run, deps.tools.temporal, t.namespace, t.address, t.tls);
      step("temporal", "ok", `Terminated ${open} open operation workflow(s) of the lost timeline; operations they covered are uncertain or held for a decision.`);
    } catch (error) {
      step("temporal", "refused", error instanceof RecoveryToolError ? error.message : "Temporal could not be reached.");
      needsPerson.push("Terminate open operation and reconcile workflows in Temporal before any worker starts (see RECOVERY.md section 3).");
      return finish();
    }
  } else {
    step("temporal", "handed_off", "Temporal was not touched. Terminate open operation and reconcile workflows before any worker starts, or rerun with --terminate-temporal.");
    needsPerson.push("Terminate open operation and reconcile workflows in Temporal before any worker starts.");
  }
  needsPerson.push("Keep workers and runners stopped until the Temporal step is done; reconcile provider state for the window after the backup snapshot (work done after it left no trace here).");
  needsPerson.push("After reopening the application, run recovery health --report FILE --readiness-url URL --token-file FILE to record first healthy readiness and application RTO.");
  ok = steps.every((s) => s.status === "ok" || s.status === "handed_off" || s.status === "skipped");
  return finish();
}

async function alreadyBumped(db: PlatformDb, runId: string): Promise<boolean> {
  try {
    return Number((await db.query<{ n: number | string }>("select count(*)::int as n from platform.recovery_epochs where restore_run_id = $1", [runId]))[0]?.n ?? 0) > 0;
  } catch { return false; }
}

async function fileExists(p: string): Promise<boolean> {
  try { await stat(p); return true; } catch { return false; }
}

async function requireEmptyOrMissing(dir: string): Promise<void> {
  try {
    if ((await readdir(dir)).length > 0) throw new RecoveryToolError("refused", "The product data directory is not empty; a restore never overwrites.");
  } catch (error) {
    if (error instanceof RecoveryToolError) throw error;
  }
}
