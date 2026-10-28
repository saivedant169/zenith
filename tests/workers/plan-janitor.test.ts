/** Real filesystem/PGlite, synthetic plans, injected retention clock. No tofu or cloud I/O. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { lstat, mkdir, mkdtemp, readFile, rm, symlink, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { openPlatformDb, repos } from "@/lib/controlplane/db";
import { sha256Hex } from "@/lib/controlplane/digest";
import { TERMINAL_OPERATION_STATUSES, type Sql } from "@/lib/controlplane/types";
import { PLAN_JANITOR_INTERVAL_MS, planJanitorPass, planMaxAgeFromEnv, startPlanJanitor } from "@/lib/execution/plan-janitor";
import { planArtifactRetentionPreviewFromEnv, startPlanArtifactJanitor } from "@/lib/execution/plan-janitor";
import { proposalFor, user } from "../controlplane/_support/harness";

let db: Awaited<ReturnType<typeof openPlatformDb>>;
let temp: string, planDir: string;
const NOW = Date.parse("2026-10-01T12:00:00Z");
const options = () => ({ planDir, maxAgeMs: 3600_000, clock: () => NOW });
beforeEach(async () => { db = await openPlatformDb({ kind: "pglite" }); temp = await mkdtemp(path.join(os.tmpdir(), "zenith-janitor-")); planDir = path.join(temp, "plans"); await mkdir(planDir); });
afterEach(async () => { vi.useRealTimers(); await db.close(); await rm(temp, { recursive: true, force: true }); });
async function file(digest: string, ageHours = 2) {
  const name = path.join(planDir, `${digest}.tfplan`);
  await writeFile(name, "synthetic private plan");
  await utimes(name, new Date(NOW - ageHours * 3600_000), new Date(NOW - ageHours * 3600_000));
  return name;
}
async function owner(digest: string, status: string, workspaceId = "ws-a", evidenceOnly = false) {
  const { operation } = await repos.operations.create(db, { workspaceId, principal: user(), proposal: proposalFor(workspaceId, evidenceOnly ? {} : { planDigest: digest }) });
  await db.query("update platform.operations set status=$3 where workspace_id=$1 and id=$2", [workspaceId, operation.id, status]);
  if (evidenceOnly) await repos.evidence.insert(db, { workspaceId, operationId: operation.id, kind: "tofu_plan", digest, summary: { planDigest: digest }, simulated: true });
  return operation;
}

describe("plan janitor", () => {
  it("retains legacy bytes for every terminal outcome without changing rows or applying a pruning policy", async () => {
    for (const [i, status] of TERMINAL_OPERATION_STATUSES.entries()) { const digest = sha256Hex(String(i)); await file(digest, 1); await owner(digest, status); }
    const before = await db.query("select * from platform.operations order by seq");
    expect(await planJanitorPass(db, options())).toMatchObject({ removed: 0, retained: 7, errors: 0 });
    expect(await db.query("select * from platform.operations order by seq")).toEqual(before);
    expect(await planJanitorPass(db, options())).toMatchObject({ removed: 0 });
  });

  it("never deletes a plan belonging to any non-terminal status", async () => {
    for (const [i, status] of ["proposed", "awaiting_approval", "approved", "queued", "running"].entries()) { const digest = sha256Hex(String(i)); await file(digest); await owner(digest, status); }
    expect(await planJanitorPass(db, options())).toMatchObject({ scanned: 5, removed: 0, retained: 5 });
  });

  it("keeps recent/unowned plans, unknown names, directories and outside files", async () => {
    const digest = "a".repeat(64); const recent = await file(digest, 0.99); await owner(digest, "succeeded");
    const unowned = await file("b".repeat(64));
    await writeFile(path.join(planDir, "unrecognized.tfplan"), "keep"); await mkdir(path.join(planDir, `${"c".repeat(64)}.tfplan`));
    const outside = path.join(temp, `${digest}.tfplan`); await writeFile(outside, "outside");
    expect(await planJanitorPass(db, options())).toMatchObject({ removed: 0, retained: 4 });
    expect(await readFile(recent, "utf8")).toBe("synthetic private plan"); expect(await lstat(unowned)).toBeDefined(); expect(await readFile(outside, "utf8")).toBe("outside");
  });

  it("protects shared digests across workspaces and owners found only through re-plan evidence", async () => {
    const shared = "a".repeat(64); await file(shared); await owner(shared, "succeeded"); const active = await owner(shared, "awaiting_approval", "ws-b", true);
    expect(await planJanitorPass(db, options())).toMatchObject({ removed: 0, retained: 1 });
    await db.query("update platform.operations set status='cancelled' where workspace_id=$1 and id=$2", [active.workspaceId, active.id]);
    expect(await planJanitorPass(db, options())).toMatchObject({ removed: 0, retained: 1 });
  });

  it("retains a digest with evidence that cannot be bound to an operation", async () => {
    const digest = "a".repeat(64); await file(digest); await owner(digest, "succeeded");
    await repos.evidence.insert(db, { workspaceId: "ws-other", kind: "tofu_plan", digest, summary: {}, simulated: true });
    expect(await planJanitorPass(db, options())).toMatchObject({ removed: 0, retained: 1 });
  });

  it("refuses a symlink root and never follows nested directory links", async () => {
    const outside = path.join(temp, "outside"); await mkdir(outside);
    const link = path.join(planDir, "nested"); await symlink(outside, link, "junction");
    const digest = "a".repeat(64); const protectedFile = path.join(outside, `${digest}.tfplan`); await writeFile(protectedFile, "outside"); await owner(digest, "succeeded");
    expect(await planJanitorPass(db, options())).toMatchObject({ removed: 0, retained: 1 });
    expect(await readFile(protectedFile, "utf8")).toBe("outside");
    await expect(planJanitorPass(db, { ...options(), planDir: link })).rejects.toThrow("unsafe");
  });

  it("bounds non-deleting scans and reports a missing directory without creating it", async () => {
    for (let i = 0; i < 3; i++) { const digest = sha256Hex(String(i)); await file(digest); await owner(digest, "expired"); }
    expect(await planJanitorPass(db, { ...options(), limit: 2 })).toMatchObject({ scanned: 2, removed: 0, retained: 2 });
    expect(await planJanitorPass(db, options())).toMatchObject({ removed: 0, retained: 3 });
    expect(await planJanitorPass(db, { ...options(), planDir: path.join(temp, "missing") })).toMatchObject({ status: "missing" });
  });

  it("skips overlapping cleanup under its directory lease", async () => {
    const root = await import("node:fs/promises").then((fs) => fs.realpath(planDir));
    const lease = await repos.leases.acquire(db, { scope: `system:plan-janitor:${sha256Hex(root)}`, holder: "other", ttlMs: 60_000 });
    expect(lease).not.toBeNull();
    expect(await planJanitorPass(db, options())).toMatchObject({ status: "busy", scanned: 0 });
  });

  it("does not delete on a failed ownership read, and reports no raw errors or names", async () => {
    const digest = "a".repeat(64); const retained = await file(digest); await owner(digest, "failed");
    const failing: Sql = { tx: db.tx.bind(db), query: async (sql, params) => { if (sql.includes("with owners")) throw new Error("synthetic-secret-canary"); return db.query(sql, params); } };
    const result = await planJanitorPass(failing, options());
    expect(result).toMatchObject({ removed: 0, errors: 1 }); expect(JSON.stringify(result)).not.toContain("synthetic-secret-canary"); expect(JSON.stringify(result)).not.toContain(digest);
    expect(await lstat(retained)).toBeDefined();
  });

  it("rechecks a file refreshed while its ownership is being read", async () => {
    const digest = "a".repeat(64); const refreshed = await file(digest); await owner(digest, "failed");
    let refreshedOnce = false;
    const changing: Sql = { tx: db.tx.bind(db), query: async <T>(sql: string, params?: readonly unknown[]) => { const rows = await db.query<T>(sql, params); if (sql.includes("with owners") && !refreshedOnce) { refreshedOnce = true; await utimes(refreshed, new Date(NOW), new Date(NOW)); } return rows; } };
    expect(await planJanitorPass(changing, options())).toMatchObject({ removed: 0, retained: 1 });
    expect(await lstat(refreshed)).toBeDefined();
  });

  it("retains a plan if a new active owner appears between ownership checks", async () => {
    const digest = "a".repeat(64); const retained = await file(digest); await owner(digest, "succeeded");
    let added = false;
    const changing: Sql = { tx: db.tx.bind(db), query: async <T>(sql: string, params?: readonly unknown[]) => { const rows = await db.query<T>(sql, params); if (sql.includes("with owners") && !added) { added = true; await owner(digest, "running", "ws-new", true); } return rows; } };
    expect(await planJanitorPass(changing, options())).toMatchObject({ removed: 0, retained: 1 });
    expect(await lstat(retained)).toBeDefined();
  });

  it("runs periodically, stays single-flight and awaits the active pass on stop", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const entered = Promise.withResolvers<void>(); const resume = Promise.withResolvers<void>();
    let acquisitions = 0;
    const paused: Sql = { tx: db.tx.bind(db), query: async (sql, params) => { if (sql.includes("insert into platform.leases")) { acquisitions++; entered.resolve(); await resume.promise; } return db.query(sql, params); } };
    const report = vi.fn(); const janitor = startPlanJanitor(paused, options(), report);
    await entered.promise; await vi.advanceTimersByTimeAsync(PLAN_JANITOR_INTERVAL_MS * 2);
    expect(acquisitions).toBe(1);
    let stopped = false; const stopping = janitor.stop().then(() => { stopped = true; });
    await Promise.resolve(); expect(stopped).toBe(false); resume.resolve(); await stopping;
    expect(report).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(PLAN_JANITOR_INTERVAL_MS); expect(acquisitions).toBe(1);
  });

  it("continues bounded scans beyond retained entries without deleting terminal plans", async () => {
    for (let i = 0; i < 5; i++) { const digest = sha256Hex(String(i)); await file(digest); await owner(digest, i === 4 ? "cancelled" : "running"); }
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const report = vi.fn(); const janitor = startPlanJanitor(db, { ...options(), limit: 2 }, report);
    try {
      await vi.waitFor(() => expect(report).toHaveBeenCalledTimes(1));
      for (let i = 2; i <= 4; i++) { await vi.advanceTimersByTimeAsync(PLAN_JANITOR_INTERVAL_MS); await vi.waitFor(() => expect(report).toHaveBeenCalledTimes(i)); }
      const results = report.mock.calls.map(([result]) => result);
      expect(results.reduce((count, result) => count + result.removed, 0)).toBe(0);
      expect(results.reduce((count,result)=>count+result.scanned,0)).toBeGreaterThanOrEqual(5);
      expect(results.every((result) => result.scanned <= 2)).toBe(true);
      for (let i = 0; i < 5; i++) expect(await lstat(path.join(planDir, `${sha256Hex(String(i))}.tfplan`))).toBeDefined();
    } finally { await janitor.stop(); }
  });

  it("validates retention and batch settings", async () => {
    expect(planMaxAgeFromEnv({})).toBe(24 * 3600_000); expect(planMaxAgeFromEnv({ ZENITH_WORKER_PLAN_MAX_AGE_HOURS: "48" })).toBe(48 * 3600_000);
    for (const hours of ["0", "-1", "no", "Infinity", "8761"]) expect(() => planMaxAgeFromEnv({ ZENITH_WORKER_PLAN_MAX_AGE_HOURS: hours })).toThrow("MAX_AGE_HOURS");
    await expect(planJanitorPass(db, { ...options(), limit: 0 })).rejects.toThrow("limit");
    await expect(planJanitorPass(db, { ...options(), clock: () => NaN })).rejects.toThrow("clock");
  });
});

describe("plan retention explicit configuration and timer [models]", () => {
  const configured = () => ({ workspaceId: "ws_preview", createdBefore: "2021-01-01T00:00:00.000Z", limit: 2, holdOperationIds: ["op_held"] });
  const env = (value: unknown) => ({ ZENITH_WORKER_PLAN_RETENTION_PREVIEW: JSON.stringify(value) });
  it("leaves preview disabled without selecting a default retention duration", () => {
    expect(planArtifactRetentionPreviewFromEnv({})).toBeUndefined();
  });
  it("captures only explicit immutable workspace cutoff batch and preview holds", () => {
    const input = configured(), policy = planArtifactRetentionPreviewFromEnv(env(input));
    expect(policy).toEqual(input); expect(Object.isFrozen(policy)).toBe(true); expect(Object.isFrozen(policy?.holdOperationIds)).toBe(true);
    input.holdOperationIds[0] = "op_changed"; expect(policy?.holdOperationIds).toEqual(["op_held"]);
  });
  it.each(["empty", "malformed", "null", "array", "missing cutoff", "invalid date", "noncanonical time", "zero year", "missing holds", "duplicate holds", "oversized holds", "foreign hold type", "unsafe identifier", "zero batch", "oversized batch", "fractional batch", "extra execute", "extra storage key", "oversized input"])("refuses %s configuration without exposing values", fault => {
    const raw = configured(), faults: Record<string, unknown> = {
      null: null, array: [], "missing cutoff": { workspaceId: raw.workspaceId, limit: raw.limit, holdOperationIds: [] },
      "invalid date": { ...raw, createdBefore: "2021-02-30T00:00:00.000Z" }, "noncanonical time": { ...raw, createdBefore: "2021-01-01" },
      "zero year": { ...raw, createdBefore: "0000-01-01T00:00:00.000Z" },
      "missing holds": { workspaceId: raw.workspaceId, createdBefore: raw.createdBefore, limit: raw.limit },
      "duplicate holds": { ...raw, holdOperationIds: ["op_held", "op_held"] }, "oversized holds": { ...raw, holdOperationIds: Array.from({ length: 1001 }, (_, i) => `op_${i}`) },
      "foreign hold type": { ...raw, holdOperationIds: [null] }, "unsafe identifier": { ...raw, workspaceId: "ws';synthetic-private-canary" },
      "zero batch": { ...raw, limit: 0 }, "oversized batch": { ...raw, limit: 1001 }, "fractional batch": { ...raw, limit: 1.5 },
      "extra execute": { ...raw, execute: true }, "extra storage key": { ...raw, storageKey: "synthetic-private-canary" },
    };
    const value = fault === "empty" ? "" : fault === "malformed" ? "{synthetic-private-canary"
      : fault === "oversized input" ? "synthetic-private-canary".repeat(10_000) : JSON.stringify(faults[fault]);
    try { planArtifactRetentionPreviewFromEnv({ ZENITH_WORKER_PLAN_RETENTION_PREVIEW: value }); throw new Error("Expected refusal"); }
    catch (error) { expect(error).toBeInstanceOf(Error); expect((error as Error).message).toBe("ZENITH_WORKER_PLAN_RETENTION_PREVIEW requires explicit bounded dry-run configuration."); }
  });
  it("runs existing logical expiry without querying preview when configuration is absent", async () => {
    const expire = vi.spyOn(repos.planArtifacts, "expire").mockResolvedValue(3), preview = vi.spyOn(repos.planArtifacts, "previewRetention");
    const report = vi.fn(), janitor = startPlanArtifactJanitor(db, report);
    try { await janitor.stop(); expect(expire).toHaveBeenCalledOnce(); expect(preview).not.toHaveBeenCalled(); expect(report).toHaveBeenCalledExactlyOnceWith({ expired: 3, settled: expect.objectContaining({ written: 0 }) }); }
    finally { expire.mockRestore(); preview.mockRestore(); }
  });
  it("integrates read-only counts after unchanged logical expiry and keeps timer single-flight with awaited shutdown", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const entered = Promise.withResolvers<void>(), resume = Promise.withResolvers<void>(), order: string[] = [];
    const expire = vi.spyOn(repos.planArtifacts, "expire").mockImplementation(async () => { order.push("expiry"); return 2; });
    const result = { mode: "dry-run" as const, scanned: 2, hasMore: true, held: 1, active: 1, unresolved: 0, unavailable: 0, withinRetention: 0, archiveReview: 0 };
    const preview = vi.spyOn(repos.planArtifacts, "previewRetention").mockImplementation(async () => { order.push("preview"); entered.resolve(); await resume.promise; return result; });
    const policy = planArtifactRetentionPreviewFromEnv(env(configured())), report = vi.fn(), janitor = startPlanArtifactJanitor(db, report, { retentionPreview: policy });
    try {
      await entered.promise; await vi.advanceTimersByTimeAsync(PLAN_JANITOR_INTERVAL_MS * 2); expect(preview).toHaveBeenCalledOnce();
      let stopped = false; const stopping = janitor.stop().then(() => { stopped = true; }); await Promise.resolve(); expect(stopped).toBe(false);
      resume.resolve(); await stopping; expect(stopped).toBe(true); expect(order).toEqual(["expiry", "preview"]);
      expect(preview).toHaveBeenCalledExactlyOnceWith(db, policy); expect(report).toHaveBeenCalledExactlyOnceWith({ expired: 2, settled: expect.objectContaining({ written: 0 }), retention: result });
      await vi.advanceTimersByTimeAsync(PLAN_JANITOR_INTERVAL_MS); expect(preview).toHaveBeenCalledOnce();
    } finally { resume.resolve(); await janitor.stop(); expire.mockRestore(); preview.mockRestore(); }
  });
  it("reports only unavailability when a preview read fails and never logs the private exception", async () => {
    const expire = vi.spyOn(repos.planArtifacts, "expire").mockResolvedValue(0), preview = vi.spyOn(repos.planArtifacts, "previewRetention").mockRejectedValue(new Error("synthetic-private-canary"));
    const report = vi.fn(), janitor = startPlanArtifactJanitor(db, report, { retentionPreview: configured() });
    try { await janitor.stop(); expect(report).toHaveBeenCalledExactlyOnceWith(); expect(JSON.stringify(report.mock.calls)).not.toContain("synthetic-private-canary"); }
    finally { expire.mockRestore(); preview.mockRestore(); }
  });
  it("refuses getter-backed repository configuration before IO without invoking its accessor", async () => {
    let called = 0, queried = 0; const config = Object.defineProperty(configured(), "workspaceId", { get() { called++; throw new Error("synthetic-private-canary"); } });
    const sql: Sql = { tx: async fn => fn(sql), query: async () => { queried++; return []; } };
    await expect(repos.planArtifacts.previewRetention(sql, config)).rejects.toThrow("explicit bounded configuration"); expect(called).toBe(0); expect(queried).toBe(0);
  });
  it("refuses an added execution field or getter-backed hold before repository IO", async () => {
    let queried = 0, called = 0; const sql: Sql = { tx: async fn => fn(sql), query: async () => { queried++; return []; } };
    const withExecution = { ...configured(), execute: true };
    await expect(repos.planArtifacts.previewRetention(sql, withExecution)).rejects.toThrow("explicit bounded configuration");
    const input = configured(); Object.defineProperty(input.holdOperationIds, "0", { get() { called++; throw new Error("synthetic-private-canary"); } });
    await expect(repos.planArtifacts.previewRetention(sql, input)).rejects.toThrow("explicit bounded configuration");
    expect(called).toBe(0); expect(queried).toBe(0);
  });
  it("parses opt-in worker configuration before codec health store or polling effects using the existing guarded store", async () => {
    const worker = await import("node:fs/promises").then(fs => fs.readFile(path.resolve("workers/execution/worker.ts"), "utf8"));
    const parse = worker.indexOf("? undefined : planArtifactRetentionPreviewFromEnv()");
    expect(parse).toBeGreaterThan(0); for (const effect of ["const dataConverter = temporalDataConverterFromEnv()", "await startHealthServer(", "await openExecutionStore(", "await Worker.create("])
      expect(parse).toBeLessThan(worker.indexOf(effect));
    expect(worker).toContain("}, { retentionPreview, settlement: { startClosure: "); expect(worker).toContain("startPlanArtifactJanitor(db");
  });
});
