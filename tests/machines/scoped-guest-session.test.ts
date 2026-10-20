/**
 * PROD-MACH-02 default guest path through the REAL stack: PGlite repositories, encrypted tenant vault,
 * the platform credential broker, the machine session provider and the connection revocation service.
 * ONLY the Kubernetes API boundary is modeled (an in-memory GuestClusterPort substituted for
 * createGuestClusterPort); no live TLS/RBAC claim is made here. The real API server is covered by
 * tests/machines/kubernetes-guest-scoped-kind.test.ts.
 */
import { randomUUID } from "node:crypto";
import { inspect } from "node:util";
import { dump as yamlDump } from "js-yaml";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { KubernetesConnectionConfig, ProviderConnection } from "@/lib/credentials/types";
import type { AccessAttributes, GuestClusterPort } from "@/lib/providers/kubernetes/guest";
import type { KubernetesMachineSession, MachineOperation, MachineSessionRequest } from "@/lib/machines/types";
import { tempDataDir } from "../_support/data-dir";
import { T0, grantFor, requestFor } from "./_helpers";

const model = vi.hoisted(() => ({ current: undefined as undefined | { port: unknown } }));
vi.mock("@/lib/providers/kubernetes/guest", async (original) => ({
  ...(await original<typeof import("@/lib/providers/kubernetes/guest")>()),
  createGuestClusterPort: () => { if (!model.current) throw new Error("no modeled cluster"); return model.current.port; },
}));

tempDataDir("zenith-scoped-guest-", { fast: true });
const { openPlatformDb, repos } = await import("@/lib/controlplane/db");
const { platformCredentialBroker, revokeKubernetesGuestBindings } = await import("@/lib/platform/credentials");
const { createMachineSessionProvider } = await import("@/lib/machines/sessions");
const { generateSigningJwk, LocalJwkSigner } = await import("@/lib/credentials/signing");
const { signCapabilityGrant, verifyCapabilityGrant } = await import("@/lib/credentials/grants");
const { guestObjectName, guestHash } = await import("@/lib/providers/kubernetes/guest");
const vault = await import("@/lib/secrets");
type KubeConfig = import("@kubernetes/client-node").KubeConfig;

let db: Awaited<ReturnType<typeof openPlatformDb>>;
let key: Awaited<ReturnType<typeof generateSigningJwk>>;
let signer: ReturnType<typeof LocalJwkSigner.fromJwk>;
const MODEL_CA = Buffer.from("modeled-public-kubernetes-ca").toString("base64");
const MINTER_CANARY = "minter-credential-canary-value";
const boundKubeconfig = (server: string, token: string) => yamlDump({ apiVersion: "v1", kind: "Config", "current-context": "bound",
  clusters: [{ name: "bound-cluster", cluster: { server, "certificate-authority-data": MODEL_CA } }],
  contexts: [{ name: "bound", context: { cluster: "bound-cluster", user: "bound-user" } }], users: [{ name: "bound-user", user: { token } }] }, { noRefs: true });
const jwt = (claims: Record<string, unknown>) => { const p = (v: unknown) => Buffer.from(JSON.stringify(v)).toString("base64url"); return `${p({ alg: "RS256" })}.${p(claims)}.${Buffer.from("sig-bytes").toString("base64url")}`; };

function modeledCluster(over: { allow?: (a: AccessAttributes) => boolean; failToken?: boolean; failDelete?: boolean } = {}) {
  const calls: string[] = [];
  const port: GuestClusterPort = {
    async allowed(a) { calls.push("allowed"); return over.allow ? over.allow(a) : !!a.namespace && a.namespace !== "kube-system" && a.verb !== "*"; },
    async ensureServiceAccount(ns, name) { calls.push(`sa:${ns}:${name}`); return { uid: `uid-${name}` }; },
    async ensureRole(ns, name) { calls.push(`role:${ns}:${name}`); },
    async ensureRoleBinding(ns, name) { calls.push(`rb:${ns}:${name}`); },
    async requestToken(ns, name, uid, aud, ttl) {
      calls.push(`token:${ns}:${name}`);
      if (over.failToken) throw new Error("modeled API failure");
      return { token: jwt({ sub: `system:serviceaccount:${ns}:${name}`, aud: aud.length ? aud : ["modeled-audience"], exp: Math.floor(T0 / 1000) + ttl, "kubernetes.io": { serviceaccount: { uid } } }), expiresAt: new Date(T0 + ttl * 1000).toISOString() };
    },
    async deleteGuestObjects(ns, name) { calls.push(`delete:${ns}:${name}`); if (over.failDelete) throw new Error("modeled delete failure"); },
  };
  model.current = { port };
  return { calls, port };
}

beforeAll(async () => {
  db = await openPlatformDb({ kind: "pglite" });
  key = await generateSigningJwk("EdDSA");
  signer = LocalJwkSigner.fromJwk("scoped-guest-fixture", key.privateJwk, { alg: "EdDSA" });
});
beforeEach(() => { vi.stubEnv("ZENITH_SECRET_KEY", "1".repeat(64)); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); model.current = undefined; });
afterAll(async () => { await db.close(); });

async function fixture(operation: MachineOperation = "container.list", targetId = "app/pod-1", mode: KubernetesConnectionConfig["mode"] = "scoped_guest") {
  const suffix = randomUUID(), workspaceId = `ws-sg-${suffix}`, operationId = `op-sg-${suffix}`, environmentId = `env-sg-${suffix}`, resourceId = `res-sg-${suffix}`;
  const credentialRef = `vault:minter/${suffix}/KUBE_TOKEN`;
  const config: KubernetesConnectionConfig = { provider: "kubernetes", mode, server: "https://cluster.example.test", caData: MODEL_CA, credentialRef, namespaces: ["app", "other"] };
  const created = await repos.connections.create(db, { workspaceId, config, createdBy: "scoped-guest-fixture" });
  await repos.connections.recordVerification(db, { workspaceId, id: created.id, ok: true, detail: "fixture" });
  const connection = (await repos.connections.get(db, workspaceId, created.id))!;
  await vault.putSecretAsync(workspaceId, credentialRef, boundKubeconfig(config.server, MINTER_CANARY), "scoped-guest-fixture");
  const now = () => new Date(T0);
  const jws = await signCapabilityGrant(grantFor(operation, { ws: workspaceId, op: operationId, env: environmentId, res: resourceId }), { signer });
  const grant = await verifyCapabilityGrant(jws, { audience: "worker", expectedCapability: operation, expectedOperationId: operationId, now: now(), keys: [key.publicJwk] });
  const target = requestFor(operation, {}, { transport: "kubernetes", targetId, operationId,
    target: { workspaceId, environmentId, resourceId, address: "compute_instance/guest", transport: "kubernetes", targetId } }).target;
  const request: MachineSessionRequest = { target, operation, operationId, grant };
  const credentials = platformCredentialBroker(db, { now });
  const provider = (captured: ProviderConnection = connection) => createMachineSessionProvider({ credentials, connection: captured, grantJws: jws, now });
  return { workspaceId, connection, config, request, credentials, provider, now, grant };
}
const bindings = (f: { workspaceId: string; connection: ProviderConnection }) => repos.k8sGuestBindings.listForConnection(db, f.workspaceId, f.connection.id);
const safe = (value: unknown) => { expect(JSON.stringify(value)).not.toContain(MINTER_CANARY); expect(inspect(value)).not.toContain(MINTER_CANARY); };

describe("scoped Kubernetes guest sessions through the default stack", () => {
  it.each([["container.list", "read"], ["container.logs", "read"], ["container.exec", "exec"], ["file.read", "exec"]] as const)("%s mints a %s token for the target namespace only", async (operation, profile) => {
    const f = await fixture(operation), cluster = modeledCluster();
    let held!: KubernetesMachineSession;
    await f.provider().withSession(f.request, async (value) => {
      held = value as KubernetesMachineSession;
      expect(held.namespaces).toEqual(["app"]);
      const kc = held.kubeConfig() as KubeConfig;
      expect(kc.getCurrentCluster()?.server).toBe(f.config.server);
      const token = kc.getCurrentUser()?.token ?? "";
      expect(token).not.toBe(MINTER_CANARY);
      expect(JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString()).sub).toBe(`system:serviceaccount:app:${guestObjectName(f.workspaceId, f.connection.id, profile)}`);
      safe(held);
    });
    expect(cluster.calls.filter((c) => c.startsWith("token:"))).toEqual([`token:app:${guestObjectName(f.workspaceId, f.connection.id, profile)}`]);
    expect(cluster.calls.every((c) => !c.includes(":other:"))).toBe(true);
    const rows = await bindings(f);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ namespace: "app", profile, status: "active", issuedCount: 1 });
    expect(() => held.kubeConfig()).toThrow(/ended/);
    safe(await repos.events.list(db, f.workspaceId));
    safe(rows);
  });

  it("a namespace outside the connection allowlist is refused before the broker or cluster is touched", async () => {
    const f = await fixture("container.list", "elsewhere/pod-1"), cluster = modeledCluster(), spy = vi.spyOn(f.credentials, "withSession");
    await expect(f.provider().withSession(f.request, async () => "entered")).rejects.toMatchObject({ code: "denied" });
    expect(spy).not.toHaveBeenCalled();
    expect(cluster.calls).toEqual([]);
    const sys = await fixture("container.list", "kube-system/etcd");
    await expect(sys.provider().withSession(sys.request, async () => "entered")).rejects.toMatchObject({ code: "denied" });
  });

  it("an over-privileged minter is refused with no token, no objects and no fallback", async () => {
    const f = await fixture("container.exec"), cluster = modeledCluster({ allow: () => true });
    await expect(f.provider().withSession(f.request, async () => "entered")).rejects.toMatchObject({ code: "denied" });
    expect(cluster.calls.some((c) => c.startsWith("token:") || c.startsWith("sa:") || c.startsWith("role:"))).toBe(false);
    expect(await bindings(f)).toEqual([]);
    const denied = (await repos.events.list(db, f.workspaceId)).filter((e) => e.type === "credential.denied");
    expect(denied).toEqual([expect.objectContaining({ data: expect.objectContaining({ reason: "guest_credential_refused" }) })]);
  });

  it("a failed TokenRequest refuses the dispatch; the minter credential is never handed over", async () => {
    const f = await fixture(), cluster = modeledCluster({ failToken: true });
    let entered = false;
    await expect(f.provider().withSession(f.request, async (s) => { entered = true; safe(s); return "entered"; })).rejects.toMatchObject({ code: "denied" });
    expect(entered).toBe(false);
    expect(cluster.calls.some((c) => c.startsWith("token:"))).toBe(true);
    expect((await bindings(f))[0]).toMatchObject({ issuedCount: 0, lastError: "cluster_error" });
  });

  it("without a deployer part the broker refuses deploy/observe (no minter fallback); a bad guest scope stays a guest refusal", async () => {
    const f = await fixture(), cluster = modeledCluster();
    await expect(f.credentials.withSession({ connectionId: f.connection.id, grant: f.request.grant, purpose: "observe" }, async () => "entered"))
      .rejects.toMatchObject({ name: "CredentialDeniedError", reason: "deployer_credential_refused" });
    await expect(f.credentials.withSession({ connectionId: f.connection.id, grant: f.request.grant, purpose: "observe", kubernetesGuest: { namespace: "elsewhere", profile: "read" } }, async () => "entered"))
      .rejects.toMatchObject({ reason: "guest_credential_refused" });
    expect(cluster.calls).toEqual([]);
  });

  it("the broker refuses a guest request on a legacy kubeconfig_ref connection instead of serving the broad credential", async () => {
    const f = await fixture("container.list", "app/pod-1", "kubeconfig_ref"), cluster = modeledCluster();
    let entered = false;
    await expect(f.credentials.withSession({ connectionId: f.connection.id, grant: f.request.grant, purpose: "observe", kubernetesGuest: { namespace: "app", profile: "read" } }, async (session) => { entered = true; safe(session); return "entered"; }))
      .rejects.toMatchObject({ name: "CredentialDeniedError", reason: "guest_credential_refused" });
    expect(entered).toBe(false);
    expect(cluster.calls).toEqual([]);
    expect(await bindings(f)).toEqual([]);
  });

  it("the captured test credential adapter cannot serve a scoped_guest connection", async () => {
    const f = await fixture();
    const provider = createMachineSessionProvider({ credentials: f.credentials, connection: f.connection, grantJws: "", now: f.now,
      kubernetes: { resolveCredential: async () => "adapter-token-value-123" } });
    await expect(provider.withSession(f.request, async () => "entered")).rejects.toMatchObject({ code: "denied" });
  });

  it("revocation: bindings stop minting in the same commit, then cluster objects are deleted and in-flight sessions end", async () => {
    const f = await fixture("container.exec"), cluster = modeledCluster();
    let inflight!: KubernetesMachineSession;
    await f.provider().withSession(f.request, async (s) => { inflight = s as KubernetesMachineSession; });
    await repos.connections.revokeAudited(db, { workspaceId: f.workspaceId, id: f.connection.id, actorId: "admin", reason: "test" });
    expect((await bindings(f)).map((b) => b.status)).toEqual(["revoking"]);
    // New dispatch with a connection captured before revocation: refused by status gates, no new token.
    const tokensBefore = cluster.calls.filter((c) => c.startsWith("token:")).length;
    await expect(f.provider().withSession(f.request, async () => "entered")).rejects.toMatchObject({ code: "denied" });
    expect(cluster.calls.filter((c) => c.startsWith("token:")).length).toBe(tokensBefore);
    expect(() => inflight.kubeConfig()).toThrow(/ended/);
    const revoked = (await repos.connections.get(db, f.workspaceId, f.connection.id))!;
    expect(await revokeKubernetesGuestBindings(db, revoked, { now: f.now })).toEqual({ revoked: 1, pending: 0, attempted: true });
    expect(cluster.calls.filter((c) => c.startsWith("delete:"))).toEqual([`delete:app:${guestObjectName(f.workspaceId, f.connection.id, "exec")}`]);
    expect((await bindings(f)).map((b) => b.status)).toEqual(["revoked"]);
    expect(await revokeKubernetesGuestBindings(db, revoked, { now: f.now })).toEqual({ revoked: 0, pending: 0, attempted: true });
  });

  it("revocation with an unreachable cluster leaves bindings revoking and unmintable, then retries", async () => {
    const f = await fixture(), failing = modeledCluster({ failDelete: true });
    await f.provider().withSession(f.request, async () => undefined);
    await repos.connections.revoke(db, f.workspaceId, f.connection.id);
    const revoked = (await repos.connections.get(db, f.workspaceId, f.connection.id))!;
    expect(await revokeKubernetesGuestBindings(db, revoked, { now: f.now })).toEqual({ revoked: 0, pending: 1, attempted: true });
    expect((await bindings(f))[0]).toMatchObject({ status: "revoking", lastError: "cluster_error" });
    modeledCluster();
    expect(failing.calls.length).toBeGreaterThan(0);
    expect(await revokeKubernetesGuestBindings(db, revoked, { now: f.now })).toEqual({ revoked: 1, pending: 0, attempted: true });
  });

  it("legacy kubeconfig_ref guest sessions are refused with migration guidance: no broad credential is handed out", async () => {
    const f = await fixture("container.list", "app/pod-1", "kubeconfig_ref"), cluster = modeledCluster(), read = vi.spyOn(vault, "readSecretValueAsync");
    let entered = false;
    const error = await f.provider().withSession(f.request, async () => { entered = true; }).then(() => undefined, (e: unknown) => e) as Error & { code?: string };
    expect(error.code).toBe("denied");
    expect(error.message).toMatch(/guest_credential_refused.*convertToScopedGuest/);
    expect(entered).toBe(false);
    expect(read).not.toHaveBeenCalled();
    expect(cluster.calls).toEqual([]);
    expect(await bindings(f)).toEqual([]);
    expect(await revokeKubernetesGuestBindings(db, f.connection)).toEqual({ revoked: 0, pending: 0, attempted: false });
  });

  it("conversion through rotate: patch needs a different minter ref, candidate verifies as a minter, promote switches mode", async () => {
    const f = await fixture("container.list", "app/pod-1", "kubeconfig_ref");
    const { applyRotationPatch, LifecycleInputError } = await import("@/lib/connections/schemas");
    const live = f.connection.config as KubernetesConnectionConfig;
    expect(() => applyRotationPatch(live, { convertToScopedGuest: true })).toThrow(LifecycleInputError);
    expect(() => applyRotationPatch(live, { convertToScopedGuest: true, credentialRef: live.credentialRef })).toThrow(LifecycleInputError);
    const minterRef = `vault:minter-new/${randomUUID()}/KUBE_TOKEN`;
    await vault.putSecretAsync(f.workspaceId, minterRef, boundKubeconfig(live.server, MINTER_CANARY), "scoped-guest-fixture");
    const candidate = applyRotationPatch(live, { convertToScopedGuest: true, credentialRef: minterRef }) as KubernetesConnectionConfig;
    expect(candidate).toMatchObject({ mode: "scoped_guest", credentialRef: minterRef, namespaces: live.namespaces });
    const staged = (await repos.connectionRotations.stage(db, { workspaceId: f.workspaceId, connectionId: f.connection.id, candidateConfig: candidate, createdBy: "admin" }))!;
    // An over-privileged minter candidate does not verify and cannot be promoted.
    modeledCluster({ allow: () => true });
    const broker = platformCredentialBroker(db, { now: f.now, verifyCandidate: { workspaceId: f.workspaceId, connectionId: f.connection.id, config: candidate } });
    const bad = await broker.verifyConnection(f.connection.id, { workspaceId: f.workspaceId });
    expect(bad.ok).toBe(false);
    await repos.connectionRotations.recordCandidateVerification(db, { workspaceId: f.workspaceId, id: staged.id, ok: false, detail: bad.detail });
    expect(await repos.connectionRotations.promote(db, { workspaceId: f.workspaceId, id: staged.id, actorId: "admin" })).toMatchObject({ ok: false });
    modeledCluster();
    const good = await broker.verifyConnection(f.connection.id, { workspaceId: f.workspaceId });
    expect(good.ok).toBe(true);
    await repos.connectionRotations.recordCandidateVerification(db, { workspaceId: f.workspaceId, id: staged.id, ok: true, detail: good.detail });
    expect(await repos.connectionRotations.promote(db, { workspaceId: f.workspaceId, id: staged.id, actorId: "admin" })).toMatchObject({ ok: true });
    expect((await repos.connections.get(db, f.workspaceId, f.connection.id))!.config).toMatchObject({ mode: "scoped_guest", credentialRef: minterRef });
    // Other mode changes stay refused.
    await expect(repos.connectionRotations.stage(db, { workspaceId: f.workspaceId, connectionId: f.connection.id, candidateConfig: { ...candidate, mode: "kubeconfig_ref" }, createdBy: "admin" })).rejects.toThrow();
  });

  it("verification of a scoped_guest connection checks the minter scope and creates nothing", async () => {
    const f = await fixture(), good = modeledCluster();
    expect(await f.credentials.verifyConnection(f.connection.id, { workspaceId: f.workspaceId })).toMatchObject({ ok: true });
    expect(good.calls.every((c) => c === "allowed")).toBe(true);
    modeledCluster({ allow: () => true });
    const bad = await f.credentials.verifyConnection(f.connection.id, { workspaceId: f.workspaceId });
    expect(bad.ok).toBe(false);
    expect(bad.detail).toMatch(/cluster-wide or system-namespace/);
    expect(guestHash(f.workspaceId, f.connection.id)).toHaveLength(16);
  });
});
