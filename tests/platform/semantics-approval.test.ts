/**
 * PROD-DUR-03 approval binding over the real PGlite ledger and broker (synthetic plans, scripted policy, no
 * cloud calls): at a plan gate whose recorded review carries the canonical executable-semantics digest, an
 * approval must present exactly that digest; the binding is audited; plans reviewed before the digest existed
 * keep their previous approval behaviour (and are refused later at dispatch when a store is wired).
 */
import { describe, expect, it } from "vitest";
import type { StoreKind } from "../capabilities/support";
import { tempDataDir } from "../_support/data-dir";

tempDataDir("zenith-semantics-approval-", { fast: true });
const { STORE_KINDS, makeHarness, closeSharedPgliteAfterAll, scriptedEngine, requireApproval, user, sessionFor } = await import("../capabilities/support");
const { makePlan, change } = await import("../execution/fakes/fixtures");
const { migration0013ApprovedSourceSnapshots } = await import("@/lib/controlplane/db/migrations/0013_approved_source_snapshots");
const { repos } = await import("@/lib/controlplane/db");
const { buildPlanFacts } = await import("@/lib/capabilities/evaluate");
const { planEvidence } = await import("@/lib/execution/plan-evidence");
const { createOperationsPort } = await import("@/lib/execution/platform");
const { createExecutionBroker } = await import("@/lib/platform/broker");
const { computeExecutableSemantics } = await import("@/lib/execution/semantics/digest");
closeSharedPgliteAfterAll();

const plan = makePlan({ changes: [change({ address: "aws_s3_bucket.assets", type: "aws_s3_bucket", action: "create" })] });
const facts = buildPlanFacts(plan)!;
const hex = (c: string): string => c.repeat(64);
const semantics = computeExecutableSemantics({
  revision: { id: "rev_1", deployedRevisionId: null, manifestDigest: hex("1") },
  recipe: { executableSourceDigest: null, sources: [] },
  scripts: { release: null },
  migrations: null,
  targets: { graphDigest: hex("a"), provider: "aws", region: "us-east-1", environmentId: "env", connectionId: "conn", connectionConfigDigest: hex("b") },
  configuration: { configDigest: hex("c") },
  providerLocks: { lockDigest: hex("d"), tofuVersion: "1.12.5" },
  backend: { kind: "s3", configDigest: hex("e") },
  savedPlan: { planDigest: plan.planDigest },
  provenance: { pipelines: [] },
  ownership: { transfers: [] },
  runbook: null,
  decommission: { adoptions: [] },
});

async function gated(kind: StoreKind, withSemantics: boolean) {
  const h = await makeHarness({ kind, engine: scriptedEngine("plan-policy", () => requireApproval(1, "admin", true)) });
  await h.db!.exec(migration0013ApprovedSourceSnapshots.sql);
  const proposal = await h.broker.propose({ capability: "deployment.deploy", scope: { workspaceId: h.ids.wsA, projectId: h.ids.projA, environmentId: h.ids.envAProd }, input: {} }, user("alice"));
  const op = proposal.operation;
  const first = { workspaceId: h.ids.wsA, operationId: op.id, proposalDigest: op.proposalDigest, approver: user("erin"), session: sessionFor("erin") };
  await h.broker.approve(first);
  await h.broker.beginExecution({ workspaceId: h.ids.wsA, operationId: op.id, holder: `workflow:${op.id}`, audience: "worker" });
  const ports = createOperationsPort(h.db!);
  const worker = createExecutionBroker(h.db!, async () => h.broker);
  const evidence = planEvidence({ plan, facts, cost: {}, graphDigest: hex("a"), stage: "plan" });
  await repos.evidence.insert(h.db!, { workspaceId: h.ids.wsA, operationId: op.id, kind: "tofu_plan", digest: plan.planDigest, summary: { ...evidence.summary, ...(withSemantics ? { semantics } : {}) }, simulated: false });
  await ports.setPlanDigest({ workspaceId: h.ids.wsA, operationId: op.id, planDigest: plan.planDigest });
  const decision = await worker.reevaluate(op.id, facts);
  await ports.setPolicyDecision({ workspaceId: h.ids.wsA, operationId: op.id, decisionId: decision.decisionId });
  await ports.transition({ workspaceId: h.ids.wsA, operationId: op.id, to: "awaiting_approval" });
  const decide = (planDigest?: string, semanticsDigest?: string, who = "erin") =>
    h.broker.approve({ workspaceId: h.ids.wsA, operationId: op.id, proposalDigest: op.proposalDigest, planDigest, semanticsDigest, approver: user(who), session: sessionFor(who) });
  return { h, op, decide, worker };
}

describe.each(STORE_KINDS.filter((k) => k !== "memory"))("approval binds the canonical executable semantics [%s]", (kind) => {
  it("shows the digest in the operation detail the browser and MCP read", async () => {
    const { h, op } = await gated(kind, true);
    const detail = await h.broker.getOperationDetail({ workspaceId: h.ids.wsA, operationId: op.id, principal: user("erin") });
    expect(detail.planReview?.semantics?.digest).toBe(semantics.digest);
    expect(Object.keys(detail.planReview!.semantics!.components)).toHaveLength(13);
  });

  it("refuses an approval that omits the semantics digest", async () => {
    const { h, op, decide } = await gated(kind, true);
    await expect(decide(plan.planDigest)).rejects.toMatchObject({ code: "semantics_mismatch" });
    expect((await h.store.listApprovals(h.ids.wsA, op.id)).filter((a) => a.decision === "approve")).toHaveLength(1); // only round zero
  });

  it("refuses an approval of different semantics, without leaking the recorded value into the message", async () => {
    const { decide } = await gated(kind, true);
    const error = await decide(plan.planDigest, hex("0")).catch((e: unknown) => e as { code: string; message: string });
    expect((error as { code: string }).code).toBe("semantics_mismatch");
    expect((error as { message: string }).message).not.toContain(semantics.digest);
  });

  it("records the approval and an audit row naming the semantics it was given against", async () => {
    const { h, op, decide, worker } = await gated(kind, true);
    const outcome = await decide(plan.planDigest, semantics.digest);
    expect(outcome.finalized).toBe(true);
    const events = await repos.events.list(h.db!, h.ids.wsA, { operationId: op.id });
    const bound = events.find((e) => e.type === "policy.evaluated" && e.data.kind === "approval_semantics_bound");
    expect(bound?.data).toMatchObject({ approvalId: outcome.approval.id, semanticsDigest: semantics.digest, planDigest: plan.planDigest });
    expect((await worker.approvalStatus(op.id)).approved).toBe(true);
  });

  it("a rejection needs no semantics digest", async () => {
    const { h, op } = await gated(kind, true);
    const rejected = await h.broker.reject({ workspaceId: h.ids.wsA, operationId: op.id, proposalDigest: op.proposalDigest, approver: user("erin"), session: sessionFor("erin") });
    expect(rejected.operation.status).toBe("rejected");
  });

  it("plans reviewed before the digest existed keep the previous approval behaviour", async () => {
    const { h, op, decide } = await gated(kind, false);
    const detail = await h.broker.getOperationDetail({ workspaceId: h.ids.wsA, operationId: op.id, principal: user("erin") });
    expect(detail.planReview?.semantics).toBeUndefined();
    expect((await decide(plan.planDigest)).finalized).toBe(true);
  });
});
