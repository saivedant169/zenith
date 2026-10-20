/** Real Request/Response + MCP SDK transport, injected auth/broker ports.
 * This proves metadata and schema-validator behavior of the installed SDK. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";
import { tempDataDir } from "../_support/data-dir";
import { argsFor, bearer, canaries, identity, ids, makeHarness, ORIGIN } from "./support";
import type { McpRuntime } from "@/lib/agent-access/v3/runtime";
import type { AuthDeps } from "@/lib/agent-access/v3/auth";
import { TOOL_CATALOG, catalogFor } from "@/lib/agent-access/v3/catalog";
import { TOOL_NAMES, UNTRUSTED_NOTE } from "@/lib/agent-access/v3/contract";
import { PROTOCOL_VERSION_META_KEY, CLIENT_CAPABILITIES_META_KEY } from "@modelcontextprotocol/server";

tempDataDir("zenith-mcp-v3-route-", { fast: true });
const updateSession = vi.hoisted(() => vi.fn(async () => new NextResponse(null, { status: 599 })));
vi.mock("@/lib/supabase/middleware", () => ({ updateSession }));
const { checkRequestOrigin } = await import("@/lib/agent-access/control/boundary");
const { AgentError } = await import("@/lib/agent-access/security");
const { setMcpRuntimeForTests } = await import("@/lib/agent-access/v3/runtime");
const route = await import("@/app/api/agent/v3/mcp/route");
const { middleware } = await import("@/middleware");

function request(method: string, params?: object, headers: Record<string, string> = {}, origin = ORIGIN): Request {
  return new Request(`${origin}/api/agent/v3/mcp`, { method: "POST", headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json", accept: "application/json, text/event-stream", ...headers },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, ...(params ? { params } : {}) }) });
}
async function setup(scopes = ["read", "plan", "logs", "write"]) {
  const h = await makeHarness(); let revoked = false;
  const verify = vi.fn(async () => {
    if (revoked) throw new AgentError("unauthorized", "The connection was revoked.", 401);
    const who = identity({ scopes });
    return { ...who, id: who.integrationId };
  });
  const deps: AuthDeps = { checkOrigin: checkRequestOrigin, now: Date.now,
    authority: async () => ({ kind: "postgres", verify, touch: async () => {} }),
    oauth: { config: (origin) => ({ issuer: "https://issuer.test", resource: `${origin}/api/agent/v3/mcp` }),
      verify: async () => { throw new AgentError("invalid_token", "Token was not issued for this resource.", 401); }, bind: async () => identity() } };
  const runtime: McpRuntime = { auth: deps, ports: h.ports, requireEnabled: vi.fn(async () => {}), throttle: vi.fn(async () => {}) };
  setMcpRuntimeForTests(runtime);
  return { h, runtime, verify, revoke: () => { revoked = true; } };
}
beforeEach(() => { vi.stubEnv("ZENITH_AGENT_ORIGIN", ORIGIN); vi.stubEnv("VERCEL", undefined); vi.stubEnv("ZENITH_SERVERLESS", undefined); updateSession.mockClear(); });
afterEach(() => { setMcpRuntimeForTests(null); vi.unstubAllEnvs(); });

describe("MCP v3 HTTP", () => {
  it("initializes with v3 server identity and instructions", async () => {
    await setup();
    const res = await route.POST(request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } }));
    expect(res.status).toBe(200);
    expect((await res.json()).result).toMatchObject({ serverInfo: { name: "zenith-control-v3", version: "3.0.0-dev.1" }, instructions: expect.stringContaining("Only a person can approve") });
    expect(res.headers.get("cache-control")).toBe("no-store");
  });
  it("tools/list emits exact schemas, hints and _meta.zenith", async () => {
    await setup(); const res = await route.POST(request("tools/list")); expect(res.status).toBe(200);
    const body = await res.json(); expect(body.result.tools).toHaveLength(TOOL_NAMES.length);
    for (const tool of TOOL_CATALOG) expect(body.result.tools).toContainEqual(expect.objectContaining({ name: tool.name, inputSchema: tool.inputSchema,
      annotations: tool.annotations, _meta: { zenith: expect.objectContaining({ contractVersion: 3, schemaVersion: tool.schemaVersion, schemaDigest: tool.schemaDigest }) } }));
    const events = body.result.tools.find((tool: { name: string }) => tool.name === "zenith_get_operation_events");
    expect(events).toMatchObject({ title: "Get operation events", _meta: { zenith: { access: "read", requiredScope: "read" } } });
    expect(events.inputSchema.required).toEqual(["workspaceId", "operationId"]);
  });
  it("modern protocol requests also use JSON and the same catalog/strict tools", async () => {
    const { h } = await setup();
    // SDK 2.0 exports the legacy version as LATEST_PROTOCOL_VERSION; its
    // modern request metadata negotiates the separate 2026 wire protocol.
    const meta = { [PROTOCOL_VERSION_META_KEY]: "2026-07-28", [CLIENT_CAPABILITIES_META_KEY]: {} };
    const list = await route.POST(request("tools/list", { _meta: meta }, { "mcp-protocol-version": "2026-07-28", "mcp-method": "tools/list" }));
    expect(list.status, await list.clone().text()).toBe(200); expect(list.headers.get("content-type")).toContain("application/json");
    const listedTools = (await list.json()).result.tools;
    expect(listedTools).toHaveLength(TOOL_NAMES.length);
    expect(listedTools.map((tool: { name: string }) => tool.name)).toContain("zenith_get_operation_events");
    const call = await route.POST(request("tools/call", { _meta: meta, name: "zenith_get_topology", arguments: argsFor("zenith_get_topology") }, { "mcp-protocol-version": "2026-07-28", "mcp-method": "tools/call", "mcp-name": "zenith_get_topology" }));
    expect(call.status).toBe(200); expect((await call.json()).result.structuredContent.ok).toBe(true);
    expect(h.authorizeRead).toHaveBeenCalledTimes(1);
  });
  it("HTTP validation refusals redact secret-shaped external member names", async () => {
    await setup();
    for (const canary of canaries) {
      const body = await (await route.POST(request("tools/call", { name: "zenith_get_topology", arguments: { ...argsFor("zenith_get_topology"), [canary]: true } }))).json();
      expect(body.result.structuredContent.error.code).toBe("invalid_input");
      expect(JSON.stringify(body)).not.toContain(canary); expect(body.result.structuredContent.note).toBe(UNTRUSTED_NOTE);
    }
  });
  it.each([["read"], ["read", "plan"], ["read", "logs"], ["read", "write"]])("filters catalog for scopes %j", async (...scopes: string[]) => {
    await setup(scopes); const body = await (await route.POST(request("tools/list"))).json();
    expect(body.result.tools.map((t: { name: string }) => t.name)).toEqual(catalogFor(scopes).map((t) => t.name));
  });
  it("calls a valid tool through strict zod and the broker", async () => {
    const { h, verify } = await setup();
    const res = await route.POST(request("tools/call", { name: "zenith_get_topology", arguments: argsFor("zenith_get_topology") }));
    const body = await res.json(); expect(body.result.isError).not.toBe(true);
    expect(body.result.structuredContent).toMatchObject({ contractVersion: 3, ok: true, tool: "zenith_get_topology", untrusted_data: { label: "untrusted_data" } });
    expect(h.authorizeRead).toHaveBeenCalledTimes(1); expect(verify).toHaveBeenCalledTimes(2);
  });
  it.each(TOOL_NAMES)("%s rejects an extra approval over HTTP", async (name) => {
    const { h } = await setup();
    for (const key of ["approved", "approval", "approvedBy"]) {
      const body = await (await route.POST(request("tools/call", { name, arguments: { ...argsFor(name), [key]: true } }))).json();
      expect(body.result.isError).toBe(true);
      expect(body.result.structuredContent).toMatchObject({ ok: false, note: UNTRUSTED_NOTE, error: { code: "invalid_input" } });
    }
    expect(h.propose).not.toHaveBeenCalled(); expect(h.beginExecution).not.toHaveBeenCalled();
    expect(h.starts.deploy).toHaveLength(0); expect(h.starts.dayTwo).toHaveLength(0);
  });
  it.each([{}, { cookie: "session=browser-only" }] as Record<string, string>[])("requires a bearer even with cookie headers %j", async (extra) => {
    const { verify } = await setup(); const req = request("tools/list", undefined, extra); req.headers.delete("authorization");
    const res = await route.POST(req); expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toBe(`Bearer resource_metadata="${ORIGIN}/.well-known/oauth-protected-resource/api/agent/v3/mcp", scope="zenith:read"`);
    expect((await res.json()).error.code).toBe("authentication_required"); expect(verify).not.toHaveBeenCalled();
  });
  it("revocation takes effect on the next request", async () => {
    const s = await setup(); expect((await route.POST(request("tools/list"))).status).toBe(200); s.revoke();
    const res = await route.POST(request("tools/list")); expect(res.status).toBe(401); expect((await res.json()).error.code).toBe("unauthorized");
  });
  it("reverifies authority inside a call and refuses mid-request revocation", async () => {
    const { h, verify } = await setup(); verify.mockImplementationOnce(async () => ({ ...identity(), id: ids.integration }))
      .mockRejectedValueOnce(new AgentError("unauthorized", "Revoked.", 401));
    const body = await (await route.POST(request("tools/call", { name: "zenith_get_topology", arguments: argsFor("zenith_get_topology") }))).json();
    expect(body.result.structuredContent.error.code).toBe("unauthorized"); expect(h.authorizeRead).not.toHaveBeenCalled();
  });
  it("refuses an untrusted host or Origin before touching authority", async () => {
    const { verify } = await setup();
    expect((await route.POST(request("tools/list", undefined, {}, "http://evil.test"))).status).toBe(403);
    expect((await route.POST(request("tools/list", undefined, { origin: "http://evil.test" }))).status).toBe(403);
    expect(verify).not.toHaveBeenCalled();
  });
  it("honors kill switch and rate limiting", async () => {
    const { runtime } = await setup(); runtime.throttle = vi.fn(async () => { throw new AgentError("rate_limited", "Retry later.", 429); });
    expect((await route.POST(request("tools/list"))).status).toBe(429);
    runtime.requireEnabled = vi.fn(async () => { throw new AgentError("control_disabled", "Disabled.", 503); });
    expect((await route.POST(request("tools/list"))).status).toBe(503);
  });
  it("does not accept a v2 OAuth token at v3", async () => {
    const { h } = await setup();
    const res = await route.POST(request("tools/list", undefined, { authorization: "Bearer v2-audience-token", "x-zenith-workspace": ids.ws }));
    expect(res.status).toBe(401); expect((await res.json()).error.code).toBe("invalid_token"); expect(h.authorizeRead).not.toHaveBeenCalled();
  });
  it("publishes protected-resource metadata at the bypassed exact path", async () => {
    const { runtime, verify } = await setup();
    const res = await route.GET(new Request(`${ORIGIN}/api/agent/v3/mcp?metadata=oauth-protected-resource`));
    expect(res.status).toBe(200); expect(await res.json()).toMatchObject({ resource: `${ORIGIN}/api/agent/v3/mcp`, authorization_servers: ["https://issuer.test"], scopes_supported: expect.arrayContaining(["zenith:read", "zenith:write"]), bearer_methods_supported: ["header"] });
    expect(verify).not.toHaveBeenCalled(); expect(runtime.requireEnabled).not.toHaveBeenCalled();
    runtime.auth.oauth.config = () => undefined;
    expect((await route.GET(new Request(`${ORIGIN}/api/agent/v3/mcp?metadata=oauth-protected-resource`))).status).toBe(503);
  });
  it("bounds POST bodies before MCP parses them", async () => {
    await setup(); const req = request("tools/list");
    const res = await route.POST(new Request(req.url, { method: "POST", headers: req.headers, body: "x".repeat(524289) }));
    expect(res.status).toBe(413); expect((await res.json()).error.code).toBe("body_too_large");
  });
  it("exports the serverless route contract", () => {
    expect(route.runtime).toBe("nodejs"); expect(route.dynamic).toBe("force-dynamic"); expect(route.maxDuration).toBe(60);
    expect(route.GET).toBe(route.POST); expect(route.DELETE).toBe(route.POST);
  });
});
it("middleware bypasses v3 exactly; the approval page remains cookie-gated", async () => {
  expect((await middleware(new NextRequest(`${ORIGIN}/api/agent/v3/mcp?metadata=oauth-protected-resource`))).status).toBe(200);
  expect(updateSession).not.toHaveBeenCalled();
  for (const path of ["/api/agent/v3/mcp/extra", "/api/agent/v3/mcp/", "/integrations/operations/op-a"]) expect((await middleware(new NextRequest(`${ORIGIN}${path}`))).status).toBe(599);
  expect(updateSession).toHaveBeenCalledTimes(3);
});
