/** Local HTTP and PGlite are real; Temporal and other dependency checks are synthetic. */
import { afterEach, describe, expect, it, vi } from "vitest";
import { openPlatformDb } from "@/lib/controlplane/db";
import { healthPortFromEnv, readinessProbe, startHealthServer, type ReadinessChecks } from "../../workers/execution/health";

const healthy = (): ReadinessChecks => ({ temporal: () => true, store: () => true, policy: () => true, drivers: () => true });
let endpoint: Awaited<ReturnType<typeof startHealthServer>> | undefined;
afterEach(async () => { vi.useRealTimers(); await endpoint?.close(); endpoint = undefined; });
async function get(path = "/readyz", method = "GET") { return fetch(`http://127.0.0.1:${endpoint!.port}${path}`, { method }); }

describe("worker health", () => {
  it("serves liveness independently of readiness and binds only to loopback", async () => {
    const failed = vi.fn(() => { throw new Error("synthetic-secret-canary"); });
    endpoint = await startHealthServer({ port: 0, checks: { temporal: failed, store: failed, policy: failed, drivers: failed } });
    const live = await get("/healthz"); expect(live.status).toBe(200); expect(await live.json()).toEqual({ alive: true }); expect(failed).not.toHaveBeenCalled();
    expect(endpoint.server.address()).toMatchObject({ address: "127.0.0.1" });
    const ready = await get(); expect(ready.status).toBe(503); expect(await ready.text()).not.toContain("synthetic-secret-canary");
    expect(ready.headers.get("cache-control")).toBe("no-store");
  });

  it("returns ready only when all four dependencies are available", async () => {
    endpoint = await startHealthServer({ port: 0, checks: healthy() });
    const response = await get("/readyz?ignored=synthetic-input");
    expect(response.status).toBe(200); expect(await response.json()).toEqual({ ready: true, checks: { temporal: "ok", store: "ok", policy: "ok", drivers: "ok" } });
  });

  it.each(["temporal", "store", "policy", "drivers"] as const)("fails readiness when %s is unavailable", async (key) => {
    endpoint = await startHealthServer({ port: 0, checks: { ...healthy(), [key]: () => false } });
    const response = await get(); expect(response.status).toBe(503); expect(await response.json()).toMatchObject({ ready: false, checks: { [key]: "unavailable" } });
  });

  it("reports unknown during startup and recovers after dependency recovery", async () => {
    let available: boolean | undefined;
    endpoint = await startHealthServer({ port: 0, checks: { ...healthy(), temporal: () => available } });
    const before = await get(); expect(before.status).toBe(503); expect(await before.json()).toMatchObject({ checks: { temporal: "unknown" } });
    available = true; expect((await get()).status).toBe(200);
    available = false; expect((await get()).status).toBe(503);
    available = true; expect((await get()).status).toBe(200);
  });

  it("detects a real control-store outage after successful readiness", async () => {
    const db = await openPlatformDb({ kind: "pglite" });
    endpoint = await startHealthServer({ port: 0, checks: { ...healthy(), store: async () => { await db.query("select 1"); return true; } } });
    try { expect((await get()).status).toBe(200); }
    finally { await db.close(); }
    const failed = await get(); expect(failed.status).toBe(503); expect(await failed.json()).toMatchObject({ checks: { store: "unavailable" } });
    expect((await get("/healthz")).status).toBe(200);
  });

  it("bounds hanging checks, coalesces them across requests and allows later recovery", async () => {
    vi.useFakeTimers();
    const pending = Promise.withResolvers<boolean>(); const check = vi.fn(() => pending.promise);
    const probe = readinessProbe({ ...healthy(), temporal: check }, 100);
    const first = probe(); const overlapping = probe();
    await vi.advanceTimersByTimeAsync(100);
    expect(await first).toMatchObject({ ready: false, checks: { temporal: "unavailable" } }); await overlapping;
    expect(check).toHaveBeenCalledOnce();
    // Each check that outlived its timeout is abandoned and retried, but only two stay outstanding per dependency.
    for (let i = 0; i < 4; i++) { const later = probe(); await vi.advanceTimersByTimeAsync(100); expect(await later).toMatchObject({ checks: { temporal: "unavailable" } }); }
    expect(check).toHaveBeenCalledTimes(3);
    pending.resolve(true); await vi.advanceTimersByTimeAsync(0);
    expect(await probe()).toMatchObject({ ready: true }); expect(check).toHaveBeenCalledTimes(4);
    expect(vi.getTimerCount()).toBe(0);
  });
  it("recovers when a check stuck on a dead connection never answers but a fresh attempt succeeds", async () => {
    vi.useFakeTimers();
    const never = new Promise<boolean>(() => {}); const store = vi.fn().mockReturnValueOnce(never).mockResolvedValue(true);
    const probe = readinessProbe({ ...healthy(), store }, 100);
    const stuck = probe(); await vi.advanceTimersByTimeAsync(100);
    expect(await stuck).toMatchObject({ ready: false, checks: { store: "unavailable" } });
    expect(await probe()).toMatchObject({ ready: true, checks: { store: "ok" } });
    expect(store).toHaveBeenCalledTimes(2);
  });

  it("handles HEAD, unknown paths and invalid methods without triggering probes", async () => {
    const check = vi.fn(() => true); endpoint = await startHealthServer({ port: 0, checks: { temporal: check, store: check, policy: check, drivers: check } });
    const head = await get("/healthz", "HEAD"); expect(head.status).toBe(200); expect(await head.text()).toBe("");
    expect((await get("/missing")).status).toBe(404);
    const post = await get("/readyz", "POST"); expect(post.status).toBe(405); expect(post.headers.get("allow")).toBe("GET, HEAD"); expect(check).not.toHaveBeenCalled();
  });

  it("validates port settings without echoing input and sanitizes bind failure", async () => {
    expect(healthPortFromEnv({})).toBe(9464); expect(healthPortFromEnv({ ZENITH_WORKER_HEALTH_PORT: "12345" })).toBe(12345);
    for (const port of ["0", "65536", "-1", "1.5", "NaN", "synthetic-secret-canary"]) {
      try { healthPortFromEnv({ ZENITH_WORKER_HEALTH_PORT: port }); throw new Error("unexpected success"); }
      catch (err) { expect(String(err)).toContain("HEALTH_PORT"); expect(String(err)).not.toContain("synthetic-secret-canary"); }
    }
    expect(() => readinessProbe(healthy(), 0)).toThrow("timeout");
    endpoint = await startHealthServer({ port: 0, checks: healthy() });
    await expect(startHealthServer({ port: endpoint.port, checks: healthy() })).rejects.toThrow("listener could not start");
  });
});
