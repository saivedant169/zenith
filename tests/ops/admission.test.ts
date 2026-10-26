/**
 * PROD-OPS-02: request admission (maintenance, in-flight ceiling, per-workspace rate and concurrency),
 * dispatch admission (pause and rate), and the route() wiring that makes them reachable.
 *
 * The control store is injected as a small in-memory fake of exactly the three queries admission makes
 * (maintenance row, tenant quota row, active-operation count); the real SQL is exercised against PGlite
 * and PostgreSQL in tests/ops/store.engine.test.ts. Nothing here pretends to be a database engine test.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Sql } from "@/lib/controlplane/types";
import { assertDispatchAdmitted, beginRequest, bindRequestWorkspace } from "@/lib/ops/admission";
import { BackpressureError } from "@/lib/ops/errors";
import { opsLimitsFromEnv } from "@/lib/ops/config";
import { buildRuntime, setOpsRuntimeForTests } from "@/lib/ops/runtime";
import { metricsRegistry } from "@/lib/ops/telemetry/metrics";
import { parseTraceparent } from "@/lib/ops/telemetry/tracing";

interface FakeState {
  maintenance?: { mode: string; reason: string; version: number };
  quotas: Record<string, Record<string, unknown>>;
  active: Record<string, number>;
  failQueries?: boolean;
  /** make only the tenant quota read, or only the active-operation count, fail */
  failQuotas?: boolean;
  failActive?: boolean;
}

function fakeStore(state: FakeState): () => Promise<Sql> {
  const sql: Sql = {
    async query<T>(text: string, params: readonly unknown[] = []): Promise<T[]> {
      if (state.failQueries) throw new Error("control store unreachable");
      if (state.failQuotas && text.includes("from platform.tenant_quotas")) throw new Error("quota relation unreadable");
      if (state.failActive && text.includes("from platform.operations")) throw new Error("operations relation unreadable");
      if (text.includes("from platform.ops_maintenance where")) {
        return (state.maintenance ? [{ ...state.maintenance, updated_by: "op", updated_at: "now" }] : []) as T[];
      }
      if (text.includes("from platform.tenant_quotas")) {
        const row = state.quotas[String(params[0])];
        return (row ? [row] : []) as T[];
      }
      if (text.includes("from platform.operations")) return [{ n: state.active[String(params[0])] ?? 0 }] as T[];
      return [];
    },
    tx: async (fn) => fn(sql),
  };
  return async () => sql;
}

const quotaRow = (workspaceId: string, over: Record<string, unknown> = {}) => ({
  workspace_id: workspaceId, weight: 1, api_rate_per_sec: null, api_burst: null, max_concurrent_requests: null,
  max_active_operations: null, max_queued_jobs: null, version: 1, updated_by: "op", updated_at: "now", ...over,
});

function install(env: Record<string, string>, state: FakeState = { quotas: {}, active: {} }) {
  const runtime = buildRuntime(opsLimitsFromEnv(env), fakeStore(state));
  setOpsRuntimeForTests(runtime);
  return { runtime, state };
}

const req = (method: string, pathname: string, headers: Record<string, string> = {}) => ({ method, pathname, headers: new Headers(headers), requestId: "req1" });

beforeEach(() => {
  vi.stubEnv("ZENITH_PLATFORM_DB", "pglite");
  metricsRegistry().reset();
});
afterEach(() => {
  setOpsRuntimeForTests(undefined);
  vi.unstubAllEnvs();
});

describe("beginRequest", () => {
  it("admits a request, tracks it in flight, and releases everything on finish (idempotently)", async () => {
    const { runtime } = install({});
    const scope = await beginRequest(req("GET", "/api/projects"));
    await scope.bindWorkspace("ws_a");
    expect(runtime.globalGate.inFlight).toBe(1);
    expect(runtime.tenantGate.inFlightFor("ws_a")).toBe(1);
    scope.finish(200);
    scope.finish(200);
    expect(runtime.globalGate.inFlight).toBe(0);
    expect(runtime.tenantGate.inFlightFor("ws_a")).toBe(0);
    const text = metricsRegistry().renderPrometheus();
    expect(text).toContain('zenith_api_requests_total{tenant="ws_a",route_class="/api/projects",method="GET",status_class="2xx"} 1');
    expect(text).toContain('zenith_admission_decisions_total{layer="api",decision="allowed",tenant="ws_a"} 1');
  });

  it("answers 503 overloaded at the process-wide in-flight ceiling, and frees the slot when a request finishes", async () => {
    install({ ZENITH_OPS_API_MAX_IN_FLIGHT: "2" });
    const a = await beginRequest(req("GET", "/api/a"));
    const b = await beginRequest(req("GET", "/api/b"));
    await expect(beginRequest(req("GET", "/api/c"))).rejects.toMatchObject({ code: "overloaded", status: 503, layer: "api" });
    a.finish(200);
    const c = await beginRequest(req("GET", "/api/c"));
    c.finish(200);
    b.finish(200);
    expect(metricsRegistry().renderPrometheus()).toContain('zenith_admission_decisions_total{layer="api",decision="overloaded",tenant="none"} 1');
  });

  it("never refuses control lanes at the ceiling: runner results, cron ticks and the operator route still get through", async () => {
    install({ ZENITH_OPS_API_MAX_IN_FLIGHT: "1" });
    const held = await beginRequest(req("GET", "/api/a"));
    for (const path of ["/api/platform/v1/runners/run_1/jobs/job_1/result", "/api/internal/tick/reconcile", "/api/admin/ops/maintenance"]) {
      const lane = await beginRequest(req("POST", path));
      await lane.bindWorkspace("ws_a"); // lanes skip the tenant quota as well
      lane.finish(200);
    }
    held.finish(200);
  });

  it("rate limits ONE workspace with 429 + a retry hint while another workspace is unaffected", async () => {
    install({ ZENITH_OPS_API_RATE_PER_SEC: "1", ZENITH_OPS_API_BURST: "2" });
    for (let i = 0; i < 2; i++) {
      const s = await beginRequest(req("GET", "/api/projects"));
      await s.bindWorkspace("ws_noisy");
      s.finish(200);
    }
    const refused = await beginRequest(req("GET", "/api/projects"));
    const error = await refused.bindWorkspace("ws_noisy").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(BackpressureError);
    expect(error).toMatchObject({ code: "rate_limited", status: 429, layer: "api", tenant: "ws_noisy" });
    expect((error as BackpressureError).retryAfterSec).toBeGreaterThanOrEqual(1);
    refused.finish(429, error);
    const calm = await beginRequest(req("GET", "/api/projects"));
    await expect(calm.bindWorkspace("ws_calm")).resolves.toBeUndefined();
    calm.finish(200);
    const text = metricsRegistry().renderPrometheus();
    expect(text).toContain('zenith_admission_decisions_total{layer="api",decision="rate_limited",tenant="ws_noisy"} 1');
    expect(text).toContain('status_class="4xx"');
  });

  it("caps one workspace's concurrent requests (429) without affecting others, and a finished request frees its slot", async () => {
    install({ ZENITH_OPS_API_MAX_CONCURRENT_PER_TENANT: "2" });
    const open = [];
    for (let i = 0; i < 2; i++) { const s = await beginRequest(req("GET", "/api/x")); await s.bindWorkspace("ws_a"); open.push(s); }
    const third = await beginRequest(req("GET", "/api/x"));
    await expect(third.bindWorkspace("ws_a")).rejects.toMatchObject({ code: "concurrency_exceeded", status: 429 });
    third.finish(429);
    const other = await beginRequest(req("GET", "/api/x"));
    await expect(other.bindWorkspace("ws_b")).resolves.toBeUndefined();
    other.finish(200);
    open[0].finish(200);
    const again = await beginRequest(req("GET", "/api/x"));
    await expect(again.bindWorkspace("ws_a")).resolves.toBeUndefined();
    again.finish(200);
    open[1].finish(200);
  });

  it("applies a tenant's quota override and weight from the control store", async () => {
    const state: FakeState = { quotas: { ws_vip: quotaRow("ws_vip", { max_concurrent_requests: 4 }), ws_w3: quotaRow("ws_w3", { weight: 3 }) }, active: {} };
    const { runtime } = install({ ZENITH_OPS_API_MAX_CONCURRENT_PER_TENANT: "1" }, state);
    const vip = [];
    for (let i = 0; i < 4; i++) { const s = await beginRequest(req("GET", "/api/x")); await s.bindWorkspace("ws_vip"); vip.push(s); }
    const fifth = await beginRequest(req("GET", "/api/x"));
    await expect(fifth.bindWorkspace("ws_vip")).rejects.toMatchObject({ code: "concurrency_exceeded" });
    fifth.finish(429);
    // weight 3 scales the default of 1 to 3
    const w3 = [];
    for (let i = 0; i < 3; i++) { const s = await beginRequest(req("GET", "/api/x")); await s.bindWorkspace("ws_w3"); w3.push(s); }
    expect(runtime.tenantGate.inFlightFor("ws_w3")).toBe(3);
    const fourth = await beginRequest(req("GET", "/api/x"));
    await expect(fourth.bindWorkspace("ws_w3")).rejects.toMatchObject({ code: "concurrency_exceeded" });
    fourth.finish(429);
    for (const s of [...vip, ...w3]) s.finish(200);
  });

  it("falls back to the defaults, not an error, when the control store is down", async () => {
    install({}, { quotas: {}, active: {}, failQueries: true });
    const s = await beginRequest(req("GET", "/api/x"));
    await expect(s.bindWorkspace("ws_a")).resolves.toBeUndefined();
    s.finish(200);
  });

  it("refuses mutating calls in read-only maintenance from the store, keeps reads, and a store outage keeps the last known window", async () => {
    const state: FakeState = { quotas: {}, active: {}, maintenance: { mode: "read_only", reason: "failover drill", version: 2 } };
    install({ ZENITH_OPS_MAINTENANCE_CACHE_MS: "0" }, state);
    await expect(beginRequest(req("POST", "/api/projects"))).rejects.toMatchObject({ code: "maintenance_read_only", status: 503 });
    const read = await beginRequest(req("GET", "/api/projects"));
    read.finish(200);
    const lane = await beginRequest(req("POST", "/api/platform/v1/runners/run_1/heartbeat"));
    lane.finish(200);
    state.failQueries = true;
    await expect(beginRequest(req("POST", "/api/projects"))).rejects.toMatchObject({ code: "maintenance_read_only" });
    state.failQueries = false;
    state.maintenance = { mode: "off", reason: "", version: 3 };
    const writable = await beginRequest(req("POST", "/api/projects"));
    writable.finish(200);
  });

  it("applies the host-level override even when no store is configured", async () => {
    vi.stubEnv("ZENITH_PLATFORM_DB", "");
    vi.stubEnv("ZENITH_PLATFORM_DB_URL", "");
    vi.stubEnv("SUPABASE_DB_URL", "");
    install({ ZENITH_MAINTENANCE_MODE: "read_only", ZENITH_MAINTENANCE_REASON: "host upgrade" });
    await expect(beginRequest(req("DELETE", "/api/projects/p1"))).rejects.toMatchObject({ code: "maintenance_read_only" });
  });

  it("applies the quota to a workspace learned late (platform API bearer) through bindRequestWorkspace, once per request, and is a no-op outside a request", async () => {
    const { runtime } = install({ ZENITH_OPS_API_MAX_CONCURRENT_PER_TENANT: "1" });
    await expect(bindRequestWorkspace("ws_late")).resolves.toBeUndefined();
    const first = await beginRequest(req("POST", "/api/platform/v1/capabilities/propose"));
    await first.run(() => bindRequestWorkspace("ws_late"));
    await first.run(() => bindRequestWorkspace("ws_late")); // idempotent: still one lease
    await first.run(() => bindRequestWorkspace("ws_other")); // the first workspace wins
    expect(runtime.tenantGate.inFlightFor("ws_late")).toBe(1);
    expect(runtime.tenantGate.inFlightFor("ws_other")).toBe(0);
    const second = await beginRequest(req("POST", "/api/platform/v1/capabilities/propose"));
    await expect(second.run(() => bindRequestWorkspace("ws_late"))).rejects.toMatchObject({ code: "concurrency_exceeded", status: 429 });
    second.finish(429);
    first.finish(200);
    expect(runtime.tenantGate.inFlightFor("ws_late")).toBe(0);
  });

  it("puts the operation id from an operations path on the span so traces join to the operation", async () => {
    install({});
    const { tracer } = await import("@/lib/ops/telemetry/tracing");
    tracer().drain(10_000);
    const scope = await beginRequest(req("POST", "/api/platform/v1/operations/op_77/cancel", { traceparent: "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01" }));
    scope.finish(200);
    const span = tracer().drain(100).find((x) => x.traceId === "4bf92f3577b34da6a3ce929d0e0e4736");
    expect(span?.attributes["zenith.operation.id"]).toBe("op_77");
  });

  it("opens a server span: honours an incoming traceparent and returns one, with tenant correlation attributes", async () => {
    install({});
    const incoming = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01";
    const scope = await beginRequest(req("GET", "/api/projects", { traceparent: incoming }));
    await scope.bindWorkspace("ws_trace");
    const out = parseTraceparent(scope.traceparent);
    expect(out?.traceId).toBe("4bf92f3577b34da6a3ce929d0e0e4736");
    expect(out?.spanId).not.toBe("00f067aa0ba902b7");
    scope.finish(200);
    const { tracer } = await import("@/lib/ops/telemetry/tracing");
    const span = tracer().drain(100).find((s) => s.traceId === "4bf92f3577b34da6a3ce929d0e0e4736");
    expect(span).toMatchObject({ parentSpanId: "00f067aa0ba902b7", kind: "server", name: "GET /api/projects" });
    expect(span?.attributes).toMatchObject({ "zenith.tenant.id": "ws_trace", "zenith.operation.class": "api", "zenith.request.id": "req1", "http.response.status_code": 200 });
  });
});

describe("assertDispatchAdmitted", () => {
  it("is a no-op for a healthy workspace and counts the dispatch", async () => {
    install({});
    await expect(assertDispatchAdmitted({ workspaceId: "ws_a", kind: "deploy", operationId: "op_1" })).resolves.toBeUndefined();
    expect(metricsRegistry().renderPrometheus()).toContain('zenith_dispatch_total{tenant="ws_a",kind="deploy",outcome="admitted"} 1');
  });

  it("pauses new dispatch in dispatch_paused and read_only maintenance, before anything is claimed", async () => {
    for (const mode of ["dispatch_paused", "read_only"]) {
      install({ ZENITH_OPS_MAINTENANCE_CACHE_MS: "0" }, { quotas: {}, active: {}, maintenance: { mode, reason: "upgrade", version: 1 } });
      await expect(assertDispatchAdmitted({ workspaceId: "ws_a", kind: "destroy", operationId: "op_1" })).rejects.toMatchObject({ code: "maintenance_dispatch_paused", status: 503, layer: "maintenance", tenant: "ws_a" });
    }
    expect(metricsRegistry().renderPrometheus()).toContain('outcome="maintenance_dispatch_paused"');
  });

  it("enforces the workspace's active-operation quota with 429, excluding the operation being retried", async () => {
    const state: FakeState = { quotas: {}, active: { ws_full: 3 } };
    install({ ZENITH_OPS_MAX_ACTIVE_OPERATIONS: "3" }, state);
    await expect(assertDispatchAdmitted({ workspaceId: "ws_full", kind: "deploy", operationId: "op_9" })).rejects.toMatchObject({ code: "concurrency_exceeded", status: 429, layer: "dispatch" });
    await expect(assertDispatchAdmitted({ workspaceId: "ws_roomy", kind: "deploy", operationId: "op_9" })).resolves.toBeUndefined();
    state.active.ws_full = 2;
    await expect(assertDispatchAdmitted({ workspaceId: "ws_full", kind: "deploy", operationId: "op_9" })).resolves.toBeUndefined();
  });

  it("uses a tenant's own max_active_operations when one is set", async () => {
    const state: FakeState = { quotas: { ws_big: quotaRow("ws_big", { max_active_operations: 50 }) }, active: { ws_big: 40 } };
    install({ ZENITH_OPS_MAX_ACTIVE_OPERATIONS: "3" }, state);
    await expect(assertDispatchAdmitted({ workspaceId: "ws_big", kind: "dayTwo" })).resolves.toBeUndefined();
  });

  it("token-buckets dispatch per workspace", async () => {
    install({ ZENITH_OPS_DISPATCH_RATE_PER_SEC: "0.01", ZENITH_OPS_DISPATCH_BURST: "2" });
    await assertDispatchAdmitted({ workspaceId: "ws_a", kind: "deploy" });
    await assertDispatchAdmitted({ workspaceId: "ws_a", kind: "deploy" });
    await expect(assertDispatchAdmitted({ workspaceId: "ws_a", kind: "deploy" })).rejects.toMatchObject({ code: "rate_limited", layer: "dispatch", status: 429 });
    await expect(assertDispatchAdmitted({ workspaceId: "ws_b", kind: "deploy" })).resolves.toBeUndefined();
  });

  it("refuses, rather than admits, when the quota lookup throws (fail closed), and the error reveals nothing of the cause", async () => {
    install({}, { quotas: {}, active: {}, failQuotas: true });
    const error = await assertDispatchAdmitted({ workspaceId: "ws_a", kind: "deploy", operationId: "op_1" }).then(() => undefined, (e: unknown) => e);
    expect(error).toMatchObject({ code: "admission_unavailable", status: 503, layer: "dispatch", tenant: "ws_a" });
    expect((error as Error).message).not.toMatch(/relation|platform|unreadable|store/i);
    expect(metricsRegistry().renderPrometheus()).toContain('zenith_dispatch_total{tenant="ws_a",kind="deploy",outcome="admission_unavailable"} 1');
  });

  it("refuses, rather than admits, when the control store cannot be read at all", async () => {
    install({}, { quotas: {}, active: {}, failQueries: true });
    await expect(assertDispatchAdmitted({ workspaceId: "ws_a", kind: "deploy", operationId: "op_1" })).rejects.toMatchObject({ code: "admission_unavailable", status: 503 });
  });

  it("refuses when the active-operation count cannot be read, and admits once it can", async () => {
    const state: FakeState = { quotas: {}, active: { ws_a: 0 }, failActive: true };
    install({}, state);
    await expect(assertDispatchAdmitted({ workspaceId: "ws_a", kind: "deploy", operationId: "op_1" })).rejects.toMatchObject({ code: "admission_unavailable", layer: "dispatch" });
    state.failActive = false;
    await expect(assertDispatchAdmitted({ workspaceId: "ws_a", kind: "deploy", operationId: "op_1" })).resolves.toBeUndefined();
  });

  it("admits a workspace whose quota is read and is under its active-operation limit", async () => {
    install({}, { quotas: { ws_ok: quotaRow("ws_ok", { max_active_operations: 5 }) }, active: { ws_ok: 4 } });
    await expect(assertDispatchAdmitted({ workspaceId: "ws_ok", kind: "deploy", operationId: "op_1" })).resolves.toBeUndefined();
  });

  it("refuses an over-quota workspace whose quota is read", async () => {
    install({}, { quotas: { ws_ok: quotaRow("ws_ok", { max_active_operations: 5 }) }, active: { ws_ok: 5 } });
    await expect(assertDispatchAdmitted({ workspaceId: "ws_ok", kind: "deploy", operationId: "op_1" })).rejects.toMatchObject({ code: "concurrency_exceeded", status: 429 });
  });

  it("keeps an unconfigured install unchanged: no platform store means defaults and no active count, so it is admitted", async () => {
    vi.stubEnv("ZENITH_PLATFORM_DB", "");
    vi.stubEnv("ZENITH_PLATFORM_DB_URL", "");
    vi.stubEnv("SUPABASE_DB_URL", "");
    install({}, { quotas: {}, active: {}, failQueries: true });
    await expect(assertDispatchAdmitted({ workspaceId: "ws_a", kind: "deploy", operationId: "op_1" })).resolves.toBeUndefined();
  });
});
