/**
 * PROD-OPS-04: recovery epochs and operator continuation.
 *
 * Engines: a fresh PGlite store always; a brand-new scratch PostgreSQL database (never the shared platform
 * schema, because a bump lifts every fence counter) when ZENITH_TEST_PLATFORM_PG_URL is set. A "restore" is
 * simulated the way it appears to the code: rows written before the bump keep the pre-bump epoch stamp, and the
 * tests rewind consumed-ness by hand (`consumed_at = null`) exactly as a restored backup would present it.
 *
 * Every assertion is scoped to the test's own workspace: the engine is shared by the tests in this file and a bump
 * is database-wide by design.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as repos from "@/lib/controlplane/db/repos";
import { openPlatformDb, type PlatformDbHandle } from "@/lib/controlplane/db";
import { claimDue, enqueueIntent, settleIntent } from "@/lib/controlplane/outbox";
import {
  bumpRecoveryEpoch, currentRecoveryEpoch, decideItem, operationPredatesRestore, epochOfFence, fenceFloor, getRecoveryItem, listRecoveryItems, recoveryItemId, recoveryStatus,
  type RecoveryDecision, type RecoveryItem,
} from "@/lib/controlplane/recovery";
import type { Sql } from "@/lib/controlplane/types";
import { PG_URL, approve, expectCode, newWorkspace, seedApprovedOperation, seedAwaitingApproval, uid, user } from "./_support/harness";
import { openMigratedScratchDatabase } from "./_support/scratch-db";

interface Engine { name: string; open(): Promise<{ db: PlatformDbHandle; close(): Promise<void> }> }

const ENGINES: Engine[] = [
  { name: "pglite", open: async () => { const db = await openPlatformDb({ kind: "pglite" }); return { db, close: () => db.close() }; } },
  ...(PG_URL ? [{ name: "postgres (scratch database)", open: openMigratedScratchDatabase }] : []),
];

const runId = (): string => `restore-${randomUUID()}`;
const bump = (db: Sql, over: Partial<Parameters<typeof bumpRecoveryEpoch>[1]> = {}) =>
  bumpRecoveryEpoch(db, { restoreRunId: runId(), actor: "operator:test", reason: "rehearsal restore", ...over });
const itemFor = async (db: Sql, ws: string, kind: "operation" | "intent" | "effect", ref: string): Promise<RecoveryItem> => {
  const found = (await listRecoveryItems(db, ws, { limit: 500 })).find((i) => i.kind === kind && i.ref === ref);
  if (!found) throw new Error(`no recovery item for ${kind} ${ref}`);
  return found;
};
const decide = (db: Sql, item: RecoveryItem, decision: RecoveryDecision, over: { binding?: string; workspaceId?: string; actor?: string } = {}) =>
  decideItem(db, { workspaceId: over.workspaceId ?? item.workspaceId, itemId: item.id, decision, actor: over.actor ?? "user:admin-1", reason: "reviewed after the restore", bindingDigest: over.binding ?? item.bindingDigest });

describe.each(ENGINES)("recovery epochs [$name]", (engine) => {
  let ctx: Awaited<ReturnType<Engine["open"]>>;
  beforeAll(async () => { ctx = await engine.open(); }, 120_000);
  afterAll(async () => { await ctx.close(); }, 60_000);
  const db = (): Sql => ctx.db;

  describe("fences carry the epoch", () => {
    it("a fresh database is at epoch 0 and tokens start at the floor", async () => {
      expect(fenceFloor(0)).toBe(1);
      expect(epochOfFence(1)).toBe(0);
      expect(epochOfFence(fenceFloor(3))).toBe(3);
      expect(epochOfFence(fenceFloor(3) - 1)).toBe(2);
      const e = await currentRecoveryEpoch(db());
      const lease = await repos.leases.acquire(db(), { scope: `env:${uid("env")}`, holder: "w1", ttlMs: 60_000 });
      expect(lease?.fenceToken).toBeGreaterThanOrEqual(fenceFloor(e));
    });

    it("a restore expires every lease; a pre-restore token never equals a live fence again", async () => {
      const scope = `env:${uid("env")}`;
      const before = await currentRecoveryEpoch(db());
      const old = (await repos.leases.acquire(db(), { scope, holder: "survivor", ttlMs: 600_000 }))!;
      await db().tx((tx) => repos.leases.assertFence(tx, scope, old.fenceToken));
      const result = await bump(db());
      expect(result.epoch).toBeGreaterThan(before);
      expect(result.replayed).toBe(false);
      // the surviving worker's token is refused, even though its row still exists
      await expect(db().tx((tx) => repos.leases.assertFence(tx, scope, old.fenceToken))).rejects.toMatchObject({ code: "lease_lost" });
      expect(await repos.leases.renew(db(), old, 60_000)).toBeNull();
      // the next holder's token carries the new epoch and is higher than anything issued before
      const next = (await repos.leases.acquire(db(), { scope, holder: "survivor", ttlMs: 60_000 }))!;
      expect(next.fenceToken).toBeGreaterThanOrEqual(fenceFloor(result.epoch));
      expect(epochOfFence(next.fenceToken)).toBe(result.epoch);
      expect(next.fenceToken).toBeGreaterThan(old.fenceToken);
      // a scope first seen after the restore starts at the floor, not at 1 (the token 1 of the lost timeline stays dead)
      const fresh = (await repos.leases.acquire(db(), { scope: `env:${uid("env")}`, holder: "w2", ttlMs: 60_000 }))!;
      expect(fresh.fenceToken).toBe(fenceFloor(result.epoch));
      await expect(db().tx((tx) => repos.leases.assertFence(tx, fresh.scope, 1))).rejects.toMatchObject({ code: "lease_lost" });
    });
  });

  describe("the epoch itself", () => {
    it("is append-only, monotonic and idempotent per restore run", async () => {
      const id = runId();
      const first = await bumpRecoveryEpoch(db(), { restoreRunId: id, actor: "operator:a", reason: "first" });
      const again = await bumpRecoveryEpoch(db(), { restoreRunId: id, actor: "operator:a", reason: "first" });
      expect(again).toMatchObject({ epoch: first.epoch, replayed: true });
      expect(await currentRecoveryEpoch(db())).toBe(first.epoch);
      const second = await bump(db());
      expect(second.epoch).toBe(first.epoch + 1);
      await expectRejection(db().query("update platform.recovery_epochs set reason = 'x' where epoch = $1", [second.epoch]));
      await expectRejection(db().query("delete from platform.recovery_epochs where epoch = $1", [second.epoch]));
    });

    it("jumps past the highest epoch learned outside the database or recorded in the backup", async () => {
      const base = await currentRecoveryEpoch(db());
      const jumped = await bump(db(), { observedEpoch: base + 5 });
      expect(jumped.epoch).toBe(base + 6);
      const fromManifest = await bump(db(), { manifestEpoch: jumped.epoch + 3 });
      expect(fromManifest.epoch).toBe(jumped.epoch + 4);
      await expectCode(bumpRecoveryEpoch(db(), { restoreRunId: "x", actor: "a", reason: "r" }), "invalid_input");
      await expectCode(bumpRecoveryEpoch(db(), { restoreRunId: runId(), actor: "a", reason: "r", observedEpoch: 9001 }), "invalid_input");
    });
  });

  describe("approvals cannot resurrect", () => {
    it("an approval granted before the restore never authorizes execution", async () => {
      const awaiting = await seedAwaitingApproval(db());
      const ws = awaiting.workspaceId;
      const approved = await approve(db(), awaiting, user("approver-1"));
      expect(approved.operation.status).toBe("approved");
      expect(await operationPredatesRestore(db(), ws, awaiting.operation.id)).toBe(false);
      await bump(db());
      expect(await operationPredatesRestore(db(), ws, awaiting.operation.id)).toBe(true);
      const details = await expectCode(repos.operations.claimForExecution(db(), { workspaceId: ws, id: awaiting.operation.id, expectedDigest: awaiting.operation.proposalDigest, holder: "w" }), "invalid_state");
      expect(details).toMatchObject({ reason: "recovery_epoch_stale" });
      expect((await repos.operations.get(db(), ws, awaiting.operation.id))?.status).toBe("approved");
      // the stale approval is invisible to the single-use gate as well
      expect(await repos.approvals.consume(db(), { workspaceId: ws, operationId: awaiting.operation.id, proposalDigest: awaiting.operation.proposalDigest })).toEqual([]);
    });

    it("a consumed approval that the restore made look unused cannot be used again; only a fresh round in the new epoch runs", async () => {
      const awaiting = await seedAwaitingApproval(db());
      const ws = awaiting.workspaceId, op = awaiting.operation.id, digest = awaiting.operation.proposalDigest;
      await approve(db(), awaiting, user("approver-1"));
      // The lost timeline claimed (consumed) the approval and ran. The backup predates that: rewind it by hand.
      await repos.operations.claimForExecution(db(), { workspaceId: ws, id: op, expectedDigest: digest, holder: "worker:lost" });
      await db().query("update platform.approvals set consumed_at = null where workspace_id = $1 and operation_id = $2", [ws, op]);
      await db().query("update platform.operations set status = 'approved', lease_holder = null, lease_until = null where workspace_id = $1 and id = $2", [ws, op]);

      await bump(db());
      await expectCode(repos.operations.claimForExecution(db(), { workspaceId: ws, id: op, expectedDigest: digest, holder: "worker:new" }), "invalid_state");

      // A person decides. Resume reopens with a FRESH approval round; the old approval stays void.
      const item = await itemFor(db(), ws, "operation", op);
      expect(item).toMatchObject({ priorState: "approved", state: "pending", allowed: ["resume", "abandon"] });
      const roundBefore = (item.subject as { approvalRound: number }).approvalRound;
      const resumed = await decide(db(), item, "resume");
      expect(resumed).toMatchObject({ state: "resumed", decidedBy: "user:admin-1" });
      const reopened = (await repos.operations.get(db(), ws, op))!;
      expect(reopened.status).toBe("awaiting_approval");
      expect(await approvalRoundOf(db(), ws, op)).toBe(roundBefore + 1);
      await expectCode(repos.operations.claimForExecution(db(), { workspaceId: ws, id: op, expectedDigest: digest, holder: "worker:new" }), "invalid_state");

      // Someone approves again in the new epoch; only then may it run, exactly once.
      const second = await repos.approvals.record(db(), { workspaceId: ws, operationId: op, approver: user("approver-2"), approverRole: "editor", decision: "approve", proposalDigest: digest, policyVersion: "a".repeat(64) });
      expect(second.operation.status).toBe("approved");
      const claimed = await repos.operations.claimForExecution(db(), { workspaceId: ws, id: op, expectedDigest: digest, holder: "worker:new" });
      expect(claimed.status).toBe("running");
      await expectCode(repos.operations.claimForExecution(db(), { workspaceId: ws, id: op, expectedDigest: digest, holder: "worker:other" }), "invalid_state");
    });

    it("an operation restored while awaiting approval cannot be approved or rejected until reopened", async () => {
      const awaiting = await seedAwaitingApproval(db());
      await bump(db());
      const details = await expectCode(approve(db(), awaiting, user("approver-1")), "invalid_state");
      expect(details).toMatchObject({ reason: "recovery_epoch_stale" });
      const item = await itemFor(db(), awaiting.workspaceId, "operation", awaiting.operation.id);
      await decide(db(), item, "resume");
      const approved = await approve(db(), awaiting, user("approver-2"));
      expect(approved.operation.status).toBe("approved");
    });

    it("abandon cancels an operation that was held", async () => {
      const seeded = await seedApprovedOperation(db());
      await bump(db());
      const item = await itemFor(db(), seeded.workspaceId, "operation", seeded.operation.id);
      await decide(db(), item, "abandon");
      expect((await repos.operations.get(db(), seeded.workspaceId, seeded.operation.id))?.status).toBe("cancelled");
    });
  });

  describe("running work and external effects stay uncertain", () => {
    it("a restored running operation becomes uncertain and can only be acknowledged", async () => {
      const seeded = await seedApprovedOperation(db());
      const ws = seeded.workspaceId, op = seeded.operation.id;
      const running = await repos.operations.claimForExecution(db(), { workspaceId: ws, id: op, expectedDigest: seeded.operation.proposalDigest, holder: "worker:lost", leaseMs: 600_000 });
      expect(running.status).toBe("running");
      await bump(db());
      expect((await repos.operations.get(db(), ws, op))?.status).toBe("uncertain");
      const item = await itemFor(db(), ws, "operation", op);
      expect(item).toMatchObject({ priorState: "running", allowed: ["keep_uncertain"] });
      await expectCode(decide(db(), item, "resume"), "invalid_state");
      await expectCode(decide(db(), item, "abandon"), "invalid_state");
      const kept = await decide(db(), item, "keep_uncertain");
      expect(kept.state).toBe("kept_uncertain");
      expect((await repos.operations.get(db(), ws, op))?.status).toBe("uncertain");
    });

    it("a pending effect becomes uncertain; the same identity is never created twice; a late receipt is evidence only", async () => {
      const seeded = await seedApprovedOperation(db());
      const ws = seeded.workspaceId, op = seeded.operation.id;
      const begin = (key: string) => repos.externalEffects.begin(db(), { workspaceId: ws, family: "build_launch", operationId: op, provider: "aws", dedupKey: key, requestDigest: "c".repeat(64), idempotencySupported: false, actor: "test" });
      const pending = (await begin("svc:a")).effect;
      const accepted = (await begin("svc:b")).effect;
      await repos.externalEffects.recordAccepted(db(), { workspaceId: ws, effectId: accepted.effectId, receipt: { requestIds: ["req-1"], resourceId: "build-1" }, actor: "test" });
      await bump(db());

      const afterPending = (await repos.externalEffects.get(db(), ws, pending.effectId))!;
      expect(afterPending.state).toBe("uncertain");
      expect(afterPending.stateReason).toMatch(/restored from a backup/i);
      expect((await repos.externalEffects.get(db(), ws, accepted.effectId))?.state).toBe("accepted");
      const events = await repos.externalEffects.listEvents(db(), ws, pending.effectId);
      expect(events.map((e) => e.kind)).toContain("recovery_epoch");

      const replay = await begin("svc:a");
      expect(replay.created).toBe(false);
      expect(replay.effect.effectId).toBe(pending.effectId);
      expect(replay.effect.state).toBe("uncertain");

      const late = await repos.externalEffects.recordAccepted(db(), { workspaceId: ws, effectId: pending.effectId, receipt: { requestIds: ["req-late"], resourceId: "build-late" }, actor: "test" });
      expect(late.state).toBe("uncertain");
      expect(late.lateReceipt).not.toBeNull();

      const items = (await listRecoveryItems(db(), ws, { limit: 500 })).filter((i) => i.kind === "effect");
      expect(items.map((i) => i.priorState).sort()).toEqual(["accepted", "pending"]);
      for (const item of items) {
        expect(item.allowed).toEqual(["keep_uncertain"]);
        await expectCode(decide(db(), item, "resume"), "invalid_state");
      }
      const acknowledged = await decide(db(), (await itemFor(db(), ws, "effect", pending.effectId)), "keep_uncertain");
      expect(acknowledged.state).toBe("kept_uncertain");
      expect((await repos.externalEffects.get(db(), ws, pending.effectId))?.state).toBe("uncertain");
    });

    it("unconsumed capability grants are revoked, consumed ones are left alone", async () => {
      const seeded = await seedApprovedOperation(db());
      const ws = seeded.workspaceId, op = seeded.operation.id;
      const issuedAt = new Date().toISOString(), expiresAt = new Date(Date.now() + 10 * 60_000).toISOString();
      const grant = (jti: string) => repos.grants.insert(db(), { jti, workspaceId: ws, operationId: op, capability: "infrastructure.plan", audience: "worker", issuedAt, expiresAt });
      const open = uid("jti"), used = uid("jti");
      await grant(open);
      await grant(used);
      expect(await repos.grants.consume(db(), { workspaceId: ws, jti: used })).toBe(true);
      await bump(db());
      expect(await repos.grants.status(db(), ws, open)).toBe("revoked");
      expect(await repos.grants.status(db(), ws, used)).toBe("consumed");
    });
  });

  describe("intents and the continuation decision", () => {
    it("a restored pending intent is not claimable until a person resumes it; abandon supersedes it", async () => {
      const seeded = await seedApprovedOperation(db());
      const ws = seeded.workspaceId, op = seeded.operation.id;
      const kept = await enqueueIntent(db(), { workspaceId: ws, operationId: op, kind: "workflow_signal", idempotencyKey: "approval:1", payload: { signal: "approvalRecorded" } });
      const dropped = await enqueueIntent(db(), { workspaceId: ws, operationId: op, kind: "workflow_signal", idempotencyKey: "cancel:op", payload: { signal: "cancel" } });
      await bump(db());

      expect(await claimDue(db(), { holder: "relay-1", only: { workspaceId: ws, id: kept.id } })).toEqual([]);
      // an intent created after the restore is stamped with the new epoch and flows normally
      const fresh = await enqueueIntent(db(), { workspaceId: ws, operationId: op, kind: "workflow_signal", idempotencyKey: "after-restore", payload: { signal: "approvalRecorded" } });
      expect(await claimDue(db(), { holder: "relay-1", only: { workspaceId: ws, id: fresh.id } })).toHaveLength(1);

      const keptItem = await itemFor(db(), ws, "intent", kept.id);
      expect(keptItem.allowed).toEqual(["resume", "abandon"]);
      await decide(db(), keptItem, "resume");
      expect(await claimDue(db(), { holder: "relay-1", only: { workspaceId: ws, id: kept.id } })).toHaveLength(1);

      const droppedItem = await itemFor(db(), ws, "intent", dropped.id);
      await decide(db(), droppedItem, "abandon");
      expect(await claimDue(db(), { holder: "relay-1", only: { workspaceId: ws, id: dropped.id } })).toEqual([]);
      const row = (await db().query<{ state: string; outcome: string }>("select state, outcome from platform.durable_intents where id = $1", [dropped.id]))[0];
      expect(row).toMatchObject({ state: "dead", outcome: "superseded" });
    });

    it("a claim taken before the restore cannot settle after it", async () => {
      const seeded = await seedApprovedOperation(db());
      const ws = seeded.workspaceId, op = seeded.operation.id;
      const intent = await enqueueIntent(db(), { workspaceId: ws, operationId: op, kind: "workflow_signal", idempotencyKey: "pre-claim", payload: { signal: "approvalRecorded" } });
      const [claimed] = await claimDue(db(), { holder: "relay-lost", only: { workspaceId: ws, id: intent.id } });
      expect(claimed).toBeDefined();
      await bump(db());
      expect(await settleIntent(db(), claimed!, { kind: "delivered" })).toBe(false);
      expect((await db().query<{ state: string }>("select state from platform.durable_intents where id = $1", [intent.id]))[0]?.state).toBe("pending");
    });

    it("binds to the exact state reviewed, one tenant at a time, once", async () => {
      const seeded = await seedApprovedOperation(db());
      const ws = seeded.workspaceId, op = seeded.operation.id;
      await bump(db());
      const item = await itemFor(db(), ws, "operation", op);
      expect(item.id).toBe(recoveryItemId(item.epoch, ws, "operation", op));
      await expectCode(decide(db(), item, "abandon", { binding: "0".repeat(64) }), "digest_mismatch");
      await expectCode(decide(db(), item, "abandon", { workspaceId: newWorkspace() }), "not_found");
      expect(await getRecoveryItem(db(), newWorkspace(), item.id)).toBeNull();
      expect((await listRecoveryItems(db(), newWorkspace())).length).toBe(0);
      // the subject changes after the person looked (someone cancelled it): the reviewed digest is no longer valid
      await repos.operations.transition(db(), { workspaceId: ws, id: op, from: ["approved"], to: "cancelled" });
      await expectCode(decide(db(), item, "abandon"), "digest_mismatch");
      const current = await itemFor(db(), ws, "operation", op);
      await decide(db(), current, "abandon");
      await expectCode(decide(db(), current, "abandon"), "conflict");
      const status = await recoveryStatus(db(), ws);
      expect(status).toMatchObject({ pending: 0, decided: 1 });
      expect(status.epoch).toBe(await currentRecoveryEpoch(db()));
    });

    it("refuses to resume what must not be replayed: an operation with unresolved effects", async () => {
      const seeded = await seedApprovedOperation(db());
      const ws = seeded.workspaceId, op = seeded.operation.id;
      await repos.externalEffects.begin(db(), { workspaceId: ws, family: "build_launch", operationId: op, provider: "aws", dedupKey: "svc:x", requestDigest: "d".repeat(64), idempotencySupported: false, actor: "test" });
      await bump(db());
      const item = await itemFor(db(), ws, "operation", op);
      expect(item.resumeBlockedBy.join(" ")).toMatch(/unresolved/);
      const details = await expectCode(decide(db(), item, "resume"), "invalid_state");
      expect(details).toMatchObject({ reason: "resume_blocked" });
      // the person can still abandon it
      await decide(db(), item, "abandon");
    });
  });
});

async function approvalRoundOf(db: Sql, ws: string, op: string): Promise<number> {
  return Number((await db.query<{ r: number | string }>("select approval_round as r from platform.operations where workspace_id = $1 and id = $2", [ws, op]))[0]?.r);
}

async function expectRejection(promise: Promise<unknown>): Promise<void> {
  let rejected = false;
  try { await promise; } catch { rejected = true; }
  expect(rejected).toBe(true);
}
