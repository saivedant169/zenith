import { describe, expect, it } from "vitest";
import {
  FieldOwnershipConflictError,
  FieldOwnershipRegistry,
  OwnershipRegistrationError,
  applyFieldOwnership,
  assertNativeOperationAllowed,
  assertPlanFieldOwnership,
  autoscaledAddresses,
  blocking,
  checkNativeOperation,
  checkPlanFieldOwnership,
  classifyDrift,
  evaluateWrite,
  factsForNode,
  ignoreChangesFor,
  lifecycleIgnoreChanges,
  mergeIgnoreChanges,
  normalizePath,
  pathCovers,
  resolveFieldOwner,
  transferDigest,
  transferRequest,
  type OwnershipTransfer,
} from "@/lib/ownership";
import type { DriftReport, ResourceGraph, ResourceNode } from "@/lib/resources/types";
import type { NormalizedPlan, PlanResourceChange } from "@/lib/tofu/types";

const NOW = new Date("2026-10-05T12:00:00.000Z");

function node(over: Partial<ResourceNode> & Pick<ResourceNode, "address">): ResourceNode {
  return {
    kind: "container_service",
    provider: "aws",
    region: "us-east-1",
    nativeType: "aws:ecs_service",
    ownership: "managed",
    spec: { replicas: 2, artifact: { type: "image", ref: "x" } },
    origin: [],
    dependsOn: [],
    specDigest: "d",
    labels: {},
    ...over,
  };
}

const graphOf = (nodes: ResourceNode[]): ResourceGraph => ({ version: 1, environmentId: "env", manifestDigest: "m", nodes, edges: [], graphDigest: "g", notes: [] });

const web = node({ address: "service/web" });
const scaledWeb = node({ address: "service/web", spec: { replicas: 2, autoscaling: { min: 2, max: 8 } } });
const hpa = node({
  address: "provider_native/hpa",
  kind: "provider_native",
  provider: "kubernetes",
  nativeType: "k8s:HorizontalPodAutoscaler",
  spec: { type: "k8s:HorizontalPodAutoscaler", config: { target: "web", minReplicas: 2, maxReplicas: 4 } },
});
const k8sWeb = node({ address: "service/web", provider: "kubernetes", nativeType: "k8s:Deployment" });

const transfer = (over: Partial<OwnershipTransfer> = {}): OwnershipTransfer => {
  const base = { address: "service/web", resourceType: "aws:ecs_service", path: "replicas", from: "iac" as const, to: "native-op" as const, ...over };
  return { approvalId: "apr_1", approvedAt: "2026-10-05T10:00:00.000Z", ...base, digest: transferDigest(base), ...over };
};

describe("paths", () => {
  it("normalizes indices and covers children", () => {
    expect(normalizePath("a.b[0].c")).toBe("a.b[].c");
    expect(pathCovers("tags", "tags.env")).toBe(true);
    expect(pathCovers("tag", "tags")).toBe(false);
    expect(pathCovers("template[].container[].image", "template[0].container[2].image")).toBe(true);
  });
});

describe("registry", () => {
  it("rejects two rules claiming the same field", () => {
    const r = new FieldOwnershipRegistry([{ id: "a", resourceTypes: ["t"], paths: ["x"], owner: "iac", reason: "r" }]);
    expect(() => r.register({ id: "b", resourceTypes: ["t"], paths: ["x.y"], owner: "autoscaler", reason: "r" })).toThrow(OwnershipRegistrationError);
    expect(() => r.register({ id: "c", resourceTypes: ["u"], paths: ["x"], owner: "autoscaler", reason: "r" })).not.toThrow();
    expect(() => r.register({ id: "a", resourceTypes: ["z"], paths: ["x"], owner: "iac", reason: "r" })).toThrow(/already registered/);
  });

  it("defaults unknown fields to iac and labels them as assumed", () => {
    const r = resolveFieldOwner({ resourceType: "aws:ecs_service", path: "cpu" });
    expect(r).toMatchObject({ owner: "iac", source: "default" });
  });

  it("moves the replica count to the autoscaler when one is attached, in both spellings", () => {
    expect(resolveFieldOwner({ resourceType: "aws:ecs_service", path: "replicas" }).owner).toBe("iac");
    expect(resolveFieldOwner({ resourceType: "aws:ecs_service", path: "replicas", facts: { autoscaled: true } }).owner).toBe("autoscaler");
    expect(resolveFieldOwner({ resourceType: "aws_ecs_service", path: "desired_count", facts: { autoscaled: true } }).owner).toBe("autoscaler");
  });

  it("honours only exact, current, approved transfers", () => {
    const q = { resourceType: "aws:ecs_service", path: "replicas", address: "service/web" };
    expect(resolveFieldOwner(q, { transfers: [transfer()], now: NOW })).toMatchObject({ owner: "native-op", source: "transfer", baseOwner: "iac", transferId: "apr_1" });
    // other resource, tampered digest, expired, wrong from-owner, provider-managed, no approval
    expect(resolveFieldOwner({ ...q, address: "service/api" }, { transfers: [transfer()], now: NOW }).owner).toBe("iac");
    expect(resolveFieldOwner(q, { transfers: [{ ...transfer(), to: "autoscaler" }], now: NOW }).owner).toBe("iac");
    expect(resolveFieldOwner(q, { transfers: [transfer({ expiresAt: "2026-10-05T11:00:00.000Z" })], now: NOW }).owner).toBe("iac");
    expect(resolveFieldOwner(q, { transfers: [transfer({ from: "autoscaler" })], now: NOW }).owner).toBe("iac");
    expect(resolveFieldOwner(q, { transfers: [transfer({ approvalId: "" })], now: NOW }).owner).toBe("iac");
    expect(resolveFieldOwner({ resourceType: "aws_instance", path: "ami", address: "vm/a" }, { transfers: [transfer({ address: "vm/a", resourceType: "aws_instance", path: "ami", from: "provider-managed", to: "iac" })], now: NOW }).owner).toBe("provider-managed");
  });

  it("applies a transfer approved under the portable spelling to the tofu spelling", () => {
    const r = resolveFieldOwner({ resourceType: "aws_ecs_service", path: "desired_count", address: "service/web" }, { transfers: [transfer()], now: NOW });
    expect(r.owner).toBe("native-op");
  });
});

describe("facts", () => {
  it("derives autoscaled from spec or a native autoscaler node, and release-managed from artifact", () => {
    expect(factsForNode(web)).toEqual({});
    expect(factsForNode(scaledWeb).autoscaled).toBe(true);
    expect(factsForNode(node({ address: "service/x", spec: { artifact: { type: "built" } } })).releaseManaged).toBe(true);
    const g = graphOf([k8sWeb, hpa]);
    expect([...autoscaledAddresses(g)]).toEqual(["service/web"]);
    expect(factsForNode(k8sWeb, g).autoscaled).toBe(true);
  });
});

describe("native operation enforcement", () => {
  it("lets service.scale write replicas only when a transfer made native-op the owner", () => {
    const [plain] = checkNativeOperation({ capability: "service.scale", node: web, now: NOW });
    expect(plain!.verdict).toBe("transfer_required");
    expect(plain!.transfer).toMatchObject({ from: "iac", to: "native-op", address: "service/web" });
    expect(plain!.transfer!.digest).toBe(transferRequest({ address: "service/web", resourceType: "aws:ecs_service", path: "replicas", from: "iac", to: "native-op" }).digest);

    const [moved] = checkNativeOperation({ capability: "service.scale", node: web, transfers: [transfer()], now: NOW });
    expect(moved!.verdict).toBe("allowed");
  });

  it("gives an autoscaled Cloud Run instance range to the autoscaler: native scale refused, IaC ignores the range", () => {
    const run = node({ address: "service/run", provider: "gcp", nativeType: "gcp:cloud_run_service", spec: { replicas: 1, autoscaling: { min: 1, max: 5 } } });
    const [c] = checkNativeOperation({ capability: "service.scale", node: run, input: { minInstances: 3 }, now: NOW });
    expect(c).toMatchObject({ verdict: "transfer_required", resolution: { owner: "autoscaler" } });
    expect(lifecycleIgnoreChanges({ resourceType: "google_cloud_run_v2_service", address: run.address, facts: { autoscaled: true } })?.ignore_changes)
      .toEqual(expect.arrayContaining(["template[0].scaling[0].min_instance_count", "template[0].scaling[0].max_instance_count"]));
    expect(lifecycleIgnoreChanges({ resourceType: "google_cloud_run_v2_service", address: run.address, facts: {} })).toBeUndefined();
  });

  it("refuses scaling an autoscaled workload and asks for a transfer from the autoscaler", () => {
    const [c] = checkNativeOperation({ capability: "service.scale", node: scaledWeb, now: NOW });
    expect(c).toMatchObject({ verdict: "transfer_required", resolution: { owner: "autoscaler" } });
    expect(() => assertNativeOperationAllowed({ capability: "service.scale", node: scaledWeb, now: NOW })).toThrow(FieldOwnershipConflictError);
  });

  it("allows deployments for release-managed workloads and ignores operations that write no owned field", () => {
    const built = node({ address: "service/web", provider: "azure", nativeType: "azure:container_app", spec: { replicas: 1, artifact: { type: "built" } } });
    expect(checkNativeOperation({ capability: "deployment.deploy", node: built, now: NOW }).map((c) => c.verdict)).toEqual(["allowed"]);
    expect(checkNativeOperation({ capability: "service.restart", node: web, now: NOW })).toEqual([]);
  });

  it("treats drift.repair as an iac write and blocks it on autoscaler-owned fields", () => {
    expect(checkNativeOperation({ capability: "drift.repair", node: web, repairAttributes: ["replicas"], now: NOW })[0]!.verdict).toBe("allowed");
    expect(checkNativeOperation({ capability: "drift.repair", node: scaledWeb, repairAttributes: ["replicas"], now: NOW })[0]!.verdict).toBe("transfer_required");
    // The broker and grant re-admission pass only the proposal input: its attributes are the repaired fields.
    expect(checkNativeOperation({ capability: "drift.repair", node: scaledWeb, input: { action: "reapply_desired_state", attributes: ["replicas"] }, now: NOW })[0]!.verdict).toBe("transfer_required");
  });

  it("refuses provider-managed fields outright and never offers a transfer", () => {
    const c = evaluateWrite({ address: "vm/a", resourceType: "aws_instance", path: "ami", writer: "iac", action: "update" }, { now: NOW });
    expect(c.verdict).toBe("refused");
    expect(c.transfer).toBeUndefined();
  });

  it("refuses the base owner writing a field that was transferred away", () => {
    const c = evaluateWrite({ address: "service/web", resourceType: "aws:ecs_service", path: "replicas", writer: "iac", action: "update" }, { transfers: [transfer()], now: NOW });
    expect(c.verdict).toBe("refused");
    expect(blocking(c)).toBe(true);
  });
});

describe("plan enforcement", () => {
  const change = (over: Partial<PlanResourceChange>): PlanResourceChange => ({
    address: "aws_ecs_service.web",
    nodeAddress: "service/web",
    type: "aws_ecs_service",
    providerName: "aws",
    action: "update",
    changes: [{ path: "desired_count", before: 2, after: 6, sensitive: false, forcesReplacement: false }],
    destroysData: false,
    ...over,
  });
  const plan = (c: PlanResourceChange): Pick<NormalizedPlan, "resourceChanges"> => ({ resourceChanges: [c] });

  it("allows an iac update to an iac-owned field", () => {
    expect(() => assertPlanFieldOwnership(plan(change({})), [web])).not.toThrow();
  });

  it("refuses an iac update to an autoscaler-owned field", () => {
    expect(() => assertPlanFieldOwnership(plan(change({})), [scaledWeb])).toThrow(/owned by autoscaler/);
    const found = checkPlanFieldOwnership(plan(change({})), [scaledWeb]);
    expect(found.map((c) => c.verdict)).toEqual(["transfer_required"]);
  });

  it("uses an autoscaler declared as a separate native node", () => {
    const g = graphOf([k8sWeb, hpa]);
    const p = plan(change({ address: "kubernetes_deployment.web", type: "k8s:Deployment", changes: [{ path: "replicas", before: 1, after: 3, sensitive: false, forcesReplacement: false }] }));
    expect(() => assertPlanFieldOwnership(p, g.nodes, { factsByAddress: new Map([["service/web", { autoscaled: true }]]) })).toThrow(FieldOwnershipConflictError);
  });

  it("does not refuse ordinary iac-owned updates on existing resource types", () => {
    const attrs = ["tags.env", "cpu", "memory", "task_definition", "desired_count", "instance_type", "template[0].container[0].image", "name"];
    for (const [type, nativeType] of [["aws_ecs_service", "aws:ecs_service"], ["aws_instance", "aws:ec2_instance"], ["azurerm_container_app", "azure:container_app"], ["google_cloud_run_v2_service", "gcp:cloud_run_service"]] as const) {
      const n = node({ address: "service/x", nativeType, spec: { replicas: 2, artifact: { type: "image", ref: "r" } } });
      for (const path of attrs) {
        // provider-managed and release-pointer fields are the only declared exceptions
        if ((type === "aws_instance" && path === "ami")) continue;
        const p = plan(change({ nodeAddress: "service/x", address: type + ".x", type, changes: [{ path, before: 1, after: 2, sensitive: false, forcesReplacement: false }] }));
        expect(() => assertPlanFieldOwnership(p, [n]), type + " " + path).not.toThrow();
      }
    }
  });

  it("allows a non-iac update only with a matching unrevoked transfer", () => {
    const p = plan(change({}));
    expect(() => assertPlanFieldOwnership(p, [scaledWeb], { transfers: [transfer({ from: "autoscaler", to: "iac" })], now: NOW })).not.toThrow();
    expect(() => assertPlanFieldOwnership(p, [scaledWeb], { transfers: [transfer({ from: "autoscaler", to: "native-op" })], now: NOW })).toThrow(FieldOwnershipConflictError);
    expect(() => assertPlanFieldOwnership(p, [scaledWeb], { transfers: [], now: NOW })).toThrow(FieldOwnershipConflictError);
  });

  it("treats create and replace as seeding, and skips deletes and no-ops", () => {
    expect(() => assertPlanFieldOwnership(plan(change({ action: "create" })), [scaledWeb])).not.toThrow();
    expect(() => assertPlanFieldOwnership(plan(change({ action: "replace" })), [scaledWeb])).not.toThrow();
    expect(checkPlanFieldOwnership(plan(change({ action: "delete" })), [scaledWeb])).toEqual([]);
    expect(checkPlanFieldOwnership(plan(change({ action: "no-op" })), [scaledWeb])).toEqual([]);
  });

  it("refuses an update to a provider-managed attribute", () => {
    const p = plan(change({ address: "aws_instance.a", nodeAddress: "vm/a", type: "aws_instance", changes: [{ path: "ami", before: "ami-1", after: "ami-2", sensitive: false, forcesReplacement: true }] }));
    expect(() => assertPlanFieldOwnership(p, [])).toThrow(/provider-managed/);
  });
});

describe("drift classification", () => {
  const report = (fields: { attribute: string; desired: unknown; observed: unknown }[], address = "service/web"): DriftReport => ({
    environmentId: "env",
    graphDigest: "g",
    computedAt: NOW.toISOString(),
    simulated: false,
    unobserved: [],
    findings: [{ address, class: "changed", severity: "medium", fields, repairable: true, autoRepairEligible: true, explanation: "differs" }],
  });

  it("classifies autoscaler variance as expected and drops it from the report", () => {
    const g = graphOf([scaledWeb]);
    const r = report([{ attribute: "replicas", desired: 2, observed: 7 }]);
    const [owned] = classifyDrift(g, r);
    expect(owned!.fields[0]).toMatchObject({ owner: "autoscaler", classification: "expected_variance" });
    expect(owned!.expectedOnly).toBe(true);
    expect(applyFieldOwnership(g, r).findings).toEqual([]);
  });

  it("keeps iac drift as an unauthorized change and leaves repair flags alone", () => {
    const g = graphOf([web]);
    const r = report([{ attribute: "replicas", desired: 2, observed: 5 }]);
    expect(classifyDrift(g, r)[0]!.fields[0]!.classification).toBe("unauthorized_change");
    const out = applyFieldOwnership(g, r).findings[0]!;
    expect(out.repairable).toBe(true);
    expect(out.autoRepairEligible).toBe(true);
  });

  it("stops re-apply from reverting a transferred native-op field", () => {
    const g = graphOf([web]);
    const r = report([{ attribute: "replicas", desired: 2, observed: 5 }]);
    const out = applyFieldOwnership(g, r, { transfers: [transfer()], now: NOW }).findings[0]!;
    expect(out.repairable).toBe(false);
    expect(out.autoRepairEligible).toBe(false);
    expect(out.explanation).toMatch(/owned by a native operation/);
  });

  it("splits a mixed finding: only the owned-elsewhere field is dropped", () => {
    const g = graphOf([scaledWeb]);
    const r = report([
      { attribute: "replicas", desired: 2, observed: 7 },
      { attribute: "cpu", desired: 256, observed: 512 },
    ]);
    const out = applyFieldOwnership(g, r).findings[0]!;
    expect(out.fields!.map((f) => f.attribute)).toEqual(["cpu"]);
  });

  it("passes non-changed findings through", () => {
    const g = graphOf([web]);
    const r: DriftReport = { ...report([]), findings: [{ address: "service/web", class: "missing", severity: "medium", repairable: true, autoRepairEligible: true, explanation: "gone" }] };
    expect(applyFieldOwnership(g, r).findings).toHaveLength(1);
  });
});

describe("ignore_changes generation", () => {
  it("emits desired_count only when an autoscaler owns it", () => {
    expect(ignoreChangesFor({ resourceType: "aws_ecs_service" })).toEqual([]);
    expect(ignoreChangesFor({ resourceType: "aws_ecs_service", facts: { autoscaled: true } })).toEqual(["desired_count"]);
    expect(lifecycleIgnoreChanges({ resourceType: "aws_ecs_service" })).toBeUndefined();
  });

  it("emits paths for a transferred field and for release-managed images", () => {
    expect(ignoreChangesFor({ resourceType: "aws_ecs_service", address: "service/web", transfers: [transfer()], now: NOW })).toEqual(["desired_count"]);
    expect(ignoreChangesFor({ resourceType: "azurerm_container_app", facts: { releaseManaged: true } })).toEqual(["template[0].container[0].args", "template[0].container[0].image"]);
    expect(ignoreChangesFor({ resourceType: "azurerm_container_app" })).toEqual([]);
  });

  it("mirrors the ignore_changes the drivers already emit", () => {
    expect(ignoreChangesFor({ resourceType: "aws_instance" })).toEqual(["ami"]);
    expect(ignoreChangesFor({ resourceType: "azurerm_postgresql_flexible_server" })).toEqual(["high_availability[0].standby_availability_zone", "zone"]);
    expect(ignoreChangesFor({ resourceType: "azurerm_mysql_flexible_server" })).toEqual(["high_availability[0].standby_availability_zone", "zone"]);
    expect(ignoreChangesFor({ resourceType: "aws_ssm_parameter" })).toEqual(["value"]);
    expect(ignoreChangesFor({ resourceType: "google_cloud_run_v2_service", facts: { releaseManaged: true } })).toEqual(["template[0].containers[0].image"]);
    expect(ignoreChangesFor({ resourceType: "google_cloud_run_v2_job", facts: { releaseManaged: true } })).toEqual(["template[0].template[0].containers[0].image"]);
  });

  it("merges without duplicating equivalent paths", () => {
    expect(mergeIgnoreChanges(["template[0].x"], ["template[1].x", "y"])).toEqual(["template[0].x", "y"]);
  });
});
