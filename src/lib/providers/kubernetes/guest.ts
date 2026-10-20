/**
 * Tenant-scoped Kubernetes guest credentials (PROD-MACH-02).
 *
 * A `scoped_guest` connection stores a MINTER credential (a vault reference to a
 * namespaced identity that may only manage Zenith guest ServiceAccounts, Roles and
 * RoleBindings and request their tokens). The minter never reaches a guest caller.
 * For every machine dispatch the broker uses it to:
 *
 *   1. refuse an over-privileged minter (cluster-wide `*`, cluster RBAC writes,
 *      kube-system secrets/exec/token) via SelfSubjectAccessReview;
 *   2. ensure ONE ServiceAccount + namespaced Role + RoleBinding per
 *      (workspace, connection, namespace, profile): the Role names exact verbs on
 *      pods/pods-log (read) plus pods/exec (exec), and nothing else;
 *   3. mint a short-lived, audience-bound TokenRequest token for that ServiceAccount
 *      and verify its claims (subject, SA uid, audience, expiry) before use;
 *   4. record the issuance only while the binding is `active` and the connection is
 *      not revoked, in one SQL statement; otherwise the token is discarded.
 *
 * Any failure is an explicit refusal with a fixed message. There is no fallback to
 * the minter, a kubeconfig, a runner identity or any broader credential.
 * Revocation deletes RoleBinding, Role and ServiceAccount; deleting the
 * ServiceAccount invalidates its already-issued tokens at the API server.
 *
 * Tokens, kubeconfigs and provider error bodies never appear in messages, results
 * or the binding table (only stable snake_case codes).
 * https://kubernetes.io/docs/reference/kubernetes-api/authentication-resources/token-request-v1/
 * https://kubernetes.io/docs/reference/access-authn-authz/rbac/
 */
import { createHash } from "node:crypto";
import {
  ApiException, AuthorizationV1Api, CoreV1Api, KubeConfig, RbacAuthorizationV1Api,
  type V1PolicyRule, type V1RoleBinding, type RbacV1Subject,
} from "@kubernetes/client-node";
import type { KubernetesSession } from "@/lib/credentials/types";
import { canonical } from "@/lib/controlplane/digest";
import { isDnsLabel } from "./naming";
import { validateServerUrl } from "./session";

export type GuestProfile = "read" | "exec";

export type GuestErrorCode =
  | "scope_refused"
  | "minter_overprivileged"
  | "minter_insufficient"
  | "minter_rejected"
  | "namespace_missing"
  | "object_conflict"
  | "binding_revoked"
  | "token_invalid"
  | "cluster_error";

const MESSAGES: Record<GuestErrorCode, string> = {
  scope_refused: "The requested Kubernetes guest scope is not permitted for this connection.",
  minter_overprivileged: "The Kubernetes minter credential holds cluster-wide or system-namespace privilege; scoped guest minting is refused.",
  minter_insufficient: "The Kubernetes minter credential cannot manage guest ServiceAccounts and Roles in every allowlisted namespace.",
  minter_rejected: "The Kubernetes API rejected the minter credential.",
  namespace_missing: "An allowlisted Kubernetes namespace was not found.",
  object_conflict: "A foreign object already uses a Zenith guest object name; scoped guest minting is refused.",
  binding_revoked: "The Kubernetes guest binding or its connection is revoked.",
  token_invalid: "The Kubernetes API returned an unusable or mismatched guest token.",
  cluster_error: "The Kubernetes API could not complete the guest credential request.",
};

/** A fixed-message refusal. `code` is stable and safe to persist or show. */
export class GuestCredentialError extends Error {
  readonly code: GuestErrorCode;
  constructor(code: GuestErrorCode) {
    super(MESSAGES[code]);
    this.name = "GuestCredentialError";
    this.code = code;
  }
}

/* --------------------------------- policy --------------------------------- */

/** Namespaces a guest binding can never target, whatever the connection allowlist says. */
export const SYSTEM_NAMESPACES: ReadonlySet<string> = new Set(["kube-system", "kube-public", "kube-node-lease"]);

/** TokenRequest rejects anything below 10 minutes; the ceiling keeps tokens short-lived. */
export const GUEST_TOKEN_MIN_SEC = 600;
export const GUEST_TOKEN_MAX_SEC = 3600;

const LABEL = { managedBy: "app.kubernetes.io/managed-by", component: "zenith.dev/component", hash: "zenith.dev/guest-hash", profile: "zenith.dev/guest-profile" } as const;

/** Opaque, stable, label-safe tenant+connection identity (the ids themselves stay out of cluster objects). */
export function guestHash(workspaceId: string, connectionId: string): string {
  return createHash("sha256").update(`zenith-guest/v1\0${workspaceId}\0${connectionId}`).digest("hex").slice(0, 16);
}
/** `zg-<hash16>-<profile>`: 24 or 25 characters, a DNS label. */
export function guestObjectName(workspaceId: string, connectionId: string, profile: GuestProfile): string {
  return `zg-${guestHash(workspaceId, connectionId)}-${profile}`;
}
export function guestLabels(workspaceId: string, connectionId: string, profile: GuestProfile): Record<string, string> {
  return { [LABEL.managedBy]: "zenith", [LABEL.component]: "guest", [LABEL.hash]: guestHash(workspaceId, connectionId), [LABEL.profile]: profile };
}

/**
 * Exact least-privilege rules. No wildcards, no secrets, no write verbs on workloads,
 * no cluster scope. `pods/exec` lists get and create because the WebSocket upgrade is
 * authorized as `get` on older API servers and `create` on current ones.
 */
export function guestRoleRules(profile: GuestProfile): V1PolicyRule[] {
  const rules: V1PolicyRule[] = [
    { apiGroups: [""], resources: ["pods"], verbs: ["get", "list"] },
    { apiGroups: [""], resources: ["pods/log"], verbs: ["get"] },
  ];
  if (profile === "exec") rules.push({ apiGroups: [""], resources: ["pods/exec"], verbs: ["create", "get"] });
  return rules;
}

/** Machine operations that only read pod state/logs use `read`; every exec-based operation uses `exec`. */
export function guestProfileFor(operation: string): GuestProfile {
  return operation === "container.list" || operation === "container.inspect" || operation === "container.logs" ? "read" : "exec";
}

/** Throws unless the namespace is a DNS label, outside system namespaces, and on the allowlist. */
export function assertGuestNamespace(namespace: string, allowlist: readonly string[]): void {
  if (typeof namespace !== "string" || !isDnsLabel(namespace) || SYSTEM_NAMESPACES.has(namespace) || !allowlist.includes(namespace)) {
    throw new GuestCredentialError("scope_refused");
  }
}

/* ---------------------------------- ports --------------------------------- */

export interface AccessAttributes { verb: string; group: string; resource: string; subresource?: string; namespace?: string }

/** The cluster operations guest minting needs. The real implementation is {@link createGuestClusterPort}. */
export interface GuestClusterPort {
  /** SelfSubjectAccessReview as the MINTER. */
  allowed(attributes: AccessAttributes): Promise<boolean>;
  ensureServiceAccount(namespace: string, name: string, labels: Record<string, string>): Promise<{ uid: string }>;
  ensureRole(namespace: string, name: string, labels: Record<string, string>, rules: V1PolicyRule[]): Promise<void>;
  ensureRoleBinding(namespace: string, name: string, labels: Record<string, string>, serviceAccount: string): Promise<void>;
  requestToken(namespace: string, serviceAccount: string, uid: string, audiences: readonly string[], expirationSeconds: number): Promise<{ token: string; expiresAt: string }>;
  /** Delete RoleBinding, Role, ServiceAccount, only objects carrying this hash label; absent is success. */
  deleteGuestObjects(namespace: string, name: string, hash: string): Promise<void>;
}

export interface GuestBindingRef { id: string; status: "provisioning" | "active" | "revoking" | "revoked"; namespace: string; profile: GuestProfile; objectName: string }

/** Tenant-scoped persistence (see `repos.k8sGuestBindings`); every call is already bound to one workspace. */
export interface GuestStorePort {
  ensureBinding(input: { connectionId: string; namespace: string; profile: GuestProfile; objectName: string }): Promise<GuestBindingRef | null>;
  markActive(bindingId: string, saUid: string): Promise<GuestBindingRef | null>;
  recordIssuance(bindingId: string, tokenExpiresAt: Date): Promise<boolean>;
  recordError(bindingId: string, code: GuestErrorCode): Promise<void>;
  markRevoking(bindingId: string): Promise<boolean>;
  markRevoked(bindingId: string): Promise<boolean>;
  listOpen(connectionId: string): Promise<GuestBindingRef[]>;
}

/* ------------------------------ minter scope ------------------------------ */

const FORBIDDEN_FOR_MINTER: readonly AccessAttributes[] = [
  { verb: "*", group: "*", resource: "*" },
  { verb: "create", group: "rbac.authorization.k8s.io", resource: "clusterrolebindings" },
  { verb: "create", group: "rbac.authorization.k8s.io", resource: "clusterroles" },
  { verb: "get", group: "", resource: "secrets", namespace: "kube-system" },
  { verb: "create", group: "", resource: "pods", subresource: "exec", namespace: "kube-system" },
  { verb: "create", group: "", resource: "serviceaccounts", subresource: "token", namespace: "kube-system" },
];
const RBAC = "rbac.authorization.k8s.io";
const REQUIRED_FOR_MINTER = (namespace: string): AccessAttributes[] => [
  { verb: "create", group: "", resource: "serviceaccounts", namespace },
  { verb: "get", group: "", resource: "serviceaccounts", namespace },
  { verb: "delete", group: "", resource: "serviceaccounts", namespace },
  { verb: "create", group: "", resource: "serviceaccounts", subresource: "token", namespace },
  { verb: "create", group: RBAC, resource: "roles", namespace },
  { verb: "get", group: RBAC, resource: "roles", namespace },
  { verb: "update", group: RBAC, resource: "roles", namespace },
  { verb: "delete", group: RBAC, resource: "roles", namespace },
  { verb: "create", group: RBAC, resource: "rolebindings", namespace },
  { verb: "get", group: RBAC, resource: "rolebindings", namespace },
  { verb: "delete", group: RBAC, resource: "rolebindings", namespace },
];

/** Refuse a minter that holds cluster-wide or system-namespace power. Cheap enough to run on every mint. */
export async function assertMinterNotOverprivileged(cluster: GuestClusterPort): Promise<void> {
  for (const attributes of FORBIDDEN_FOR_MINTER) {
    if (await cluster.allowed(attributes)) throw new GuestCredentialError("minter_overprivileged");
  }
}

/** Provisioning/verification: the minter must manage guest objects in every allowlisted namespace. */
export async function assertMinterSufficient(cluster: GuestClusterPort, namespaces: readonly string[]): Promise<void> {
  for (const namespace of namespaces) {
    for (const attributes of REQUIRED_FOR_MINTER(namespace)) {
      if (!(await cluster.allowed(attributes))) throw new GuestCredentialError("minter_insufficient");
    }
  }
}

/** Connection verification for `scoped_guest`: allowlist shape, over-privilege and sufficiency. Creates nothing. */
export async function verifyGuestMinter(cluster: GuestClusterPort, namespaces: readonly string[]): Promise<void> {
  if (!namespaces.length) throw new GuestCredentialError("scope_refused");
  for (const namespace of namespaces) assertGuestNamespace(namespace, namespaces);
  await assertMinterNotOverprivileged(cluster);
  await assertMinterSufficient(cluster, namespaces);
}

/* ---------------------------------- tokens -------------------------------- */

const JWT_RE = /^[A-Za-z0-9_-]{4,4096}\.[A-Za-z0-9_-]{4,4096}\.[A-Za-z0-9_-]{4,4096}$/;

export interface GuestTokenClaims { sub: string; aud: string[]; exp: number; uid?: string }

/** Decode (NOT verify the signature of) the claims the API server put in a TokenRequest token. */
export function decodeGuestTokenClaims(token: string): GuestTokenClaims {
  if (typeof token !== "string" || !JWT_RE.test(token)) throw new GuestCredentialError("token_invalid");
  try {
    const payload = JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString("utf8")) as Record<string, unknown>;
    const aud = Array.isArray(payload.aud) ? payload.aud : typeof payload.aud === "string" ? [payload.aud] : [];
    const k8s = payload["kubernetes.io"] as { serviceaccount?: { uid?: unknown } } | undefined;
    if (typeof payload.sub !== "string" || typeof payload.exp !== "number" || !aud.length || !aud.every((a) => typeof a === "string")) throw new Error("claims");
    const uid = k8s?.serviceaccount?.uid;
    return { sub: payload.sub, aud: aud as string[], exp: payload.exp, ...(typeof uid === "string" ? { uid } : {}) };
  } catch { throw new GuestCredentialError("token_invalid"); }
}

/** The token must be for exactly this ServiceAccount, audience-bound, and expire inside the bound. */
export function assertGuestTokenClaims(token: string, expect: { namespace: string; serviceAccount: string; uid: string; audiences: readonly string[]; nowMs: number; maxLifetimeSec: number }): GuestTokenClaims {
  const claims = decodeGuestTokenClaims(token);
  if (claims.sub !== `system:serviceaccount:${expect.namespace}:${expect.serviceAccount}` || claims.uid !== expect.uid
    || !expect.audiences.every((a) => claims.aud.includes(a))
    || claims.exp * 1000 <= expect.nowMs || claims.exp * 1000 > expect.nowMs + expect.maxLifetimeSec * 1000 + 60_000) {
    throw new GuestCredentialError("token_invalid");
  }
  return claims;
}

/* ---------------------------------- mint ---------------------------------- */

export interface GuestMintDeps { cluster: GuestClusterPort; store: GuestStorePort; now?: () => Date }

export interface GuestMintRequest {
  workspaceId: string;
  connectionId: string;
  namespace: string;
  profile: GuestProfile;
  /** the connection's allowlist */
  namespaces: readonly string[];
  /** TokenRequest audiences; empty = API server default */
  audiences?: readonly string[];
  tokenTtlSec?: number;
}
export interface GuestCredential { token: string; expiresAt: string; bindingId: string; serviceAccount: string }

const clampTtl = (s: number | undefined) => Math.min(Math.max(Math.floor(s ?? GUEST_TOKEN_MIN_SEC), GUEST_TOKEN_MIN_SEC), GUEST_TOKEN_MAX_SEC);

export interface VerifiedTokenRequest {
  namespace: string;
  serviceAccount: string;
  uid: string;
  /** TokenRequest audiences; empty = API server default */
  audiences?: readonly string[];
  tokenTtlSec?: number;
  now?: () => Date;
}

/**
 * The TokenRequest half of the minter, shared by every scoped identity Zenith issues tokens for (guest sessions here,
 * the per-tenant operator in `execution/tenant-isolation.ts`): clamp the lifetime to 600..3600 s, request an
 * audience-bound token for the ServiceAccount UID, and refuse it unless its claims name that ServiceAccount, that UID,
 * a non-empty audience and an expiry inside the requested bound. Throws {@link GuestCredentialError}.
 */
export async function requestVerifiedToken(cluster: Pick<GuestClusterPort, "requestToken">, req: VerifiedTokenRequest): Promise<{ token: string; expiresAt: Date; claims: GuestTokenClaims }> {
  const now = req.now ?? (() => new Date());
  const audiences = [...(req.audiences ?? [])];
  const ttl = clampTtl(req.tokenTtlSec);
  const issued = await cluster.requestToken(req.namespace, req.serviceAccount, req.uid, audiences, ttl);
  const claims = assertGuestTokenClaims(issued.token, { namespace: req.namespace, serviceAccount: req.serviceAccount, uid: req.uid, audiences, nowMs: now().getTime(), maxLifetimeSec: ttl });
  return { token: issued.token, expiresAt: new Date(claims.exp * 1000), claims };
}

/**
 * Mint one scoped credential or throw {@link GuestCredentialError}. The returned
 * token has been claim-checked and its issuance recorded against a live binding.
 */
export async function mintGuestCredential(deps: GuestMintDeps, req: GuestMintRequest): Promise<GuestCredential> {
  const now = deps.now ?? (() => new Date());
  if (req.profile !== "read" && req.profile !== "exec") throw new GuestCredentialError("scope_refused");
  assertGuestNamespace(req.namespace, req.namespaces);
  const audiences = [...(req.audiences ?? [])];
  const ttl = clampTtl(req.tokenTtlSec);
  const name = guestObjectName(req.workspaceId, req.connectionId, req.profile);
  const labels = guestLabels(req.workspaceId, req.connectionId, req.profile);

  await assertMinterNotOverprivileged(deps.cluster);
  const binding = await deps.store.ensureBinding({ connectionId: req.connectionId, namespace: req.namespace, profile: req.profile, objectName: name });
  if (!binding || binding.status === "revoking" || binding.status === "revoked") throw new GuestCredentialError("binding_revoked");
  try {
    if (binding.status === "provisioning") await assertMinterSufficient(deps.cluster, [req.namespace]);
    const account = await deps.cluster.ensureServiceAccount(req.namespace, name, labels);
    await deps.cluster.ensureRole(req.namespace, name, labels, guestRoleRules(req.profile));
    await deps.cluster.ensureRoleBinding(req.namespace, name, labels, name);
    const active = await deps.store.markActive(binding.id, account.uid);
    if (!active || active.status !== "active") throw new GuestCredentialError("binding_revoked");
    const issued = await requestVerifiedToken(deps.cluster, { namespace: req.namespace, serviceAccount: name, uid: account.uid, audiences, tokenTtlSec: ttl, now });
    if (!(await deps.store.recordIssuance(binding.id, issued.expiresAt))) throw new GuestCredentialError("binding_revoked");
    return { token: issued.token, expiresAt: issued.expiresAt.toISOString(), bindingId: binding.id, serviceAccount: name };
  } catch (error) {
    const code = error instanceof GuestCredentialError ? error.code : "cluster_error";
    await deps.store.recordError(binding.id, code).catch(() => undefined);
    throw error instanceof GuestCredentialError ? error : new GuestCredentialError("cluster_error");
  }
}

/** A guest kubeconfig carries only the guest token and the connection's own server/CA. Never the minter. */
export function buildGuestKubeConfig(input: { server: string; caData?: string; token: string; allowInsecureLoopback?: boolean }): KubeConfig {
  const server = validateServerUrl(input.server, input.allowInsecureLoopback === true);
  const kc = new KubeConfig();
  kc.loadFromClusterAndUser({ name: "zenith-guest-cluster", server, caData: input.caData, skipTLSVerify: server.startsWith("http:") }, { name: "zenith-guest-user", token: input.token });
  return kc;
}

/* -------------------------------- revocation ------------------------------- */

export interface GuestRevocationOutcome { revoked: number; pending: number }

/**
 * Delete the cluster objects of every open binding of a (revoked) connection and
 * mark them revoked. A binding whose deletion fails stays `revoking` (still
 * unmintable) and is retried by the next call. Never throws for a single failure.
 */
export async function revokeGuestBindings(deps: Pick<GuestMintDeps, "cluster" | "store">, input: { workspaceId: string; connectionId: string }): Promise<GuestRevocationOutcome> {
  const hash = guestHash(input.workspaceId, input.connectionId);
  let revoked = 0, pending = 0;
  for (const binding of await deps.store.listOpen(input.connectionId)) {
    await deps.store.markRevoking(binding.id).catch(() => false);
    try {
      await deps.cluster.deleteGuestObjects(binding.namespace, binding.objectName, hash);
      if (await deps.store.markRevoked(binding.id)) { revoked++; continue; }
      pending++;
    } catch (error) {
      pending++;
      await deps.store.recordError(binding.id, error instanceof GuestCredentialError ? error.code : "cluster_error").catch(() => undefined);
    }
  }
  return { revoked, pending };
}

/* ------------------------------ real cluster port -------------------------- */

const status = (e: unknown): number | undefined => (e instanceof ApiException ? e.code : undefined);
function mapApi(e: unknown, notFound: GuestErrorCode = "cluster_error"): GuestCredentialError {
  if (e instanceof GuestCredentialError) return e;
  const s = status(e);
  if (s === 401) return new GuestCredentialError("minter_rejected");
  if (s === 403) return new GuestCredentialError("minter_insufficient");
  if (s === 404) return new GuestCredentialError(notFound);
  return new GuestCredentialError("cluster_error");
}
const owned = (labels: Record<string, string> | undefined, expected: Record<string, string>): boolean =>
  !!labels && Object.entries(expected).every(([k, v]) => labels[k] === v);
const subjectsEqual = (a: RbacV1Subject[] | undefined, b: RbacV1Subject[]): boolean => canonical((a ?? []).map(({ kind, name, namespace, apiGroup }) => ({ kind, name, namespace, apiGroup: apiGroup ?? "" }))) === canonical(b.map(({ kind, name, namespace, apiGroup }) => ({ kind, name, namespace, apiGroup: apiGroup ?? "" })));
const rulesEqual = (a: V1PolicyRule[] | undefined, b: V1PolicyRule[]): boolean => {
  const norm = (rules: V1PolicyRule[]) => rules.map((r) => ({ g: [...(r.apiGroups ?? [])].sort(), r: [...(r.resources ?? [])].sort(), v: [...(r.verbs ?? [])].sort(), n: [...(r.resourceNames ?? [])].sort(), u: [...(r.nonResourceURLs ?? [])].sort() }));
  return canonical(norm(a ?? [])) === canonical(norm(b));
};

/** The production port: `@kubernetes/client-node` clients built from the MINTER session's KubeConfig. */
export function createGuestClusterPort(session: KubernetesSession, signal?: AbortSignal): GuestClusterPort {
  const kc = session.kubeConfig();
  if (!(kc instanceof KubeConfig)) throw new GuestCredentialError("cluster_error");
  const core = kc.makeApiClient(CoreV1Api);
  const rbac = kc.makeApiClient(RbacAuthorizationV1Api);
  const authz = kc.makeApiClient(AuthorizationV1Api);
  const options = signal ? { signal } : undefined;
  const absent = (e: unknown) => status(e) === 404;
  return {
    async allowed(a) {
      try {
        const review = await authz.createSelfSubjectAccessReview({ body: { apiVersion: "authorization.k8s.io/v1", kind: "SelfSubjectAccessReview",
          spec: { resourceAttributes: { verb: a.verb, group: a.group, resource: a.resource, ...(a.subresource ? { subresource: a.subresource } : {}), ...(a.namespace ? { namespace: a.namespace } : {}) } } } }, options as never);
        return review.status?.allowed === true;
      } catch (e) { throw mapApi(e); }
    },
    async ensureServiceAccount(namespace, name, labels) {
      try {
        let live;
        try { live = await core.readNamespacedServiceAccount({ name, namespace }, options as never); }
        catch (e) {
          if (!absent(e)) throw e;
          try { live = await core.createNamespacedServiceAccount({ namespace, body: { metadata: { name, namespace, labels }, automountServiceAccountToken: false } }, options as never); }
          catch (c) { if (status(c) !== 409) throw c; live = await core.readNamespacedServiceAccount({ name, namespace }, options as never); }
        }
        if (!owned(live.metadata?.labels, labels) || typeof live.metadata?.uid !== "string") throw new GuestCredentialError("object_conflict");
        return { uid: live.metadata.uid };
      } catch (e) { throw mapApi(e, "namespace_missing"); }
    },
    async ensureRole(namespace, name, labels, rules) {
      try {
        let live;
        try { live = await rbac.readNamespacedRole({ name, namespace }, options as never); }
        catch (e) {
          if (!absent(e)) throw e;
          // Create empty, then set the rules by name below. Kubernetes cannot match a create against
          // the minter's name-pinned `escalate` (the name is unknown at authorization time), so a create
          // carrying rules the minter does not hold is refused; the named update is allowed.
          try { await rbac.createNamespacedRole({ namespace, body: { metadata: { name, namespace, labels }, rules: [] } }, options as never); }
          catch (c) { if (status(c) !== 409) throw c; }
          live = await rbac.readNamespacedRole({ name, namespace }, options as never);
        }
        if (!owned(live.metadata?.labels, labels)) throw new GuestCredentialError("object_conflict");
        // Out-of-band widening of the guest Role is reverted, never trusted.
        if (!rulesEqual(live.rules, rules)) await rbac.replaceNamespacedRole({ name, namespace, body: { metadata: { name, namespace, labels, resourceVersion: live.metadata?.resourceVersion }, rules } }, options as never);
      } catch (e) { throw mapApi(e, "namespace_missing"); }
    },
    async ensureRoleBinding(namespace, name, labels, serviceAccount) {
      const subjects: RbacV1Subject[] = [{ kind: "ServiceAccount", name: serviceAccount, namespace, apiGroup: "" }];
      const body: V1RoleBinding = { metadata: { name, namespace, labels }, roleRef: { apiGroup: RBAC, kind: "Role", name }, subjects };
      try {
        let live;
        try { live = await rbac.readNamespacedRoleBinding({ name, namespace }, options as never); }
        catch (e) {
          if (!absent(e)) throw e;
          try { await rbac.createNamespacedRoleBinding({ namespace, body }, options as never); return; }
          catch (c) { if (status(c) !== 409) throw c; live = await rbac.readNamespacedRoleBinding({ name, namespace }, options as never); }
        }
        if (!owned(live.metadata?.labels, labels)) throw new GuestCredentialError("object_conflict");
        const same = live.roleRef.kind === "Role" && live.roleRef.name === name && live.roleRef.apiGroup === RBAC && subjectsEqual(live.subjects, subjects);
        if (!same) {
          // roleRef is immutable: replace by delete + create.
          await rbac.deleteNamespacedRoleBinding({ name, namespace }, options as never);
          await rbac.createNamespacedRoleBinding({ namespace, body }, options as never);
        }
      } catch (e) { throw mapApi(e, "namespace_missing"); }
    },
    async requestToken(namespace, serviceAccount, uid, audiences, expirationSeconds) {
      try {
        const issued = await core.createNamespacedServiceAccountToken({ name: serviceAccount, namespace,
          body: { apiVersion: "authentication.k8s.io/v1", kind: "TokenRequest", metadata: { name: serviceAccount, namespace, uid }, spec: { audiences: [...audiences], expirationSeconds } } }, options as never);
        const token = issued.status?.token, expiresAt = issued.status?.expirationTimestamp;
        if (typeof token !== "string" || !(expiresAt instanceof Date || typeof expiresAt === "string")) throw new GuestCredentialError("token_invalid");
        return { token, expiresAt: new Date(expiresAt).toISOString() };
      } catch (e) { throw mapApi(e); }
    },
    async deleteGuestObjects(namespace, name, hash) {
      try {
        const expected = { [LABEL.hash]: hash, [LABEL.component]: "guest" };
        const guarded = async (read: () => Promise<{ metadata?: { labels?: Record<string, string> } }>, remove: () => Promise<unknown>) => {
          let live;
          try { live = await read(); } catch (e) { if (absent(e)) return; throw e; }
          // Not ours (name collision with a foreign object): leave it, there is nothing of ours to delete.
          if (!owned(live.metadata?.labels, expected)) return;
          try { await remove(); } catch (e) { if (!absent(e)) throw e; }
        };
        await guarded(() => rbac.readNamespacedRoleBinding({ name, namespace }, options as never), () => rbac.deleteNamespacedRoleBinding({ name, namespace }, options as never));
        await guarded(() => rbac.readNamespacedRole({ name, namespace }, options as never), () => rbac.deleteNamespacedRole({ name, namespace }, options as never));
        await guarded(() => core.readNamespacedServiceAccount({ name, namespace }, options as never), () => core.deleteNamespacedServiceAccount({ name, namespace }, options as never));
      } catch (e) {
        // A missing namespace means the objects are gone with it.
        if (status(e) === 404) return;
        throw mapApi(e);
      }
    },
  };
}
