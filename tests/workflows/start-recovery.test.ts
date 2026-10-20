/**
 * PROD-DUR-01: crash-window recovery of the workflow start. Owned real Temporal
 * frontend (local CLI) plus actual SQL/Broker, like start-intent.test.ts. Faults
 * are injected exactly at the boundaries: after the sole attempt CAS but before the
 * Start RPC, after an accepted Start but before the readback acknowledgement, after
 * the prepared commit. The relay entrypoint is `recoverWorkflowStartIntent`.
 *
 * Skipped when the owned Temporal CLI is unavailable, unless ZENITH_TEST_TEMPORAL=1
 * or ZENITH_TEST_WORKFLOW_START_REQUIRED=1 (then it fails instead of skipping).
 */
import { randomUUID } from "node:crypto";
import { Client, Connection } from "@temporalio/client";
import { TestWorkflowEnvironment } from "@temporalio/testing";
import { DefaultLogger, Runtime, makeTelemetryFilterString } from "@temporalio/worker";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { digest } from "@/lib/controlplane/digest";
import { openPlatformDb, type PlatformDbHandle } from "@/lib/controlplane/db";
import { migration0012WorkflowStartIntents } from "@/lib/controlplane/db/migrations/0012_workflow_start_intents";
import * as intents from "@/lib/controlplane/db/repos/workflow-start-intents";
import { projectOperation } from "@/lib/controlplane/authority";
import { adoptStartIntents, enqueueIntent, getIntent, intentId, relayOnce } from "@/lib/controlplane/outbox";
import { createTemporalIntentHandlers } from "@/lib/controlplane/outbox/temporal";
import { createIsolatedWorkflowStarterForTests, recoverWorkflowStartIntent, START_RECOVERY_WINDOW_MS, WorkflowStartUnconfirmedError } from "@/lib/workflows/start-intent";
import { temporalConfigFromEnv } from "@/lib/workflows/config";
import { WORKFLOW_ID, type WorkflowResult } from "@/lib/workflows/types";
import { approveAs, closeSharedPgliteAfterAll, makeHarness as brokerHarness, PG_URL, proposeOk, requestFor,
  requireApproval, scriptedEngine, user } from "../capabilities/support";
import { findTemporalCli, makeHarness as temporalHarness, workflowBundlePath,
  type Harness as TemporalHarness, type ScenarioBody, type TestServer } from "./support";

closeSharedPgliteAfterAll();

function recoverySuite() {
  let server: TestServer | undefined, bundle = "";
  const skipReason = "Owned Temporal CLI is unavailable.";
  beforeAll(async () => {
    const cli = findTemporalCli();
    if (!cli) {
      if (process.env.ZENITH_TEST_TEMPORAL === "1" || process.env.ZENITH_TEST_WORKFLOW_START_REQUIRED === "1") throw new Error(skipReason);
      return;
    }
    try {
      Runtime.install({ logger: new DefaultLogger("ERROR"), telemetryOptions: { logging: { filter: makeTelemetryFilterString({ core: "ERROR", other: "ERROR" }), forward: {} } } });
    } catch { /* The shared process may already have its SDK Runtime. */ }
    const env = await TestWorkflowEnvironment.createLocal({ server: {
      executable: { type: "existing-path", path: cli }, ip: "127.0.0.1", namespace: `zenith-start-recovery-${randomUUID()}`,
      extraArgs: [
        "--dynamic-config-value", "frontend.WorkflowTimeSkippingEnabled=true",
        "--dynamic-config-value", 'history.transferProcessorUpdateAckInterval="1s"',
        "--dynamic-config-value", "history.transferProcessorUpdateAckIntervalJitterCoefficient=0",
      ],
    } });
    if (/:7233$/.test(env.address)) { await env.teardown(); throw new Error("Owned recovery engine refuses the default Temporal port."); }
    server = { env, mode: "local-cli", timeSkipping: env.supportsTimeSkipping, teardown: () => env.teardown() };
    bundle = await workflowBundlePath();
  }, 240_000);
  afterAll(async () => { await server?.teardown(); });
  return { scenario(name: string, body: ScenarioBody, timeoutMs = 60_000) {
    it(name, async (ctx) => {
      if (!server) return ctx.skip(skipReason);
      await body(temporalHarness(server, bundle));
    }, timeoutMs);
  } };
}
const { scenario } = recoverySuite();
let independentPg: Promise<PlatformDbHandle> | undefined;
afterAll(async () => { await (await independentPg)?.close(); });

async function fixture(t: TemporalHarness) {
  const h = await brokerHarness({ kind: PG_URL ? "postgres" : "pglite", engine: scriptedEngine("start-recovery", () => requireApproval(1, "admin")) });
  const db = h.db!;
  await db.exec(migration0012WorkflowStartIntents.sql);
  const db2 = PG_URL ? await (independentPg ??= openPlatformDb({ kind: "postgres", url: PG_URL, max: 2, migrate: false })) : db;
  const p = await proposeOk(h, requestFor(h, "service.restart", "prod"), user("bob"));
  await approveAs(h, p.operation, "erin");
  await h.broker.beginExecution({ workspaceId: h.ids.wsA, operationId: p.id, holder: `workflow:${p.id}`, audience: "worker", leaseMs: 60_000 });
  const input = { workspaceId: h.ids.wsA, operationId: p.id, environmentId: h.ids.envAProd, capability: "service.restart" };
  const config = temporalConfigFromEnv({ ZENITH_TEMPORAL_ADDRESS: t.server.env.address, ZENITH_TEMPORAL_NAMESPACE: t.server.env.namespace ?? "default" });
  const connection = await Connection.connect({ address: config.address, connectTimeout: "2s" });
  const connection2 = await Connection.connect({ address: config.address, connectTimeout: "2s" });
  const client = new Client({ connection, namespace: config.namespace });
  const client2 = new Client({ connection: connection2, namespace: config.namespace });
  const request: intents.StartRequest = { kind: "dayTwo", arguments: input, namespace: config.namespace,
    endpointDigest: digest({ address: config.address, tls: config.tls }), taskQueue: t.taskQueue };
  const store = intents.createIsolatedStartIntentStoreForTests(h.broker);
  const deps = (c: Client) => ({ config, getClient: async () => c, store });
  return { h, db, db2, p, input, config, client, client2, request, store, deps,
    ws: h.ids.wsA, op: p.id,
    inventory: () => intents.get(db2, h.ids.wsA, p.id),
    close: async () => { vi.restoreAllMocks(); await connection.close(); await connection2.close(); } };
}

scenario("crash after the attempt CAS and before the Start RPC: recovery resends the identical request once and acknowledges", async (t) => {
  const f = await fixture(t);
  const spy = vi.spyOn(f.client.workflowService, "startWorkflowExecution");
  try {
    await t.run(async () => {
      await f.store.prepare(f.db, f.request);
      const attempted = (await f.store.claim(f.db, f.request)).intent;
      expect(attempted.phase).toBe("attempted");
      expect(spy).not.toHaveBeenCalled();
      expect(await recoverWorkflowStartIntent(f.db, f.ws, f.op, f.deps(f.client))).toBe("acknowledged");
      expect(spy).toHaveBeenCalledTimes(1);
      const retained = await f.inventory();
      // same permanent attempt: no new attempt id, same workflow id
      expect(retained).toMatchObject({ phase: "acknowledged", attempt_id: attempted.attempt_id });
      const handle = f.client.workflow.getHandle(retained!.binding.workflowId, retained!.run_id!);
      expect(((await handle.result()) as WorkflowResult).status).toBe("succeeded");
      // already acknowledged: a second pass is a no-op, never another Start
      expect(await recoverWorkflowStartIntent(f.db2, f.ws, f.op, f.deps(f.client2))).toBe("acknowledged");
      expect(spy).toHaveBeenCalledTimes(1);
    });
  } finally { await f.close(); }
});

scenario("crash after an accepted Start and before the acknowledgement commit: recovery reads the original back and never sends again", async (t) => {
  const f = await fixture(t);
  const starter = createIsolatedWorkflowStarterForTests(f.db, f.h.broker, f.client, f.config, t.taskQueue);
  const lost = vi.spyOn(intents, "acknowledge").mockImplementation(async () => { throw new Error("process died before the acknowledgement committed"); });
  try {
    await t.run(async () => {
      await expect(starter.start("dayTwo", f.input)).rejects.toBeInstanceOf(WorkflowStartUnconfirmedError);
      lost.mockRestore();
      expect((await f.inventory())?.phase).toBe("attempted");
      const spy = vi.spyOn(f.client2.workflowService, "startWorkflowExecution");
      expect(await recoverWorkflowStartIntent(f.db2, f.ws, f.op, f.deps(f.client2))).toBe("acknowledged");
      expect(spy).not.toHaveBeenCalled();
      const retained = await f.inventory();
      expect(retained?.phase).toBe("acknowledged");
      expect(((await f.client2.workflow.getHandle(retained!.binding.workflowId, retained!.run_id!).result()) as WorkflowResult).status).toBe("succeeded");
    });
  } finally { await f.close(); }
});

scenario("an execution under the retained workflow id that is not the retained original is refused, never adopted or overwritten", async (t) => {
  const f = await fixture(t);
  try {
    await t.run(async () => {
      await f.store.prepare(f.db, f.request);
      const attempted = (await f.store.claim(f.db, f.request)).intent;
      const foreign = await f.client.workflow.start("dayTwoOperationWorkflow", { workflowId: attempted.binding.workflowId, taskQueue: t.taskQueue, args: [f.input] });
      const spy = vi.spyOn(f.client2.workflowService, "startWorkflowExecution");
      expect(await recoverWorkflowStartIntent(f.db2, f.ws, f.op, f.deps(f.client2))).toBe("refused");
      expect(spy).not.toHaveBeenCalled();
      expect((await f.inventory())?.phase).toBe("attempted");
      expect((await f.client.workflow.getHandle(attempted.binding.workflowId).describe()).runId).toBe(foreign.firstExecutionRunId);
    });
  } finally { await f.close(); }
});

scenario("prepared-only crash is recovered through the ordinary authority-checked start path", async (t) => {
  const f = await fixture(t);
  const spy = vi.spyOn(f.client.workflowService, "startWorkflowExecution");
  try {
    await t.run(async () => {
      await f.store.prepare(f.db, f.request);
      expect((await f.inventory())?.phase).toBe("prepared");
      expect(await recoverWorkflowStartIntent(f.db, f.ws, f.op, f.deps(f.client))).toBe("acknowledged");
      expect(spy).toHaveBeenCalledTimes(1);
      expect((await f.inventory())?.phase).toBe("acknowledged");
    });
  } finally { await f.close(); }
});

scenario("recovery is refused outside its window, after the operation lease lapsed, or against another endpoint", async (t) => {
  const f = await fixture(t);
  const spy = vi.spyOn(f.client.workflowService, "startWorkflowExecution");
  try {
    await f.store.prepare(f.db, f.request);
    await f.store.claim(f.db, f.request);
    // window elapsed
    expect(await recoverWorkflowStartIntent(f.db, f.ws, f.op, { ...f.deps(f.client), now: () => Date.now() + START_RECOVERY_WINDOW_MS + 60_000 })).toBe("refused");
    // another Temporal endpoint than the one the attempt was bound to
    expect(await recoverWorkflowStartIntent(f.db, f.ws, f.op, { ...f.deps(f.client), config: { ...f.config, address: "127.0.0.1:1" } })).toBe("refused");
    // lease lapsed: the reconciler's uncertain outcome wins; nothing new is started
    await f.db.query("update platform.operations set lease_until = clock_timestamp() - interval '1 second' where workspace_id = $1 and id = $2", [f.ws, f.op]);
    expect(await recoverWorkflowStartIntent(f.db, f.ws, f.op, f.deps(f.client))).toBe("refused");
    expect(spy).not.toHaveBeenCalled();
    expect((await f.inventory())?.phase).toBe("attempted");
  } finally { await f.close(); }
});

scenario("two independent recovering workers produce one workflow and one acknowledged intent", async (t) => {
  const f = await fixture(t);
  const spyA = vi.spyOn(f.client.workflowService, "startWorkflowExecution");
  const spyB = vi.spyOn(f.client2.workflowService, "startWorkflowExecution");
  try {
    await t.run(async () => {
      await f.store.prepare(f.db, f.request);
      await f.store.claim(f.db, f.request);
      const results = await Promise.all([
        recoverWorkflowStartIntent(f.db, f.ws, f.op, f.deps(f.client)),
        recoverWorkflowStartIntent(f.db2, f.ws, f.op, f.deps(f.client2)),
      ]);
      expect(results).toContain("acknowledged");
      // a resend of the same requestId is deduplicated by the server: still exactly one execution
      expect(spyA.mock.calls.length + spyB.mock.calls.length).toBeGreaterThanOrEqual(1);
      expect(await recoverWorkflowStartIntent(f.db, f.ws, f.op, f.deps(f.client))).toBe("acknowledged");
      const retained = await f.inventory();
      const described = await f.client.workflow.getHandle(retained!.binding.workflowId).describe();
      expect(described.runId).toBe(retained!.run_id);
    });
  } finally { await f.close(); }
});

scenario("the relay adopts an abandoned start intent, recovers it, and the projection derives the running phase", async (t) => {
  const f = await fixture(t);
  try {
    await t.run(async () => {
      await f.store.prepare(f.db, f.request);
      await f.store.claim(f.db, f.request);
      expect((await projectOperation(f.db, f.ws, f.op))?.phase).toBe("start_attempted_unconfirmed");
      expect(await adoptStartIntents(f.db, 50, 0)).toBeGreaterThanOrEqual(1);
      const only = { workspaceId: f.ws, id: intentId(f.ws, "workflow_start", `start:${f.op}`) };
      const handlers = createTemporalIntentHandlers({ sql: f.db, config: () => f.config, client: async () => f.client, recovery: f.deps(f.client) });
      expect(await relayOnce(f.db, handlers, { holder: "relay-test", only })).toMatchObject({ claimed: 1, delivered: 1 });
      expect(await getIntent(f.db, f.ws, "workflow_start", `start:${f.op}`)).toMatchObject({ state: "delivered", outcome: "delivered" });
      expect(await projectOperation(f.db, f.ws, f.op)).toMatchObject({ phase: "running", startIntent: { phase: "acknowledged" } });
    });
  } finally { await f.close(); }
});

scenario("a successful signal redelivered under the same requestId is dispatched to the workflow exactly once", async (t) => {
  const f = await fixture(t);
  const signalRpc = vi.spyOn(f.client.workflowService, "signalWorkflowExecution");
  try {
    // No worker polls: the workflow stays open, so the history shows exactly what the server accepted.
    const workflowId = WORKFLOW_ID(f.op);
    const handle = await f.client.workflow.start("dayTwoOperationWorkflow", { workflowId, taskQueue: t.taskQueue, args: [f.input] });
    const signaled = async () => (await handle.fetchHistory()).events!.filter((e) => e.workflowExecutionSignaledEventAttributes).length;
    const intent = await enqueueIntent(f.db, { workspaceId: f.ws, operationId: f.op, kind: "workflow_signal", idempotencyKey: `approval:${f.op}:1`, payload: { signal: "approvalRecorded" } });
    const only = { workspaceId: f.ws, id: intent.id };
    const handlers = createTemporalIntentHandlers({ sql: f.db, config: () => f.config, client: async () => f.client });
    // the relay crashes after the successful dispatch and before the delivered settlement commits
    await expect(relayOnce(f.db, handlers, { holder: "relay-a", only, faults: { afterDeliver: async () => { throw new Error("relay died before settling"); } } })).rejects.toThrow("relay died");
    expect(await signaled()).toBe(1);
    expect(await getIntent(f.db, f.ws, "workflow_signal", `approval:${f.op}:1`)).toMatchObject({ state: "pending" });
    await f.db.query("update platform.durable_intents set lease_until = clock_timestamp() - interval '1 second' where id = $1", [intent.id]);
    // redelivery carries the same intent id as requestId and is settled this time
    expect(await relayOnce(f.db, handlers, { holder: "relay-b", only })).toMatchObject({ claimed: 1, delivered: 1 });
    expect(await getIntent(f.db, f.ws, "workflow_signal", `approval:${f.op}:1`)).toMatchObject({ state: "delivered", outcome: "delivered" });
    // transport saw two sends under one requestId; the workflow history recorded one signal
    expect(signalRpc).toHaveBeenCalledTimes(2);
    expect(signalRpc.mock.calls.map(([req]) => req.requestId)).toEqual([intent.id, intent.id]);
    expect(await signaled()).toBe(1);
    // a different requestId is a different effect and is accepted: the dedupe is by id, not by blanket suppression
    const next = await enqueueIntent(f.db, { workspaceId: f.ws, operationId: f.op, kind: "workflow_signal", idempotencyKey: `approval:${f.op}:2`, payload: { signal: "approvalRecorded" } });
    expect(await handlers.workflow_signal(next)).toEqual({ status: "delivered" });
    expect(await signaled()).toBe(2);
    await handle.terminate("test done");
  } finally { await f.close(); }
});

scenario("a signal to a workflow Temporal does not know is a real NotFound, retried then recorded as not_found", async (t) => {
  const f = await fixture(t);
  try {
    const intent = await enqueueIntent(f.db, { workspaceId: f.ws, operationId: f.op, kind: "workflow_signal", idempotencyKey: `cancel:${f.op}`, payload: { signal: "cancel" } });
    const handlers = createTemporalIntentHandlers({ sql: f.db, config: () => f.config, client: async () => f.client });
    expect(await handlers.workflow_signal(intent)).toEqual({ status: "not_found" });
    // unknown signal names are refused before any transport
    const bad = await enqueueIntent(f.db, { workspaceId: f.ws, operationId: f.op, kind: "workflow_signal", idempotencyKey: `bogus:${f.op}`, payload: { signal: "dropEverything" } });
    expect(await handlers.workflow_signal(bad)).toEqual({ status: "refused" });
  } finally { await f.close(); }
});
