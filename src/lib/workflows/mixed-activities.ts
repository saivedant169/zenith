/**
 * Activities for `mixedParentWorkflow` (PROD-MIX-02). Thin, typed adapters over
 * `src/lib/execution/mixed/service.ts`: every decision is made there from durable
 * platform state, so a retried or resumed activity repeats it safely.
 *
 * Failure mapping. A refusal of the plan (`MixedPlanError`, a digest or
 * transition conflict from the store) crosses the boundary as the workflow's clean
 * `StepFailed`, non-retryable, which ends the parent `failed` with nothing started.
 * A lost lease is `LeaseLost`. Anything unclassified stays a plain error, and
 * because the child step may have acted, the workflow ends it `uncertain`.
 *
 * Run join (wave-4 assembly). Every child transition the parent observes is recorded on the MIX-03/04 run
 * (`src/lib/execution/mixed/orchestration-join.ts`): the run opens at verify, a `start` run event is recorded right
 * before each child's broker claim, outcomes are synced idempotently, and a consumer whose incoming outputs change the
 * parent digest waits for a person's review of exactly that digest instead of being rebound.
 */
import { ApplicationFailure, CancelledFailure, Context } from "@temporalio/activity";
import type { Sql } from "@/lib/controlplane/types";
import { repos } from "@/lib/controlplane/db";
import { ControlStoreError } from "@/lib/controlplane/db/errors";
import * as plans from "@/lib/controlplane/db/repos/mixed-parent-plans";
import { createConnectionsPort, createLeasesPort } from "@/lib/execution/platform";
import { createProductPort } from "@/lib/execution/product-port";
import { settleOutcome } from "@/lib/execution/mixed/settle";
import { composeMixedDeps } from "@/lib/execution/mixed/deps";
import { advanceChild, beginParent, observeChild, settleParent, verifyParent, type ChildLauncher } from "@/lib/execution/mixed/service";
import {
  cancelRunForParent, joinedLauncher, materializeIncoming, openRunForParent, reviewStillPending, syncAllChildren, syncChildOutcome, tickRun, type JoinDeps, type ParentReviewOpener,
} from "@/lib/execution/mixed/orchestration-join";
import { MixedOrchestrationError, platformMixedRunDeps, type MixedRunDeps } from "@/lib/execution/mixed-orchestration";
import { MIXED_PARENT_CAPABILITY } from "@/lib/execution/mixed/types";
import { MixedPlanError } from "@/lib/execution/mixed/types";
import { createMixedWorld, type MixedWorld } from "@/lib/execution/mixed/world";
import { platformDriverLookup } from "@/lib/platform/driver-lookup";
import { findGraphProblems } from "@/lib/execution/graph";
import type { MixedActivities } from "./definitions/mixedParent";
import { stepFailed, toTemporalFailure } from "./activities/failures";

const ID = /^[A-Za-z0-9_.:-]{1,128}$/;
const PARTITION = /^[A-Za-z0-9_.:/-]{1,200}$/;
const POLL_MS = 5_000;
const LEASE_TTL_MS = 5 * 60 * 1000;

/** The real launcher: the broker claim a person's Start performs, then the durable, idempotent start intent. */
export function createChildLauncher(): ChildLauncher {
  return {
    async claim(workspaceId, operationId) {
      const [{ platformBroker }, { isBrokerError }] = await Promise.all([import("@/lib/capabilities/platform"), import("@/lib/capabilities/errors")]);
      try {
        await (await platformBroker()).beginExecution({ workspaceId, operationId, holder: `workflow:${operationId}`, audience: "worker", leaseMs: 5 * 60_000 });
        return "claimed";
      } catch (error) {
        if (isBrokerError(error) && error.code === "already_claimed") return "already_claimed";
        throw error;
      }
    },
    async start(input) {
      const { startWorkflowIntent } = await import("./start-intent");
      await startWorkflowIntent("deploy", input);
    },
  };
}

/** The real opener: a review operation proposed through the capability broker under the parent's own principal, never executable. */
export function createParentReviewOpener(): ParentReviewOpener {
  return {
    async open({ workspaceId, parentOperationId, review }) {
      const [{ platformBroker }, { isBrokerError }] = await Promise.all([import("@/lib/capabilities/platform"), import("@/lib/capabilities/errors")]);
      const broker = await platformBroker();
      const parent = await broker.deps.store.getOperation(workspaceId, parentOperationId);
      if (!parent) throw new MixedPlanError("not_found", "The parent operation was not found.");
      try {
        const proposed = await broker.propose({ capability: MIXED_PARENT_CAPABILITY, scope: parent.proposal.scope, input: review as unknown as Record<string, unknown>,
          reason: "Outputs of a finished child changed the parent plan; a person must review the new parent digest before the next child starts.",
          idempotencyKey: `mixed-review-${review.requiredParentDigest.slice(0, 32)}-${parentOperationId.slice(-24)}` }, parent.principal, { via: "workflow", ttlMs: 24 * 60 * 60 * 1000 });
        if (proposed.operation.status !== "awaiting_approval") throw new MixedPlanError("approval_mismatch", "Workspace policy did not ask a person to review the changed parent plan, so the next child cannot start.");
        return { operationId: proposed.operation.id };
      } catch (error) {
        if (isBrokerError(error)) throw new MixedPlanError("approval_mismatch", `The review of the changed parent plan could not be opened: ${error.message.slice(0, 200)}`);
        throw error;
      }
    },
  };
}

function mapFailure(error: unknown): unknown {
  if (error instanceof MixedOrchestrationError) return error.code === "conflict" || error.code === "unavailable" ? toTemporalFailure(error) : stepFailed(error.message);
  if (error instanceof MixedPlanError) return stepFailed(error.message);
  if (error instanceof ControlStoreError && ["conflict", "invalid_state", "digest_mismatch", "not_found", "tenant_mismatch", "invalid_input"].includes(error.code)) return stepFailed(error.message);
  return toTemporalFailure(error);
}

function checked(input: unknown, partition: boolean): { workspaceId: string; operationId: string; parentPlanId: string; partitionId: string } {
  const i = input as Record<string, unknown> | null;
  if (!i || typeof i !== "object" || Object.getPrototypeOf(i) !== Object.prototype) throw ApplicationFailure.nonRetryable("Mixed activity input is invalid.", "MixedContractInvalid");
  const { workspaceId, operationId, parentPlanId, partitionId } = i as Record<string, string>;
  if (![workspaceId, operationId, parentPlanId].every((value) => typeof value === "string" && ID.test(value)) || (partition && !(typeof partitionId === "string" && PARTITION.test(partitionId)))) {
    throw ApplicationFailure.nonRetryable("Mixed activity input is invalid.", "MixedContractInvalid");
  }
  return { workspaceId, operationId, parentPlanId, partitionId: partition ? partitionId : "" };
}

export interface MixedActivityDeps {
  db: Sql;
  world?: MixedWorld;
  launcher?: ChildLauncher;
  /** Run service dependencies; production composes them from the platform broker on first use. */
  run?: MixedRunDeps;
  /** Opens the human review of a changed parent digest; production proposes through the broker. */
  reviews?: ParentReviewOpener;
  /** test seams for pacing; production uses real time */
  pollMs?: number;
}

export function createMixedActivities(options: MixedActivityDeps): MixedActivities {
  const world = options.world ?? createMixedWorld({
    product: createProductPort(), connections: createConnectionsPort(options.db), platformConnection: (workspaceId, id) => repos.connections.get(options.db, workspaceId, id), sql: options.db,
  });
  const launcher = options.launcher ?? createChildLauncher();
  // A child with cross-partition references may start only when the world can supply the producers' typed outputs: the run
  // then refuses its start until every incoming reference is materialized (never on a guess). Same composition as the REST
  // start (execution/mixed/deps.ts), so both paths judge reference readiness with one check.
  const deps = composeMixedDeps(options.db, world);
  const reviews = options.reviews ?? createParentReviewOpener();
  let joinPromise: Promise<JoinDeps> | undefined;
  const join = (): Promise<JoinDeps> => {
    joinPromise ??= (async (): Promise<JoinDeps> => {
      const run = options.run ?? platformMixedRunDeps(options.db, await (await import("@/lib/capabilities/platform")).platformBroker());
      return { sql: options.db, world, run, reviews };
    })();
    return joinPromise;
  };
  const planOf = async (workspaceId: string, planId: string) => {
    const stored = await plans.getPlan(options.db, workspaceId, planId);
    if (!stored) throw new MixedPlanError("not_found", "The mixed plan was not found.");
    return stored.plan;
  };
  const leases = createLeasesPort(options.db);
  const pollMs = options.pollMs ?? POLL_MS;

  const guarded = <A extends unknown[], R>(fn: (...args: A) => Promise<R>) => async (...args: A): Promise<R> => {
    try { return await fn(...args); } catch (error) { throw mapFailure(error); }
  };

  return {
    verifyMixedParent: guarded(async (raw) => {
      const input = checked(raw, false);
      const ready = await verifyParent(deps, { workspaceId: input.workspaceId, operationId: input.operationId, planId: input.parentPlanId, requireRunning: true });
      // The cross-provider refusal is lifted only through this admission: every node must still pass its ordinary checks.
      const parent = await world.parentGraph(input.workspaceId, ready.stored.plan.parentEnvironmentId);
      const problems = findGraphProblems(parent.graph, ready.stored.plan.children[0].authority.provider, platformDriverLookup, ready.admission);
      if (problems.length) throw new MixedPlanError("plan_refused", `The mixed graph is not executable: ${problems[0].slice(0, 200)}`);
      await beginParent(deps, { workspaceId: input.workspaceId, planId: input.parentPlanId });
      // The run (MIX-03/04) opens once per parent operation; its deadline is the parent approval's expiry.
      await openRunForParent(await join(), { workspaceId: input.workspaceId, parentOperationId: input.operationId, plan: ready.stored.plan });
      const order = ready.stored.plan.children.map((child) => ({ partitionId: child.partitionId, ordinal: child.ordinal }));
      return { order, childSetDigest: ready.stored.plan.childSetDigest };
    }),

    advanceMixedChild: guarded(async (raw) => {
      const input = checked(raw, true);
      const j = await join();
      const plan = await planOf(input.workspaceId, input.parentPlanId);
      const scope = { workspaceId: input.workspaceId, parentOperationId: input.operationId, plan };
      // A parent started before the run existed, or a crash between observe and record, converges here.
      await openRunForParent(j, scope);
      await syncAllChildren(j, scope);
      const materialized = await materializeIncoming(j, { ...scope, partitionId: input.partitionId });
      if (materialized.state === "waiting") return { state: "waiting" as const };
      if (materialized.state === "blocked") {
        await plans.blockChild(options.db, { workspaceId: input.workspaceId, planId: input.parentPlanId, partitionId: input.partitionId, reason: materialized.reason });
        return { state: "blocked" as const, reason: materialized.reason };
      }
      const result = await advanceChild(deps, joinedLauncher(j, launcher, scope), { workspaceId: input.workspaceId, operationId: input.operationId, planId: input.parentPlanId, partitionId: input.partitionId });
      if (result.state === "blocked") return { state: "blocked" as const, reason: result.reason };
      if (result.state === "waiting") return { state: "waiting" as const };
      if (result.state !== "started") {
        const receipt = await plans.getReceipt(options.db, input.workspaceId, input.parentPlanId, input.partitionId);
        await syncChildOutcome(j, { ...scope, partitionId: input.partitionId, state: result.state, ...(receipt ? { receipt } : {}) });
      }
      return { state: result.state };
    }),

    awaitMixedChild: guarded(async (raw) => {
      const input = checked(raw, true);
      const { lease, windowMs } = raw as { lease: { scope: string; holder: string; fenceToken: number }; windowMs: number };
      const context = Context.current();
      context.cancellationSignal.throwIfAborted();
      const until = Date.now() + Math.max(1_000, Math.min(windowMs, 5 * 60_000));
      try {
        for (;;) {
          context.heartbeat({ phase: "observing" });
          const renewed = await leases.renew(lease, LEASE_TTL_MS);
          if (!renewed) throw new (await import("@/lib/controlplane/types")).LeaseLostError(lease.scope, lease.fenceToken);
          const observed = await observeChild(deps, { workspaceId: input.workspaceId, planId: input.parentPlanId, partitionId: input.partitionId });
          if (observed.state === "pending") throw new MixedPlanError("child_mismatch", "The child has no adopted operation.");
          const j = await join();
          const scope = { workspaceId: input.workspaceId, parentOperationId: input.operationId, plan: await planOf(input.workspaceId, input.parentPlanId) };
          if (observed.state !== "started" && observed.state !== "adopted") {
            // Record the child's end on the run before the workflow acts on it.
            await syncChildOutcome(j, { ...scope, partitionId: input.partitionId, state: observed.state, ...(observed.receipt ? { receipt: observed.receipt } : {}) });
            return { state: observed.state };
          }
          if (observed.state === "started") {
            // Child timeouts and approval expiry are the run's: a timeout means the outcome is unconfirmed, never that the child stopped.
            const status = await tickRun(j, { workspaceId: input.workspaceId, parentOperationId: input.operationId, partitionId: input.partitionId });
            if (status === "timed_out" || status === "outage") return { state: "uncertain" };
          }
          if (observed.state === "adopted") {
            // Not claimed yet: return as soon as its own approval lets the parent advance it.
            const rows = await plans.listChildren(options.db, input.workspaceId, input.parentPlanId);
            const row = rows.find((candidate) => candidate.partitionId === input.partitionId);
            const facts = row?.childOperationId ? await plans.readOperationFacts(options.db, input.workspaceId, row.childOperationId) : null;
            // A consumer waiting for a person's review of a changed parent digest keeps waiting; it is not re-advanced in a loop.
            if ((!facts || !["proposed", "awaiting_approval"].includes(facts.status)) && !(await reviewStillPending(j, { workspaceId: input.workspaceId, parentOperationId: input.operationId, partitionId: input.partitionId }))) return { state: "adopted" };
          }
          if (Date.now() >= until) return { state: observed.state };
          await new Promise<void>((resolve) => { const t = setTimeout(resolve, Math.min(pollMs, Math.max(0, until - Date.now()))); t.unref(); context.cancellationSignal.addEventListener("abort", () => { clearTimeout(t); resolve(); }, { once: true }); });
          context.cancellationSignal.throwIfAborted();
        }
      } catch (error) {
        if (context.cancellationSignal.aborted) throw new CancelledFailure(undefined);
        throw error;
      }
    }),

    settleMixedParent: guarded(async (raw) => {
      const input = checked(raw, false);
      const { outcome, reason } = raw as { outcome: "succeeded" | "failed" | "uncertain" | "cancelled"; reason: string };
      const effective = await settleOutcome(options.db, { workspaceId: input.workspaceId, planId: input.parentPlanId, requested: outcome });
      // A cancelled parent cancels its run (unstarted children cancel now; running ones stay cancel_requested until they report).
      if (effective === "cancelled") await cancelRunForParent(await join(), { workspaceId: input.workspaceId, parentOperationId: input.operationId });
      await settleParent(deps, { workspaceId: input.workspaceId, planId: input.parentPlanId, outcome: effective, reason: String(reason ?? "").slice(0, 400) });
      return { status: effective };
    }),
  };
}
