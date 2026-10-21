/**
 * POST /api/internal/tick/reconcile: the same gate as every other tick route
 * (401 without the bearer, 503 without CRON_SECRET), and an honest answer when
 * the controller has nothing to run against.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { tempDataDir } from "../_support/data-dir";
import { ENV, FakeBroker, SESSION_CANARY, T0, World, Clock, tinyGraph } from "./_support";

tempDataDir("zenith-reconcile-route-", { fast: true });

const SECRET = "test-cron-secret-value";
const { POST } = await import("@/app/api/internal/tick/reconcile/route");
const { MemoryReconcileBackend, resetMemoryReconcileBackend, wireReconcilePorts } = await import("@/lib/reconcile");

const call = (opts: { bearer?: string; raw?: string; query?: string } = {}): Promise<Response> => {
  const headers = new Headers();
  if (opts.raw !== undefined) headers.set("authorization", opts.raw);
  else if (opts.bearer !== undefined) headers.set("authorization", `Bearer ${opts.bearer}`);
  return POST(new NextRequest(`http://zenith.test/api/internal/tick/reconcile${opts.query ?? ""}`, { method: "POST", headers }));
};

beforeEach(() => {
  process.env.CRON_SECRET = SECRET;
  delete process.env.ZENITH_RECONCILE_MEMORY;
  // No platform store configured: a set platform DB URL makes the route boot real ports (correctly a 200).
  for (const name of ["ZENITH_PLATFORM_DB", "ZENITH_PLATFORM_DB_URL", "SUPABASE_DB_URL"]) vi.stubEnv(name, "");
  wireReconcilePorts(null);
  resetMemoryReconcileBackend();
});

afterEach(() => {
  vi.unstubAllEnvs();
  delete process.env.CRON_SECRET;
  delete process.env.ZENITH_RECONCILE_MEMORY;
  wireReconcilePorts(null);
  resetMemoryReconcileBackend();
});

describe("the gate", () => {
  it("refuses a request with no Authorization header, a wrong bearer, or a header that is not a bearer", async () => {
    for (const attempt of [{}, { bearer: "nope" }, { bearer: "" }, { raw: SECRET }, { raw: `Basic ${SECRET}` }]) {
      const res = await call(attempt);
      expect(res.status, JSON.stringify(attempt)).toBe(401);
      const body = (await res.json()) as { error: { message: string; fix?: string } };
      expect(body.error.message).toContain("scheduler");
      expect(body.error.fix).toContain("CRON_SECRET");
    }
  });

  it("answers 503, not 200, when CRON_SECRET is unset", async () => {
    delete process.env.CRON_SECRET;
    const res = await call({ bearer: SECRET });
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: { message: string; fix?: string } };
    expect(body.error.message).toContain("CRON_SECRET");
    expect(body.error.fix).toContain("Vercel");
  });

  it("checks the bearer BEFORE it builds any ports: an unauthorised probe touches nothing", async () => {
    const factory = vi.fn();
    wireReconcilePorts(factory);
    expect((await call()).status).toBe(401);
    expect((await call({ bearer: "nope" })).status).toBe(401);
    delete process.env.CRON_SECRET;
    expect((await call({ bearer: SECRET })).status).toBe(503);
    expect(factory).not.toHaveBeenCalled();
  });
});

describe("what it answers when authorised", () => {
  it("503 platform_store_unavailable when no ports were wired: never a 200 that claims 'no drift' for a fleet nobody looked at", async () => {
    const res = await call({ bearer: SECRET });
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: { message: string; fix?: string } };
    expect(body.error.message).toMatch(/no platform store/i);
    expect(body.error.fix).toContain("ZENITH_RECONCILE_MEMORY=1");
  });

  it("with ZENITH_RECONCILE_MEMORY=1 it runs against the in-memory backend and answers counts", async () => {
    process.env.ZENITH_RECONCILE_MEMORY = "1";
    const res = await call({ bearer: SECRET });
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toMatchObject({ pass: "reconcile", ok: true, claimed: 0, reconciled: 0, failed: 0, deferred: 0, timedOut: false, saturated: false });
    expect(typeof body.ms).toBe("number");
    const counts = Object.entries(body).filter(([k]) => k !== "pass" && k !== "ok" && k !== "ms");
    expect(counts.length).toBeGreaterThan(5);
  });

  it("runs ONE bounded pass over wired ports and reports what it did", async () => {
    const clock = new Clock(T0);
    const backend = new MemoryReconcileBackend({ now: clock.now });
    const world = new World();
    for (let i = 0; i < 7; i++) {
      const id = `env-${i}`;
      const g = tinyGraph(id, 2);
      backend.addEnvironment({ ...ENV, environmentId: id }, g);
      world.allPresent(g);
    }
    world.patch("log_group/extra-0", { presence: "missing" });
    const ports = backend.passPorts({ broker: new FakeBroker(backend), driverFor: world.driverFor, withObserveSession: (_r, fn) => fn({ token: SESSION_CANARY }) });
    wireReconcilePorts(() => ports);

    const first = (await (await call({ bearer: SECRET, query: "?max=3" })).json()) as Record<string, number | boolean>;
    expect(first).toMatchObject({ ok: true, claimed: 3, reconciled: 3, saturated: true, driftDetected: 3, repairsProposed: 3, repairsStarted: 3 });
    const second = (await (await call({ bearer: SECRET, query: "?max=10" })).json()) as Record<string, number>;
    expect(second).toMatchObject({ claimed: 4, reconciled: 4 });
    expect(backend.events.filter((e) => e.type === "drift.detected")).toHaveLength(7);
  });

  it("?budgetMs=0 runs nothing, and the limits cannot be widened past the pass's own ceilings", async () => {
    const backend = new MemoryReconcileBackend();
    backend.addEnvironment({ ...ENV }, tinyGraph("env-prod", 1));
    wireReconcilePorts(() => backend.passPorts());
    expect(await (await call({ bearer: SECRET, query: "?budgetMs=0" })).json()).toMatchObject({ claimed: 0 });
    // an absurd max is clamped, not honoured (and the environment is simply reconciled)
    expect(await (await call({ bearer: SECRET, query: "?max=999999999&budgetMs=999999999" })).json()).toMatchObject({ ok: true, claimed: 1 });
  });

  it("a pass that throws answers 500 with a request id and leaks nothing", async () => {
    wireReconcilePorts(() => {
      throw new Error("internal detail: postgres://admin:hunter2@db");
    });
    const res = await call({ bearer: SECRET });
    expect(res.status).toBe(500);
    const text = await res.text();
    expect(text).not.toContain("hunter2");
    expect(res.headers.get("x-request-id")).toBeTruthy();
  });
});
