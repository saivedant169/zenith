/**
 * PROD-DUR-01 / PROD-DUR-02: the versioned operation authority record, the durable
 * intent outbox and crash-window recovery with fault injection at every relay
 * boundary. Actual platform SQL on the PGlite lane always; on real PostgreSQL
 * (independent backends, real row locks) when ZENITH_TEST_PLATFORM_PG_URL is set.
 *
 * Transport is a recording handler: these tests prove the database contract
 * (claim fencing, idempotent identity, at-least-once with stale-holder refusal).
 * The real Temporal transport is exercised in tests/workflows/start-recovery.test.ts.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as repos from "@/lib/controlplane/db/repos";
import { casTransition, derivePhase, environmentActivity, projectOperation, readAuthority, type OperationAuthority } from "@/lib/controlplane/authority";
import {
  claimDue, deriveApprovalSignals, enqueueIntent, getIntent, intentId, MAX_ATTEMPTS, relayOnce, settleIntent,
  type DeliveryResult, type DurableIntent, type IntentHandlers,
} from "@/lib/controlplane/outbox";
import type { OperationStatus, Sql } from "@/lib/controlplane/types";
import { LANES, expectCode, newWorkspace, openLane, seedApprovedOperation } from "./_support/harness";

const handlers = (fn: (intent: DurableIntent) => Promise<DeliveryResult> | DeliveryResult): IntentHandlers =>
  ({ workflow_signal: async (i) => fn(i), workflow_start: async (i) => fn(i) });
const expireLease = (db: Sql, id: string) =>
  db.query("update platform.durable_intents set lease_until = clock_timestamp() - interval '1 second' where id = $1", [id]);
const makeDue = (db: Sql, id: string) =>
  db.query("update platform.durable_intents set next_attempt_at = clock_timestamp() - interval '1 second' where id = $1", [id]);

describe.each(LANES)("durable intents and operation authority [$name]", (lane) => {
  let ctx: Awaited<ReturnType<typeof openLane>>;
  beforeAll(async () => { ctx = await openLane(lane); }, 60_000);
  afterAll(async () => { await ctx.close(); });
  const db = () => ctx.db;

  const seeded = async () => {
    const s = await seedApprovedOperation(db());
    return { ws: s.workspaceId, op: s.operation.id };
  };
  const signalIntent = async (key = "cancel:op", operationId?: string, ws?: string) => {
    const s = operationId && ws ? { ws, op: operationId } : await seeded();
    const intent = await enqueueIntent(db(), { workspaceId: s.ws, operationId: s.op, kind: "workflow_signal", idempotencyKey: key, payload: { signal: "cancel" } });
    return { ...s, intent, only: { workspaceId: s.ws, id: intent.id } };
  };

  describe("operation authority record (DUR-02)", () => {
    it("exists for every operation and its version moves only with authority-relevant changes", async () => {
      const { ws, op } = await seeded();
      const first = await readAuthority(db(), ws, op);
      expect(first).toMatchObject({ version: 1, status: "approved", approvalRound: 0 });
      // a heartbeat-like write that changes no authority column must not move the fence
      await db().query("update platform.operations set updated_at = clock_timestamp() where workspace_id = $1 and id = $2", [ws, op]);
      expect((await readAuthority(db(), ws, op))?.version).toBe(1);
      const moved = await casTransition(db(), { workspaceId: ws, operationId: op, expectedVersion: 1, from: ["approved"], to: "cancelled" });
      expect(moved.ok).toBe(true);
      expect((await readAuthority(db(), ws, op))).toMatchObject({ version: 2, status: "cancelled" });
    });

    it("compare-and-set refuses a stale version, a foreign tenant and a replay without changing anything", async () => {
      const { ws, op } = await seeded();
      const stale = await casTransition(db(), { workspaceId: ws, operationId: op, expectedVersion: 7, from: ["approved"], to: "cancelled" });
      expect(stale).toMatchObject({ ok: false, reason: "version_conflict", authority: { version: 1 } });
      expect((await repos.operations.get(db(), ws, op))?.status).toBe("approved");
      const foreign = await casTransition(db(), { workspaceId: newWorkspace(), operationId: op, expectedVersion: 1, from: ["approved"], to: "cancelled" });
      expect(foreign).toMatchObject({ ok: false, reason: "version_conflict", authority: null });
      expect((await casTransition(db(), { workspaceId: ws, operationId: op, expectedVersion: 1, from: ["approved"], to: "cancelled" })).ok).toBe(true);
      const replay = await casTransition(db(), { workspaceId: ws, operationId: op, expectedVersion: 1, from: ["approved"], to: "cancelled" });
      expect(replay).toMatchObject({ ok: false, reason: "version_conflict", authority: { version: 2 } });
    });

    it("of two independent writers holding the same version exactly one commits", async () => {
      const { ws, op } = await seeded();
      const attempt = (sql: Sql) => casTransition(sql, { workspaceId: ws, operationId: op, expectedVersion: 1, from: ["approved"], to: "cancelled" });
      const results = await Promise.all([attempt(ctx.db), attempt(ctx.db2)]);
      expect(results.filter((r) => r.ok)).toHaveLength(1);
      expect(results.filter((r) => !r.ok && r.reason === "version_conflict")).toHaveLength(1);
      expect((await readAuthority(db(), ws, op))?.version).toBe(2);
    });

    it("a rolled-back transition leaves the version and the operation untouched", async () => {
      const { ws, op } = await seeded();
      await expect(db().tx(async (tx) => {
        const r = await casTransition(tx, { workspaceId: ws, operationId: op, expectedVersion: 1, from: ["approved"], to: "cancelled" });
        expect(r.ok).toBe(true);
        throw new Error("simulated crash before commit");
      })).rejects.toThrow("simulated crash");
      expect(await readAuthority(db(), ws, op)).toMatchObject({ version: 1, status: "approved" });
    });

    it("the projection is derived from the authority record, never stored", async () => {
      const { ws, op } = await seeded();
      expect(await projectOperation(db(), ws, op)).toMatchObject({ source: "operation_authority", authorityVersion: 1, phase: "ready_to_start", unconfirmed: false, cancelRequested: false });
      expect(await projectOperation(db(), newWorkspace(), op)).toBeNull();
      await signalIntent("cancel:" + op, op, ws);
      expect(await projectOperation(db(), ws, op)).toMatchObject({ cancelRequested: true, intents: [{ kind: "workflow_signal", state: "pending" }] });
      await casTransition(db(), { workspaceId: ws, operationId: op, expectedVersion: 1, from: ["approved"], to: "cancelled" });
      expect(await projectOperation(db(), ws, op)).toMatchObject({ authorityVersion: 2, phase: "cancelled" });
    });

    it("maps every authority status to one named phase, including an unconfirmed start", () => {
      const base = { workspaceId: "w", operationId: "o", version: 1, approvalRound: 0, planDigest: null, workflowId: null, fenceToken: null, updatedAt: "" };
      const phase = (status: OperationStatus, start: Parameters<typeof derivePhase>[1] = null) => derivePhase({ ...base, status } as OperationAuthority, start);
      expect(phase("running", { phase: "attempted", runId: null, observedStartAt: null })).toBe("start_attempted_unconfirmed");
      expect(phase("running", { phase: "acknowledged", runId: "r", observedStartAt: "t" })).toBe("running");
      expect(phase("running", { phase: "prepared", runId: null, observedStartAt: null })).toBe("start_recorded");
      expect(phase("uncertain")).toBe("uncertain");
      expect(phase("awaiting_approval")).toBe("pending_decision");
      expect(phase("rejected")).toBe("closed_without_effect");
      expect(phase("succeeded")).toBe("completed");
    });
  });

  describe("intent identity and atomicity (DUR-01)", () => {
    it("is idempotent by key, deterministic across workers, and refuses a different effect under the same key", async () => {
      const { ws, op, intent } = await signalIntent("cancel:idem");
      expect(intent.id).toBe(intentId(ws, "workflow_signal", "cancel:idem"));
      const again = await enqueueIntent(ctx.db2, { workspaceId: ws, operationId: op, kind: "workflow_signal", idempotencyKey: "cancel:idem", payload: { signal: "cancel" } });
      expect(again.id).toBe(intent.id);
      await expectCode(enqueueIntent(db(), { workspaceId: ws, operationId: op, kind: "workflow_signal", idempotencyKey: "cancel:idem", payload: { signal: "approvalRecorded" } }), "conflict");
    });

    it("refuses another tenant's operation, secret material and malformed keys", async () => {
      const { ws, op } = await seeded();
      await expectCode(enqueueIntent(db(), { workspaceId: newWorkspace(), operationId: op, kind: "workflow_signal", idempotencyKey: "cancel:x", payload: {} }), "operation_not_found");
      await expectCode(enqueueIntent(db(), { workspaceId: ws, operationId: op, kind: "workflow_signal", idempotencyKey: "cancel:y", payload: { apiKey: "abc" } }), "secret_material");
      await expectCode(enqueueIntent(db(), { workspaceId: ws, operationId: op, kind: "workflow_signal", idempotencyKey: "bad key!", payload: {} }), "invalid_input");
    });

    it("crash before the deciding transaction commits records no intent", async () => {
      const { ws, op } = await seeded();
      await expect(db().tx(async (tx) => {
        await enqueueIntent(tx, { workspaceId: ws, operationId: op, kind: "workflow_signal", idempotencyKey: "cancel:rolledback", payload: { signal: "cancel" } });
        throw new Error("simulated crash before commit");
      })).rejects.toThrow("simulated crash");
      expect(await getIntent(db(), ws, "workflow_signal", "cancel:rolledback")).toBeNull();
    });

    it("an intent identity cannot be rewritten and a settled intent cannot reopen", async () => {
      const { ws, only, intent } = await signalIntent("cancel:immutable");
      await expect(db().query("update platform.durable_intents set payload = '{\"signal\":\"approvalRecorded\"}'::jsonb where id = $1", [intent.id])).rejects.toThrow();
      const [claimed] = await claimDue(db(), { holder: "t", only });
      expect(await settleIntent(db(), claimed, { kind: "delivered" })).toBe(true);
      await expect(db().query("update platform.durable_intents set state = 'pending', outcome = null, settled_at = null where id = $1", [intent.id])).rejects.toThrow();
      expect((await getIntent(db(), ws, "workflow_signal", "cancel:immutable"))?.state).toBe("delivered");
    });
  });

  describe("concurrency decision reads the authority record (DUR-02)", () => {
    it("an environment is occupied while an operation on it is running, queued or uncertain, and free once it is terminal", async () => {
      const s = await seedApprovedOperation(db());
      const env = s.operation.environmentId!;
      expect(await environmentActivity(db(), s.workspaceId, env)).toEqual([]);
      await db().query("update platform.operations set status = 'queued' where workspace_id = $1 and id = $2", [s.workspaceId, s.operation.id]);
      expect(await environmentActivity(db(), s.workspaceId, env)).toMatchObject([{ operationId: s.operation.id, status: "queued" }]);
      // another tenant never sees it, and another environment is unaffected
      expect(await environmentActivity(db(), newWorkspace(), env)).toEqual([]);
      expect(await environmentActivity(db(), s.workspaceId, "env_other")).toEqual([]);
      await db().query("update platform.operations set status = 'uncertain' where workspace_id = $1 and id = $2", [s.workspaceId, s.operation.id]);
      expect(await environmentActivity(db(), s.workspaceId, env)).toMatchObject([{ status: "uncertain" }]);
      await db().query("update platform.operations set status = 'cancelled' where workspace_id = $1 and id = $2", [s.workspaceId, s.operation.id]);
      expect(await environmentActivity(db(), s.workspaceId, env)).toEqual([]);
    });
  });

  describe("approval wake-up sweep predicate (W9)", () => {
    const ackedStart = (ws: string, op: string) => db().query(
      `insert into platform.workflow_start_intents (workspace_id, operation_id, binding, binding_digest, phase, attempt_id, run_id, observed_start_at, evidence_digest, attempted_at, acknowledged_at)
       values ($1, $2, $3::text::jsonb, $4, 'acknowledged', $5, $5, clock_timestamp(), $4, clock_timestamp(), clock_timestamp())`,
      [ws, op, JSON.stringify({ format: "zenith.workflow-start.v1", arguments: { workspaceId: ws, operationId: op } }), "a".repeat(64), "11111111-1111-4111-8111-111111111111"]);
    const aged = (ws: string, op: string) => db().query(
      "update platform.operation_authority set updated_at = clock_timestamp() - interval '10 minutes' where workspace_id = $1 and operation_id = $2", [ws, op]);
    const eligible = async (over: { start?: boolean; round?: number; plan?: boolean; age?: boolean } = {}) => {
      const { ws, op } = await seeded();
      if (over.start !== false) await ackedStart(ws, op);
      await db().query("update platform.operations set approval_round = $3, plan_digest = $4 where workspace_id = $1 and id = $2",
        [ws, op, over.round ?? 1, over.plan === false ? null : "c".repeat(64)]);
      if (over.age !== false) await aged(ws, op);
      return { ws, op };
    };
    const sweepKey = async (ws: string, op: string) => `approval-sweep:${op}:${(await readAuthority(db(), ws, op))!.version}`;

    it("creates exactly one wake-up for an approved plan round whose workflow is acknowledged and waiting", async () => {
      const { ws, op } = await eligible();
      await deriveApprovalSignals(db());
      const intent = await getIntent(db(), ws, "workflow_signal", await sweepKey(ws, op));
      expect(intent).toMatchObject({ state: "pending", payload: { signal: "approvalRecorded" }, operationId: op });
      await deriveApprovalSignals(db());
      const all = await db().query("select id from platform.durable_intents where workspace_id = $1 and operation_id = $2", [ws, op]);
      expect(all).toHaveLength(1);
    });

    it("does nothing without an acknowledged start, plan round, plan digest, approved/rejected status or quiet period", async () => {
      const cases = [
        await eligible({ start: false }), await eligible({ round: 0 }), await eligible({ plan: false }), await eligible({ age: false }),
      ];
      const running = await eligible();
      await db().query("update platform.operations set status = 'cancelled' where workspace_id = $1 and id = $2", [running.ws, running.op]);
      await aged(running.ws, running.op);
      cases.push(running);
      await deriveApprovalSignals(db());
      for (const c of cases) {
        const rows = await db().query("select id from platform.durable_intents where workspace_id = $1 and operation_id = $2", [c.ws, c.op]);
        expect(rows).toHaveLength(0);
      }
    });

  });

  describe("crash windows with fault injection at each relay boundary", () => {
    it("after the intent commit, before any claim: a later worker delivers it once", async () => {
      const { ws, only, intent } = await signalIntent("cancel:w1");
      const seen: string[] = [];
      const result = await relayOnce(db(), handlers((i) => { seen.push(i.id); return { status: "delivered" }; }), { holder: "late", only });
      expect(result).toMatchObject({ claimed: 1, delivered: 1 });
      expect(seen).toEqual([intent.id]);
      expect(await getIntent(db(), ws, "workflow_signal", "cancel:w1")).toMatchObject({ state: "delivered", outcome: "delivered", claimEpoch: 1 });
    });

    it("after the claim, before transport: the lease lapses and a second worker delivers exactly once", async () => {
      const { ws, only, intent } = await signalIntent("cancel:w2");
      const calls: string[] = [];
      await expect(relayOnce(db(), handlers(() => { calls.push("first"); return { status: "delivered" }; }), {
        holder: "dies", only, faults: { afterClaim: () => { throw new Error("process died after claim"); } },
      })).rejects.toThrow("process died");
      expect(calls).toEqual([]);
      expect(await getIntent(db(), ws, "workflow_signal", "cancel:w2")).toMatchObject({ state: "pending", claimEpoch: 1 });
      // still leased: nobody else may take it yet
      expect((await relayOnce(db(), handlers(() => ({ status: "delivered" })), { holder: "early", only })).claimed).toBe(0);
      await expireLease(db(), intent.id);
      expect((await relayOnce(db(), handlers((i) => { calls.push(i.id); return { status: "delivered" }; }), { holder: "survivor", only })).delivered).toBe(1);
      expect(calls).toEqual([intent.id]);
      expect(await getIntent(db(), ws, "workflow_signal", "cancel:w2")).toMatchObject({ state: "delivered", claimEpoch: 2 });
    });

    it("after transport, before settle: redelivery is at-least-once under the SAME idempotency key", async () => {
      const { ws, only, intent } = await signalIntent("cancel:w3");
      const delivered: string[] = [];
      const transport = handlers((i) => { delivered.push(i.id); return { status: "delivered" }; });
      await expect(relayOnce(db(), transport, {
        holder: "dies", only, faults: { afterDeliver: () => { throw new Error("process died after transport accepted"); } },
      })).rejects.toThrow("process died");
      expect(await getIntent(db(), ws, "workflow_signal", "cancel:w3")).toMatchObject({ state: "pending" });
      await expireLease(db(), intent.id);
      await relayOnce(db(), transport, { holder: "survivor", only });
      // the receiver sees the same intent id twice and deduplicates (Temporal requestId); the row settles once
      expect(delivered).toEqual([intent.id, intent.id]);
      expect(await getIntent(db(), ws, "workflow_signal", "cancel:w3")).toMatchObject({ state: "delivered", claimEpoch: 2 });
    });

    it("a superseded holder cannot settle: only the current claim epoch wins", async () => {
      const { ws, only, intent } = await signalIntent("cancel:w4");
      const [stale] = await claimDue(db(), { holder: "slow", only });
      await expireLease(db(), intent.id);
      const [current] = await claimDue(ctx.db2, { holder: "fast", only });
      expect(current.claimEpoch).toBe(stale.claimEpoch + 1);
      expect(await settleIntent(db(), stale, { kind: "delivered" })).toBe(false);
      expect((await getIntent(db(), ws, "workflow_signal", "cancel:w4"))?.state).toBe("pending");
      expect(await settleIntent(ctx.db2, current, { kind: "delivered" })).toBe(true);
      expect(await settleIntent(db(), current, { kind: "delivered" })).toBe(false);
    });

    it("concurrent relays never deliver one row at the same time", async () => {
      const { only } = await signalIntent("cancel:w5");
      let inFlight = 0, peak = 0, total = 0;
      const slow = handlers(async () => {
        total++; inFlight++; peak = Math.max(peak, inFlight);
        await new Promise((r) => setTimeout(r, 50));
        inFlight--;
        return { status: "delivered" };
      });
      await Promise.all([
        relayOnce(ctx.db, slow, { holder: "a", only }),
        relayOnce(ctx.db2, slow, { holder: "b", only }),
      ]);
      expect(peak).toBe(1);
      expect(total).toBe(1);
    });

    it("a rejected or failing transport backs off and retries, then dies visibly instead of looping forever", async () => {
      const { ws, only, intent } = await signalIntent("cancel:w6");
      let calls = 0;
      const failing = handlers(() => { calls++; return { status: "retry", code: "temporal_unavailable" }; });
      for (let i = 0; i < MAX_ATTEMPTS; i++) {
        await makeDue(db(), intent.id);
        await relayOnce(db(), failing, { holder: "r" + i, only });
      }
      expect(calls).toBe(MAX_ATTEMPTS);
      expect(await getIntent(db(), ws, "workflow_signal", "cancel:w6")).toMatchObject({ state: "dead", outcome: "exhausted", lastErrorCode: "temporal_unavailable" });
      expect((await projectOperation(db(), ws, intent.operationId))?.unconfirmed).toBe(true);
    });

    it("a handler that throws is a retry, never a lost intent", async () => {
      const { ws, only } = await signalIntent("cancel:w7");
      const result = await relayOnce(db(), handlers(() => { throw new Error("boom"); }), { holder: "x", only });
      expect(result).toMatchObject({ retried: 1, delivered: 0 });
      expect(await getIntent(db(), ws, "workflow_signal", "cancel:w7")).toMatchObject({ state: "pending", lastErrorCode: "handler_error" });
    });

    it("signals to a workflow that is not visible retry a bounded number of times, then settle as not_found", async () => {
      const { ws, only, intent } = await signalIntent("cancel:w8");
      for (let i = 0; i < 5; i++) {
        await makeDue(db(), intent.id);
        await relayOnce(db(), handlers(() => ({ status: "not_found" })), { holder: "n" + i, only });
      }
      expect(await getIntent(db(), ws, "workflow_signal", "cancel:w8")).toMatchObject({ state: "dead", outcome: "not_found" });
    });

    it("a refused delivery is terminal evidence, not a retry", async () => {
      const { ws, only } = await signalIntent("cancel:w9");
      const result = await relayOnce(db(), handlers(() => ({ status: "refused" })), { holder: "x", only });
      expect(result).toMatchObject({ dead: 1, retried: 0 });
      expect(await getIntent(db(), ws, "workflow_signal", "cancel:w9")).toMatchObject({ state: "dead", outcome: "refused" });
    });
  });

  describe("cancel requested, dies before the signal (W13)", () => {
    it("the cancel intent is committed first; a crash before any relay pass leaves one pending row, a repeat request adds none, a later pass settles it once", async () => {
      const { ws, op } = await seeded();
      const key = `cancel:${op}`;
      // same commit the bridge makes before any transport (deps.ts cancelOperation -> signalDurably -> enqueueIntent); no relay pass runs: the crash
      const intent = await enqueueIntent(db(), { workspaceId: ws, operationId: op, kind: "workflow_signal", idempotencyKey: key, payload: { signal: "cancel" } });
      const cancelRows = () => db().query(
        "select id, state, outcome from platform.durable_intents where workspace_id = $1 and operation_id = $2 and kind = 'workflow_signal' and idempotency_key like 'cancel:%'", [ws, op]);
      expect(await cancelRows()).toEqual([{ id: intent.id, state: "pending", outcome: null }]);
      // the read model reports the request while the authority is still untouched
      expect(await projectOperation(db(), ws, op)).toMatchObject({
        cancelRequested: true, unconfirmed: false, phase: "ready_to_start", authorityVersion: 1,
        intents: [{ id: intent.id, kind: "workflow_signal", idempotencyKey: key, state: "pending" }],
      });
      // a second cancel request for the same operation, from the other connection, attaches to the same intent
      const again = await enqueueIntent(ctx.db2, { workspaceId: ws, operationId: op, kind: "workflow_signal", idempotencyKey: key, payload: { signal: "cancel" } });
      expect(again.id).toBe(intent.id);
      expect(await cancelRows()).toHaveLength(1);
      // a later relay pass (the runner-reaper relay) delivers it once through the fake transport
      const seen: string[] = [];
      const only = { workspaceId: ws, id: intent.id };
      expect(await relayOnce(db(), handlers((i) => { seen.push(i.id); return { status: "delivered" }; }), { holder: "relay", only })).toMatchObject({ claimed: 1, delivered: 1 });
      expect(seen).toEqual([intent.id]);
      expect(await getIntent(db(), ws, "workflow_signal", key)).toMatchObject({ state: "delivered", outcome: "delivered" });
      expect((await relayOnce(db(), handlers((i) => { seen.push(i.id); return { status: "delivered" }; }), { holder: "again", only })).claimed).toBe(0);
      expect(seen).toEqual([intent.id]);
      expect(await projectOperation(db(), ws, op)).toMatchObject({ cancelRequested: true, intents: [{ state: "delivered" }] });
    });
  });
});
