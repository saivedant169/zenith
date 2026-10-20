/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * PROD-MAN-01 acceptance of the managed substrate against a REAL (local) cluster. GATED: skipped, with the
 * reason below, unless every one of these is set. Run it through scripts/k8s/managed-substrate-acceptance.sh,
 * which creates a disposable kind + Calico cluster, installs the baseline, a registry and the sealed operator
 * credential, and sets all of them:
 *
 *   ZENITH_TEST_MANAGED_KIND=1
 *   ZENITH_MANAGED_CLUSTER_SERVER, ZENITH_MANAGED_CLUSTER_CA_DATA, ZENITH_MANAGED_KUBECONFIG_REF,
 *   ZENITH_MANAGED_APP_DOMAIN, ZENITH_MANAGED_GATEWAY_MODE=ingress, ZENITH_MANAGED_INGRESS_CLASS,
 *   ZENITH_MANAGED_REGISTRY, ZENITH_MANAGED_BUILDER_IMAGE (digest-pinned), ZENITH_MANAGED_BUILD_REGISTRY_INSECURE
 *   ZENITH_DATA, ZENITH_STORE=file, ZENITH_SECRET_KEY   the vault the operator credential was sealed into
 *   ZENITH_TEST_MANAGED_WORKLOAD_IMAGE                  a digest-pinned image (busybox)
 *   KUBECONFIG                                          the cluster's ADMIN kubeconfig, used only by the probe pods
 *   ZENITH_MANAGED_OPERATOR_CREDENTIAL_PREFIX           where reviewed onboarding seals each tenant's operator token
 *
 * What this proves that the contract fakes cannot, and what it does not:
 *   - the DEFAULT composition (`createDefaultManagedSubstrate`) builds a working port from the environment and the
 *     platform vault scope alone: no injected port, session factory, credential resolver or toolkit
 *   - tenant-scoped sessions: the managed apply pipeline creates the tenancy baseline and a workload in the tenant
 *     namespace on a real API server; the session cannot reach another tenant, the build namespace or kube-system
 *   - the release adapter points that Deployment at a new pinned digest through the managed session
 *   - a source build: the source hand-off, ONE builder Job in the platform build namespace, the digest the real
 *     builder wrote after a real push, and an attestation that passes the zenith isolation profile
 *   - build egress is ENFORCED, not merely declared: a probe in the build namespace cannot reach the API server
 *     that a control probe elsewhere reaches (needs an enforcing CNI; the script uses Calico)
 * NOT proven even when this passes: a cloud cluster, Gateway API/cert-manager/DNS/ACME (ingress mode is used),
 * that the built image RUNS, pod admission of the tenant workload (the busybox image runs as root and the tenant
 * namespace enforces `restricted`, so its pods are rejected by design; only the objects are asserted), the platform
 * database and Temporal (the platform side is not part of a kind run), or any production hosted acceptance.
 */
import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { gzipSync } from "node:zlib";
import { CoreV1Api, KubeConfig } from "@kubernetes/client-node";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { DriverContext } from "@/lib/drivers/types";
import { assertBuildIsolation } from "@/lib/execution/build-isolation";
import type { ProductContext, ProductPort } from "@/lib/execution/ports";
import { createZenithBuildPort, createZenithSourceStore } from "@/lib/platform/zenith-managed-build";
import { createDefaultManagedSubstrate } from "@/lib/platform/zenith-managed";
import { createZenithWorkloadsPort } from "@/lib/platform/release-zenith";
import { createK8sClient, readObject } from "@/lib/providers/kubernetes/client";
import { applyZenithEnvironment } from "@/lib/providers/zenith/apply";
import type { ManagedSubstratePort } from "@/lib/providers/zenith/managed-port";
import { tenantNamespace } from "@/lib/providers/zenith/tenancy";
import { createPlatformPorts } from "@/lib/execution/platform";
import { prepareIsolation } from "@/lib/execution/tenant-isolation";
import { createPlatformSemanticsStore } from "@/lib/controlplane/db/repos/executable-semantics";
import { createEffectLedger } from "@/lib/effects/ledger";
import { createIsolationCustody } from "@/lib/platform/zenith-isolation-custody";
import { vaultCipherFromEnv } from "@/lib/secrets";
import { LANES, openLane, seedApprovedOperation } from "../../controlplane/_support/harness";
import { NET, mkNode } from "./support";

const REQUIRED = [
  "ZENITH_MANAGED_CLUSTER_SERVER", "ZENITH_MANAGED_CLUSTER_CA_DATA", "ZENITH_MANAGED_KUBECONFIG_REF", "ZENITH_MANAGED_APP_DOMAIN",
  "ZENITH_MANAGED_REGISTRY", "ZENITH_MANAGED_BUILDER_IMAGE", "ZENITH_DATA", "ZENITH_SECRET_KEY", "ZENITH_TEST_MANAGED_WORKLOAD_IMAGE", "KUBECONFIG",
  "ZENITH_MANAGED_OPERATOR_CREDENTIAL_PREFIX",
] as const;
const missing = REQUIRED.filter((name) => !process.env[name]);
const enabled = process.env.ZENITH_TEST_MANAGED_KIND === "1" && missing.length === 0 && process.env.ZENITH_MANAGED_GATEWAY_MODE === "ingress";
if (!enabled) {
  console.warn(`managed-kind acceptance skipped: ${process.env.ZENITH_TEST_MANAGED_KIND !== "1" ? "ZENITH_TEST_MANAGED_KIND is not 1" : missing.length ? `missing ${missing.join(", ")}` : "ZENITH_MANAGED_GATEWAY_MODE must be ingress"}`);
}

const IMAGE = process.env.ZENITH_TEST_MANAGED_WORKLOAD_IMAGE ?? "";
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** A minimal ustar archive: regular files only, enough for a Dockerfile and one file. */
function tarGz(files: Record<string, string>): Uint8Array {
  const blocks: Buffer[] = [];
  for (const [name, text] of Object.entries(files)) {
    const body = Buffer.from(text);
    const header = Buffer.alloc(512);
    header.write(name, 0, 100);
    header.write("0000644\0", 100);
    header.write("0000000\0", 108);
    header.write("0000000\0", 116);
    header.write(`${body.length.toString(8).padStart(11, "0")}\0`, 124);
    header.write("00000000000\0", 136);
    header.write("        ", 148);
    header.write("0", 156);
    header.write("ustar\0", 257);
    header.write("00", 263);
    const sum = [...header].reduce((a, b) => a + b, 0);
    header.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148);
    blocks.push(header, body, Buffer.alloc((512 - (body.length % 512)) % 512));
  }
  blocks.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(blocks));
}

describe.skipIf(!enabled)("Zenith-managed substrate on a real kind cluster", () => {
  const suffix = randomBytes(4).toString("hex");
  const WS = `ws-man01-${suffix}`;
  const ENV_A = `env-man01a-${suffix}`;
  const ENV_B = `env-man01b-${suffix}`;
  const evidence: { requirement: string; startedAt: string; finishedAt?: string; areas: Record<string, Record<string, unknown>> } = { requirement: "PROD-MAN-01", startedAt: new Date().toISOString(), areas: {} };
  const record = (area: string, data: Record<string, unknown>) => { evidence.areas[area] = { ...(evidence.areas[area] ?? {}), ...data }; };

  let managed: ManagedSubstratePort;
  let admin: CoreV1Api;
  let lane: Awaited<ReturnType<typeof openLane>>;

  /** The control plane's side of a tenant lookup. The product store is not part of a kind run; this has the same shape. */
  const product: Pick<ProductPort, "loadContext"> = {
    loadContext: async ({ workspaceId, environmentId }) => ({
      workspace: { id: workspaceId, name: "Acme", slug: `acme-${suffix}` },
      project: { id: "proj-man01", name: "Shop", slug: "shop" },
      environment: { id: environmentId, name: "production", class: "production", provider: "zenith", region: "zenith-managed", baseDomain: process.env.ZENITH_MANAGED_APP_DOMAIN, connectionId: "c", policies: {} },
    }) as unknown as ProductContext,
  };

  const ref = (environmentId: string) => ({ workspaceId: WS, environmentId });
  const web = () => mkNode("container_service/web", "container_service", {
    workload: "web", size: "small", vcpu: 0.25, memoryMb: 256, replicas: 1, port: 8080, zones: 1, subnetTier: "private",
    artifact: { type: "image", ref: IMAGE }, env: [],
  });
  const context = async (environmentId: string): Promise<DriverContext> => ({
    provider: "zenith", region: "zenith-managed", workspaceId: WS, environmentId, operationId: `op-${suffix}`, session: await managed.openSession(ref(environmentId)),
    signal: AbortSignal.timeout(900_000), log: () => undefined, tags: {}, now: () => new Date(),
  });

  beforeAll(async () => {
    // THE DEFAULT COMPOSITION: environment, platform vault and an in-process platform database. Nothing is injected except
    // the control-plane lookup double above and, in onboarding below, a contract-level human approval.
    lane = await openLane(LANES[0]);
    managed = createDefaultManagedSubstrate({ env: { ...process.env }, product, db: lane.db });
    const kc = new KubeConfig();
    kc.loadFromDefault();
    admin = kc.makeApiClient(CoreV1Api);
    // Sessions use only the tenant operator identity that reviewed onboarding issued and sealed into the platform vault.
    const ports = createPlatformPorts(lane.db);
    for (const environmentId of [ENV_A, ENV_B]) {
      const seeded = await seedApprovedOperation(lane.db, WS, { proposal: { scope: { workspaceId: WS, projectId: "proj-man01", environmentId } } });
      const tenant = await managed.tenants.resolve(ref(environmentId));
      const lease = await ports.leases.acquire({ workspaceId: WS, scope: `env:${environmentId}`, holder: `man01:${environmentId}`, ttlMs: 300_000 });
      if (!lease) throw new Error("onboarding lease missing");
      const request = managed.onboarding!.request(tenant, seeded.operation.id, lease, false);
      let reviewed = "";
      const provisioner = managed.onboarding!.provisioner({ d: { ...ports, semantics: createPlatformSemanticsStore(lane.db), effects: createEffectLedger(lane.db),
        isolationCustody: createIsolationCustody({ db: lane.db, ops: ports.ops, leases: ports.leases, cipher: vaultCipherFromEnv({ ZENITH_PLAN_ARTIFACT_KEY: randomBytes(32).toString("hex") }, { purpose: "enc:plan-artifacts" }) }),
        broker: { approvalStatus: async () => ({ approved: true, rejected: false, approvalId: "human-contract", dispatchApproval: { planDigest: reviewed, proposalDigest: seeded.operation.proposalDigest, approvalIds: ["human-contract"], approvalRound: 1, requiredApprovalCount: 1 } }) } } as any,
        emit: async () => {}, evidence: async () => undefined, log: () => {}, now: () => new Date() });
      const plan = await provisioner.plan(request); reviewed = plan.planDigest;
      expect((await provisioner.apply(request, reviewed)).verified).toBe(prepareIsolation(request).objects.length);
      await ports.leases.release(lease);
    }
    record("onboarding", { tenants: 2, operatorIdentity: "reviewed isolation custody", approval: "contract-level" });
  }, 600_000);

  afterAll(async () => {
    evidence.finishedAt = new Date().toISOString();
    const out = process.env.ZENITH_TEST_MANAGED_EVIDENCE_OUT;
    if (out) {
      mkdirSync(path.dirname(out), { recursive: true });
      writeFileSync(out, `${JSON.stringify(evidence, null, 2)}\n`);
    }
    for (const env of [ENV_A, ENV_B]) await admin.deleteNamespace({ name: tenantNamespace(WS, env) }).catch(() => undefined);
    await lane?.close();
  });

  it("is configured from the environment alone and says what it can do", () => {
    const status = managed.status();
    expect(status.configured).toBe(true);
    expect(status.build).toMatchObject({ available: true, namespace: "zenith-build" });
    expect(managed.registry()?.host).toBe(process.env.ZENITH_MANAGED_REGISTRY!.split("/")[0]);
    record("composition", { configured: true, buildAvailable: true, vaultScopeUsed: true, injectedPorts: [] });
  });

  it("opens tenant-scoped sessions through the platform vault and applies the managed baseline and a workload", async () => {
    for (const environmentId of [ENV_A, ENV_B]) {
      const report = await managed.withSession(ref(environmentId), (session) =>
        applyZenithEnvironment({ session, expect: ref(environmentId), toolkit: managed.toolkit, nodes: [NET, web()], resolveSecret: async () => undefined, signal: AbortSignal.timeout(180_000) }));
      expect(report.ok, JSON.stringify(report.baseline?.results.filter((r) => !["created", "configured", "unchanged"].includes(r.status)))).toBe(true);
      const ns = tenantNamespace(WS, environmentId);
      const namespace = await admin.readNamespace({ name: ns });
      expect(namespace.metadata?.labels?.["pod-security.kubernetes.io/enforce"]).toBe("restricted");
      expect(namespace.metadata?.labels?.["zenith.dev/environment"]).toBeDefined();
      for (const [kind, name] of [["ResourceQuota", "zenith-quota"], ["LimitRange", "zenith-limits"], ["NetworkPolicy", "zenith-default-deny"], ["ServiceAccount", "zenith-tenant"], ["Deployment", "web"]] as const) {
        const apiVersion = kind === "Deployment" ? "apps/v1" : kind === "NetworkPolicy" ? "networking.k8s.io/v1" : "v1";
        const live = await managed.withSession(ref(environmentId), (s) => managed.toolkit.read(s.kubernetes, { apiVersion, kind, namespace: ns, name }));
        expect(live, `${kind}/${name} in ${ns}`).toBeDefined();
      }
    }
    record("apply", { tenants: 2, baseline: true, workload: true });
  });

  it("scopes each session to its own tenant namespace: not another tenant, not the build namespace, not kube-system", async () => {
    const session = await managed.openSession(ref(ENV_A));
    // Bound to the environment, exactly as the apply pipeline and every driver bind it: a Zenith-labelled namespace of
    // ANOTHER environment is then not "ours" either.
    const client = createK8sClient(session.kubernetes, { environmentId: ENV_A });
    await expect(client.guard.assert(tenantNamespace(WS, ENV_A))).resolves.toBeUndefined();
    for (const forbidden of [tenantNamespace(WS, ENV_B), "zenith-build", "kube-system", "zenith-system"]) {
      await expect(client.guard.assert(forbidden), forbidden).rejects.toMatchObject({ code: expect.stringMatching(/namespace_forbidden|not_found/) });
    }
    // The control here is the session's namespace allowlist plus the environment-bound guard. The credential behind it is the
    // operator's: its own breadth is PROD-MAN-04's evaluation, not claimed here.
    record("scope", { selfAllowed: true, forbidden: ["other tenant", "zenith-build", "kube-system", "zenith-system"] });
  });

  it("rolls the Deployment to a new pinned digest through the release adapter and the managed session", async () => {
    const ctx = await context(ENV_A);
    const next = `${IMAGE.slice(0, IMAGE.indexOf("@"))}@sha256:${"e".repeat(64)}`;
    await createZenithWorkloadsPort(managed).deployImage(ctx, web(), { uri: next, digest: `sha256:${"e".repeat(64)}` }, { idempotencyKey: `release-${suffix}` });
    const live = await readObject(createK8sClient((ctx.session as any).kubernetes), { apiVersion: "apps/v1", kind: "Deployment", namespace: tenantNamespace(WS, ENV_A), name: "web" });
    expect((live as any).spec.template.spec.containers[0].image).toBe(next);
    record("release", { deployImage: true });
  });

  it("builds a source archive in the platform build namespace and returns an admitted, attested digest", async () => {
    const archive = tarGz({ Dockerfile: "FROM scratch\nCOPY hello.txt /hello.txt\n", "hello.txt": `zenith managed build ${suffix}\n` });
    const bundle = { archive, sha256: createHash("sha256").update(archive).digest("hex"), bytes: archive.length };
    const ctx = await context(ENV_A);
    const stored = await createZenithSourceStore(managed).upload(ctx, bundle);
    const port = createZenithBuildPort({ managed, pollMs: 2000 });
    const service = mkNode("container_service/web", "container_service", { artifact: { type: "built", pipeline: "build_pipeline/web", registry: "container_registry/web" } });
    const pipeline = mkNode("build_pipeline/web", "build_pipeline", { source: { repo: "acme/web", ref: "main" }, output: { registry: "container_registry/web" }, location: "customer_account" });
    const handle = await port.startBuild(ctx, { service, pipeline, source: { s3Key: stored.name, digest: bundle.sha256, bucket: stored.namespace }, idempotencyKey: `build-${suffix}` });
    const result = await port.waitForBuild(ctx, handle, { timeoutMs: 600_000 });
    expect(result.status, result.detail).toBe("succeeded");
    expect(result.digest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(managed.registry()!.ownsPinnedImage((ctx.session as any).tenant, result.imageUri!)).toBe(true);
    expect(assertBuildIsolation("zenith", result.attestation!.isolation, { allowOpenEgress: false })).toEqual({ exceptions: [] });
    expect(result.attestation!.isolation.network).toMatchObject({ egress: "allowlisted", verifiedBy: "provider_read" });
    record("build", { status: result.status, digest: result.digest, repository: result.imageUri?.split("@")[0], profile: result.attestation!.isolation.profileId, egress: result.attestation!.isolation.network.egress });
  }, 900_000);

  /** A probe pod run with the ADMIN kubeconfig (the test's own, never the managed substrate's credential). */
  async function probe(namespace: string, script: string): Promise<{ ok: boolean; log: string }> {
    const name = `probe-${suffix}-${randomBytes(2).toString("hex")}`;
    await admin.createNamespacedPod({
      namespace,
      body: { metadata: { name, labels: { "zenith.dev/probe": suffix } }, spec: { restartPolicy: "Never", automountServiceAccountToken: false, containers: [{ name: "p", image: IMAGE, command: ["sh", "-c", script] }] } },
    });
    try {
      for (let i = 0; i < 90; i++) {
        const pod = await admin.readNamespacedPod({ name, namespace });
        const phase = pod.status?.phase;
        if (phase === "Succeeded" || phase === "Failed") {
          const log = await admin.readNamespacedPodLog({ name, namespace }).catch(() => "");
          return { ok: phase === "Succeeded", log: String(log).slice(0, 400) };
        }
        await sleep(2000);
      }
      throw new Error("probe did not finish");
    } finally {
      await admin.deleteNamespacedPod({ name, namespace }).catch(() => undefined);
    }
  }

  it("enforces the build namespace egress policy with real traffic (needs an enforcing CNI)", async () => {
    const reach = "nc -z -w 5 kubernetes.default.svc 443";
    const control = await probe("default", reach);
    expect(control.ok, `control probe should reach the API server: ${control.log}`).toBe(true);
    const inBuild = await probe("zenith-build", reach);
    expect(inBuild.ok, "a probe in the build namespace must NOT reach the API server").toBe(false);
    record("egress", { controlReachesApiServer: control.ok, buildNamespaceReachesApiServer: inBuild.ok, enforced: control.ok && !inBuild.ok });
  }, 300_000);
});
