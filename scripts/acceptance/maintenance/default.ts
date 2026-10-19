/** Genuine default activities on natural Temporal timers. No schedule.trigger, backdated health or fake activities. */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { readFile } from "node:fs/promises";
import { Client, Connection, ScheduleNotFoundError } from "@temporalio/client";
import { temporalDataConverterFromEnv } from "@/lib/workflows/codec";
import { connectionOptionsFor, temporalConfigFromEnv } from "@/lib/workflows/config";
import { openPlatformDb, repos } from "@/lib/controlplane/db";
import { withLease } from "@/lib/controlplane/leases";
import { CRITICAL_JOBS } from "@/lib/platform/critical-jobs";
import { assertCompatibleCriticalSchedule, CRITICAL_SCHEDULE_ID } from "@/lib/workflows/critical-schedule";
import { assertCompatibleReconcileSchedule, RECONCILE_SCHEDULE_ID } from "@/lib/workflows/reconcile-schedule";
import { TASK_QUEUE } from "@/lib/workflows/types";
import { assignPlan } from "@/lib/billing/store";
import { DEFAULT_PLAN_ID } from "@/lib/billing/plans";
import { localUrl, CORE_JOBS, assertMaintenancePreconditions, seededEpoch } from "./preconditions";

// Durable-only maintenance entries with no HTTP fallback route.
const ADDENDA_JOBS = ["key-rewrap", "data-minimize", "data-retention", "managed-serving"] as const;

async function wait<T>(read: () => Promise<T | false>, budgetMs = 180_000): Promise<T> {
  const deadline = Date.now() + budgetMs;
  do { const value = await read(); if (value !== false) return value; await new Promise(resolve => setTimeout(resolve, 1000)); } while (Date.now() < deadline);
  throw new Error("Default maintenance acceptance deadline exceeded.");
}
async function closedWithin(child: ChildProcess, timeoutMs: number): Promise<{ code: number | null; signal: NodeJS.Signals | null } | undefined> {
  return new Promise(resolve => {
    const timer = setTimeout(() => { child.removeListener("close", onClose); resolve(undefined); }, timeoutMs);
    const onClose = (code: number | null, signal: NodeJS.Signals | null) => { clearTimeout(timer); resolve({ code, signal }); };
    child.once("close", onClose);
  });
}
interface WorkerOwnership { restartOrdinal: number; workerIdentity: string }
interface WorkerCloseout extends WorkerOwnership { pid: number; closed: true; exitCode: number | null; signal: NodeJS.Signals | null }
const workerOwnership = new WeakMap<ChildProcess, WorkerOwnership>();
export type MaintenanceDiagnosticPhase =
  | "preconditions" | "temporal_setup" | "seed_owned_records" | "natural_timer_health"
  | "critical_schedule_contract" | "reconcile_schedule_contract" | "natural_timer_effects"
  | "billing_durable_fallback" | "lease_exclusion" | "worker_stop" | "real_worker_outage"
  | "outage_fallback" | "billing_idempotency" | "worker_restart" | "restart_catchup"
  | "api_health" | "epoch_check";
const maintenanceFailurePhases = new WeakMap<object, MaintenanceDiagnosticPhase>();
/** Return only a phase attached to the original error caught by this source-owned driver. */
export function maintenanceFailurePhase(error: unknown): MaintenanceDiagnosticPhase | undefined {
  return error !== null && (typeof error === "object" || typeof error === "function")
    ? maintenanceFailurePhases.get(error)
    : undefined;
}
export async function stopOwnedWorker(child: ChildProcess): Promise<WorkerCloseout | undefined> {
  const ownership = workerOwnership.get(child);
  assert(Number.isSafeInteger(child.pid) && child.pid! > 0, "Owned worker identity is unavailable.");
  assert(child.exitCode === null && child.signalCode === null, "Owned worker exited before the planned stop.");
  assert(child.kill("SIGTERM"), "Could not signal the owned worker for shutdown.");
  let result = await closedWithin(child, 15_000);
  if (!result) {
    const killed = child.kill("SIGKILL");
    result = await closedWithin(child, 5_000);
    assert(result, "Owned worker did not close after SIGKILL.");
    assert(killed, "Owned worker required forced termination.");
  }
  assert(result.signal === "SIGTERM" || (result.signal === null && result.code === 0), "Owned worker did not stop cleanly after SIGTERM.");
  assert(result.signal === "SIGTERM" && result.code === null || result.signal === null && result.code === 0, "Owned worker close event was not a graceful SIGTERM settlement.");
  return ownership ? { pid: child.pid!, ...ownership, closed: true, exitCode: result.code, signal: result.signal } : undefined;
}
export async function defaultMaintenanceAcceptance(): Promise<Record<string, unknown>> {
  assert(process.env.ZENITH_TEST_MAINTENANCE === "1", "Not run: needs the Mac default stack and ZENITH_TEST_MAINTENANCE=1.");
  localUrl(process.env.ZENITH_PLATFORM_DB_URL ?? "", ["postgres:", "postgresql:"]);
  localUrl(process.env.ZENITH_J4_API_ORIGIN ?? "", ["http:", "https:"]);
  const dataConverter = temporalDataConverterFromEnv(process.env);
  const db = await openPlatformDb({ kind: "postgres", url: process.env.ZENITH_PLATFORM_DB_URL!, migrate: false, max: 2 });
  let connection: Connection | undefined, worker: ChildProcess | undefined;
  let restartOrdinal = 0;
  const workerClosures: WorkerCloseout[] = [];
  const hostWorkerClosure = { schemaVersion: 1, kind: "owned_child_closeouts", runId: randomUUID(),
    namespace: process.env.ZENITH_TEMPORAL_NAMESPACE, children: workerClosures, graceful: false as boolean };
  const ownedSchedules: string[] = [];
  const workspaceId = `j4-billing-${randomUUID()}`;
  const observedJobs = [...CORE_JOBS, "billing", ...ADDENDA_JOBS] as const;
  let primaryFailure: { value: unknown } | undefined;
  let phase: MaintenanceDiagnosticPhase = "preconditions";
  try {
    phase = "preconditions";
    const epoch = await assertMaintenancePreconditions(db, process.env);
    phase = "temporal_setup";
    connection = await Connection.connect(connectionOptionsFor(temporalConfigFromEnv()));
    const client = new Client({ connection, namespace: process.env.ZENITH_TEMPORAL_NAMESPACE, dataConverter });
    for (const id of [CRITICAL_SCHEDULE_ID, RECONCILE_SCHEDULE_ID]) await assert.rejects(client.schedule.getHandle(id).describe(), ScheduleNotFoundError);
    for (const taskQueueType of [1, 2]) {
      const queue = await client.workflowService.describeTaskQueue({ namespace: process.env.ZENITH_TEMPORAL_NAMESPACE, taskQueue: { name: TASK_QUEUE }, taskQueueType });
      assert((queue.pollers?.length ?? 0) === 0, "Isolated namespace already has a worker.");
    }
    phase = "seed_owned_records";
    // Record fixture timestamps only after the migration's immutable epoch. No singleton INSERT/UPDATE/DELETE.
    await assignPlan(db, { workspaceId, planId: DEFAULT_PLAN_ID, actor: "test:j4", reason: "owned local rehearsal" });
    const nonce = randomUUID();
    await db.query("insert into platform.agent_nonces(agent_id, nonce, seen_at) values ($1,$2,clock_timestamp() - interval '21 minutes')", [workspaceId, nonce]);
    const secret = (await readFile(process.env.ZENITH_J4_CRON_SECRET_FILE!, "utf8")).trim();
    assert(secret.length > 0, "Cron-secret file is empty.");
    const http = async (route: string) => {
      const response = await fetch(new URL(route, process.env.ZENITH_J4_API_ORIGIN), { method: "POST", headers: { authorization: `Bearer ${secret}` }, redirect: "error", signal: AbortSignal.timeout(15_000) });
      assert(response.ok, "Default tick/status HTTP request failed.");
      return await response.json() as Record<string, unknown>;
    };
    const start = () => {
      const identity = `j4-maintenance-${randomUUID()}`;
      const child = spawn(process.execPath, ["--import", "tsx", "workers/execution/worker.ts"], { env: { ...process.env, NODE_OPTIONS: "--max-old-space-size=1024", ZENITH_WORKER_IDENTITY: identity, ZENITH_WORKER_RECONCILE_SCHEDULE_MODE: "provision", ZENITH_WORKER_RECONCILE_MAX_ENVIRONMENTS: "1", ZENITH_WORKER_RECONCILE_CONCURRENCY: "1" }, stdio: "ignore", windowsHide: true });
      child.once("error", () => { /* wait() fails on absent health; no secret-bearing diagnostics */ });
      restartOrdinal++;
      workerOwnership.set(child, { restartOrdinal, workerIdentity: identity });
      worker = child;
    };
    const healthy = async (minimum: number) => {
      assert(worker?.exitCode === null && worker?.signalCode === null, "Owned worker exited.");
      const rows = await repos.scheduledJobs.listScheduledJobs(db);
      return observedJobs.every(job => rows.some(row => row.job === job && row.runsTotal >= minimum && row.lastStatus === "ok" && row.lastSuccessSource === "temporal")) ? rows : false;
    };
    const assertAddendumNoOverlap = async (job: typeof ADDENDA_JOBS[number], alsoBusy: readonly string[] = [], signals: readonly AbortSignal[] = []) => {
      await withLease(db, { scope: `critical-job:${job}`, holder: `test:j4:${job}:${randomUUID()}`, ttlMs: CRITICAL_JOBS[job].leaseTtlMs }, async (_lease, leaseSignal) => {
        const before = await repos.scheduledJobs.getScheduledJob(db, job);
        assert(before, `No successful run record exists for ${job}.`);
        const actions = (await client.schedule.getHandle(CRITICAL_SCHEDULE_ID).describe()).info.numActionsTaken;
        await wait(async () => {
          leaseSignal.throwIfAborted();
          for (const signal of signals) signal.throwIfAborted();
          const current = await client.schedule.getHandle(CRITICAL_SCHEDULE_ID).describe();
          if (current.info.numActionsTaken <= actions || current.info.runningActions.length) return false;
          const recent = current.info.recentActions.at(-1);
          assert(recent?.action.type === "startWorkflow", "Natural action is absent.");
          const result = await client.workflow.getHandle(recent.action.workflow.workflowId, recent.action.workflow.firstExecutionRunId).result() as Record<string, string>;
          assert(result[job] === "busy", `Natural maintenance action overlapped the held ${job} lease.`);
          assert(alsoBusy.every(name => result[name] === "busy"), "Natural maintenance action overlapped a held core-job lease.");
          const after = await repos.scheduledJobs.getScheduledJob(db, job);
          assert(after?.runsTotal === before.runsTotal, `A run record was added while the ${job} lease was held.`);
          return true;
        }, 90_000);
      });
    };
    phase = "natural_timer_health";
    ownedSchedules.push(CRITICAL_SCHEDULE_ID, RECONCILE_SCHEDULE_ID);
    start();
    const first = await wait(() => healthy(1));

    phase = "critical_schedule_contract";
    const critical = await client.schedule.getHandle(CRITICAL_SCHEDULE_ID).describe();
    assertCompatibleCriticalSchedule(critical);
    phase = "reconcile_schedule_contract";
    assertCompatibleReconcileSchedule(await client.schedule.getHandle(RECONCILE_SCHEDULE_ID).describe(), { contract: "zenith.reconcile-sweep.v1", maxEnvironments: 1, environmentConcurrency: 1 });
    phase = "natural_timer_effects";
    assert(!critical.state.paused && critical.info.numActionsTaken > 0, "Natural maintenance timer never fired.");
    const pruned = await db.query("select nonce from platform.agent_nonces where agent_id=$1 and nonce=$2", [workspaceId, nonce]);
    assert(pruned.length === 0, "Default housekeeping did not prune the seeded expired nonce.");
    assert(first.find(row => row.job === "billing")!.lastCounts.accounts >= 1, "Default billing did not examine durable accounts.");
    phase = "billing_durable_fallback";
    assert((await http("/api/internal/tick/billing")).deferred === "durable_current", "Billing HTTP fallback did not yield to the durable timer.");
    phase = "lease_exclusion";
    // Hold the real shared lease across a natural timer, then issue the actual fallback route.
    await withLease(db, { scope: "critical-job:runbooks", holder: `test:j4:${randomUUID()}`, ttlMs: 120_000 }, async (_lease, signal) => {
      await withLease(db, { scope: "critical-job:billing", holder: `test:j4:${randomUUID()}`, ttlMs: 120_000 }, async (_billingLease, billingSignal) => {
        const before = (await repos.scheduledJobs.getScheduledJob(db, "runbooks"))!.runsTotal;
        const billingBefore = (await repos.scheduledJobs.getScheduledJob(db, "billing"))!.runsTotal;
        await assertAddendumNoOverlap(ADDENDA_JOBS[0], ["runbooks", "billing"], [signal, billingSignal]);
        const fallback = await http("/api/internal/tick/runbooks");
        assert(["busy", "durable_current"].includes(String(fallback.deferred)), "HTTP fallback did not defer.");
        assert((await repos.scheduledJobs.getScheduledJob(db, "runbooks"))!.runsTotal === before, "A second runbook pass overlapped.");
        const billingFallback = await http("/api/internal/tick/billing");
        assert(["busy", "durable_current"].includes(String(billingFallback.deferred)), "Billing HTTP fallback did not defer behind the held lease.");
        assert((await repos.scheduledJobs.getScheduledJob(db, "billing"))!.runsTotal === billingBefore, "A second billing pass overlapped.");
      });
    });
    for (const job of ADDENDA_JOBS.slice(1)) await assertAddendumNoOverlap(job);
    phase = "worker_stop";
    const firstCloseout = await stopOwnedWorker(worker!);
    assert(firstCloseout, "Owned worker closeout proof is unavailable.");
    workerClosures.push(firstCloseout); worker = undefined;
    phase = "real_worker_outage";
    // Real elapsed time, longer than both fallback deferral and two minute cadences.
    const until = Date.now() + 125_000;
    while (Date.now() < until) await new Promise(resolve => setTimeout(resolve, Math.min(1000, until - Date.now())));
    phase = "outage_fallback";
    const fallback = await http("/api/internal/tick/runbooks");
    assert(fallback.ran === true, "Fallback did not resume during the worker outage.");
    assert((await repos.scheduledJobs.getScheduledJob(db, "runbooks"))!.lastSuccessSource === "fallback");
    const billingFallback = await http("/api/internal/tick/billing");
    assert(billingFallback.enabled === true && billingFallback.deferred === undefined && Number(billingFallback.accounts) >= 1 && billingFallback.invoiceErrors === 0, "Billing fallback did not resume during the real worker outage.");
    assert((await repos.scheduledJobs.getScheduledJob(db, "billing"))!.lastSuccessSource === "fallback");
    phase = "billing_idempotency";
    const invoices = await db.query("select id, period from platform.billing_invoices where workspace_id=$1 order by period", [workspaceId]);
    const repeatedBilling = await http("/api/internal/tick/billing");
    assert(repeatedBilling.enabled === true && repeatedBilling.deferred === undefined && repeatedBilling.invoicesCreated === 0 && repeatedBilling.invoiceErrors === 0, "Repeated authenticated billing fallback did not converge.");
    assert.deepEqual(await db.query("select id, period from platform.billing_invoices where workspace_id=$1 order by period", [workspaceId]), invoices, "Repeated billing fallback duplicated invoices.");
    phase = "worker_restart";
    const beforeRestart = await repos.scheduledJobs.listScheduledJobs(db);
    const previousActions = (await client.schedule.getHandle(CRITICAL_SCHEDULE_ID).describe()).info.numActionsTaken;
    start();
    phase = "restart_catchup";
    const after = await wait(async () => {
      const rows = await healthy(2);
      return rows && observedJobs.every(job => rows.find(r => r.job === job)!.runsTotal > beforeRestart.find(r => r.job === job)!.runsTotal) ? rows : false;
    });
    const recovered = await client.schedule.getHandle(CRITICAL_SCHEDULE_ID).describe();
    assertCompatibleCriticalSchedule(recovered);
    assert(recovered.info.numActionsTaken >= previousActions, "Schedule history did not survive worker restart.");
    assert(after.find(r => r.job === "housekeeping")!.missedTicksTotal > 0, "Natural outage was not counted.");
    assert(ADDENDA_JOBS.every(job => after.find(r => r.job === job)!.missedTicksTotal > beforeRestart.find(r => r.job === job)!.missedTicksTotal),
      "A durable-only addendum did not record missed ticks across the worker outage.");
    phase = "api_health";
    const status = await http("/api/internal/tick/status");
    assert(Array.isArray(status.jobs) && observedJobs.every(job => (status.jobs as { job: string; durable: boolean; state: string }[]).some(row => row.job === job && row.durable && row.state === "healthy")), "Default API health does not match durable readback.");
    phase = "epoch_check";
    assert(await seededEpoch(db) === epoch, "Published cleanup epoch changed.");
    return { schema: 1, level: "local_engine", runId: hostWorkerClosure.runId, naturalTimers: true, schedules: 2, criticalJobs: CORE_JOBS.length, billing: true, billingFallback: true, billingFallbackIdempotent: true, workerRestart: true, fallbackResumed: true, jobLeaseExclusion: true, maintenanceAddenda: [...ADDENDA_JOBS], addendaLeaseExclusion: true, addendaRestartCatchup: true, housekeepingEffect: true, epochPreserved: true, hostWorkerClosure };
  } catch (error) {
    if (error !== null && (typeof error === "object" || typeof error === "function")) maintenanceFailurePhases.set(error, phase);
    primaryFailure = { value: error };
    throw error;
  } finally {
    const errors: unknown[] = [];
    // Drain while our worker is still alive. A cleanup failure never prevents stopping our child.
    if (connection && worker && worker.exitCode === null && worker.signalCode === null) {
      try {
        const client = new Client({ connection, namespace: process.env.ZENITH_TEMPORAL_NAMESPACE, dataConverter });
        for (const id of ownedSchedules) {
          try { await client.schedule.getHandle(id).pause("J4 owned cleanup drain."); }
          catch (error) { if (!(error instanceof ScheduleNotFoundError)) throw error; }
        }
        await wait(async () => {
          for (const id of ownedSchedules) {
            try { if ((await client.schedule.getHandle(id).describe()).info.runningActions.length) return false; }
            catch (error) { if (!(error instanceof ScheduleNotFoundError)) throw error; }
          }
          return true;
        }, 120_000);
      } catch (error) { errors.push(error); }
    }
    try {
      if (worker) {
        const closeout = await stopOwnedWorker(worker);
        assert(closeout, "Owned worker closeout proof is unavailable.");
        workerClosures.push(closeout);
      }
    } catch (error) { errors.push(error); }
    if (connection) {
      try {
        if (!errors.length) {
          const client = new Client({ connection, namespace: process.env.ZENITH_TEMPORAL_NAMESPACE, dataConverter });
          for (const id of ownedSchedules) {
            const handle = client.schedule.getHandle(id);
            try { await handle.pause("J4 owned rehearsal cleanup."); }
            catch (error) { if (error instanceof ScheduleNotFoundError) continue; throw error; }
            const current = await handle.describe();
            assert(current.info.runningActions.length === 0, "Running workflow remains; retain namespace/database.");
            await handle.delete();
            await assert.rejects(handle.describe(), ScheduleNotFoundError);
          }
        }
      } catch (error) { errors.push(error); }
      finally { try { await connection.close(); } catch (error) { errors.push(error); } }
    }
    try { await db.close(); } catch (error) { errors.push(error); }
    if (!errors.length && (workerClosures.length !== 2
      || workerClosures.some((entry, index) => entry.restartOrdinal !== index + 1 || !entry.closed || !(entry.signal === "SIGTERM" && entry.exitCode === null || entry.signal === null && entry.exitCode === 0))
      || new Set(workerClosures.map(entry => entry.pid)).size !== 2 || new Set(workerClosures.map(entry => entry.workerIdentity)).size !== 2)) {
      errors.push(new Error("Owned worker closeout proof is incomplete."));
    }
    if (errors.length) {
      if (primaryFailure) throw new AggregateError(errors, "Owned maintenance cleanup is unconfirmed; retain namespace/database.", { cause: primaryFailure.value });
      throw new AggregateError(errors, "Owned maintenance cleanup is unconfirmed; retain namespace/database.");
    }
    hostWorkerClosure.graceful = true;
  }
}
