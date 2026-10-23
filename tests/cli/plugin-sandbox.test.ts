import { createServer, request as httpRequest, type RequestOptions, type IncomingMessage } from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { gzipSync, gunzipSync } from "node:zlib";
import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { checkBootstrap, unpack } from "../../deploy/plugin-sandbox/runner.mjs";
import { allowRpc, gatewayHandler, sameLease } from "../../deploy/plugin-sandbox/gateway.mjs";
import { socketFetch } from "../../deploy/plugin-sandbox/transport.mjs";
import { archive, launchFixture } from "../plugins/launcher-support";

const temporary: string[] = [];
afterEach(async () => { for (const path of temporary.splice(0)) await rm(path, { recursive: true, force: true }); });
async function scratch(): Promise<string> { const path = await mkdtemp(join(tmpdir(), "zenith-plugin-archive-test-")); temporary.push(path); return path; }

describe("plugin archive [pure strict ustar reader]", () => {
  it("extracts regular files with launcher-owned modes into scratch", async () => {
    const root = await scratch(); await unpack(archive([{ name: "bridge/main.mjs", content: "example" }]), root);
    expect(await readFile(join(root, "bridge/main.mjs"), "utf8")).toBe("example");
  });
  it.each(["../escape", "/absolute", "dir/../../escape", "dir/./bad", "dir//bad", "C:/absolute", "dir\\escape"])("refuses unsafe archive path %s", async (name) => {
    await expect(unpack(archive([{ name }]), await scratch())).rejects.toThrow("plugin_archive_refused");
  });
  it.each(["1", "2", "3", "4", "6", "x", "g", "S"])("refuses archive member type %s", async (type) => {
    await expect(unpack(archive([{ name: "member", type, link: "../escape" }]), await scratch())).rejects.toThrow("plugin_archive_refused");
  });
  it("refuses duplicate members and file/directory collisions", async () => {
    await expect(unpack(archive([{ name: "main.mjs" }, { name: "main.mjs" }]), await scratch())).rejects.toThrow("plugin_archive_refused");
    await expect(unpack(archive([{ name: "dir", content: "file" }, { name: "dir/main.mjs" }]), await scratch())).rejects.toThrow();
  });
  it("refuses corrupt checksums, incomplete trailers and too many entries", async () => {
    const corrupt = gunzipSync(archive()); corrupt[0] = 65;
    await expect(unpack(gzipSync(corrupt), await scratch())).rejects.toThrow("plugin_archive_refused");
    const incomplete = gunzipSync(archive()).subarray(0, -1024);
    await expect(unpack(gzipSync(incomplete), await scratch())).rejects.toThrow("plugin_archive_refused");
    await expect(unpack(archive(Array.from({ length: 257 }, (_, index) => ({ name: `entry-${index}` }))), await scratch())).rejects.toThrow("plugin_archive_refused");
  });
});

describe("API-only gateway [modeled upstream, no container isolation claim]", () => {
  const rpc = (arguments_: Record<string, unknown> = { target: { workspaceId: "ws-a", projectId: "proj-a", environmentId: "env-a" } }) => ({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "zenith_get_topology", arguments: arguments_ } });
  it("accepts approved scoped tools and denies foreign targets, batches and credential routes", () => {
    const { lease } = launchFixture(); expect(allowRpc(rpc(), lease)).toBe(true);
    expect(allowRpc(rpc({ target: { workspaceId: "ws-b", projectId: "proj-a" } }), lease)).toBe(false);
    expect(allowRpc(rpc({ target: { workspaceId: "ws-a", projectId: "proj-b" } }), lease)).toBe(false);
    expect(allowRpc(rpc({ target: { workspaceId: "ws-a", projectId: "proj-a", environmentId: "env-b" } }), lease)).toBe(false);
    expect(allowRpc([rpc()], lease)).toBe(false);
    expect(allowRpc({ ...rpc(), method: "credentials/list" }, lease)).toBe(false);
    expect(allowRpc({ ...rpc(), params: { ...rpc().params, name: "zenith_restart_service" } }, lease)).toBe(false);
    expect(allowRpc({ ...rpc(), url: "https://metadata.invalid" }, lease)).toBe(false);
  });
  it("matches live leases independent of object key order and refuses permission changes", () => {
    const { lease } = launchFixture(); expect(sameLease(Object.fromEntries(Object.entries(lease).reverse()), lease)).toBe(true);
    expect(sameLease({ ...lease, projectIds: ["proj-b"] }, lease)).toBe(false);
    expect(sameLease({ ...lease, status: "revoked" }, lease)).toBe(false);
    expect(sameLease({ ...lease, extra: true }, lease)).toBe(false);
  });
  it("forwards only MCP to the fixed HTTPS origin, filters discovery and terminates on revocation", async () => {
    const f = launchFixture(); let revoked = false;
    const lost = vi.fn();
    const upstream = vi.fn<typeof fetch>(async (url) => {
      if (String(url).endsWith("/launch/check")) return Response.json(revoked ? { status: "revoked" } : f.lease);
      return Response.json({ jsonrpc: "2.0", id: 1, result: { tools: [{ name: "zenith_get_topology" }, { name: "zenith_restart_service" }] } });
    });
    const server = createServer(gatewayHandler({ token: f.input.token, binding: f.binding, lease: f.lease, apiOrigin: f.input.apiOrigin }, upstream, lost));
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    const address = server.address(); if (!address || typeof address === "string") throw new Error("test listener failed");
    const origin = `http://127.0.0.1:${address.port}`;
    const request = (path: string, message: unknown, headers = {}) => fetch(`${origin}${path}`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(message) });
    try {
      expect((await request("/api/integrations", rpc())).status).toBe(403);
      expect((await request("/api/agent/v3/mcp", rpc(), { authorization: `Bearer ${f.input.token}` })).status).toBe(403);
      expect(upstream).not.toHaveBeenCalled();
      const response = await request("/api/agent/v3/mcp", { jsonrpc: "2.0", id: 1, method: "tools/list" });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ jsonrpc: "2.0", id: 1, result: { tools: [{ name: "zenith_get_topology" }] } });
      expect(upstream).toHaveBeenLastCalledWith(new URL(`${f.input.apiOrigin}/api/agent/v3/mcp`), expect.objectContaining({
        redirect: "error", headers: expect.objectContaining({ authorization: `Bearer ${f.input.token}`, "x-zenith-workspace": f.lease.workspaceId }),
      }));
      revoked = true;
      expect((await request("/api/agent/v3/mcp", rpc())).status).toBe(401); expect(lost).toHaveBeenCalledOnce();
      expect(upstream.mock.calls.filter(([url]) => String(url).endsWith("/v3/mcp"))).toHaveLength(1);
    } finally { server.closeAllConnections(); await new Promise<void>((done) => server.close(() => done())); }
  });
});

it("the Node fetch adapter reaches only the MCP socket and drops caller credentials", async () => {
  const f = launchFixture(); const seen: Record<string, string | string[] | undefined>[] = [];
  const server = createServer(async (req, res) => {
    seen.push(req.headers); req.resume(); res.setHeader("content-type", "application/json"); res.end('{"result":{}}');
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const address = server.address(); if (!address || typeof address === "string") throw new Error("fixture failed");
  const localRequest = ((options: RequestOptions, done: (res: IncomingMessage) => void) => httpRequest({ ...options, socketPath: undefined, hostname: "127.0.0.1", port: address.port }, done)) as typeof httpRequest;
  const adapter = socketFetch("modeled-socket", f.binding.audience, localRequest);
  try {
    const response = await adapter(f.binding.audience, { method: "POST", body: "{}", headers: { authorization: `Bearer ${f.input.token}`, cookie: "caller cookie" } });
    expect((response as Response).status).toBe(200); expect(seen).toHaveLength(1);
    expect(seen[0]).not.toHaveProperty("authorization"); expect(seen[0]).not.toHaveProperty("cookie");
    await expect(adapter("https://metadata.invalid/credentials", { method: "POST", body: "{}" })).rejects.toThrow("plugin_transport_refused");
    await expect(adapter(f.binding.audience, { method: "GET" })).rejects.toThrow("plugin_transport_refused");
    expect(seen).toHaveLength(1);
  } finally { server.closeAllConnections(); await new Promise<void>((done) => server.close(() => done())); }
});

describe("plugin runner bootstrap", () => {
  it("refuses a plugin bootstrap that carries any token and accepts the gateway-free form", () => {
    const bytes = Buffer.from("artifact"); const artifactDigest = createHash("sha256").update(bytes).digest("hex");
    const input = { binding: { credentialDigest: "0".repeat(64) }, artifactDigest };
    expect(() => checkBootstrap(input, bytes)).not.toThrow();
    for (const token of [`za_${"a".repeat(43)}`, "", undefined]) expect(() => checkBootstrap({ ...input, token }, bytes)).toThrow("invalid_bootstrap");
    expect(() => checkBootstrap({ ...input, artifactDigest: "1".repeat(64) }, bytes)).toThrow("invalid_bootstrap");
  });
});
