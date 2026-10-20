/**
 * PROD-DUR-01 / PROD-DUR-02: product-authority projection repair.
 *
 * The platform start intent is the authority; the product `workflowStartedAt` is a
 * projection. When a start was acknowledged durably but the product write was lost,
 * `projectAcknowledgedStart` (reached through the relay's workflow_start handler)
 * must converge the product record idempotently and never send a second start.
 *
 * The platform half runs on PGlite always and on real PostgreSQL when
 * ZENITH_TEST_PLATFORM_PG_URL is set. The product half is the file store: the
 * product PostgreSQL store is a Supabase/PostgREST project (see
 * tests/db/contract/factories.ts), which a plain PostgreSQL server cannot serve.
 */
import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Client } from "@temporalio/client";
import type { Sql } from "@/lib/controlplane/types";
import type { Deployment } from "@/lib/domain/types";
import { tempDataDir } from "../_support/data-dir";

const boot = vi.hoisted(() => ({ ensureBoot: vi.fn(async () => undefined) }));
vi.mock("@/lib/server/boot", () => boot);

const DATA = tempDataDir("zenith-projection-repair-", { fast: true });
const { LANES, openLane, seedApprovedOperation } = await import("../controlplane/_support/harness");
const { enqueueIntent, getIntent, relayOnce } = await import("@/lib/controlplane/outbox");
const { createTemporalIntentHandlers, projectAcknowledgedStarts } = await import("@/lib/controlplane/outbox/temporal");
const startIntents = await import("@/lib/controlplane/db/repos/workflow-start-intents");
const { digest } = await import("@/lib/controlplane/digest");
const { projectAcknowledgedStart } = await import("@/lib/bridge/projection");
const { flushPendingAsync, q } = await import("@/lib/db/store");
const { ctx, seed, workflowDeployment } = await import("./support");

const OBSERVED = "2026-10-21T10:00:00.000Z";
const RUN = "11111111-1111-4111-8111-111111111111";
const persisted = (id: string): Deployment | undefined =>
  (JSON.parse(fs.readFileSync(path.join(DATA, "state.json"), "utf8")).deployments as Deployment[]).find((d) => d.id === id);

/** A binding the retained-intent reader accepts, shaped exactly as `prepare` writes it for a deploy. */
function validBinding(ws: string, op: string, d: Deployment) {
  const args = startIntents.snapshotWorkflowArguments("deploy", {
    workspaceId: ws, operationId: op, projectId: d.projectId, environmentId: d.environmentId, revisionId: d.revisionId,
    deploymentId: d.id, connectionId: "bridge-connection", preApproved: true, build: false });
  const proposalDigest = "b".repeat(64), inputDigest = "c".repeat(64), argumentsDigest = digest(args);
  return { kind: "deploy", arguments: args, namespace: "default", endpointDigest: "d".repeat(64), taskQueue: "zenith",
    format: "zenith.workflow-start.v1", workflowType: startIntents.WORKFLOW_START_TYPES.deploy, workflowId: `op-${op}`,
    argumentsDigest, proposalDigest, inputDigest, sourceDigest: digest({ proposalDigest, inputDigest, argumentsDigest }),
    configDigest: digest(startIntents.START_CONFIG) };
}

describe("projectAcknowledgedStart (product seam)", () => {
  beforeEach(() => { seed(); });

  it("derives workflowStartedAt once, persists it and leaves status, steps and the active writer to the worker", async () => {
    const d = workflowDeployment("applying");
    q.environment(ctx.environmentId!)!.activeDeploymentId = d.id;
    const steps = structuredClone(d.steps);
    expect(projectAcknowledgedStart(d.id, OBSERVED)).toBe(true);
    await flushPendingAsync();
    expect(q.deployment(d.id)).toMatchObject({ workflowStartedAt: OBSERVED, status: "applying", steps });
    expect(q.environment(ctx.environmentId!)?.activeDeploymentId).toBe(d.id);
    expect(persisted(d.id)?.workflowStartedAt).toBe(OBSERVED);
  });

  it("is idempotent: a repeat, even with a later observation, never rewrites the first fact", () => {
    const d = workflowDeployment("planning");
    expect(projectAcknowledgedStart(d.id, OBSERVED)).toBe(true);
    expect(projectAcknowledgedStart(d.id, OBSERVED)).toBe(false);
    expect(projectAcknowledgedStart(d.id, "2026-10-21T11:00:00.000Z")).toBe(false);
    expect(q.deployment(d.id)?.workflowStartedAt).toBe(OBSERVED);
  });

  it("refuses an unknown deployment and terminal deployments, changing nothing", () => {
    expect(projectAcknowledgedStart("no-such-deployment", OBSERVED)).toBe(false);
    const d = workflowDeployment("failed");
    expect(projectAcknowledgedStart(d.id, OBSERVED)).toBe(false);
    expect(q.deployment(d.id)?.workflowStartedAt).toBeUndefined();
  });
});

describe.each(LANES)("acknowledged start with a lost product projection [$name]", (lane) => {
  let lanes: Awaited<ReturnType<typeof openLane>>;
  beforeAll(async () => { lanes = await openLane(lane); }, 60_000);
  afterAll(async () => { await lanes.close(); });
  beforeEach(() => { seed(); boot.ensureBoot.mockReset(); boot.ensureBoot.mockResolvedValue(undefined); });

  /** An acknowledged durable start for a fresh operation, plus the product deployment it projects into. */
  async function lostProjection() {
    const sql: Sql = lanes.db;
    const { workspaceId: ws, operation } = await seedApprovedOperation(sql);
    const op = operation.id;
    const d = workflowDeployment("applying");
    d.operationId = op;
    d.id = `bridge-workflow-${op}`; // one deployment per operation, so a lane's earlier fixtures never alias it
    const binding = validBinding(ws, op, d);
    await sql.query(
      `insert into platform.workflow_start_intents (workspace_id, operation_id, binding, binding_digest, phase, attempt_id, run_id, observed_start_at, evidence_digest, attempted_at, acknowledged_at)
       values ($1, $2, $3::text::jsonb, $4, 'acknowledged', $5, $5, $6::timestamptz, $4, clock_timestamp(), clock_timestamp())`,
      [ws, op, JSON.stringify(binding), digest(binding), RUN, OBSERVED]);
    const intent = await enqueueIntent(sql, { workspaceId: ws, operationId: op, kind: "workflow_start", idempotencyKey: `start:${op}`, payload: {} });
    // Any transport use is a duplicate start: nothing here may reach Temporal.
    const transport = vi.fn(async () => { throw new Error("a repaired projection must not touch Temporal"); });
    const handlers = createTemporalIntentHandlers({ sql, client: transport as unknown as () => Promise<Client>, recovery: { getClient: transport as never } });
    const retained = () => startIntents.get(sql, ws, op);
    return { sql, ws, op, d, intent, handlers, transport, retained, only: { workspaceId: ws, id: intent.id } };
  }

  it("the relay converges the product record from the authority, once, without a second start", async () => {
    const f = await lostProjection();
    const before = await f.retained();
    expect(f.d.workflowStartedAt).toBeUndefined();
    const steps = structuredClone(f.d.steps);

    expect(await relayOnce(f.sql, f.handlers, { holder: "repair-test", only: f.only })).toMatchObject({ claimed: 1, delivered: 1, dead: 0 });

    expect(await getIntent(f.sql, f.ws, "workflow_start", `start:${f.op}`)).toMatchObject({ state: "delivered", outcome: "delivered" });
    expect(q.deployment(f.d.id)).toMatchObject({ workflowStartedAt: OBSERVED, status: "applying", steps });
    expect(persisted(f.d.id)?.workflowStartedAt).toBe(OBSERVED);
    expect(f.transport).not.toHaveBeenCalled();
    // the authority is untouched: same attempt, run and acknowledgement
    expect(await f.retained()).toMatchObject({ phase: "acknowledged", attempt_id: before!.attempt_id, run_id: RUN });
    expect(Date.parse((await f.retained())!.observed_start_at!)).toBe(Date.parse(OBSERVED));
  });

  it("redelivering the same handler is idempotent: still delivered, no rewrite, no start", async () => {
    const f = await lostProjection();
    expect(await f.handlers.workflow_start(f.intent)).toEqual({ status: "delivered" });
    const first = q.deployment(f.d.id)!.workflowStartedAt;
    expect(first).toBe(OBSERVED);
    expect(await f.handlers.workflow_start(f.intent)).toEqual({ status: "delivered" });
    expect(await f.handlers.workflow_start(f.intent)).toEqual({ status: "delivered" });
    expect(q.deployment(f.d.id)?.workflowStartedAt).toBe(first);
    expect(f.transport).not.toHaveBeenCalled();
  });

  it("a projection write that fails never un-delivers the start, and the next pass still converges", async () => {
    const f = await lostProjection();
    boot.ensureBoot.mockRejectedValueOnce(new Error("product store unavailable"));
    // best effort: the authority fact stands, the product copy is left behind
    expect(await f.handlers.workflow_start(f.intent)).toEqual({ status: "delivered" });
    expect(q.deployment(f.d.id)?.workflowStartedAt).toBeUndefined();
    expect(await f.retained()).toMatchObject({ phase: "acknowledged", run_id: RUN });
    // the repair is re-derivable from the authority on the next pass
    expect(await f.handlers.workflow_start(f.intent)).toEqual({ status: "delivered" });
    expect(q.deployment(f.d.id)?.workflowStartedAt).toBe(OBSERVED);
    expect(f.transport).not.toHaveBeenCalled();
  });

  it("never reaches a deployment the worker has already finished", async () => {
    const f = await lostProjection();
    f.d.status = "succeeded"; f.d.endedAt = OBSERVED;
    expect(await f.handlers.workflow_start(f.intent)).toEqual({ status: "delivered" });
    expect(q.deployment(f.d.id)).toMatchObject({ status: "succeeded", endedAt: OBSERVED });
    expect(q.deployment(f.d.id)?.workflowStartedAt).toBeUndefined();
  });

  it("the sweep repairs an acknowledged start that has no relay row, and only while the operation is live", async () => {
    const f = await lostProjection();
    // An in-process acknowledged start leaves no relay row: settle the one created above so only the sweep can repair it.
    await f.sql.query("delete from platform.durable_intents where workspace_id = $1 and id = $2", [f.ws, f.intent.id]);
    expect(await getIntent(f.sql, f.ws, "workflow_start", `start:${f.op}`)).toBeNull();
    expect(await projectAcknowledgedStarts(f.sql)).toBeGreaterThanOrEqual(1);
    expect(q.deployment(f.d.id)?.workflowStartedAt).toBe(OBSERVED);
    expect(persisted(f.d.id)?.workflowStartedAt).toBe(OBSERVED);
    expect(await projectAcknowledgedStarts(f.sql)).toBe(0);
    expect(f.transport).not.toHaveBeenCalled();
    expect(await f.retained()).toMatchObject({ phase: "acknowledged", run_id: RUN });

    const finished = await lostProjection();
    await finished.sql.query("delete from platform.durable_intents where workspace_id = $1 and id = $2", [finished.ws, finished.intent.id]);
    const cancelled = await finished.sql.query<{ id: string; status: string }>("update platform.operations set status = 'cancelled' where workspace_id = $1 and id = $2 returning id, status", [finished.ws, finished.op]);
    expect(cancelled).toEqual([{ id: finished.op, status: "cancelled" }]);
    await projectAcknowledgedStarts(finished.sql);
    expect(q.deployment(finished.d.id)?.workflowStartedAt).toBeUndefined();
  });

  it("the sweep converges a projection that failed after the start was delivered", async () => {
    const f = await lostProjection();
    boot.ensureBoot.mockRejectedValueOnce(new Error("product store unavailable"));
    expect(await relayOnce(f.sql, f.handlers, { holder: "repair-test", only: f.only })).toMatchObject({ delivered: 1 });
    expect(await getIntent(f.sql, f.ws, "workflow_start", `start:${f.op}`)).toMatchObject({ state: "delivered" });
    expect(q.deployment(f.d.id)?.workflowStartedAt).toBeUndefined();
    // the relay row is settled, so no later relay pass would retry it; the sweep does
    expect(await projectAcknowledgedStarts(f.sql)).toBeGreaterThanOrEqual(1);
    expect(q.deployment(f.d.id)?.workflowStartedAt).toBe(OBSERVED);
    expect(f.transport).not.toHaveBeenCalled();
  });
});
