/** Actual Linux Docker runtime, modeled HTTPS authority/MCP protocol fixture.
 * This proves container controls, NOT real platform issuance/review authority.
 * Missing infrastructure is skipped explicitly, never recorded as passed. */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer, request as httpsRequest } from "node:https";
import { describe, expect, it, vi } from "vitest";
import { launchPlugin } from "@/cli/plugins/launcher";
import { manifestDigestOf } from "@/lib/plugins/manifest";
import { DockerRuntime, type SandboxSpec } from "@/cli/plugins/runtime";
import { archive, launchFixture } from "../plugins/launcher-support";
import { signedPortion } from "@/lib/plugins/manifest";

// signManifest is a runtime-generated test publisher helper, not release authority.
import { signManifest as signFixture } from "../plugins/support";

const enabled = process.env.ZENITH_TEST_PLUGIN_DOCKER === "1";
const image = process.env.ZENITH_PLUGIN_SANDBOX_IMAGE;
const certFile = process.env.ZENITH_PLUGIN_TEST_TLS_CERT_FILE;
const keyFile = process.env.ZENITH_PLUGIN_TEST_TLS_KEY_FILE;
const docker = (args: string[]): Promise<string> => new Promise((resolve, reject) => {
  execFile("docker", args, { timeout: 15_000, maxBuffer: 1024 * 1024 }, (error, stdout) => error ? reject(error) : resolve(stdout.trim()));
});

const probe = `import { request } from 'node:http';
import { readFile, writeFile, access } from 'node:fs/promises';
import { createConnection } from 'node:net';
import { spawn } from 'node:child_process';
const denied = async (task) => { try { await task(); return false; } catch { return true; } };
const blocked = (host, port) => new Promise((done) => {
  const socket = createConnection({ host, port }); let finished = false;
  const stop = (value) => { if (finished) return; finished = true; socket.destroy(); done(value); };
  socket.once('connect', () => stop(false)); socket.once('error', () => stop(true)); socket.setTimeout(500, () => stop(true));
});
const status = await readFile('/proc/self/status', 'utf8');
const result = { uid: process.getuid(), caps: /CapEff:\\s+0+\\n/.test(status), noNewPrivileges: /NoNewPrivs:\\s+1\\n/.test(status),
  rootReadOnly: await denied(() => writeFile('/etc/plugin-write-test', 'x')),
  payloadReadOnly: await denied(() => writeFile('/zenith/plugin-write-test', 'x')),
  noDocker: await denied(() => access('/var/run/docker.sock')),
  noHostStore: await denied(() => access('/host')),
  apiDirectBlocked: await blocked('host.docker.internal', Number(process.argv[2])),
  metadataBlocked: await blocked('169.254.169.254', 80),
  noToken: process.env.ZENITH_TOKEN === undefined && !Object.values(process.env).some((v) => /za_[A-Za-z0-9_-]{20,}/.test(v)),
  envKeys: Object.keys(process.env).sort() };
const send = (message) => new Promise((done, reject) => {
  const req = request({ socketPath: process.env.ZENITH_MCP_SOCKET, path: process.env.ZENITH_MCP_PATH, method: 'POST', headers: { 'content-type': 'application/json' } }, (res) => { res.resume(); res.once('end', () => done(res.statusCode)); });
  req.once('error', reject); req.end(JSON.stringify(message));
});
await send({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'zenith_get_topology', arguments: { target: { workspaceId: 'ws-a', projectId: 'proj-a', environmentId: 'env-a' }, probe: result } } });
const child = spawn(process.execPath, ['-e', 'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000)'], { stdio: 'ignore' });
process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);`;

async function fixture() {
  if (!image || !certFile || !keyFile) throw new Error("Enabled Docker spec requires image digest and generated TLS cert/key FILE paths; see PROD-UX-03.md");
  const f = launchFixture(); let revoked = false; let unavailable = false;
  let received: Record<string, unknown> | undefined;
  const cert = await readFile(certFile); const key = await readFile(keyFile);
  const server = createServer({ cert, key }, async (req, res) => {
    const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) as Record<string, unknown> : {};
    if (req.url === "/archive.tgz") { res.end(f.bytes); return; }
    if (req.headers.authorization !== `Bearer ${f.input.token}`) { res.writeHead(401); res.end(); return; }
    res.setHeader("content-type", "application/json");
    if (req.url === "/api/integrations/plugins/launch/check") {
      if (unavailable) { res.writeHead(503); res.end("{}"); return; }
      expect(body).toEqual(f.binding); res.end(JSON.stringify(revoked ? { status: "revoked" } : f.lease)); return;
    }
    if (req.url === "/api/agent/v3/mcp") {
      received = ((body.params as { arguments: { probe: Record<string, unknown> } }).arguments.probe);
      res.end(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: {} })); return;
    }
    res.writeHead(404); res.end("{}");
  });
  await new Promise<void>((done) => server.listen(0, "0.0.0.0", done));
  const address = server.address(); if (!address || typeof address === "string") throw new Error("fixture failed");
  const origin = `https://host.docker.internal:${address.port}`;
  const unsigned = signedPortion(f.manifest);
  f.bytes = archive([{ name: "main.mjs", content: probe }]);
  unsigned.artifact = { format: "tar.gz", url: `${origin}/archive.tgz`, digest: `sha256:${createHash("sha256").update(f.bytes).digest("hex")}` };
  unsigned.components!.mcpServers![0].args.push(String(address.port));
  f.manifest = signFixture(unsigned, f.publisher.privateKey);
  f.input = { ...f.input, manifest: f.manifest, reviewedDigest: manifestDigestOf(f.manifest), image, apiOrigin: origin, caFile: certFile };
  f.binding = { ...f.binding, manifestDigest: f.input.reviewedDigest, audience: `${origin}/api/agent/v3/mcp` };
  f.lease = { ...f.lease, ...f.binding, expiresAt: new Date(Date.now() + 120_000).toISOString() };
  // Host transport connects loopback with the generated certificate's real
  // server name. Inside Docker the same origin uses Desktop's built-in DNS.
  const fetcher: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    return new Promise<Response>((done, reject) => {
      const req = httpsRequest(url, { hostname: "127.0.0.1", servername: "host.docker.internal", ca: cert, method: init?.method,
        headers: init?.headers as Record<string, string>, signal: init?.signal ?? undefined }, (res) => {
        const chunks: Buffer[] = []; res.on("data", (part: Buffer) => chunks.push(part));
        res.on("end", () => done(new Response(Buffer.concat(chunks), { status: res.statusCode, headers: { "content-type": String(res.headers["content-type"] ?? "application/octet-stream") } })));
      });
      req.on("error", reject); req.end(typeof init?.body === "string" ? init.body : undefined);
    });
  };
  let spec: SandboxSpec | undefined;
  const actual = new DockerRuntime();
  const runtime = { async start(input: SandboxSpec) { spec = input; return actual.start(input); } };
  return { ...f, fetcher, runtime, revoke: () => { revoked = true; }, outage: () => { unavailable = true; },
    received: () => received,
    async ownedContainers() {
      const ids = (await docker(["ps", "-aq", "--filter", "label=zenith.plugin.launch"])).split(/\s+/).filter(Boolean);
      if (!ids.length) return [];
      const containers = JSON.parse(await docker(["inspect", ...ids])) as { Id: string; Name: string; Config: { Env: string[] }; HostConfig: { NetworkMode: string; ReadonlyRootfs: boolean }; Mounts: { Source: string; Name?: string; Type: string }[] }[];
      return containers.filter((c) => c.Mounts.some((m) => m.Source === spec?.scratch));
    },
    async close() { server.closeAllConnections(); await new Promise<void>((done) => server.close(() => done())); },
  };
}

describe.skipIf(!enabled)("real plugin sandbox [needs ZENITH_TEST_PLUGIN_DOCKER=1, Linux Docker, pinned Node22 image, generated TLS files]", () => {
  it.each(["revoke", "outage", "cancel"])("proves actual process isolation and forced cleanup on %s", async (mode) => {
    const f = await fixture(); const signal = new AbortController();
    const run = launchPlugin(f.input, { runtime: f.runtime, publishers: f.publisher.publishers, fetch: f.fetcher, signal: signal.signal });
    const failure = expect(run).rejects.toThrow();
    try {
      await vi.waitFor(() => expect(f.received()).toBeDefined(), { timeout: 30_000 });
      const proof = f.received()!;
      for (const name of ["caps", "noNewPrivileges", "rootReadOnly", "payloadReadOnly", "noDocker", "noHostStore", "apiDirectBlocked", "metadataBlocked", "noToken"]) expect(proof[name], name).toBe(true);
      expect(proof.uid).toBe(65532);
      expect(proof.envKeys).toEqual(["HOME", "PATH", "TMPDIR", "ZENITH_API_VERSION", "ZENITH_MCP_PATH", "ZENITH_MCP_SOCKET", "ZENITH_URL", "ZENITH_WORKSPACE"]);
      const owned = await f.ownedContainers(); expect(owned).toHaveLength(2);
      const plugin = owned.find((c) => c.Name.endsWith("-process"))!;
      expect(plugin.HostConfig.NetworkMode).toBe("none"); expect(plugin.HostConfig.ReadonlyRootfs).toBe(true);
      expect(plugin.Config.Env.join()).not.toContain(f.input.token);
      const started = Date.now();
      if (mode === "revoke") f.revoke(); else if (mode === "outage") f.outage(); else signal.abort();
      await failure; expect(Date.now() - started).toBeLessThan(20_000);
      expect(await f.ownedContainers()).toHaveLength(0);
      for (const volume of new Set(owned.flatMap((c) => c.Mounts.filter((m) => m.Type === "volume").map((m) => m.Name!)))) {
        await expect(docker(["volume", "inspect", volume])).rejects.toThrow();
      }
    } finally { signal.abort(); await run.catch(() => {}); await f.close(); }
  }, 60_000);
});
