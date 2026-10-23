import { operationPlanReview } from "@/lib/controlplane/db/repos/operation-review";
/** Real PGlite ledger, broker and committed OPA; cloud/Tofu/product ports are explicit contract fakes. */
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDestroyActivities } from "@/lib/execution/destroy";
import { createRuntime } from "@/lib/execution/runtime";
import { createPlatformPorts } from "@/lib/execution/platform";
import { createExecutionBroker } from "@/lib/platform/broker";
import { requestDestroyReview, getDestroyReview, runDestroyReview } from "@/lib/capabilities/destroy-review";
import { setDestroyReviewDispatcherForTests } from "@/lib/capabilities/destroy-review-dispatch";
import { loadDestroyPlan } from "@/lib/capabilities/destroy-plan";
import { createWorld, type World } from "./fakes/world";
import { bucketManifest, change, makePlan, REVISION, CANARY_SECRET, CANARY_SESSION_KEY } from "./fakes/fixtures";
import { upgradeManifest } from "@/lib/resources/upgrade";
import { closeSharedPgliteAfterAll, integrationOf, makeHarness, sessionFor, user, PG_URL, scriptedEngine, requireApproval } from "../capabilities/support";
import { deliverPlanApproval } from "@/lib/bridge/lifecycle";
import { setBridgeDepsForTests } from "@/lib/bridge/deps";
import { planEvidence, toPlanSummary } from "@/lib/execution/plan-evidence";
import { extractPlanFacts } from "@/lib/policy/plan-facts";
import { StepFailedError } from "@/lib/execution/errors";

closeSharedPgliteAfterAll();
const worlds: World[] = [];
afterEach(() => { worlds.splice(0).forEach((w) => w.dispose()); setDestroyReviewDispatcherForTests(undefined); setBridgeDepsForTests(null); vi.restoreAllMocks(); });

async function setup(kind: "pglite" | "postgres" = "pglite") {
  const h = await makeHarness({ kind });
  const w = createWorld(); worlds.push(w);
  const scope = { workspaceId: h.ids.wsA, projectId: h.ids.projA, environmentId: h.ids.envASbx };
  const env = w.product.base.environment;
  env.id = scope.environmentId; env.class = "sandbox"; env.deployedRevisionId = REVISION;
  w.product.base.workspace.id = scope.workspaceId; w.product.base.project.id = scope.projectId;
  const manifest = upgradeManifest(bucketManifest(), { provider: "aws", region: "us-east-1" });
  manifest.policies = { backup: "daily", ...manifest.policies, deletion: "allow" }; w.product.setManifest(manifest);
  vi.spyOn(w.product, "loadContext").mockImplementation(async () => ({ ...structuredClone(w.product.base), revision: structuredClone(w.product.revisions.get(REVISION)!) }));
  w.tofu.planFactory = (ws) => makePlan({ configDigest: ws.configDigest, lockDigest: ws.lockDigest,
    changes: [change({ address: "aws_s3_bucket.object_store_assets", nodeAddress: "object_store/assets", type: "aws_s3_bucket", action: "delete", destroysData: true })] });
  vi.spyOn(w.connections, "resolve").mockResolvedValue({ ...w.connections.connections.values().next().value!, workspaceId: scope.workspaceId });
  const platform = createPlatformPorts(h.db!);
  const fixtureArtifacts=w.deps.planArtifacts;
  if(!fixtureArtifacts)throw new Error("Isolated custody fixture is missing.");
  const planArtifacts={...fixtureArtifacts,async publish(input:Parameters<typeof fixtureArtifacts.publish>[0]) {
    if(!input.produced)throw new Error("Isolated review producer is missing.");
    const operation=await platform.ops.get(input.produced.manifest.operationId);
    if(!operation)throw new Error("Isolated review operation is missing.");
    w.ops.seed({...operation});
    await fixtureArtifacts.publish(input);
    // Explicit PGlite fixture: the composed ledger, read by the real broker, owns the digest and sanitized evidence.
    await platform.ops.setPlanDigest({workspaceId:operation.workspaceId,operationId:operation.id,planDigest:input.produced.manifest.planDigest});
    await platform.evidence.append(input.evidence);
  }};
  const rt = createRuntime({ ...w.deps, ...platform, planArtifacts, product: w.product, connections: w.connections,
    broker: createExecutionBroker(h.db!, async () => h.broker), clock: () => h.clock.now(), limits: { heartbeatIntervalMs: 1000 } });
  const activities = createDestroyActivities(rt, { reviewBroker: async () => h.broker });
  const agent = integrationOf(h, "intRO");
  h.world.integrations.get(`${scope.workspaceId}|${agent.id}`)!.scopes = ["plan"];
  h.world.members.set(`${scope.workspaceId}|bob`, "viewer");
  const dispatch = vi.fn(async () => undefined); setDestroyReviewDispatcherForTests(dispatch);
  const request = (key = "destroy-intent-001", refresh = false, actor = agent) => requestDestroyReview(h.broker, scope, actor, { idempotencyKey: key, refresh });
  const run = (operationId: string) => activities.reviewTeardown({ workspaceId: scope.workspaceId, operationId });
  const review = async (key = "destroy-intent-001", refresh = false) => { const queued = await request(key, refresh); return run(queued.reviewOperationId); };
  return { h, w, scope, rt, activities, agent, dispatch, request, run, review };
}

describe("first destroy review", () => {
  it("a plan-only viewer agent creates evidence, a readable PlanView and an immutable pending proposal without apply", async () => {
    const { h, w, scope, agent, request, run, dispatch } = await setup();
    const queued = await request();
    expect(dispatch).toHaveBeenCalledExactlyOnceWith({ workspaceId: scope.workspaceId, operationId: queued.reviewOperationId });
    expect(w.tofu.planCalls).toHaveLength(0);
    const result = await run(queued.reviewOperationId);
    const detail = await h.broker.getOperationDetail({ workspaceId: scope.workspaceId, operationId: result.operationId, principal: user("erin") });
    expect(detail.operation).toMatchObject({ capability: "infrastructure.destroy", status: "awaiting_approval", principal: { id: agent.id, kind: "integration" }, planDigest: result.planDigest });
    expect(detail.decision?.approval).toMatchObject({ minRole: "admin", count: 1 });
    expect(detail.planReview?.view).toMatchObject({ planDigest: result.planDigest, resources: [{ action: "delete" }], untrustedValues: true });
    expect((await h.store.getPlanEvidence(scope.workspaceId, result.operationId, result.planDigest))?.summary).toMatchObject({ destroy: true, stage: "plan", statefulDeletes: ["aws_s3_bucket.object_store_assets"] });
    expect(w.credentials.sessions[0]).toMatchObject({ purpose: "observe", capability: "infrastructure.plan", revoked: true });
    expect(w.tofu.applyCalls).toHaveLength(0);
    const poll = await getDestroyReview(h.broker, scope, agent, queued.reviewOperationId);
    expect(poll.review).toMatchObject({ operationId: result.operationId, status: "awaiting_approval", planReview: { planDigest: result.planDigest } });
    expect(JSON.stringify(poll)).not.toContain(CANARY_SECRET); expect(JSON.stringify(poll)).not.toContain(CANARY_SESSION_KEY);
  });
  it("reuses an open environment review across different callers and keys", async () => {
    const { h, w, scope, request, run, review } = await setup();
    const first = await review();
    const replayIntent = await request();
    expect(replayIntent.replayed).toBe(true);
    expect(await run(replayIntent.reviewOperationId)).toEqual(first);
    const another = await request("another-intent-002", false, user("carol"));
    expect(await run(another.reviewOperationId)).toEqual({ ...first, replayed: true });
    expect(w.tofu.planCalls).toHaveLength(1);
    expect((await h.store.listOperations(scope.workspaceId, { environmentId: scope.environmentId, capability: "infrastructure.destroy", status: "awaiting_approval" })).items).toHaveLength(1);
  });
  it.each(["changed", "expired", "refresh"])("supersedes a %s review with a recorded reason", async (mode) => {
    const { h, scope, w, review } = await setup();
    const first = await review();
    if (mode === "changed") w.product.base.environment.baseDomain = "changed.zenith.test";
    if (mode === "expired") await h.expireOperation(first.operationId);
    const next = await review("new-intent-002", mode === "refresh");
    expect(next.operationId).not.toBe(first.operationId);
    expect((await h.store.getOperation(scope.workspaceId, first.operationId))?.status).toBe("cancelled");
    const events = await h.store.listEvents(scope.workspaceId, { operationId: first.operationId });
    expect(events.some((e) => e.type === "operation.cancelled" && String(e.data.reason).includes(mode === "changed" ? "inputs changed" : mode === "expired" ? "expired" : "refreshed"))).toBe(true);
    expect(w.tofu.applyCalls).toHaveLength(0);
  });
  it("refuses agent approval, missing/moved digest and viewer approval; browser admin starts the existing destroy workflow", async () => {
    const { h, scope, agent, review, w } = await setup(); const result = await review();
    const op = (await h.store.getOperation(scope.workspaceId, result.operationId))!;
    const decide = (actor = user("erin"), planDigest?: string) => h.broker.approve({ workspaceId: scope.workspaceId, operationId: op.id, proposalDigest: op.proposalDigest,
      planDigest, semanticsDigest: operationPlanReview(op)?.semantics?.digest, approver: actor, session: sessionFor(actor.id) });
    await expect(decide(agent, result.planDigest)).rejects.toMatchObject({ code: "approver_not_human" });
    await expect(decide(user("erin"), undefined)).rejects.toMatchObject({ code: "digest_mismatch" });
    await expect(decide(user("erin"), "b".repeat(64))).rejects.toMatchObject({ code: "digest_mismatch" });
    await expect(decide(user("carol"))).rejects.toMatchObject({ code: "approver_role_insufficient" });
    const startDestroy = vi.fn(async () => undefined);
    setBridgeDepsForTests({ broker: async () => h.broker, workflows: { startDestroy, startDeploy: async () => undefined,
      signalApproval: async () => ({ delivered: true }), cancelOperation: async () => ({ delivered: true }) } });
    const approved = await decide(user("erin"), result.planDigest);
    expect(await deliverPlanApproval(approved.operation)).toEqual({ delivered: true });
    expect(startDestroy).toHaveBeenCalledExactlyOnceWith({ workspaceId: scope.workspaceId, environmentId: scope.environmentId, operationId: op.id });
    expect((await h.store.getOperation(scope.workspaceId, op.id))?.status).toBe("running");
    expect(await h.db!.query("select capability from platform.capability_grants where workspace_id=$1 and operation_id=$2", [scope.workspaceId, op.id])).toEqual([{ capability: "infrastructure.plan" }]);
    expect((await h.store.listApprovals(scope.workspaceId, op.id))[0].consumedAt).toBeDefined();
    expect(w.tofu.applyCalls).toHaveLength(0);
  });
  it("revoked plan access prevents human approval of the delegated review", async () => {
    const { h, scope, agent, review } = await setup(); const result = await review();
    const op = (await h.store.getOperation(scope.workspaceId, result.operationId))!;
    h.world.integrations.get(`${scope.workspaceId}|${agent.id}`)!.scopes = [];
    await expect(h.broker.approve({ workspaceId: scope.workspaceId, operationId: op.id, proposalDigest: op.proposalDigest, planDigest: result.planDigest, semanticsDigest: operationPlanReview(op)?.semantics?.digest,
      approver: user("erin"), session: sessionFor("erin") })).rejects.toMatchObject({ code: "policy_denied" });
  });
  it("does not replace or cancel a teardown approved at the cancellation boundary", async () => {
    const { h, scope, review, w } = await setup(); const first = await review();
    const op = (await h.store.getOperation(scope.workspaceId, first.operationId))!;
    const original = h.store.cancelOperation.bind(h.store);
    let approved: typeof op | null = null;
    let events: Awaited<ReturnType<typeof h.store.listEvents>> = [];
    const jti = `race_${op.id}`;
    const cancel = vi.spyOn(h.store, "cancelOperation").mockImplementation(async (input) => {
      if (input.id === op.id) {
        expect(input.expectedStatus).toBe("awaiting_approval");
        await h.broker.approve({ workspaceId: scope.workspaceId, operationId: op.id, proposalDigest: op.proposalDigest, planDigest: first.planDigest, semanticsDigest: operationPlanReview(op)?.semantics?.digest,
          approver: user("erin"), session: sessionFor("erin") });
        approved = await h.store.getOperation(scope.workspaceId, op.id);
        events = await h.store.listEvents(scope.workspaceId, { operationId: op.id });
        // A review can retain planning authority before a held provider attempt exists.
        await h.store.insertGrant({ jti, workspaceId: scope.workspaceId, operationId: op.id, capability: "infrastructure.plan", audience: "worker",
          issuedAt: h.clock.now().toISOString(), expiresAt: new Date(h.clock.now().getTime() + 60_000).toISOString() });
      }
      return original(input);
    });
    await expect(review("approval-race-intent", true)).rejects.toMatchObject({ code: "conflict" });
    expect(cancel).toHaveBeenCalledOnce();
    expect(await h.store.getOperation(scope.workspaceId, op.id)).toEqual(approved);
    expect(await h.store.listEvents(scope.workspaceId, { operationId: op.id })).toEqual(events);
    expect((await h.store.listApprovals(scope.workspaceId, op.id))).toHaveLength(1);
    expect(await h.db!.query("select capability from platform.capability_grants where workspace_id=$1 and operation_id=$2", [scope.workspaceId, op.id])).toEqual([{ capability: "infrastructure.plan" }]);
    expect(await h.store.consumeGrant({ workspaceId: scope.workspaceId, jti })).toBe(true);
    expect((await h.store.listOperations(scope.workspaceId, { capability: "infrastructure.destroy" })).items).toHaveLength(1);
    expect(w.tofu.applyCalls).toHaveLength(0);
  });
  it("the memory ledger also stops replacement when approval wins at cancellation", async () => {
    const h = await makeHarness({ kind: "memory" }); const w = createWorld(); worlds.push(w);
    const scope = { workspaceId: h.ids.wsA, projectId: h.ids.projA, environmentId: h.ids.envASbx };
    w.product.base.environment.id = scope.environmentId;
    vi.spyOn(w.product, "loadContext").mockImplementation(async () => ({ ...structuredClone(w.product.base), revision: structuredClone(w.product.revisions.get(REVISION)!) }));
    const pending = (await h.store.createOperation({ id: "memory-destroy-review", decisionId: "memory-review-policy", workspaceId: scope.workspaceId,
      principal: user("bob"), proposal: { capability: "infrastructure.destroy", scope, input: {}, summary: "Recorded destroy review", details: [], risk: "high" },
      decision: { policyVersion: "v1", inputDigest: "a".repeat(64), outcome: "require_approval", reasons: [], approval: { count: 1, minRole: "admin", separationOfDuties: false } },
      requestHash: "memory-review", correlationId: "memory-review", ttlMs: 60_000 })).operation;
    setDestroyReviewDispatcherForTests(async () => undefined);
    const requested = await requestDestroyReview(h.broker, scope, user("carol"), { idempotencyKey: "memory-review-refresh", refresh: true });
    const plan = makePlan({ changes: [change({ address: "aws_s3_bucket.object_store_assets", type: "aws_s3_bucket", action: "delete", destroysData: false })] });
    const facts = extractPlanFacts(plan);
    const summary = { ...planEvidence({ plan, facts, cost: {}, graphDigest: "b".repeat(64), stage: "plan" }).summary,
      destroy: true, destroyAddresses: plan.resourceChanges.map((r) => r.address), statefulDeletes: facts.destroyedStatefulAddresses };
    // Memory has no execution evidence repository. This explicit fake represents
    // the source plan's evidence, while the operation/approval/grant ledger is real.
    const get = h.store.getOperation.bind(h.store);
    vi.spyOn(h.store, "getOperation").mockImplementation(async (workspaceId, id) => {
      const op = await get(workspaceId, id);
      return op && id === requested.reviewOperationId ? { ...op, planDigest: plan.planDigest } : op;
    });
    vi.spyOn(h.store, "getPlanEvidence").mockImplementation(async (workspaceId, operationId, planDigest) =>
      workspaceId === scope.workspaceId && operationId === requested.reviewOperationId && planDigest === plan.planDigest
        ? { id: "memory-plan-evidence", workspaceId, operationId, kind: "tofu_plan", digest: planDigest, summary, simulated: false, createdAt: h.clock.now().toISOString() } : null);
    const acquire = w.leases.acquire.bind(w.leases);
    vi.spyOn(w.leases, "acquire").mockImplementation(async (input) => { await h.acquireLease(scope.environmentId); return acquire(input); });
    const cancel = h.store.cancelOperation.bind(h.store);
    let approved: typeof pending | null = null;
    let events: Awaited<ReturnType<typeof h.store.listEvents>> = [];
    vi.spyOn(h.store, "cancelOperation").mockImplementation(async (input) => {
      expect(input.id).toBe(pending.id); expect(input.expectedStatus).toBe("awaiting_approval");
      await h.store.recordApproval({ workspaceId: scope.workspaceId, operationId: pending.id, approver: user("erin"), approverRole: "admin",
        decision: "approve", proposalDigest: pending.proposalDigest, policyVersion: "v1" });
      approved = await get(scope.workspaceId, pending.id); events = await h.store.listEvents(scope.workspaceId, { operationId: pending.id });
      await h.store.insertGrant({ jti: "memory-review-race-grant", workspaceId: scope.workspaceId, operationId: pending.id, capability: "infrastructure.destroy", audience: "worker",
        issuedAt: h.clock.now().toISOString(), expiresAt: new Date(h.clock.now().getTime() + 60_000).toISOString() });
      return cancel(input);
    });
    const propose = vi.spyOn(h.broker, "propose");
    const planner = vi.fn(async () => toPlanSummary(plan, facts, {}));
    await expect(runDestroyReview(createRuntime({ ...w.deps, clock: () => h.clock.now() }), h.broker,
      { workspaceId: scope.workspaceId, operationId: requested.reviewOperationId }, planner)).rejects.toMatchObject({ code: "conflict" });
    expect(planner).toHaveBeenCalledOnce(); expect(propose).not.toHaveBeenCalled();
    expect(await get(scope.workspaceId, pending.id)).toEqual(approved);
    expect(await h.store.listEvents(scope.workspaceId, { operationId: pending.id })).toEqual(events);
    expect(await h.store.listApprovals(scope.workspaceId, pending.id)).toHaveLength(1);
    expect(await h.store.consumeGrant({ workspaceId: scope.workspaceId, jti: "memory-review-race-grant" })).toBe(true);
    expect((await h.store.listOperations(scope.workspaceId, { capability: "infrastructure.destroy" })).items).toHaveLength(1);
    expect(w.tofu.applyCalls).toHaveLength(0);
  });
  it("consolidates pre-existing duplicate pending reviews with recorded reasons", async () => {
    const { h, scope, agent, review, w } = await setup(); const first = await review();
    const op = (await h.store.getOperation(scope.workspaceId, first.operationId))!;
    const proposal = op.proposal as import("@/lib/capabilities/types").BrokerProposal;
    const duplicate = await h.broker.propose({ capability: "infrastructure.destroy", scope, input: proposal.input, idempotencyKey: "legacy-duplicate-review" }, agent,
      { via: "workflow", teardownReview: true, destroyPlan: { operationId: proposal.broker!.destroyPlan!.operationId, planDigest: first.planDigest } });
    const next = await review("consolidate-intent");
    expect(next.operationId).not.toBe(first.operationId);
    for (const id of [first.operationId, duplicate.operation.id]) {
      expect((await h.store.getOperation(scope.workspaceId, id))?.status).toBe("cancelled");
      expect((await h.store.listEvents(scope.workspaceId, { operationId: id })).some((e) => String(e.data.reason).includes("consolidated"))).toBe(true);
    }
    expect((await h.store.listOperations(scope.workspaceId, { capability: "infrastructure.destroy", status: "awaiting_approval" })).items).toHaveLength(1);
    expect(w.tofu.applyCalls).toHaveLength(0);
  });
  it("refuses a busy lease and concurrent request without another open proposal", async () => {
    const { h, scope, rt, request, run, w } = await setup();
    const a = await request(), b = await request("concurrent-intent");
    let release!: () => void;
    const wait = new Promise<void>((resolve) => { release = resolve; });
    const original = w.tofu.planWorkspace.bind(w.tofu);
    vi.spyOn(w.tofu, "planWorkspace").mockImplementation(async (...args) => { await wait; return original(...args); });
    const first = run(a.reviewOperationId);
    // Wait for the first worker to have entered the provider callback.
    await vi.waitFor(() => expect(w.credentials.sessions).toHaveLength(1));
    await expect(run(b.reviewOperationId)).rejects.toMatchObject({ code: "conflict" });
    release(); await first;
    expect((await h.store.listOperations(scope.workspaceId, { capability: "infrastructure.destroy", status: "awaiting_approval" })).items).toHaveLength(1);
    expect(await rt.d.leases.acquire({ scope: `env:${scope.environmentId}`, holder: "test-after", ttlMs: 1000, workspaceId: scope.workspaceId })).toBeTruthy();
    expect(w.tofu.applyCalls).toHaveLength(0);
  });
  it("records a product refusal's reason on the failed review, never a provider's raw text", async () => {
    const { h, scope, request, run, w } = await setup();
    const refused = await request("refused-intent");
    vi.spyOn(w.tofu, "planWorkspace").mockRejectedValueOnce(new StepFailedError("The provider could not completely review teardown; skipped or uncertain objects require investigation."));
    await expect(run(refused.reviewOperationId)).rejects.toBeTruthy();
    expect((await h.store.getOperation(scope.workspaceId, refused.reviewOperationId))?.error).toBe("Teardown review did not complete. Nothing was applied. The provider could not completely review teardown; skipped or uncertain objects require investigation.");
    const raw = await request("raw-intent");
    vi.spyOn(w.tofu, "planWorkspace").mockRejectedValueOnce(new Error("provider said token=" + CANARY_SECRET));
    await expect(run(raw.reviewOperationId)).rejects.toBeTruthy();
    expect((await h.store.getOperation(scope.workspaceId, raw.reviewOperationId))?.error).toBe("Teardown review did not complete. Nothing was applied.");
  });
  it("refuses foreign scope, no plan scope and injected approval/plan fields before dispatch", async () => {
    const { h, scope, agent, dispatch } = await setup();
    await expect(requestDestroyReview(h.broker, { ...scope, workspaceId: h.ids.wsB }, agent, { idempotencyKey: "foreign-intent" })).rejects.toMatchObject({ code: "not_found" });
    h.world.integrations.get(`${scope.workspaceId}|${agent.id}`)!.scopes = ["read"];
    await expect(requestDestroyReview(h.broker, scope, agent, { idempotencyKey: "no-plan-intent" })).rejects.toMatchObject({ code: "policy_denied" });
    await expect(requestDestroyReview(h.broker, scope, agent, { idempotencyKey: "injected-intent", approved: true, planDigest: "a".repeat(64) })).rejects.toMatchObject({ code: "invalid_request" });
    expect(dispatch).not.toHaveBeenCalled();
  });
  it.each(["active", "connection", "unmapped", "changed-during-plan"])("refuses %s planning without a teardown proposal", async (mode) => {
    const { h, scope, request, run, w } = await setup();
    if (mode === "active") w.product.base.environment.activeDeploymentId = "busy";
    if (mode === "connection") vi.mocked(w.connections.resolve).mockResolvedValue(null);
    if (mode === "unmapped") w.tofu.planFactory = () => makePlan({ changes: [change({ address: "terraform_data.foreign", type: "terraform_data", action: "delete" })] });
    if (mode === "changed-during-plan") { const before = w.tofu.planFactory; w.tofu.planFactory = (ws, n) => { w.product.base.environment.region = "us-west-2"; return before(ws, n); }; }
    const queued = await request();
    await expect(run(queued.reviewOperationId)).rejects.toBeDefined();
    expect((await h.store.listOperations(scope.workspaceId, { capability: "infrastructure.destroy" })).items).toHaveLength(0);
    expect(w.tofu.applyCalls).toHaveLength(0);
  });
  it("a missing PlanView refuses approval even through the browser broker endpoint", async () => {
    const { h, scope, review } = await setup(); const result = await review();
    const op = (await h.store.getOperation(scope.workspaceId, result.operationId))!;
    await h.db!.query("delete from platform.evidence where workspace_id = $1 and operation_id = $2", [scope.workspaceId, op.id]);
    await expect(h.broker.approve({ workspaceId: scope.workspaceId, operationId: op.id, proposalDigest: op.proposalDigest, planDigest: result.planDigest, semanticsDigest: operationPlanReview(op)?.semantics?.digest,
      approver: user("erin"), session: sessionFor("erin") })).rejects.toMatchObject({ code: "digest_mismatch" });
  });
  it("records a valid source destroy plan and refuses to supersede an approved teardown", async () => {
    const { h, scope, review } = await setup(); const result = await review();
    const op = (await h.store.getOperation(scope.workspaceId, result.operationId))!;
    expect(await loadDestroyPlan(h.deps, scope, { operationId: result.operationId, planDigest: result.planDigest })).toMatchObject({ facts: { delete: 1 } });
    await h.broker.approve({ workspaceId: scope.workspaceId, operationId: op.id, proposalDigest: op.proposalDigest, planDigest: result.planDigest, semanticsDigest: operationPlanReview(op)?.semantics?.digest,
      approver: user("erin"), session: sessionFor("erin") });
    await expect(review("refresh-approved", true)).rejects.toMatchObject({ code: "conflict" });
  });
});

describe.skipIf(!PG_URL)("real Postgres destroy-review lane", () => {
  it("persists the first pending review with a readable PlanView", async () => {
    const { h, scope, review } = await setup("postgres"); const result = await review();
    expect((await h.broker.getOperationDetail({ workspaceId: scope.workspaceId, operationId: result.operationId, principal: user("erin") })).planReview?.planDigest).toBe(result.planDigest);
  });
});


/** Current-record guard on a partially decided proposal; these fixtures perform no OpenTofu/provider calls. */
import { seedAwaitingApproval } from "../controlplane/_support/harness";
import { repos } from "@/lib/controlplane/db";
function supersessionBarrier(){let release!:()=>void;const promise=new Promise<void>(resolve=>{release=resolve;});return {release,promise};}
describe.skipIf(!PG_URL)("undecided teardown supersession [postgres]",()=>{
  it("an independent partial approval wins the operation lock and prevents refresh cancellation without revoking grants",async()=>{
    const h=await makeHarness({kind:"postgres"});
    const seeded=await seedAwaitingApproval(h.db!,{workspaceId:h.ids.wsA,count:2,minRole:"admin",proposal:{capability:"infrastructure.destroy"}});
    const op=seeded.operation;const entered=supersessionBarrier(),release=supersessionBarrier();
    const jti=`partial_grant_${op.id}`;await h.store.insertGrant({jti,workspaceId:op.workspaceId,operationId:op.id,capability:"infrastructure.plan",audience:"worker",issuedAt:new Date().toISOString(),expiresAt:new Date(Date.now()+60000).toISOString()});
    const deciding=h.db!.tx(async tx=>{
      await repos.approvals.record(tx,{workspaceId:op.workspaceId,operationId:op.id,proposalDigest:op.proposalDigest,approver:user("erin"),approverRole:"admin",decision:"approve",policyVersion:seeded.decision.policyVersion});
      entered.release();await release.promise;
    });
    await entered.promise;let finished=false;
    const cancelling=h.store.cancelOperation({workspaceId:op.workspaceId,id:op.id,expectedStatus:"awaiting_approval",requireUndecidedApprovalRound:true,reason:"refresh"}).then(value=>{finished=true;return value;});
    await new Promise(resolve=>setTimeout(resolve,30));expect(finished).toBe(false);
    release.release();await deciding;expect(await cancelling).toBeNull();
    expect((await h.store.getOperation(op.workspaceId,op.id))?.status).toBe("awaiting_approval");
    expect(await h.store.listApprovals(op.workspaceId,op.id)).toHaveLength(1);
    expect(await h.db!.query("select capability from platform.capability_grants where workspace_id=$1 and operation_id=$2",[op.workspaceId,op.id])).toEqual([{capability:"infrastructure.plan"}]);
    expect(await h.store.consumeGrant({workspaceId:op.workspaceId,jti})).toBe(true);
    expect((await h.store.listEvents(op.workspaceId,{operationId:op.id})).some(event=>event.type==="operation.cancelled")).toBe(false);
    // An explicitly requested ordinary cancellation keeps its original behavior.
    expect((await h.store.cancelOperation({workspaceId:op.workspaceId,id:op.id,reason:"user cancellation"}))?.status).toBe("cancelled");
  });
});
describe("undecided teardown supersession [isolated memory]",()=>{
  it("a partial current-record human decision blocks internal refresh while general cancellation remains available",async()=>{
    const h=await makeHarness({kind:"memory",engine:scriptedEngine("memory-partial-review",()=>requireApproval(2,"admin"))});
    const proposal=await h.broker.propose({capability:"deployment.deploy",scope:{workspaceId:h.ids.wsA,projectId:h.ids.projA,environmentId:h.ids.envAProd},input:{}},user("alice"));
    const op=proposal.operation;
    await h.broker.approve({workspaceId:op.workspaceId,operationId:op.id,proposalDigest:op.proposalDigest,approver:user("erin"),session:sessionFor("erin")});
    expect((await h.store.getOperation(op.workspaceId,op.id))?.status).toBe("awaiting_approval");
    const before=await h.store.listEvents(op.workspaceId,{operationId:op.id});
    expect(await h.store.cancelOperation({workspaceId:op.workspaceId,id:op.id,expectedStatus:"awaiting_approval",requireUndecidedApprovalRound:true})).toBeNull();
    expect(await h.store.listEvents(op.workspaceId,{operationId:op.id})).toEqual(before);
    expect((await h.store.cancelOperation({workspaceId:op.workspaceId,id:op.id}))?.status).toBe("cancelled");
  });
});
