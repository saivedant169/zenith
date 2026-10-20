/**
 * Opt-in PROD-MACH-02 acceptance on a genuine disposable kind cluster: the DEFAULT scoped guest path
 * (namespaced minter -> per-binding ServiceAccount + Role + RoleBinding -> TokenRequest) through the real
 * platform credential broker, encrypted tenant vault, machine session provider and Kubernetes machine driver.
 * Nothing about the Kubernetes API is modeled.
 *
 * Gate (same as tests/machines/kubernetes-kind.test.ts): ZENITH_TEST_KIND=1, an absolute private KUBECONFIG
 * whose single context is kind-<ZENITH_TEST_KIND_GUEST_CLUSTER> (zenith-*), and a digest-pinned
 * ZENITH_TEST_KIND_RELEASE_IMAGE already loaded into the cluster. Only labeled, randomly named namespaces
 * and one cluster-scoped binding (labeled and removed in cleanup) are created. The admin config is used for
 * setup and cleanup only and never reaches a broker or guest callback.
 * https://kubernetes.io/docs/reference/access-authn-authz/rbac/#privilege-escalation-prevention-and-bootstrapping
 */
import { randomBytes, randomUUID } from "node:crypto";
import { lstatSync } from "node:fs";
import path from "node:path";
import { setTimeout as wait } from "node:timers/promises";
import { ApiException, AuthorizationV1Api, CoreV1Api, KubeConfig, RbacAuthorizationV1Api } from "@kubernetes/client-node";
import { dump as yamlDump } from "js-yaml";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { CapabilityGrantClaims } from "@/lib/controlplane/types";
import type { KubernetesConnectionConfig } from "@/lib/credentials/types";
import type { KubernetesMachineSession, MachineOperation, MachineSessionRequest } from "@/lib/machines/types";
import { tempDataDir } from "../_support/data-dir";
import { requestFor } from "./_helpers";

tempDataDir("zenith-kind-scoped-guest-", { fast: true });
const { openPlatformDb, repos } = await import("@/lib/controlplane/db");
const { platformCredentialBroker, revokeKubernetesGuestBindings } = await import("@/lib/platform/credentials");
const { createMachineSessionProvider } = await import("@/lib/machines/sessions");
const { createKubernetesMachineDriver } = await import("@/lib/machines/transports/kubernetes");
const { guestObjectName, decodeGuestTokenClaims } = await import("@/lib/providers/kubernetes/guest");
const { generateSigningJwk, LocalJwkSigner } = await import("@/lib/credentials/signing");
const { signCapabilityGrant, verifyCapabilityGrant } = await import("@/lib/credentials/grants");
const vault = await import("@/lib/secrets");

const enabled = process.env.ZENITH_TEST_KIND === "1";
const RBAC_GROUP = "rbac.authorization.k8s.io";

class KindError extends Error {
  readonly httpStatus?: number;
  constructor(error: unknown) {
    super("The owned kind scoped-guest fixture request failed.");
    const status = error instanceof ApiException ? error.code : error && typeof error === "object" && "cause" in error && error.cause instanceof ApiException ? error.cause.code : undefined;
    if (typeof status === "number") this.httpStatus = status;
    const machine = error && typeof error === "object" && "code" in error ? error.code : undefined;
    if (typeof machine === "string") Object.assign(this, { machineCode: machine });
  }
}
async function api<T>(request: () => Promise<T>): Promise<T> { try { return await request(); } catch (error) { throw new KindError(error); } }

function ownedAdminConfig(): KubeConfig {
  const file = process.env.KUBECONFIG, clusterName = process.env.ZENITH_TEST_KIND_GUEST_CLUSTER;
  if (!file || !path.isAbsolute(file) || file.includes(path.delimiter) || !clusterName || !/^zenith-[a-z0-9-]{1,40}$/.test(clusterName)) throw new Error("Opt-in kind acceptance requires the explicit owned kubeconfig and cluster name.");
  const stat = lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || (process.getuid && (stat.uid !== process.getuid() || (stat.mode & 0o077) !== 0)) || stat.size > 256 * 1024) throw new Error("The explicit owned kind kubeconfig is unsafe.");
  const kc = new KubeConfig();
  kc.loadFromFile(file);
  const name = `kind-${clusterName}`, cluster = kc.getCurrentCluster(), user = kc.getCurrentUser();
  if (kc.getCurrentContext() !== name || kc.contexts.length !== 1 || kc.clusters.length !== 1 || !cluster || !user || cluster.name !== name || cluster.skipTLSVerify || !cluster.caData
    || user.exec || user.authProvider || user.token || !user.certData || !user.keyData) throw new Error("The explicit owned kind kubeconfig does not select exactly the owned cluster.");
  const url = new URL(cluster.server);
  if (url.protocol !== "https:" || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) throw new Error("The owned kind API server must be loopback HTTPS.");
  return kc;
}

describe.skipIf(!enabled)("default scoped Kubernetes guest credentials against the owned kind cluster", () => {
  const suffix = randomBytes(6).toString("hex"), namespace = `zenith-sg-${suffix}`, foreignNamespace = `zenith-sg-foreign-${suffix}`;
  const labels = { "app.kubernetes.io/managed-by": "zenith", "zenith.dev/acceptance": "scoped-guest", "zenith.dev/acceptance-run": suffix };
  const ownedNamespaces: { name: string; uid: string }[] = [], ownedVaultRefs: { workspaceId: string; ref: string }[] = [], ownedClusterBindings: string[] = [];
  let admin: KubeConfig, core: CoreV1Api, rbac: RbacAuthorizationV1Api;
  let db: Awaited<ReturnType<typeof openPlatformDb>>;
  let server = "", caData = "";
  let key: Awaited<ReturnType<typeof generateSigningJwk>>, signer: ReturnType<typeof LocalJwkSigner.fromJwk>;
  let controller: AbortController;
  beforeEach(() => { controller = new AbortController(); });
  afterEach(() => { controller?.abort(); });

  beforeAll(async () => {
    admin = ownedAdminConfig();
    const image = process.env.ZENITH_TEST_KIND_RELEASE_IMAGE;
    if (!image || !/^[a-zA-Z0-9][-a-zA-Z0-9._/:]*@sha256:[a-f0-9]{64}$/.test(image)) throw new Error("The root-loaded kind fixture image must be digest-pinned.");
    server = admin.getCurrentCluster()!.server; caData = admin.getCurrentCluster()!.caData!;
    core = admin.makeApiClient(CoreV1Api); rbac = admin.makeApiClient(RbacAuthorizationV1Api);
    vi.stubEnv("ZENITH_STORE", "file");
    vi.stubEnv("ZENITH_SECRET_KEY", randomBytes(32).toString("hex"));
    db = await openPlatformDb({ kind: "pglite" });
    key = await generateSigningJwk("EdDSA"); signer = LocalJwkSigner.fromJwk("kind-scoped-guest", key.privateJwk, { alg: "EdDSA" });
    for (const name of [namespace, foreignNamespace]) {
      const created = await api(() => core.createNamespace({ body: { metadata: { name, labels } } }));
      if (!created.metadata?.uid) throw new Error("The owned namespace creation was not confirmed.");
      ownedNamespaces.push({ name, uid: created.metadata.uid });
    }
    await api(() => core.createNamespacedPod({ namespace, body: { metadata: { name: "guest-marker", labels }, spec: { restartPolicy: "Never", activeDeadlineSeconds: 240, automountServiceAccountToken: false,
      securityContext: { runAsNonRoot: true, runAsUser: 65532, seccompProfile: { type: "RuntimeDefault" } },
      containers: [{ name: "marker", image, imagePullPolicy: "Never", command: ["/bin/sh", "-c", "sleep 200"],
        resources: { requests: { cpu: "10m", memory: "8Mi" }, limits: { cpu: "50m", memory: "32Mi" } },
        securityContext: { allowPrivilegeEscalation: false, capabilities: { drop: ["ALL"] }, readOnlyRootFilesystem: true } }] } } }));
    // exec into a container that has not started yet is answered 500 "container not found"
    for (let started = Date.now(); ; await wait(500)) {
      const pod = await api(() => core.readNamespacedPod({ namespace, name: "guest-marker" }));
      const state = pod.status?.containerStatuses?.[0]?.state;
      if (state?.running) break;
      if (state?.terminated || Date.now() - started > 90_000) throw new Error(`The owned guest-marker pod did not start: ${JSON.stringify(state ?? pod.status?.phase)}`);
    }
  }, 150_000);

  afterAll(async () => {
    let failure = false;
    try {
      const cleanup = ownedAdminConfig(), cCore = cleanup.makeApiClient(CoreV1Api), cRbac = cleanup.makeApiClient(RbacAuthorizationV1Api);
      for (const name of ownedClusterBindings) { try { await api(() => cRbac.deleteClusterRoleBinding({ name })); } catch (e) { if (!(e instanceof KindError && e.httpStatus === 404)) failure = true; } }
      for (const owned of [...ownedNamespaces].reverse()) {
        try {
          const current = await api(() => cCore.readNamespace({ name: owned.name }));
          if (current.metadata?.uid !== owned.uid || !Object.entries(labels).every(([k, v]) => current.metadata?.labels?.[k] === v)) throw new Error("identity changed");
          await api(() => cCore.deleteNamespace({ name: owned.name }));
        } catch { failure = true; }
      }
    } catch { failure = true; }
    finally {
      for (const owned of ownedVaultRefs) { try { await vault.removeSecretAsync(owned.workspaceId, owned.ref); } catch { failure = true; } }
      try { await db?.close(); } catch { failure = true; }
      vi.unstubAllEnvs();
    }
    if (failure) throw new Error("The owned kind scoped-guest cleanup was not fully confirmed; root cluster cleanup remains required.");
  }, 120_000);

  /**
   * A namespaced MINTER: it manages guest objects in `namespace` only. `bind`/`escalate` are pinned to the two
   * deterministic guest role names so Kubernetes' own privilege-escalation prevention allows exactly those Roles.
   */
  async function minterToken(workspaceId: string, connectionId: string, over: { omit?: "rolebindings" } = {}): Promise<{ token: string; name: string }> {
    const name = `minter-${randomBytes(4).toString("hex")}`;
    const sa = await api(() => core.createNamespacedServiceAccount({ namespace, body: { metadata: { name, labels }, automountServiceAccountToken: false } }));
    const guestRoles = [guestObjectName(workspaceId, connectionId, "read"), guestObjectName(workspaceId, connectionId, "exec")];
    const rules = [
      { apiGroups: [""], resources: ["serviceaccounts"], verbs: ["create", "get", "delete"] },
      { apiGroups: [""], resources: ["serviceaccounts/token"], verbs: ["create"] },
      { apiGroups: [RBAC_GROUP], resources: ["roles"], verbs: ["create", "get", "update", "delete"] },
      { apiGroups: [RBAC_GROUP], resources: ["roles"], verbs: ["bind", "escalate"], resourceNames: guestRoles },
      ...(over.omit === "rolebindings" ? [] : [{ apiGroups: [RBAC_GROUP], resources: ["rolebindings"], verbs: ["create", "get", "delete"] }]),
    ];
    await api(() => rbac.createNamespacedRole({ namespace, body: { metadata: { name, labels }, rules } }));
    await api(() => rbac.createNamespacedRoleBinding({ namespace, body: { metadata: { name, labels }, roleRef: { apiGroup: RBAC_GROUP, kind: "Role", name }, subjects: [{ kind: "ServiceAccount", name, namespace }] } }));
    const issued = await api(() => core.createNamespacedServiceAccountToken({ name, namespace, body: { apiVersion: "authentication.k8s.io/v1", kind: "TokenRequest", metadata: { name, namespace, uid: sa.metadata!.uid }, spec: { audiences: [], expirationSeconds: 3000 } } }));
    if (!issued.status?.token) throw new Error("minter token not issued");
    return { token: issued.status.token, name };
  }

  async function fixture(operation: MachineOperation = "container.list", opts: { omit?: "rolebindings"; overprivileged?: boolean } = {}) {
    const workspaceId = `ws-kind-sg-${randomUUID()}`, credentialRef = `vault:kind-sg/${randomUUID()}/MINTER`;
    const config: KubernetesConnectionConfig = { provider: "kubernetes", mode: "scoped_guest", server, caData, credentialRef, namespaces: [namespace] };
    const created = await repos.connections.create(db, { workspaceId, config, createdBy: "kind-scoped-guest" });
    const minter = await minterToken(workspaceId, created.id, { omit: opts.omit });
    if (opts.overprivileged) {
      const name = `zenith-sg-over-${suffix}-${randomBytes(3).toString("hex")}`;
      ownedClusterBindings.push(name);
      await api(() => rbac.createClusterRoleBinding({ body: { metadata: { name, labels }, roleRef: { apiGroup: RBAC_GROUP, kind: "ClusterRole", name: "cluster-admin" }, subjects: [{ kind: "ServiceAccount", name: minter.name, namespace }] } }));
    }
    ownedVaultRefs.push({ workspaceId, ref: credentialRef });
    await vault.putSecretAsync(workspaceId, credentialRef, yamlDump({ apiVersion: "v1", kind: "Config", "current-context": "minter",
      clusters: [{ name: "owning-cluster", cluster: { server, "certificate-authority-data": caData } }],
      contexts: [{ name: "minter", context: { cluster: "owning-cluster", user: "minter" } }], users: [{ name: "minter", user: { token: minter.token } }] }, { noRefs: true }), "kind-scoped-guest");
    const credentials = platformCredentialBroker(db);
    const verified = await credentials.verifyConnection(created.id, { workspaceId });
    await repos.connections.recordVerification(db, { workspaceId, id: created.id, ok: verified.ok, detail: verified.detail });
    const connection = (await repos.connections.get(db, workspaceId, created.id))!;
    const operationId = `op-kind-sg-${randomUUID()}`, environmentId = `env-kind-sg-${suffix}`, resourceId = `res-kind-sg-${randomUUID()}`, now = Math.floor(Date.now() / 1000);
    const claims: CapabilityGrantClaims = { jti: randomUUID(), iss: "kind-scoped-guest", aud: "worker", sub: "user:kind-scoped-guest", iat: now - 1, exp: now + 300, cap: operation, op: operationId, digest: "d".repeat(64), ws: workspaceId, env: environmentId, res: resourceId };
    const jws = await signCapabilityGrant(claims, { signer });
    const grant = await verifyCapabilityGrant(jws, { audience: "worker", expectedCapability: operation, expectedOperationId: operationId, keys: [key.publicJwk] });
    const args = operation === "container.exec" ? { argv: ["/bin/sh", "-c", "echo scoped-guest-exec-ok"], timeoutSec: 20 } : { all: true };
    const request = requestFor(operation, args, { operationId, target: { workspaceId, environmentId, resourceId, address: "compute_instance/guest-marker", transport: "kubernetes", targetId: operation === "container.exec" ? `${namespace}/guest-marker/marker` : namespace }, timeoutSec: 20 });
    const sessionRequest: MachineSessionRequest = { operationId, operation, target: request.target, grant };
    const provider = createMachineSessionProvider({ credentials, connection, grantJws: jws, signal: controller.signal });
    const driver = createKubernetesMachineDriver();
    return { workspaceId, connection, verified, request, sessionRequest, provider, driver, credentials, run: () => provider.withSession(sessionRequest, (s) => api(() => driver.execute(request, s, controller.signal))) };
  }
  const guestAccess = (session: KubernetesMachineSession) => {
    const kc = session.kubeConfig() as KubeConfig, authz = kc.makeApiClient(AuthorizationV1Api);
    return async (resourceAttributes: { verb: string; resource: string; subresource?: string; group?: string; namespace?: string }) =>
      (await api(() => authz.createSelfSubjectAccessReview({ body: { apiVersion: "authorization.k8s.io/v1", kind: "SelfSubjectAccessReview", spec: { resourceAttributes: { group: "", ...resourceAttributes } } } }))).status?.allowed === true;
  };

  it("verification accepts a namespaced minter and refuses one holding cluster-wide privilege", async () => {
    const good = await fixture();
    expect(good.verified.ok).toBe(true);
    const bad = await fixture("container.list", { overprivileged: true });
    expect(bad.verified.ok).toBe(false);
    expect(bad.verified.detail).toMatch(/cluster-wide or system-namespace/);
    await expect(bad.run()).rejects.toMatchObject({ code: "denied" });
  }, 120_000);

  it("container.list uses a read-only, namespace-bound, audience-bound short-lived guest token", async () => {
    const f = await fixture(); let held!: KubernetesMachineSession;
    const result = await f.provider.withSession(f.sessionRequest, async (value) => {
      held = value as KubernetesMachineSession;
      expect(held.namespaces).toEqual([namespace]);
      const token = (held.kubeConfig() as KubeConfig).getCurrentUser()?.token ?? "";
      const claims = decodeGuestTokenClaims(token);
      expect(claims.sub).toBe(`system:serviceaccount:${namespace}:${guestObjectName(f.workspaceId, f.connection.id, "read")}`);
      expect(claims.aud.length).toBeGreaterThan(0);
      expect(claims.exp * 1000 - Date.now()).toBeLessThanOrEqual(3_600_000 + 60_000);
      const can = guestAccess(held);
      expect(await can({ verb: "list", resource: "pods", namespace })).toBe(true);
      expect(await can({ verb: "get", resource: "pods", subresource: "log", namespace })).toBe(true);
      for (const denied of [{ verb: "create", resource: "pods", subresource: "exec", namespace }, { verb: "get", resource: "secrets", namespace }, { verb: "list", resource: "pods", namespace: foreignNamespace },
        { verb: "list", resource: "nodes" }, { verb: "create", resource: "serviceaccounts", subresource: "token", namespace }, { verb: "delete", resource: "pods", namespace }]) expect(await can(denied)).toBe(false);
      return api(() => f.driver.execute(f.request, held, controller.signal));
    });
    expect(result.ok).toBe(true);
    expect(result.data).toMatchObject({ containers: [expect.objectContaining({ pod: "guest-marker", namespace, name: "marker" })] });
    expect(() => held.kubeConfig()).toThrow("ended");
    const binding = (await repos.k8sGuestBindings.listForConnection(db, f.workspaceId, f.connection.id))[0];
    expect(binding).toMatchObject({ namespace, profile: "read", status: "active", issuedCount: 1 });
  }, 120_000);

  it("container.exec uses the exec profile and can run in the namespaced pod but still cannot read secrets", async () => {
    const f = await fixture("container.exec");
    let can!: ReturnType<typeof guestAccess>;
    const result = await f.provider.withSession(f.sessionRequest, async (value) => {
      can = guestAccess(value as KubernetesMachineSession);
      expect(await can({ verb: "create", resource: "pods", subresource: "exec", namespace })).toBe(true);
      expect(await can({ verb: "get", resource: "secrets", namespace })).toBe(false);
      expect(await can({ verb: "create", resource: "pods", subresource: "exec", namespace: foreignNamespace })).toBe(false);
      return api(() => f.driver.execute(f.request, value, controller.signal));
    });
    expect(result.ok).toBe(true);
    expect(result.output?.stdout).toContain("scoped-guest-exec-ok");
  }, 120_000);

  it("a foreign namespace is refused by Zenith before any cluster call", async () => {
    const f = await fixture();
    const foreign = { ...f.sessionRequest, target: { ...f.sessionRequest.target, targetId: foreignNamespace } };
    await expect(f.provider.withSession(foreign, async () => "entered")).rejects.toMatchObject({ code: "denied" });
    expect(await repos.k8sGuestBindings.listForConnection(db, f.workspaceId, f.connection.id)).toEqual([]);
  }, 60_000);

  it("out-of-band widening of the guest Role is reverted on the next mint", async () => {
    const f = await fixture(); await f.run();
    const roleName = guestObjectName(f.workspaceId, f.connection.id, "read");
    const live = await api(() => rbac.readNamespacedRole({ name: roleName, namespace }));
    await api(() => rbac.replaceNamespacedRole({ name: roleName, namespace, body: { ...live, rules: [...(live.rules ?? []), { apiGroups: [""], resources: ["secrets"], verbs: ["get"] }] } }));
    await f.provider.withSession(f.sessionRequest, async (value) => {
      expect(await guestAccess(value as KubernetesMachineSession)({ verb: "get", resource: "secrets", namespace })).toBe(false);
    });
    expect(JSON.stringify((await api(() => rbac.readNamespacedRole({ name: roleName, namespace }))).rules)).not.toContain("secrets");
  }, 120_000);

  it("a minter that cannot create the RoleBinding is refused explicitly with no fallback and no token", async () => {
    const f = await fixture("container.list", { omit: "rolebindings" });
    expect(f.verified.ok).toBe(false);
    let entered = false;
    await expect(f.provider.withSession(f.sessionRequest, async () => { entered = true; })).rejects.toMatchObject({ code: "denied" });
    expect(entered).toBe(false);
  }, 120_000);

  it("revocation deletes the cluster objects, kills in-flight tokens at the API server and blocks new dispatch", async () => {
    const f = await fixture("container.exec"); let heldToken = "";
    await f.provider.withSession(f.sessionRequest, async (value) => { heldToken = (((value as KubernetesMachineSession).kubeConfig()) as KubeConfig).getCurrentUser()!.token!; });
    const probe = () => { const kc = new KubeConfig(); kc.loadFromClusterAndUser({ name: "c", server, caData, skipTLSVerify: false }, { name: "u", token: heldToken }); return api(() => kc.makeApiClient(CoreV1Api).listNamespacedPod({ namespace })); };
    // The in-flight token still works until revocation (cluster-side proof that it is a real credential).
    await expect(probe()).resolves.toBeTruthy();
    await repos.connections.revokeAudited(db, { workspaceId: f.workspaceId, id: f.connection.id, actorId: "admin", reason: "kind acceptance" });
    const revoked = (await repos.connections.get(db, f.workspaceId, f.connection.id))!;
    // Dispatch is refused immediately, before any cluster cleanup.
    await expect(f.provider.withSession(f.sessionRequest, async () => "entered")).rejects.toMatchObject({ code: "denied" });
    expect(await revokeKubernetesGuestBindings(db, revoked)).toEqual({ revoked: 1, pending: 0, attempted: true });
    const name = guestObjectName(f.workspaceId, f.connection.id, "exec");
    for (const read of [() => core.readNamespacedServiceAccount({ name, namespace }), () => rbac.readNamespacedRole({ name, namespace }), () => rbac.readNamespacedRoleBinding({ name, namespace })]) {
      await expect(api(read)).rejects.toMatchObject({ httpStatus: 404 });
    }
    // Token validity is checked against the (now deleted) ServiceAccount; allow brief controller propagation.
    const deadline = performance.now() + 20_000; let status: number | undefined;
    for (;;) {
      try { await probe(); status = 200; } catch (e) { status = e instanceof KindError ? e.httpStatus : undefined; }
      if (status === 401 || performance.now() >= deadline) break;
      await wait(250);
    }
    expect(status).toBe(401);
    expect((await repos.k8sGuestBindings.listForConnection(db, f.workspaceId, f.connection.id)).map((b) => b.status)).toEqual(["revoked"]);
  }, 150_000);
});
