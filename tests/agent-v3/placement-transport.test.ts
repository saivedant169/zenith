/** Real Next route, MCP SDK transport, dispatcher, broker and solver. Only
 * bearer authority, product rows and connection verification are test fakes;
 * no live database, cloud session or workflow is used. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PROTOCOL_VERSION_META_KEY, CLIENT_CAPABILITIES_META_KEY } from "@modelcontextprotocol/server";
import { POST } from "@/app/api/agent/v3/mcp/route";
import { checkRequestOrigin } from "@/lib/agent-access/control/boundary";
import { AgentError } from "@/lib/agent-access/security";
import { toolDescriptor } from "@/lib/agent-access/v3/catalog";
import { UNTRUSTED_NOTE } from "@/lib/agent-access/v3/contract";
import { setMcpRuntimeForTests } from "@/lib/agent-access/v3/runtime";
import { placementReads } from "@/lib/placement/recommend";
import { tempDataDir } from "../_support/data-dir";
import { bearer, canaries, denyDecision, identity, ids, makeHarness, ORIGIN, target } from "./support";

tempDataDir("zenith-placement-mcp-transport-", { fast: true });
const name = "zenith_recommend_placement";
const descriptor = toolDescriptor(name)!;
const args = { target, constraints: { userRegions: ["india"] } };

beforeEach(() => vi.stubEnv("ZENITH_AGENT_ORIGIN", ORIGIN));
afterEach(() => { setMcpRuntimeForTests(null); vi.restoreAllMocks(); vi.unstubAllEnvs(); });

async function setup(scopes = ["read", "plan"]) {
  const h = await makeHarness();
  const verify = vi.fn(async () => ({ ...identity({ scopes }), id: ids.integration }));
  setMcpRuntimeForTests({
    auth: {
      checkOrigin: checkRequestOrigin, now: Date.now,
      authority: async () => ({ kind: "postgres", verify, touch: async () => {} }),
      oauth: {
        config: (origin) => ({ issuer: "https://issuer.test", resource: `${origin}/api/agent/v3/mcp` }),
        verify: async () => { throw new AgentError("invalid_token", "Test accepts linked credentials only.", 401); },
        bind: async () => identity(),
      },
    },
    ports: h.ports, requireEnabled: async () => {}, throttle: async () => {},
  });
  vi.spyOn(placementReads, "project").mockImplementation(h.ports.reads.project);
  vi.spyOn(placementReads, "environment").mockImplementation(async (ws, project, env) => {
    const row = await h.ports.reads.environment(ws, project, env);
    return row ? { ...row, createdAt: h.clock.now().toISOString(), policies: { approvalRequired: false, allowStatefulDeletion: false } } : null;
  });
  vi.spyOn(placementReads, "connections").mockImplementation(async (ws) => {
    h.trace.push("connections"); return [{ workspaceId: ws, provider: "aws", verified: true }];
  });
  return { h, verify };
}

describe.each(["2025-06-18", "2026-07-28"])("placement MCP HTTP %s", (protocol) => {
  function request(method: string, params: object = {}) {
    const modern = protocol === "2026-07-28";
    return new Request(`${ORIGIN}/api/agent/v3/mcp`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${bearer}`, "content-type": "application/json", accept: "application/json, text/event-stream",
        ...(modern ? { "mcp-protocol-version": protocol, "mcp-method": method, ...(method === "tools/call" ? { "mcp-name": name } : {}) } : {}),
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params: {
        ...params,
        ...(modern ? { _meta: { [PROTOCOL_VERSION_META_KEY]: protocol, [CLIENT_CAPABILITIES_META_KEY]: {} } } : {}),
      } }),
    });
  }

  it("advertises the strict placement contract and dispatches tools/call to its authorized handler", async () => {
    const { h, verify } = await setup();
    const before = structuredClone({ project: h.projects.get(ids.project), environment: h.environments.get(ids.env) });
    const list = await POST(request("tools/list"));
    expect(list.status).toBe(200);
    expect((await list.json()).result.tools).toContainEqual(expect.objectContaining({
      name, inputSchema: descriptor.inputSchema, annotations: descriptor.annotations,
      _meta: { zenith: expect.objectContaining({ access: "read", capability: "placement.solve", requiredScope: "plan",
        schemaVersion: 2, schemaDigest: descriptor.schemaDigest }) },
    }));
    expect(h.authorizeRead).not.toHaveBeenCalled();
    expect(placementReads.project).not.toHaveBeenCalled();
    const call = await POST(request("tools/call", { name, arguments: args }));
    expect(call.status).toBe(200);
    const body = await call.json();
    expect(body.result.isError).not.toBe(true);
    expect(body.result.structuredContent).toMatchObject({
      contractVersion: 3, tool: name, schemaVersion: 2, ok: true, note: UNTRUSTED_NOTE,
      data: { workspaceId: ids.ws, projectId: ids.project, environmentId: ids.env, connectedProviders: ["aws"], isEstimate: true },
      untrusted_data: { label: "untrusted_data", content: { result: { chosen: {
        requiresConnection: false, cost: { lines: expect.any(Array) },
      } }, explanation: expect.stringMatching(/estimate/i) } },
    });
    expect(h.authorizeRead).toHaveBeenCalledExactlyOnceWith({ capability: "placement.solve", scope: target }, h.principal.principal);
    expect(h.trace[0]).toBe("authorizeRead");
    expect(placementReads.connections).toHaveBeenCalledExactlyOnceWith(ids.ws);
    expect(verify).toHaveBeenCalledTimes(3); // list + call, then reauthentication inside the call
    const authorization = await h.authorizeRead.mock.results[0].value;
    expect(JSON.stringify(body)).not.toContain(authorization.grant);
    expect(JSON.stringify(body)).not.toContain("config-value-never-return");
    for (const canary of canaries) expect(JSON.stringify(body)).not.toContain(canary);
    expect({ project: h.projects.get(ids.project), environment: h.environments.get(ids.env) }).toEqual(before);
    expect(h.propose).not.toHaveBeenCalled(); expect(h.beginExecution).not.toHaveBeenCalled();
    expect(h.store.allEvents().filter((event) => event.type === "operation.proposed")).toEqual([]);
    expect(h.starts).toEqual({ deploy: [], dayTwo: [] }); expect(h.sessionRequests).toEqual([]);
  });

  it("omits placement without plan scope and refuses a call before product reads", async () => {
    const { h } = await setup(["read"]);
    const list = await POST(request("tools/list"));
    expect((await list.json()).result.tools).not.toContainEqual(expect.objectContaining({ name }));
    const body = await (await POST(request("tools/call", { name, arguments: args }))).json();
    // The scoped factory omits the handler entirely, so the SDK refuses it
    // as an unknown tool before Zenith dispatch or broker resolution.
    expect(body).toMatchObject({ jsonrpc: "2.0", id: 1, error: { code: -32602, message: `Tool ${name} not found` } });
    expect(body).not.toHaveProperty("result");
    expect(h.authorizeRead).not.toHaveBeenCalled();
    expect(placementReads.project).not.toHaveBeenCalled(); expect(placementReads.connections).not.toHaveBeenCalled();
  });

  it("enforces nested strict schemas and bounded constraints before authorization", async () => {
    const { h } = await setup();
    for (const constraints of [{ approved: true }, { usage: { approved: true } }, { budgetUsdMonthly: -1 },
      { userRegions: Array.from({ length: 33 }, () => "india") }, { componentProviders: { web: "$(shell)" } }]) {
      const body = await (await POST(request("tools/call", { name, arguments: { target, constraints } }))).json();
      expect(body.result.isError).toBe(true);
      expect(body.result.structuredContent).toMatchObject({ ok: false, note: UNTRUSTED_NOTE, error: { code: "invalid_input" } });
    }
    expect(h.authorizeRead).not.toHaveBeenCalled(); expect(placementReads.project).not.toHaveBeenCalled();
  });

  it("policy denial reaches the broker but never the product or connection store", async () => {
    const { h } = await setup(); h.setDecision(denyDecision);
    const body = await (await POST(request("tools/call", { name, arguments: args }))).json();
    expect(body.result.structuredContent).toMatchObject({ ok: false, error: { code: "policy_denied" } });
    expect(h.authorizeRead).toHaveBeenCalledTimes(1); expect(h.trace).toEqual(["authorizeRead"]);
    expect(placementReads.project).not.toHaveBeenCalled(); expect(placementReads.connections).not.toHaveBeenCalled();
  });
});
