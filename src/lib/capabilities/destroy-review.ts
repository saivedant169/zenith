/**
 * First teardown review. Public callers request infrastructure.plan only.
 * The worker serializes reviews with the environment lease, records a bounded
 * PlanView, and opens an immutable admin-approval proposal. It never applies.
 * Freshness covers stored inputs and a 15-minute window, not live drift; the
 * existing destroy workflow always replans before applying. No live proof.
 */
import { z } from "zod";
import { digest } from "@/lib/controlplane/digest";
import type { OperationRecord, Principal, Scope } from "@/lib/controlplane/types";
import { projectPlanReview } from "@/lib/controlplane/db/repos/operation-review";
import { withKeepAlive } from "@/lib/execution/keepalive";
import { StepFailedError } from "@/lib/execution/errors";
import { errorText } from "@/lib/execution/text";
import type { Runtime } from "@/lib/execution/runtime";
import type { LeaseRef, PlanSummary } from "@/lib/workflows/types";
import { BrokerError, notFound } from "./errors";
import { loadDestroyPlan } from "./destroy-plan";
import type { Broker } from "./platform";
import type { BrokerProposal, ProposeContext } from "./types";
import { operationView } from "./views";
import { dispatchDestroyReview } from "./destroy-review-dispatch";

export const DESTROY_REVIEW_TTL_MS = 15 * 60_000;
export const DestroyReviewOptions = z.object({
  idempotencyKey: z.string().regex(/^[A-Za-z0-9_-]{8,100}$/),
  refresh: z.boolean().optional(),
}).strict();
const Intent = z.object({ environmentId: z.string().min(1).max(100), teardownReview: z.literal(true), refresh: z.boolean() }).strict();
const Result = z.object({ operationId: z.string().min(1).max(200), planDigest: z.string().regex(/^[a-f0-9]{64}$/), replayed: z.boolean() }).strict();
export type DestroyReviewResult = z.infer<typeof Result>;

async function authorize(broker: Broker, scope: Scope, principal: Principal) {
  const auth = await broker.authorizeRead({ capability: "infrastructure.plan", scope }, principal, { audience: "worker" });
  if (auth.decision.outcome !== "allow" || !auth.claims) throw new BrokerError("policy_denied", "Current policy does not authorize a teardown review.");
}

/** Dispatch carries ids only. Failed/ambiguous transport never creates mutation authority. */
export async function requestDestroyReview(broker: Broker, scope: Scope, principal: Principal, raw: unknown, via: ProposeContext["via"] = "rest") {
  const options = DestroyReviewOptions.safeParse(raw);
  if (!options.success) throw new BrokerError("invalid_request", "The teardown review request is invalid. Supply an idempotency key and optional refresh flag.");
  await authorize(broker, scope, principal);
  const result = await broker.propose({ capability: "infrastructure.plan", scope,
    input: { environmentId: scope.environmentId, teardownReview: true, refresh: options.data.refresh ?? false },
    idempotencyKey: options.data.idempotencyKey }, principal, { via, ttlMs: DESTROY_REVIEW_TTL_MS });
  if (result.operation.status === "denied" || result.operation.status === "awaiting_approval") throw new BrokerError("policy_denied", "Current policy does not allow read-only teardown planning.");
  if (["approved", "queued"].includes(result.operation.status)) {
    try { await dispatchDestroyReview({ workspaceId: scope.workspaceId, operationId: result.operation.id }); }
    catch { throw new BrokerError("platform_store_unavailable", "Teardown review dispatch could not be confirmed. Retry with the same idempotency key or inspect the review operation.", undefined, { reviewOperationId: result.operation.id }); }
  }
  return { reviewOperationId: result.operation.id, status: result.operation.status, replayed: result.replayed };
}

/** Authorized polling, including after reload; no raw worker or provider output. */
export async function getDestroyReview(broker: Broker, scope: Scope, principal: Principal, reviewOperationId?: string) {
  await authorize(broker, scope, principal);
  let source: OperationRecord | undefined;
  if (reviewOperationId) {
    const row = await broker.deps.store.getOperation(scope.workspaceId, reviewOperationId);
    if (!row || row.environmentId !== scope.environmentId || (scope.projectId && row.projectId !== scope.projectId) || !Intent.safeParse(row.proposal.input).success || row.capability !== "infrastructure.plan") throw notFound();
    source = row;
  } else {
    let cursor: string | undefined;
    do {
      const page = await broker.deps.store.listOperations(scope.workspaceId, { environmentId: scope.environmentId, capability: "infrastructure.plan" }, { limit: 100, cursor });
      source = page.items.find((op) => Intent.safeParse(op.proposal.input).success);
      cursor = page.nextCursor;
    } while (!source && cursor);
  }
  if (!source) return { review: null };
  const completed = Result.safeParse(source.result);
  if (!completed.success || source.status !== "succeeded") return { review: { reviewOperationId: source.id, status: source.status } };
  const detail = await broker.getOperationDetail({ workspaceId: scope.workspaceId, operationId: completed.data.operationId, principal });
  if (detail.operation.environmentId !== scope.environmentId || detail.operation.capability !== "infrastructure.destroy") throw notFound();
  return { review: { reviewOperationId: source.id, ...completed.data, status: detail.operation.status,
    operation: detail.operation, planReview: detail.planReview } };
}

/** Worker entry: a scoped, stored planning intent is required before any I/O. */
export async function runDestroyReview(rt: Runtime, broker: Broker, input: { workspaceId: string; operationId: string }, planDestroy: (lease: LeaseRef) => Promise<PlanSummary>): Promise<DestroyReviewResult> {
  const op = await broker.deps.store.getOperation(input.workspaceId, input.operationId);
  const intent = Intent.safeParse(op?.proposal.input);
  if (!op || op.capability !== "infrastructure.plan" || !intent.success || op.environmentId !== intent.data.environmentId) throw notFound();
  await authorize(broker, op.proposal.scope, op.principal);
  const priorResult = Result.safeParse(op.result);
  if (op.status === "succeeded" && priorResult.success) return priorResult.data;
  if (!["approved", "queued"].includes(op.status)) throw new BrokerError("invalid_state", "This teardown review has already started or ended. Inspect its recorded state.");
  const lease = await rt.d.leases.acquire({ workspaceId: op.workspaceId, scope: `env:${op.environmentId}`, holder: rt.holder(op.id), ttlMs: rt.limits.leaseTtlMs });
  if (!lease) {
    await broker.deps.store.cancelOperation({ workspaceId: op.workspaceId, id: op.id, reason: "Teardown review refused: the environment lease is busy.", actor: op.principal });
    throw new BrokerError("conflict", "The environment is busy. Wait for its active operation before requesting a review.");
  }
  let claimed = false;
  try {
    await broker.beginExecution({ workspaceId: op.workspaceId, operationId: op.id, holder: `workflow:${op.id}`, audience: "worker", lease });
    claimed = true;
    const result = await withKeepAlive(rt, { lease, detail: "teardown review", operation: { workspaceId: op.workspaceId, operationId: op.id } }, async () => {
      const product = await rt.d.product.loadContext({ workspaceId: op.workspaceId, environmentId: intent.data.environmentId });
      if (product.environment.activeDeploymentId) throw new BrokerError("conflict", "Finish the active deployment before reviewing teardown.");
      const rows = await rt.d.resources.list(op.workspaceId, intent.data.environmentId);
      const basis = digest({ environment: product.environment, revision: product.revision,
        resources: rows.map((row) => ({ address: row.address, provider: row.provider, ownership: row.ownership, specDigest: row.specDigest, externalId: row.externalId })).sort((a, b) => a.address.localeCompare(b.address)) });
      const pending: OperationRecord[] = [];
      let cursor: string | undefined;
      do {
        const page = await broker.deps.store.listOperations(op.workspaceId, { environmentId: op.environmentId, capability: "infrastructure.destroy", status: ["proposed", "awaiting_approval", "approved", "queued", "running", "uncertain"] }, { limit: 100, cursor });
        pending.push(...page.items); cursor = page.nextCursor;
      } while (cursor);
      if (pending.some((current) => current.status !== "awaiting_approval")) throw new BrokerError("conflict", "An existing teardown has been approved, started or has an uncertain outcome. Inspect it before requesting a new review.");
      for (const current of pending) {
        const proposal = current.proposal as BrokerProposal;
        const storedBasis = (proposal.input as { reviewBasis?: string } | null)?.reviewBasis;
        if (pending.length === 1 && !intent.data.refresh && storedBasis === basis && Date.parse(current.expiresAt) > broker.deps.clock.now().getTime()) {
          await ensureReviewEvidence(rt, broker, current);
          return { operationId: current.id, planDigest: current.planDigest!, replayed: true };
        }
      }
      const plan = await planDestroy(lease);
      const reviewed = await loadDestroyPlan(broker.deps, op.proposal.scope, { operationId: op.id, planDigest: plan.planDigest });
      const source = await broker.deps.store.getPlanEvidence(op.workspaceId, op.id, plan.planDigest);
      if (!source || !projectPlanReview(source.summary, plan.planDigest)) throw new BrokerError("invalid_state", "The destroy PlanView is unavailable. Nothing was applied.");
      await rt.d.leases.assertFence(lease.scope, lease.fenceToken);
      // Recheck input freshness before binding it into the immutable proposal.
      const latest = await rt.d.product.loadContext({ workspaceId: op.workspaceId, environmentId: intent.data.environmentId });
      const latestRows = await rt.d.resources.list(op.workspaceId, intent.data.environmentId);
      if (digest({ environment: latest.environment, revision: latest.revision,
        resources: latestRows.map((row) => ({ address: row.address, provider: row.provider, ownership: row.ownership, specDigest: row.specDigest, externalId: row.externalId })).sort((a, b) => a.address.localeCompare(b.address)) }) !== basis) throw new BrokerError("conflict", "The environment changed during review. Request a new review.");
      for (const stale of pending) {
        const reason = Date.parse(stale.expiresAt) <= broker.deps.clock.now().getTime() ? "Superseded by a new teardown review: the previous review expired."
          : intent.data.refresh ? "Superseded by an explicitly refreshed teardown review."
          : pending.length > 1 ? "Superseded by a new teardown review: multiple pending reviews were consolidated."
          : "Superseded by a new teardown review: the environment inputs changed.";
        const cancelled = await broker.deps.store.cancelOperation({ workspaceId: op.workspaceId, id: stale.id, reason, actor: op.principal, expectedStatus: "awaiting_approval", requireUndecidedApprovalRound:true });
        if (!cancelled) throw new BrokerError("conflict", "The previous teardown changed while it was being superseded. Inspect it before proceeding.");
      }
      const proposal = await broker.propose({ capability: "infrastructure.destroy", scope: op.proposal.scope,
        input: { environmentId: op.environmentId, reviewBasis: basis }, idempotencyKey: `review:${op.id}:${reviewed.planDigest}` }, op.principal,
        { via: "workflow", teardownReview: true, destroyPlan: { operationId: op.id, planDigest: reviewed.planDigest }, ttlMs: DESTROY_REVIEW_TTL_MS });
      if (proposal.operation.status !== "awaiting_approval") throw new BrokerError("policy_denied", "Workspace policy refused the teardown proposal. Nothing was applied.");
      const stored = await broker.deps.store.getOperation(op.workspaceId, proposal.operation.id);
      if (!stored) throw new BrokerError("invalid_state", "The teardown proposal could not be read back.");
      await ensureReviewEvidence(rt, broker, stored);
      // Direct object teardown has no OpenTofu binary; IaC must associate the source original before any human decision.
      if (!["kubernetes","zenith"].includes(product.environment.provider)) {
        if (!rt.d.planArtifacts) throw new BrokerError("invalid_state","Durable source review custody is unavailable; request a new review.");
        await rt.d.planArtifacts.associate({workspaceId:op.workspaceId,sourceOperationId:op.id,destinationOperationId:stored.id,
          sourceEvidenceId:source.id,planDigest:reviewed.planDigest,lease});
      }
      await rt.d.leases.assertFence(lease.scope, lease.fenceToken);
      return { operationId: stored.id, planDigest: reviewed.planDigest, replayed: false };
    });
    await broker.completeExecution({ workspaceId: op.workspaceId, operationId: op.id, outcome: "succeeded", result, fence: lease });
    return result;
  } catch (error) {
    // Product-authored refusals say why (scrubbed and capped); anything else stays generic.
    const reason = error instanceof BrokerError || error instanceof StepFailedError ? ` ${errorText(error, 300)}` : "";
    if (claimed) await broker.completeExecution({ workspaceId: op.workspaceId, operationId: op.id, outcome: "failed", error: `Teardown review did not complete. Nothing was applied.${reason}` }).catch(() => undefined);
    // External diagnostics are data and may contain credentials. Never propagate them.
    if (error instanceof BrokerError) throw error;
    throw new BrokerError("invalid_state", "Teardown review failed or lost its lease. Nothing was applied. Inspect the operation and request a new review.");
  } finally { await rt.d.leases.release(lease).catch(() => false); }
}

async function ensureReviewEvidence(rt: Runtime, broker: Broker, op: OperationRecord) {
  const ref = (op.proposal as BrokerProposal).broker?.destroyPlan;
  if (!op.planDigest || !ref) throw new BrokerError("invalid_state", "The teardown review has no recorded source plan.");
  const row = await broker.deps.store.getPlanEvidence(op.workspaceId, ref.operationId, op.planDigest);
  if (!row || row.simulated || !projectPlanReview(row.summary, op.planDigest)) throw new BrokerError("invalid_state", "The destroy PlanView is unavailable.");
  await rt.d.evidence.append({ id: `evd_${digest({ operationId: op.id, destroyReview: op.planDigest }).slice(0, 32)}`,
    workspaceId: op.workspaceId, operationId: op.id, kind: "tofu_plan", digest: op.planDigest, summary: row.summary, simulated: false });
  // Both approval surfaces read the proposal's own evidence, not the source row.
  const stored = await broker.deps.store.getOperation(op.workspaceId, op.id);
  const evidence = await broker.deps.store.getPlanEvidence(op.workspaceId, op.id, op.planDigest);
  if (!stored || operationView(stored).planDigest !== op.planDigest || !evidence || !projectPlanReview(evidence.summary, op.planDigest)) throw new BrokerError("invalid_state", "The teardown review could not be verified.");
}
