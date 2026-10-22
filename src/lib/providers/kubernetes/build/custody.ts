/** Operator-provisioned tenant build custody. Never uses a deploy credential as a fallback. */
import { AuthenticationV1Api, AuthorizationV1Api, type KubeConfig } from "@kubernetes/client-node";
import { z } from "zod";
import { digest } from "@/lib/controlplane/digest";
import type { KubernetesSession } from "@/lib/credentials/types";
import type { DriverContext } from "@/lib/drivers/types";
import { StepFailedError } from "@/lib/execution/errors";
import { isVaultRef } from "@/lib/secrets/refs";
import { readSecretValueAsync } from "@/lib/secrets";
import { assertSessionMatches, type ZenithSession } from "@/lib/providers/zenith/session";
import { createKubernetesSession, validateServerUrl } from "../session";
import { createK8sClient, listByKind, readObject } from "../client";
import { dig, isRecord } from "../util";
import { renderBuildCustody } from "./rbac";
import { containsExpected } from "./admission";
import { releaseContext } from "../release/support";
import { ConfigSchema, validateConfig, type IsolatedBuildConfig } from "./config";

export interface TenantBuildRef { workspaceId: string; environmentId: string; provider: string }
export const buildTenantKey = (ref: Pick<TenantBuildRef, "workspaceId" | "environmentId">): string =>
  digest(["zenith.build-tenant.v1", ref.workspaceId, ref.environmentId]).slice(0, 40);

export const TenantBuildProfileSchema = z.object({
  workspaceId: z.string().min(1).max(200), environmentId: z.string().min(1).max(200),
  provider: z.enum(["zenith", "kubernetes"]),
  server: z.string(), caData: z.string().optional(),
  credentialRef: z.string().refine(isVaultRef),
  verifierCredentialRef: z.string().refine(isVaultRef),
  registryRepositoryRoot: z.string().regex(/^[a-z0-9][a-z0-9.:/_-]*\/[a-z0-9._/-]+$/).optional(),
  config: ConfigSchema,
}).strict();
export type TenantBuildProfile = z.infer<typeof TenantBuildProfileSchema>;

export function readBuildProfiles(env: Record<string, string | undefined> = process.env): TenantBuildProfile[] {
  let raw: unknown;
  try { raw = JSON.parse(env.ZENITH_ISOLATED_BUILD_PROFILES ?? ""); } catch {
    throw new StepFailedError("Source builds require ZENITH_ISOLATED_BUILD_PROFILES with separately provisioned tenant build custody and dedicated nodes.");
  }
  const parsed = z.array(TenantBuildProfileSchema).min(1).max(1000).safeParse(raw);
  if (!parsed.success) throw new StepFailedError("The tenant build profiles are incomplete; supply pinned images, reviewed runtime profiles, node isolation and separate vault references.");
  const profiles = parsed.data;
  const unique = new Set<string>(), namespaces = new Set<string>();
  for (const profile of profiles) {
    profile.config = validateConfig(profile.config);
    const key = buildTenantKey(profile);
    const identity = profile.provider + ":" + key;
    if (unique.has(identity) || namespaces.has(profile.config.namespace) || namespaces.has(profile.config.proxy.namespace)) {
      throw new StepFailedError("Tenant build profiles may not share namespaces or contain duplicate targets.");
    }
    if (profile.credentialRef === profile.verifierCredentialRef || profile.config.namespace !== "zb-" + key ||
        profile.config.proxy.namespace !== "zp-" + key || profile.config.nodeIsolation.tenant !== key) {
      throw new StepFailedError("Build custody must use separate credentials, tenant-derived namespaces and tenant-dedicated nodes.");
    }
    if (profile.provider === "kubernetes" && (!profile.registryRepositoryRoot || !profile.registryRepositoryRoot.endsWith("/" + key))) {
      throw new StepFailedError("Native Kubernetes builds require a tenant-owned registry repository root ending in the build tenant key.");
    }
    validateServerUrl(profile.server);
    unique.add(identity); namespaces.add(profile.config.namespace); namespaces.add(profile.config.proxy.namespace);
  }
  return profiles;
}
export function tenantBuildProfile(ref: TenantBuildRef, env: Record<string, string | undefined> = process.env): TenantBuildProfile {
  const profile = readBuildProfiles(env).find(p => p.workspaceId === ref.workspaceId && p.environmentId === ref.environmentId && p.provider === ref.provider);
  if (!profile) throw new StepFailedError("This environment has no provisioned tenant build custody and node isolation profile; source execution is refused.");
  return profile;
}
export const buildProfileDigest = (profile: TenantBuildProfile): string => digest(profile);

export interface BuildCustodyPort {
  profile(ref: TenantBuildRef): TenantBuildProfile;
  withSessions<T>(ctx: TenantBuildRef & { signal: AbortSignal; session?: unknown; reviewedBuildProfileDigest?: string },
    fn: (writer: KubernetesSession, verifier: KubernetesSession, profile: TenantBuildProfile) => Promise<T>): Promise<T>;
}

/** Check effective rules rather than assuming a credential's vault name or RBAC manifest proves authority. */
export function assertBuildRules(rules: { apiGroups?: string[]; resources?: string[]; verbs?: string[]; resourceNames?: string[] }[], namespace: string, config: IsolatedBuildConfig): void {
  const build = namespace === config.namespace;
  for (const rule of rules) {
    for (const group of rule.apiGroups ?? []) for (const resource of rule.resources ?? []) for (const verb of rule.verbs ?? []) {
      const read = ["get", "list", "watch"].includes(verb);
      const allowed = group === "" && read && ["pods", "serviceaccounts", "resourcequotas", "namespaces"].includes(resource) ||
        group === "authorization.k8s.io" && verb === "create" && ["selfsubjectaccessreviews", "selfsubjectrulesreviews"].includes(resource) ||
        group === "authentication.k8s.io" && verb === "create" && resource === "selfsubjectreviews" ||
        group === "batch" && resource === "jobs" && (read || build && verb === "create") ||
        group === "" && resource === "secrets" && build && ["get", "create"].includes(verb) ||
        group === "" && resource === "configmaps" && !build && read ||
        group === "" && resource === "services" && !build && read ||
        group === "apps" && resource === "deployments" && !build && read ||
        group === "networking.k8s.io" && resource === "networkpolicies" && read ||
        // Stock Kubernetes grants every service account ClusterTrustBundle reads (public CA bundles only).
        group === "certificates.k8s.io" && resource === "clustertrustbundles" && read;
      if (!allowed) throw new StepFailedError("The tenant build controller has authority outside its reviewed build role; deployment credentials are refused.");
    }
  }
}
const kubeConfig = (session: KubernetesSession): KubeConfig => session.kubeConfig() as KubeConfig;
async function identity(session: KubernetesSession, expected: string): Promise<void> {
  const api = kubeConfig(session).makeApiClient(AuthenticationV1Api) as AuthenticationV1Api;
  const result = await api.createSelfSubjectReview({ body: { apiVersion: "authentication.k8s.io/v1", kind: "SelfSubjectReview" } });
  const namespace = expected.split(":")[2];
  const groups = result.status?.userInfo?.groups ?? [];
  const wantedGroups = ["system:authenticated", "system:serviceaccounts", "system:serviceaccounts:" + namespace];
  if (groups.length !== wantedGroups.length || groups.some(group => !wantedGroups.includes(group))) throw new StepFailedError("The tenant build identity has unreviewed authentication groups; source execution is refused.");
  if (result.status?.userInfo?.username !== expected) throw new StepFailedError("The vault credential is not the expected tenant build identity; no privileged fallback is allowed.");
}
/** Complete binding readback also catches grants in namespaces other than the two build namespaces. */
async function assertCustodyBindings(verifier: KubernetesSession, c: IsolatedBuildConfig, signal: AbortSignal): Promise<void> {
  const client = createK8sClient(verifier, { signal });
  const bindings = [];
  for (const kind of ["RoleBinding", "ClusterRoleBinding"]) {
    const result = await listByKind(client, { apiVersion: "rbac.authorization.k8s.io/v1", kind, namespaced: kind === "RoleBinding" }, undefined);
    if (result.truncated || result.unavailable) throw new StepFailedError("All build identity role bindings must be readable.");
    bindings.push(...result.items);
  }
  const expected = renderBuildCustody(c);
  for (const binding of bindings) {
    const subjects = binding.subjects;
    if (!Array.isArray(subjects) || !subjects.some(subject => isRecord(subject) &&
      (subject.kind === "ServiceAccount" && (subject.name === "zenith-build-controller" && subject.namespace === c.namespace ||
        subject.name === "zenith-build-verifier" && subject.namespace === c.proxy.namespace) ||
       subject.kind === "User" && ["system:serviceaccount:" + c.namespace + ":zenith-build-controller", "system:serviceaccount:" + c.proxy.namespace + ":zenith-build-verifier"].includes(String(subject.name)) ||
       subject.kind === "Group" && ["system:authenticated", "system:serviceaccounts", "system:serviceaccounts:" + c.namespace, "system:serviceaccounts:" + c.proxy.namespace].includes(String(subject.name))))) continue;
    const wanted = expected.find(object => object.kind === binding.kind && object.metadata.name === dig(binding, "metadata", "name") &&
      object.metadata.namespace === dig(binding, "metadata", "namespace"));
    if (!wanted) {
      // Built-in authenticated discovery/self-review only. Check the live role's entire rule set. Kubernetes binds the
      // service-account issuer (OIDC) and ClusterTrustBundle discovery roles to every service account by default.
      const roleName = dig(binding, "roleRef", "name");
      if (binding.kind !== "ClusterRoleBinding" || !["system:basic-user", "system:discovery", "system:public-info-viewer",
        "system:service-account-issuer-discovery", "system:cluster-trust-bundle-discovery"].includes(String(roleName))) {
        throw new StepFailedError("A build custody identity has an additional role binding; source execution is refused.");
      }
      const role = await readObject(client, { apiVersion: "rbac.authorization.k8s.io/v1", kind: "ClusterRole", name: String(roleName) });
      if (!role || !Array.isArray(role.rules)) throw new StepFailedError("Built-in discovery authority could not be read.");
      for (const rule of role.rules) {
        if (!isRecord(rule)) throw new StepFailedError("Invalid discovery authority.");
        if (rule.nonResourceURLs) {
          if (!Array.isArray(rule.verbs) || rule.verbs.some(v => v !== "get") || !Array.isArray(rule.nonResourceURLs) ||
            (rule.nonResourceURLs ?? []).some(url => typeof url !== "string" || !/^\/(api|apis|healthz|livez|readyz|version|openapi)(\/\*|\/)?$/.test(url)
              && !/^\/(\.well-known\/openid-configuration|openid\/v1\/jwks)\/?$/.test(url))) {
            throw new StepFailedError("Unreviewed discovery authority.");
          }
        } else if (roleName === "system:cluster-trust-bundle-discovery") {
          // Public CA bundles only: exactly ClusterTrustBundle reads, nothing else.
          if (JSON.stringify(rule.apiGroups) !== JSON.stringify(["certificates.k8s.io"]) || JSON.stringify(rule.resources) !== JSON.stringify(["clustertrustbundles"])
            || rule.resourceNames !== undefined || !Array.isArray(rule.verbs) || rule.verbs.some(v => !["get", "list", "watch"].includes(String(v)))) {
            throw new StepFailedError("Unreviewed discovery authority.");
          }
        } else assertBuildRules([rule], c.namespace, c);
      }
      continue;
    }
    if (!containsExpected(binding.subjects, wanted.subjects) || !containsExpected(binding.roleRef, wanted.roleRef)) {
      throw new StepFailedError("The tenant build role binding changed.");
    }
  }
  // Compare every rendered role, not just its name. No extra verbs/resources may hide in a rule.
  for (const wanted of expected.filter(object => object.kind === "Role" || object.kind === "ClusterRole")) {
    const role = await readObject(client, { apiVersion: wanted.apiVersion, kind: wanted.kind, name: wanted.metadata.name, namespace: wanted.metadata.namespace });
    if (!role || digest(role.rules) !== digest(wanted.rules)) throw new StepFailedError("The tenant build custody role is absent or has changed.");
  }
}
async function assertAccess(writer: KubernetesSession, verifier: KubernetesSession, c: IsolatedBuildConfig, signal: AbortSignal): Promise<void> {
  await assertCustodyBindings(verifier, c, signal);
  await identity(writer, "system:serviceaccount:" + c.namespace + ":zenith-build-controller");
  await identity(verifier, "system:serviceaccount:" + c.proxy.namespace + ":zenith-build-verifier");
  const authorization = kubeConfig(writer).makeApiClient(AuthorizationV1Api) as AuthorizationV1Api;
  for (const namespace of [c.namespace, c.proxy.namespace]) {
    const result = await authorization.createSelfSubjectRulesReview({ body: { apiVersion: "authorization.k8s.io/v1", kind: "SelfSubjectRulesReview", spec: { namespace } } });
    if (!result.status || result.status.incomplete || result.status.evaluationError) {
      throw new StepFailedError("Build credential permissions could not be completely reviewed.");
    }
    for (const rule of result.status.nonResourceRules ?? []) {
      if (rule.verbs.some(v => v !== "get") || (rule.nonResourceURLs ?? []).some(url =>
          !["/api", "/api/*", "/apis", "/apis/*", "/healthz", "/livez", "/readyz", "/version", "/version/", "/openapi", "/openapi/*",
            // Stock service-account issuer discovery (OIDC metadata and public signing keys).
            "/.well-known/openid-configuration", "/.well-known/openid-configuration/", "/openid/v1/jwks", "/openid/v1/jwks/"].includes(url))) {
        throw new StepFailedError("Build credentials have unreviewed non-resource authority.");
      }
    }
    assertBuildRules(result.status.resourceRules, namespace, c);
  }
  const probes = [
    { session: writer, attributes: { verb: "create", group: "batch", resource: "jobs", namespace: c.namespace }, expected: true },
    { session: writer, attributes: { verb: "create", group: "batch", resource: "jobs", namespace: c.proxy.namespace }, expected: false },
    { session: writer, attributes: { verb: "get", resource: "secrets", namespace: "kube-system" }, expected: false },
    { session: writer, attributes: { verb: "create", group: "rbac.authorization.k8s.io", resource: "clusterrolebindings" }, expected: false },
    { session: verifier, attributes: { verb: "list", resource: "nodes" }, expected: true },
    { session: verifier, attributes: { verb: "list", resource: "pods" }, expected: true },
    { session: verifier, attributes: { verb: "get", resource: "secrets", namespace: c.namespace }, expected: false },
    { session: verifier, attributes: { verb: "create", group: "batch", resource: "jobs", namespace: c.namespace }, expected: false },
  ];
  for (const probe of probes) {
    const api = kubeConfig(probe.session).makeApiClient(AuthorizationV1Api) as AuthorizationV1Api;
    const result = await api.createSelfSubjectAccessReview({ body: { apiVersion: "authorization.k8s.io/v1", kind: "SelfSubjectAccessReview", spec: { resourceAttributes: probe.attributes } } });
    if (result.status?.evaluationError || result.status?.allowed !== probe.expected) throw new StepFailedError("The tenant build credential lacks required custody permissions or holds forbidden deployment authority.");
  }
}
export function createBuildCustody(options: { env?: Record<string, string | undefined> } = {}): BuildCustodyPort {
  const environment = () => options.env ?? process.env;
  return {
    profile: ref => tenantBuildProfile(ref, environment()),
    async withSessions(ctx, fn) {
      const profile = tenantBuildProfile(ctx, environment());
      if (ctx.reviewedBuildProfileDigest && ctx.reviewedBuildProfileDigest !== buildProfileDigest(profile)) {
        throw new StepFailedError("The reviewed tenant build custody profile changed; plan again and approve the new build profile.");
      }
      if (ctx.session) {
        const deployment = ctx.provider === "zenith" ? (assertSessionMatches(ctx.session as ZenithSession, ctx), (ctx.session as ZenithSession).kubernetes) :
          releaseContext(ctx as DriverContext).session;
        if (validateServerUrl(kubeConfig(deployment).getCurrentCluster()?.server ?? "") !== validateServerUrl(profile.server)) {
          throw new StepFailedError("Build custody belongs to another cluster than the approved deployment target.");
        }
      }
      const scope = ctx.provider === "zenith" ? environment().ZENITH_MANAGED_VAULT_SCOPE ?? "zenith-platform" : ctx.workspaceId;
      const open = (ref: string, namespaces: string[]) => createKubernetesSession({
        provider: "kubernetes", mode: "kubeconfig_ref", server: profile.server,
        ...(profile.caData ? { caData: profile.caData } : {}), credentialRef: ref, namespaces,
      }, { ttlSec: 3600, resolveCredential: async reference => {
        const value = await readSecretValueAsync(scope, reference);
        if (!value) throw new StepFailedError("The tenant build credential is unavailable in its owning vault scope.");
        return value;
      } }, ctx.signal);
      let writer: KubernetesSession, verifier: KubernetesSession;
      try {
        ctx.signal.throwIfAborted();
        writer = await open(profile.credentialRef, [profile.config.namespace, profile.config.proxy.namespace]);
        verifier = await open(profile.verifierCredentialRef, [profile.config.namespace, profile.config.proxy.namespace]);
        await assertAccess(writer, verifier, profile.config, ctx.signal);
      } catch (error) {
        if (error instanceof StepFailedError) throw error;
        // Never expose echoed Kubernetes/vault response text.
        throw new StepFailedError("Tenant build custody could not be verified: check the vault references, API identity and reviewed build RBAC.");
      }
      return fn(writer, verifier, profile);
    },
  };
}
