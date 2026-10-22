/**
 * Real route wrapper, membership/role checks, browser guard and PGlite intent SQL.
 * Supabase identity and GitHub HTTP are mocked; no live install is claimed.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionUser } from "@/lib/auth/session";
import type { Member, Workspace } from "@/lib/domain/types";
import type { PlatformDb } from "@/lib/controlplane/types";
import { tempDataDir } from "../_support/data-dir";
import { api, INSTALL_TOKEN, USER_TOKEN, json, keys } from "./fixtures";

tempDataDir("zenith-github-callback-", { fast: true });
process.env.ZENITH_STORE = "file";
const state = vi.hoisted(() => ({ user: { id: "human", email: "human@zenith.test", name: "Human" } as SessionUser | null, verified: true, db: undefined as PlatformDb | undefined, identityGate: undefined as { entered: () => void; wait: Promise<void> } | undefined, mfaClaims: vi.fn(), mfaUser: vi.fn() }));
vi.mock("@/lib/server/boot", () => ({ ensureBoot: async () => undefined }));
vi.mock("@/lib/supabase/env", async (original) => ({ ...await original<typeof import("@/lib/supabase/env")>(),
  SUPABASE_URL: "http://auth.test", SUPABASE_PUBLIC_KEY: "synthetic-publishable-key", isSupabaseConfigured: () => true }));
vi.mock("@supabase/ssr", () => ({ createServerClient: () => ({ auth: { getClaims: state.mfaClaims, getUser: state.mfaUser } }) }));
vi.mock("@/lib/supabase/route", () => ({ sessionUserFromRequest: async () => state.user }));
vi.mock("@/lib/waitlist/enforcement", () => ({ requireProductRequestAccess: async () => undefined }));
vi.mock("@/lib/hosted/access/identity", () => ({ verifyRequestIdentity: async () => {
  const gate = state.identityGate;
  if (gate) { state.identityGate = undefined; gate.entered(); await gate.wait; }
  return { subject: state.user?.id, email: state.user?.email, emailVerified: state.verified };
} }));
vi.mock("@/lib/controlplane/db/open", async (original) => ({ ...await original<typeof import("@/lib/controlplane/db/open")>(), platformDb: async () => state.db! }));

const { db, resetDb } = await import("@/lib/db/store");
const { NextRequest } = await import("next/server");
const { openPlatformDb } = await import("@/lib/controlplane/db");
const { createGithubSourceStore } = await import("@/lib/sources/github/store");
const { digest } = await import("@/lib/sources/github/store");
const { captureGithubWebhookFence } = await import("@/lib/sources/github/webhook-store");
const { GET, POST } = await import("@/app/api/platform/v1/github/callback/route");
const ROOT = "https://zenith.test/api/platform/v1/github/callback";
const AGENT_HEADERS: Record<string, string>[] = [{ authorization: "Bearer synthetic-agent-canary" }, { authorization: "" }, { "x-zenith-actor": "navigator" }, { "x-zenith-actor-key": "synthetic-navigator-canary" }];
const CROSS_SITE_HEADERS: Record<string, string>[] = [{ origin: "https://evil.test" }, { origin: "null" }, { origin: "" }, { "sec-fetch-site": "cross-site" }];
let material: Awaited<ReturnType<typeof keys>>;
let fetchImpl: ReturnType<typeof api>;
beforeAll(async () => { material = await keys(); state.db = await openPlatformDb({ kind: "pglite" }); });
afterAll(async () => { await state.db?.close(); await material.close(); });
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });
beforeEach(async () => {
  vi.stubEnv("ZENITH_PLATFORM_ORIGIN", "https://zenith.test"); vi.stubEnv("ZENITH_HOSTED_MODE", "0");
  vi.stubEnv("ZENITH_GITHUB_APP_ID", "42"); vi.stubEnv("ZENITH_GITHUB_APP_PRIVATE_KEY_FILE", material.config.privateKeyFile);
  vi.stubEnv("ZENITH_GITHUB_APP_CLIENT_ID", "Iv1.synthetic"); vi.stubEnv("ZENITH_GITHUB_APP_CLIENT_SECRET_FILE", material.config.clientSecretFile!);
  fetchImpl = api(); vi.stubGlobal("fetch", fetchImpl); state.verified = true; state.identityGate = undefined;
  state.user = { id: "human", email: "human@zenith.test", name: "Human" };
  state.mfaClaims.mockImplementation(async () => ({ data: { claims: { sub: state.user?.id ?? "", aal: "aal2", exp: Date.now() / 1000 + 600,
    amr: [{ method: "totp", timestamp: Date.now() / 1000 }] } }, error: null }));
  state.mfaUser.mockImplementation(async () => ({ data: { user: { id: state.user?.id ?? "", email_confirmed_at: new Date().toISOString(),
    factors: [{ factor_type: "totp", status: "verified" }] } }, error: null }));
  resetDb({ workspaces: ["ws-a", "ws-b"].map((id) => ({ id, name: id, slug: id, createdAt: new Date(0).toISOString() } as Workspace)), members: [
    { id: "human", workspaceId: "ws-a", email: "human@zenith.test", name: "Human", role: "admin" },
    { id: "editor", workspaceId: "ws-a", email: "editor@zenith.test", name: "Editor", role: "editor" },
  ] as Member[] });
  for (const table of ["github_binding_events", "github_install_intents", "github_source_bindings"]) await state.db!.query(`delete from platform.${table} where workspace_id = $1`, ["ws-a"]);
});
async function call(method: "GET" | "POST", query = "", opts: { cookie?: string; body?: string; headers?: Record<string, string>; signal?: AbortSignal } = {}) {
  return (method === "GET" ? GET : POST)(new NextRequest(ROOT + query, {
    method, signal: opts.signal, headers: { cookie: `zenith-workspace=ws-a${opts.cookie ? `; ${opts.cookie}` : ""}`, ...(method === "POST" ? { origin: "https://zenith.test", "content-type": "application/x-www-form-urlencoded" } : {}), ...opts.headers },
    ...(method === "POST" ? { body: opts.body ?? "repository=acme%2Fapp" } : {}),
  }), { params: Promise.resolve({}) });
}
async function start() {
  const response = await call("POST"); expect(response.status).toBe(303);
  const target = new URL(response.headers.get("location")!); const installState = target.searchParams.get("state")!;
  const cookie = response.headers.get("set-cookie")!.split(";")[0]; return { state: installState, cookie, response };
}
async function authorize(input: { state: string; cookie: string }) {
  return call("GET", `?installation_id=7&setup_action=install&state=${input.state}`, { cookie: input.cookie });
}

describe("GitHub browser install callback", () => {
  it.each(["request abort", "body deadline"])("bounds a stalled form on %s before any source mutation", async mode => {
    const controller = new AbortController();
    let reached!: () => void; let release!: () => void;
    const started = new Promise<void>(resolve => { reached = resolve; });
    const waiting = new Promise<void>(resolve => { release = resolve; });
    const request = new NextRequest(ROOT, { method: "POST", signal: controller.signal,
      headers: { cookie: "zenith-workspace=ws-a", origin: "https://zenith.test", "content-type": "application/x-www-form-urlencoded" }, body: "placeholder" });
    Object.defineProperty(request, "body", { value: new ReadableStream<Uint8Array>({ async pull() { reached(); await waiting; } }, { highWaterMark: 0 }) });
    const result = POST(request, { params: Promise.resolve({}) });
    try { await started; if (mode === "request abort") controller.abort(); expect((await result).status).toBe(400); }
    finally { release(); }
    expect(await state.db!.query("select workspace_id from platform.github_install_intents where workspace_id=$1", ["ws-a"])).toEqual([]);
    expect(await state.db!.query("select action from platform.github_binding_events where workspace_id=$1", ["ws-a"])).toEqual([]);
  }, 15_000);

  it.each(["request abort", "authority deadline"])("releases the installation lock on %s without accepting the late identity grant", async mode => {
    const started = await start(); await authorize(started);
    let resumeHttp!: () => void; let httpEntered!: () => void; let resumeIdentity!: () => void; let identityEntered!: () => void;
    const httpWait = new Promise<void>(resolve => { resumeHttp = resolve; });
    const httpReached = new Promise<void>(resolve => { httpEntered = resolve; });
    const identityWait = new Promise<void>(resolve => { resumeIdentity = resolve; });
    const identityReached = new Promise<void>(resolve => { identityEntered = resolve; });
    fetchImpl.mockImplementationOnce(async () => { httpEntered(); await httpWait; return json({ access_token: USER_TOKEN, token_type: "bearer" }); });
    const controller = new AbortController();
    const result = call("GET", `?code=synthetic-code&state=${started.state}`, { cookie: started.cookie, signal: controller.signal });
    await httpReached;
    state.identityGate = { entered: identityEntered, wait: identityWait }; resumeHttp();
    try {
      await identityReached;
      if (mode === "request abort") controller.abort();
      expect((await result).status).toBe(503);
      // Actual SQL must become available while the original identity promise
      // still waits. A late successful response cannot run the bind callback.
      expect(await captureGithubWebhookFence(state.db!, "42", 7)).toMatchObject({ generation: "0" });
    } finally { resumeIdentity(); resumeHttp(); }
    expect(await createGithubSourceStore(state.db!).getBinding("ws-a")).toBeUndefined();
    expect(await state.db!.query("select action from platform.github_binding_events where workspace_id=$1", ["ws-a"])).toEqual([]);
  }, 15_000);
  it.each(["demoted", "removed", "disabled"] as const)("refuses revocation when admin becomes %s during a streamed body", async mode => {
    const store = createGithubSourceStore(state.db!);
    const fence = await captureGithubWebhookFence(state.db!, "42", 7);
    await store.bind({ workspaceId: "ws-a", actorId: "human", appId: "42", installationId: 7, repositoryId: 99, owner: "acme", repo: "app", expectedVersion: 0, installationGeneration: fence.generation });
    let release!: () => void;
    let reached!: () => void;
    const waiting = new Promise<void>(resolve => { release = resolve; });
    const reachedRead = new Promise<void>(resolve => { reached = resolve; });
    // NextRequest buffering cannot consume this stream: the route reads it directly.
    const request = new NextRequest(ROOT, { method: "POST", headers: { cookie: "zenith-workspace=ws-a", origin: "https://zenith.test", "content-type": "application/x-www-form-urlencoded" }, body: "placeholder" });
    const stream = new ReadableStream<Uint8Array>({ async pull(controller) {
      reached(); await waiting; controller.enqueue(new TextEncoder().encode("action=revoke&version=1")); controller.close();
    } }, { highWaterMark: 0 });
    Object.defineProperty(request, "body", { value: stream });
    const result = POST(request, { params: Promise.resolve({}) });
    await reachedRead;
    if (mode === "disabled") state.verified = false;
    else if (mode === "removed") db().members = db().members.filter(m => !(m.workspaceId === "ws-a" && m.id === "human"));
    else db().members.find(m => m.workspaceId === "ws-a" && m.id === "human")!.role = "viewer";
    release();
    expect((await result).status).toBe(mode === "disabled" ? 401 : 403);
    expect(await store.getBinding("ws-a")).toMatchObject({ version: 1 });
    expect(await state.db!.query("select action from platform.github_binding_events where workspace_id=$1", ["ws-a"])).toEqual([{ action: "bound" }]);
  });
  it.each(["demoted", "removed", "disabled"] as const)("refuses binding when admin becomes %s during GitHub verification", async mode => {
    const started = await start(); await authorize(started);
    let release!: () => void; let reached!: () => void;
    const waiting = new Promise<void>(resolve => { release = resolve; });
    const reachedHttp = new Promise<void>(resolve => { reached = resolve; });
    fetchImpl.mockImplementationOnce(async () => { reached(); await waiting; return json({ access_token: USER_TOKEN, token_type: "bearer" }); });
    const result = call("GET", `?code=synthetic-code&state=${started.state}`, { cookie: started.cookie });
    await reachedHttp;
    if (mode === "disabled") state.verified = false;
    else if (mode === "removed") db().members = db().members.filter(m => !(m.workspaceId === "ws-a" && m.id === "human"));
    else db().members.find(m => m.workspaceId === "ws-a" && m.id === "human")!.role = "viewer";
    release();
    expect((await result).status).toBe(mode === "disabled" ? 401 : 403);
    expect(await createGithubSourceStore(state.db!).getBinding("ws-a")).toBeUndefined();
    expect(await state.db!.query("select action from platform.github_binding_events where workspace_id=$1", ["ws-a"])).toEqual([]);
  });
  it("requires a current admin browser and exact binding version for source revocation", async () => {
    const store = createGithubSourceStore(state.db!);
    const fence = await captureGithubWebhookFence(state.db!, "42", 7);
    await store.bind({ workspaceId: "ws-a", actorId: "human", appId: "42", installationId: 7, repositoryId: 99, owner: "acme", repo: "app", expectedVersion: 0, installationGeneration: fence.generation });
    expect(await (await call("GET")).text()).toContain('name="version" value="1"');
    for (const headers of [...AGENT_HEADERS, ...CROSS_SITE_HEADERS]) expect((await call("POST", "", { body: "action=revoke&version=1", headers })).status).toBe(403);
    expect((await call("POST", "", { body: "action=revoke&version=2" })).status).toBe(409);
    expect(await store.getBinding("ws-a")).toMatchObject({ version: 1 });
    const result = await call("POST", "", { body: "action=revoke&version=1" });
    expect(result.status).toBe(200); expect(await result.text()).toContain("GitHub source revoked");
    expect(result.headers.get("set-cookie")).toContain("Max-Age=0");
    await expect(store.getBinding("ws-a")).rejects.toThrow("refused");
    expect((await store.getState("ws-a"))?.binding.version).toBe(2);
    expect((await call("POST", "", { body: "action=revoke&version=1" })).status).toBe(409);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
  it.each(["action=revoke&version=1&version=1", "action=revoke&action=revoke&version=1", "action=revoke&version=1&repository=acme%2Fapp", "action=revoke&version=0", "action=revoke&version=-1", "action=delete&version=1"])("rejects ambiguous revoke input: %s", async (body) => {
    expect((await call("POST", "", { body })).status).toBe(400); expect(fetchImpl).not.toHaveBeenCalled();
  });
  it("serves a browser form and redirects installation with protected expiring proof cookies", async () => {
    const form = await call("GET"); expect(form.status).toBe(200); expect(await form.text()).toContain("Install and bind repository");
    const started = await start(); expect(started.state).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(started.response.headers.get("location")?.startsWith("https://github.com/apps/zenith-test/installations/new?state=")).toBe(true);
    const allowedFormDestinations = /form-action ([^;]+)/.exec(form.headers.get("content-security-policy") ?? "")?.[1].split(" ");
    expect(allowedFormDestinations).toContain(new URL(started.response.headers.get("location")!).origin);
    expect(started.response.headers.get("set-cookie")).toMatch(/HttpOnly/); expect(started.response.headers.get("set-cookie")).toMatch(/Secure/); expect(started.response.headers.get("set-cookie")).toMatch(/SameSite=lax/i);
    // The form page must let the browser send its real Origin on its own POST; GitHub still receives no referrer.
    expect(form.headers.get("referrer-policy")).toBe("same-origin");
    expect(started.response.headers.get("referrer-policy")).toBe("same-origin");
  });
  it("binds only after server-side OAuth and GitHub user repository verification", async () => {
    const started = await start(); const auth = await authorize(started); expect(auth.status).toBe(303);
    const target = new URL(auth.headers.get("location")!);
    expect(target.origin + target.pathname).toBe("https://github.com/login/oauth/authorize");
    expect(target.searchParams.get("code_challenge")).toBe(Buffer.from(digest(started.cookie.split("=")[1]), "hex").toString("base64url"));
    const response = await call("GET", `?code=synthetic-code&state=${started.state}`, { cookie: started.cookie });
    expect(response.status).toBe(200); const body = await response.text(); expect(body).toContain("GitHub source connected");
    const binding = await createGithubSourceStore(state.db!).getBinding("ws-a"); expect(binding?.repositoryId).toBe(99); expect(binding?.installationId).toBe(7);
    const output = body + JSON.stringify(binding) + [...response.headers.values()].join(" ");
    expect(output.includes(INSTALL_TOKEN) || output.includes(USER_TOKEN) || output.includes("synthetic-code")).toBe(false);
    expect(response.headers.get("set-cookie")).toContain("Max-Age=0");
  });
  it.each(AGENT_HEADERS)("rejects agent headers for form/start/callback: %j", async (headers) => {
    for (const method of ["GET", "POST"] as const) expect((await call(method, "", { headers })).status).toBe(403);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
  it.each(CROSS_SITE_HEADERS)("refuses cross-site install mutations: %j", async (headers) => {
    expect((await call("POST", "", { headers })).status).toBe(403); expect(fetchImpl).not.toHaveBeenCalled();
  });
  it("requires current verified identity and the admin role", async () => {
    state.verified = false; expect((await call("GET")).status).toBe(401);
    state.verified = true; state.user = { id: "editor", email: "editor@zenith.test", name: "Editor" }; expect((await call("POST")).status).toBe(403);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
  it("refuses a callback after the initiating human changes", async () => {
    const started = await start(); await authorize(started); state.user = { id: "editor", email: "editor@zenith.test", name: "Editor" };
    const response = await call("GET", `?code=synthetic-code&state=${started.state}`, { cookie: started.cookie }); expect(response.status).toBe(403);
    expect(await createGithubSourceStore(state.db!).getBinding("ws-a")).toBeUndefined();
  });
  it("refuses a named workspace outside the selected membership", async () => {
    expect((await call("POST", "?workspace=ws-b")).status).toBe(403); expect(fetchImpl).not.toHaveBeenCalled();
  });
  it("requires the original browser proof and single-use callback state", async () => {
    const started = await start();
    expect((await call("GET", `?installation_id=7&state=${started.state}`)).status).toBe(403);
    expect((await authorize(started)).status).toBe(303); expect((await authorize(started)).status).toBe(403);
    expect((await call("GET", `?code=synthetic-code&state=${started.state}`, { cookie: started.cookie })).status).toBe(200);
    expect((await call("GET", `?code=synthetic-code&state=${started.state}`, { cookie: started.cookie })).status).toBe(403);
  });
  it("refuses a repository invisible to the GitHub user and consumes that callback", async () => {
    const started = await start(); await authorize(started);
    fetchImpl.mockResolvedValueOnce(json({ access_token: USER_TOKEN, token_type: "bearer" })).mockResolvedValueOnce(json({ repositories: [{ id: 100, full_name: "foreign/private" }] }));
    expect((await call("GET", `?code=synthetic-code&state=${started.state}`, { cookie: started.cookie })).status).toBe(403);
    expect(await createGithubSourceStore(state.db!).getBinding("ws-a")).toBeUndefined();
    expect((await call("GET", `?code=synthetic-code&state=${started.state}`, { cookie: started.cookie })).status).toBe(403);
  });
  it("scrubs external token errors from HTTP and logs", async () => {
    const started = await start(); await authorize(started); fetchImpl.mockRejectedValueOnce(new Error(USER_TOKEN));
    const logs = [vi.spyOn(console, "log"), vi.spyOn(console, "warn"), vi.spyOn(console, "error")];
    try {
      const response = await call("GET", `?code=synthetic-code&state=${started.state}`, { cookie: started.cookie }); expect(response.status).toBe(503);
      const body = await response.text(); const output = body + JSON.stringify(logs.flatMap((log) => log.mock.calls));
      expect(output.includes(USER_TOKEN) || output.includes(INSTALL_TOKEN)).toBe(false);
    } finally { logs.forEach((log) => log.mockRestore()); }
  });
  it.each(["repository=acme%2Fapp&repository=foreign%2Fprivate", "repository=https%3A%2F%2Ftoken%40github.com%2Facme%2Fapp", "repository=acme%2Fapp&installation_id=7", "repository=" + "x".repeat(1100)])("rejects invalid form input without HTTP: %s", async (body) => {
    expect((await call("POST", "", { body })).status).toBe(400); expect(fetchImpl).not.toHaveBeenCalled();
  });
  it("refuses duplicate parameters and direct callbacks without install state", async () => {
    const started = await start(); expect((await call("GET", `?installation_id=7&state=${started.state}&state=${started.state}`, { cookie: started.cookie })).status).toBe(400);
    expect((await call("GET", "?installation_id=7")).status).toBe(400);
  });
});
