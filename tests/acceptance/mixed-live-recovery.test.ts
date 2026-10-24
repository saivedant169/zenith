/**
 * PROD-MIX-07: the fault proxy and the live recovery drill, LOCAL ENGINE level. The TCP fault proxy and the fixture's real HTTP
 * servers run on loopback, so the blackhole is a real dropped connection and the drill's phases, readbacks and checkpoints run for
 * real. The cloud-side half (revoking a partition connection, a deployed GCP/Azure/AWS app) is faked here and exercised for real only
 * by scripts/acceptance/mixed/live-recovery.ts with ZENITH_LIVE_MIXED=1 and ZENITH_LIVE_MIXED_RECOVERY=1, deferred by the user. A
 * pass in this file is never evidence of a live recovery.
 */
import type { AddressInfo } from "node:net";
import type http from "node:http";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { startFaultProxy, type FaultProxy } from "../../scripts/acceptance/mixed/fault-proxy";
import { loadRecoveryConfig, runRecoveryDrill, type RecoveryConfig, type RecoveryDeps } from "../../scripts/acceptance/mixed/live-recovery";
import { expectedChecksum, expectedPriceCents, type ReadbackSource, type StoredOrder } from "../../scripts/acceptance/mixed/readback";
import { nodeRequester, type Requester } from "../../scripts/acceptance/mixed/traffic";
import { memoryStore } from "../../scripts/release/checkpoint";
import { Scope, loadManifestFile } from "../../scripts/release/scope";
import { createEnricherServer } from "../../fixtures/mixed-app/enricher/server.mjs";
import { createMemoryStore } from "../../fixtures/mixed-app/web/stores.mjs";
import { createWebServer } from "../../fixtures/mixed-app/web/server.mjs";
import { approvedScope, unapprovedShippedFile } from "../release/_support";

const RUN = "zlive-202610071200-abcd";
const NOW = new Date("2026-10-07T12:30:00.000Z");

const listen = (server: http.Server): Promise<number> => new Promise((resolve) => { server.listen(0, "127.0.0.1", () => resolve((server.address() as AddressInfo).port)); });
const close = (server: http.Server): Promise<void> => new Promise((resolve) => { server.closeAllConnections?.(); server.close(() => resolve()); });

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { while (cleanups.length) await cleanups.pop()!(); });

async function stack(): Promise<{ entry: string; store: ReturnType<typeof createMemoryStore> }> {
  const enricher = createEnricherServer({ provider: "aws" });
  const enricherPort = await listen(enricher);
  const store = createMemoryStore();
  const web = createWebServer({ store, env: { ENRICHER_URL: `http://127.0.0.1:${enricherPort}`, WEB_PROVIDER: "gcp", ENRICHER_TIMEOUT_MS: "1500" } as unknown as NodeJS.ProcessEnv });
  const webPort = await listen(web);
  cleanups.push(() => close(web), () => close(enricher));
  return { entry: `http://127.0.0.1:${webPort}`, store };
}

const get = (url: string, via?: { host: string; port: number }, timeoutMs = 1000) => nodeRequester(via)({ method: "GET", url: new URL(url), timeoutMs });

describe("fault proxy (real sockets on loopback)", () => {
  async function echo(): Promise<{ port: number }> {
    const { createServer } = await import("node:http");
    const server = createServer((_req, res) => { res.writeHead(200, { "content-type": "text/plain" }); res.end("ok"); });
    const port = await listen(server);
    cleanups.push(() => close(server));
    return { port };
  }

  it("forwards when passing, swallows when blackholed, resets on demand and heals back", async () => {
    const target = await echo();
    const proxy: FaultProxy = await startFaultProxy({ host: "127.0.0.1", port: target.port });
    cleanups.push(() => proxy.close());
    const via = { host: "127.0.0.1", port: proxy.port };
    expect(proxy.mode()).toBe("pass");
    expect((await get("http://upstream.example.test/", via)).body).toBe("ok");

    proxy.setMode("blackhole");
    await expect(get("http://upstream.example.test/", via, 400)).rejects.toThrow("timeout");
    expect(proxy.stats()).toMatchObject({ forwarded: 1, swallowed: 1 });

    proxy.setMode("reset");
    await expect(get("http://upstream.example.test/", via, 800)).rejects.toThrow();
    expect(proxy.stats().reset).toBe(1);

    proxy.setMode("pass");
    expect((await get("http://upstream.example.test/", via)).status).toBe(200);
  });

  it("destroys the connections it was swallowing when it heals, as a real network would", async () => {
    const target = await echo();
    const proxy = await startFaultProxy({ host: "127.0.0.1", port: target.port }, { initial: "blackhole" });
    cleanups.push(() => proxy.close());
    const pending = get("http://upstream.example.test/", { host: "127.0.0.1", port: proxy.port }, 5000);
    const assertion = expect(pending).rejects.toThrow();
    await new Promise((r) => setTimeout(r, 100));
    proxy.setMode("pass");
    await assertion;
  });

  it("stops accepting connections after close and binds to loopback by default", async () => {
    const target = await echo();
    const proxy = await startFaultProxy({ host: "127.0.0.1", port: target.port });
    expect(proxy.port).toBeGreaterThan(0);
    await proxy.close();
    await expect(get("http://upstream.example.test/", { host: "127.0.0.1", port: proxy.port }, 500)).rejects.toThrow();
  });
});

describe("configuration", () => {
  const ENV = { ZENITH_LIVE_MIXED: "1", ZENITH_LIVE_MIXED_RECOVERY: "1", ZENITH_LIVE_MIXED_FAULT: "blackhole", ZENITH_LIVE_MIXED_RUN_ID: RUN, ZENITH_LIVE_MIXED_ENTRY_URL: "https://app.example.test", ZENITH_LIVE_MIXED_READBACK_DB_URL_FILE: path.resolve("/secure/readback.txt") };
  const skip = (over: Record<string, string | undefined>): string => { const r = loadRecoveryConfig({ ...ENV, ...over }); return "skipReason" in r ? r.skipReason : ""; };

  it("is skipped, with the reason, unless both opt-ins, exactly one known fault and every reference are present", () => {
    expect(skip({ ZENITH_LIVE_MIXED: undefined })).toContain("deferred");
    expect(skip({ ZENITH_LIVE_MIXED_RECOVERY: undefined })).toContain("deferred");
    expect(skip({ ZENITH_LIVE_MIXED_FAULT: undefined })).toContain("exactly one fault");
    expect(skip({ ZENITH_LIVE_MIXED_FAULT: "everything" })).toContain("exactly one fault");
    expect(skip({ ZENITH_LIVE_MIXED_ENTRY_URL: undefined })).toContain("ZENITH_LIVE_MIXED_ENTRY_URL");
    expect(skip({ ZENITH_LIVE_MIXED_RUN_ID: "my-run" })).toContain("live-run id");
    expect(skip({ ZENITH_LIVE_MIXED_READBACK_DB_URL_FILE: "readback.txt" })).toContain("absolute path");
    expect(skip({})).toBe("");
  });

  it("makes revoking a connection hard to do by accident: the id must be confirmed twice and the control plane named", () => {
    const base = { ZENITH_LIVE_MIXED_FAULT: "revoke_connection" };
    expect(skip(base)).toContain("same connection id");
    expect(skip({ ...base, ZENITH_LIVE_MIXED_REVOKE_CONNECTION_ID: "conn_1" })).toContain("same connection id");
    expect(skip({ ...base, ZENITH_LIVE_MIXED_REVOKE_CONNECTION_ID: "conn_1", ZENITH_LIVE_MIXED_CONFIRM_REVOKE: "conn_2" })).toContain("same connection id");
    expect(skip({ ...base, ZENITH_LIVE_MIXED_REVOKE_CONNECTION_ID: "conn_1", ZENITH_LIVE_MIXED_CONFIRM_REVOKE: "conn_1" })).toContain("ZENITH_LIVE_MIXED_API_URL");
    expect(skip({ ...base, ZENITH_LIVE_MIXED_REVOKE_CONNECTION_ID: "conn_1", ZENITH_LIVE_MIXED_CONFIRM_REVOKE: "conn_1", ZENITH_LIVE_MIXED_API_URL: "https://zenith.example.test", ZENITH_LIVE_MIXED_TOKEN_FILE: "token.txt" })).toContain("absolute");
    expect(skip({ ...base, ZENITH_LIVE_MIXED_REVOKE_CONNECTION_ID: "conn_1", ZENITH_LIVE_MIXED_CONFIRM_REVOKE: "conn_1", ZENITH_LIVE_MIXED_API_URL: "https://zenith.example.test", ZENITH_LIVE_MIXED_TOKEN_FILE: path.resolve("/secure/t.txt") })).toBe("");
  });
});

/* ----------------------------------------------------------------- the drill */

function readbackOf(rows: StoredOrder[] | (() => StoredOrder[])): () => Promise<ReadbackSource> {
  const current = (): StoredOrder[] => (typeof rows === "function" ? rows() : rows);
  return async () => ({ describe: () => ({ channel: "direct_database", kind: "postgres", host: "mixed.postgres.database.azure.com" }), fetchByPrefix: async (prefix) => current().filter((r) => r.clientKey.startsWith(prefix)) });
}

function fakeApp(): { rows: StoredOrder[]; requester: Requester; healthy: { value: boolean } } {
  const rows: StoredOrder[] = [];
  const healthy = { value: true };
  const requester: Requester = async (request) => {
    if (!healthy.value) return { status: 503, body: "{}" };
    const order = JSON.parse(request.body!) as { clientKey: string; sku: string; qty: number };
    const priceCents = expectedPriceCents(order.sku, order.qty)!;
    const checksum = expectedChecksum({ ...order, priceCents });
    if (!rows.some((r) => r.clientKey === order.clientKey)) rows.push({ ...order, priceCents, checksum, webProvider: "gcp", enricherProvider: "aws" });
    return { status: 201, body: JSON.stringify({ ...order, priceCents, checksum, webProvider: "gcp", enricherProvider: "aws" }) };
  };
  return { rows, requester, healthy };
}

const config = (over: Partial<RecoveryConfig> = {}): RecoveryConfig => ({ runId: RUN, fault: "blackhole", entryUrl: "http://127.0.0.1:1", readbackUrlFile: "/unused", dbHostSuffix: ".postgres.database.azure.com", orders: 4, outDir: mkdtempSync(path.join(os.tmpdir(), "zrecov-")), ...over });
const deps = (over: RecoveryDeps = {}): RecoveryDeps => ({ scope: approvedScope(undefined, NOW), store: memoryStore(), now: () => NOW, env: {}, ...over });

describe("the blackhole drill against the fixture's real servers", () => {
  it("serves, loses nothing it acknowledged while the client path is blackholed, reports the writes as uncertain, and serves again after healing", async () => {
    const live = await stack();
    const report = await runRecoveryDrill(config({ entryUrl: live.entry }), deps({ readback: readbackOf(() => live.store.all() as StoredOrder[]) }));
    expect(report.phases.map((p) => [p.phase, p.ok])).toEqual([["base", true], ["fault", true], ["heal", true]]);
    expect(report.phases[0]!.counts).toMatchObject({ acknowledged: 4, uncertain: 0 });
    expect(report.phases[1]!.counts).toMatchObject({ acknowledged: 0, uncertain: 4 });
    expect(report.phases[2]!.counts).toMatchObject({ acknowledged: 4, uncertain: 0 });
    expect(report).toMatchObject({ ok: true, fault: "blackhole", irreversible: false, provenance: "live" });
    // the blackholed phase reached nothing: only the base and heal writes exist
    expect(live.store.all()).toHaveLength(8);
    expect(live.store.all().some((r: StoredOrder) => r.clientKey.startsWith(`${RUN}-fault-`))).toBe(false);
  }, 30_000);

  it("injects no fault when the baseline is not clean", async () => {
    const app = fakeApp();
    app.healthy.value = false;
    const report = await runRecoveryDrill(config(), deps({ requester: app.requester, readback: readbackOf(app.rows) }));
    expect(report.ok).toBe(false);
    expect(report.phases.map((p) => p.phase)).toEqual(["base"]);
    expect(report.phases[0]!.problems.join(" ")).toContain("No write was acknowledged in the baseline");
  });
});

describe("the revoke-connection drill (control plane faked)", () => {
  const revokeConfig = (): RecoveryConfig => config({ fault: "revoke_connection", apiUrl: "https://zenith.example.test", tokenFile: path.resolve("/secure/token.txt"), revokeConnectionId: "conn_run_1" });

  function controlPlane(status: string): { post: (p: string) => Promise<unknown>; get: (p: string) => Promise<unknown>; calls: string[] } {
    const calls: string[] = [];
    return { calls, post: async (p) => { calls.push(`POST ${p}`); return {}; }, get: async (p) => { calls.push(`GET ${p}`); return { status }; } };
  }

  it("revokes through the control plane's own API, confirms it, proves the application kept serving and calls it irreversible", async () => {
    const app = fakeApp();
    const cp = controlPlane("revoked");
    const report = await runRecoveryDrill(revokeConfig(), deps({ requester: app.requester, readback: readbackOf(app.rows), post: cp.post, get: cp.get }));
    expect(cp.calls).toEqual(["POST /api/platform/v1/connections/conn_run_1/revoke", "GET /api/platform/v1/connections/conn_run_1"]);
    expect(report.phases.map((p) => p.phase)).toEqual(["base", "fault"]);
    expect(report).toMatchObject({ ok: true, irreversible: true, fault: "revoke_connection" });
    expect(report.nextCommands.join(" ")).toContain("replacement connection");
    expect(app.rows).toHaveLength(8);
  });

  it("fails when the revocation cannot be confirmed or the application stopped serving", async () => {
    const a = fakeApp();
    const notConfirmed = await runRecoveryDrill(revokeConfig(), deps({ requester: a.requester, readback: readbackOf(a.rows), post: controlPlane("verified").post, get: controlPlane("verified").get }));
    expect(notConfirmed.ok).toBe(false);
    expect(notConfirmed.phases[1]!.problems.join(" ")).toContain('reads back as "verified"');

    const b = fakeApp();
    const cp = controlPlane("revoked");
    const stopped = await runRecoveryDrill(revokeConfig(), deps({ requester: async (r) => { if (cp.calls.length) b.healthy.value = false; return b.requester(r); }, readback: readbackOf(b.rows), post: cp.post, get: cp.get }));
    expect(stopped.ok).toBe(false);
    expect(stopped.phases[1]!.problems.join(" ")).toContain("stopped serving");
  });

  it("reports an API failure as a failed phase, never as success", async () => {
    const app = fakeApp();
    const report = await runRecoveryDrill(revokeConfig(), deps({ requester: app.requester, readback: readbackOf(app.rows), post: async () => { throw new Error("The control plane answered 403 for POST /api/platform/v1/connections/x/revoke."); }, get: async () => ({ status: "verified" }) }));
    expect(report.ok).toBe(false);
    expect(report.phases[1]!.problems.join(" ")).toContain("Revocation could not be completed");
  });
});

describe("scope", () => {
  it("refuses without an approved scope before any traffic or fault", async () => {
    const app = fakeApp();
    await expect(runRecoveryDrill(config(), deps({ scope: new Scope(loadManifestFile(unapprovedShippedFile()), () => NOW), requester: app.requester }))).rejects.toMatchObject({ code: "not_approved" });
    expect(app.rows).toEqual([]);
  });

  it("refuses when the approved scope does not grant fault injection", async () => {
    const app = fakeApp();
    const scope = approvedScope((raw) => { const h = raw.harnesses as Record<string, { actions: string[] }>; h["mixed-recovery-live"]!.actions = h["mixed-recovery-live"]!.actions.filter((a) => a !== "inject_fault"); }, NOW);
    await expect(runRecoveryDrill(config(), deps({ scope, requester: app.requester }))).rejects.toMatchObject({ code: "action_not_granted" });
    expect(app.rows).toEqual([]);
  });
});
