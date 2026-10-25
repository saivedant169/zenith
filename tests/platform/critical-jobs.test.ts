/** PROD-OBS-04: durable critical job execution, overlap, fencing, catch-up, fallback idempotency and health (real PGlite dialect). */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { openPlatformDb, repos } from "@/lib/controlplane/db";
import {
  CRITICAL_JOBS, FALLBACK_DEFER_MS, MAINTENANCE_JOBS, criticalJobHealth, jobLeaseScope, runCriticalJob, type JobOutcome,
} from "@/lib/platform/critical-jobs";

let db: Awaited<ReturnType<typeof openPlatformDb>>;
// Compile the real reaper and relay as setup, rather than charging a cold
// Temporal/native module graph to this SQL wrapper case's execution timeout.
beforeAll(async () => {
  await Promise.all([import("@/lib/platform/app"), import("@/lib/controlplane/outbox/temporal")]);
});
beforeEach(async () => { db = await openPlatformDb({ kind: "pglite" }); });
afterEach(async () => { await db.close(); });

const ok = async (): Promise<JobOutcome<{ n: number }>> => ({ value: { n: 1 }, counts: { n: 1 } });
const age = (job: string, column: "last_success_at" | "last_finished_at" | "last_started_at", ms: number) =>
  db.query(`update platform.scheduled_job_runs set ${column} = clock_timestamp() - ($2::bigint * interval '1 millisecond') where job = $1`, [job, ms]);

describe("critical job runs", () => {
  it("records a durable run, releases its lease and reports healthy", async () => {
    const result = await runCriticalJob(db, "housekeeping", "temporal", () => MAINTENANCE_JOBS.housekeeping(db));
    expect(result.status).toBe("ok");
    const row = await repos.scheduledJobs.getScheduledJob(db, "housekeeping");
    expect(row).toMatchObject({ lastStatus: "ok", lastSource: "temporal", lastSuccessSource: "temporal", consecutiveFailures: 0, runsTotal: 1 });
    expect(await repos.leases.current(db, jobLeaseScope("housekeeping"))).toBeNull();
    const health = await criticalJobHealth(db);
    expect(health.jobs.find((j) => j.job === "housekeeping")).toMatchObject({ state: "healthy", durable: true });
    // jobs that never ran are reported, not hidden
    expect(health.jobs.find((j) => j.job === "runbooks")?.state).toBe("never_run");
    expect(health.healthy).toBe(false);
  });

  it("records billing durably and defers its fallback after a successful durable tick", async () => {
    vi.stubEnv("ZENITH_BILLING", "disabled");
    try {
      const result = await runCriticalJob(db, "billing", "temporal", () => MAINTENANCE_JOBS.billing(db));
      expect(result).toMatchObject({ status: "ok", value: { enabled: false } });
      expect(await repos.scheduledJobs.getScheduledJob(db, "billing")).toMatchObject({ lastStatus: "ok", lastSuccessSource: "temporal", runsTotal: 1 });
      let dispatched = false;
      expect(await runCriticalJob(db, "billing", "fallback", async () => { dispatched = true; return ok(); })).toEqual({ status: "skipped", reason: "durable_current" });
      expect(dispatched).toBe(false);
      expect((await criticalJobHealth(db)).jobs.find(j => j.job === "billing")).toMatchObject({ state: "healthy", durable: true });
      expect(await repos.leases.current(db, jobLeaseScope("billing"))).toBeNull();
    } finally { vi.unstubAllEnvs(); }
  });

  it("lets an operator's explicit run-now (force) skip the deferral, still under the lease", async () => {
    vi.stubEnv("ZENITH_BILLING", "disabled");
    try {
      await runCriticalJob(db, "billing", "temporal", () => MAINTENANCE_JOBS.billing(db));
      let dispatched = false;
      const forced = await runCriticalJob(db, "billing", "fallback", async () => { dispatched = true; return ok(); }, { force: true });
      expect(forced.status).toBe("ok");
      expect(dispatched).toBe(true);
      expect(await repos.leases.current(db, jobLeaseScope("billing"))).toBeNull();
    } finally { vi.unstubAllEnvs(); }
  });

  it("runs the runner reaper through the same wrapper", async () => {
    const result = await runCriticalJob(db, "runner-reaper", "temporal", () => MAINTENANCE_JOBS["runner-reaper"](db));
    expect(result).toMatchObject({ status: "ok", value: { ran: true, jobs: 0 } });
  });

  it("prevents overlap across sources: a second trigger while one holds the lease does nothing", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let started!: () => void;
    const running = new Promise<void>((resolve) => { started = resolve; });
    const first = runCriticalJob(db, "reconcile", "temporal", async () => { started(); await gate; return ok(); });
    await running;
    let ran = false;
    const second = await runCriticalJob(db, "reconcile", "fallback", async () => { ran = true; return ok(); });
    expect(second.status).toBe("busy");
    expect(ran).toBe(false);
    release();
    expect((await first).status).toBe("ok");
  });

  it("defers the fallback while the durable scheduler is current and resumes when it is stale", async () => {
    await runCriticalJob(db, "reconcile", "temporal", ok);
    let fallbackRuns = 0;
    const fallback = () => runCriticalJob(db, "reconcile", "fallback", async () => { fallbackRuns++; return ok(); });
    expect(await fallback()).toEqual({ status: "skipped", reason: "durable_current" });
    expect(fallbackRuns).toBe(0);
    expect((await repos.scheduledJobs.getScheduledJob(db, "reconcile"))?.skippedTotal).toBe(1);
    // the durable scheduler stops: after the deferral window the fallback runs and is recorded as the last success
    await age("reconcile", "last_success_at", FALLBACK_DEFER_MS + 5_000);
    expect((await fallback()).status).toBe("ok");
    expect(fallbackRuns).toBe(1);
    expect(await repos.scheduledJobs.getScheduledJob(db, "reconcile")).toMatchObject({ lastSuccessSource: "fallback", lastSource: "fallback" });
    expect((await criticalJobHealth(db)).jobs.find((j) => j.job === "reconcile")?.durable).toBe(false);
  });

  it("a fallback-only history never defers (cron keeps the platform alive without Temporal)", async () => {
    await runCriticalJob(db, "housekeeping", "fallback", ok);
    expect((await runCriticalJob(db, "housekeeping", "fallback", ok)).status).toBe("ok");
  });

  it("records failures with a fixed code, rethrows, marks failing after three and recovers on success", async () => {
    for (let i = 0; i < 3; i++) await expect(runCriticalJob(db, "runbooks", "temporal", async () => { throw new Error("secret detail must not be stored"); })).rejects.toThrow();
    const row = await repos.scheduledJobs.getScheduledJob(db, "runbooks");
    expect(row).toMatchObject({ lastStatus: "failed", consecutiveFailures: 3, lastErrorCode: "job_failed" });
    expect(JSON.stringify(row)).not.toContain("secret detail");
    expect((await criticalJobHealth(db)).jobs.find((j) => j.job === "runbooks")?.state).toBe("failing");
    expect(await repos.leases.current(db, jobLeaseScope("runbooks"))).toBeNull();
    await runCriticalJob(db, "runbooks", "temporal", ok);
    expect(await repos.scheduledJobs.getScheduledJob(db, "runbooks")).toMatchObject({ lastStatus: "ok", consecutiveFailures: 0, lastErrorCode: null });
  });

  it("marks a job stale after five missed cadences", async () => {
    await runCriticalJob(db, "housekeeping", "temporal", ok);
    await age("housekeeping", "last_success_at", CRITICAL_JOBS.housekeeping.cadenceMs * 5 + 1_000);
    expect((await criticalJobHealth(db)).jobs.find((j) => j.job === "housekeeping")?.state).toBe("stale");
  });

  it("closes an outage with one catch-up pass and records the missed ticks", async () => {
    await runCriticalJob(db, "housekeeping", "temporal", ok);
    await age("housekeeping", "last_finished_at", 10 * 60_000 + 500);
    let runs = 0;
    const result = await runCriticalJob(db, "housekeeping", "temporal", async () => { runs++; return ok(); });
    expect(runs).toBe(1);
    expect(result.status === "ok" && result.missedTicks).toBe(9);
    expect((await repos.scheduledJobs.getScheduledJob(db, "housekeeping"))?.missedTicksTotal).toBe(9);
  });

  it("a job whose own inner lock was busy is recorded as skipped, not as a success", async () => {
    const result = await runCriticalJob(db, "housekeeping", "temporal", async () => ({ value: { ran: false }, performed: false }));
    expect(result.status).toBe("skipped");
    const row = await repos.scheduledJobs.getScheduledJob(db, "housekeeping");
    expect(row).toMatchObject({ lastStatus: "skipped", lastSuccessAt: null, consecutiveFailures: 0 });
  });
});

describe("run record fencing", () => {
  it("only the holder that began a run may finish it", async () => {
    await repos.scheduledJobs.beginRun(db, { job: "runbooks", source: "temporal", cadenceMs: 60_000, fenceToken: 5 });
    expect(await repos.scheduledJobs.finishRun(db, { job: "runbooks", fenceToken: 4, outcome: "ok" })).toBe(false);
    expect((await repos.scheduledJobs.getScheduledJob(db, "runbooks"))?.lastStatus).toBe("running");
    // a takeover begins a new run under a later fence; the old holder's late finish changes nothing
    await repos.scheduledJobs.beginRun(db, { job: "runbooks", source: "fallback", cadenceMs: 60_000, fenceToken: 6 });
    expect(await repos.scheduledJobs.finishRun(db, { job: "runbooks", fenceToken: 5, outcome: "failed" })).toBe(false);
    expect(await repos.scheduledJobs.finishRun(db, { job: "runbooks", fenceToken: 6, outcome: "ok", counts: { executed: 2 } })).toBe(true);
    expect(await repos.scheduledJobs.getScheduledJob(db, "runbooks")).toMatchObject({ lastStatus: "ok", lastSource: "fallback", lastCounts: { executed: 2 } });
    // a finished run cannot be finished twice
    expect(await repos.scheduledJobs.finishRun(db, { job: "runbooks", fenceToken: 6, outcome: "failed" })).toBe(false);
  });

  it("refuses malformed job names and fence tokens", async () => {
    await expect(repos.scheduledJobs.getScheduledJob(db, "Bad Job")).rejects.toThrow();
    await expect(repos.scheduledJobs.beginRun(db, { job: "runbooks", source: "temporal", cadenceMs: 60_000, fenceToken: 0 })).rejects.toThrow();
  });
});
