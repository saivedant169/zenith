/**
 * Worker adapter over the capability broker's SAME evaluation/signing pipeline.
 * Read grants may only attenuate to plan/observe. Mutation grants require a
 * running operation, current authorization, live fence and digest-bound human
 * approvals. Proposal approvals authorize planning; only a later approval round
 * can authorize its concrete, write-once plan. Proposals remain immutable.
 * Deploy/apply/rollback secret sync also requires the secret capability's own
 * policy and approval checks; exact reviewed targets are signed server-side.
 */
import { randomUUID } from "node:crypto";
import { platformBroker, isDefaultPlatformBrokerFor, type Broker } from "@/lib/capabilities/platform";
import { capability, isCapability } from "@/lib/capabilities/catalog";
import { loadDestroyPlan } from "@/lib/capabilities/destroy-plan";
import { evaluate } from "@/lib/capabilities/evaluate";
import { requestFromOperation } from "@/lib/capabilities/reevaluate";
import { ROLE_RANK } from "@/lib/capabilities/ports";
import { lapsedStandingApprovalIds } from "@/lib/capabilities/standing-grants";
import { repos } from "@/lib/controlplane/db";
import { approvalRoundOf, operationPlanReview } from "@/lib/controlplane/db/repos/operation-review";
import type { ApprovalRequirement, CapabilityGrantClaims, OperationRecord, Sql } from "@/lib/controlplane/types";
import { createOperationsPort, workerStoreScope, StepFailedError, type BrokerPort, type PlanPolicyInput } from "@/lib/execution";
import { readPlanEvidence } from "@/lib/execution/plan-evidence";
import { EcsReplicaRepairInput, readRepairBinding, repairBindingDigest, repairBindingEvidenceId } from "@/lib/execution/ecs-replica-repair-binding";
import { secretResourcesForOperation } from "./secret-grants";
import { digest } from "@/lib/controlplane/digest";
import { effectiveAutonomy } from "@/lib/capabilities/autonomy";
import { resolveWorkspacePolicy } from "@/lib/policy/defaults";
import type { Evaluation } from "@/lib/capabilities/evaluate";
import type { CurrentDispatchRequirement, DispatchApprovalSnapshot } from "@/lib/execution/ports";
import { readCurrentNativeLinkedCredential, readCurrentNativeOAuthGrant, isCurrentNativeOAuthGrantFor } from "@/lib/capabilities/current-integration-grants";
import type { NativeLinkedCredentialTuple } from "@/lib/agent-access/authority/pg";
import type { NativeOAuthGrantTuple } from "@/lib/agent-access/control/journal-pg";
import { readNativeCleanupOwnerGrantOrigin, reserveNativeCleanupOwnerGrant, insertNativeCleanupOwnerGrant } from "./plan-artifacts";

type BrokerFactory = () => Promise<Broker>;
type NativeDispatchRequirement=CurrentDispatchRequirement&{readonly nativeCredential?:Readonly<NativeLinkedCredentialTuple>;readonly nativeCredentialRequiredScope?:string;readonly nativeOAuthGrant?:Readonly<NativeOAuthGrantTuple>;readonly nativeOAuthRequiredScope?:string;readonly delegatedDestroyPlan?:Readonly<{operationId:string;evidenceId:string}>};
const currentDispatchRequirements = new WeakMap<object, { sql: Sql; broker: Broker; defaultOrigin: boolean; value: NativeDispatchRequirement }>();
/** Fixed, non-secret reason codes for a dispatch requirement that could not be captured or is no longer current. */
const requirementGaps = new WeakMap<object, string>();
const unavailableRequirement = (gap = "unavailable"): never => { throw Object.assign(new StepFailedError("Current dispatch requirement is unavailable or changed."), { requirementGap: gap }); };
function immutable<T>(value: T): T {
  if (value && typeof value === "object") { for (const child of Object.values(value)) immutable(child); Object.freeze(value); }
  return value;
}
function nativeOperation(op: OperationRecord): Record<string, unknown> {
  return { id: op.id, workspace_id: op.workspaceId, project_id: op.projectId ?? null, environment_id: op.environmentId ?? null,
    resource_id: op.resourceId ?? null, capability: op.capability, principal: op.principal, proposal_digest: op.proposalDigest, input_digest: op.inputDigest,
    plan_digest: op.planDigest ?? null, approval_round: approvalRoundOf(op) };
}
/** Only the private factory registry can originate this value. Structural copies cannot supply it. */
export async function readCurrentDispatchRequirement(snapshot: unknown, sql: Sql, workspaceId: string, operationId: string): Promise<NativeDispatchRequirement | undefined> {
  if (!snapshot || typeof snapshot !== "object") return undefined;
  const entry = currentDispatchRequirements.get(snapshot);
  const valid = () => !!entry && entry.sql === sql && (entry.defaultOrigin ? isDefaultPlatformBrokerFor(entry.broker, sql) : process.env.NODE_ENV === "test")
    && entry.value.operation.workspace_id === workspaceId && entry.value.operation.id === operationId
    && (!entry.value.nativeOAuthGrant || isCurrentNativeOAuthGrantFor(entry.value.nativeOAuthGrant, sql, workspaceId,
      entry.value.nativeOAuthGrant.integration_id, entry.value.nativeOAuthGrant.subject));
  if (!entry || !valid()) return undefined;
  try { if ((await entry.broker.deps.policy()).version !== entry.value.policy.version || !valid()) return undefined; } catch { return undefined; }
  return entry.value;
}
/**
 * Why a snapshot does not hold a current default dispatch requirement: a fixed, non-secret code for the refusal's cause.
 * Diagnostic only; isDefaultCurrentDispatchRequirement remains the decision.
 */
export async function dispatchRequirementGap(snapshot: unknown, sql: Sql, workspaceId: string, operationId: string): Promise<string> {
  if (!snapshot || typeof snapshot !== "object") return "no-snapshot";
  const entry = currentDispatchRequirements.get(snapshot);
  if (!entry) return requirementGaps.get(snapshot) ?? "not-registered";
  if (!entry.defaultOrigin) return "not-default-origin";
  if (entry.sql !== sql) return "database-handle";
  if (!isDefaultPlatformBrokerFor(entry.broker, sql)) return "broker-identity";
  if (entry.value.operation.workspace_id !== workspaceId || entry.value.operation.id !== operationId) return "operation";
  if (entry.value.nativeOAuthGrant && !isCurrentNativeOAuthGrantFor(entry.value.nativeOAuthGrant, sql, workspaceId, entry.value.nativeOAuthGrant.integration_id, entry.value.nativeOAuthGrant.subject)) return "oauth-grant";
  try { if ((await entry.broker.deps.policy()).version !== entry.value.policy.version) return "policy-version"; } catch { return "policy-read"; }
  return "current";
}
/** The default paired runtime additionally refuses a modeled factory origin. */
export async function isDefaultCurrentDispatchRequirement(snapshot: unknown, sql: Sql, workspaceId: string, operationId: string): Promise<boolean> {
  if (!snapshot || typeof snapshot !== "object") return false;
  return currentDispatchRequirements.get(snapshot)?.defaultOrigin === true
    && await readCurrentDispatchRequirement(snapshot, sql, workspaceId, operationId) !== undefined;
}

export function createExecutionBroker(db: Sql, getBroker: BrokerFactory = platformBroker): BrokerPort {
  const ops = createOperationsPort(db);
  const load = async (id: string): Promise<OperationRecord> => {
    const op = await ops.get(id);
    if (!op) throw new StepFailedError("Operation not found.");
    return op;
  };
  const latestFacts = async (op: OperationRecord): Promise<PlanPolicyInput | undefined> => {
    if (!op.planDigest) return undefined;
    const reviewed = await repos.operations.get(db, op.workspaceId, op.id);
    const review = reviewed ? operationPlanReview(reviewed) : undefined;
    const parsed = review ? readPlanEvidence({ ...review }) : undefined;
    if (!parsed) throw new StepFailedError("The operation's plan has no authoritative evidence.");
    return { ...parsed.facts, ...(parsed.cost.deltaUsdMonthly !== undefined ? { costDeltaUsdMonthly: parsed.cost.deltaUsdMonthly } : {}), ...(parsed.cost.projectedMonthlyUsd !== undefined ? { projectedMonthlyUsd: parsed.cost.projectedMonthlyUsd } : {}) };
  };
  const repairReview = async (op: OperationRecord): Promise<string> => {
    const input = EcsReplicaRepairInput.safeParse(op.proposal.input);
    if (!input.success || !op.planDigest || !op.resourceId) throw new StepFailedError("Replica repair requires its supported recipe and concrete reviewed plan.");
    const evidence = await repos.evidence.get(db, op.workspaceId, repairBindingEvidenceId(op.id));
    const binding = evidence ? readRepairBinding(evidence.summary.binding) : undefined;
    const rows = await db.query<{ summary: Record<string, unknown> }>(
      `select summary from platform.evidence where workspace_id = $1 and operation_id = $2
       and kind = 'tofu_plan' and digest = $3 and simulated = false and summary->>'stage' = 'plan'
       order by created_at, id limit 1`, [op.workspaceId, op.id, op.planDigest]);
    const summary = rows[0]?.summary;
    const reviewedBinding = summary ? readRepairBinding(summary.repairBinding) : undefined;
    if (!evidence || evidence.simulated || evidence.operationId !== op.id || !binding || !reviewedBinding
      || binding.workspaceId !== op.workspaceId || binding.environmentId !== op.environmentId || binding.operationId !== op.id
      || binding.resourceId !== op.resourceId || binding.address !== input.data.address || binding.graphDigest !== input.data.graphDigest
      || binding.projectId !== op.projectId || evidence.digest !== repairBindingDigest(binding)
      || summary?.repairBindingDigest !== evidence.digest || repairBindingDigest(reviewedBinding) !== evidence.digest
      || summary?.planDigest !== op.planDigest || !readPlanEvidence(summary)) throw new StepFailedError("Replica repair has no matching immutable target binding and reviewed plan evidence.");
    return evidence.digest;
  };
  const decisionFor = async (broker: Broker, op: OperationRecord, facts?: PlanPolicyInput, cap = op.capability) => {
    const req = requestFromOperation(op);
    return evaluate(broker.deps, { ...req, def: capability(cap), risk: cap === op.capability ? req.risk : capability(cap).risk, ...(facts ? { plan: facts, planDigest: op.planDigest } : {}) });
  };
  const captureCurrentRequirement = async (op: OperationRecord, evaluation: Evaluation): Promise<Omit<NativeDispatchRequirement, "approvals"> & { candidates: Record<string, unknown>[] }> => {
    if (!op.planDigest || !op.environmentId || evaluation.decision.outcome === "deny") return unavailableRequirement("no-plan-or-environment");
    const current = await repos.operations.get(db, op.workspaceId, op.id);
    if (!current || digest(nativeOperation(current)) !== digest(nativeOperation(op))) return unavailableRequirement("operation-changed");
    const [workspace, environment, evidenceRows, candidates] = await Promise.all([
      repos.settings.getWorkspacePolicy(db, op.workspaceId), repos.settings.getEnvironmentSettings(db, op.workspaceId, op.environmentId),
      db.query<{ id: string; digest: string; summary: Record<string, unknown> }>(`select id,digest,summary from platform.evidence where workspace_id=$1 and operation_id=$2
        and kind='tofu_plan' and digest=$3 and not simulated and summary->>'stage'='plan' order by created_at,id limit 1`, [op.workspaceId, op.id, op.planDigest]),
      db.query<{ row: Record<string, unknown> }>(`select to_jsonb(a) as row from platform.approvals a where workspace_id=$1 and operation_id=$2
        and approval_round=$3 and proposal_digest=$4 order by id limit 10001`, [op.workspaceId, op.id, approvalRoundOf(op), op.proposalDigest]),
    ]);
    const evidence = evidenceRows[0], parsed = evidence && readPlanEvidence(evidence.summary);
    const facts = parsed && { ...parsed.facts, ...(parsed.cost.deltaUsdMonthly !== undefined ? { costDeltaUsdMonthly: parsed.cost.deltaUsdMonthly } : {}),
      ...(parsed.cost.projectedMonthlyUsd !== undefined ? { projectedMonthlyUsd: parsed.cost.projectedMonthlyUsd } : {}) };
    const input = evaluation.input;
    if (!evidence || !facts) return unavailableRequirement("plan-evidence");
    if (digest(facts) !== digest(input.plan)) return unavailableRequirement("plan-facts");
    if (digest(input) !== evaluation.evaluated.inputDigest) return unavailableRequirement("policy-input");
    if (candidates.length > 10000) return unavailableRequirement("approval-rows");
    if (input.request.scope.workspaceId !== op.workspaceId || input.request.scope.projectId !== op.projectId || input.request.scope.environmentId !== op.environmentId) return unavailableRequirement("scope");
    if (digest(resolveWorkspacePolicy(workspace.params)) !== digest(input.workspacePolicy)) return unavailableRequirement("workspace-policy");
    if (!input.environment || effectiveAutonomy(environment, input.environment.class).level !== input.environment.autonomyLevel) return unavailableRequirement("environment-autonomy");
    const nativeCredential=op.principal.kind==="integration"?readCurrentNativeLinkedCredential(op.principal,op.workspaceId,db):undefined;
    const nativeOAuthGrant=op.principal.kind==="integration"?readCurrentNativeOAuthGrant(op.principal,op.workspaceId,db):undefined;
    const delegated = input.principal.kind === "system" && input.principal.id === "teardown-review" && op.capability === "infrastructure.destroy";
    const proposal = op.proposal as { broker?: { v?: number; teardownReview?: boolean; destroyPlan?: { operationId?: string; evidenceId?: string } } };
    const destroyPlan = proposal.broker?.destroyPlan;
    if (delegated && (proposal.broker?.v !== 1 || proposal.broker.teardownReview !== true || !destroyPlan?.operationId || !destroyPlan.evidenceId
      || !evaluation.decision.approval || evaluation.decision.approval.minRole !== "admin" || evaluation.decision.approval.count < 1)) return unavailableRequirement("teardown-delegation");
    const nativeCredentialRequiredScope = delegated ? capability("infrastructure.plan").integrationScope : input.request.integrationScope;
    const integrationTuple = nativeCredential ?? nativeOAuthGrant;
    if(op.principal.kind==="integration"&&(!integrationTuple||!!nativeCredential===!!nativeOAuthGrant||!nativeCredentialRequiredScope
      ||!integrationTuple.scopes.some(scope => scope === nativeCredentialRequiredScope)
      ||digest(evaluation.access.integrationScopes)!==digest(integrationTuple.scopes)||digest(evaluation.access.allowedProjectIds)!==digest(integrationTuple.project_ids)
      ||digest(evaluation.access.allowedEnvironmentIds??null)!==digest(integrationTuple.environment_ids)
      ||!op.projectId||!integrationTuple.project_ids.includes(op.projectId)||integrationTuple.environment_ids&&!integrationTuple.environment_ids.includes(op.environmentId)
      ||input.principal.kind==="integration"&&digest(input.principal.integrationScopes)!==digest(integrationTuple.scopes)))return unavailableRequirement("integration-grant");
    const captured=immutable(structuredClone({ requirement: evaluation.decision.approval ? evaluation.decision.approval : null,
      policy: { version: evaluation.evaluated.policyVersion, inputDigest: evaluation.evaluated.inputDigest, input: structuredClone(input) },
      operation: nativeOperation(current), settings: {
        workspace: workspace.isDefault ? null : { workspace_id: op.workspaceId, params: workspace.params },
        environment: environment.isDefault ? null : { workspace_id: op.workspaceId, environment_id: op.environmentId, autonomy_level: environment.autonomyLevel, policy_params: environment.policyParams },
      }, evidence, candidates: candidates.map(value => value.row) }));
    return immutable({ ...captured, ...(nativeCredential ? { nativeCredential, nativeCredentialRequiredScope } : {}),
      ...(nativeOAuthGrant ? { nativeOAuthGrant, nativeOAuthRequiredScope: nativeCredentialRequiredScope } : {}),
      ...(delegated && destroyPlan?.operationId && destroyPlan.evidenceId ? { delegatedDestroyPlan: { operationId: destroyPlan.operationId, evidenceId: destroyPlan.evidenceId } } : {}) });
  };
  const approvals = async (broker: Broker, op: OperationRecord, requirement?: ApprovalRequirement) => {
    const all = await broker.deps.store.listApprovals(op.workspaceId, op.id);
    const time = broker.deps.clock.now().getTime();
    const round = approvalRoundOf(op);
    // Standing-grant approvals stop counting when the grant is revoked/expired or its creator lost admin (PROD-DUR-04).
    const lapsed = await lapsedStandingApprovalIds(broker.deps, op);
    const live = all.filter((a) => approvalRoundOf(a) === round && a.proposalDigest === op.proposalDigest && Date.parse(a.expiresAt) > time && !lapsed.has(a.id));
    const rejected = live.some((a) => a.decision === "reject") || ["rejected", "cancelled", "denied"].includes(op.status);
    if (!requirement) return { approved: !rejected, rejected, dispatchApproval: { approvalIds: [],requiredApprovalCount:0,approvalRound:round,proposalDigest:op.proposalDigest,planDigest:op.planDigest } };
    // Round zero cannot authorize the subsequently gated concrete plan.
    if (op.planDigest && round === 0) {
      // A destroy proposal can include its already-reviewed source in the immutable initial proposal.
      // This never attests bytes: dispatch still requires the authenticated artifact association.
      const ref=(op.proposal as {broker?:{v?:number;destroyPlan?:{operationId?:string;evidenceId?:string}}}).broker;
      if(op.capability!=="infrastructure.destroy" || op.proposal.planDigest!==op.planDigest || ref?.v!==1 || !ref.destroyPlan?.operationId || !ref.destroyPlan.evidenceId) return {approved:false,rejected};
      try {
        const source=await broker.deps.store.getOperation(op.workspaceId,ref.destroyPlan.operationId);
        const intent=source?.proposal.input as {environmentId?:string;teardownReview?:boolean}|undefined;
        const original=await loadDestroyPlan(broker.deps,op.proposal.scope,{operationId:ref.destroyPlan.operationId,planDigest:op.planDigest});
        if(source?.capability!=="infrastructure.plan" || !intent?.teardownReview || intent.environmentId!==op.environmentId
          || original.evidenceId!==ref.destroyPlan.evidenceId || original.planDigest!==op.planDigest) return {approved:false,rejected};
      } catch { return {approved:false,rejected}; }
    }
    const validated: typeof live = [];
    for (const a of live) {
      if (a.decision !== "approve" || a.approver.kind !== "user") continue;
      if (a.consumedAt && op.status !== "running") continue;
      if (requirement.separationOfDuties && a.approver.id === (op.principal.onBehalfOf ?? op.principal.id)) continue;
      const access = await broker.deps.roles.resolve(a.approver, op.workspaceId);
      if (ROLE_RANK[access.role] < ROLE_RANK[requirement.minRole]) continue;
      validated.push(a);
    }
    // Role resolution can await external stores. Recheck time after the final await, then bind exact IDs for the SQL boundary.
    const finalTime=broker.deps.clock.now().getTime();
    const current=validated.filter(a=>Date.parse(a.expiresAt)>finalTime);
    const currentUsers=new Set(current.map(a=>a.approver.id));
    return { approved: !rejected && currentUsers.size >= requirement.count, rejected, approvalId: current.at(-1)?.id,
      dispatchApproval: { approvalIds:current.map(a=>a.id),requiredApprovalCount:requirement.count,approvalRound:round,proposalDigest:op.proposalDigest,planDigest:op.planDigest } };
  };
  return {
    reevaluate: (id, facts) => workerStoreScope(async () => {
      const op = await load(id);
      const broker = await getBroker();
      const evaluation = await decisionFor(broker, op, facts);
      const decision = evaluation.decision;
      const recorded = await broker.deps.store.recordPolicyDecision({ workspaceId: op.workspaceId, operationId: op.id, policyVersion: evaluation.evaluated.policyVersion, inputDigest: evaluation.evaluated.inputDigest, ...decision });
      return { outcome: decision.outcome, decisionId: recorded.id, reasons: decision.reasons.map((r) => r.code) };
    }),
    approvalStatus: (id) => workerStoreScope(async () => {
      const op = await load(id);
      const broker = await getBroker();
      const facts = await latestFacts(op);
      const evaluation = await decisionFor(broker, op, facts), { decision } = evaluation;
      if (decision.outcome === "deny") return { approved: false, rejected: true };
      if (decision.outcome === "require_approval" && !decision.approval) throw new StepFailedError("Current policy did not specify an approval requirement.");
      // Capture the actual current evaluation before any approving-human await.
      // Unavailable private provenance cannot change the public projection into
      // authority: saved-plan dispatch will refuse without a genuine capture.
      let captured: Awaited<ReturnType<typeof captureCurrentRequirement>> | undefined;
      let captureGap: string | undefined;
      if (op.planDigest) {
        try { captured = await captureCurrentRequirement(op, evaluation); } catch (error) {
          captured = undefined;
          const gap = (error as { requirementGap?: unknown } | null)?.requirementGap;
          captureGap = typeof gap === "string" ? gap : "capture-error";
        }
      }
      const result = await approvals(broker, op, decision.approval);
      if (result.dispatchApproval) {
        const snapshot: DispatchApprovalSnapshot = immutable({ ...result.dispatchApproval, approvalIds: [...result.dispatchApproval.approvalIds] });
        if (captured && result.approved && !result.rejected) {
          const selected = snapshot.approvalIds.map(id => captured.candidates.filter(value => value.id === id));
          if (new Set(snapshot.approvalIds).size === snapshot.approvalIds.length && selected.every(rows => rows.length === 1)) {
            const { candidates: _candidates, ...value } = captured;
            currentDispatchRequirements.set(snapshot, { sql: db, broker, defaultOrigin: getBroker === platformBroker && isDefaultPlatformBrokerFor(broker, db), value: immutable({ ...value, approvals: selected.map(rows => rows[0]) }) });
          } else requirementGaps.set(snapshot, "approval-selection");
        } else requirementGaps.set(snapshot, captureGap ?? (op.planDigest ? "not-approved" : "no-plan"));
        return { ...result, dispatchApproval: snapshot };
      }
      return result;
    }),
    issueGrant: (id, audience, fence, opts) => workerStoreScope(async () => {
      const op = await load(id);
      if (op.status !== "running") throw new StepFailedError("Only a running operation can receive an activity grant.");
      const cap = opts?.capability ?? op.capability;
      const secretSync = cap === "secret.write" && ["deployment.deploy", "infrastructure.apply", "deployment.rollback"].includes(op.capability);
      if (!isCapability(cap) || (cap !== op.capability && !secretSync && !["infrastructure.plan", "infrastructure.observe"].includes(cap))) throw new StepFailedError("Requested grant does not attenuate this operation.");
      if (cap !== op.capability && (!op.environmentId || !capability(op.capability).mutates)) throw new StepFailedError("This operation cannot issue an environment read grant.");
      // Unconditional for destroy, including direct Kubernetes/Zenith paths:
      // a caller flag or an operation match cannot originate this active held-attempt capability.
      const cleanupOrigin=cap==="infrastructure.destroy"?await readNativeCleanupOwnerGrantOrigin(db,id,cap,audience,fence):undefined;
      const broker = await getBroker();
      const facts = cap === op.capability || secretSync ? await latestFacts(op) : undefined;
      const replicaRepair = cap === "drift.repair";
      const bindingDigest = replicaRepair ? await repairReview(op) : undefined;
      if (replicaRepair && (!facts || audience !== "worker" || approvalRoundOf(op) === 0)) throw new StepFailedError("Replica repair needs a concrete plan in the current human approval round.");
      let parentDuration = 3600;
      let parentTargets: unknown;
      if (secretSync) {
        if (!facts || audience !== "worker") throw new StepFailedError("Secret sync requires a reviewed plan and a worker grant.");
        const original = (await decisionFor(broker, op, facts)).decision;
        if (original.outcome === "deny" || (original.outcome === "require_approval" && (!original.approval || !(await approvals(broker, op, original.approval)).approved))) throw new StepFailedError("Current policy or approval denies this deployment's secret sync.");
        parentDuration = typeof original.constraints?.grantDurationSec === "number" ? original.constraints.grantDurationSec : 900;
        parentTargets = original.constraints?.secretResources;
      }
      const { decision } = await decisionFor(broker, op, facts, cap);
      // Rule codes are fixed vocabulary; they tell an operator which policy refused, never input values.
      if (decision.outcome === "deny") throw new StepFailedError(`Current policy denies this activity grant (${decision.reasons.map((reason) => reason.code).filter((code) => /^[a-z0-9_]{1,64}$/.test(code)).join(", ") || "no reason code"}).`);
      if (decision.outcome === "require_approval") {
        if (!decision.approval || !(await approvals(broker, op, decision.approval)).approved) throw new StepFailedError("Current policy requires human approval of this exact proposal and plan in the current round.");
      }
      if (capability(cap).mutates && !fence) throw new StepFailedError("Mutating activity grants require an environment fence.");
      if (fence) {
        if (fence.scope !== `env:${op.environmentId}`) throw new StepFailedError("Grant fence does not protect this environment.");
        await repos.leases.assertFence(db, fence.scope, fence.fenceToken);
      }
      let constraints = decision.constraints;
      if (replicaRepair) {
        if (decision.outcome !== "require_approval" || !decision.approval) throw new StepFailedError("Replica repair requires current human approval.");
        // Unknown restrictions cannot be ignored by this narrowly scoped adapter.
        if (Object.keys(constraints ?? {}).some((key) => key !== "grantDurationSec")) throw new StepFailedError("Replica repair cannot enforce this policy constraint; nothing was authorized.");
        constraints = { ...constraints, repairPlanDigest: op.planDigest!, repairBindingDigest: bindingDigest! };
        const current = await load(id);
        if (current.status !== "running" || current.planDigest !== op.planDigest || approvalRoundOf(current) !== approvalRoundOf(op)) throw new StepFailedError("Replica repair authority changed before grant issuance.");
      }
      if (secretSync) {
        const targets = await secretResourcesForOperation(db, op);
        for (const allowed of [parentTargets, decision.constraints?.secretResources]) {
          if (allowed !== undefined && (!Array.isArray(allowed) || targets.some((id) => !allowed.includes(id)))) throw new StepFailedError("Policy constraints deny these secret targets.");
        }
        constraints = { ...constraints, secretResources: targets };
        if ((await load(id)).status !== "running") throw new StepFailedError("The operation stopped before secret grant issuance.");
      }
      // Target reads may take time; never sign after this environment fence is lost.
      if ((secretSync || replicaRepair) && fence) await repos.leases.assertFence(db, fence.scope, fence.fenceToken);
      const iat = Math.floor(broker.deps.clock.now().getTime() / 1000);
      const requested = opts?.durationSec ?? 900;
      const policySec = typeof decision.constraints?.grantDurationSec === "number" ? decision.constraints.grantDurationSec : 900;
      if (!Number.isInteger(requested) || requested < 1 || !Number.isFinite(policySec) || policySec < 1 || !Number.isFinite(parentDuration) || parentDuration < 1) throw new StepFailedError("Grant duration is invalid.");
      const exp = Math.min(iat + Math.max(1, Math.min(3600, requested, policySec, parentDuration)), Math.floor(Date.parse(op.expiresAt) / 1000));
      if (exp <= iat) throw new StepFailedError("Operation expired before grant issuance.");
      const claims: CapabilityGrantClaims = { jti: randomUUID(), iss: broker.deps.issuer ?? "zenith-control", aud: audience, sub: op.principal.onBehalfOf ?? op.principal.id, iat, exp, cap, op: op.id, digest: op.proposalDigest, ws: op.workspaceId, proj: op.projectId, env: op.environmentId, res: op.resourceId, fence: fence?.fenceToken, constraints };
      if(cleanupOrigin)await reserveNativeCleanupOwnerGrant(cleanupOrigin,db,claims.jti);
      await broker.deps.signer.ready();
      const jws = await broker.deps.signer.sign(claims);
      const grant={ jti: claims.jti, workspaceId: op.workspaceId, operationId: op.id, capability: cap, audience, issuedAt: new Date(iat * 1000).toISOString(), expiresAt: new Date(exp * 1000).toISOString() };
      if(cleanupOrigin)await insertNativeCleanupOwnerGrant(cleanupOrigin,db,grant);
      else await broker.deps.store.insertGrant(grant);
      // The signed bearer remains local; it never enters evidence or workflow history.
      return { jws, claims };
    }),
  };
}
