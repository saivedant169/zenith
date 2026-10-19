/**
 * The service layer: withLease (renewal, abort on loss, release), the
 * operation lifecycle helpers that commit ledger changes together with their
 * events, the reconciler, and the idempotency wrapper.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import * as repos from "@/lib/controlplane/db/repos";
import { IdempotencyConflictError } from "@/lib/controlplane/db";
import { LeaseLostError, type Lease, type Sql } from "@/lib/controlplane/types";
import { LeaseUnavailableError, withLease } from "@/lib/controlplane/leases";
import { decide } from "@/lib/controlplane/approvals";
import { emitForOperation, newCorrelationId } from "@/lib/controlplane/events";
import { withIdempotency } from "@/lib/controlplane/idempotency";
import {
  cancelOperation,
  claimOperation,
  completeOperation,
  proposeOperation,
  reconcileOperations,
  recordPolicyOutcome,
} from "@/lib/controlplane/operations";
import { LANES, backdate, expectCode, newWorkspace, openLane, proposalFor, seedApprovedOperation, seedAwaitingApproval, uid, user } from "./_support/harness";

describe.each(LANES)("services [$name]", (lane) => {
  let ctx: Awaited<ReturnType<typeof openLane>>;
  beforeAll(async () => {
    ctx = await openLane(lane);
  }, 60_000);
  afterAll(async () => {
    await ctx.close();
  });
  const db = () => ctx.db;
  const scope = (): string => `env:${uid("env")}`;

  describe("withLease", () => {
    it("runs under the lease, hands fn the lease and a live signal, and releases afterwards", async () => {
      const s = scope();
      const [floor] = await db().query<{ fence_token: number }>("select platform.recovery_fence_floor() as fence_token");
      expect(Number.isSafeInteger(floor.fence_token)).toBe(true);
      const value = await withLease(db(), { scope: s, holder: "worker-a", ttlMs: 5_000 }, async (lease, signal) => {
        expect(lease).toMatchObject({ scope: s, holder: "worker-a", fenceToken: floor.fence_token });
        expect(signal.aborted).toBe(false);
        expect((await repos.leases.current(db(), s))?.holder).toBe("worker-a");
        return "done";
      });
      expect(value).toBe("done");
      expect(await repos.leases.current(db(), s)).toBeNull();
    });

    it("refuses when another holder has the scope (LeaseUnavailableError), without running fn", async () => {
      const s = scope();
      await repos.leases.acquire(db(), { scope: s, holder: "other", ttlMs: 30_000 });
      let ran = false;
      const err = await withLease(db(), { scope: s, holder: "me", ttlMs: 5_000 }, async () => {
        ran = true;
      }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(LeaseUnavailableError);
      expect((err as LeaseUnavailableError).code).toBe("lease_unavailable");
      expect(ran).toBe(false);
      expect((await repos.leases.current(db(), s))?.holder).toBe("other"); // untouched
    });

    it("keeps renewing while fn runs: a short lease outlives its ttl and nobody can take it", async () => {
      const s = scope();
      let stolen: Lease | null | undefined;
      await withLease(db(), { scope: s, holder: "worker-a", ttlMs: 2_000, renewEveryMs: 250 }, async (initialLease, signal) => {
        const started = performance.now();
        const { holder, fenceToken, expiresAt: initialExpiry } = initialLease;
        let previousExpiry = initialExpiry;
        const waitUntilElapsed = async (elapsedMs: number): Promise<void> => {
          const deadline = started + elapsedMs;
          while (performance.now() < deadline) {
            const remainingMs = deadline - performance.now();
            await new Promise<void>((resolve, reject) => {
              const timer = setTimeout(() => {
                signal.removeEventListener("abort", onAbort);
                resolve();
              }, remainingMs);
              const onAbort = (): void => {
                clearTimeout(timer);
                signal.removeEventListener("abort", onAbort);
                reject(signal.reason ?? new Error("Lease lost before renewal milestone"));
              };
              signal.addEventListener("abort", onAbort, { once: true });
              if (signal.aborted) onAbort();
            });
          }
        };
        const expectRenewedLease = async (): Promise<void> => {
          const current = await repos.leases.current(db(), s);
          expect(current).toMatchObject({
            scope: s,
            holder,
            fenceToken,
          });
          expect(Date.parse(current!.expiresAt)).toBeGreaterThan(Date.parse(previousExpiry));
          previousExpiry = current!.expiresAt;
        };

        await waitUntilElapsed(2_100);
        expect(performance.now() - started).toBeGreaterThanOrEqual(2_100);
        await expectRenewedLease();
        await waitUntilElapsed(4_200);
        expect(performance.now() - started).toBeGreaterThanOrEqual(4_200);
        await expectRenewedLease();

        stolen = await repos.leases.acquire(db(), { scope: s, holder: "thief", ttlMs: 5_000 });
        expect(signal.aborted).toBe(false);
      });
      expect(stolen).toBeNull();
      expect(await repos.leases.current(db(), s)).toBeNull();
    }, 8_000);

    it("aborts the signal when the lease is taken over, and throws LeaseLostError even if fn returns normally", async () => {
      const s = scope();
      let abortedWith: unknown;
      const err = await withLease(db(), { scope: s, holder: "worker-a", ttlMs: 2_000, renewEveryMs: 60 }, async (lease, signal) => {
        await backdate(db(), "leases", "expires_at", s, "scope");
        const taker = await repos.leases.acquire(db(), { scope: s, holder: "worker-b", ttlMs: 30_000 });
        expect(taker?.fenceToken).toBe(lease.fenceToken + 1);
        await new Promise<void>((resolve) => {
          if (signal.aborted) resolve();
          else signal.addEventListener("abort", () => resolve(), { once: true });
        });
        abortedWith = signal.reason;
        return "fn finished normally";
      }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(LeaseLostError);
      expect(abortedWith).toBeInstanceOf(LeaseLostError);
      // the loser must not release the winner's lease
      expect((await repos.leases.current(db(), s))?.holder).toBe("worker-b");
    });

    it("stops before the lease lapses when the database becomes unreachable (two thirds of the ttl)", async () => {
      const s = scope();
      const flaky: Sql = {
        query: <T>(text: string, params?: readonly unknown[]) =>
          text.includes("greatest(expires_at") ? Promise.reject(new Error("connection reset")) : db().query<T>(text, params),
        tx: (fn) => db().tx(fn),
      };
      const started = Date.now();
      const err = await withLease(flaky, { scope: s, holder: "worker-a", ttlMs: 600, renewEveryMs: 50 }, async (_l, signal) => {
        await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
        return "never used";
      }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(LeaseLostError);
      expect(Date.now() - started).toBeLessThan(600); // aborted before the DB lease could expire
    });

    it("propagates an outer abort into the inner signal and releases when fn throws", async () => {
      const s = scope();
      const outer = new AbortController();
      const boom = new Error("fn failed");
      const err = await withLease(db(), { scope: s, holder: "w", ttlMs: 5_000, signal: outer.signal }, async (_l, signal) => {
        outer.abort(new Error("workflow cancelled"));
        expect(signal.aborted).toBe(true);
        throw boom;
      }).catch((e: unknown) => e);
      expect(err).toBe(boom);
      expect(await repos.leases.current(db(), s)).toBeNull();
    });

    it("uses an unref'd timer so a forgotten lease never keeps the process alive", async () => {
      const spy = vi.spyOn(globalThis, "setInterval");
      try {
        await withLease(db(), { scope: scope(), holder: "w", ttlMs: 5_000 }, async () => undefined);
        const timer = spy.mock.results[0]?.value as { hasRef?: () => boolean } | undefined;
        expect(timer?.hasRef?.()).toBe(false);
      } finally {
        spy.mockRestore();
      }
    });

    it("appends lease.acquired and lease.released events when asked to audit", async () => {
      const ws = newWorkspace();
      const correlationId = newCorrelationId();
      const [floor] = await db().query<{ fence_token: number }>("select platform.recovery_fence_floor() as fence_token");
      expect(Number.isSafeInteger(floor.fence_token)).toBe(true);
      await withLease(db(), { scope: scope(), holder: "w", ttlMs: 5_000, workspaceId: ws, audit: { workspaceId: ws, correlationId, environmentId: "env_1" } }, async () => undefined);
      const events = await repos.events.list(db(), ws, { correlationId });
      expect(events.map((e) => e.type)).toEqual(["lease.acquired", "lease.released"]);
      expect(events[0].data).toMatchObject({ holder: "w", fenceToken: floor.fence_token });
    });
  });

  describe("operation lifecycle", () => {
    it("policy outcomes move a proposed operation and record the decision + events atomically", async () => {
      const ws = newWorkspace();
      const decision = (outcome: "allow" | "deny" | "require_approval") => ({
        policyVersion: "a".repeat(64),
        inputDigest: "b".repeat(64),
        outcome,
        reasons: [{ code: `r_${outcome}`, message: outcome }],
        ...(outcome === "require_approval" ? { approval: { count: 1, minRole: "editor" as const, separationOfDuties: false } } : {}),
      });
      const propose = async () => (await proposeOperation(db(), { workspaceId: ws, principal: user(), proposal: proposalFor(ws) })).operation;

      const allowed = await propose();
      const a = await recordPolicyOutcome(db(), { workspaceId: ws, operationId: allowed.id, decision: decision("allow") });
      expect(a?.operation).toMatchObject({ status: "approved", approvalRequired: false, policyDecisionId: a?.decision.id });

      const denied = await propose();
      const d = await recordPolicyOutcome(db(), { workspaceId: ws, operationId: denied.id, decision: decision("deny") });
      expect(d?.operation.status).toBe("denied");
      expect(d?.operation.finishedAt).toBeDefined();

      const needs = await propose();
      const n = await recordPolicyOutcome(db(), { workspaceId: ws, operationId: needs.id, decision: decision("require_approval") });
      expect(n?.operation).toMatchObject({ status: "awaiting_approval", approvalRequired: true });

      const types = async (id: string) => (await repos.events.list(db(), ws, { operationId: id })).map((e) => e.type);
      expect(await types(allowed.id)).toEqual(["operation.proposed", "policy.evaluated", "operation.approved"]);
      expect(await types(denied.id)).toEqual(["operation.proposed", "policy.evaluated", "operation.denied"]);
      expect(await types(needs.id)).toEqual(["operation.proposed", "policy.evaluated"]);

      // an operation that has already left `proposed` is not re-decided, and no stray decision row is left
      expect(await recordPolicyOutcome(db(), { workspaceId: ws, operationId: allowed.id, decision: decision("deny") })).toBeNull();
      expect(await repos.policyDecisions.listForOperation(db(), ws, allowed.id)).toHaveLength(1);
      expect((await repos.operations.get(db(), ws, allowed.id))?.status).toBe("approved");
    });

    it("propose to approve to claim to complete: every step is fenced and evented, and the approval is single-use", async () => {
      const seeded = await seedAwaitingApproval(db());
      const { workspaceId: ws } = seeded;
      const decided = await decide(db(), {
        workspaceId: ws,
        operationId: seeded.operation.id,
        approver: user("approver"),
        approverRole: "admin",
        decision: "approve",
        proposalDigest: seeded.operation.proposalDigest,
        policyVersion: "a".repeat(64),
      });
      expect(decided.operation.status).toBe("approved");

      const envScope = `env:${seeded.operation.environmentId}`;
      const result = await withLease(db(), { scope: envScope, holder: "worker-1", ttlMs: 5_000, workspaceId: ws }, async (lease) => {
        const running = await claimOperation(db(), {
          workspaceId: ws,
          id: seeded.operation.id,
          expectedDigest: seeded.operation.proposalDigest,
          holder: "worker-1",
          lease: { scope: lease.scope, fenceToken: lease.fenceToken },
        });
        expect(running.status).toBe("running");
        // a second worker cannot claim the same approved operation
        await expectCode(
          claimOperation(db(), { workspaceId: ws, id: seeded.operation.id, expectedDigest: seeded.operation.proposalDigest, holder: "worker-2" }),
          "invalid_state"
        );
        return completeOperation(db(), { workspaceId: ws, id: seeded.operation.id, outcome: "succeeded", result: { changed: 1 }, fence: { scope: lease.scope, fenceToken: lease.fenceToken } });
      });
      expect(result?.status).toBe("succeeded");
      expect(result?.result).toEqual({ changed: 1 });

      const events = await repos.events.list(db(), ws, { operationId: seeded.operation.id });
      expect(events.map((e) => e.type)).toEqual(["operation.proposed", "policy.evaluated", "operation.approved", "operation.started", "operation.succeeded"]);
      expect(new Set(events.map((e) => e.correlationId)).size).toBe(1);
      // a finished operation cannot be finished again
      expect(await completeOperation(db(), { workspaceId: ws, id: seeded.operation.id, outcome: "failed" })).toBeNull();
    });

    it("if the lease is lost mid-run the operation becomes uncertain (and is never finished as success)", async () => {
      const seeded = await seedApprovedOperation(db());
      const { workspaceId: ws, operation } = seeded;
      const envScope = `env:${operation.environmentId}`;
      const err = await withLease(db(), { scope: envScope, holder: "worker-1", ttlMs: 2_000, renewEveryMs: 60, workspaceId: ws }, async (lease, signal) => {
        await claimOperation(db(), { workspaceId: ws, id: operation.id, expectedDigest: operation.proposalDigest, holder: "worker-1", lease: { scope: lease.scope, fenceToken: lease.fenceToken } });
        await backdate(db(), "leases", "expires_at", envScope, "scope");
        await repos.leases.acquire(db(), { scope: envScope, holder: "worker-2", ttlMs: 30_000 });
        await new Promise<void>((resolve) => {
          if (signal.aborted) resolve();
          else signal.addEventListener("abort", () => resolve(), { once: true });
        });
        // the worker must NOT report success: its fenced completion is refused
        await expect(completeOperation(db(), { workspaceId: ws, id: operation.id, outcome: "succeeded", fence: { scope: lease.scope, fenceToken: lease.fenceToken } })).rejects.toBeInstanceOf(LeaseLostError);
      }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(LeaseLostError);

      await reconcileOperations(db(), { limit: 1000 });
      expect((await repos.operations.get(db(), ws, operation.id))?.status).toBe("uncertain");
      const types = (await repos.events.list(db(), ws, { operationId: operation.id })).map((e) => e.type);
      expect(types).toContain("operation.uncertain");
      expect(types).not.toContain("operation.succeeded");
    });

    it("cancel revokes live grants, only pre-execution operations can be cancelled", async () => {
      const seeded = await seedApprovedOperation(db());
      const { workspaceId: ws, operation } = seeded;
      const now = Date.now();
      await repos.grants.insert(db(), { jti: uid("jti"), workspaceId: ws, operationId: operation.id, capability: "x", audience: "worker", issuedAt: new Date(now).toISOString(), expiresAt: new Date(now + 60_000).toISOString() });
      const cancelled = await cancelOperation(db(), { workspaceId: ws, id: operation.id, reason: "changed my mind" });
      expect(cancelled?.status).toBe("cancelled");
      const grants = await db().query<{ revoked_at: string | null }>("select revoked_at from platform.capability_grants where workspace_id = $1 and operation_id = $2", [ws, operation.id]);
      expect(grants.every((g) => g.revoked_at !== null)).toBe(true);
      expect((await repos.events.list(db(), ws, { operationId: operation.id })).map((e) => e.type)).toContain("operation.cancelled");
      expect(await cancelOperation(db(), { workspaceId: ws, id: operation.id })).toBeNull();
      expect(await cancelOperation(db(), { workspaceId: newWorkspace(), id: operation.id })).toBeNull();

      const other = await seedApprovedOperation(db());
      await repos.operations.claimForExecution(db(), { workspaceId: other.workspaceId, id: other.operation.id, expectedDigest: other.operation.proposalDigest, holder: "w" });
      expect(await cancelOperation(db(), { workspaceId: other.workspaceId, id: other.operation.id })).toBeNull(); // running: cannot be "cancelled"
    });

    it("conditional cancellation leaves approved and queued operations and their ledger intact", async () => {
      const seeded = await seedAwaitingApproval(db());
      const { workspaceId, operation } = seeded;
      expect((await repos.operations.get(db(), workspaceId, operation.id))?.status).toBe("awaiting_approval");
      await decide(db(), { workspaceId, operationId: operation.id, approver: user(), approverRole: "editor", decision: "approve",
        proposalDigest: operation.proposalDigest, policyVersion: seeded.decision.policyVersion });
      const jti = uid("jti");
      const issuedAt = new Date().toISOString(), expiresAt = new Date(Date.now() + 60_000).toISOString();
      // A raw unheld destroy bearer remains forbidden. This cancellation fixture retains
      // only a legitimate read-only planning grant while browser approval wins.
      await expect(repos.grants.insert(db(), { jti: uid("unheld_destroy"), workspaceId, operationId: operation.id,
        capability: "infrastructure.destroy", audience: "worker", issuedAt, expiresAt })).rejects.toMatchObject({ sqlstate: "23514" });
      expect(await db().query("select jti from platform.capability_grants where workspace_id=$1 and operation_id=$2", [workspaceId, operation.id])).toEqual([]);
      const planningGrant = await repos.grants.insert(db(), { jti, workspaceId, operationId: operation.id, capability: "infrastructure.plan", audience: "worker", issuedAt, expiresAt });
      expect(planningGrant.capability).toBe("infrastructure.plan");
      const approvals = await repos.approvals.listForOperation(db(), workspaceId, operation.id);
      const events = await repos.events.list(db(), workspaceId, { operationId: operation.id });
      for (const status of ["approved", "queued"] as const) {
        if (status === "queued") await repos.operations.transition(db(), { workspaceId, id: operation.id, from: ["approved"], to: "queued" });
        const current = await repos.operations.get(db(), workspaceId, operation.id);
        expect(current?.status).toBe(status);
        expect(await cancelOperation(db(), { workspaceId, id: operation.id, expectedStatus: "awaiting_approval", reason: "Superseded" })).toBeNull();
        expect(await repos.operations.get(db(), workspaceId, operation.id)).toEqual(current);
        expect(await repos.approvals.listForOperation(db(), workspaceId, operation.id)).toEqual(approvals);
        expect(await repos.events.list(db(), workspaceId, { operationId: operation.id })).toEqual(events);
        const grants = await db().query<{ revoked_at: string | null }>("select revoked_at from platform.capability_grants where workspace_id = $1 and jti = $2", [workspaceId, jti]);
        expect(grants).toEqual([{ revoked_at: null }]);
        expect(await repos.grants.get(db(), workspaceId, jti)).toEqual(planningGrant);
        expect(await db().query("select jti from platform.capability_grants where workspace_id=$1 and operation_id=$2 and capability='infrastructure.destroy'", [workspaceId, operation.id])).toEqual([]);
      }
    });

    it("reconcile expires overdue proposals and revokes their grants, idempotently", async () => {
      const seeded = await seedApprovedOperation(db());
      const { workspaceId: ws, operation } = seeded;
      const now = Date.now();
      const jti = uid("jti");
      await repos.grants.insert(db(), { jti, workspaceId: ws, operationId: operation.id, capability: "x", audience: "worker", issuedAt: new Date(now).toISOString(), expiresAt: new Date(now + 60_000).toISOString() });
      await backdate(db(), "operations", "expires_at", operation.id);
      await reconcileOperations(db(), { limit: 1000 });
      expect((await repos.operations.get(db(), ws, operation.id))?.status).toBe("expired");
      expect(await repos.grants.status(db(), ws, jti)).toBe("revoked");
      const again = await reconcileOperations(db(), { limit: 1000 });
      expect([...again.expired, ...again.uncertain].map((o) => o.id)).not.toContain(operation.id);
      const types = (await repos.events.list(db(), ws, { operationId: operation.id })).map((e) => e.type);
      expect(types.filter((t) => t === "operation.cancelled")).toHaveLength(1);
    });

    it("emitForOperation inherits scope and correlation; newCorrelationId is unique", async () => {
      const { workspaceId: ws, operation } = await seedApprovedOperation(db());
      const seq = await emitForOperation(db(), operation, "deployment.healthy", { data: { replicas: 3 }, causationId: "evt_cause" });
      const [event] = await repos.events.list(db(), ws, { afterSeq: seq - 1, operationId: operation.id });
      expect(event).toMatchObject({ type: "deployment.healthy", operationId: operation.id, correlationId: operation.correlationId, environmentId: operation.environmentId, causationId: "evt_cause", data: { replicas: 3 } });
      expect(newCorrelationId()).toMatch(/^corr_/);
      expect(newCorrelationId()).not.toBe(newCorrelationId());
    });
  });

  describe("withIdempotency", () => {
    const input = (ws: string, key: string, hash = "h1") => ({ workspaceId: ws, key, requestHash: hash });

    it("runs fn once, stores the response, and replays it for the same key and hash", async () => {
      const ws = newWorkspace();
      let runs = 0;
      const fn = async () => ({ id: `res_${++runs}`, list: [1, 2] });
      const first = await withIdempotency(db(), input(ws, "k1"), fn);
      const second = await withIdempotency(db(), input(ws, "k1"), fn);
      expect(first).toEqual({ replayed: false, value: { id: "res_1", list: [1, 2] } });
      expect(second).toEqual({ replayed: true, value: { id: "res_1", list: [1, 2] } });
      expect(runs).toBe(1);
      await expect(withIdempotency(db(), input(ws, "k1", "different"), fn)).rejects.toBeInstanceOf(IdempotencyConflictError);
      expect(runs).toBe(1);
    });

    it("a failing fn leaves the key unclaimed, so the client can retry", async () => {
      const ws = newWorkspace();
      await expect(withIdempotency(db(), input(ws, "k2"), async () => { throw new Error("transient"); })).rejects.toThrowError("transient");
      const retry = await withIdempotency(db(), input(ws, "k2"), async () => "ok");
      expect(retry).toEqual({ replayed: false, value: "ok" });
    });

    it("racing callers with one key run fn exactly once", async () => {
      const ws = newWorkspace();
      let runs = 0;
      const results = await Promise.all(
        Array.from({ length: 8 }, (_, i) => withIdempotency(i % 2 ? ctx.db : ctx.db2, input(ws, "k3"), async () => ({ n: ++runs })))
      );
      expect(runs).toBe(1);
      expect(results.filter((r) => !r.replayed)).toHaveLength(1);
      expect(new Set(results.map((r) => JSON.stringify(r.value))).size).toBe(1);
    });

    it("keys are per workspace", async () => {
      const key = uid("shared");
      const a = await withIdempotency(db(), input(newWorkspace(), key), async () => "a");
      const b = await withIdempotency(db(), input(newWorkspace(), key), async () => "b");
      expect(a.replayed).toBe(false);
      expect(b).toEqual({ replayed: false, value: "b" });
    });
  });
});
