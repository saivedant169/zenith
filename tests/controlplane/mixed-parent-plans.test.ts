/**
 * PROD-MIX-01 / PROD-MIX-02 over the platform database: the immutable parent plan and
 * child subplans, the address registry, write-once child binding, the parent
 * approval gate, dependency-ordered advancement, durable receipts and the database
 * triggers that make all of it tamper-evident. Real platform SQL on PGlite always and
 * on real PostgreSQL when ZENITH_TEST_PLATFORM_PG_URL is set (the same lanes as the
 * other platform suites). The product store, the child launcher and the semantics
 * store are fakes, labelled as such; the cloud is never reached.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as plans from "@/lib/controlplane/db/repos/mixed-parent-plans";
import type { Sql } from "@/lib/controlplane/types";
import { digest } from "@/lib/controlplane/digest";
import { admitMixedGraph } from "@/lib/execution/mixed/admission";
import { parentProposalInput } from "@/lib/execution/mixed/parent-plan";
import { settleOutcome } from "@/lib/execution/mixed/settle";
import {
  adoptChildOperation, advanceChild, beginParent, observeChild, planMixed, settleParent, verifyParent,
  type ChildLauncher, type MixedDeps,
} from "@/lib/execution/mixed/service";
import { MixedPlanError, type MixedParentPlan, type MixedPlanErrorCode } from "@/lib/execution/mixed/types";
import type { MixedWorld } from "@/lib/execution/mixed/world";
import type { DeclaredReference } from "@/lib/execution/mixed/parent-plan";
import type { PartitionPin } from "@/lib/execution/mixed/partitioner";
import { finalizeGraph, GraphBuilder } from "@/lib/resources/expand-support";
import type { ResourceGraph } from "@/lib/resources/types";
import type { SemanticsStore } from "@/lib/execution/semantics/store";
import type { DeployWorkflowInput } from "@/lib/workflows/types";
import type { ProviderConnection } from "@/lib/credentials/types";
import { LANES, approve, expectCode, openLane, seedApprovedOperation, seedAwaitingApproval, user, uid } from "./_support/harness";
import { PARENT_ENV, PROJECT, connection, fixtureConnectivity, mixedGraph, refresh } from "../execution/mixed/_fixtures";

const ENVIRONMENTS = ["env-azure", "env-gcp", "env-aws"] as const;
const PROVIDER_OF: Record<string, "azure" | "gcp" | "aws"> = { "env-azure": "azure", "env-gcp": "gcp", "env-aws": "aws" };
const SEMANTICS = "9".repeat(64);

async function refusal(promise: Promise<unknown>, code: MixedPlanErrorCode): Promise<MixedPlanError> {
  let failure: unknown;
  try { await promise; } catch (error) { failure = error; }
  expect(failure).toBeInstanceOf(MixedPlanError);
  expect((failure as MixedPlanError).code).toBe(code);
  return failure as MixedPlanError;
}

/** Two AWS functions in one region; b depends on a and reads a's queue through a typed reference. */
function awsPairGraph(): ResourceGraph {
  const b = new GraphBuilder(PARENT_ENV);
  b.add({ address: "service/a", kind: "function", place: { provider: "aws", region: "us-east-1" }, spec: { n: 1 }, origin: ["a"] });
  b.add({ address: "service/b", kind: "function", place: { provider: "aws", region: "us-east-1" }, spec: { n: 2 }, origin: ["b"], dependsOn: ["service/a"] });
  return finalizeGraph(b, PARENT_ENV, digest("manifest-aws-pair-plan"));
}
const PAIR_PINS: PartitionPin[] = [{ address: "service/a", childEnvironmentId: "env-aws-1" }, { address: "service/b", childEnvironmentId: "env-aws-2" }];
const PAIR_REFERENCE: DeclaredReference = { id: "ref-queue", producer: { address: "service/a", output: "queueArn", type: "resource_id" }, consumer: { address: "service/b", input: "queueArn", type: "resource_id" } };
const pairWorld = (conns: Record<string, ProviderConnection>): MixedWorld => ({
  parentGraph: async () => ({ projectId: PROJECT, graph: awsPairGraph() }), childEnvironment: async (_w, env) => ({ projectId: PROJECT, connection: conns[env]! }),
  childGraph: async () => awsPairGraph(), childStartInput: async () => { throw new Error("unused"); }, connections: async () => new Map(),
});
/** Same provider, another AWS account: a different connection, so a different trust boundary. */
function otherAwsAccount(workspaceId: string): ProviderConnection {
  const base = connection("aws", { id: "conn-aws-other", workspaceId });
  const other = "210987654321";
  return { ...base, config: { ...base.config, accountId: other, observeRoleArn: `arn:aws:iam::${other}:role/observe`, deployRoleArn: `arn:aws:iam::${other}:role/deploy` } as ProviderConnection["config"] };
}

class FakeLauncher implements ChildLauncher {
  claims: string[] = [];
  starts: DeployWorkflowInput[] = [];
  failStart = false;
  constructor(private readonly db: Sql) {}
  async claim(workspaceId: string, operationId: string): Promise<"claimed" | "already_claimed"> {
    const rows = await this.db.query(
      `update platform.operations set status = 'running', lease_holder = $3, lease_until = clock_timestamp() + interval '5 minutes', started_at = clock_timestamp()
        where workspace_id = $1 and id = $2 and status in ('approved','queued') returning id`, [workspaceId, operationId, `workflow:${operationId}`]);
    if (!rows.length) return "already_claimed";
    this.claims.push(operationId);
    return "claimed";
  }
  async start(input: DeployWorkflowInput): Promise<void> {
    if (this.failStart) throw new Error("start unconfirmed");
    this.starts.push(input);
  }
}

describe.each(LANES)("mixed parent and child plans [$name]", (lane) => {
  let ctx: Awaited<ReturnType<typeof openLane>>;
  beforeAll(async () => { ctx = await openLane(lane); }, 60_000);
  afterAll(async () => { await ctx.close(); });
  const db = () => ctx.db;

  interface Scenario {
    ws: string;
    deps: MixedDeps;
    launcher: FakeLauncher;
    conns: Record<string, ProviderConnection>;
    graphFor: (env: string) => ReturnType<typeof mixedGraph>;
    plan: MixedParentPlan;
    parentOperationId: string;
    childOperations: Record<string, string>;
    semantics: { value: string | undefined };
  }

  /** A planned, approved, claimed parent with every child's operation adopted. `stage` stops early for the tests that need an earlier state. */
  async function scenario(stage: "planned" | "attached" | "approved" | "adopted" | "running" = "running"): Promise<Scenario> {
    const ws = uid("ws");
    const conns: Record<string, ProviderConnection> = {};
    for (const env of ENVIRONMENTS) conns[env] = connection(PROVIDER_OF[env], { workspaceId: ws });
    const graphFor = (env: string) => { const graph = mixedGraph(); graph.nodes = graph.nodes.filter((node) => node.provider === PROVIDER_OF[env]); refresh(graph); return graph; };
    const semantics = { value: SEMANTICS as string | undefined };
    const world: MixedWorld = {
      parentGraph: async () => ({ projectId: PROJECT, graph: mixedGraph() }),
      childEnvironment: async (_ws, env) => ({ projectId: PROJECT, connection: conns[env] }),
      childGraph: async (_ws, env) => graphFor(env),
      childStartInput: async (workspaceId, op) => ({ operationId: op.id, workspaceId, projectId: op.projectId, environmentId: op.environmentId, revisionId: `rev-${op.environmentId}`, deploymentId: `dep-${op.id}`, connectionId: "product-connection", preApproved: true, build: false }),
      connections: async (_ws, ids) => new Map(ids.map((id) => [id, Object.values(conns).find((c) => c.id === id) ?? null])),
    };
    const store = { get: async (workspaceId: string, operationId: string, planDigest: string) => (semantics.value ? { workspaceId, operationId, planDigest, semantics: { digest: semantics.value }, createdAt: new Date().toISOString() } : null), record: async () => { throw new Error("fake store is read-only"); } } as unknown as SemanticsStore;
    const deps: MixedDeps = { sql: db(), world, semantics: store };
    const launcher = new FakeLauncher(db());
    const planned = await planMixed(deps, { workspaceId: ws, parentEnvironmentId: PARENT_ENV, childEnvironmentIds: [...ENVIRONMENTS], createdBy: "user-planner", connectivity: fixtureConnectivity({ workspaceId: ws, projectId: PROJECT, parentEnvironmentId: PARENT_ENV, graph: mixedGraph(), candidates: ENVIRONMENTS.map(env => ({childEnvironmentId: env, connection: conns[env]})) }) });
    const base = { ws, deps, launcher, conns, graphFor, plan: planned.stored.plan, parentOperationId: "", childOperations: {} as Record<string, string>, semantics };
    if (stage === "planned") return base;
    const seeded = await seedAwaitingApproval(db(), { workspaceId: ws, proposal: { capability: "deployment.deploy", scope: { workspaceId: ws, projectId: PROJECT, environmentId: PARENT_ENV }, input: parentProposalInput(planned.stored.plan) } });
    base.parentOperationId = seeded.operation.id;
    await plans.attachParentOperation(db(), { workspaceId: ws, planId: base.plan.parentPlanId, operationId: seeded.operation.id });
    if (stage === "attached") return base;
    await approve(db(), seeded);
    for (const child of base.plan.children) {
      const op = await seedApprovedOperation(db(), ws, { proposal: { capability: "deployment.deploy", scope: { workspaceId: ws, projectId: PROJECT, environmentId: child.childEnvironmentId }, input: { revisionId: `rev-${child.childEnvironmentId}`, deploymentId: `dep-${child.childEnvironmentId}` } } });
      base.childOperations[child.partitionId] = op.operation.id;
    }
    if (stage === "approved") return base;
    for (const child of base.plan.children) await adoptChildOperation(deps, { workspaceId: ws, planId: base.plan.parentPlanId, partitionId: child.partitionId, operationId: base.childOperations[child.partitionId] });
    if (stage === "adopted") return base;
    await db().query("update platform.operations set status = 'running', lease_holder = 'workflow:parent', lease_until = clock_timestamp() + interval '5 minutes', started_at = clock_timestamp() where workspace_id = $1 and id = $2", [ws, base.parentOperationId]);
    await beginParent(deps, { workspaceId: ws, planId: base.plan.parentPlanId });
    return base;
  }

  const finishChild = async (s: Scenario, partitionId: string, status: "succeeded" | "failed" | "cancelled" | "uncertain", planDigest = "a".repeat(64)) => {
    await db().query("update platform.operations set status = $3, plan_digest = $4, finished_at = clock_timestamp(), lease_holder = null, lease_until = null where workspace_id = $1 and id = $2",
      [s.ws, s.childOperations[partitionId], status, planDigest]);
  };
  const advance = (s: Scenario, partitionId: string) => advanceChild(s.deps, s.launcher, { workspaceId: s.ws, operationId: s.parentOperationId, planId: s.plan.parentPlanId, partitionId });
  const first = (s: Scenario) => s.plan.children[0].partitionId;

  describe("the immutable parent plan (MIX-02)", () => {
    it("stores the ordered child subplans once, with the address registry, and is idempotent", async () => {
      const s = await scenario("planned");
      const stored = await plans.getPlan(db(), s.ws, s.plan.parentPlanId);
      expect(stored).toMatchObject({ status: "planned", version: 1, createdBy: "user-planner" });
      expect(stored!.plan).toEqual(JSON.parse(JSON.stringify(s.plan)));
      expect((await plans.getAddresses(db(), s.ws, s.plan.parentPlanId)).map((entry) => entry.stableAddress)).toEqual(s.plan.addresses.map((entry) => entry.stableAddress));
      const children = await plans.listChildren(db(), s.ws, s.plan.parentPlanId);
      expect(children.map((child) => [child.ordinal, child.state])).toEqual([[0, "pending"], [1, "pending"], [2, "pending"]]);
      const again = await planMixed(s.deps, { workspaceId: s.ws, parentEnvironmentId: PARENT_ENV, childEnvironmentIds: [...ENVIRONMENTS], createdBy: "user-planner", connectivity: s.plan.connectivity!.declaration });
      expect(again.created).toBe(false);
      expect(again.stored.plan.parentPlanId).toBe(s.plan.parentPlanId);
      expect(again.proposalInput).toEqual(parentProposalInput(s.plan));
    });

    it("refuses undeclared protected connectivity before persisting a plan", async () => {
      const s = await scenario("planned");
      const failure = await refusal(planMixed(s.deps, {workspaceId:s.ws,parentEnvironmentId:PARENT_ENV,childEnvironmentIds:[...ENVIRONMENTS],createdBy:"user-planner"}), "plan_refused");
      expect(failure.detail).toMatchObject({code:"missing_connectivity"});
      expect((await plans.listPlansForEnvironment(db(),s.ws,PARENT_ENV)).map(p => p.plan.parentPlanId)).toEqual([s.plan.parentPlanId]);
    });

    it("plans one AWS connection split over two child environments with a typed reference and no declaration (one trust boundary)", async () => {
      const ws = uid("ws");
      const aws = connection("aws", { workspaceId: ws });
      const planned = await planMixed({ sql: db(), world: pairWorld({ "env-aws-1": aws, "env-aws-2": aws }) }, {
        workspaceId: ws, parentEnvironmentId: PARENT_ENV, childEnvironmentIds: ["env-aws-1", "env-aws-2"], pins: PAIR_PINS, references: [PAIR_REFERENCE], createdBy: "user-planner",
      });
      expect(planned.created).toBe(true);
      expect(planned.stored.plan.connectivity).toBeUndefined();
      expect(planned.stored.plan.children.map((child) => child.authority.connectionId)).toEqual(["conn-aws", "conn-aws"]);
      expect(planned.stored.plan.references).toHaveLength(1);
      expect((await plans.listPlansForEnvironment(db(), ws, PARENT_ENV)).map((p) => p.plan.parentPlanId)).toEqual([planned.stored.plan.parentPlanId]);
    });

    it("still refuses the same provider on a different connection without a declaration, and stores nothing", async () => {
      const ws = uid("ws");
      const failure = await refusal(planMixed({ sql: db(), world: pairWorld({ "env-aws-1": connection("aws", { workspaceId: ws }), "env-aws-2": otherAwsAccount(ws) }) }, {
        workspaceId: ws, parentEnvironmentId: PARENT_ENV, childEnvironmentIds: ["env-aws-1", "env-aws-2"], pins: PAIR_PINS, references: [PAIR_REFERENCE], createdBy: "user-planner",
      }), "plan_refused");
      expect(failure.detail).toMatchObject({ code: "missing_connectivity" });
      expect(await plans.listPlansForEnvironment(db(), ws, PARENT_ENV)).toEqual([]);
    });

    it("refuses to plan when a partition has no verified connection, and stores nothing", async () => {
      const ws = uid("ws");
      const conns = { "env-azure": connection("azure", { workspaceId: ws }), "env-gcp": connection("gcp", { workspaceId: ws, status: "revoked" }), "env-aws": connection("aws", { workspaceId: ws }) } as Record<string, ProviderConnection>;
      const world: MixedWorld = {
        parentGraph: async () => ({ projectId: PROJECT, graph: mixedGraph() }), childEnvironment: async (_w, env) => ({ projectId: PROJECT, connection: conns[env] }),
        childGraph: async () => mixedGraph(), childStartInput: async () => { throw new Error("unused"); }, connections: async () => new Map(),
      };
      await refusal(planMixed({ sql: db(), world }, { workspaceId: ws, parentEnvironmentId: PARENT_ENV, childEnvironmentIds: [...ENVIRONMENTS], createdBy: "user-planner" }), "connection_unverified");
      expect(await plans.listPlansForEnvironment(db(), ws, PARENT_ENV)).toEqual([]);
    });

    it("refuses a child in another project and a parent listed as its own child", async () => {
      const s = await scenario("planned");
      const other: MixedWorld = { ...s.deps.world, childEnvironment: async (_w, env) => ({ projectId: "other-project", connection: s.conns[env] }) };
      await refusal(planMixed({ sql: db(), world: other }, { workspaceId: s.ws, parentEnvironmentId: PARENT_ENV, childEnvironmentIds: [...ENVIRONMENTS], createdBy: "user-planner" }), "child_mismatch");
      await refusal(planMixed(s.deps, { workspaceId: s.ws, parentEnvironmentId: PARENT_ENV, childEnvironmentIds: [PARENT_ENV, "env-aws"], createdBy: "user-planner" }), "invalid_input");
      await refusal(planMixed(s.deps, { workspaceId: s.ws, parentEnvironmentId: PARENT_ENV, childEnvironmentIds: [], createdBy: "user-planner" }), "invalid_input");
    });

    it("is tenant-scoped: a foreign workspace sees nothing and cannot bind", async () => {
      const s = await scenario("attached");
      expect(await plans.getPlan(db(), uid("ws"), s.plan.parentPlanId)).toBeNull();
      expect(await plans.getPlanByParentOperation(db(), uid("ws"), s.parentOperationId)).toBeNull();
      await expectCode(plans.attachParentOperation(db(), { workspaceId: uid("ws"), planId: s.plan.parentPlanId, operationId: s.parentOperationId }), "not_found");
      await refusal(adoptChildOperation(s.deps, { workspaceId: uid("ws"), planId: s.plan.parentPlanId, partitionId: first(s), operationId: "op_x" }), "not_found");
    });
  });

  describe("the parent operation is the approval vehicle", () => {
    it("binds an operation only when its proposal input is exactly the plan, write-once", async () => {
      const s = await scenario("planned");
      const wrong = await seedAwaitingApproval(db(), { workspaceId: s.ws, proposal: { capability: "deployment.deploy", scope: { workspaceId: s.ws, projectId: PROJECT, environmentId: PARENT_ENV }, input: { ...parentProposalInput(s.plan), childSetDigest: "0".repeat(64) } } });
      await expectCode(plans.attachParentOperation(db(), { workspaceId: s.ws, planId: s.plan.parentPlanId, operationId: wrong.operation.id }), "digest_mismatch");
      const otherEnv = await seedAwaitingApproval(db(), { workspaceId: s.ws, proposal: { capability: "deployment.deploy", scope: { workspaceId: s.ws, projectId: PROJECT, environmentId: "env-elsewhere" }, input: parentProposalInput(s.plan) } });
      await expectCode(plans.attachParentOperation(db(), { workspaceId: s.ws, planId: s.plan.parentPlanId, operationId: otherEnv.operation.id }), "digest_mismatch");
      const good = await seedAwaitingApproval(db(), { workspaceId: s.ws, proposal: { capability: "deployment.deploy", scope: { workspaceId: s.ws, projectId: PROJECT, environmentId: PARENT_ENV }, input: parentProposalInput(s.plan) } });
      const attached = await plans.attachParentOperation(db(), { workspaceId: s.ws, planId: s.plan.parentPlanId, operationId: good.operation.id });
      expect(attached.parentOperationId).toBe(good.operation.id);
      expect((await plans.attachParentOperation(db(), { workspaceId: s.ws, planId: s.plan.parentPlanId, operationId: good.operation.id })).parentOperationId).toBe(good.operation.id);
      await expectCode(plans.attachParentOperation(db(), { workspaceId: s.ws, planId: s.plan.parentPlanId, operationId: otherEnv.operation.id }), "conflict");
      await expect(db().query("update platform.mixed_parent_plans set parent_operation_id = $3, version = version + 1 where workspace_id = $1 and plan_id = $2", [s.ws, s.plan.parentPlanId, wrong.operation.id])).rejects.toThrow();
    });

    it("refuses to start before a person approved exactly this child set, and when policy allowed it without one", async () => {
      const s = await scenario("adopted");
      // approved by a person (scenario) but not yet running: verify without the running requirement passes
      const ready = await verifyParent(s.deps, { workspaceId: s.ws, operationId: s.parentOperationId, planId: s.plan.parentPlanId, requireRunning: false });
      expect(ready.admission.addresses.size).toBe(3);
      await refusal(verifyParent(s.deps, { workspaceId: s.ws, operationId: s.parentOperationId, planId: s.plan.parentPlanId, requireRunning: true }), "invalid_state");

      const ws = uid("ws");
      const unattended = await scenarioWithPolicyAllow(ws);
      await refusal(verifyParent(unattended.deps, { workspaceId: ws, operationId: unattended.parentOperationId, planId: unattended.plan.parentPlanId, requireRunning: false }), "approval_mismatch");

      const pending = await scenario("attached");
      await refusal(verifyParent(pending.deps, { workspaceId: pending.ws, operationId: pending.parentOperationId, planId: pending.plan.parentPlanId, requireRunning: false }), "approval_mismatch");
    });

    async function scenarioWithPolicyAllow(ws: string) {
      const s = await scenario("planned");
      // Re-plan in the allow-without-human workspace: same code path, different workspace and a policy-allowed (approved, approval_required false) operation.
      const conns: Record<string, ProviderConnection> = {};
      for (const env of ENVIRONMENTS) conns[env] = connection(PROVIDER_OF[env], { workspaceId: ws });
      const world: MixedWorld = { ...s.deps.world, childEnvironment: async (_w, env) => ({ projectId: PROJECT, connection: conns[env] }), connections: async (_w, ids) => new Map(ids.map((id) => [id, Object.values(conns).find((c) => c.id === id) ?? null])) };
      const deps: MixedDeps = { ...s.deps, world };
      const planned = await planMixed(deps, { workspaceId: ws, parentEnvironmentId: PARENT_ENV, childEnvironmentIds: [...ENVIRONMENTS], createdBy: "user-planner", connectivity: fixtureConnectivity({ workspaceId: ws, projectId: PROJECT, parentEnvironmentId: PARENT_ENV, graph: mixedGraph(), candidates: ENVIRONMENTS.map(env => ({childEnvironmentId: env, connection: conns[env]})) }) });
      const op = await seedApprovedOperation(db(), ws, { proposal: { capability: "deployment.deploy", scope: { workspaceId: ws, projectId: PROJECT, environmentId: PARENT_ENV }, input: parentProposalInput(planned.stored.plan) } });
      await plans.attachParentOperation(db(), { workspaceId: ws, planId: planned.stored.plan.parentPlanId, operationId: op.operation.id });
      return { deps, plan: planned.stored.plan, parentOperationId: op.operation.id };
    }

    it("refuses while a child has no adopted operation, and when the registry or any connection changed", async () => {
      const s = await scenario("approved");
      await refusal(verifyParent(s.deps, { workspaceId: s.ws, operationId: s.parentOperationId, planId: s.plan.parentPlanId, requireRunning: false }), "child_mismatch");
      const t = await scenario("adopted");
      const gcp = t.plan.children.find((child) => child.authority.provider === "gcp")!;
      t.conns["env-gcp"] = connection("gcp", { workspaceId: t.ws, status: "revoked" });
      await refusal(verifyParent(t.deps, { workspaceId: t.ws, operationId: t.parentOperationId, planId: t.plan.parentPlanId, requireRunning: false }), "connection_unverified");
      expect(gcp.authority.connectionId).toBe("conn-gcp");
    });

    it("refuses a plan whose child needs unmaterialized dependency outputs unless a materializer vouches for it", async () => {
      const ws = uid("ws");
      const s = await scenario("planned");
      const graphWithEdge = mixedGraph(); graphWithEdge.edges.push({ from: "service/web", to: "resource/db", relation: "connects_to" }); refresh(graphWithEdge);
      const conns: Record<string, ProviderConnection> = {};
      for (const env of ENVIRONMENTS) conns[env] = connection(PROVIDER_OF[env], { workspaceId: ws });
      const world: MixedWorld = { ...s.deps.world, parentGraph: async () => ({ projectId: PROJECT, graph: graphWithEdge }), childEnvironment: async (_w, env) => ({ projectId: PROJECT, connection: conns[env] }), connections: async (_w, ids) => new Map(ids.map((id) => [id, Object.values(conns).find((c) => c.id === id) ?? null])) };
      const deps: MixedDeps = { ...s.deps, world };
      const references = [{ id: "db-host", producer: { address: "resource/db", output: "endpoint", type: "endpoint" as const }, consumer: { address: "service/web", input: "endpoint_db", type: "endpoint" as const } }];
      const planned = await planMixed(deps, { workspaceId: ws, parentEnvironmentId: PARENT_ENV, childEnvironmentIds: [...ENVIRONMENTS], createdBy: "user-planner", connectivity: fixtureConnectivity({ workspaceId: ws, projectId: PROJECT, parentEnvironmentId: PARENT_ENV, graph: graphWithEdge, references, candidates: ENVIRONMENTS.map(env => ({childEnvironmentId: env, connection: conns[env]})) }), references });
      const seeded = await seedAwaitingApproval(db(), { workspaceId: ws, proposal: { capability: "deployment.deploy", scope: { workspaceId: ws, projectId: PROJECT, environmentId: PARENT_ENV }, input: parentProposalInput(planned.stored.plan) } });
      await plans.attachParentOperation(db(), { workspaceId: ws, planId: planned.stored.plan.parentPlanId, operationId: seeded.operation.id });
      await approve(db(), seeded);
      for (const child of planned.stored.plan.children) {
        const op = await seedApprovedOperation(db(), ws, { proposal: { capability: "deployment.deploy", scope: { workspaceId: ws, projectId: PROJECT, environmentId: child.childEnvironmentId }, input: { revisionId: "rev" } } });
        await adoptChildOperation({ ...deps, world: { ...world, childGraph: async (_w, env) => { const g = mixedGraph(); g.nodes = g.nodes.filter((node) => node.provider === PROVIDER_OF[env]); refresh(g); return g; } } }, { workspaceId: ws, planId: planned.stored.plan.parentPlanId, partitionId: child.partitionId, operationId: op.operation.id });
      }
      const input = { workspaceId: ws, operationId: seeded.operation.id, planId: planned.stored.plan.parentPlanId, requireRunning: false };
      await refusal(verifyParent(deps, input), "plan_refused");
      const vouched = await verifyParent({ ...deps, referencesReady: async () => true }, input);
      expect(vouched.stored.plan.children.some((child) => child.blockedByReferences.length > 0)).toBe(true);
    });
  });

  describe("binding a child operation to its subplan", () => {
    it("binds an operation whose revision expands to exactly the approved subplan, once", async () => {
      const s = await scenario("approved");
      const child = s.plan.children[0];
      const bound = await adoptChildOperation(s.deps, { workspaceId: s.ws, planId: s.plan.parentPlanId, partitionId: child.partitionId, operationId: s.childOperations[child.partitionId] });
      expect(bound).toMatchObject({ state: "adopted", childOperationId: s.childOperations[child.partitionId], ordinal: 0 });
      const replay = await adoptChildOperation(s.deps, { workspaceId: s.ws, planId: s.plan.parentPlanId, partitionId: child.partitionId, operationId: s.childOperations[child.partitionId] });
      expect(replay.version).toBe(bound.version);
      const other = await seedApprovedOperation(db(), s.ws, { proposal: { capability: "deployment.deploy", scope: { workspaceId: s.ws, projectId: PROJECT, environmentId: child.childEnvironmentId }, input: { revisionId: "rev-other" } } });
      await expectCode(adoptChildOperation(s.deps, { workspaceId: s.ws, planId: s.plan.parentPlanId, partitionId: child.partitionId, operationId: other.operation.id }), "invalid_state");
    });

    it("refuses an operation for another environment, a revision that does not match, a drifted connection and one with no revision", async () => {
      const s = await scenario("approved");
      const [azure, gcp] = s.plan.children;
      await refusal(adoptChildOperation(s.deps, { workspaceId: s.ws, planId: s.plan.parentPlanId, partitionId: azure.partitionId, operationId: s.childOperations[gcp.partitionId] }), "child_mismatch");
      const extra = { ...s.deps.world, childGraph: async () => { const g = mixedGraph(); g.nodes = g.nodes.filter((node) => node.provider === "azure" || node.address === "service/web"); refresh(g); return g; } };
      await refusal(adoptChildOperation({ ...s.deps, world: extra }, { workspaceId: s.ws, planId: s.plan.parentPlanId, partitionId: azure.partitionId, operationId: s.childOperations[azure.partitionId] }), "child_mismatch");
      const changed = connection("azure", { workspaceId: s.ws }); if (changed.config.provider === "azure") changed.config.stateContainer = "other-container";
      s.conns["env-azure"] = changed;
      await refusal(adoptChildOperation(s.deps, { workspaceId: s.ws, planId: s.plan.parentPlanId, partitionId: azure.partitionId, operationId: s.childOperations[azure.partitionId] }), "plan_refused");
      s.conns["env-azure"] = connection("azure", { workspaceId: s.ws });
      const bare = await seedApprovedOperation(db(), s.ws, { proposal: { capability: "deployment.deploy", scope: { workspaceId: s.ws, projectId: PROJECT, environmentId: azure.childEnvironmentId }, input: {} } });
      await refusal(adoptChildOperation(s.deps, { workspaceId: s.ws, planId: s.plan.parentPlanId, partitionId: azure.partitionId, operationId: bare.operation.id }), "child_mismatch");
    });

    it("cannot adopt the parent operation as a child, or an operation after the plan started", async () => {
      const s = await scenario("approved");
      await expectCode(plans.adoptChild(db(), { workspaceId: s.ws, planId: s.plan.parentPlanId, partitionId: s.plan.children[0].partitionId, operationId: s.parentOperationId }), "digest_mismatch");
      const t = await scenario("running");
      await beginParent(t.deps, { workspaceId: t.ws, planId: t.plan.parentPlanId });
      await refusal(adoptChildOperation(t.deps, { workspaceId: t.ws, planId: t.plan.parentPlanId, partitionId: t.plan.children[0].partitionId, operationId: t.childOperations[t.plan.children[0].partitionId] }), "invalid_state");
    });
  });

  describe("dependency-ordered execution with durable receipts", () => {
    it("starts children one at a time in order; each starts through the durable intent exactly once; receipts carry the DUR-B digest", async () => {
      const s = await scenario("running");
      await verifyParent(s.deps, { workspaceId: s.ws, operationId: s.parentOperationId, planId: s.plan.parentPlanId, requireRunning: true });
      await beginParent(s.deps, { workspaceId: s.ws, planId: s.plan.parentPlanId });
      expect((await plans.getPlan(db(), s.ws, s.plan.parentPlanId))!.status).toBe("running");
      await beginParent(s.deps, { workspaceId: s.ws, planId: s.plan.parentPlanId });

      for (const [index, child] of s.plan.children.entries()) {
        const result = await advance(s, child.partitionId);
        expect(result).toMatchObject({ state: "started", childOperationId: s.childOperations[child.partitionId] });
        expect(s.launcher.claims).toHaveLength(index + 1);
        // a repeated advance never claims or starts again
        expect(await advance(s, child.partitionId)).toMatchObject({ state: "started" });
        expect(s.launcher.claims).toHaveLength(index + 1);
        expect(s.launcher.starts).toHaveLength(index + 1);
        expect(s.launcher.starts[index]).toMatchObject({ operationId: s.childOperations[child.partitionId], environmentId: child.childEnvironmentId, preApproved: true });
        // while the child runs: no receipt, still started
        expect(await observeChild(s.deps, { workspaceId: s.ws, planId: s.plan.parentPlanId, partitionId: child.partitionId })).toEqual({ state: "started" });
        await finishChild(s, child.partitionId, "succeeded");
        const observed = await observeChild(s.deps, { workspaceId: s.ws, planId: s.plan.parentPlanId, partitionId: child.partitionId });
        expect(observed.state).toBe("succeeded");
        expect(observed.receipt).toMatchObject({ outcome: "succeeded", childOperationId: s.childOperations[child.partitionId], executableSemanticsDigest: SEMANTICS, ordinal: index });
        expect((await observeChild(s.deps, { workspaceId: s.ws, planId: s.plan.parentPlanId, partitionId: child.partitionId })).receipt).toEqual(observed.receipt);
      }
      expect(await settleOutcome(db(), { workspaceId: s.ws, planId: s.plan.parentPlanId, requested: "succeeded" })).toBe("succeeded");
      await settleParent(s.deps, { workspaceId: s.ws, planId: s.plan.parentPlanId, outcome: "succeeded", reason: "all children succeeded" });
      expect((await plans.getPlan(db(), s.ws, s.plan.parentPlanId))!.status).toBe("succeeded");
      expect((await plans.listReceipts(db(), s.ws, s.plan.parentPlanId)).map((receipt) => receipt.ordinal)).toEqual([0, 1, 2]);
    });

    it("never starts a child before its dependency succeeded: it is blocked, terminal, and nothing is claimed", async () => {
      const s = await scenario("running");
      await beginParent(s.deps, { workspaceId: s.ws, planId: s.plan.parentPlanId });
      const [, second] = s.plan.children;
      expect(await advance(s, second.partitionId)).toEqual({ state: "blocked", reason: "dependency_not_succeeded" });
      expect(s.launcher.claims).toEqual([]);
      expect((await plans.listChildren(db(), s.ws, s.plan.parentPlanId))[1].state).toBe("blocked");
      expect(await advance(s, second.partitionId)).toMatchObject({ state: "blocked" });
    });

    it.each(["failed", "cancelled", "uncertain"] as const)("a %s child stops the parent: later children are blocked, nothing is rolled back, the parent is not reported succeeded", async (outcome) => {
      const s = await scenario("running");
      await beginParent(s.deps, { workspaceId: s.ws, planId: s.plan.parentPlanId });
      const [one, two, three] = s.plan.children;
      await advance(s, one.partitionId);
      await finishChild(s, one.partitionId, outcome);
      const observed = await observeChild(s.deps, { workspaceId: s.ws, planId: s.plan.parentPlanId, partitionId: one.partitionId });
      expect(observed.state).toBe(outcome);
      const blocked = await advance(s, two.partitionId);
      expect(blocked).toEqual({ state: "blocked", reason: outcome === "uncertain" ? "dependency_uncertain" : "dependency_not_succeeded" });
      expect(s.launcher.claims).toHaveLength(1);
      expect(await settleOutcome(db(), { workspaceId: s.ws, planId: s.plan.parentPlanId, requested: "succeeded" })).toBe("uncertain");
      await settleParent(s.deps, { workspaceId: s.ws, planId: s.plan.parentPlanId, outcome, reason: "stopped" });
      const rows = await plans.listChildren(db(), s.ws, s.plan.parentPlanId);
      expect(rows.map((row) => row.state)).toEqual([outcome, "blocked", "blocked"]);
      expect((await plans.getPlan(db(), s.ws, s.plan.parentPlanId))!.status).toBe(outcome);
      expect(three.partitionId).toBe(rows[2].partitionId);
    });

    it("waits for a child's own approval and never claims it early", async () => {
      const s = await scenario("running");
      const [one] = s.plan.children;
      await db().query("update platform.operations set status = 'awaiting_approval' where workspace_id = $1 and id = $2", [s.ws, s.childOperations[one.partitionId]]);
      expect(await advance(s, one.partitionId)).toEqual({ state: "waiting", reason: "approval" });
      expect(s.launcher.claims).toEqual([]);
    });

    it("blocks a child whose operation ended before the parent started it", async () => {
      const s = await scenario("running");
      const [one] = s.plan.children;
      await finishChild(s, one.partitionId, "cancelled");
      expect(await advance(s, one.partitionId)).toMatchObject({ state: "blocked" });
      expect(s.launcher.claims).toEqual([]);
    });

    it("re-proves the connection and the child graph right before the claim", async () => {
      const s = await scenario("running");
      const [one, two] = s.plan.children;
      s.conns["env-azure"] = connection("azure", { workspaceId: s.ws, status: "revoked" });
      await refusal(advance(s, one.partitionId), "connection_unverified");
      expect(s.launcher.claims).toEqual([]);
      s.conns["env-azure"] = connection("azure", { workspaceId: s.ws });
      const original = s.deps.world.childGraph;
      s.deps.world.childGraph = async (w, env, rev) => { const g = await original(w, env, rev); g.nodes = g.nodes.map((node) => ({ ...node, specDigest: "b".repeat(64) })); return g; };
      await refusal(advance(s, one.partitionId), "child_mismatch");
      expect(s.launcher.claims).toEqual([]);
      expect(two.partitionId).not.toBe(one.partitionId);
    });

    it("a lost start response leaves the child adopted and claimed; the retry does not claim twice", async () => {
      const s = await scenario("running");
      const [one] = s.plan.children;
      s.launcher.failStart = true;
      await expect(advance(s, one.partitionId)).rejects.toThrow("start unconfirmed");
      expect(s.launcher.claims).toHaveLength(1);
      expect((await plans.listChildren(db(), s.ws, s.plan.parentPlanId))[0].state).toBe("adopted");
      s.launcher.failStart = false;
      expect(await advance(s, one.partitionId)).toMatchObject({ state: "started" });
      expect(s.launcher.claims).toHaveLength(1);
      expect(s.launcher.starts).toHaveLength(1);
    });

    it("refuses to advance when the parent is not running or approval is gone", async () => {
      const s = await scenario("approved");
      await refusal(advance(s, s.plan.children[0].partitionId), "invalid_state");
      const t = await scenario("adopted");
      await refusal(advance(t, t.plan.children[0].partitionId), "invalid_state");
    });

    it("a succeeded child with no reviewed semantics is NOT reported as success", async () => {
      const s = await scenario("running");
      s.semantics.value = undefined;
      await beginParent(s.deps, { workspaceId: s.ws, planId: s.plan.parentPlanId });
      const [one] = s.plan.children;
      await advance(s, one.partitionId);
      await finishChild(s, one.partitionId, "succeeded");
      const observed = await observeChild(s.deps, { workspaceId: s.ws, planId: s.plan.parentPlanId, partitionId: one.partitionId });
      expect(observed.state).toBe("uncertain");
      expect(observed.receipt).toMatchObject({ outcome: "uncertain", childStatus: "succeeded_without_reviewed_semantics" });
      expect(await settleOutcome(db(), { workspaceId: s.ws, planId: s.plan.parentPlanId, requested: "succeeded" })).toBe("uncertain");
    });

    it("an unclaimed child and a settled plan: settle blocks the rest and only moves the parent forward", async () => {
      const s = await scenario("running");
      await beginParent(s.deps, { workspaceId: s.ws, planId: s.plan.parentPlanId });
      await settleParent(s.deps, { workspaceId: s.ws, planId: s.plan.parentPlanId, outcome: "cancelled", reason: "stop" });
      expect((await plans.listChildren(db(), s.ws, s.plan.parentPlanId)).every((child) => child.state === "blocked")).toBe(true);
      expect((await plans.getPlan(db(), s.ws, s.plan.parentPlanId))!.status).toBe("cancelled");
      await settleParent(s.deps, { workspaceId: s.ws, planId: s.plan.parentPlanId, outcome: "cancelled", reason: "again" });
      await expectCode(plans.setParentStatus(db(), { workspaceId: s.ws, planId: s.plan.parentPlanId, from: "cancelled", to: "running" }), "invalid_state");
    });
  });

  describe("the database refuses to rewrite history", () => {
    it("subplans, ids and digests are immutable and nothing is deletable", async () => {
      const s = await scenario("running");
      const reject = (sql: string, params: unknown[]) => expect(db().query(sql, params)).rejects.toThrow();
      await reject("update platform.mixed_child_plans set subplan_digest = $3, version = version + 1 where workspace_id = $1 and plan_id = $2", [s.ws, s.plan.parentPlanId, "c".repeat(64)]);
      await reject("update platform.mixed_child_plans set semantics_digest = $3, version = version + 1 where workspace_id = $1 and plan_id = $2", [s.ws, s.plan.parentPlanId, "c".repeat(64)]);
      await reject("update platform.mixed_child_plans set child_environment_id = 'env-x', version = version + 1 where workspace_id = $1 and plan_id = $2", [s.ws, s.plan.parentPlanId]);
      await reject("update platform.mixed_parent_plans set child_set_digest = $3, version = version + 1 where workspace_id = $1 and plan_id = $2", [s.ws, s.plan.parentPlanId, "c".repeat(64)]);
      await reject("update platform.mixed_parent_plans set plan = '{}'::jsonb, version = version + 1 where workspace_id = $1 and plan_id = $2", [s.ws, s.plan.parentPlanId]);
      await reject("delete from platform.mixed_parent_plans where workspace_id = $1 and plan_id = $2", [s.ws, s.plan.parentPlanId]);
      await reject("delete from platform.mixed_child_plans where workspace_id = $1 and plan_id = $2", [s.ws, s.plan.parentPlanId]);
      await reject("update platform.mixed_addresses set address = 'x' where workspace_id = $1 and plan_id = $2", [s.ws, s.plan.parentPlanId]);
      await reject("delete from platform.mixed_addresses where workspace_id = $1 and plan_id = $2", [s.ws, s.plan.parentPlanId]);
    });

    it("the child operation binding is write-once and the state machine only moves forward, and a terminal state needs its receipt", async () => {
      const s = await scenario("running");
      const [one] = s.plan.children;
      const other = await seedApprovedOperation(db(), s.ws);
      await expect(db().query("update platform.mixed_child_plans set child_operation_id = $4, version = version + 1 where workspace_id = $1 and plan_id = $2 and partition_id = $3", [s.ws, s.plan.parentPlanId, one.partitionId, other.operation.id])).rejects.toThrow();
      await expect(db().query("update platform.mixed_child_plans set state = 'succeeded', version = version + 1 where workspace_id = $1 and plan_id = $2 and partition_id = $3", [s.ws, s.plan.parentPlanId, one.partitionId])).rejects.toThrow();
      await expect(db().query("update platform.mixed_child_plans set state = 'started', version = version + 1 where workspace_id = $1 and plan_id = $2 and partition_id = $3 and state = 'adopted'", [s.ws, s.plan.parentPlanId, one.partitionId])).resolves.toBeDefined();
      await expect(db().query("update platform.mixed_child_plans set state = 'succeeded', version = version + 1 where workspace_id = $1 and plan_id = $2 and partition_id = $3", [s.ws, s.plan.parentPlanId, one.partitionId])).rejects.toThrow();
      await expect(db().query("update platform.mixed_child_plans set state = 'adopted', version = version + 1 where workspace_id = $1 and plan_id = $2 and partition_id = $3", [s.ws, s.plan.parentPlanId, one.partitionId])).rejects.toThrow();
      await expect(db().query("update platform.mixed_child_plans set state = 'pending' where workspace_id = $1 and plan_id = $2 and partition_id = $3", [s.ws, s.plan.parentPlanId, one.partitionId])).rejects.toThrow();
    });

    it("receipts are append-only, need a started child under the same operation, and a different outcome is a conflict", async () => {
      const s = await scenario("running");
      await beginParent(s.deps, { workspaceId: s.ws, planId: s.plan.parentPlanId });
      const [one, two] = s.plan.children;
      // no receipt for a child that never started
      await expectCode(plans.recordReceipt(db(), { workspaceId: s.ws, parentPlanId: s.plan.parentPlanId, partitionId: two.partitionId, ordinal: 1, childOperationId: s.childOperations[two.partitionId], outcome: "succeeded", childStatus: "succeeded" }), "invalid_state");
      await advance(s, one.partitionId);
      await expectCode(plans.recordReceipt(db(), { workspaceId: s.ws, parentPlanId: s.plan.parentPlanId, partitionId: one.partitionId, ordinal: 0, childOperationId: "op_other", outcome: "succeeded", childStatus: "succeeded" }), "invalid_state");
      const fields = { workspaceId: s.ws, parentPlanId: s.plan.parentPlanId, partitionId: one.partitionId, ordinal: 0, childOperationId: s.childOperations[one.partitionId], outcome: "failed" as const, childStatus: "failed" };
      const receipt = await plans.recordReceipt(db(), fields);
      expect((await plans.recordReceipt(db(), fields)).receiptDigest).toBe(receipt.receiptDigest);
      await expectCode(plans.recordReceipt(db(), { ...fields, outcome: "succeeded", childStatus: "succeeded" }), "conflict");
      await expect(db().query("update platform.mixed_child_receipts set outcome = 'succeeded' where workspace_id = $1 and plan_id = $2", [s.ws, s.plan.parentPlanId])).rejects.toThrow();
      await expect(db().query("delete from platform.mixed_child_receipts where workspace_id = $1 and plan_id = $2", [s.ws, s.plan.parentPlanId])).rejects.toThrow();
    });

    it("the reviewed semantics digest is write-once", async () => {
      const s = await scenario("running");
      const [one] = s.plan.children;
      const recorded = await plans.recordExecutableSemantics(db(), { workspaceId: s.ws, planId: s.plan.parentPlanId, partitionId: one.partitionId, executableSemanticsDigest: SEMANTICS });
      expect(recorded.executableSemanticsDigest).toBe(SEMANTICS);
      expect((await plans.recordExecutableSemantics(db(), { workspaceId: s.ws, planId: s.plan.parentPlanId, partitionId: one.partitionId, executableSemanticsDigest: SEMANTICS })).version).toBe(recorded.version);
      await expectCode(plans.recordExecutableSemantics(db(), { workspaceId: s.ws, planId: s.plan.parentPlanId, partitionId: one.partitionId, executableSemanticsDigest: "d".repeat(64) }), "digest_mismatch");
    });

    it("admission is minted again from stored facts on every pass (a revoked connection after approval refuses the parent)", async () => {
      const s = await scenario("running");
      const stored = (await plans.getPlan(db(), s.ws, s.plan.parentPlanId))!.plan;
      const connections = await s.deps.world.connections(s.ws, stored.children.map((child) => child.authority.connectionId));
      expect(() => admitMixedGraph({ plan: stored, graph: mixedGraph(), connections })).not.toThrow();
      s.conns["env-aws"] = connection("aws", { workspaceId: s.ws, status: "revoked" });
      await refusal(verifyParent(s.deps, { workspaceId: s.ws, operationId: s.parentOperationId, planId: s.plan.parentPlanId, requireRunning: true }), "connection_unverified");
    });
  });

  it("uses a human principal for the approval in these fixtures", () => {
    expect(user("u").kind).toBe("user");
  });
});
