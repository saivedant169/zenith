/** Real PGlite ledger/broker/signing; synthetic plans and scripted policy, no cloud calls. */
import { describe, expect, it } from "vitest";
import { tempDataDir } from "../_support/data-dir";

tempDataDir("zenith-plan-approval-", { fast: true });
const { makeHarness, closeSharedPgliteAfterAll, scriptedEngine, requireApproval, allowDecision, user, sessionFor, PG_URL } = await import("../capabilities/support");
const { makePlan, change } = await import("../execution/fakes/fixtures");
const {migration0013ApprovedSourceSnapshots}=await import("@/lib/controlplane/db/migrations/0013_approved_source_snapshots");
const { repos } = await import("@/lib/controlplane/db");
const { approvalRoundOf, projectPlanReview } = await import("@/lib/controlplane/db/repos/operation-review");
const { buildPlanFacts } = await import("@/lib/capabilities/evaluate");
const { planEvidence } = await import("@/lib/execution/plan-evidence");
const { createOperationsPort } = await import("@/lib/execution/platform");
const { createExecutionBroker } = await import("@/lib/platform/broker");
closeSharedPgliteAfterAll();
const plan = makePlan({ changes: [change({ address: "aws_s3_bucket.assets", type: "aws_s3_bucket", action: "create", changes: [
  { path: "bucket", before: "raw-before-canary", after: "raw-after-canary", sensitive: false, forcesReplacement: false },
  { path: "password", before: "(sensitive)", after: "(sensitive)", sensitive: true, forcesReplacement: false },
] })] });
const facts = buildPlanFacts(plan)!;
const artifact = (cost = {}) => planEvidence({ plan, facts, cost, graphDigest: "a".repeat(64), stage: "plan" });

async function running(count = 1) {
  const h = await makeHarness({ kind: "pglite", engine: scriptedEngine("plan-policy", (input) => requireApproval(input.plan?.create ? count : 1, "admin", true)) });
  await h.db!.exec(migration0013ApprovedSourceSnapshots.sql); // Explicit candidate prerequisite; not production registry proof.
  const proposal = await h.broker.propose({ capability: "deployment.deploy", scope: { workspaceId: h.ids.wsA, projectId: h.ids.projA, environmentId: h.ids.envAProd }, input: {} }, user("alice"));
  const op = proposal.operation;
  const decide = (who = "erin", planDigest?: string, decision: "approve" | "reject" = "approve") => h.broker[decision]({ workspaceId: h.ids.wsA, operationId: op.id, proposalDigest: op.proposalDigest, planDigest, approver: user(who), session: sessionFor(who) });
  await decide();
  await h.broker.beginExecution({ workspaceId: h.ids.wsA, operationId: op.id, holder: `workflow:${op.id}`, audience: "worker" });
  const ports = createOperationsPort(h.db!);
  const worker = createExecutionBroker(h.db!, async () => h.broker);
  const evidence = artifact({ deltaUsdMonthly: 12.5 });
  await repos.evidence.insert(h.db!, { workspaceId: h.ids.wsA, operationId: op.id, kind: "tofu_plan", digest: plan.planDigest, summary: evidence.summary, simulated: false });
  await ports.setPlanDigest({ workspaceId: h.ids.wsA, operationId: op.id, planDigest: plan.planDigest });
  const decision = await worker.reevaluate(op.id, facts);
  await ports.setPolicyDecision({ workspaceId: h.ids.wsA, operationId: op.id, decisionId: decision.decisionId });
  const suspend = () => ports.transition({ workspaceId: h.ids.wsA, operationId: op.id, to: "awaiting_approval" });
  return { h, op, decide, worker, ports, suspend, decision };
}

describe("concrete plan approval rounds", () => {
  it("preserves require_approval, ignores consumed round zero, and grants only after this plan round is approved", async () => {
    const { h, op, worker, suspend, ports, decide, decision } = await running();
    expect(decision.outcome).toBe("require_approval");
    expect(await worker.approvalStatus(op.id)).toMatchObject({ approved: false, rejected: false });
    const fence = await h.acquireLease(h.ids.envAProd);
    await expect(worker.issueGrant(op.id, "worker", fence)).rejects.toThrow("current round");
    await h.loseLease(fence.scope);
    const waiting = await suspend();
    expect(waiting?.status).toBe("awaiting_approval"); expect(approvalRoundOf(waiting!)).toBe(1);
    expect(await worker.approvalStatus(op.id)).toMatchObject({ approved: false, rejected: false });
    await decide("erin", plan.planDigest);
    expect(await worker.approvalStatus(op.id)).toMatchObject({ approved: true, rejected: false });
    await ports.transition({ workspaceId: h.ids.wsA, operationId: op.id, to: "running" });
    const newFence = await h.acquireLease(h.ids.envAProd);
    expect(newFence.fenceToken).toBeGreaterThan(fence.fenceToken);
    const grant = await worker.issueGrant(op.id, "worker", newFence);
    expect(grant.claims).toMatchObject({ op: op.id, fence: newFence.fenceToken });
    const approvals = await h.store.listApprovals(h.ids.wsA, op.id);
    expect(approvals.map(approvalRoundOf)).toEqual([0, 1]);
    expect(approvals.every((a) => Boolean(a.consumedAt))).toBe(true);
    const events = await repos.events.list(h.db!, h.ids.wsA, { operationId: op.id });
    expect(events.filter((e) => e.type === "operation.started")).toHaveLength(2);
    expect(events.some((e) => e.type === "operation.prepared" && e.data.kind === "approval_gate")).toBe(true);
  });
  it("refuses missing/stale reviewed plan digests, including the SQL path", async () => {
    const { h, op, suspend, decide } = await running(); await suspend();
    await expect(decide()).rejects.toMatchObject({ code: "digest_mismatch" });
    await expect(decide("erin", "f".repeat(64))).rejects.toMatchObject({ code: "digest_mismatch" });
    await expect(h.store.recordApproval({ workspaceId: h.ids.wsA, operationId: op.id, proposalDigest: op.proposalDigest, approver: user("erin"), approverRole: "admin", policyVersion: "plan-policy", decision: "approve" })).rejects.toMatchObject({ code: "digest_mismatch" });
    expect(await h.store.listApprovals(h.ids.wsA, op.id)).toHaveLength(1);
  });
  it("checks round preconditions under the SQL lock and prevents an old request deciding a later round", async () => {
    const { h, op, suspend } = await running(); await suspend();
    const input = { workspaceId: h.ids.wsA, operationId: op.id, proposalDigest: op.proposalDigest, approver: user("erin"), approverRole: "admin" as const, policyVersion: "plan-policy", decision: "approve" as const, planDigest: plan.planDigest, expectedApprovalRound: 0 };
    await expect(h.store.recordApproval(input)).rejects.toMatchObject({ code: "digest_mismatch" });
  });
  it("enforces separation, minimum role and distinct count in the plan round", async () => {
    const { h, op, suspend, decide, worker } = await running(2); await suspend();
    await expect(decide("alice", plan.planDigest)).rejects.toMatchObject({ code: "separation_of_duties" });
    await expect(decide("bob", plan.planDigest)).rejects.toMatchObject({ code: "approver_role_insufficient" });
    const first = await decide("erin", plan.planDigest); expect(first.finalized).toBe(false); expect(first.approvals).toEqual({ have: 1, need: 2 });
    await expect(decide("erin", plan.planDigest)).rejects.toMatchObject({ code: "duplicate_decision" });
    expect((await worker.approvalStatus(op.id)).approved).toBe(false);
    h.world.members.set(`${h.ids.wsA}|dave`, "admin"); await decide("dave", plan.planDigest);
    expect((await worker.approvalStatus(op.id)).approved).toBe(true);
    h.world.members.set(`${h.ids.wsA}|erin`, "viewer");
    expect((await worker.approvalStatus(op.id)).approved).toBe(false);
    await h.expireApprovals(op.id); expect((await worker.approvalStatus(op.id)).approved).toBe(false);
  });
  it("rejects the plan round even without a reviewed artifact and issues no apply grant", async () => {
    const { h, op, worker, suspend, decide } = await running(); await suspend();
    await decide("erin", undefined, "reject");
    expect(await worker.approvalStatus(op.id)).toMatchObject({ approved: false, rejected: true });
    await expect(worker.issueGrant(op.id, "worker")).rejects.toThrow("running");
    expect((await h.store.getOperation(h.ids.wsA, op.id))?.status).toBe("rejected");
  });
  it("keeps deny as deny instead of opening an approval gate", async () => {
    const { h, op, worker } = await running();
    h.setEngine(scriptedEngine("denied-now", () => ({ outcome: "deny", reasons: [{ code: "public_database", message: "Public DB denied." }] })));
    expect(await worker.reevaluate(op.id, facts)).toMatchObject({ outcome: "deny", reasons: ["public_database"] });
    expect(await worker.approvalStatus(op.id)).toEqual({ approved: false, rejected: true });
  });
  it("refuses approval if current concrete-plan policy denies, even if proposal policy allows", async () => {
    const { h, suspend, decide } = await running(); await suspend();
    h.setEngine(scriptedEngine("changed", (input) => input.plan?.create ? { outcome: "deny", reasons: [{ code: "plan_denied", message: "The plan is denied." }] } : requireApproval(1, "admin", true)));
    await expect(decide("erin", plan.planDigest)).rejects.toMatchObject({ code: "policy_denied" });
  });
  it("cannot replace the approved plan digest with a re-plan", async () => {
    const { h, op, ports, suspend, decide } = await running(); await suspend(); await decide("erin", plan.planDigest);
    await expect(ports.setPlanDigest({ workspaceId: h.ids.wsA, operationId: op.id, planDigest: makePlan({ seed: "changed" }).planDigest })).rejects.toThrow("plan_changed");
    expect((await h.store.getOperation(h.ids.wsA, op.id))?.planDigest).toBe(plan.planDigest);
  });
  it("an approval recorded before a plan is stamped cannot authorize that later plan", async () => {
    const { h, ports } = await running();
    const op = (await h.broker.propose({ capability: "deployment.deploy", scope: { workspaceId: h.ids.wsA, projectId: h.ids.projA, environmentId: h.ids.envAProd }, input: {} }, user("alice"))).operation;
    const approve = () => h.broker.approve({ workspaceId: h.ids.wsA, operationId: op.id, proposalDigest: op.proposalDigest, approver: user("erin"), session: sessionFor("erin") });
    await approve(); await h.broker.beginExecution({ workspaceId: h.ids.wsA, operationId: op.id, holder: `workflow:${op.id}`, audience: "worker" });
    await ports.transition({ workspaceId: h.ids.wsA, operationId: op.id, to: "awaiting_approval" });
    await approve();
    await expect(ports.setPlanDigest({ workspaceId: h.ids.wsA, operationId: op.id, planDigest: plan.planDigest })).rejects.toThrow("plan_changed");
    expect((await h.store.getOperation(h.ids.wsA, op.id))?.planDigest).toBeUndefined();
  });
  it("exposes tenant-scoped, bounded review evidence with no attribute values and unknown costs", async () => {
    const { h, op, suspend } = await running(); await suspend();
    const detail = await h.broker.getOperationDetail({ workspaceId: h.ids.wsA, operationId: op.id, principal: user("erin") });
    expect(detail.planReview).toMatchObject({ planDigest: plan.planDigest, cost: { deltaUsdMonthly: 12.5 }, decision: { outcome: "require_approval" } });
    expect(JSON.stringify(detail)).not.toMatch(/raw-before-canary|raw-after-canary|fingerprint/);
    expect(detail.planReview?.view.resources[0].changes).toEqual([{ path: "bucket", forcesReplacement: false }, { path: "password", sensitive: true, forcesReplacement: false }]);
    expect(detail.operation.approvalRound).toBe(1);
    await expect(h.broker.getOperationDetail({ workspaceId: h.ids.wsB, operationId: op.id, principal: user("mallory") })).rejects.toMatchObject({ code: "not_found" });
    const summary = artifact().summary; expect(projectPlanReview(summary, plan.planDigest)?.cost).toEqual({});
    expect(projectPlanReview({ ...summary, view: {} }, plan.planDigest)).toBeUndefined();
    expect(projectPlanReview({ ...summary, stage: "final_plan" }, plan.planDigest)).toBeUndefined();
    expect(projectPlanReview(summary, "b".repeat(64))).toBeUndefined();
  });
  it("refuses missing/simulated evidence and expires an unanswered plan round", async () => {
    const { h, op, suspend, decide, ports } = await running(); await suspend();
    await h.db!.query("update platform.evidence set simulated = true where workspace_id = $1 and operation_id = $2", [h.ids.wsA, op.id]);
    await expect(decide("erin", plan.planDigest)).rejects.toMatchObject({ code: "invalid_state" });
    await h.expireOperation(op.id); await ports.transition({ workspaceId: h.ids.wsA, operationId: op.id, to: "expired" });
    expect((await h.store.getOperation(h.ids.wsA, op.id))?.status).toBe("expired");
  });
});


/** Initial source review is immutable before the destroy proposal exists. Synthetic plan bytes remain outside this authority test. */
async function immutableDestroyReview(kind:"pglite"|"postgres") {
  const h=await makeHarness({kind,engine:scriptedEngine("source-review-policy",input=>input.request.capability==="infrastructure.destroy"?requireApproval(1,"admin"):allowDecision())});
  await h.db!.exec(migration0013ApprovedSourceSnapshots.sql); // Explicit candidate prerequisite.
  const scope={workspaceId:h.ids.wsA,projectId:h.ids.projA,environmentId:h.ids.envASbx};
  const initial=await h.broker.propose({capability:"infrastructure.plan",scope,input:{environmentId:scope.environmentId,teardownReview:true}},user("bob"));
  const source=initial.operation;
  await h.broker.beginExecution({workspaceId:scope.workspaceId,operationId:source.id,holder:`workflow:${source.id}`,audience:"worker"});
  const removed=makePlan({changes:[change({address:"terraform_data.reviewed",type:"terraform_data",action:"delete",destroysData:false})]});
  const destroyFacts=buildPlanFacts(removed)!;
  const summary={...planEvidence({plan:removed,facts:destroyFacts,cost:{},graphDigest:"a".repeat(64),stage:"plan"}).summary,destroy:true,destroyAddresses:["terraform_data.reviewed"],statefulDeletes:[]};
  const evidence=await repos.evidence.insert(h.db!,{workspaceId:scope.workspaceId,operationId:source.id,kind:"tofu_plan",digest:removed.planDigest,summary,simulated:false});
  const ports=createOperationsPort(h.db!);await ports.setPlanDigest({workspaceId:scope.workspaceId,operationId:source.id,planDigest:removed.planDigest});
  const proposed=await h.broker.propose({capability:"infrastructure.destroy",scope,input:{environmentId:scope.environmentId}},user("bob"),{via:"workflow",teardownReview:true,destroyPlan:{operationId:source.id,planDigest:removed.planDigest}});
  const op=proposed.operation;
  await repos.evidence.insert(h.db!,{workspaceId:scope.workspaceId,operationId:op.id,kind:"tofu_plan",digest:removed.planDigest,summary,simulated:false});
  await h.broker.completeExecution({workspaceId:scope.workspaceId,operationId:source.id,outcome:"succeeded",result:{operationId:op.id,planDigest:removed.planDigest}});
  await h.broker.approve({workspaceId:scope.workspaceId,operationId:op.id,proposalDigest:op.proposalDigest,planDigest:removed.planDigest,approver:user("erin"),session:sessionFor("erin")});
  const worker=createExecutionBroker(h.db!,async()=>h.broker);
  return {h,source,op,evidence,scope,removed,ports,worker};
}
for(const kind of ["pglite",...(PG_URL?["postgres" as const]:[])] as const) describe(`immutable source review approval [${kind}]`,()=>{
  it("accepts the exact initial immutable source review and its digest-bound browser human approval",async()=>{
    const f=await immutableDestroyReview(kind);
    expect(approvalRoundOf(f.op)).toBe(0);expect((await f.worker.approvalStatus(f.op.id)).approved).toBe(true);
    await f.ports.transition({workspaceId:f.scope.workspaceId,operationId:f.op.id,to:"running"});
    const approvals=await f.h.store.listApprovals(f.scope.workspaceId,f.op.id);
    expect(approvals).toHaveLength(1);
    expect(approvals[0]).toMatchObject({workspaceId:f.scope.workspaceId,operationId:f.op.id,proposalDigest:f.op.proposalDigest,decision:"approve",approverRole:"admin",approver:{kind:"user",id:"erin"}});
    expect(approvalRoundOf(approvals[0])).toBe(0);
    const current=await f.h.store.getOperation(f.scope.workspaceId,f.op.id);
    expect(current).toMatchObject({status:"running",proposalDigest:f.op.proposalDigest,planDigest:f.removed.planDigest});
    expect(current?.proposal.planDigest).toBe(f.removed.planDigest);
    const approved=await f.worker.approvalStatus(f.op.id);
    expect(approved.approved).toBe(true);
    expect(approved.dispatchApproval?.approvalIds).toEqual([approvals[0].id]);
    const grants=()=>f.h.db!.query<{jti:string}>("select jti from platform.capability_grants where workspace_id=$1 and operation_id=$2",[f.scope.workspaceId,f.op.id]);
    expect(await grants()).toEqual([]);
    const fence=await f.h.acquireLease(f.scope.environmentId);
    let returnedGrant:unknown;
    // Browser approval is genuine for this exact digest. A direct call has no
    // private active held-attempt origin and must neither sign nor insert a grant.
    await expect(f.worker.issueGrant(f.op.id,"worker",fence).then(grant=>{returnedGrant=grant;return grant;})).rejects.toMatchObject({code:"cleanup_writer_unconfirmed"});
    expect(returnedGrant).toBeUndefined();
    expect(await grants()).toEqual([]);
    expect((await f.worker.approvalStatus(f.op.id)).dispatchApproval?.approvalIds).toEqual([approvals[0].id]);
    expect((await f.worker.approvalStatus(f.op.id)).approved).toBe(true);
  });
  it.each(["failed source","expired source","simulated source evidence","missing source evidence","foreign source scope","foreign source workspace reference","moved source digest"])("refuses %s for an initial destroy proposal",async(mode)=>{
    const f=await immutableDestroyReview(kind);
    if(mode==="failed source")await f.h.db!.query("update platform.operations set status='failed' where workspace_id=$1 and id=$2",[f.scope.workspaceId,f.source.id]);
    if(mode==="expired source")await f.h.expireOperation(f.source.id);
    if(mode==="simulated source evidence")await f.h.db!.query("update platform.evidence set simulated=true where workspace_id=$1 and id=$2",[f.scope.workspaceId,f.evidence.id]);
    if(mode==="missing source evidence")await f.h.db!.query("delete from platform.evidence where workspace_id=$1 and id=$2",[f.scope.workspaceId,f.evidence.id]);
    if(mode==="foreign source scope")await f.h.db!.query("update platform.operations set environment_id=$3 where workspace_id=$1 and id=$2",[f.scope.workspaceId,f.source.id,f.h.ids.envBProd]);
    if(mode==="foreign source workspace reference") {
      const foreign=await repos.operations.create(f.h.db!,{workspaceId:f.h.ids.wsB,principal:user("foreign-reviewer"),proposal:{capability:"infrastructure.plan",scope:{workspaceId:f.h.ids.wsB,environmentId:f.h.ids.envBProd},input:{environmentId:f.h.ids.envBProd,teardownReview:true},planDigest:f.removed.planDigest,summary:"Independent foreign review",details:[],risk:"high"}});
      await f.h.db!.query("update platform.operations set status='succeeded' where workspace_id=$1 and id=$2",[f.h.ids.wsB,foreign.operation.id]);
      const foreignEvidence=await repos.evidence.insert(f.h.db!,{workspaceId:f.h.ids.wsB,operationId:foreign.operation.id,kind:"tofu_plan",digest:f.removed.planDigest,summary:f.evidence.summary,simulated:false});
      // Corrupt only the destination's immutable source reference; lookup must stay in its own workspace.
      await f.h.db!.query("update platform.operations set proposal=jsonb_set(proposal,'{broker,destroyPlan}',$3::jsonb) where workspace_id=$1 and id=$2",[f.scope.workspaceId,f.op.id,JSON.stringify({operationId:foreign.operation.id,evidenceId:foreignEvidence.id})]);
    }
    if(mode==="moved source digest")await f.h.db!.query("update platform.operations set plan_digest=$3 where workspace_id=$1 and id=$2",[f.scope.workspaceId,f.source.id,"f".repeat(64)]);
    expect((await f.worker.approvalStatus(f.op.id)).approved).toBe(false);
  });
});


describe("source-bound canonical review projection",()=>{
  const source={service:"container_service/web",commit:"a".repeat(40),dockerfileDigest:"d".repeat(64),recipeDigest:"e".repeat(64),archiveDigest:"f".repeat(64),archiveFormat:"zip" as const};
  const summary=()=>{const old=artifact().summary;return {...old,executableSourceDigest:"c".repeat(64),view:{...old.view as object,executableSourceDigest:"c".repeat(64),approvedSources:[source]}};};
  it("preserves strict source metadata and exact digest while dropping no authority into output values",()=>{
    expect(projectPlanReview(summary(),plan.planDigest)?.view).toMatchObject({executableSourceDigest:"c".repeat(64),approvedSources:[source]});
  });
  it.each(["different digest","no digest","duplicate service","bad commit","unknown metadata","hidden count missing"])("refuses %s source metadata",kind=>{
    const s=summary(),v=s.view as {executableSourceDigest?:string;approvedSources:Record<string,unknown>[];approvedSourcesTruncated?:boolean};
    if(kind==="different digest")v.executableSourceDigest="b".repeat(64);if(kind==="no digest")delete v.executableSourceDigest;
    if(kind==="duplicate service")v.approvedSources.push({...source});if(kind==="bad commit")v.approvedSources[0]={...source,commit:"main"};
    if(kind==="unknown metadata")v.approvedSources[0]={...source,token:"unexpected"};if(kind==="hidden count missing")v.approvedSourcesTruncated=true;
    expect(projectPlanReview(s,plan.planDigest)).toBeUndefined();
  });
  it("missing native schema/read errors never downgrade a current source-bearing review or leak diagnostics",async()=>{
    const {withPlanReview}=await import("@/lib/controlplane/db/repos/operation-review");
    const {operation}=await import("../screens/platform/fixtures");
    const input=summary(),sql={query:async(query:string)=>{if(query.startsWith("select summary"))return [{summary:input}];throw new Error("PRIVATE-TRANSPORT-DIAGNOSTIC");},tx:async()=>{throw new Error("Read-only model.");}};
    const read=withPlanReview(sql as never,{...operation(),planDigest:plan.planDigest,approvalRound:0});await expect(read).rejects.toThrow("Approved source review is unavailable");await expect(read).rejects.not.toThrow("PRIVATE-TRANSPORT-DIAGNOSTIC");
  });
  it("bounds source metadata inside the total view budget and declares the exact omitted service count",async()=>{
    const {immutableSourceSnapshot,sourceSnapshotSetDigest}=await import("@/lib/execution/source-snapshot");
    const rows=Array.from({length:100},(_,i)=>immutableSourceSnapshot({format:"zenith.approved-source.v1",workspaceId:"ws",operationId:"op",projectId:"proj",environmentId:"env",
      serviceAddress:`container_service/service${i}`,pipelineAddress:`build_pipeline/service${i}`,serviceSpecDigest:"a".repeat(64),pipelineSpecDigest:"b".repeat(64),provider:"aws",region:"us-east-1",owner:"acme",repo:"app",repositoryId:99,requestedRef:"main",commitSha:"a".repeat(40),githubBinding:null,dockerfile:"Dockerfile",dockerfileDigest:"d".repeat(64),recipeDigest:"e".repeat(64),archiveFormat:"zip",archiveDigest:"f".repeat(64),archiveBytes:100}));
    const bound={...plan,executableSourceDigest:sourceSnapshotSetDigest(rows)},evidence=planEvidence({plan:bound,facts,cost:{},graphDigest:"a".repeat(64),stage:"plan",approvedSources:rows});
    expect(Buffer.byteLength(JSON.stringify(evidence.summary.view))).toBeLessThanOrEqual(40_000);
    const view=projectPlanReview(evidence.summary,bound.planDigest)?.view;expect(view?.approvedSources).toHaveLength(64);expect(view?.approvedSourcesOmitted).toBe(36);expect(view?.approvedSourcesTruncated).toBe(true);expect(view?.executableSourceDigest).toBe(sourceSnapshotSetDigest(rows));
  });
});
