/** Real isolated Temporal workflow/worker + PGlite; explicit fake cloud ports, never a live account. */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { Worker } from "@temporalio/worker";
import type { Client } from "@temporalio/client";
import { createDestroyActivities } from "@/lib/execution/destroy";
import { createRuntime } from "@/lib/execution/runtime";
import { createPlatformPorts } from "@/lib/execution/platform";
import { createExecutionBroker } from "@/lib/platform/broker";
import { requestDestroyReview } from "@/lib/capabilities/destroy-review";
import { dispatchDestroyReview } from "@/lib/capabilities/destroy-review-dispatch";
import { TASK_QUEUE } from "@/lib/workflows/types";
import { startTestServer, workflowBundlePath, type TestServer } from "../workflows/support";
import { closeSharedPgliteAfterAll, makeHarness, integrationOf, user, sessionFor } from "../capabilities/support";
import { createWorld, createSqlPlanArtifactFixture, type World } from "./fakes/world";
import { bucketManifest, makePlan, change, REVISION } from "./fakes/fixtures";
import { upgradeManifest } from "@/lib/resources/upgrade";

const transport = vi.hoisted(() => ({ client: undefined as Client | undefined }));
vi.mock("@/lib/workflows/client", () => ({ workflowClient: async () => transport.client! }));
const enabled = !!process.env.ZENITH_TEST_TEMPORAL_SERVER || process.env.ZENITH_TEST_TEMPORAL_DOWNLOAD === "1";
let server: TestServer | undefined;
let bundle: string;
const worlds: World[] = [];
closeSharedPgliteAfterAll();
beforeAll(async () => {
  if (!enabled) return;
  const started = await startTestServer("time-skipping");
  if (!started.server) throw new Error(started.skipReason);
  server = started.server; transport.client = server.env.client;
  bundle = await workflowBundlePath();
}, 60_000);
afterEach(() => { worlds.splice(0).forEach((w) => w.dispose()); vi.restoreAllMocks(); });
afterAll(async () => { transport.client = undefined; await server?.teardown(); });

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
  const executionBroker=createExecutionBroker(h.db!,async()=>h.broker);
  const rt = createRuntime({ ...w.deps, ...platform, product: w.product, connections: w.connections,
    planArtifacts:createSqlPlanArtifactFixture(w,h.db!,executionBroker),broker: executionBroker, clock: () => h.clock.now(), limits: { heartbeatIntervalMs: 1000 } });
  const activities = createDestroyActivities(rt, { reviewBroker: async () => h.broker });
  const agent = integrationOf(h, "intRO");
  h.world.integrations.get(`${scope.workspaceId}|${agent.id}`)!.scopes = ["plan"];
  h.world.members.set(`${scope.workspaceId}|bob`, "viewer");
  const request = (key = "destroy-intent-001", refresh = false, actor = agent) => requestDestroyReview(h.broker, scope, actor, { idempotencyKey: key, refresh });
  return { h, w, scope, activities, request };
}


describe.skipIf(!enabled)("Temporal read-only teardown review workflow", () => {
  it("retries a review attempt that never reached the worker, so the queued review is not left to expire", async () => {
    const { h, scope, activities, request } = await setup();
    // A worker restart can leave a stale poller that takes the first attempt and never runs it.
    let attempts = 0;
    const reviewTeardown: typeof activities.reviewTeardown = async (input) => {
      if (++attempts === 1) throw new Error("lost with a restarted worker");
      return activities.reviewTeardown(input);
    };
    const worker = await Worker.create({ connection: server!.env.nativeConnection, taskQueue: TASK_QUEUE,
      workflowBundle: { codePath: bundle }, activities: { ...activities, reviewTeardown } });
    await worker.runUntil(async () => {
      const queued = await request("destroy-intent-retry");
      const result = await server!.env.client.workflow.getHandle(`teardown-review-${queued.reviewOperationId}`).result() as { operationId: string };
      expect(attempts).toBe(2);
      expect((await h.store.getOperation(scope.workspaceId, queued.reviewOperationId))?.status).toBe("succeeded");
      expect((await h.store.getOperation(scope.workspaceId, result.operationId))?.status).toBe("awaiting_approval");
    });
  }, 60_000);

  it("records evidence and a pending proposal once, and preserves approval winning a refresh race without apply", async () => {
    const { h, w, scope, activities, request } = await setup();
    const worker = await Worker.create({ connection: server!.env.nativeConnection, taskQueue: TASK_QUEUE,
      workflowBundle: { codePath: bundle }, activities });
    await worker.runUntil(async () => {
      const queued = await request();
      const workflowId = `teardown-review-${queued.reviewOperationId}`;
      const handle = server!.env.client.workflow.getHandle(workflowId);
      const result = await handle.result() as { operationId: string; planDigest: string };
      const detail = await h.broker.getOperationDetail({ workspaceId: scope.workspaceId, operationId: result.operationId, principal: user("erin") });
      expect(detail.operation).toMatchObject({ capability: "infrastructure.destroy", status: "awaiting_approval", planDigest: result.planDigest });
      expect(detail.planReview?.view.resources[0]).toMatchObject({ action: "delete" });
      const semanticsDigest = detail.planReview?.semantics?.digest;
      expect(semanticsDigest).toMatch(/^[a-f0-9]{64}$/);
      expect(await h.store.getPlanEvidence(scope.workspaceId, result.operationId, result.planDigest)).toMatchObject({ kind: "tofu_plan", simulated: false, summary: { destroy: true } });
      expect(w.credentials.sessions).toHaveLength(1);
      expect(w.credentials.sessions[0]).toMatchObject({ purpose: "observe", capability: "infrastructure.plan", revoked: true });
      await dispatchDestroyReview({ workspaceId: scope.workspaceId, operationId: queued.reviewOperationId });
      expect((await server!.env.client.workflow.getHandle(workflowId).describe()).runId).toBe((await handle.describe()).runId);
      expect(w.tofu.planCalls).toHaveLength(1);
      const op = (await h.store.getOperation(scope.workspaceId, result.operationId))!;
      const cancel = h.store.cancelOperation.bind(h.store);
      let approved: typeof op | null = null;
      let events: Awaited<ReturnType<typeof h.store.listEvents>> = [];
      const cancellation = vi.spyOn(h.store, "cancelOperation").mockImplementation(async (input) => {
        expect(input).toMatchObject({ id: op.id, expectedStatus: "awaiting_approval", requireUndecidedApprovalRound: true });
        const decision = await h.broker.approve({ workspaceId: scope.workspaceId, operationId: op.id, proposalDigest: op.proposalDigest, planDigest: result.planDigest,
          semanticsDigest, approver: user("erin"), session: sessionFor("erin") });
        expect(decision.operation.status).toBe("approved");
        approved = await h.store.getOperation(scope.workspaceId, op.id);
        events = await h.store.listEvents(scope.workspaceId, { operationId: op.id });
        const cancelled = await cancel(input);
        expect(cancelled).toBeNull();
        return cancelled;
      });
      const refresh = await request("temporal-refresh-race", true);
      await expect(server!.env.client.workflow.getHandle(`teardown-review-${refresh.reviewOperationId}`).result()).rejects.toBeDefined();
      expect(cancellation).toHaveBeenCalledOnce();
      expect(await h.store.getOperation(scope.workspaceId, op.id)).toEqual(approved);
      expect((await h.store.getOperation(scope.workspaceId, op.id))?.status).toBe("approved");
      expect(await h.store.listEvents(scope.workspaceId, { operationId: op.id })).toEqual(events);
      expect((await h.store.listOperations(scope.workspaceId, { capability: "infrastructure.destroy" })).items).toHaveLength(1);
      expect((await h.store.getOperation(scope.workspaceId, refresh.reviewOperationId))?.status).toBe("failed");
      expect(w.tofu.applyCalls).toHaveLength(0);
    });
  }, 60_000);
});
