/** Real MCP HTTP route + composed ports + native source implementations.
 * AWS SDK responses, Kubernetes API and auth are mocked; no live cloud proof.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { mockClient } from "aws-sdk-client-mock";
import { CloudWatchLogsClient, FilterLogEventsCommand } from "@aws-sdk/client-cloudwatch-logs";
import { CloudWatchClient, GetMetricDataCommand } from "@aws-sdk/client-cloudwatch";
import type { CredentialBroker, CredentialRequest, ProviderSession } from "@/lib/credentials/types";
import type { KubernetesCoreApi } from "@/lib/observability/sources/kubernetes";
import type { DriverContext } from "@/lib/drivers/types";
import type { ResourceNode } from "@/lib/resources/types";
import type { AuthDeps } from "@/lib/agent-access/v3/auth";
import { tempDataDir } from "../_support/data-dir";
import { CANARY, fakeAwsSession, fakeKubeSession } from "../observability/_fixtures";
import { argsFor, bearer, identity, ids, makeHarness, ORIGIN } from "./support";

tempDataDir("zenith-observe-wired-route-", { fast: true });
const { openPlatformDb, repos } = await import("@/lib/controlplane/db");
const { composeAgentPorts } = await import("@/lib/platform/agent-ports");
const { sourcesForEnvironment } = await import("@/lib/observability/sources/factory");
const { graphFor } = await import("@/lib/agent-access/v3/context");
const { defaultPorts, registerCredentialBroker, registerInvestigator } = await import("@/lib/agent-access/v3/adapters");
const { setMcpRuntimeForTests } = await import("@/lib/agent-access/v3/runtime");
const route = await import("@/app/api/agent/v3/mcp/route");
const cwLogs = mockClient(CloudWatchLogsClient);
const cwMetrics = mockClient(CloudWatchClient);
let sql: Awaited<ReturnType<typeof openPlatformDb>>;
beforeAll(async () => {
  sql = await openPlatformDb({ kind: "pglite" });
  for (const provider of ["aws", "kubernetes"] as const) {
    const connection = await repos.connections.create(sql, { id: `platform-${provider}`, workspaceId: ids.ws, legacyConnectionId: `product-${provider}`, createdBy: "operator",
      config: provider === "aws" ? { provider, mode: "runner", accountId: "123456789012", region: "us-east-1", observeRoleArn: "arn:aws:iam::123456789012:role/Observe", deployRoleArn: "arn:aws:iam::123456789012:role/Deploy", runnerId: "contract-runner" }
        : { provider, mode: "kubeconfig_ref", server: "https://cluster.test", namespaces: [] } });
    await repos.connections.recordVerification(sql, { workspaceId: ids.ws, id: connection.id, ok: true, detail: "Mocked fixture." });
  }
});
afterAll(async () => { await sql.close(); cwLogs.restore(); cwMetrics.restore(); });
afterEach(() => { registerCredentialBroker(undefined); registerInvestigator(undefined); setMcpRuntimeForTests(null); cwLogs.reset(); cwMetrics.reset(); });

async function setup(provider: "aws" | "kubernetes") {
  const h = await makeHarness(); const environment = h.environments.get(ids.env)!;
  environment.provider = provider; environment.connectionId = `product-${provider}`;
  let inside = false; const sessionRequests: CredentialRequest[] = [];
  const api: KubernetesCoreApi = {
    listNamespacedPod: vi.fn(async () => { expect(inside).toBe(true); return { items: [{ metadata: { name: "web-pod" }, spec: { containers: [{ name: "web" }] } }] }; }),
    readNamespacedPodLog: vi.fn(async () => { expect(inside).toBe(true); return `${h.clock.now().toISOString()} ERROR password=${CANARY.password} ECONNREFUSED`; }),
    listNamespacedEvent: vi.fn(async () => { expect(inside).toBe(true); return { items: [] }; }),
  };
  const session: ProviderSession = provider === "aws" ? fakeAwsSession() : fakeKubeSession({});
  const credentials: CredentialBroker = { async withSession(req, fn) { sessionRequests.push(req); inside = true; try { return await fn(session); } finally { inside = false; } }, verifyConnection: async () => ({ ok: false, detail: "Mocked broker" }) };
  const graph = graphFor(h.projects.get(ids.project)!.workingManifest, environment);
  if (provider === "aws") {
    for (const node of graph.nodes.filter((n) => n.kind === "container_service" || n.kind === "log_group")) {
      const row = await repos.resources.upsertDesired(sql, { workspaceId: ids.ws, projectId: ids.project, environmentId: ids.env, node });
      await repos.observations.appendObservation(sql, { workspaceId: ids.ws, resourceId: row.id, observation: { address: node.address, presence: "present", attributes: {}, observedAt: h.clock.now().toISOString(), source: "contract-fixture", simulated: false,
        externalId: node.kind === "container_service" ? "arn:aws:ecs:us-east-1:123456789012:service/contract/web" : "/ecs/contract/web" } });
    }
    cwLogs.on(FilterLogEventsCommand).callsFake(() => { expect(inside).toBe(true); return { events: [{ timestamp: h.clock.ms, message: `ERROR password=${CANARY.password} ECONNREFUSED`, eventId: "fixture-event" }] }; });
    cwMetrics.on(GetMetricDataCommand).callsFake((input) => { expect(inside).toBe(true); return { MetricDataResults: input.MetricDataQueries.map((q: { Id: string }) => ({ Id: q.Id, StatusCode: "Complete", Timestamps: [h.clock.now()], Values: [25] })) }; });
  }
  const ports = composeAgentPorts(sql, credentials, { reads: h.ports.reads, now: h.clock.now,
    sources: (input) => sourcesForEnvironment({ ...input, kubernetes: { api: () => api } }),
    drivers: () => ({ id: "contract-driver", provider, nativeType: "fixture", kind: "container_service", capabilities: { compile: false, observe: true, runtime: true, verify: false, discover: false, operations: [], evidence: { observe: "contract", runtime: "contract" } },
      observe: async (ctx: DriverContext, node: ResourceNode) => { expect(inside).toBe(true); expect(ctx.session).toBe(session); return { address: node.address, presence: "present", attributes: {}, observedAt: h.clock.now().toISOString(), source: "contract-driver", simulated: false }; },
      runtime: async (_ctx: DriverContext, node: ResourceNode) => ({ address: node.address, health: "unhealthy", counts: { desired: 1, running: 0 }, signals: ["CrashLoopBackOff"], observedAt: h.clock.now().toISOString(), source: "contract-driver", simulated: false }), expectedAttributes: () => ({}) }),
  });
  registerCredentialBroker(credentials, ports.observability); registerInvestigator(ports.investigator);
  const defaults = defaultPorts(); h.ports.observability = defaults.observability; h.ports.investigator = defaults.investigator;
  const who = identity();
  const auth: AuthDeps = { checkOrigin: () => ORIGIN, now: Date.now, authority: async () => ({ kind: "postgres", verify: async () => ({ ...who, id: who.integrationId }), touch: async () => {} }),
    oauth: { config: () => undefined, verify: async () => { throw new Error("No OAuth fixture"); }, bind: async () => who } };
  setMcpRuntimeForTests({ ports: h.ports, auth, requireEnabled: async () => {}, throttle: async () => {} });
  return { h, api, sessionRequests, inside: () => inside };
}

async function call(name: string, args: unknown) {
  const response = await route.POST(new Request(`${ORIGIN}/api/agent/v3/mcp`, { method: "POST", headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }) }));
  expect(response.status).toBe(200); return (await response.json()).result.structuredContent;
}

describe("cloud signals through MCP HTTP", () => {
  it("returns AWS logs and metrics using native source code inside the observe callback", async () => {
    const s = await setup("aws");
    const logs = await call("zenith_query_logs", argsFor("zenith_query_logs"));
    expect(logs.ok).toBe(true); expect(logs.data.count).toBe(1); expect(logs.data.sources).toEqual(["aws.cloudwatch-logs"]);
    const metrics = await call("zenith_query_metrics", argsFor("zenith_query_metrics"));
    expect(metrics.ok).toBe(true); expect(metrics.data.seriesCount).toBe(1); expect(metrics.untrusted_data.content.series[0].points[0].value).toBe(25);
    expect(JSON.stringify(logs)).not.toContain(CANARY.password); expect(s.sessionRequests).toHaveLength(2); expect(s.inside()).toBe(false);
    expect(s.sessionRequests.every((req) => req.purpose === "observe" && req.connectionId === "platform-aws")).toBe(true);
  });

  it("returns Kubernetes pod logs using renderer selectors instead of an unavailable adapter", async () => {
    const s = await setup("kubernetes"); const logs = await call("zenith_query_logs", argsFor("zenith_query_logs"));
    expect(logs.ok).toBe(true); expect(logs.data.count).toBe(1); expect(logs.data.sources).toEqual(["kubernetes"]);
    expect(s.api.readNamespacedPodLog).toHaveBeenCalledOnce(); expect(s.sessionRequests[0]).toMatchObject({ connectionId: "platform-kubernetes", purpose: "observe" });
    expect(JSON.stringify(logs)).not.toContain(CANARY.password); expect(s.inside()).toBe(false);
  });

  it("serves Kubernetes events and traces through their own read grants with explicit provenance", async () => {
    const s = await setup("kubernetes");
    const events = await call("zenith_search_events", argsFor("zenith_search_events"));
    expect(events.ok).toBe(true); expect(events.data.telemetry.signal).toBe("event");
    expect(events.data.telemetry.scope.workspaceId).toBe(ids.ws); expect(Date.parse(events.data.telemetry.observedAt)).toBeGreaterThan(0);
    expect(s.api.listNamespacedEvent).toHaveBeenCalled();
    const traces = await call("zenith_search_traces", argsFor("zenith_search_traces"));
    expect(traces.ok).toBe(true); expect(traces.data.telemetry.signal).toBe("trace");
    // Every source states its provenance; one that could not answer says why.
    for (const source of [...events.data.telemetry.provenance, ...traces.data.telemetry.provenance]) {
      if (source.state === "unknown" || source.state === "inaccessible") expect(source.reason?.length).toBeGreaterThan(0);
    }
    expect(s.sessionRequests.every((req) => req.purpose === "observe")).toBe(true); expect(s.inside()).toBe(false);
  });

  it("returns an evidence-based investigation through the route without executing remediation", async () => {
    const s = await setup("kubernetes"); const result = await call("zenith_investigate_incident", argsFor("zenith_investigate_incident"));
    expect(result.ok).toBe(true); expect(result.data.investigated).toBe(true); expect(result.data.hypotheses.length).toBeGreaterThan(0);
    expect(result.data.evidence).toEqual(expect.arrayContaining([expect.objectContaining({ outcome: "fail" })]));
    expect(s.sessionRequests[0].grant.cap).toBe("incident.investigate"); expect(s.h.starts.deploy).toEqual([]); expect(s.h.starts.dayTwo).toEqual([]);
    expect(JSON.stringify(result)).not.toContain(CANARY.password);
  });

  it("uniformly refuses foreign or nonexistent targets before any credential session", async () => {
    const s = await setup("kubernetes");
    for (const workspaceId of [ids.foreignWs, "missing-workspace"]) for (const name of ["zenith_query_logs", "zenith_query_metrics", "zenith_investigate_incident"] as const) {
      const result = await call(name, { ...argsFor(name), target: { workspaceId, projectId: ids.foreignProject, environmentId: ids.foreignEnv } });
      expect(result.error.code).toBe("not_found");
    }
    expect(s.sessionRequests).toEqual([]); expect(s.api.listNamespacedPod).not.toHaveBeenCalled();
  });
});
