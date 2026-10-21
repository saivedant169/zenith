/** Real ledger, signer, browser approval and broker; synthetic plan, no AWS calls. */
import { describe, expect, it } from "vitest";
import { tempDataDir } from "../_support/data-dir";
tempDataDir("zenith-ecs-repair-grants-", { fast: true });
const { makeHarness, closeSharedPgliteAfterAll, STORE_KINDS, scriptedEngine, allowDecision, requireApproval, user, sessionFor } = await import("../capabilities/support");
const { repos } = await import("@/lib/controlplane/db");
const { makePlan, change } = await import("../execution/fakes/fixtures");
const { buildPlanFacts } = await import("@/lib/capabilities/evaluate");
const { planEvidence } = await import("@/lib/execution/plan-evidence");
const { repairBindingDigest, repairBindingEvidenceId } = await import("@/lib/execution/ecs-replica-repair-binding");
const { createOperationsPort } = await import("@/lib/execution/platform");
const { createExecutionBroker } = await import("@/lib/platform/broker");
import type { EcsReplicaRepairBindingV1 } from "@/lib/execution/ecs-replica-repair-binding";
closeSharedPgliteAfterAll();

async function fixture(kind: "pglite" | "postgres", strict = false) {
  const h = await makeHarness({ kind, engine: scriptedEngine("repair-policy", (input) =>
    strict && input.request.capability === "drift.repair" && input.plan ? requireApproval(2, "admin", true) : allowDecision()) });
  const input = { action: "reapply_desired_state", address: "service/web", kind: "container_service", findingClass: "changed", severity: "medium",
    attributes: ["replicas"], graphDigest: "a".repeat(64), reportComputedAt: "2026-09-30T00:00:00.000Z" };
  // The repaired service's platform row: claim and grant admission judge its current field ownership (IaC-owned replicas).
  await h.db!.query(`insert into platform.resources (id, workspace_id, environment_id, address, kind, provider, native_type, ownership, spec_digest, spec)
    values ($1,$2,$3,$4,'container_service','aws','aws:ecs_service','managed',$5,$6::text::jsonb)`,
    [h.ids.resAWebProd, h.ids.wsA, h.ids.envAProd, input.address, "b".repeat(64), JSON.stringify({ replicas: 3 })]);
  const proposed = await h.broker.propose({ capability: "drift.repair", scope: { workspaceId: h.ids.wsA, projectId: h.ids.projA,
    environmentId: h.ids.envAProd, resourceId: h.ids.resAWebProd }, input }, user("alice"));
  const op = proposed.operation;
  const started = await h.broker.beginExecution({ workspaceId: h.ids.wsA, operationId: op.id, holder: `workflow:${op.id}`, audience: "worker" });
  const ports = createOperationsPort(h.db!); const worker = createExecutionBroker(h.db!, async () => h.broker);
  const binding: EcsReplicaRepairBindingV1 = { version: 1, recipe: "aws.ecs.replicas", workspaceId: h.ids.wsA, projectId: h.ids.projA,
    environmentId: h.ids.envAProd, operationId: op.id, resourceId: h.ids.resAWebProd, address: input.address, revisionId: "revision-1",
    graphDigest: input.graphDigest, specDigest: "b".repeat(64), provider: "aws", nativeType: "aws:ecs_service", connectionId: "platform-connection",
    productConnectionId: "product-connection", accountId: "123456789012", region: "us-east-1", backendDigest: "c".repeat(64),
    tofuAddress: "aws_ecs_service.web", serviceArn: "arn:aws:ecs:us-east-1:123456789012:service/cluster/web",
    clusterArn: "arn:aws:ecs:us-east-1:123456789012:cluster/cluster", serviceCreatedAt: "2026-09-01T00:00:00.000Z",
    taskDefinitionArn: "arn:aws:ecs:us-east-1:123456789012:task-definition/web:7", ownershipTagsDigest: "d".repeat(64),
    field: "desired_count", desiredReplicas: 3, observedReplicas: 1,
    readProvenance: { service: "ecs:DescribeServices", autoscaling: "application-autoscaling:DescribeScalableTargets", resourceId: "service/cluster/web",
      namespace: "ecs", dimension: "ecs:service:DesiredCount", complete: true, scalableTargets: 0, simulated: false } };
  const plan = makePlan({ changes: [change({ address: binding.tofuAddress, nodeAddress: input.address, type: "aws_ecs_service", action: "update",
    changes: [{ path: "desired_count", before: 1, after: 3, sensitive: false, forcesReplacement: false }] })] });
  const facts = buildPlanFacts(plan)!;
  const persist = async () => {
    await repos.evidence.insert(h.db!, { id: repairBindingEvidenceId(op.id), workspaceId: h.ids.wsA, operationId: op.id, kind: "observation",
      digest: repairBindingDigest(binding), simulated: false, summary: { recipe: binding.recipe, binding } });
    const evidence = planEvidence({ plan, facts, cost: {}, graphDigest: input.graphDigest, stage: "plan", repairBinding: binding });
    await repos.evidence.insert(h.db!, { workspaceId: h.ids.wsA, operationId: op.id, kind: "tofu_plan", digest: plan.planDigest, simulated: false, summary: evidence.summary });
    await ports.setPlanDigest({ workspaceId: h.ids.wsA, operationId: op.id, planDigest: plan.planDigest });
    const decision = await worker.reevaluate(op.id, facts);
    await ports.setPolicyDecision({ workspaceId: h.ids.wsA, operationId: op.id, decisionId: decision.decisionId });
    return decision;
  };
  const approve = (who = "bob", digest = plan.planDigest) => h.broker.approve({ workspaceId: h.ids.wsA, operationId: op.id,
    proposalDigest: op.proposalDigest, planDigest: digest, approver: user(who), session: sessionFor(who) });
  return { h, op, started, worker, ports, binding, plan, persist, approve };
}

async function expectPlanningDenied(kind: "memory" | "pglite" | "postgres") {
  const h = await makeHarness({ kind, engine: scriptedEngine("deny-planning", (input) => input.request.capability === "infrastructure.plan"
    ? { outcome: "deny", reasons: [{ code: "read-denied", message: "planning denied" }] } : allowDecision()) });
  const proposed = await h.broker.propose({ capability: "drift.repair", scope: { workspaceId: h.ids.wsA, environmentId: h.ids.envAProd, resourceId: h.ids.resAWebProd }, input: {} }, user("alice"));
  await expect(h.broker.beginExecution({ workspaceId: h.ids.wsA, operationId: proposed.operation.id, holder: "worker", audience: "worker" })).rejects.toMatchObject({ code: "policy_denied" });
  expect((await h.store.getOperation(h.ids.wsA, proposed.operation.id))?.status).toBe("approved");
}

const SQL_STORE_KINDS = STORE_KINDS.filter((kind): kind is "pglite" | "postgres" => kind !== "memory");
describe.each(SQL_STORE_KINDS)("replica repair authority [%s]", (kind) => {
  describe("initial planning authority", () => {
    it("claims with independently authorized planning authority and preserves the original operation capability", async () => {
      const f = await fixture(kind); expect(f.started.claims.cap).toBe("infrastructure.plan"); expect(f.started.operation.capability).toBe("drift.repair");
      expect((await f.h.store.getOperation(f.h.ids.wsA, f.op.id))?.capability).toBe("drift.repair");
      await expect(f.worker.issueGrant(f.op.id, "worker", await f.h.acquireLease(f.h.ids.envAProd))).rejects.toThrow("concrete reviewed plan");
      const read = await f.worker.issueGrant(f.op.id, "worker", undefined, { capability: "infrastructure.plan" });
      expect(read.claims.cap).toBe("infrastructure.plan");
      await expect(f.h.broker.beginExecution({ workspaceId: f.h.ids.wsA, operationId: f.op.id, holder: "other", audience: "worker" }))
        .rejects.toMatchObject({ code: "already_claimed" });
    });
  });
  describe("planning policy denial", () => {
    it("refuses an initial claim when independent planning policy denies it", async () => {
      await expectPlanningDenied(kind);
    });
  });
  describe("browser plan approval", () => {
    it("requires exact current-round browser approval even when policy otherwise allows", async () => {
      const f = await fixture(kind); expect((await f.persist()).outcome).toBe("require_approval");
      expect((await f.worker.approvalStatus(f.op.id)).approved).toBe(false);
      await expect(f.worker.issueGrant(f.op.id, "worker", await f.h.acquireLease(f.h.ids.envAProd))).rejects.toThrow("current human approval round");
      await f.ports.transition({ workspaceId: f.h.ids.wsA, operationId: f.op.id, to: "awaiting_approval" });
      await expect(f.approve("bob", "f".repeat(64))).rejects.toMatchObject({ code: "digest_mismatch" });
      await expect(f.h.broker.approve({ workspaceId: f.h.ids.wsA, operationId: f.op.id, proposalDigest: f.op.proposalDigest,
        planDigest: f.plan.planDigest, approver: user("bob"), session: sessionFor("alice") })).rejects.toMatchObject({ code: "browser_session_required" });
      await f.approve(); await f.ports.transition({ workspaceId: f.h.ids.wsA, operationId: f.op.id, to: "running" });
      const grant = await f.worker.issueGrant(f.op.id, "worker", await f.h.acquireLease(f.h.ids.envAProd));
      expect(grant.claims).toMatchObject({ cap: "drift.repair", constraints: { repairPlanDigest: f.plan.planDigest, repairBindingDigest: repairBindingDigest(f.binding) } });
      await f.h.expireApprovals(f.op.id);
      await expect(f.worker.issueGrant(f.op.id, "worker", await f.h.acquireLease(f.h.ids.envAProd))).rejects.toThrow("human approval");
    });
  });
  describe("resumed planning authority", () => {
    it("reauthorizes resumed planning independently without consuming approval on denial or minting a repair bearer", async () => {
      const f = await fixture(kind); await f.persist();
      await f.ports.transition({ workspaceId: f.h.ids.wsA, operationId: f.op.id, to: "awaiting_approval" });
      await f.approve();
      f.h.setEngine(scriptedEngine("repair-policy", (input) => input.request.capability === "infrastructure.plan"
        ? { outcome: "deny", reasons: [{ code: "read-denied", message: "planning denied" }] } : allowDecision()));
      const resume = () => f.h.broker.beginExecution({ workspaceId: f.h.ids.wsA, operationId: f.op.id, holder: `workflow:${f.op.id}`, audience: "worker" });
      await expect(resume()).rejects.toMatchObject({ code: "policy_denied" });
      expect((await f.h.store.getOperation(f.h.ids.wsA, f.op.id))?.status).toBe("approved");
      expect((await f.h.store.listApprovals(f.h.ids.wsA, f.op.id)).every((approval) => !approval.consumedAt)).toBe(true);
      f.h.setEngine(scriptedEngine("repair-policy", () => allowDecision()));
      const resumed = await resume();
      expect(resumed.claims).toMatchObject({ cap: "infrastructure.plan", op: f.op.id, digest: f.op.proposalDigest });
      expect(resumed.operation.capability).toBe("drift.repair");
      expect(resumed.claims.constraints?.repairBindingDigest).toBeUndefined();
      const write = await f.worker.issueGrant(f.op.id, "worker", await f.h.acquireLease(f.h.ids.envAProd));
      expect(write.claims).toMatchObject({ cap: "drift.repair", constraints: { repairBindingDigest: repairBindingDigest(f.binding), repairPlanDigest: f.plan.planDigest } });
    });
  });
  describe("stricter approval policy", () => {
    it("preserves stricter approval count, role and separation requirements", async () => {
      const f = await fixture(kind, true); await f.persist(); await f.ports.transition({ workspaceId: f.h.ids.wsA, operationId: f.op.id, to: "awaiting_approval" });
      await expect(f.approve("alice")).rejects.toMatchObject({ code: "separation_of_duties" });
      await expect(f.approve("bob")).rejects.toMatchObject({ code: "approver_role_insufficient" });
      await f.approve("erin"); expect((await f.worker.approvalStatus(f.op.id)).approved).toBe(false);
      f.h.world.members.set(`${f.h.ids.wsA}|dave`, "admin"); await f.approve("dave");
      expect((await f.worker.approvalStatus(f.op.id)).approved).toBe(true);
    });
  });
  describe("immutable repair evidence", () => {
    it("refuses mismatched immutable evidence and unsupported policy restrictions", async () => {
      const f = await fixture(kind); await f.persist(); await f.ports.transition({ workspaceId: f.h.ids.wsA, operationId: f.op.id, to: "awaiting_approval" });
      await f.approve(); await f.ports.transition({ workspaceId: f.h.ids.wsA, operationId: f.op.id, to: "running" });
      await f.h.db!.query("update platform.evidence set simulated = true where id = $1", [repairBindingEvidenceId(f.op.id)]);
      await expect(f.worker.issueGrant(f.op.id, "worker", await f.h.acquireLease(f.h.ids.envAProd))).rejects.toThrow("immutable target binding");
      await f.h.db!.query("update platform.evidence set simulated = false where id = $1", [repairBindingEvidenceId(f.op.id)]);
      f.h.setEngine(scriptedEngine("restricted", () => ({ ...allowDecision(), constraints: { maxReplicas: 1 } })));
      await expect(f.worker.issueGrant(f.op.id, "worker", await f.h.acquireLease(f.h.ids.envAProd))).rejects.toThrow("cannot enforce");
    });
  });
});

describe("replica repair authority [memory]", () => {
  it("refuses an initial claim when independent planning policy denies it", async () => {
    await expectPlanningDenied("memory");
  });
});
