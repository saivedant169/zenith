/** Product -> broker -> fake workflow; no cloud/Temporal or live identity calls. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { tempDataDir } from "../_support/data-dir";
import { seed, ctx, ready } from "../bridge/support";
import { makePlan, change } from "../execution/fakes/fixtures";
import { allowDecision, scriptedEngine, sessionFor } from "../capabilities/support";
import { createBroker, setPlatformBrokerForTests, type Broker } from "@/lib/capabilities/platform";
import { setDestroyReviewDispatcherForTests } from "@/lib/capabilities/destroy-review-dispatch";
import { MemoryBrokerStore } from "@/lib/capabilities/memory-store";
import { productRoleResolver, productScopeResolver } from "@/lib/capabilities/product-adapters";
import { systemClock } from "@/lib/capabilities/ports";
import { buildPlanFacts } from "@/lib/capabilities/evaluate";
import { planEvidence } from "@/lib/execution/plan-evidence";
import { bridgeDeps, setBridgeDepsForTests } from "@/lib/bridge/deps";
import { deliverPlanApproval } from "@/lib/bridge/lifecycle";
import { checkActionThroughBroker } from "@/lib/capabilities/action-bridge";
import { cleanupWriterBarriers } from "@/lib/controlplane/db/repos";

tempDataDir("zenith-teardown-", { fast: true });
const { runAction } = await import("@/lib/actions/core");
const { db } = await import("@/lib/db/store");
await import("@/lib/actions/defs/env-teardown");
let broker: Broker;
const startDestroy = vi.fn(async () => undefined);
const signalApproval = vi.fn(async () => ({ delivered: true as const }));
const input = { environmentId: ctx.environmentId! };
beforeEach(async () => {
  seed(); startDestroy.mockReset(); signalApproval.mockClear();
  // The earlier-delivery refusal has its own cases in env-lifecycle; these cover the broker flow on a drained environment.
  vi.spyOn(cleanupWriterBarriers, "preview").mockResolvedValue({ unknownHistory: 0, grants: 0, handoffs: 0, reservations: 0 });
  const store = new MemoryBrokerStore();
  broker = createBroker({ store, scopes: productScopeResolver(), roles: productRoleResolver(), clock: systemClock,
    policy: async () => scriptedEngine("allow", () => allowDecision()), signer: { ready: async () => undefined, sign: async () => "fake-grant-never-returned" } });
  setPlatformBrokerForTests(broker);
  const scope = { workspaceId: ctx.workspaceId, projectId: ctx.projectId, environmentId: ctx.environmentId };
  const plan = makePlan({ changes: [change({ address: "aws_s3_bucket.assets", type: "aws_s3_bucket", action: "delete", destroysData: true })] });
  const facts = buildPlanFacts(plan)!;
  const source = await broker.propose({ capability: "infrastructure.plan", scope }, { kind: "user", id: ctx.actor.id, name: ctx.actor.name }, { plan });
  vi.spyOn(store, "getPlanEvidence").mockImplementation(async () => ({ id: "fixture-evidence", workspaceId: ctx.workspaceId, operationId: source.operation.id, kind: "tofu_plan", digest: plan.planDigest,
    summary: { ...planEvidence({ plan, facts, cost: {}, graphDigest: "a".repeat(64), stage: "plan" }).summary, destroy: true, destroyAddresses: ["object_store/assets"], statefulDeletes: facts.destroyedStatefulAddresses, retained: ["Secret/ns/keep"] }, simulated: false, createdAt: new Date().toISOString() }));
  setBridgeDepsForTests({ broker: async () => broker, readiness: async () => ready, platformConnection: async () => ({ status: "verified" }),
    teardownSession: async (context) => sessionFor(context.actor.id), workflows: { startDestroy, startDeploy: async () => undefined, signalApproval, cancelOperation: async () => ({ delivered: true }) } });
});
afterEach(() => { setBridgeDepsForTests(null); setPlatformBrokerForTests(null); setDestroyReviewDispatcherForTests(undefined); vi.restoreAllMocks(); });

async function proposal() {
  const { result } = await runAction("env.teardown", ctx, input, { mode: "execute" });
  expect(result?.ok).toBe(true);
  const data = result!.data as { operationId: string; proposalDigest: string };
  return (await broker.getOperationDetail({ workspaceId: ctx.workspaceId, operationId: data.operationId, principal: { kind: "user", id: ctx.actor.id, name: ctx.actor.name } })).operation;
}
async function approve(op: Awaited<ReturnType<typeof proposal>>) {
  return broker.approve({ workspaceId: ctx.workspaceId, operationId: op.id, proposalDigest: op.proposalDigest,
    approver: { kind: "user", id: "admin-b", name: "Admin B" }, session: sessionFor("admin-b") });
}

describe("env.teardown", () => {
  it("plans without writes, shows authoritative counts/stateful deletes/retention", async () => {
    const before = await broker.deps.store.listOperations(ctx.workspaceId);
    const { plan } = await runAction("env.teardown", ctx, input, { mode: "plan" });
    expect(plan).toMatchObject({ requiresApproval: true, risk: "high" });
    expect(plan?.blocked).toBeUndefined();
    expect(plan?.details.join(" ")).toContain("1 delete");
    expect(plan?.details.join(" ")).toContain("aws_s3_bucket.assets");
    expect(plan?.details.join(" ")).toContain("Secret/ns/keep");
    expect(await broker.deps.store.listOperations(ctx.workspaceId)).toEqual(before);
    expect(startDestroy).not.toHaveBeenCalled();
  });
  it("proposes without starting, then starts only after browser approval with ids only", async () => {
    const op = await proposal();
    expect(op.status).toBe("awaiting_approval"); expect(startDestroy).not.toHaveBeenCalled();
    const approved = await approve(op);
    expect(await deliverPlanApproval(approved.operation)).toEqual({ delivered: true });
    expect(startDestroy).toHaveBeenCalledExactlyOnceWith({ operationId: op.id, workspaceId: ctx.workspaceId, environmentId: ctx.environmentId });
    expect(JSON.stringify(startDestroy.mock.calls)).not.toContain("fake-grant");
  });
  it("shares concurrent starts and refuses a replay after the claim", async () => {
    const approved = await approve(await proposal());
    const results = await Promise.all([deliverPlanApproval(approved.operation), deliverPlanApproval(approved.operation)]);
    expect(results.every((r) => r?.delivered)).toBe(true);
    expect(startDestroy).toHaveBeenCalledTimes(1);
    expect((await deliverPlanApproval(approved.operation))?.delivered).toBe(false);
    expect(startDestroy).toHaveBeenCalledTimes(1);
  });
  it("marks an unconfirmed workflow start uncertain", async () => {
    const approved = await approve(await proposal());
    startDestroy.mockRejectedValueOnce(new Error("fake transport timeout"));
    expect(await deliverPlanApproval(approved.operation)).toMatchObject({ delivered: false });
    expect((await broker.deps.store.getOperation(ctx.workspaceId, approved.operation.id))?.status).toBe("uncertain");
  });
  it("refuses missing browser proof, foreign environments and unreviewed extra fields", async () => {
    setBridgeDepsForTests({ ...bridgeDeps(), teardownSession: async () => undefined });
    expect((await runAction("env.teardown", ctx, input, { mode: "execute" })).result?.ok).toBe(false);
    expect((await runAction("env.teardown", { ...ctx, workspaceId: "foreign" }, input, { mode: "execute" })).result?.ok).toBe(false);
    expect((await runAction("env.teardown", ctx, { ...input, planDigest: "f".repeat(64) }, { mode: "execute" })).result?.ok).toBe(false);
    expect(startDestroy).not.toHaveBeenCalled();
  });
  it.each(["navigator", "integration"])("refuses %s at the action and agent bridge", async (kind) => {
    const agent = kind === "navigator" ? { ...ctx, actor: { ...ctx.actor, type: "navigator" as const }, autonomy: "autonomous" as const } :
      { ...ctx, integration: { clientId: "integration", operationId: "op", proposalDigest: "a".repeat(64) } };
    expect((await checkActionThroughBroker(broker.deps, agent, "env.teardown", input, { persist: true })).kind).toBe("deny");
    expect((await runAction("env.teardown", agent, input, { mode: "execute" })).result?.ok).toBe(false);
    expect(startDestroy).not.toHaveBeenCalled();
  });
  it("blocks while a deployment is active", async () => {
    db().deployments.push({ id: "busy", projectId: ctx.projectId!, environmentId: ctx.environmentId!, revisionId: "bridge-r1", status: "applying", steps: [], outputs: [], actor: ctx.actor, changeSummary: "busy", estCostDeltaUsd: 0, createdAt: new Date().toISOString() });
    expect((await runAction("env.teardown", ctx, input, { mode: "plan" })).plan?.blocked).toContain("active deployment");
    expect((await runAction("env.teardown", ctx, input, { mode: "execute" })).result?.ok).toBe(false);
  });
});

describe("env.reviewTeardown", () => {
  it("a viewer can plan and request a read-only worker review without proposing a mutation", async () => {
    const viewer = { ...ctx, actor: { type: "user" as const, id: "viewer", name: "Viewer" } };
    const dispatch = vi.fn(async () => undefined); setDestroyReviewDispatcherForTests(dispatch);
    const reviewInput = { ...input, idempotencyKey: "browser-review-001" };
    const before = (await broker.deps.store.listOperations(ctx.workspaceId)).items.length;
    expect((await runAction("env.reviewTeardown", viewer, reviewInput, { mode: "plan" })).plan).toMatchObject({ risk: "low", requiresApproval: false });
    expect((await broker.deps.store.listOperations(ctx.workspaceId)).items).toHaveLength(before);
    const executed = await runAction("env.reviewTeardown", viewer, reviewInput, { mode: "execute" });
    expect(executed.result?.ok).toBe(true); expect(dispatch).toHaveBeenCalledTimes(1);
    expect((await broker.deps.store.listOperations(ctx.workspaceId, { capability: "infrastructure.destroy" })).items).toHaveLength(0);
    expect(startDestroy).not.toHaveBeenCalled();
  });
  it("refuses active deployment and approval fields before worker dispatch", async () => {
    const dispatch = vi.fn(async () => undefined); setDestroyReviewDispatcherForTests(dispatch);
    expect((await runAction("env.reviewTeardown", ctx, { ...input, idempotencyKey: "browser-review-001", approved: true }, { mode: "execute" })).result?.ok).toBe(false);
    db().deployments.push({ id: "busy", projectId: ctx.projectId!, environmentId: ctx.environmentId!, revisionId: "bridge-r1", status: "applying", steps: [], outputs: [], actor: ctx.actor, changeSummary: "busy", estCostDeltaUsd: 0, createdAt: new Date().toISOString() });
    expect((await runAction("env.reviewTeardown", ctx, { ...input, idempotencyKey: "browser-review-002" }, { mode: "execute" })).result?.ok).toBe(false);
    expect(dispatch).not.toHaveBeenCalled();
  });
  it("the legacy browser path refuses another proposal while a first review is still pending", async () => {
    setDestroyReviewDispatcherForTests(async () => undefined);
    expect((await runAction("env.reviewTeardown", ctx, { ...input, idempotencyKey: "pending-review-001" }, { mode: "execute" })).result?.ok).toBe(true);
    expect((await runAction("env.teardown", ctx, input, { mode: "execute" })).result).toMatchObject({ ok: false, error: expect.stringContaining("current teardown review") });
    expect((await broker.deps.store.listOperations(ctx.workspaceId, { capability: "infrastructure.destroy" })).items).toHaveLength(0);
  });
});
