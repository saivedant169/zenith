/**
 * Actual owning PostgreSQL rows and encrypted tenant file vault through the
 * default broker. Only namespaced API responses are modeled: this is neither
 * hosted vault proof nor TLS, RBAC, browser approval or live cluster acceptance.
 */
import { randomUUID } from "node:crypto";
import { dump as yamlDump } from "js-yaml";
import { KubeConfig } from "@kubernetes/client-node";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { KubernetesConnectionConfig, ProviderSession } from "@/lib/credentials/types";
import type { CapabilityGrantClaims } from "@/lib/controlplane/types";
import { tempDataDir } from "../_support/data-dir";

tempDataDir("zenith-native-vault-target-", { fast: true });
const api = vi.hoisted(() => ({ sessions: [] as ProviderSession[], read: vi.fn() }));
vi.mock("@/lib/providers/kubernetes/client", () => ({ createK8sClient: (session: ProviderSession) => {
  api.sessions.push(session); return { core: { readNamespacedServiceAccount: api.read } };
} }));
const { openPlatformDb, repos, PLATFORM_SCHEMA_VERSION } = await import("@/lib/controlplane/db");
const { platformCredentialBroker } = await import("@/lib/platform/credentials");
const vault = await import("@/lib/secrets");
const { PG_URL } = await import("../controlplane/_support/harness");
if (process.env.ZENITH_TEST_KUBERNETES_VAULT_TARGET_REQUIRED === "1") {
  if (!PG_URL) throw new Error("Kubernetes vault target acceptance requires owned PostgreSQL.");
  if (PLATFORM_SCHEMA_VERSION < 13) throw new Error("Kubernetes vault target acceptance requires the canonical registered schema13.");
}

const CANARY = "native-vault-target-credential-canary";
const CA = Buffer.from("modeled-public-ca-target-bytes").toString("base64");
const refs: { workspaceId: string; ref: string }[] = [];
function document(config: KubernetesConnectionConfig) {
  return { apiVersion: "v1", kind: "Config", "current-context": "bound",
    clusters: [{ name: "cluster", cluster: { server: config.server, "certificate-authority-data": config.caData } as Record<string, unknown> }],
    contexts: [{ name: "bound", context: { cluster: "cluster", user: "reader" } }],
    users: [{ name: "reader", user: { token: CANARY } }] };
}
function barrier() { let release!: () => void; const promise = new Promise<void>(resolve => { release = resolve; }); return { promise, release }; }

// A missing local prerequisite stays visible; the required lane throws above before opening a pool.
describe.skipIf(!PG_URL)("default Kubernetes vault target binding [postgres; modeled API boundary]", () => {
  let db: Awaited<ReturnType<typeof openPlatformDb>>, peer: Awaited<ReturnType<typeof openPlatformDb>>;
  beforeAll(async () => {
    db = await openPlatformDb({ kind: "postgres", url: PG_URL, migrate: true, max: 1 });
    try { peer = await openPlatformDb({ kind: "postgres", url: PG_URL, migrate: true, max: 1 }); }
    catch (error) { await db.close(); throw error; }
    const left = await db.query<{ pid: number }>("select pg_backend_pid() as pid"), right = await peer.query<{ pid: number }>("select pg_backend_pid() as pid");
    expect(left[0].pid).not.toBe(right[0].pid);
  }, 60_000);
  beforeEach(() => {
    vi.stubEnv("ZENITH_STORE", "file"); vi.stubEnv("ZENITH_SECRET_KEY", "1".repeat(64));
    api.sessions.length = 0; api.read.mockReset().mockImplementation(async ({ name, namespace }) => ({ metadata: { name, namespace } }));
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    try { for (const own of refs.splice(0)) await vault.removeSecretAsync(own.workspaceId, own.ref); }
    finally { vi.unstubAllEnvs(); }
  });
  afterAll(async () => { try { await peer?.close(); } finally { await db?.close(); } });

  async function fixture(value?: (config: KubernetesConnectionConfig) => string, secretWorkspace?: string) {
    const workspaceId = `ws-vault-target-${randomUUID()}`, ref = `vault:target/${randomUUID()}/KUBECONFIG`;
    const config: KubernetesConnectionConfig = { provider: "kubernetes", mode: "kubeconfig_ref", server: "https://cluster.example.test", caData: CA, credentialRef: ref, namespaces: ["orders", "payments"] };
    const connection = await repos.connections.create(db, { workspaceId, config, createdBy: "native-target-fixture" });
    const owner = secretWorkspace ?? workspaceId;
    await vault.putSecretAsync(owner, ref, value ? value(config) : yamlDump(document(config), { noRefs: true }), "native-target-fixture");
    refs.push({ workspaceId: owner, ref });
    return { workspaceId, ref, config, connection, credentials: platformCredentialBroker(db) };
  }
  async function safe(f: Awaited<ReturnType<typeof fixture>>, value: unknown) {
    expect(JSON.stringify(value)).not.toContain(CANARY);
    expect(JSON.stringify(await repos.connections.list(db, f.workspaceId))).not.toContain(CANARY);
    expect(JSON.stringify(await repos.events.list(db, f.workspaceId))).not.toContain(CANARY);
  }
  async function verified(f: Awaited<ReturnType<typeof fixture>>) {
    const result = await f.credentials.verifyConnection(f.connection.id, { workspaceId: f.workspaceId });
    expect(result.ok).toBe(true);
    expect(await repos.connections.recordVerification(db, { workspaceId: f.workspaceId, id: f.connection.id, ok: result.ok, detail: result.detail })).toMatchObject({ status: "verified" });
    api.read.mockClear(); api.sessions.length = 0;
  }
  function grant(f: Awaited<ReturnType<typeof fixture>>): CapabilityGrantClaims {
    const now = Math.floor(Date.now() / 1000);
    // Explicit upstream grant model; no claim of canonical human/policy issuance.
    return { jti: randomUUID(), iss: "target-fixture", aud: "worker", sub: "user:fixture", iat: now - 1, exp: now + 600,
      cap: "container.list", ws: f.workspaceId, op: `op-target-${randomUUID()}`, env: "env-target", digest: "a".repeat(64) };
  }

  it("a full tenant-sealed kubeconfig reaches every modeled namespace read without recording automatic verification", async () => {
    const f = await fixture(); const result = await f.credentials.verifyConnection(f.connection.id, { workspaceId: f.workspaceId });
    expect(result.ok).toBe(true);
    expect(api.read.mock.calls.map(([args]) => args)).toEqual([{ name: "default", namespace: "orders" }, { name: "default", namespace: "payments" }]);
    expect((await repos.connections.get(db, f.workspaceId, f.connection.id))?.status).toBe("pending_verification");
    const held = api.sessions[0]; expect(held.provider).toBe("kubernetes");
    if (held.provider === "kubernetes") expect(() => held.kubeConfig()).toThrow("ended");
    await safe(f, result);
  });
  it("the same verified native target admits one callback and closes its retained accessor", async () => {
    const f = await fixture(); await verified(f); let held: ProviderSession | undefined;
    const callback = vi.fn(async (session: ProviderSession) => {
      held = session; expect(session.provider).toBe("kubernetes");
      if (session.provider === "kubernetes") {
        const selected = session.kubeConfig(); expect(selected).toBeInstanceOf(KubeConfig);
        if (!(selected instanceof KubeConfig)) throw new Error("The target fixture did not obtain the native KubeConfig.");
        expect(selected.getCurrentCluster()?.server).toBe(f.config.server);
      }
      return { admitted: true };
    });
    expect(await f.credentials.withSession({ connectionId: f.connection.id, purpose: "observe", grant: grant(f) }, callback)).toEqual({ admitted: true });
    expect(callback).toHaveBeenCalledOnce(); expect(api.read).not.toHaveBeenCalled();
    const retained = held;
    if (retained?.provider === "kubernetes") expect(() => retained.kubeConfig()).toThrow("ended");
    await safe(f, held);
  });
  it.each(["raw token", "different server", "different CA", "unknown context", "insecure cluster override"])("native verification refuses %s before API admission", async mode => {
    const f = await fixture(config => {
      if (mode === "raw token") return CANARY;
      const d = document(config);
      if (mode === "different server") d.clusters[0].cluster.server = "https://foreign.example.test";
      if (mode === "different CA") d.clusters[0].cluster["certificate-authority-data"] = Buffer.from("foreign-public-ca").toString("base64");
      if (mode === "unknown context") d["current-context"] = "absent";
      if (mode === "insecure cluster override") d.clusters[0].cluster["insecure-skip-tls-verify"] = true;
      return yamlDump(d, { noRefs: true });
    });
    const result = await f.credentials.verifyConnection(f.connection.id, { workspaceId: f.workspaceId });
    expect(result).toEqual({ ok: false, detail: "Kubernetes credential or token minter is missing or invalid." });
    expect(api.read).not.toHaveBeenCalled(); expect(api.sessions).toHaveLength(0);
    expect((await repos.connections.get(db, f.workspaceId, f.connection.id))?.status).toBe("pending_verification");
    expect((await repos.events.list(db, f.workspaceId)).some(event => event.type === "credential.assumed")).toBe(false);
    await safe(f, result);
  });
  it("refuses a provider session for a stored grant revoked since issue, before any credential is resolved", async () => {
    const f = await fixture(); await verified(f); const g = grant(f);
    await repos.operations.create(db, { id: g.op, workspaceId: f.workspaceId, principal: { kind: "user", id: "fixture-admin", name: "Fixture" },
      proposal: { capability: g.cap, scope: { workspaceId: f.workspaceId }, input: {}, summary: "Revoked grant fixture", details: [], risk: "low" } });
    await repos.grants.insert(db, { jti: g.jti, workspaceId: f.workspaceId, operationId: g.op, capability: g.cap, audience: "worker",
      issuedAt: new Date(g.iat * 1000).toISOString(), expiresAt: new Date(g.exp * 1000).toISOString() });
    const callback = vi.fn(async () => "entered");
    expect(await f.credentials.withSession({ connectionId: f.connection.id, purpose: "observe", grant: g }, callback)).toBe("entered");
    expect(await repos.grants.revoke(db, f.workspaceId, g.jti)).toBe(true);
    await expect(f.credentials.withSession({ connectionId: f.connection.id, purpose: "observe", grant: g }, callback)).rejects.toMatchObject({ reason: "grant_revoked" });
    expect(callback).toHaveBeenCalledOnce();
  });

  it("a same-named foreign sealed value never supplies the owning target or credential", async () => {
    const f = await fixture(undefined, `ws-foreign-vault-${randomUUID()}`);
    expect(await vault.readSecretValueAsync(f.workspaceId, f.ref)).toBeUndefined();
    const result = await f.credentials.verifyConnection(f.connection.id, { workspaceId: f.workspaceId });
    expect(result.ok).toBe(false); expect(api.read).not.toHaveBeenCalled(); expect(api.sessions).toHaveLength(0); await safe(f, result);
  });
  it("a revoked native connection never resolves a stored bound credential or reactivates", async () => {
    const f = await fixture(); await verified(f); await repos.connections.revoke(peer, f.workspaceId, f.connection.id);
    const read = vi.spyOn(vault, "readSecretValueAsync");
    const result = await f.credentials.verifyConnection(f.connection.id, { workspaceId: f.workspaceId });
    expect(result).toEqual({ ok: false, detail: "Connection revoked." }); expect(read).not.toHaveBeenCalled(); expect(api.read).not.toHaveBeenCalled();
    expect(await repos.connections.recordVerification(db, { workspaceId: f.workspaceId, id: f.connection.id, ok: true, detail: "Rejected lifecycle control." })).toBeNull();
    expect((await repos.connections.get(db, f.workspaceId, f.connection.id))?.status).toBe("revoked"); await safe(f, result);
  });
  it.each(["vault unchanged", "vault server drift", "vault CA drift", "vault revocation", "audit unchanged", "audit server drift", "audit CA drift", "audit revocation"])(
    "native callback recaptures current scope after %s", async label => {
      const f = await fixture(); await verified(f);
      const entered = barrier(), release = barrier(), phase = label.startsWith("vault") ? "vault" : "audit";
      if (phase === "vault") {
        const original = vault.readSecretValueAsync;
        vi.spyOn(vault, "readSecretValueAsync").mockImplementation(async (...args) => {
          const value = await original(...args);
          if (args[0] === f.workspaceId && args[1] === f.ref) { entered.release(); await release.promise; }
          return value;
        });
      } else {
        const original = repos.events.append;
        vi.spyOn(repos.events, "append").mockImplementation(async (sql, event) => {
          const value = await original(sql, event);
          if (event.type === "credential.assumed" && event.data?.connectionId === f.connection.id) { entered.release(); await release.promise; }
          return value;
        });
      }
      const callback = vi.fn(async (session: ProviderSession) => {
        if (session.provider !== "kubernetes") throw new Error("Unexpected target fixture provider.");
        expect(session.kubeConfig()).toBeDefined(); return { admitted: true };
      });
      const pending = f.credentials.withSession({ connectionId: f.connection.id, purpose: "observe", grant: grant(f) }, callback)
        .then(value => ({ value }), error => ({ error }));
      let observationFailure: unknown;
      try {
        await Promise.race([entered.promise, pending.then(() => { throw new Error("Session completed before the native target barrier."); })]);
        expect(callback).not.toHaveBeenCalled();
        if (label.endsWith("revocation")) await repos.connections.revoke(peer, f.workspaceId, f.connection.id);
        if (label.endsWith("server drift") || label.endsWith("CA drift")) {
          const changed = label.endsWith("server drift") ? { ...f.config, server: "https://foreign.example.test" }
            : { ...f.config, caData: Buffer.from("foreign-public-ca").toString("base64") };
          await peer.query("update platform.provider_connections set config=$3::text::jsonb where workspace_id=$1 and id=$2", [f.workspaceId, f.connection.id, JSON.stringify(changed)]);
          expect((await repos.connections.get(peer, f.workspaceId, f.connection.id))?.config).toEqual(changed);
        }
        if (label.endsWith("revocation")) expect((await repos.connections.get(peer, f.workspaceId, f.connection.id))?.status).toBe("revoked");
      } catch (error) { observationFailure = error; }
      finally { release.release(); }
      const result = await pending;
      if (observationFailure) throw observationFailure;
      if (label.endsWith("unchanged")) { expect(result).toEqual({ value: { admitted: true } }); expect(callback).toHaveBeenCalledOnce(); }
      else { expect(result).toHaveProperty("error"); expect(callback).not.toHaveBeenCalled(); }
      expect(api.read).not.toHaveBeenCalled(); await safe(f, result);
    });
});
