/**
 * Critical periodic jobs: one registry, one execution wrapper, one health view (PROD-OBS-04).
 *
 * The durable scheduler is a Temporal Schedule (`zenith-critical-maintenance-v1` for reaping,
 * housekeeping and runbooks; `zenith-reconcile-sweep-v1` for observation and the COST-03 optimizer
 * pass) served by the execution worker. The GitHub Actions cron and the in-process scheduler are
 * kept only as a *fallback trigger* and run the very same functions through `runCriticalJob`, so
 * both sources are idempotent with each other:
 *
 *  - Overlap prevention: each run holds a fenced database lease (`critical-job:<job>`); a second
 *    trigger from any source while one runs gets `busy` and does nothing. Temporal's own overlap
 *    policy is SKIP; the lease is what also excludes the HTTP fallback.
 *  - Fencing: the run record is stamped with the lease fence and only that fence may finish it, so
 *    a holder that lost its lease cannot overwrite the new holder's record.
 *  - Missed-run catch-up: every job is level-triggered and idempotent (it re-derives due work from
 *    durable rows), so a gap is closed by exactly one immediate pass, never by replaying missed
 *    ticks. The gap is recorded (`missed_ticks_total`) so an outage is visible afterwards.
 *  - Fallback deferral: while the durable scheduler has succeeded within `FALLBACK_DEFER_MS`, a
 *    fallback trigger is skipped (and counted). When the durable scheduler is down, the first
 *    fallback trigger after that window runs the job, so cron still keeps the platform alive.
 *  - Visibility: `platform.scheduled_job_runs` keeps last run/success/failure counts per job;
 *    `criticalJobHealth` classifies them, and `/api/internal/tick/status` exposes it.
 */
import { randomUUID } from "node:crypto";
import { repos } from "@/lib/controlplane/db";
import { withLease, LeaseUnavailableError } from "@/lib/controlplane/leases";
import type { Sql } from "@/lib/controlplane/types";
import type { JobSource, ScheduledJobRow } from "@/lib/controlplane/db/repos/scheduled-jobs";

export type { JobSource } from "@/lib/controlplane/db/repos/scheduled-jobs";

export const CRITICAL_JOBS = {
  billing: { cadenceMs: 60_000, leaseTtlMs: 120_000, kind: "billing" },
  housekeeping: { cadenceMs: 60_000, leaseTtlMs: 60_000, kind: "reaping" },
  "runner-reaper": { cadenceMs: 60_000, leaseTtlMs: 60_000, kind: "reaping" },
  runbooks: { cadenceMs: 60_000, leaseTtlMs: 120_000, kind: "runbooks" },
  reconcile: { cadenceMs: 60_000, leaseTtlMs: 90_000, kind: "observation" },
  engine: { cadenceMs: 60_000, leaseTtlMs: 60_000, kind: "observation" },
  alerts: { cadenceMs: 60_000, leaseTtlMs: 60_000, kind: "observation" },
  outbox: { cadenceMs: 60_000, leaseTtlMs: 60_000, kind: "observation" },
  // PROD-OPS-05 / PROD-OPS-06: key records and durable vault re-wrap; minimization of sealed results and uploads.
  // Durable-only: no cron fallback trigger exists for them (the operator CLIs run them under the same lease), so
  // a durable job that has never run (no Temporal scheduler installed) is not a health failure; one that ran and
  // went stale is.
  "key-rewrap": { cadenceMs: 60_000, leaseTtlMs: 120_000, kind: "custody", durableOnly: true },
  "data-minimize": { cadenceMs: 60_000, leaseTtlMs: 90_000, kind: "custody", durableOnly: true },
  // PROD-OPS-07: configurable retention. Archive-first and copy-only; deletion needs an approved policy plus ZENITH_RETENTION_APPLY=1.
  "data-retention": { cadenceMs: 60_000, leaseTtlMs: 120_000, kind: "custody", durableOnly: true },
  // PROD-MAN-03: custom-domain proof renewal and owed object-store key revocations. Durable-only like the custody jobs: no
  // cron fallback exists, so never having run (no Temporal scheduler installed) is not a health failure; going stale is.
  "managed-serving": { cadenceMs: 60_000, leaseTtlMs: 120_000, kind: "serving", durableOnly: true },
} as const;
export type CriticalJobName = keyof typeof CRITICAL_JOBS;
export const CRITICAL_JOB_NAMES = Object.keys(CRITICAL_JOBS) as CriticalJobName[];

/** A fallback trigger yields while the durable scheduler succeeded this recently (1.5 cadences). */
export const FALLBACK_DEFER_MS = 90_000;
/** A job is stale once it has not succeeded for this many cadences. */
export const STALE_AFTER_CADENCES = 5;
/** This many consecutive failed runs mark a job failing. */
export const FAILING_AFTER = 3;

export const jobLeaseScope = (job: CriticalJobName): string => `critical-job:${job}`;

/** What a job reports: its value, whether it did the work (false = its own inner lock was busy), and numeric counts for the health record. */
export interface JobOutcome<T> { value: T; performed?: boolean; counts?: Record<string, number> }
export type CriticalRunResult<T> =
  | { status: "ok"; value: T; missedTicks: number }
  | { status: "busy" }
  | { status: "skipped"; reason: "durable_current" | "inner_busy"; value?: T };

/** Numeric, bounded subset of a result suitable for the health record. */
export function countsOf(value: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  if (value && typeof value === "object") for (const [k, v] of Object.entries(value)) if (typeof v === "number" && Number.isSafeInteger(v)) out[k] = v;
  return out;
}

/**
 * Begin/finish the run record around `fn` under an already-held lease fence. Record-keeping never
 * turns finished work into a failure; a missing record shows up as a stale job, which is the honest
 * signal. A failed `fn` is recorded and rethrown.
 */
export async function recordLeasedRun<T>(db: Sql, job: CriticalJobName, source: JobSource, fenceToken: number, fn: () => Promise<JobOutcome<T>>): Promise<{ outcome: JobOutcome<T>; missedTicks: number }> {
  let missedTicks = 0;
  let recording = true;
  try { missedTicks = (await repos.scheduledJobs.beginRun(db, { job, source, cadenceMs: CRITICAL_JOBS[job].cadenceMs, fenceToken })).missedTicks; }
  catch { recording = false; }
  let outcome: JobOutcome<T>;
  try { outcome = await fn(); }
  catch (error) {
    if (recording) await repos.scheduledJobs.finishRun(db, { job, fenceToken, outcome: "failed", errorCode: "job_failed" }).catch(() => false);
    throw error;
  }
  if (recording) await repos.scheduledJobs.finishRun(db, { job, fenceToken, outcome: outcome.performed === false ? "skipped" : "ok", counts: outcome.counts ?? countsOf(outcome.value) }).catch(() => false);
  return { outcome, missedTicks };
}

/** Run one critical job exactly once from either trigger source. */
/** `force`: an operator's explicit run-now skips the deferral to a recent durable tick; the lease still applies, so it never runs concurrently. */
export async function runCriticalJob<T>(db: Sql, job: CriticalJobName, source: JobSource, fn: (signal: AbortSignal) => Promise<JobOutcome<T>>, options: { force?: boolean } = {}): Promise<CriticalRunResult<T>> {
  if (source === "fallback" && !options.force) {
    const row = await repos.scheduledJobs.getScheduledJob(db, job).catch(() => null);
    if (row && row.lastSuccessSource === "temporal" && row.lastSuccessAgeMs !== null && row.lastSuccessAgeMs < FALLBACK_DEFER_MS) {
      await repos.scheduledJobs.recordSkip(db, job).catch(() => undefined);
      return { status: "skipped", reason: "durable_current" };
    }
  }
  try {
    return await withLease<CriticalRunResult<T>>(db, { scope: jobLeaseScope(job), holder: `${source}:${job}:${randomUUID()}`, ttlMs: CRITICAL_JOBS[job].leaseTtlMs }, async (lease, signal) => {
      const { outcome, missedTicks } = await recordLeasedRun(db, job, source, lease.fenceToken, () => fn(signal));
      signal.throwIfAborted();
      return outcome.performed === false ? { status: "skipped", reason: "inner_busy", value: outcome.value } : { status: "ok", value: outcome.value, missedTicks };
    });
  } catch (error) {
    if (error instanceof LeaseUnavailableError) return { status: "busy" };
    throw error;
  }
}

/* ------------------------------ the shared jobs ----------------------------- */

/** The three jobs the durable maintenance schedule runs. Each is a thin call into the existing implementation. */
/**
 * Legacy-product passes (engine, alerts, outbox): same functions and same snapshot loader as the HTTP
 * route (ensureBoot + inCronScope primes the unfiltered snapshot and awaits the write-back). A boot
 * failure throws, so the run is recorded failed; nothing is skipped silently.
 */
async function productPass<T extends object>(run: (cron: typeof import("@/lib/server/cron")) => Promise<T>): Promise<JobOutcome<T>> {
  const { ensureBoot } = await import("@/lib/server/boot");
  await ensureBoot();
  const cron = await import("@/lib/server/cron");
  const value = await cron.inCronScope(() => run(cron));
  return { value, performed: true, counts: countsOf(value) };
}

export const MAINTENANCE_JOBS = {
  engine: () => productPass((c) => c.engineTickPass(15_000)),
  alerts: () => productPass((c) => c.alertTickPass()),
  outbox: () => productPass((c) => c.outboxTickPass()),
  async housekeeping(db: Sql): Promise<JobOutcome<import("./housekeeping").HousekeepingResult>> {
    const { housekeepingPass } = await import("./housekeeping");
    const r = await housekeepingPass(db);
    return { value: r, performed: r.ran, counts: countsOf(r) };
  },
  async "runner-reaper"(db: Sql): Promise<JobOutcome<{ ran: boolean; jobs: number } & Partial<import("@/lib/controlplane/outbox").RelayResult>>> {
    const { reapRunnerJobs } = await import("./app");
    const r = await reapRunnerJobs(db);
    // Durable intent relay (PROD-DUR-01): adopt abandoned start intents, derive approval wake-ups, deliver every due
    // intent under a fenced claim. Isolated from reaping: a Temporal outage is counted, never a reaper failure.
    const { runIntentRelay } = await import("@/lib/controlplane/outbox/temporal");
    const relay = await runIntentRelay({ sql: db, limit: 50 }).catch(() => null);
    return { value: { ...r, ...(relay ?? {}) }, performed: r.ran, counts: { jobs: r.jobs, ...(relay ?? { relayFailed: 1 }) } };
  },
  async "key-rewrap"(db: Sql): Promise<JobOutcome<import("@/lib/keycustody/rewrap-job").KeyRewrapResult>> {
    const { keyRewrapPass } = await import("@/lib/keycustody/rewrap-job");
    const r = await keyRewrapPass(db);
    return { value: r, performed: true, counts: countsOf(r) };
  },
  async "data-minimize"(db: Sql): Promise<JobOutcome<import("@/lib/sensitivedata/minimize").MinimizeResult>> {
    const { minimizePass } = await import("@/lib/sensitivedata/minimize");
    const r = await minimizePass(db);
    return { value: r, performed: true, counts: countsOf(r) };
  },
  async "data-retention"(db: Sql): Promise<JobOutcome<import("@/lib/retention/job").RetentionResult>> {
    const { retentionPass } = await import("@/lib/retention/job");
    const r = await retentionPass(db);
    return { value: r, performed: true, counts: countsOf(r) };
  },
  async "managed-serving"(db: Sql): Promise<JobOutcome<import("@/lib/managed-serving/job").ManagedServingResult>> {
    const { managedServingPass } = await import("@/lib/managed-serving/job");
    const r = await managedServingPass(db);
    return { value: r, performed: true, counts: countsOf(r) };
  },
  async runbooks(): Promise<JobOutcome<import("./runbooks").RunbookTickResult>> {
    const { runbookTickPass } = await import("./runbooks");
    const r = await runbookTickPass({ budgetMs: 15_000 });
    return { value: r, performed: r.ran, counts: countsOf(r) };
  },
  async billing(db: Sql): Promise<JobOutcome<import("@/lib/billing/service").BillingTickResult>> {
    const { runBillingTick } = await import("@/lib/billing/service");
    const r = await runBillingTick(db, { now: new Date() });
    return { value: r, performed: true, counts: countsOf(r) };
  },
};

export type MaintenanceOutcome = "ok" | "busy" | "skipped" | "failed";
export type MaintenanceResult = Record<keyof typeof MAINTENANCE_JOBS, MaintenanceOutcome>;

/** One durable maintenance pass: every job in isolation, so one failure never starves the others. */
export async function runCriticalMaintenance(db: Sql, source: JobSource = "temporal", signal?: AbortSignal): Promise<MaintenanceResult> {
  const out = {} as MaintenanceResult;
  for (const name of Object.keys(MAINTENANCE_JOBS) as (keyof typeof MAINTENANCE_JOBS)[]) {
    signal?.throwIfAborted();
    const job: (db: Sql) => Promise<JobOutcome<unknown>> = MAINTENANCE_JOBS[name];
    try { out[name] = (await runCriticalJob(db, name, source, () => job(db))).status; }
    catch { signal?.throwIfAborted(); out[name] = "failed"; }
  }
  return out;
}

/* --------------------------------- health ---------------------------------- */

export type JobHealthState = "healthy" | "stale" | "failing" | "never_run";
export interface CriticalJobHealth {
  job: CriticalJobName;
  kind: (typeof CRITICAL_JOBS)[CriticalJobName]["kind"];
  state: JobHealthState;
  cadenceMs: number;
  lastStatus: ScheduledJobRow["lastStatus"] | null;
  lastSource: JobSource | null;
  lastSuccessSource: JobSource | null;
  lastSuccessAt: string | null;
  lastSuccessAgeMs: number | null;
  lastErrorCode: string | null;
  consecutiveFailures: number;
  missedTicksTotal: number;
  skippedTotal: number;
  /** true when the last success came from the durable scheduler (not only the fallback) */
  durable: boolean;
  counts: Record<string, number>;
}

export function classifyJob(job: CriticalJobName, row: ScheduledJobRow | null): CriticalJobHealth {
  const spec = CRITICAL_JOBS[job];
  const base = { job, kind: spec.kind, cadenceMs: spec.cadenceMs };
  if (!row) return { ...base, state: "never_run", lastStatus: null, lastSource: null, lastSuccessSource: null, lastSuccessAt: null, lastSuccessAgeMs: null, lastErrorCode: null, consecutiveFailures: 0, missedTicksTotal: 0, skippedTotal: 0, durable: false, counts: {} };
  const stale = row.lastSuccessAgeMs === null || row.lastSuccessAgeMs > spec.cadenceMs * STALE_AFTER_CADENCES;
  const state: JobHealthState = row.consecutiveFailures >= FAILING_AFTER ? "failing" : stale ? "stale" : "healthy";
  return { ...base, state, lastStatus: row.lastStatus, lastSource: row.lastSource, lastSuccessSource: row.lastSuccessSource, lastSuccessAt: row.lastSuccessAt, lastSuccessAgeMs: row.lastSuccessAgeMs, lastErrorCode: row.lastErrorCode, consecutiveFailures: row.consecutiveFailures, missedTicksTotal: row.missedTicksTotal, skippedTotal: row.skippedTotal, durable: row.lastSuccessSource === "temporal", counts: row.lastCounts };
}

export async function criticalJobHealth(db: Sql): Promise<{ healthy: boolean; jobs: CriticalJobHealth[] }> {
  const rows = new Map((await repos.scheduledJobs.listScheduledJobs(db)).map((row) => [row.job, row]));
  const jobs = CRITICAL_JOB_NAMES.map((job) => classifyJob(job, rows.get(job) ?? null));
  // A durable-only job that has never run means no durable scheduler is installed; it does not fail the overall view.
  return { healthy: jobs.every((j) => j.state === "healthy" || ("durableOnly" in CRITICAL_JOBS[j.job] && j.state === "never_run")), jobs };
}

/* ------------------------------ fallback trigger ---------------------------- */

export type Deferred = "durable_current" | "busy" | "inner_busy";

/**
 * The GitHub cron / in-process scheduler entry. It runs the same job under the same lease and
 * record as the durable scheduler, and reports `deferred` instead of running when the durable
 * scheduler is current or another run holds the job. `idle` is the job's own "did nothing" shape.
 */
export async function runFallbackJob<T extends object>(job: CriticalJobName, fn: (db: Sql, signal: AbortSignal) => Promise<JobOutcome<T>>, idle: T): Promise<T & { deferred?: Deferred }> {
  const { platformDb } = await import("@/lib/controlplane/db");
  const db = await platformDb();
  const r = await runCriticalJob(db, job, "fallback", (signal) => fn(db, signal));
  if (r.status === "ok") return r.value;
  if (r.status === "busy") return { ...idle, deferred: "busy" };
  return { ...(r.value ?? idle), deferred: r.reason };
}
