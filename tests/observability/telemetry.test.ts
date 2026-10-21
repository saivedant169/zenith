import { describe, expect, it } from "vitest";
import { createObservabilityFabric } from "@/lib/observability/fabric";
import { describeHealthTelemetry, resourceHealthWithTelemetry } from "@/lib/observability/health";
import {
  FRESHNESS_BUDGET_MS,
  answeredProvenance,
  buildEnvelope,
  classifyUnavailable,
  describeSession,
  failedProvenance,
} from "@/lib/observability/telemetry";
import type { EventQuery, MetricSeries, NormalizedEvent, NormalizedLog, ObservabilitySource, TraceSpanSummary } from "@/lib/observability/types";
import type { RuntimeState } from "@/lib/resources/types";
import { CANARY, ENV, fakeAwsSession, fakeSource, graph, node, result, scope } from "./_fixtures";

const NOW = Date.parse("2026-09-30T12:00:00.000Z");
const now = () => new Date(NOW);
const iso = (minAgo: number) => new Date(NOW - minAgo * 60_000).toISOString();
const range = (minutes = 600) => ({ from: iso(minutes), to: iso(0) });

const log = (minAgo: number, over: Partial<NormalizedLog> = {}): NormalizedLog => ({ timestamp: iso(minAgo), provider: "fake", environmentId: ENV, severity: "info", message: "m", attributes: {}, native: {}, ...over });
const event = (minAgo: number, over: Partial<NormalizedEvent> = {}): NormalizedEvent => ({ timestamp: iso(minAgo), provider: "fake", environmentId: ENV, severity: "info", type: "t", message: "e", native: {}, ...over });

const logSource = (id: string, logs: NormalizedLog[], over: Partial<ObservabilitySource> = {}) =>
  fakeSource(id, { supports: ["log"], searchLogs: async () => result(logs, { sources: [id] }), ...over });

const fabricOf = (sources: ObservabilitySource[], session?: ReturnType<typeof describeSession>) =>
  createObservabilityFabric(sources, { now, timeoutMs: 1000, ...(session ? { session } : {}) });

describe("telemetry envelope on fabric answers", () => {
  it("labels a recent answer fresh with scope, range, observedAt and per-source provenance", async () => {
    const r = await fabricOf([logSource("aws.cloudwatch-logs", [log(2), log(9)])]).searchLogs({ scope: scope(), range: range() });
    const t = r.telemetry!;
    expect(t).toMatchObject({ schemaVersion: 1, signal: "log", state: "fresh", partial: false, observedAt: iso(0) });
    expect(t.scope).toEqual({ workspaceId: "ws-1", environmentId: ENV });
    expect(t.range).toEqual(range());
    expect(t.freshness).toMatchObject({ budgetMs: FRESHNESS_BUDGET_MS.log, newestAt: iso(2), ageMs: 2 * 60_000 });
    expect(t.provenance).toHaveLength(1);
    expect(t.provenance[0]).toMatchObject({ source: "aws.cloudwatch-logs", provider: "fake", state: "fresh", itemCount: 2, newestAt: iso(2), oldestAt: iso(9), simulated: false });
    expect(t.provenance[0].evidence.level).toBe("contract");
  });

  it("labels an answer whose newest item is older than the budget stale, not fresh", async () => {
    const r = await fabricOf([logSource("a", [log(120)])]).searchLogs({ scope: scope(), range: range() });
    expect(r.telemetry!.state).toBe("stale");
    expect(r.telemetry!.provenance[0]).toMatchObject({ state: "stale", ageMs: 120 * 60_000 });
    expect(r.telemetry!.freshness.ageMs).toBe(120 * 60_000);
  });

  it("keeps empty distinct from unknown: a reachable source with no items is empty", async () => {
    const r = await fabricOf([logSource("a", [])]).searchLogs({ scope: scope(), range: range() });
    expect(r.items).toEqual([]);
    expect(r.telemetry!.state).toBe("empty");
    expect(r.telemetry!.provenance[0].state).toBe("empty");
  });

  it("reports a refused source as inaccessible and never as empty or fresh", async () => {
    const denied = fakeSource("denied", {
      supports: ["log"],
      searchLogs: async () => {
        throw new Error("AccessDeniedException: not authorized to perform logs:FilterLogEvents");
      },
    });
    const r = await fabricOf([denied]).searchLogs({ scope: scope(), range: range() });
    expect(r.telemetry!.state).toBe("inaccessible");
    expect(r.telemetry!.provenance).toHaveLength(1);
    expect(r.telemetry!.provenance[0]).toMatchObject({ source: "denied", state: "inaccessible", itemCount: 0 });
    expect(r.telemetry!.provenance[0].reason).toBeTruthy();
  });

  it("reports a timed-out source as unknown", async () => {
    const slow = fakeSource("slow", { supports: ["log"], searchLogs: () => new Promise(() => {}) });
    const r = await createObservabilityFabric([slow], { now, timeoutMs: 20 }).searchLogs({ scope: scope(), range: range() });
    expect(r.telemetry!.state).toBe("unknown");
    expect(r.telemetry!.provenance[0]).toMatchObject({ source: "slow", state: "unknown" });
  });

  it("an unavailable-only source answer is a failure entry, not an empty answer", async () => {
    const unavailable = fakeSource("broker", {
      supports: ["log"],
      searchLogs: async () => result([], { unavailable: [{ source: "broker", reason: "The credential broker refused a session (denied)." }] }),
    });
    const r = await fabricOf([unavailable]).searchLogs({ scope: scope(), range: range() });
    expect(r.telemetry!.state).toBe("inaccessible");
    expect(r.telemetry!.provenance.map((p) => p.state)).toEqual(["inaccessible"]);
  });

  it("marks a partial answer: one fresh source plus one inaccessible source", async () => {
    const denied = fakeSource("denied", {
      supports: ["log"],
      searchLogs: async () => {
        throw new Error("403 Forbidden");
      },
    });
    const r = await fabricOf([logSource("ok", [log(1)]), denied]).searchLogs({ scope: scope(), range: range() });
    expect(r.telemetry!.state).toBe("fresh");
    expect(r.telemetry!.partial).toBe(true);
    expect(Object.fromEntries(r.telemetry!.provenance.map((p) => [p.source, p.state]))).toEqual({ ok: "fresh", denied: "inaccessible" });
  });

  it("with no covering source the answer is unknown and names the fabric", async () => {
    const r = await fabricOf([]).searchLogs({ scope: scope(), range: range() });
    expect(r.telemetry!.state).toBe("unknown");
    expect(r.telemetry!.provenance[0]).toMatchObject({ source: "fabric", state: "unknown" });
  });

  it("counts only items inside the tenant scope: a foreign-environment item cannot make an answer fresh", async () => {
    const r = await fabricOf([logSource("a", [log(1, { environmentId: "other-env" })])]).searchLogs({ scope: scope(), range: range() });
    expect(r.items).toEqual([]);
    expect(r.telemetry!.state).toBe("empty");
    expect(r.telemetry!.provenance[0].itemCount).toBe(0);
  });

  it("carries simulated provenance per source", async () => {
    const sim = fakeSource("sandbox.logsim", { supports: ["log"], searchLogs: async () => result([log(1)], { simulated: true, sources: ["sandbox.logsim"] }) });
    const r = await fabricOf([sim]).searchLogs({ scope: scope(), range: range() });
    expect(r.telemetry!.provenance[0]).toMatchObject({ simulated: true, evidence: { level: "simulated" } });
  });

  it("describes the scoped session without any credential material", async () => {
    const session = describeSession(fakeAwsSession());
    const r = await fabricOf([logSource("a", [log(1)])], session).searchLogs({ scope: scope({ addresses: ["service/web"] }), range: range() });
    expect(r.telemetry!.session).toMatchObject({ provider: "aws", region: "us-east-1", transport: "direct" });
    expect(r.telemetry!.session!.ref).toMatch(/^[0-9a-f]{16}$/);
    expect(r.telemetry!.scope.addresses).toEqual(["service/web"]);
    const text = JSON.stringify(r.telemetry);
    expect(text).not.toContain(CANARY.awsSecret);
    expect(text).not.toContain("123456789012");
    expect(text).not.toMatch(/secretAccessKey|accessKeyId/);
  });

  it("covers metrics, events and traces with the same envelope", async () => {
    const series: MetricSeries = { metric: "cpu.utilization", unit: "percent", provider: "fake", native: {}, points: [{ timestamp: iso(30), value: 1 }, { timestamp: iso(3), value: 2 }] };
    const trace: TraceSpanSummary = { traceId: "abcdef12345", rootName: "GET /", durationMs: 5, status: "ok", startedAt: iso(240), native: {} };
    const src = fakeSource("multi", {
      supports: ["metric", "event", "trace"],
      queryMetrics: async () => result([series], { sources: ["multi"] }),
      searchEvents: async (_q: EventQuery) => result([event(5), event(8, { environmentId: "foreign" })], { sources: ["multi"] }),
      searchTraces: async () => result([trace], { sources: ["multi"] }),
    });
    const fabric = fabricOf([src]);
    const m = await fabric.queryMetrics({ scope: scope(), range: range(), metrics: ["cpu.utilization"] });
    expect(m.telemetry).toMatchObject({ signal: "metric", state: "fresh" });
    expect(m.telemetry!.provenance[0].newestAt).toBe(iso(3));
    const e = await fabric.searchEvents({ scope: scope(), range: range() });
    expect(e.telemetry).toMatchObject({ signal: "event", state: "fresh" });
    expect(e.telemetry!.provenance[0].itemCount).toBe(1);
    const t = await fabric.searchTraces({ scope: scope(), range: range() });
    expect(t.telemetry).toMatchObject({ signal: "trace", state: "stale" });
  });
});

describe("telemetry primitives", () => {
  it("classifies refusals as inaccessible and everything else as unknown", () => {
    for (const r of ["AccessDenied", "UnauthorizedOperation", "403 Forbidden", "Scope is unavailable.", "The credential broker refused a session (denied)."]) expect(classifyUnavailable(r)).toBe("inaccessible");
    // Provider token failures are refusals; a read that never had a broker session is undetermined.
    for (const r of ["read_failed:ExpiredTokenException", "InvalidClientTokenId: The security token included in the request is invalid", "UnrecognizedClientException", "SignatureDoesNotMatch"]) expect(classifyUnavailable(r)).toBe("inaccessible");
    for (const r of ["no AWS session: reading aws signals needs a credential-broker session", "no GCP session: signals need a credential-broker session",
      "Zenith-managed signals need a workspace and a credential-broker Kubernetes session for the tenant namespace"]) expect(classifyUnavailable(r)).toBe("unknown");
    for (const r of ["timed out after 10s", "source does not implement log queries", "no observability source supports log signals"]) expect(classifyUnavailable(r)).toBe("unknown");
  });

  it("an item with an unparseable timestamp can never be fresh", () => {
    const p = answeredProvenance({ source: "x", provider: "p", simulated: false, timestamps: ["not-a-date"], observedAt: iso(0), budgetMs: 1000 });
    expect(p.state).toBe("unknown");
    expect(p.reason).toBeTruthy();
  });

  it("an envelope with only refused sources is inaccessible; mixed refused and unknown is unknown", () => {
    const base = { signal: "log" as const, scope: scope(), observedAt: iso(0) };
    const refused = failedProvenance({ source: "a", reason: "access denied", observedAt: iso(0) });
    const broken = failedProvenance({ source: "b", reason: "timeout", observedAt: iso(0) });
    expect(buildEnvelope({ ...base, provenance: [refused] }).state).toBe("inaccessible");
    expect(buildEnvelope({ ...base, provenance: [refused, broken] }).state).toBe("unknown");
    expect(buildEnvelope({ ...base, provenance: [] }).state).toBe("unknown");
  });

  it("session refs are stable per session and differ across sessions", () => {
    const a = describeSession(fakeAwsSession())!;
    expect(describeSession({ ...fakeAwsSession(), accountId: "999999999999" })!.ref).not.toBe(a.ref);
    expect(describeSession(undefined)).toBeUndefined();
  });
});

describe("resource health telemetry", () => {
  const web = node("service/web", "container_service", "aws");
  const state = (over: Partial<RuntimeState>): RuntimeState => ({ address: "service/web", health: "healthy", counts: {}, signals: [], observedAt: iso(0), source: "observability.aws.ecs@1", simulated: false, ...over });

  it("labels a read state fresh and a provider refusal inaccessible", () => {
    const env = describeHealthTelemetry(scope(), [state({}), state({ address: "resource/db", health: "unknown", signals: ["read_failed:AccessDeniedException"] })], { observedAt: iso(0) });
    const byAddress = Object.fromEntries(env.provenance.map((p) => [p.address, p.state]));
    expect(byAddress).toEqual({ "service/web": "fresh", "resource/db": "inaccessible" });
    expect(env.state).toBe("fresh");
    expect(env.partial).toBe(true);
  });

  it("labels a state read long before observedAt stale", () => {
    const env = describeHealthTelemetry(scope(), [state({ observedAt: iso(30) })], { observedAt: iso(0) });
    expect(env.state).toBe("stale");
  });

  it("an unreadable resource is unknown with its reason, never healthy", async () => {
    const out = await resourceHealthWithTelemetry(scope(), graph([web]), { now });
    expect(out.states[0].health).toBe("unknown");
    expect(out.telemetry.state).toBe("unknown");
    expect(out.telemetry.provenance[0]).toMatchObject({ address: "service/web", state: "unknown", reason: "no_aws_session" });
    expect(out.telemetry.session).toBeUndefined();
  });
});
