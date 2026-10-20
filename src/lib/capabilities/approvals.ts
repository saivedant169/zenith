/**
 * Approvals: human, digest-bound, expiring, single-use (ADR-0007).
 *
 * What makes an approval valid here, in the order it is checked:
 *
 *  1. The decider is a member of the workspace (a non-member gets `not_found`,
 *     the same answer as a foreign operation id).
 *  2. The decider is a plain HUMAN `user` principal AND presents a
 *     `BrowserSessionProof` for that same user. A model, an integration, the
 *     Navigator, a runner or a machine can never approve or reject — typed
 *     `approver_not_human`, and the attempt is written to the audit log.
 *  3. Role: at least the decision's `approval.minRole`; a viewer never decides.
 *  4. The operation is `awaiting_approval` and not expired.
 *  5. The digest the approver reviewed equals the operation's proposal digest.
 *  6. Separation of duties: when required, approver ≠ the requesting human
 *     (`principal.onBehalfOf ?? principal.id`).
 *  7. One decision per approver per round. A second approval by the same
 *     user is refused (`duplicate_decision`) and counts once.
 *  8. `count > 1` needs N DISTINCT approvers; the operation becomes `approved`
 *     only when the Nth lands.
 *  9. At a plan gate whose recorded review carries executable semantics (PROD-DUR-03),
 *     the approver must present the semantics digest they reviewed
 *     (`semantics_mismatch` otherwise). The approval is thereby bound to the recipe,
 *     scripts, migration class, targets, configuration, provider locks, backend and
 *     saved plan the plan view stands for, and every dispatch recomputes it.
 *
 * Steps 3–8 are enforced again by the store (`recordApproval` is the only path
 * to `approved`), so the database, not this function, is the last word.
 *
 * Approving also re-evaluates the proposal against CURRENT policy, roles and
 * autonomy. If policy now denies it, or now asks for a stricter approval than
 * the one the proposal was created under, the approval is refused
 * (`policy_denied` / `reapproval_required`) rather than recorded against a
 * requirement the approver was not shown. The approval records the policy
 * bundle version in force; execution re-validates again.
 *
 * REVOKING an approval before execution cancels the whole proposal: the
 * approval row cannot be un-written (history is append-only), and a proposal
 * whose approval was withdrawn must not remain approvable in a weaker form. A
 * fresh proposal is needed.
 */
import type { ApprovalRequirement, OperationRecord, Principal } from "@/lib/controlplane/types";
import { approvalRoundOf, operationPlanReview, type ApprovalRoundMetadata } from "@/lib/controlplane/db/repos/operation-review";
import { digest } from "@/lib/controlplane/digest";
import { BrokerError, isBrokerError, notFound } from "./errors";
import { requesterOf, requireHumanSession } from "./internal";
import { ROLE_RANK, type BrokerDeps } from "./ports";
import { reevaluate, requestFromOperation } from "./reevaluate";
import { evaluate } from "./evaluate";
import { scrubSecrets } from "./secret-guard";
import type { BrowserSessionProof, OperationView } from "./types";
import { operationView } from "./views";

export interface DecideInput {
  workspaceId: string;
  operationId: string;
  /** the digest the approver reviewed */
  proposalDigest: string;
  /** The concrete plan the browser reviewed, required at a plan gate. */
  planDigest?: string;
  /** The executable-semantics digest the browser reviewed, required at a plan gate that records one. */
  semanticsDigest?: string;
  approver: Principal;
  session: BrowserSessionProof;
  reason?: string;
}

export interface ApprovalOutcome {
  operation: OperationView & Partial<ApprovalRoundMetadata>;
  approval: {
    id: string;
    decision: "approve" | "reject";
    approverId: string;
    approverRole: "viewer" | "editor" | "admin";
    policyVersion: string;
    createdAt: string;
    expiresAt: string;
  };
  /** distinct approvals recorded and how many the policy requires */
  approvals: { have: number; need: number };
  /** true when this decision moved the operation (approved or rejected) */
  finalized: boolean;
}

/** Is `current` a stronger requirement than `stored`? (more approvers, a higher role, or a newly required second person) */
export function isStricter(current: ApprovalRequirement, stored: ApprovalRequirement | undefined): boolean {
  if (!stored) return true;
  return current.count > stored.count || ROLE_RANK[current.minRole] > ROLE_RANK[stored.minRole] || (current.separationOfDuties && !stored.separationOfDuties);
}

const REFUSAL_CODES = new Set(["semantics_mismatch", "approver_not_human", "browser_session_required", "approver_role_insufficient", "separation_of_duties", "duplicate_decision", "digest_mismatch", "invalid_state", "operation_expired", "policy_denied", "reapproval_required"]);

/** Write the refusal to the audit log (best effort: a failed audit write never turns a refusal into an allow) and return the error for throwing. */
async function audited(
  deps: BrokerDeps,
  error: unknown,
  ctx: { workspaceId: string; operationId: string; actor: Principal; attempted: string; op?: { projectId?: string; environmentId?: string; resourceId?: string; correlationId: string } }
): Promise<unknown> {
  if (!isBrokerError(error) || !REFUSAL_CODES.has(error.code)) return error;
  try {
    await deps.store.appendEvent({
      type: "policy.evaluated",
      workspaceId: ctx.workspaceId,
      projectId: ctx.op?.projectId,
      environmentId: ctx.op?.environmentId,
      resourceId: ctx.op?.resourceId,
      operationId: ctx.operationId,
      correlationId: ctx.op?.correlationId ?? `refused_${ctx.operationId}`,
      actor: ctx.actor,
      data: { kind: "approval_refused", attempted: ctx.attempted, code: error.code, principalKind: ctx.actor.kind },
    });
  } catch {
    /* the refusal stands whether or not the audit row landed */
  }
  return error;
}

async function decide(deps: BrokerDeps, input: DecideInput, decision: "approve" | "reject"): Promise<ApprovalOutcome> {
  const { workspaceId, operationId, approver } = input;
  const attempted = decision;

  const access = await deps.roles.resolve(approver, workspaceId);
  if (access.role === "none") throw notFound();

  let op: OperationRecord | null = null;

  try {
    requireHumanSession(approver, input.session, "approve or reject an operation");
    if (access.role === "viewer") throw new BrokerError("approver_role_insufficient", "A viewer cannot approve or reject operations.", "Ask an editor or admin.");

    op = await deps.store.getOperation(workspaceId, operationId);
    if (!op) throw notFound();
    if (op.status !== "awaiting_approval") {
      throw new BrokerError("invalid_state", `This operation is ${op.status}; only an operation awaiting approval can be approved or rejected.`, undefined, { status: op.status });
    }
    if (Date.parse(op.expiresAt) <= deps.clock.now().getTime()) {
      await deps.store.expireOperation({ workspaceId, id: op.id });
      throw new BrokerError("operation_expired", "The operation expired before it was reviewed.", "Propose it again.");
    }
    if (op.proposalDigest !== input.proposalDigest) {
      throw new BrokerError("digest_mismatch", "The digest you reviewed does not match the operation's current proposal.", "Reload the operation and review the exact proposal.");
    }
    const round = approvalRoundOf(op);
    const review = operationPlanReview(op);
    const teardownReview = (op.proposal as import("./types").BrokerProposal).broker?.teardownReview;
    if (decision === "approve" && teardownReview && (!review || input.planDigest !== op.planDigest)) {
      throw new BrokerError("digest_mismatch", "Review the recorded destroy PlanView and supply its exact plan digest before approving teardown.");
    }
    if ((input.planDigest !== undefined && input.planDigest !== op.planDigest) ||
        (decision === "approve" && round > 0 && op.planDigest && input.planDigest !== op.planDigest)) {
      throw new BrokerError("digest_mismatch", "The reviewed plan digest does not match the gated plan.", "Reload and review the current plan.");
    }
    if (decision === "approve" && round > 0 && op.planDigest && !review) {
      throw new BrokerError("invalid_state", "The gated plan is unavailable for review.", "Restore its planning evidence before approving.");
    }
    if (decision === "approve" && review?.semantics && input.semanticsDigest !== review.semantics.digest) {
      throw new BrokerError("semantics_mismatch", "The executable semantics you reviewed do not match the ones recorded for this plan.", "Reload the operation and review the plan with its executable semantics digest.", {
        recorded: review.semantics.digest,
      });
    }
    const stored = op.policyDecisionId ? await deps.store.getPolicyDecision(workspaceId, op.policyDecisionId) : null;
    if (!stored?.approval) {
      throw new BrokerError("invalid_state", "This operation has no recorded approval requirement, so it cannot be approved.");
    }

    let policyVersion: string;
    if (decision === "approve") {
      const re = await reevaluate(deps, op);
      if (re.gone) {
        throw new BrokerError("policy_denied", "The requester no longer has access, or the target no longer exists.", "Reject this proposal and propose again if it is still wanted.");
      }
      const evaluation = review ? await evaluate(deps, {
        ...requestFromOperation(op), planDigest: op.planDigest,
        plan: { ...review.facts,
          ...(review.cost.deltaUsdMonthly !== undefined ? { costDeltaUsdMonthly: review.cost.deltaUsdMonthly } : {}),
          ...(review.cost.projectedMonthlyUsd !== undefined ? { projectedMonthlyUsd: review.cost.projectedMonthlyUsd } : {}),
        },
      }) : re.evaluation;
      const current = evaluation.decision;
      if (current.outcome === "deny") {
        throw new BrokerError("policy_denied", "Policy no longer allows this proposal.", "Reject it and propose again if it is still wanted.", { reasons: current.reasons.map((r) => r.code).slice(0, 20) });
      }
      if (current.outcome === "require_approval" && current.approval && isStricter(current.approval, stored.approval)) {
        throw new BrokerError("reapproval_required", "Policy changed after this was proposed and now needs a stricter approval than the one this proposal was created under.", "Reject it and propose again.", {
          now: current.approval,
        });
      }
      policyVersion = evaluation.evaluated.policyVersion;
    } else {
      policyVersion = stored.policyVersion;
    }

    // The store adapter forwards additive ledger preconditions unchanged;
    // SQL validates them again under the operation row lock.
    const recordInput = {
      workspaceId,
      operationId,
      approver,
      approverRole: access.role,
      decision,
      proposalDigest: input.proposalDigest,
      policyVersion,
      reason: input.reason === undefined ? undefined : input.reason.slice(0, 2000),
      planDigest: input.planDigest,
      expectedApprovalRound: round,
    };
    const recorded = await deps.store.recordApproval(recordInput);

    if (decision === "approve" && review?.semantics) {
      // The approval row is bound to (proposal digest, plan digest); this audit row names the semantics it was given against.
      await deps.store.appendEvent({
        workspaceId,
        projectId: op.projectId,
        environmentId: op.environmentId,
        resourceId: op.resourceId,
        operationId,
        correlationId: op.correlationId,
        actor: approver,
        type: "policy.evaluated",
        data: { kind: "approval_semantics_bound", approvalId: recorded.approval.id, semanticsDigest: review.semantics.digest, planDigest: op.planDigest ?? null },
      }).catch(() => 0);
    }

    const finalized = recorded.operation.status !== "awaiting_approval";
    // The store appended operation.approved / operation.rejected with the decision. A partial
    // multi-approver set changes no status, so the broker records that it happened.
    if (!finalized) {
      await deps.store.appendEvent({
        workspaceId,
        projectId: op.projectId,
        environmentId: op.environmentId,
        resourceId: op.resourceId,
        operationId,
        correlationId: op.correlationId,
        actor: approver,
        type: "policy.evaluated",
        data: { kind: "approval_recorded", approvals: recorded.approvals, policyVersion, approvalId: recorded.approval.id },
      });
    }
    return {
      operation: { ...operationView(recorded.operation), approvalRound: approvalRoundOf(recorded.operation) },
      approval: {
        id: recorded.approval.id,
        decision,
        approverId: approver.id,
        approverRole: recorded.approval.approverRole,
        policyVersion: recorded.approval.policyVersion,
        createdAt: recorded.approval.createdAt,
        expiresAt: recorded.approval.expiresAt,
      },
      approvals: recorded.approvals,
      finalized,
    };
  } catch (error) {
    throw await audited(deps, error, { workspaceId, operationId, actor: approver, attempted, op: op ?? undefined });
  }
}

export const approve = (deps: BrokerDeps, input: DecideInput): Promise<ApprovalOutcome> => decide(deps, input, "approve");
export const reject = (deps: BrokerDeps, input: DecideInput): Promise<ApprovalOutcome> => decide(deps, input, "reject");

/**
 * Withdraw approval before execution. Allowed for an approver of the operation
 * or an admin. Cancels the operation (awaiting_approval | approved → cancelled)
 * and revokes any grant already issued for it; a claimed (running) operation
 * cannot be revoked here — that is the executor's cancellation.
 */
export async function revokeApproval(
  deps: BrokerDeps,
  input: { workspaceId: string; operationId: string; actor: Principal; session: BrowserSessionProof; reason?: string }
): Promise<{ operation: OperationView }> {
  const { workspaceId, operationId, actor } = input;
  const access = await deps.roles.resolve(actor, workspaceId);
  if (access.role === "none") throw notFound();
  try {
    requireHumanSession(actor, input.session, "revoke an approval");
  } catch (error) {
    throw await audited(deps, error, { workspaceId, operationId, actor, attempted: "revoke" });
  }
  const op = await deps.store.getOperation(workspaceId, operationId);
  if (!op) throw notFound();
  const approvals = await deps.store.listApprovals(workspaceId, operationId);
  const isApprover = approvals.some((a) => a.decision === "approve" && a.approver.id === actor.id);
  if (!isApprover && ROLE_RANK[access.role] < ROLE_RANK.admin) {
    throw await audited(deps, new BrokerError("role_insufficient", "Only an approver of this operation, or an admin, can withdraw approval.", "Ask one of them."), {
      workspaceId,
      operationId,
      actor,
      attempted: "revoke",
      op,
    });
  }
  const reason = scrubSecrets((input.reason ?? "").replace(/\s+/g, " ").slice(0, 300));
  const moved = await deps.store.cancelOperation({
    workspaceId,
    id: operationId,
    reason: `Approval revoked by ${actor.id}${reason ? `: ${reason}` : ""}. Propose again if the change is still wanted.`,
    actor,
  });
  if (!moved) {
    throw new BrokerError("invalid_state", `This operation is ${op.status}; approval can be withdrawn only before execution starts.`, undefined, { status: op.status });
  }
  return { operation: operationView(moved) };
}

/** The run-level approval a signed runbook step presents in place of a live per-step decision. */
export interface RunbookStepApproval {
  id: string;
  workspaceId: string;
  bindingDigest: string;
  requestedBy: string;
  approverId: string;
  expiresAt: string;
}

/**
 * Record a runbook run's approval on one of its step operations (PROD-MACH-03).
 *
 * The run approval was given in a browser session by a human other than the requester, against the binding digest
 * that fixes this step's exact signed definition, target and bounds; the step operation carries that same binding.
 * Every other rule of `decide` still applies: current role at the required minimum, separation of duties, a single
 * required approver, the operation awaiting approval and unexpired, and current policy re-evaluated. Internal only:
 * the runbook delivery path calls it, never a route.
 */
export async function approveRunbookStep(deps: BrokerDeps, input: { workspaceId: string; operationId: string; approval: RunbookStepApproval; expectedInputDigest: string }): Promise<ApprovalOutcome> {
  const { workspaceId, operationId, approval } = input;
  // Runbook records name accountable people as `user:<id>`; only a person's approval can stand for a step.
  const person = /^user:(.+)$/.exec(approval.approverId)?.[1];
  const approver: Principal = { kind: "user", id: person ?? approval.approverId, name: person ?? approval.approverId };
  let op: OperationRecord | null = null;
  try {
    op = await deps.store.getOperation(workspaceId, operationId);
    if (!op) throw notFound();
    const step = (op.proposal.input as { runbookStep?: { bindingDigest?: unknown } } | null)?.runbookStep;
    // The caller's own signed step input, not whatever an operation's opaque input claims.
    if (digest(op.proposal.input) !== input.expectedInputDigest || (op.proposal as import("./types").BrokerProposal).broker?.via !== "workflow") {
      throw new BrokerError("invalid_state", "This operation is not the delivered runbook step.");
    }
    if (!person || approval.workspaceId !== workspaceId || typeof step?.bindingDigest !== "string" || step.bindingDigest !== approval.bindingDigest
      || approval.requestedBy !== `user:${requesterOf(op.principal)}`) {
      throw new BrokerError("invalid_state", "The run approval does not bind this runbook step.");
    }
    if (Date.parse(approval.expiresAt) <= deps.clock.now().getTime()) throw new BrokerError("operation_expired", "The run approval has expired.", "Approve the run again.");
    if (op.status !== "awaiting_approval") {
      throw new BrokerError("invalid_state", `This operation is ${op.status}; only an operation awaiting approval can be approved.`, undefined, { status: op.status });
    }
    if (Date.parse(op.expiresAt) <= deps.clock.now().getTime()) {
      await deps.store.expireOperation({ workspaceId, id: op.id });
      throw new BrokerError("operation_expired", "The operation expired before it was approved.");
    }
    const stored = op.policyDecisionId ? await deps.store.getPolicyDecision(workspaceId, op.policyDecisionId) : null;
    if (!stored?.approval) throw new BrokerError("invalid_state", "This operation has no recorded approval requirement, so it cannot be approved.");
    if (stored.approval.count !== 1) throw new BrokerError("reapproval_required", "This step needs more than one approver; a single run approval cannot satisfy it.");
    const access = await deps.roles.resolve(approver, workspaceId);
    if (access.role === "none") throw notFound();
    if (ROLE_RANK[access.role] < ROLE_RANK[stored.approval.minRole]) {
      throw new BrokerError("approver_role_insufficient", `The run approver is ${access.role}; this step needs ${stored.approval.minRole}.`);
    }
    if (stored.approval.separationOfDuties && approver.id === requesterOf(op.principal)) {
      throw new BrokerError("separation_of_duties", "The run approver requested this run.");
    }
    const re = await reevaluate(deps, op);
    if (re.gone) throw new BrokerError("policy_denied", "The requester no longer has access, or the target no longer exists.");
    const current = re.evaluation.decision;
    if (current.outcome === "deny") throw new BrokerError("policy_denied", "Policy no longer allows this step.", undefined, { reasons: current.reasons.map((r) => r.code).slice(0, 20) });
    if (current.outcome === "require_approval" && current.approval && isStricter(current.approval, stored.approval)) {
      throw new BrokerError("reapproval_required", "Policy now needs a stricter approval than the run approval satisfies.");
    }
    // As in `decide`: the store adapter forwards the additive round precondition, which SQL re-checks under the row lock.
    const recordInput = {
      workspaceId, operationId, approver, approverRole: access.role, decision: "approve" as const, proposalDigest: op.proposalDigest,
      policyVersion: re.evaluation.evaluated.policyVersion, reason: `Runbook run approval ${approval.id}`, expectedApprovalRound: approvalRoundOf(op),
    };
    const recorded = await deps.store.recordApproval(recordInput);
    // Not best-effort: a delegated approval with no audit row fails the step, and nothing is dispatched.
    await deps.store.appendEvent({
      workspaceId, projectId: op.projectId, environmentId: op.environmentId, resourceId: op.resourceId, operationId,
      correlationId: op.correlationId, actor: approver, type: "policy.evaluated",
      data: { kind: "runbook_approval_applied", approvalId: recorded.approval.id, runbookApprovalId: approval.id, bindingDigest: approval.bindingDigest },
    });
    return {
      operation: { ...operationView(recorded.operation), approvalRound: approvalRoundOf(recorded.operation) },
      approval: { id: recorded.approval.id, decision: "approve", approverId: approver.id, approverRole: recorded.approval.approverRole,
        policyVersion: recorded.approval.policyVersion, createdAt: recorded.approval.createdAt, expiresAt: recorded.approval.expiresAt },
      approvals: recorded.approvals,
      finalized: recorded.operation.status !== "awaiting_approval",
    };
  } catch (error) {
    throw await audited(deps, error, { workspaceId, operationId, actor: approver, attempted: "approve", op: op ?? undefined });
  }
}
