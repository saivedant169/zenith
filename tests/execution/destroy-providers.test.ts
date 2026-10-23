/** C1 provider/session fakes only. No Kubernetes, managed cluster or cloud access. */
import { afterEach, describe, expect, it, vi } from "vitest";
import { createWorld, type World } from "./fakes/world";
import { ENV, OP, REVISION, WS, webDbManifest } from "./fakes/fixtures";
import { createRuntime } from "@/lib/execution/runtime";
import { createDestroyActivities, type DestroyProviderPorts, type TeardownInput, type TeardownResult } from "@/lib/execution/destroy";
import { LeaseLostError } from "@/lib/execution/errors";

const worlds: World[] = [];
afterEach(() => { worlds.splice(0).forEach((w) => w.dispose()); vi.restoreAllMocks(); });
function setup(provider: "kubernetes" | "zenith") {
  const w = createWorld({ op: { capability: "infrastructure.destroy", status: "running" } }); worlds.push(w);
  w.product.base.environment.provider = provider;
  w.product.base.environment.deployedRevisionId = REVISION;
  const manifest = webDbManifest(); manifest.routes = []; manifest.bindings = []; manifest.resources = [];
  w.product.setManifest(manifest);
  const calls: TeardownInput[] = [];
  let live = true;
  let current: TeardownResult | undefined;
  const transport = vi.fn(async (input: TeardownInput): Promise<TeardownResult> => {
    calls.push(input);
    if (current) return current;
    const result = { deleted: live ? ["Deployment/ns/web"] : [], retained: input.retainStateful ? ["PersistentVolumeClaim/ns/data"] : [], skipped: [], uncertain: [] };
    if (!input.dryRun) live = false;
    return result;
  });
  const session = { provider, expiresAt: "2099-01-01T00:00:00Z" };
  if (provider === "kubernetes") vi.spyOn(w.credentials, "withSession").mockImplementation(async (_req, fn) => fn({ provider: "kubernetes", server: "https://cluster.example.com", expiresAt: session.expiresAt, kubeConfig: () => ({}) }));
  const ports: DestroyProviderPorts = {
    ...(provider === "kubernetes" ? { teardownKubernetesEnvironment: transport } : { teardownZenithEnvironment: transport }),
    withZenithSession: async (_input, fn) => fn(session),
  };
  const activities = createDestroyActivities(createRuntime(w.deps), ports);
  const setResult = (result: TeardownResult) => { current = result; };
  return { w, activities, calls, ports, transport, setResult };
}
async function reviewed(provider: "kubernetes" | "zenith") {
  const s = setup(provider), lease = await s.w.lease();
  const plan = await s.activities.planDestroyInfrastructure({ operationId: OP, lease });
  s.w.broker.approval = { approved: true, rejected: false, approvalId: "human-fixture" };
  return { ...s, lease, plan, args: { operationId: OP, lease, planDigest: plan.planDigest } };
}

describe.each(["kubernetes", "zenith"] as const)("%s C1 destroy", (provider) => {
  it("reviews, applies and verifies through C1 without invoking tofu", async () => {
    const s = await reviewed(provider);
    expect(s.plan).toMatchObject({ delete: 1, destroysData: false });
    expect(s.calls[0]).toMatchObject({ workspaceId: WS, environmentId: ENV, retainStateful: true, dryRun: true, session: { provider } });
    await expect(s.activities.applyDestroyInfrastructure(s.args)).resolves.toEqual({ deleted: 1 });
    expect(s.calls.some((c) => !c.dryRun)).toBe(true);
    expect(await s.activities.verifyDestroyedInfrastructure(s.args)).toMatchObject({ status: "passed", checks: 1, failed: 0 });
    expect(s.w.tofu.planCalls).toHaveLength(0); expect(s.w.tofu.applyCalls).toHaveLength(0);
    expect(s.w.evidence.ofKind("tofu_plan")[0].summary).toMatchObject({ engine: "provider-teardown", destroy: true, retained: ["PersistentVolumeClaim/ns/data"] });
  });
  it("never applies without human approval or under the wrong environment fence", async () => {
    const s = await reviewed(provider); s.w.broker.approval.approved = false;
    await expect(s.activities.applyDestroyInfrastructure(s.args)).rejects.toThrow(/approval/);
    await expect(s.activities.planDestroyInfrastructure({ operationId: OP, lease: { ...s.lease, scope: "env:foreign" } })).rejects.toThrow(/environment/);
    expect(s.calls.every((c) => c.dryRun)).toBe(true);
  });
  it("requires a new approval if the object set changes after review", async () => {
    const s = await reviewed(provider);
    s.setResult({ deleted: ["Deployment/ns/new-object"], retained: ["PersistentVolumeClaim/ns/data"], skipped: [], uncertain: [] });
    await expect(s.activities.applyDestroyInfrastructure(s.args)).rejects.toMatchObject({ code: "plan_changed" });
    expect(s.calls.every((c) => c.dryRun)).toBe(true);
  });
  it("fails closed on an incomplete read-only review", async () => {
    const s = setup(provider);
    s.setResult({ deleted: [], retained: [], skipped: [], uncertain: ["Deployment/ns/web"] });
    await expect(s.activities.planDestroyInfrastructure({ operationId: OP, lease: await s.w.lease() })).rejects.toThrow(/uncertain/);
    expect(s.calls.every((c) => c.dryRun)).toBe(true);
  });
  it("treats a gap marker for an unserved CRD kind as no unreviewed object, but blocks on any other skipped ref", async () => {
    const s = setup(provider);
    const lease = await s.w.lease();
    const planOnce = () => s.activities.planDestroyInfrastructure({ operationId: OP, lease });
    s.setResult({ deleted: ["Deployment/ns/web"], retained: [], skipped: ["Certificate/ns/*", "DNSEndpoint/ns/*", "HTTPRoute/ns/*"], uncertain: [] });
    await expect(planOnce()).resolves.toMatchObject({ delete: 1 });
    s.setResult({ deleted: [], retained: [], skipped: ["Deployment/ns/web"], uncertain: [] });
    await expect(planOnce()).rejects.toThrow(/skipped or uncertain/);
    // a wildcard for a kind every cluster serves is a real coverage gap, not an absent CRD
    s.setResult({ deleted: [], retained: [], skipped: ["Service/ns/*"], uncertain: [] });
    await expect(planOnce()).rejects.toThrow(/skipped or uncertain/);
    // a wildcard that is UNCERTAIN (discovery failed or timed out) is never an absent CRD
    s.setResult({ deleted: [], retained: [], skipped: [], uncertain: ["Certificate/ns/*"] });
    await expect(planOnce()).rejects.toThrow(/skipped or uncertain/);
    // a named object of a CRD kind was seen and not deleted
    s.setResult({ deleted: [], retained: [], skipped: ["Certificate/ns/web-cert"], uncertain: [] });
    await expect(planOnce()).rejects.toThrow(/skipped or uncertain/);
  });
  it("reports partial teardown as unknown even when a later list is empty", async () => {
    const s = await reviewed(provider);
    s.transport.mockImplementationOnce(async () => ({ deleted: ["Deployment/ns/web"], retained: ["PersistentVolumeClaim/ns/data"], skipped: [], uncertain: [] }))
      .mockImplementationOnce(async () => ({ deleted: [], retained: [], skipped: [], uncertain: ["Deployment/ns/web"] }))
      .mockImplementationOnce(async () => ({ deleted: [], retained: [], skipped: [], uncertain: [] }));
    await s.activities.applyDestroyInfrastructure(s.args);
    expect((await s.activities.verifyDestroyedInfrastructure(s.args)).status).toBe("unknown");
  });
  it("cannot prove absence before an apply", async () => {
    const s = await reviewed(provider);
    s.setResult({ deleted: [], retained: [], skipped: [], uncertain: [] });
    expect((await s.activities.verifyDestroyedInfrastructure(s.args)).status).toBe("unknown");
  });
  it("does not treat a reviewed deletion that is now retained as absent", async () => {
    const s = await reviewed(provider);
    await s.activities.applyDestroyInfrastructure(s.args);
    s.setResult({ deleted: [], retained: ["Deployment/ns/web"], skipped: [], uncertain: [] });
    expect((await s.activities.verifyDestroyedInfrastructure(s.args)).status).toBe("failed");
  });
  it("strips external error text from read-only review failures", async () => {
    const s = setup(provider);
    s.transport.mockRejectedValueOnce(new Error("upstream-password-canary"));
    await expect(s.activities.planDestroyInfrastructure({ operationId: OP, lease: await s.w.lease() })).rejects.toThrow("Provider destroy review failed; nothing was applied.");
    expect(s.w.stored()).not.toContain("upstream-password-canary");
  });
  it("settles a lost fence during mutation as uncertain", async () => {
    const s = await reviewed(provider);
    s.transport.mockImplementationOnce(async () => ({ deleted: ["Deployment/ns/web"], retained: ["PersistentVolumeClaim/ns/data"], skipped: [], uncertain: [] }))
      .mockRejectedValueOnce(new LeaseLostError(s.lease.scope, s.lease.fenceToken));
    await expect(s.activities.applyDestroyInfrastructure(s.args)).rejects.toBeInstanceOf(LeaseLostError);
    expect(s.w.ops.ops.get(OP)?.status).toBe("uncertain");
  });
});

describe("kubernetes C1 destroy of an adopted data service (PROD-LIFE-11)", () => {
  async function adopted(lifecycle: "manage" | "manage_and_destroy", storedOwnership: "managed" | "referenced" = "managed") {
    const s = setup("kubernetes");
    const manifest = webDbManifest(); manifest.routes = []; manifest.bindings = [];
    manifest.resources = [{ id: "res-db", name: "legacy-db", kind: "postgres", config: {}, size: "small", ownership: "referenced", externalRef: "zenith-ns/legacy-db" }] as typeof manifest.resources;
    s.w.product.setManifest(manifest);
    s.w.deps.portability = { adoptionFacts: async () => [{ address: "postgres/legacy-db", externalId: "zenith-ns/legacy-db", status: "active", lifecycle, approvalId: "apr-1" }] } as unknown as typeof s.w.deps.portability;
    // The adoption store flips the stored row to managed; the manifest still declares it referenced.
    s.w.resources.rows.set(`${ENV}|postgres/legacy-db`, { id: "res-adopted", workspaceId: WS, environmentId: ENV, address: "postgres/legacy-db", kind: "postgres", provider: "kubernetes",
      nativeType: "k8s:StatefulSet", ownership: storedOwnership, externalId: "zenith-ns/legacy-db", specDigest: "d".repeat(64), spec: {}, dependsOn: [], origin: [], labels: {}, status: "ready" } as never);
    return { ...s, lease: await s.w.lease() };
  }
  it("passes exactly the adopted claim to teardown when destruction is allowed", async () => {
    const s = await adopted("manage_and_destroy");
    await s.activities.planDestroyInfrastructure({ operationId: OP, lease: s.lease });
    expect(s.calls[0].adopted).toEqual([{ kind: "StatefulSet", namespace: "zenith-ns", name: "legacy-db" }]);
  });
  it("lets the claim stand in for a deletion policy: deletes adopted data only when the environment allows stateful deletion", async () => {
    const off = await adopted("manage_and_destroy");
    off.w.product.base.environment.policies.allowStatefulDeletion = false;
    await off.activities.planDestroyInfrastructure({ operationId: OP, lease: off.lease });
    expect(off.calls[0].retainStateful).toBe(true);
    const on = await adopted("manage_and_destroy");
    on.w.product.base.environment.policies.allowStatefulDeletion = true;
    await on.activities.planDestroyInfrastructure({ operationId: OP, lease: on.lease });
    expect(on.calls[0]).toMatchObject({ retainStateful: false, adopted: [{ kind: "StatefulSet", namespace: "zenith-ns", name: "legacy-db" }] });
  });
  it("refuses teardown of an adopted data service whose claim forbids destruction, before any provider call", async () => {
    const s = await adopted("manage");
    await expect(s.activities.planDestroyInfrastructure({ operationId: OP, lease: s.lease })).rejects.toThrow(/was adopted, not created by Zenith/);
    expect(s.calls).toHaveLength(0);
  });
  it("passes nothing for a referenced object that was never adopted", async () => {
    const s = await adopted("manage_and_destroy", "referenced");
    s.w.deps.portability = { adoptionFacts: async () => [] } as unknown as typeof s.w.deps.portability;
    await s.activities.planDestroyInfrastructure({ operationId: OP, lease: s.lease });
    expect(s.calls[0].adopted).toBeUndefined();
  });
});
