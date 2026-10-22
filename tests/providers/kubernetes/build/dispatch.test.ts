/** Scripted Kubernetes/registry/vault contract, exercising the actual default factory and custody gates.
 * No probe in this file establishes runtime isolation. The operated harness runs on the Mac. */
import { createHash, randomBytes } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { KubernetesConnectionConfig, KubernetesSession } from "@/lib/credentials/types";
import type { DriverContext } from "@/lib/drivers/types";
import type { ManagedSubstratePort } from "@/lib/providers/zenith/managed-port";
import type { K8sClient } from "@/lib/providers/kubernetes/client";
import { createReleasePorts } from "@/lib/platform/release";
import { createIsolatedSourceStore } from "@/lib/providers/kubernetes/build/source";
import { renderBaseline, renderProxy, buildName, buildKey, sourceName, BUILD_NODE_LABEL, BUILD_PROFILE_LABEL, BUILD_TAINT } from "@/lib/providers/kubernetes/build/render";
import { renderBuildCustody } from "@/lib/providers/kubernetes/build/rbac";
import { PROBE_CHECKS } from "@/lib/providers/kubernetes/build/admission";
import { buildProfileDigest } from "@/lib/providers/kubernetes/build/custody";
import { configDigest } from "@/lib/providers/kubernetes/build/config";
import { dig } from "@/lib/providers/kubernetes/util";
import type { ResourceNode } from "@/lib/resources/types";
import { profile, ref, key } from "./fixtures";

const hooks = vi.hoisted(() => ({
  state: undefined as Script | undefined,
}));
vi.mock("@/lib/secrets", () => ({
  readSecretValueAsync: async (scope: string, reference: string) => {
    hooks.state!.vault.push([scope, reference]); return hooks.state!.secret;
  },
}));
vi.mock("@/lib/providers/kubernetes/session", async original => ({
  ...await original<typeof import("@/lib/providers/kubernetes/session")>(),
  createKubernetesSession: async (cfg: KubernetesConnectionConfig, deps: { resolveCredential(ref: string): Promise<string> }) => {
    await deps.resolveCredential(cfg.credentialRef!); return hooks.state!.session(cfg);
  },
}));
vi.mock("@/lib/providers/kubernetes/client", async original => ({
  ...await original<typeof import("@/lib/providers/kubernetes/client")>(),
  createK8sClient: () => hooks.state!.client,
  readObject: async (_client: unknown, target: { kind: string; namespace?: string; name: string }) => hooks.state!.objects.get([target.kind, target.namespace ?? "", target.name].join("/")),
  listByKind: async (_client: unknown, target: { kind: string }, namespace?: string, opts?: { labelSelector?: string }) => {
    const s = hooks.state!;
    const items = target.kind === "Node" ? [s.node] : target.kind === "Pod" ? (namespace === s.profile.config.proxy.namespace ? [s.proxyPod] : namespace === s.profile.config.namespace ? [...s.jobs.values()].filter(job => !opts?.labelSelector || opts.labelSelector.endsWith(String(dig(job, "metadata", "uid")))).map(job => s.pod(job)) : [...s.jobs.values()].map(job => s.pod(job))) :
      [...s.objects.values()].filter(object => object.kind === target.kind && (!namespace || dig(object, "metadata", "namespace") === namespace));
    return { items, truncated: false, unavailable: false };
  },
}));

type ObjectRow = Record<string, unknown>;
class Script {
  profile: typeof profile;
  secret = randomBytes(24).toString("hex");
  vault: string[][] = [];
  objects = new Map<string, ObjectRow>();
  jobs = new Map<string, ObjectRow>();
  launches: string[] = [];
  proof = Object.fromEntries(PROBE_CHECKS.map(k => [k, true]));
  outputDigest = "";
  wrongIdentity = false;
  extraGroup = false;
  deniedBuildAccess = false;
  stockRules: ObjectRow[] = [];
  stockUrls: string[] = [];
  node: ObjectRow;
  proxyPod: ObjectRow;
  client: K8sClient;
  constructor(provider: "zenith" | "kubernetes") {
    this.profile = { ...structuredClone(profile), provider };
    const c = this.profile.config;
    for (const object of [...renderBaseline(c), ...renderProxy(c), ...renderBuildCustody(c)]) this.put({
      ...object, metadata: { ...object.metadata, uid: "uid-" + object.metadata.name, generation: 1, resourceVersion: "1" },
      ...(object.kind === "Deployment" ? { status: { observedGeneration: 1, availableReplicas: 1 } } : {}),
    });
    this.put({ apiVersion: "node.k8s.io/v1", kind: "RuntimeClass", metadata: { name: c.runtimeClass, uid: "runtime", resourceVersion: "1" }, handler: "userns" });
    this.node = { metadata: { name: "build-node", uid: "node", labels: { [BUILD_NODE_LABEL]: key,
      [BUILD_PROFILE_LABEL]: c.nodeIsolation.profileDigest.slice(0, 63), "kubernetes.io/hostname": "build-node" } },
      spec: { taints: ["NoSchedule", "NoExecute"].map(effect => ({ key: BUILD_TAINT, value: key, effect })) }, status: { conditions: [{ type: "Ready", status: "True" }] } };
    const proxy = renderProxy(c).find(object => object.kind === "Deployment")!;
    this.proxyPod = { spec: dig(proxy, "spec", "template", "spec"), status: { containerStatuses: [{ ready: true, imageID: c.proxy.image }] } };
    this.client = { guard: { assert: async () => undefined }, objects: {
      create: async (object: ObjectRow) => {
        if (object.kind === "Job") {
          const name = String(dig(object, "metadata", "name")); this.launches.push(name);
          const probe = name.endsWith("-probe");
          const now = Date.now() - (probe ? 500 : 0);
          const live = { ...object, metadata: { ...object.metadata as ObjectRow, uid: name }, status: {
            startTime: new Date(now).toISOString(), completionTime: new Date(now).toISOString(), conditions: [{ type: "Complete", status: "True" }] } };
          this.jobs.set(name, live); this.put(live);
        } else this.put({ ...object, metadata: { ...object.metadata as ObjectRow, uid: "source", resourceVersion: "1" } });
        return object;
      },
    } } as unknown as K8sClient;
  }
  put(object: ObjectRow) { this.objects.set([object.kind, dig(object, "metadata", "namespace") ?? "", dig(object, "metadata", "name")].join("/"), object); }
  pod(job: ObjectRow): ObjectRow {
    const name = String(dig(job, "metadata", "name")), probe = name.endsWith("-probe");
    return { metadata: { namespace: this.profile.config.namespace, labels: { "zenith.dev/isolated-build": "true" }, ownerReferences: [{ uid: name, controller: true, kind: "Job" }] },
      spec: { ...dig(job, "spec", "template", "spec") as ObjectRow, nodeName: "build-node" }, status: {
        phase: "Succeeded", containerStatuses: [{ imageID: this.profile.config.builderImage, state: { terminated: { exitCode: 0,
          message: JSON.stringify(probe ? { version: 1, checks: this.proof } : { digest: this.outputDigest, provenanceRequested: true }) } } }] } };
  }
  session(cfg: KubernetesConnectionConfig): KubernetesSession {
    const verifier = cfg.credentialRef === this.profile.verifierCredentialRef;
    const c = this.profile.config;
    const api = {
      createSelfSubjectReview: async () => ({ status: { userInfo: { groups: ["system:authenticated", "system:serviceaccounts", "system:serviceaccounts:" + (verifier ? c.proxy.namespace : c.namespace), ...(this.extraGroup ? ["system:masters"] : [])], username: this.wrongIdentity ? "system:serviceaccount:workloads:deployment" : "system:serviceaccount:" + (verifier ? c.proxy.namespace + ":zenith-build-verifier" : c.namespace + ":zenith-build-controller") } } }),
      createSelfSubjectRulesReview: async ({ body }: { body: { spec: { namespace: string } } }) => ({ status: { incomplete: false, resourceRules:
        renderBuildCustody(c).filter(object => object.kind === "Role" && object.metadata.namespace === body.spec.namespace && object.metadata.name === (body.spec.namespace === c.namespace ? "zenith-build-controller" : "zenith-build-read")).flatMap(object => object.rules as ObjectRow[]).concat(this.stockRules),
        nonResourceRules: this.stockUrls.length ? [{ verbs: ["get"], nonResourceURLs: this.stockUrls }] : [] } }),
      createSelfSubjectAccessReview: async ({ body }: { body: { spec: { resourceAttributes: { verb: string; resource: string; namespace?: string } } } }) => {
        const a = body.spec.resourceAttributes;
        return { status: { allowed: verifier ? a.verb === "list" && ["nodes", "pods"].includes(a.resource) :
          !this.deniedBuildAccess && a.verb === "create" && a.resource === "jobs" && a.namespace === c.namespace } };
      },
    };
    return { provider: "kubernetes", namespaces: cfg.namespaces, kubeConfig: () => ({ getCurrentCluster: () => ({ server: this.profile.server }), makeApiClient: () => api }) } as unknown as KubernetesSession;
  }
  registry(builder: string) {
    const blobs = new Map<string, Buffer>();
    const put = (part: string, value: unknown) => { const bytes = Buffer.from(JSON.stringify(value)); const sha = "sha256:" + createHash("sha256").update(bytes).digest("hex"); blobs.set(part + "/" + sha, bytes); return sha; };
    const image = put("manifests", { schemaVersion: 2, layers: [] });
    const layer = put("blobs", { _type: "https://in-toto.io/Statement/v1", predicateType: "https://slsa.dev/provenance/v1", subject: [{ digest: { sha256: image.slice(7) } }],
      predicate: { buildDefinition: { buildType: "https://github.com/moby/buildkit/fixture", resolvedDependencies: [] }, runDetails: { builder: { id: builder } } } });
    const attestation = put("manifests", { schemaVersion: 2, layers: [{ digest: layer, mediaType: "application/vnd.in-toto+json", annotations: { "in-toto.io/predicate-type": "https://slsa.dev/provenance/v1" } }] });
    this.outputDigest = put("manifests", { schemaVersion: 2, mediaType: "application/vnd.oci.image.index.v1+json", manifests: [
      { digest: image, platform: { os: "linux", architecture: "arm64" } },
      { digest: attestation, annotations: { "vnd.docker.reference.type": "attestation-manifest", "vnd.docker.reference.digest": image } },
    ] });
    vi.stubGlobal("fetch", async (input: string) => { const path = input.split(/\/(manifests|blobs)\//); const bytes = blobs.get(path[1] + "/" + path[2]); if (!bytes) throw Error("Unscripted registry read"); return new Response(new Uint8Array(bytes)); });
  }
}
afterEach(() => { hooks.state = undefined; vi.unstubAllEnvs(); vi.unstubAllGlobals(); });
function setup(provider: "zenith" | "kubernetes") {
  const s = new Script(provider); hooks.state = s;
  vi.stubEnv("ZENITH_ISOLATED_BUILD_PROFILES", JSON.stringify([s.profile]));
  const ctx = { ...ref, provider, region: "local", operationId: "op-j6", signal: AbortSignal.timeout(30_000), reviewedBuildProfileDigest: buildProfileDigest(s.profile),
    session: s.session({ credentialRef: "vault:deploy", namespaces: ["workloads"] } as KubernetesConnectionConfig) } as unknown as DriverContext;
  if (provider === "zenith") ctx.session = { provider, kubernetes: ctx.session, tenant: ref };
  const make = (address: string, kind: ResourceNode["kind"], spec: Record<string, unknown>) => ({
    address, kind, provider, nativeType: "k8s:" + kind, region: ctx.region, spec, specDigest: "a".repeat(64), ownership: "managed", labels: {}, dependsOn: [], origin: [],
  } as ResourceNode);
  const service = make("container_service/web", "container_service", { artifact: { type: "built", pipeline: "build_pipeline/web", registry: "container_registry/web" } });
  const pipeline = make("build_pipeline/web", "build_pipeline", { source: { repo: "fixture/web", ref: "main", dockerfile: "Dockerfile" }, output: { registry: "container_registry/web" } });
  const registry = make("container_registry/web", "container_registry", {});
  const managed = { registry: () => ({ repositoryFor: () => s.profile.registryRepositoryRoot + "/web" }) } as unknown as ManagedSubstratePort;
  return { s, ctx, input: { service, pipeline, registry, idempotencyKey: "once" }, ports: createReleasePorts({ managed }) };
}
describe("default build dispatch and custody [scripted contract]", () => {
  it.each(["kubernetes", "zenith"] as const)("constructs the %s builder, verifies custody, probes before source execution and verifies published OCI bytes", async provider => {
    const { s, ctx, input, ports } = setup(provider);
    const archive = Buffer.from("contract source bytes"), sha256 = createHash("sha256").update(archive).digest("hex");
    const stored = await createIsolatedSourceStore().upload(ctx, { archive, sha256, bytes: archive.length });
    const source = { bucket: stored.namespace, s3Key: stored.name, digest: sha256 };
    const request = { workspaceId: ref.workspaceId, environmentId: ref.environmentId, operationId: ctx.operationId!, serviceAddress: input.service.address, pipelineAddress: input.pipeline.address,
      sourceSecret: sourceName(ref.environmentId, sha256), sourceDigest: sha256, image: "", dockerfile: "Dockerfile", contextDir: ".", idempotencyKey: input.idempotencyKey };
    const repository = s.profile.registryRepositoryRoot + "/web";
    request.image = repository + ":zn-" + buildKey({ ...request, image: repository }).slice(0, 40);
    s.registry("zenith-isolated:" + configDigest(s.profile.config) + ":" + buildKey(request));
    const handle = await ports.build.startBuild(ctx, { ...input, source });
    expect(s.launches).toEqual([buildName(request) + "-probe", buildName(request)]);
    expect(s.vault.every(([scope]) => scope === (provider === "zenith" ? "zenith-platform" : ref.workspaceId))).toBe(true);
    expect(s.vault.some(([, credential]) => credential === "vault:deploy")).toBe(false);
    const result = await ports.build.waitForBuild(ctx, handle, { timeoutMs: 1000 });
    expect(result).toMatchObject({ status: "succeeded", digest: s.outputDigest, attestation: { isolation: { profileId: provider === "zenith" ? "zenith.k8s-build.v1" : "kubernetes.rootless-build.v1" } } });
    expect(result.imageUri).toBe(repository + "@" + s.outputDigest);
  });
  it("refuses a failed runtime prerequisite before creating the source build Job", async () => {
    const { s, ctx, input, ports } = setup("kubernetes");
    const archive = Buffer.from("source"), sha256 = createHash("sha256").update(archive).digest("hex");
    const stored = await createIsolatedSourceStore().upload(ctx, { archive, sha256, bytes: archive.length });
    s.proof.metadataDenied = false;
    await expect(ports.build.startBuild(ctx, { ...input, source: { bucket: stored.namespace, s3Key: stored.name, digest: sha256 } })).rejects.toThrow(/Every runtime isolation/);
    expect(s.launches).toHaveLength(1); expect(s.launches[0]).toMatch(/-probe$/);
  });
  it("refuses release after the probed node is replaced", async () => {
    const { s, ctx, input, ports } = setup("kubernetes");
    const archive = Buffer.from("source"), sha256 = createHash("sha256").update(archive).digest("hex");
    const stored = await createIsolatedSourceStore().upload(ctx, { archive, sha256, bytes: archive.length });
    const handle = await ports.build.startBuild(ctx, { ...input, source: { bucket: stored.namespace, s3Key: stored.name, digest: sha256 } });
    (s.node.metadata as ObjectRow).uid = "replacement";
    await expect(ports.build.waitForBuild(ctx, handle, { timeoutMs: 1000 })).rejects.toThrow(/node allocation changed/);
  });
  it.each(["wrongIdentity", "deniedBuildAccess", "extraGroup"] as const)("refuses %s before source custody or execution", async failure => {
    const { s, ctx } = setup("kubernetes"); s[failure] = true;
    const archive = Buffer.from("source"), sha256 = createHash("sha256").update(archive).digest("hex");
    await expect(createIsolatedSourceStore().upload(ctx, { archive, sha256, bytes: archive.length })).rejects.toThrow(/identity|permissions/);
    expect(s.launches).toHaveLength(0);
    expect([...s.objects.values()].filter(object => object.kind === "Secret")).toHaveLength(0);
  });
  it("refuses an extra role binding even outside the build namespaces", async () => {
    const { s, ctx } = setup("kubernetes");
    s.put({ apiVersion: "rbac.authorization.k8s.io/v1", kind: "RoleBinding", metadata: { name: "deploy", namespace: "another-tenant" },
      subjects: [{ kind: "ServiceAccount", name: "zenith-build-controller", namespace: s.profile.config.namespace }], roleRef: { kind: "Role", name: "deploy" } });
    const archive = Buffer.from("source"), sha256 = createHash("sha256").update(archive).digest("hex");
    await expect(createIsolatedSourceStore().upload(ctx, { archive, sha256, bytes: archive.length })).rejects.toThrow(/additional role binding/);
    expect(s.launches).toHaveLength(0);
  });
  // Stock Kubernetes (kind v1.37) binds these two discovery roles to every service account.
  const stockDiscovery = (s: ReturnType<typeof setup>["s"], trustVerbs = ["get", "list", "watch"], oidcUrls = ["/.well-known/openid-configuration", "/.well-known/openid-configuration/", "/openid/v1/jwks", "/openid/v1/jwks/"]) => {
    for (const [name, rules] of [
      ["system:service-account-issuer-discovery", [{ nonResourceURLs: oidcUrls, verbs: ["get"] }]],
      ["system:cluster-trust-bundle-discovery", [{ apiGroups: ["certificates.k8s.io"], resources: ["clustertrustbundles"], verbs: trustVerbs }]],
    ] as const) {
      s.put({ apiVersion: "rbac.authorization.k8s.io/v1", kind: "ClusterRoleBinding", metadata: { name }, subjects: [{ kind: "Group", name: "system:serviceaccounts" }], roleRef: { kind: "ClusterRole", name } });
      s.put({ apiVersion: "rbac.authorization.k8s.io/v1", kind: "ClusterRole", metadata: { name }, rules });
    }
    // The live rules review reports the stock grants the bindings give every service account.
    s.stockRules = [{ apiGroups: ["certificates.k8s.io"], resources: ["clustertrustbundles"], verbs: trustVerbs }];
    s.stockUrls = oidcUrls;
  };
  it("admits the stock service-account issuer and ClusterTrustBundle discovery bindings", async () => {
    const { s, ctx } = setup("kubernetes"); stockDiscovery(s);
    const archive = Buffer.from("source"), sha256 = createHash("sha256").update(archive).digest("hex");
    await expect(createIsolatedSourceStore().upload(ctx, { archive, sha256, bytes: archive.length })).resolves.toBeTruthy();
  });
  it("refuses an unreviewed non-resource URL in the live rules review", async () => {
    const { s, ctx } = setup("kubernetes"); stockDiscovery(s); s.stockUrls = [...s.stockUrls, "/metrics"];
    const archive = Buffer.from("source"), sha256 = createHash("sha256").update(archive).digest("hex");
    await expect(createIsolatedSourceStore().upload(ctx, { archive, sha256, bytes: archive.length })).rejects.toThrow(/unreviewed non-resource authority/);
    expect(s.launches).toHaveLength(0);
  });
  it.each([
    ["a writable ClusterTrustBundle role", ["get", "list", "watch", "create"], undefined],
    ["an extra non-resource URL on the issuer role", undefined, ["/.well-known/openid-configuration", "/metrics"]],
  ] as const)("refuses %s before source custody", async (_case, trustVerbs, oidcUrls) => {
    const { s, ctx } = setup("kubernetes"); stockDiscovery(s, trustVerbs ? [...trustVerbs] : undefined, oidcUrls ? [...oidcUrls] : undefined);
    const archive = Buffer.from("source"), sha256 = createHash("sha256").update(archive).digest("hex");
    await expect(createIsolatedSourceStore().upload(ctx, { archive, sha256, bytes: archive.length })).rejects.toThrow(/Unreviewed discovery authority/);
    expect(s.launches).toHaveLength(0);
  });
  it("refuses changed reviewed custody before reading credentials or launching any Job", async () => {
    const { s, ctx, input, ports } = setup("kubernetes");
    ctx.reviewedBuildProfileDigest = "0".repeat(64);
    await expect(createIsolatedSourceStore().upload(ctx, { archive: Buffer.from("source"), sha256: createHash("sha256").update("source").digest("hex"), bytes: 6 })).rejects.toThrow(/reviewed tenant build custody/);
    expect(s.vault).toHaveLength(0); expect(s.launches).toHaveLength(0);
    await expect(ports.build.startBuild(ctx, { ...input, source: { bucket: s.profile.config.namespace, s3Key: sourceName(ref.environmentId, "1".repeat(64)), digest: "1".repeat(64) } })).rejects.toThrow(/reviewed tenant build custody/);
    expect(s.vault).toHaveLength(0);
  });
});
