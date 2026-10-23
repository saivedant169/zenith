/** In-process routes and CLI, real plugin/agent SQL and PgCredentialAuthority.
 * Browser identity, membership and container execution are explicit models.
 * Default Supabase AAL2 verification is exercised with a modeled provider. */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { createServer as createHttpsServer, request as httpsRequest } from "node:https";
import type { AddressInfo } from "node:net";
import { openLaunchPlatform, seedLaunchParent } from "./launch-platform";
import { archive, launchFixture, FakeContainerRuntime } from "./launcher-support";
import { signManifest } from "./support";
import type { PluginDeps } from "@/lib/plugins/service";

const state = vi.hoisted(() => ({
  deps: undefined as PluginDeps | undefined, authority: undefined as Awaited<ReturnType<typeof openLaunchPlatform>>["authority"] | undefined,
  member: true, role: "admin", aal: "aal2", claimsError: false, providerDown: false, session: "session-test",
  claimsSubject: "bob", liveIdentity: true, getClaims: vi.fn(), getUser: vi.fn(),
}));
vi.mock("@/lib/server/request", () => ({ route: (fn: unknown) => fn,
  currentRequest: () => ({ user: { id: "bob" }, workspace: { id: state.deps?.sql ? currentWorkspace : "missing" } }) }));
// A mutable workspace is read only after fixtures have been initialized.
let currentWorkspace = "";
vi.mock("@/lib/hosted/access/identity", () => ({ verifyRequestIdentity: async () => {
  if (!state.liveIdentity) throw new Error("modeled identity outage");
  return { subject: "bob", emailVerified: true, email: "bob@example.test", sessionId: "session-test" };
} }));
vi.mock("@/lib/db/store", () => ({ db: () => ({ members: state.member ? [{ id: "bob", workspaceId: currentWorkspace, role: state.role }] : [] }) }));
vi.mock("@/lib/agent-access/control/runtime", () => ({ requireControl: () => {}, requireControlAsync: async () => {},
  inAgentScope: async (who: { workspaceId: string; subject: string }, fn: () => Promise<unknown>) => {
    if (!state.member || who.workspaceId !== currentWorkspace || who.subject !== "bob") throw new PluginError("plugin_forbidden", "Modeled membership denied.");
    return fn();
  } }));
vi.mock("@/lib/supabase/env", () => ({ isSupabaseConfigured: () => true, SUPABASE_URL: "https://identity.example.test", SUPABASE_PUBLIC_KEY: "" }));
vi.mock("@supabase/ssr", () => ({ createServerClient: () => ({ auth: { getClaims: state.getClaims, getUser: state.getUser } }) }));
vi.mock("@/lib/auth/mfa-policy", () => ({ workspaceMfaControl: async () => ({ privilegedActionsRequireAal2: true, requireForAllMutations: false, maxAgeSeconds: null }) }));
vi.mock("@/lib/agent-access/authority", () => ({
  requireCredentialAuthority: async () => { if (!state.authority) throw new Error("no authority"); return state.authority; },
  credentialAuthority: () => state.authority,
}));
vi.mock("@/lib/plugins/runtime", async (original) => ({ ...await original<typeof import("@/lib/plugins/runtime")>(),
  defaultPluginDeps: async () => { if (!state.deps) throw new Error("no plugin authority"); return state.deps; } }));

import * as repos from "@/lib/controlplane/db/repos";
import { defaultAuth } from "@/lib/agent-access/v3/auth-default";
import { authenticateMcp } from "@/lib/agent-access/v3/auth";
import { assertInGrant, requirePluginTool } from "@/lib/agent-access/v3/principal";
import { revokeToken, type RevokeDeps } from "@/lib/agent-access/oauth/revoke";
import { checkRequestOrigin } from "@/lib/agent-access/control/boundary";
import { liveParentCredential } from "@/lib/plugins/runtime";
import { PluginError } from "@/lib/plugins/errors";
import { issueLauncherToken, registerPlugin, reviewPlugin, resolveLauncherIdentity, revokePluginTokenByPossession } from "@/lib/plugins/service";
import { pluginsLaunchTokenIssue, pluginsReview, pluginsRegister, pluginsRevoke, pluginsTokenRevoke } from "@/lib/plugins/http";
import { POST as launchCheck } from "@/app/api/integrations/plugins/launch/check/route";
import { POST as launchIssue } from "@/app/api/integrations/plugins/launch/tokens/route";
import { GET as catalog } from "@/app/api/integrations/plugins/catalog/route";
import { runCli, HELP } from "@/cli/main";
import { tokenDigest } from "@/cli/plugins/authority";
import { handleMcp } from "@/lib/agent-access/v3/server";
import type { McpRuntime } from "@/lib/agent-access/v3/runtime";
import { DockerRuntime } from "@/cli/plugins/runtime";
import { signedPortion } from "@/lib/plugins/manifest";

let platform: Awaited<ReturnType<typeof openLaunchPlatform>>;
let f: ReturnType<typeof launchFixture>;
let parent: Awaited<ReturnType<typeof seedLaunchParent>>;
let registration: repos.plugins.PluginRegistration;
let directory: string;
let manifestPath: string;
const workspaces: string[] = [];
// The Docker join reassigns this to its reachable HTTPS origin and restores it.
let origin = "https://zenith.example.test";
const routeContext = { params: Promise.resolve({}) };
const body = () => ({ registrationId: registration.id, manifestDigest: registration.manifestDigest,
  credentialId: parent.id, projectIds: ["proj-a"], environmentIds: ["env-a"], minutes: 60 });
const browserRequest = (path: string, data: unknown, headers: Record<string, string> = {}) => new NextRequest(`${origin}${path}`, {
  method: "POST", headers: { origin, "content-type": "application/json", ...headers }, body: JSON.stringify(data) });
const binding = (token: string) => ({ registrationId: registration.id, workspaceId: currentWorkspace,
  manifestDigest: registration.manifestDigest, credentialDigest: tokenDigest(token), audience: `${origin}/api/agent/v3/mcp` });
const checkRequest = (token: string, over: object = {}) => browserRequest("/api/integrations/plugins/launch/check",
  { ...binding(token), ...over }, { authorization: `Bearer ${token}` });
const mcpRequest = (token: string, project = "proj-a") => new Request(`${origin}/api/agent/v3/mcp`, {
  headers: { authorization: `Bearer ${token}`, "x-zenith-workspace": currentWorkspace, "x-zenith-project": project } });
async function issued() {
  const response = await launchIssue(browserRequest("/api/integrations/plugins/launch/tokens", body()), routeContext);
  expect(response.status).toBe(201);
  return await response.json() as { token: string; grantId: string; expiresAt: string; tools: string[] };
}
const revokeDeps = (): RevokeDeps => ({ checkOrigin: checkRequestOrigin, limit: async () => {}, authority: async () => platform.authority,
  plugins: { revokeByToken: (token) => revokePluginTokenByPossession(state.deps!, token) },
  oauth: { config: () => undefined, verify: async () => { throw new Error("no OAuth"); }, revokeGrant: async () => false }, resources: () => [] });
const revokeRequest = (token: string) => new Request(`${origin}/api/agent/oauth/revoke`, { method: "POST",
  headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ token }) });
const stdin = (text: string) => (async function* () { yield text; })();

beforeAll(async () => { platform = await openLaunchPlatform(); directory = await mkdtemp(join(tmpdir(), "zenith-plugin-join-")); manifestPath = join(directory, "manifest.json"); });
afterAll(async () => {
  if (platform) {
    for (const workspaceId of workspaces) await platform.db.tx(async (sql) => {
      for (const table of ["platform.plugin_events", "platform.plugin_grants", "platform.plugin_registrations", "agent.agent_credentials"]) {
        await sql.query(`delete from ${table} where workspace_id=$1`, [workspaceId]);
      }
    });
    await platform.db.close();
  }
  if (directory) await rm(directory, { recursive: true, force: true });
});
beforeEach(async () => {
  vi.stubEnv("ZENITH_AGENT_ORIGIN", origin);
  state.member = true; state.role = "admin"; state.aal = "aal2"; state.claimsError = false;
  state.providerDown = false; state.claimsSubject = "bob"; state.session = "session-test"; state.liveIdentity = true;
  state.getUser.mockReset().mockResolvedValue({ error: null, data: { user: { id: "bob", email_confirmed_at: new Date().toISOString(), factors: [{ factor_type: "totp", status: "verified" }] } } });
  state.getClaims.mockReset().mockImplementation(async () => {
    if (state.providerDown) throw new Error("modeled provider outage");
    return { error: state.claimsError ? new Error("invalid claims") : null,
      data: { claims: { sub: state.claimsSubject, session_id: state.session, aal: state.aal, exp: Date.now() / 1000 + 60 } } };
  });
  f = launchFixture(); currentWorkspace = `launch-${Math.random().toString(36).slice(2)}`;
  workspaces.push(currentWorkspace);
  parent = await seedLaunchParent(platform.db, currentWorkspace); state.authority = platform.authority;
  state.deps = { sql: platform.db, parents: liveParentCredential, publishers: () => f.publisher.publishers,
    assertLaunchScope: async (identity) => {
      if (!state.member || !["admin", "editor"].includes(state.role) || identity.projectIds.some((p) => !["proj-a", "proj-b"].includes(p)) ||
          identity.environmentIds?.some((e) => e === "env-a" ? !identity.projectIds.includes("proj-a") : e === "env-b" ? !identity.projectIds.includes("proj-b") : true)) {
        throw new PluginError("plugin_forbidden", "Modeled live membership or target ownership refused.");
      }
    } };
  const pending = await registerPlugin(state.deps, { workspaceId: currentWorkspace, manifest: f.manifest, requestedBy: "bob" });
  registration = await reviewPlugin(state.deps, { workspaceId: currentWorkspace, registrationId: pending.id, manifestDigest: pending.manifestDigest,
    decision: "approve", tools: ["zenith_get_topology"], scopes: ["read"], reviewedBy: "bob" });
  await writeFile(manifestPath, JSON.stringify(f.manifest));
});
afterEach(() => vi.unstubAllEnvs());

describe("authoritative launcher issuance and authentication", () => {
  it("routes a browser-approved child to the live parent with narrowed tools and targets, storing only a hash", async () => {
    expect(pluginsLaunchTokenIssue).toBe(launchIssue);
    const child = await issued(); expect(child.token).toMatch(/^za_[A-Za-z0-9_-]{43}$/);
    expect(child.token).not.toBe(parent.token); expect(child.tools).toEqual(["zenith_get_topology"]);
    const rows = await platform.db.query("select token_hash,project_ids,environment_ids,scopes from platform.plugin_grants where id=$1", [child.grantId]);
    expect(rows).toEqual([{ token_hash: tokenDigest(child.token), project_ids: ["proj-a"], environment_ids: ["env-a"], scopes: ["read"] }]);
    await expect(platform.authority.verify(`Bearer ${child.token}`)).rejects.toMatchObject({ code: "unauthorized" });
    expect((await platform.authority.verify(`Bearer ${parent.token}`)).id).toBe(parent.id);
    expect((await authenticateMcp(mcpRequest(parent.token), defaultAuth())).principal.via).toBe("credential");
    const response = await launchCheck(checkRequest(child.token)); expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ...binding(child.token), credentialKind: "plugin_scoped_za", tools: child.tools, projectIds: ["proj-a"], environmentIds: ["env-a"] });
    const { principal } = await authenticateMcp(mcpRequest(child.token), defaultAuth());
    expect(principal.via).toBe("plugin"); expect(principal.identity.integrationId).toBe(parent.id);
    expect(() => requirePluginTool(principal, "zenith_query_logs")).toThrow();
    expect(() => assertInGrant(principal, { workspaceId: currentWorkspace, projectId: "proj-b" })).toThrow();
    await expect(authenticateMcp(mcpRequest(child.token, "proj-b"), defaultAuth())).rejects.toMatchObject({ code: "scope_denied" });
    // Discovery through the real SDK transport must preserve the child binding.
    const runtime: McpRuntime = { auth: defaultAuth(), ports: {} as McpRuntime["ports"], requireEnabled: async () => {}, throttle: async () => {} };
    const discovery = await handleMcp(new Request(`${origin}/api/agent/v3/mcp`, { method: "POST", headers: {
      authorization: `Bearer ${child.token}`, "content-type": "application/json", accept: "application/json, text/event-stream",
    }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) }), runtime);
    expect(discovery.status).toBe(200);
    expect((await discovery.json()).result.tools.map((tool: { name: string }) => tool.name)).toEqual(["zenith_get_topology"]);
  });
  it.each(["bearer", "csrf", "member", "viewer", "unknown-role", "aal1", "wrong-subject", "wrong-session", "claims-error", "provider-down"])("refuses %s consent before any grant is created", async (reason) => {
    const headers: Record<string, string> = {};
    if (reason === "bearer") headers.authorization = `Bearer ${parent.token}`;
    if (reason === "csrf") headers.origin = "https://foreign.example.test";
    if (reason === "member") state.member = false;
    if (reason === "viewer") state.role = "viewer";
    if (reason === "unknown-role") state.role = "unknown";
    if (reason === "aal1") state.aal = "aal1";
    if (reason === "wrong-subject") state.claimsSubject = "mallory";
    if (reason === "wrong-session") state.session = "another-session";
    if (reason === "claims-error") state.claimsError = true;
    if (reason === "provider-down") state.providerDown = true;
    const response = await launchIssue(browserRequest("/api/integrations/plugins/launch/tokens", body(), headers), routeContext);
    expect(response.status).toBe(["claims-error", "provider-down"].includes(reason) ? 503 : 403);
    expect(await repos.plugins.listGrants(platform.db, currentWorkspace)).toEqual([]);
  });
  it("requires privileged consent for registration and approval too, while allowing withdrawal without step-up", async () => {
    state.aal = "aal1";
    for (const handler of [pluginsRegister, pluginsReview]) {
      expect((await handler(browserRequest("/api/integrations/plugins", { manifest: f.manifest }), routeContext)).status).toBe(403);
    }
    expect((await pluginsRevoke(browserRequest("/api/integrations/plugins/revoke", { registrationId: registration.id, reason: "withdraw trust" }), routeContext)).status).toBe(200);
  });
  it.each([
    { over: { projectIds: [] }, status: 400 }, { over: { environmentIds: [] }, status: 400 },
    { over: { projectIds: ["foreign"] }, status: 403 }, { over: { environmentIds: ["env-b"] }, status: 403 },
    { over: { manifestDigest: "0".repeat(64) }, status: 409 }, { over: { minutes: 1441 }, status: 400 },
    { over: { credentialId: "foreign-credential" }, status: 403 }, { over: { tools: ["zenith_query_logs"] }, status: 400 },
  ])("refuses invalid or unapproved issuance $over", async ({ over, status }) => {
    expect((await launchIssue(browserRequest("/api/integrations/plugins/launch/tokens", { ...body(), ...over }), routeContext)).status).toBe(status);
    expect(await repos.plugins.listGrants(platform.db, currentWorkspace)).toEqual([]);
  });
  it("refuses a missing live scope seam and a removed signing publisher", async () => {
    await expect(issueLauncherToken({ ...state.deps!, assertLaunchScope: undefined }, { ...body(), workspaceId: currentWorkspace, subject: "bob", audience: `${origin}/api/agent/v3/mcp` })).rejects.toMatchObject({ code: "plugin_unavailable" });
    const child = await issued(); state.deps!.publishers = () => new Map();
    expect((await launchCheck(checkRequest(child.token))).status).toBe(403);
  });
  it("checks parent expiry and narrowing live, and refuses malformed/cookie-only check requests", async () => {
    const child = await issued();
    await platform.db.query("update agent.agent_credentials set issued_at=$1 where id=$2", [new Date(Date.now() + 600_000).toISOString(), parent.id]);
    expect((await launchCheck(checkRequest(child.token))).status).toBe(401);
    await platform.db.query("update agent.agent_credentials set issued_at=$1 where id=$2", [new Date().toISOString(), parent.id]);
    await platform.db.query("update agent.agent_credentials set environment_ids=$1::text::jsonb where id=$2", [JSON.stringify(["env-b"]), parent.id]);
    expect((await launchCheck(checkRequest(child.token))).status).toBe(401);
    await platform.db.query("update agent.agent_credentials set expires_at=$1 where id=$2", [new Date(Date.now() - 1000).toISOString(), parent.id]);
    expect((await launchCheck(checkRequest(child.token))).status).toBe(401);
    expect((await launchCheck(browserRequest("/api/integrations/plugins/launch/check", binding(child.token), { cookie: "session=untrusted" }))).status).toBe(401);
    expect((await launchCheck(checkRequest(child.token, { scopes: ["write"] }))).status).toBe(401);
  });
  it("fails closed on a live scope/store outage before launch and on MCP without a native credential fallback", async () => {
    const child = await issued();
    state.deps!.assertLaunchScope = async () => { throw new Error("modeled store outage"); };
    expect((await launchCheck(checkRequest(child.token))).status).toBe(503);
    await expect(authenticateMcp(mcpRequest(child.token), defaultAuth())).rejects.toThrow("modeled store outage");
  });
  it.each(["registrationId", "workspaceId", "manifestDigest", "credentialDigest", "audience"])("refuses mismatched %s and never accepts a parent as a launcher", async (key) => {
    const child = await issued();
    expect((await launchCheck(checkRequest(child.token, { [key]: key.endsWith("Digest") ? "0".repeat(64) : key === "audience" ? "https://foreign.example.test/api/agent/v3/mcp" : "foreign" }))).status).toBe(401);
    expect((await launchCheck(checkRequest(parent.token))).status).toBe(401);
  });
  it.each(["parent", "grant", "plugin", "expired", "member"])("invalidates a child after %s withdrawal, without a broader authority fallback", async (reason) => {
    const child = await issued();
    if (reason === "parent") await platform.authority.revokeCredential("bob", currentWorkspace, parent.id);
    if (reason === "grant") expect((await pluginsTokenRevoke(browserRequest("/api/integrations/plugins/tokens/revoke", { grantId: child.grantId }), routeContext)).status).toBe(200);
    if (reason === "plugin") expect((await pluginsRevoke(browserRequest("/api/integrations/plugins/revoke", { registrationId: registration.id, reason: "withdraw" }), routeContext)).status).toBe(200);
    if (reason === "expired") await platform.db.query("update platform.plugin_grants set expires_at=clock_timestamp()-interval '1 second' where id=$1", [child.grantId]);
    if (reason === "member") state.member = false;
    expect((await launchCheck(checkRequest(child.token))).status).toBeGreaterThanOrEqual(400);
    await expect(resolveLauncherIdentity(state.deps!, child.token, `${origin}/api/agent/v3/mcp`)).rejects.toThrow();
    await expect(authenticateMcp(mcpRequest(child.token), defaultAuth())).rejects.toThrow();
  });
});

describe("main CLI dispatch and real revocation joining the supervisor", () => {
  const args = (action: string) => ["plugin", action, "--url", origin, "--workspace", currentWorkspace, "--json"];
  const publisherEnv = () => {
    const keys = f.publisher.publishers.get("acme")!;
    return { ZENITH_PLUGIN_TRUSTED_PUBLISHERS: JSON.stringify({ acme: keys.map((key) => ({ keyId: key.keyId,
      publicKey: key.key.export({ format: "der", type: "spki" }).subarray(-32).toString("base64") })) }), ZENITH_TOKEN: parent.token };
  };
  it("exposes plugin help through main and validates install for browser consent without submitting a privileged write", async () => {
    expect(HELP).toContain("plugin install"); const stdout = vi.fn(); const fetcher = vi.fn<typeof fetch>();
    expect(await runCli(["plugin", "--help"], { stdout })).toBe(0); expect(stdout.mock.calls.join()).toContain("plugin revoke");
    stdout.mockClear();
    expect(await runCli([...args("install"), "--manifest", manifestPath, "--digest", registration.manifestDigest], { env: publisherEnv(), stdout, fetch: fetcher })).toBe(3);
    expect(JSON.parse(stdout.mock.calls[0][0])).toMatchObject({ installed: false, browserUrl: `${origin}/platform/plugins`, manifestDigest: registration.manifestDigest });
    expect(fetcher).not.toHaveBeenCalled();
    const stderr = vi.fn();
    expect(await runCli([...args("install"), "--manifest", manifestPath, "--digest", "0".repeat(64)], { env: publisherEnv(), stderr, fetch: fetcher })).toBe(5);
    expect(await runCli([...args("install"), "--manifest", manifestPath, "--digest", registration.manifestDigest], { env: {}, stderr, fetch: fetcher })).toBe(3);
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("runs the approved child via main; RFC revocation invalidates the server token and kills its running sandbox", async () => {
    const child = await issued(); const container = new FakeContainerRuntime(); const stdout = vi.fn(); const stderr = vi.fn();
    const fetcher = vi.fn<typeof fetch>(async (input, init) => {
      const url = String(input); if (url === f.manifest.artifact.url) return new Response(new Uint8Array(f.bytes));
      if (url.endsWith("/launch/check")) return launchCheck(new Request(input, init));
      if (url.endsWith("/oauth/revoke")) return revokeToken(new Request(input, init), revokeDeps());
      throw new Error("unexpected modeled request");
    });
    const runtime = { env: publisherEnv(), fetch: fetcher, stdout, stderr, pluginRuntime: container, stdin: stdin(child.token) };
    const running = runCli([...args("run"), "--manifest", manifestPath, "--digest", registration.manifestDigest,
      "--registration", registration.id, "--image", f.input.image, "--server", "zenith"], runtime);
    await vi.waitFor(() => expect(container.specs).toHaveLength(1), { timeout: 5000 });
    expect(container.specs[0].bootstrap.token).toBe(child.token);
    expect(await runCli([...args("revoke"), "--registration", registration.id, "--digest", registration.manifestDigest, "--token-stdin"],
      { ...runtime, stdin: stdin(child.token) })).toBe(0);
    expect(await running).toBe(3); expect(container.stops).toBe(1);
    expect((await launchCheck(checkRequest(child.token))).status).toBe(401);
    expect((await platform.authority.verify(`Bearer ${parent.token}`)).id).toBe(parent.id);
    expect((await revokeToken(revokeRequest(child.token), revokeDeps())).status).toBe(200);
    expect(stdout.mock.calls.join() + stderr.mock.calls.join()).not.toContain(child.token);
    expect(fetcher.mock.calls.some(([, init]) => new Headers(init?.headers).get("authorization") === `Bearer ${parent.token}`)).toBe(false);
  });
  it("retains the launcher archive allowance above the generic CLI JSON response limit", async () => {
    const bytes = archive([{ name: "main.mjs", content: `/*${randomBytes(2 * 1024 * 1024).toString("base64")}*/setInterval(() => {}, 1000);` }]);
    expect(bytes.byteLength).toBeGreaterThan(1024 * 1024);
    f = launchFixture(bytes); f.manifest = signManifest({ ...f.manifest, version: "1.0.1" }, f.publisher.privateKey);
    const pending = await registerPlugin(state.deps!, { workspaceId: currentWorkspace, manifest: f.manifest, requestedBy: "bob" });
    registration = await reviewPlugin(state.deps!, { workspaceId: currentWorkspace, registrationId: pending.id, manifestDigest: pending.manifestDigest,
      decision: "approve", tools: ["zenith_get_topology"], scopes: ["read"], reviewedBy: "bob" });
    await writeFile(manifestPath, JSON.stringify(f.manifest)); const child = await issued(); const container = new FakeContainerRuntime();
    const running = runCli([...args("run"), "--manifest", manifestPath, "--digest", registration.manifestDigest,
      "--registration", registration.id, "--image", f.input.image, "--server", "zenith"], {
      env: publisherEnv(), stdin: stdin(child.token), pluginRuntime: container, stdout: () => {},
      fetch: async (input, init) => String(input) === f.manifest.artifact.url ? new Response(new Uint8Array(bytes)) : launchCheck(new Request(input, init)),
    });
    await vi.waitFor(() => expect(container.specs).toHaveLength(1), { timeout: 5000 });
    container.exit(); expect(await running).toBe(0);
  });
  it("never reads saved/env auth for run, and returns the main CLI's input/error exits", async () => {
    const stderr = vi.fn(); const fetcher = vi.fn<typeof fetch>();
    expect(await runCli([...args("run"), "--manifest", manifestPath, "--digest", registration.manifestDigest, "--registration", registration.id,
      "--image", f.input.image, "--server", "zenith"], { env: publisherEnv(), stdin: stdin(""), fetch: fetcher, stderr })).toBe(3);
    expect(fetcher).not.toHaveBeenCalled();
    expect(await runCli(["plugin", "unknown", "--json"], { stderr })).toBe(2);
    expect(JSON.parse(stderr.mock.calls.at(-1)![0]).error.code).toBe("invalid_arguments");
    expect(await runCli([...args("revoke"), "--registration", registration.id, "--digest", registration.manifestDigest, "--token-stdin"],
      { stdin: stdin(parent.token), fetch: async (input, init) => launchCheck(new Request(input, init)), stderr })).toBe(3);
    expect(stderr.mock.calls.join()).not.toContain(parent.token);
  });
  it("uses linked auth and the exact catalog route for list, preserving workspace and sanitizing output", async () => {
    const stdout = vi.fn();
    const fetcher = vi.fn<typeof fetch>(async (input, init) => {
      expect(String(input)).toBe(`${origin}/api/integrations/plugins/catalog`);
      expect(new Headers(init?.headers).get("authorization")).toBe(`Bearer ${parent.token}`);
      expect(new Headers(init?.headers).get("x-zenith-workspace")).toBe(currentWorkspace);
      expect(init?.redirect).toBe("error"); expect(init?.credentials).toBe("omit");
      return catalog(new Request(input, init));
    });
    expect(await runCli(args("list"), { env: publisherEnv(), fetch: fetcher, stdout })).toBe(0);
    expect(JSON.parse(stdout.mock.calls[0][0]).plugins).toEqual([expect.objectContaining({ id: registration.id, approvedTools: ["zenith_get_topology"] })]);
    expect(stdout.mock.calls.join()).not.toContain(parent.token);
    const child = await issued();
    expect((await catalog(new Request(`${origin}/api/integrations/plugins/catalog`, { headers: {
      authorization: `Bearer ${child.token}`, "x-zenith-workspace": currentWorkspace,
    } }))).status).toBe(401);
    state.member = false;
    expect((await catalog(new Request(`${origin}/api/integrations/plugins/catalog`, { headers: {
      authorization: `Bearer ${parent.token}`, "x-zenith-workspace": currentWorkspace,
    } }))).status).toBe(403);
  });
  it("reports revocation storage failure as unavailable without trying to revoke a broader credential", async () => {
    const child = await issued(); const authority = vi.fn(); const deps = revokeDeps();
    deps.authority = authority;
    deps.plugins = { revokeByToken: async () => { throw new Error("modeled DB outage"); } };
    expect((await revokeToken(revokeRequest(child.token), deps)).status).toBe(503); expect(authority).not.toHaveBeenCalled();
    const unknown = `za_${randomBytes(32).toString("base64url")}`;
    expect((await revokeToken(revokeRequest(unknown), revokeDeps())).status).toBe(200);
  });
});

// Registered owner-run case: fails as skipped (never green) unless a networked PostgreSQL server is configured.
describe.skipIf(!process.env.ZENITH_TEST_PLATFORM_PG_URL)("plugin launch authority on native PostgreSQL [postgres; postgres needs ZENITH_TEST_PLATFORM_PG_URL]", () => {
  it("issues, checks and revokes a launch child against a networked PostgreSQL server, not PGlite", async () => {
    const [server] = await platform.db.query<{ networked: boolean }>("select inet_server_addr() is not null as networked");
    expect(server.networked).toBe(true);
    const child = await issued(); expect((await launchCheck(checkRequest(child.token))).status).toBe(200);
    expect((await revokeToken(revokeRequest(child.token), revokeDeps())).status).toBe(200);
    expect((await launchCheck(checkRequest(child.token))).status).toBe(401);
  });
});

/** Real routes over real PostgreSQL joined to the actual Docker sandbox: the server-side
 * revocation decision, not a fixture flag, must stop and remove the running containers. */
const dockerJoin = process.env.ZENITH_TEST_PLUGIN_DOCKER === "1" && Boolean(process.env.ZENITH_TEST_PLATFORM_PG_URL);
describe.skipIf(!dockerJoin)("real revocation stopping a real Docker sandbox [docker; needs ZENITH_TEST_PLUGIN_DOCKER=1, ZENITH_TEST_PLATFORM_PG_URL, pinned Node22 image, generated TLS files]", () => {
  it("PostgreSQL-backed RFC revocation of the launched child stops and removes the actual sandbox", async () => {
    const image = process.env.ZENITH_PLUGIN_SANDBOX_IMAGE, certFile = process.env.ZENITH_PLUGIN_TEST_TLS_CERT_FILE, keyFile = process.env.ZENITH_PLUGIN_TEST_TLS_KEY_FILE;
    if (!image || !certFile || !keyFile) throw new Error("The Docker join requires the sandbox image digest and generated TLS cert/key files; see PROD-UX-03.md");
    const [cert, key] = await Promise.all([readFile(certFile), readFile(keyFile)]);
    const docker = (args: string[]) => new Promise<string>((done, reject) => execFile("docker", args, { timeout: 15_000 }, (error, out) => error ? reject(error) : done(out.trim())));
    const owned = async (kind: "ps" | "volume") => (await docker(kind === "ps" ? ["ps", "-aq", "--filter", "label=zenith.plugin.launch"] : ["volume", "ls", "-q", "--filter", "label=zenith.plugin.launch"])).split(/\s+/).filter(Boolean);
    expect(await owned("ps")).toEqual([]);
    const bytes = archive([{ name: "main.mjs", content: "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);" }]);
    let served: (path: string, request: NextRequest) => Response | Promise<Response> = () => new Response("{}", { status: 404 });
    const server = createHttpsServer({ cert, key }, async (req, res) => {
      const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const headers = new Headers(); for (const [name, value] of Object.entries(req.headers)) if (typeof value === "string") headers.set(name, value);
      const response = await served(req.url ?? "", new NextRequest(`${origin}${req.url}`, { method: req.method, headers, body: chunks.length ? Buffer.concat(chunks) : undefined }));
      res.writeHead(response.status, { "content-type": response.headers.get("content-type") ?? "application/json" }); res.end(Buffer.from(await response.arrayBuffer()));
    });
    await new Promise<void>((done) => server.listen(0, "0.0.0.0", done));
    const saved = origin;
    origin = `https://host.docker.internal:${(server.address() as AddressInfo).port}`; vi.stubEnv("ZENITH_AGENT_ORIGIN", origin);
    try {
      const unsigned = signedPortion(f.manifest);
      unsigned.artifact = { format: "tar.gz", url: `${origin}/archive.tgz`, digest: `sha256:${createHash("sha256").update(bytes).digest("hex")}` };
      f.manifest = signManifest({ ...unsigned, version: "1.0.2" }, f.publisher.privateKey);
      const pending = await registerPlugin(state.deps!, { workspaceId: currentWorkspace, manifest: f.manifest, requestedBy: "bob" });
      registration = await reviewPlugin(state.deps!, { workspaceId: currentWorkspace, registrationId: pending.id, manifestDigest: pending.manifestDigest,
        decision: "approve", tools: ["zenith_get_topology"], scopes: ["read"], reviewedBy: "bob" });
      await writeFile(manifestPath, JSON.stringify(f.manifest));
      const child = await issued();
      served = (path, request) => path === "/archive.tgz" ? new Response(new Uint8Array(bytes)) :
        path === "/api/integrations/plugins/launch/check" ? launchCheck(request) :
        path === "/api/agent/oauth/revoke" ? revokeToken(request, revokeDeps()) : new Response("{}", { status: 404 });
      // Host side reaches the same server on loopback with the generated certificate's name.
      const fetcher: typeof fetch = (input, init) => new Promise<Response>((done, reject) => {
        const body = typeof init?.body === "string" ? init.body : init?.body instanceof URLSearchParams ? init.body.toString() : undefined;
        const req = httpsRequest(new URL(String(input)), { hostname: "127.0.0.1", servername: "host.docker.internal", ca: cert, method: init?.method,
          // Send the API's own host name, as a real client does; only the TCP target is loopback.
          headers: { ...Object.fromEntries(new Headers(init?.headers)), host: new URL(String(input)).host }, signal: init?.signal ?? undefined }, (res) => {
          const parts: Buffer[] = []; res.on("data", (part: Buffer) => parts.push(part));
          res.on("end", () => done(new Response(Buffer.concat(parts), { status: res.statusCode, headers: { "content-type": String(res.headers["content-type"] ?? "application/octet-stream") } })));
        });
        req.on("error", reject); req.end(body);
      });
      const keys = f.publisher.publishers.get("acme")!;
      const env = { ZENITH_PLUGIN_TRUSTED_PUBLISHERS: JSON.stringify({ acme: keys.map((k) => ({ keyId: k.keyId, publicKey: k.key.export({ format: "der", type: "spki" }).subarray(-32).toString("base64") })) }) };
      const common = ["--url", origin, "--workspace", currentWorkspace, "--json"];
      const stdout = vi.fn(); const stderr = vi.fn();
      const running = runCli(["plugin", "run", ...common, "--manifest", manifestPath, "--digest", registration.manifestDigest, "--registration", registration.id,
        "--image", image, "--server", "zenith", "--ca-file", certFile], { env, fetch: fetcher, stdout, stderr, pluginRuntime: new DockerRuntime(), stdin: stdin(child.token) });
      await vi.waitFor(async () => expect(await docker(["ps", "-q", "--filter", "label=zenith.plugin.launch"])).toMatch(/\S+\s+\S+/), { timeout: 60_000, interval: 500 });
      expect(await runCli(["plugin", "revoke", ...common, "--registration", registration.id, "--digest", registration.manifestDigest, "--token-stdin"],
        { env, fetch: fetcher, stdout, stderr, stdin: stdin(child.token) })).toBe(0);
      expect(await running).toBe(3);
      await vi.waitFor(async () => { expect(await owned("ps")).toEqual([]); expect(await owned("volume")).toEqual([]); }, { timeout: 30_000, interval: 500 });
      const [grant] = await platform.db.query<{ revoked: boolean }>("select revoked_at is not null as revoked from platform.plugin_grants where id=$1", [child.grantId]);
      expect(grant.revoked).toBe(true);
      expect((await launchCheck(checkRequest(child.token))).status).toBe(401);
      expect(stdout.mock.calls.join() + stderr.mock.calls.join()).not.toContain(child.token);
    } finally {
      origin = saved; server.closeAllConnections(); await new Promise<void>((done) => server.close(() => done()));
    }
  }, 120_000);
});
