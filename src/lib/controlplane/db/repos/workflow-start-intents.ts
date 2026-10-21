/** SQL-only start authority; all transport is outside these retriable transactions. */
import { randomUUID } from "node:crypto";
import { createBroker, isMemoryStoreEnabled, type Broker } from "@/lib/capabilities/platform";
import { PlatformBrokerStore } from "@/lib/capabilities/platform-store";
import type { BrokerDeps } from "@/lib/capabilities/ports";
import { capability, isCapability } from "@/lib/capabilities/catalog";
import { MACHINE_HEALTH_OPERATIONS } from "@/lib/machines/telemetry";
import type { MachineOperation } from "@/lib/machines/types";
import { digest } from "@/lib/controlplane/digest";
import type { Sql, Principal } from "@/lib/controlplane/types";
import type { DispatchApprovalSnapshot } from "@/lib/execution/ports";
import { credentialPatternsIn } from "@/lib/credentials/redact";
import type { AutonomyLevel } from "@/lib/policy";
import { textArray } from "../sql";
import { assertDefaultMcpProductTopology, assertFinalMcpProductTopology, captureMcpDeployAuthority, requiresMcpDeployAuthority, MCP_DEPLOY_AUTHORITY } from "./workflow-start-deploy-authority";

export type WorkflowStartKind = "deploy" | "destroy" | "dayTwo" | "remediation" | "teardownReview" | "mixedParent";
export type ScalarArguments = Readonly<Record<string, string | boolean>>;
export const WORKFLOW_START_TYPES = Object.freeze({
  deploy: "infrastructureDeployWorkflow", destroy: "infrastructureDestroyWorkflow",
  dayTwo: "dayTwoOperationWorkflow", remediation: "remediationWorkflow", teardownReview: "teardownReviewWorkflow",
  mixedParent: "mixedParentWorkflow",
});
const FIELDS: Readonly<Record<WorkflowStartKind, readonly string[]>> = {
  deploy: ["workspaceId","operationId","projectId","environmentId","revisionId","deploymentId","connectionId","preApproved","build"],
  destroy: ["workspaceId","operationId","environmentId"], dayTwo: ["workspaceId","operationId","environmentId","capability"],
  remediation: ["workspaceId","operationId","environmentId","incidentId"], teardownReview: ["workspaceId","operationId"],
  mixedParent: ["workspaceId","operationId","environmentId","parentPlanId"],
};
const ID = /^[A-Za-z0-9_.:-]{1,128}$/;
const HEX = /^[a-f0-9]{64}$/;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
export class WorkflowStartIntentError extends Error {
  readonly code = "workflow_start_intent";
  constructor() { super("Workflow start authority is unavailable or conflicts with the retained intent. Inspect the operation; do not restart it."); this.name = "WorkflowStartIntentError"; }
}
function refuse(): never { throw new WorkflowStartIntentError(); }
function own(value: unknown, key: string): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return refuse();
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (!descriptor || !("value" in descriptor)) return refuse();
  return descriptor.value;
}
function id(value: unknown): string {
  if (typeof value !== "string" || !ID.test(value) || credentialPatternsIn(value).length) return refuse();
  return value;
}
/** Same own-scalar payload rule as legacy starts; extra properties are never evaluated or serialized. */
export function snapshotWorkflowArguments(kind: WorkflowStartKind, value: unknown): ScalarArguments {
  if (!Object.hasOwn(FIELDS, kind)) return refuse();
  const out: Record<string,string|boolean> = {};
  for (const key of FIELDS[kind]) {
    const field = own(value,key);
    if (key === "preApproved" || key === "build") { if (typeof field !== "boolean") return refuse(); out[key] = field; }
    else out[key] = id(field);
  }
  return Object.freeze(out);
}
export interface StartRequest {
  readonly kind: WorkflowStartKind;
  readonly arguments: ScalarArguments;
  readonly namespace: string;
  /** Hash of validated frontend address plus TLS mode, never a credential or URL. */
  readonly endpointDigest: string;
  readonly taskQueue: string;
}
export interface StartBinding extends StartRequest {
  readonly format: "zenith.workflow-start.v1";
  readonly workflowType: string;
  readonly workflowId: string;
  /** Present (> 0) only for an operation reopened after a restore; part of workflowId and of the binding digest. */
  readonly recoveryEpoch?: number;
  readonly argumentsDigest: string;
  readonly proposalDigest: string;
  readonly inputDigest: string;
  /** Request-source identity from immutable operation plus scalar arguments, not a product revision/source-bytes attestation. */
  readonly sourceDigest: string;
  /** Fixed start settings, including the pinned raw history's allowed default priority/time-skipping state. */
  readonly configDigest: string;
}
export const START_CONFIG = Object.freeze({ workflowTaskTimeoutSeconds: 10, workflowMaximumAttempts: 1,
  reuse: "REJECT_DUPLICATE", conflict: "FAIL", cron: false, parent: false, eager: false, versionOverride: false,
  priority: "parentless-default", timeSkipping: "disabled-no-propagation", declinedTargetVersionUpgrade: false });
export interface WorkflowStartIntent {
  readonly workspace_id: string; readonly operation_id: string; readonly binding: StartBinding; readonly binding_digest: string;
  readonly phase: "prepared"|"attempted"|"acknowledged"; readonly attempt_id: string|null; readonly run_id: string|null;
  readonly observed_start_at: string|null; readonly evidence_digest: string|null;
  readonly created_at: string; readonly attempted_at: string|null; readonly acknowledged_at: string|null;
}
interface Operation {
  workspace_id: string; id: string; capability: string; project_id: string|null; environment_id: string|null;
  proposal: { capability: string; scope: {workspaceId:string;projectId?:string;environmentId?:string}; input?: Record<string,unknown> };
  proposal_digest: string; input_digest: string; plan_digest: string|null;
  recovery_epoch?: number|string|null;
  status: string; approval_round: number; approval_required: boolean; workflow_id: string|null;
  lease_scope: string|null; fence_token: number|null; lease_holder: string|null;
  principal: Principal;
}
function requestCopy(input: StartRequest): StartRequest {
  const kind = own(input,"kind") as WorkflowStartKind;
  const args = snapshotWorkflowArguments(kind,own(input,"arguments"));
  const namespace = own(input,"namespace"), endpointDigest = own(input,"endpointDigest"), taskQueue = own(input,"taskQueue");
  if (typeof namespace !== "string" || !/^[A-Za-z0-9._-]{1,255}$/.test(namespace)
    || typeof endpointDigest !== "string" || !HEX.test(endpointDigest)) return refuse();
  return Object.freeze({ kind, arguments: args, namespace, endpointDigest, taskQueue: id(taskQueue) });
}
function fromRow(row: WorkflowStartIntent): WorkflowStartIntent {
  const request = requestCopy(row.binding);
  const b = row.binding;
  if (b.format !== "zenith.workflow-start.v1" || b.workflowType !== WORKFLOW_START_TYPES[request.kind]
    || epochOf(b as { recoveryEpoch?: unknown }) < 0 || b.workflowId !== workflowId(request, epochOf(b as { recoveryEpoch?: unknown })) || b.argumentsDigest !== digest(request.arguments)
    || b.configDigest !== digest(START_CONFIG) || !HEX.test(b.proposalDigest) || !HEX.test(b.inputDigest)
    || b.sourceDigest !== digest({proposalDigest:b.proposalDigest,inputDigest:b.inputDigest,argumentsDigest:b.argumentsDigest})
    || digest(b) !== row.binding_digest || request.arguments.workspaceId !== row.workspace_id || request.arguments.operationId !== row.operation_id) return refuse();
  return Object.freeze({ ...row, binding: Object.freeze({ ...b, ...request }) });
}
/** Epoch 0 keeps the historical id. An operation reopened after a restore (recovery epoch > 0) starts a NEW
 * workflow: the pre-restore one may have run after the backup, and REJECT_DUPLICATE must keep refusing it. */
function workflowId(request: StartRequest, recoveryEpoch = 0): string {
  return `${request.kind === "teardownReview" ? "teardown-review" : "op"}-${request.arguments.operationId}${recoveryEpoch > 0 ? `-e${recoveryEpoch}` : ""}`;
}
const epochOf = (b: { recoveryEpoch?: unknown }): number => b.recoveryEpoch === undefined ? 0
  : Number.isSafeInteger(b.recoveryEpoch) && (b.recoveryEpoch as number) > 0 ? b.recoveryEpoch as number : -1;
function matches(row: WorkflowStartIntent, request: StartRequest): void {
  const prior = row.binding;
  if (prior.kind !== request.kind || prior.endpointDigest !== request.endpointDigest || prior.namespace !== request.namespace
    || prior.taskQueue !== request.taskQueue || prior.argumentsDigest !== digest(request.arguments)) return refuse();
}
function bind(request: StartRequest, op: Operation): StartBinding {
  if (op.workspace_id !== request.arguments.workspaceId || op.id !== request.arguments.operationId
    || op.proposal.capability !== op.capability || op.proposal.scope.workspaceId !== op.workspace_id
    || (op.proposal.scope.projectId ?? null) !== op.project_id || (op.proposal.scope.environmentId ?? null) !== op.environment_id
    || !HEX.test(op.proposal_digest) || !HEX.test(op.input_digest) || digest(op.proposal) !== op.proposal_digest
    || digest(op.proposal.input ?? null) !== op.input_digest || (op.workflow_id !== null && op.workflow_id !== workflowId(request))) return refuse();
  const args = request.arguments, input = op.proposal.input;
  if (request.kind !== "teardownReview" && args.environmentId !== op.environment_id) return refuse();
  if (request.kind === "deploy") {
    // A mixed parent operation is a deploy-capability proposal that only the parent workflow may run (PROD-MIX-02): never the single-provider deploy workflow.
    if (input?.mixedParentPlanId !== undefined || input?.mixedParentReviewOf !== undefined) return refuse();
    if (!["deployment.deploy","deployment.rollback","infrastructure.apply"].includes(op.capability)
      || args.projectId !== op.project_id || args.revisionId !== input?.revisionId
      || args.deploymentId !== (input?.deploymentId ?? `dep-${op.id}`)
      || (typeof input?.build === "boolean" && args.build !== input.build)
      || (requiresMcpDeployAuthority(request.kind, op)
        && (args.connectionId !== input?.connectionId || args.preApproved !== true))) return refuse();
  } else if (request.kind === "mixedParent") {
    if (op.capability !== "deployment.deploy" || typeof input?.mixedParentPlanId !== "string" || args.parentPlanId !== input.mixedParentPlanId) return refuse();
  } else if (request.kind === "destroy") { if (op.capability !== "infrastructure.destroy") return refuse(); }
  else if (request.kind === "teardownReview") {
    if (op.capability !== "infrastructure.plan" || input?.teardownReview !== true || input.environmentId !== op.environment_id) return refuse();
  } else {
    // Day-two runs mutations, plus the approved read-only machine health reads the worker serves through readMachineHealth (PROD-OBS-02).
    const healthRead = request.kind === "dayTwo" && MACHINE_HEALTH_OPERATIONS.has(op.capability as MachineOperation);
    if (!isCapability(op.capability) || (!capability(op.capability).mutates && !healthRead)
      || ["deployment.deploy","deployment.rollback","infrastructure.apply","infrastructure.destroy"].includes(op.capability)) return refuse();
    if (request.kind === "dayTwo" && args.capability !== op.capability) return refuse();
    if (request.kind === "remediation" && args.incidentId !== input?.incidentId) return refuse();
  }
  const recoveryEpoch = Number(op.recovery_epoch ?? 0);
  if (!Number.isSafeInteger(recoveryEpoch) || recoveryEpoch < 0) return refuse();
  return Object.freeze({ ...request, format: "zenith.workflow-start.v1", workflowType: WORKFLOW_START_TYPES[request.kind],
    ...(recoveryEpoch > 0 ? { recoveryEpoch } : {}),
    workflowId: workflowId(request, recoveryEpoch), argumentsDigest: digest(args), proposalDigest: op.proposal_digest,
    inputDigest: op.input_digest, sourceDigest:digest({proposalDigest:op.proposal_digest,inputDigest:op.input_digest,argumentsDigest:digest(args)}),
    configDigest: digest(START_CONFIG) });
}
export async function get(sql: Sql, workspaceId: string, operationId: string): Promise<WorkflowStartIntent|null> {
  const rows = await sql.query<WorkflowStartIntent>("select * from platform.workflow_start_intents where workspace_id=$1 and operation_id=$2",[id(workspaceId),id(operationId)]);
  return rows[0] ? fromRow(rows[0]) : null;
}
async function lockedOperation(tx: Sql, request: StartRequest): Promise<Operation> {
  const params = [request.arguments.workspaceId,request.arguments.operationId];
  const before = (await tx.query<Operation>("select * from platform.operations where workspace_id=$1 and id=$2",params))[0];
  if (!before) return refuse();
  // Same order as canonical execution: recorded environment lease, then operation, then intent.
  if (before.lease_scope !== null) await tx.query("select scope from platform.leases where scope=$1 for share",[before.lease_scope]);
  const op = (await tx.query<Operation>("select * from platform.operations where workspace_id=$1 and id=$2 for update",params))[0];
  if (!op || op.lease_scope !== before.lease_scope || op.fence_token !== before.fence_token) return refuse();
  return op;
}
type AuthorityDependencies = Readonly<Omit<BrokerDeps,"store">>;
const AUTHORITY_DEADLINE_MS = 8_000;
function captureDependencies(broker: Broker): AuthorityDependencies {
  const {scopes,roles,signer,clock,policy,issuer,newId}=broker.deps;
  return Object.freeze({scopes,roles,signer,clock,policy,issuer,newId});
}
async function canonicalDependencies(tx: Sql, signal: AbortSignal): Promise<AuthorityDependencies> {
  const [{currentProductRoleResolver},{platformScopeResolver},{CredentialGrantSigner},{systemClock},{loadPolicyEngine}]=await Promise.all([
    import("@/lib/capabilities/current-product-roles"),import("@/lib/platform/scopes"),
    import("@/lib/capabilities/credential-signer"),import("@/lib/capabilities/ports"),import("@/lib/policy"),
  ]);
  return Object.freeze({scopes:platformScopeResolver(tx),roles:currentProductRoleResolver({signal}),
    signer:new CredentialGrantSigner(),clock:systemClock,policy:()=>loadPolicyEngine()});
}
interface SettingsSnapshot {
  workspaceId:string; environmentId:string;
  policy:{present:boolean;version:number;params:Record<string,unknown>};
  environment:{present:boolean;version:number;autonomyLevel:AutonomyLevel;policyParams:Record<string,unknown>};
}
function freezeSnapshot<T>(value:T):T {
  if(value && typeof value === "object") {Object.values(value).forEach(freezeSnapshot);Object.freeze(value);}
  return value;
}
async function captureSettings(tx:Sql,op:Operation):Promise<SettingsSnapshot> {
  const environmentId=id(op.environment_id),workspaceId=id(op.workspace_id);
  const [policies,environments]=await Promise.all([
    tx.query<{workspace_id:string;version:number;params:Record<string,unknown>}>(
      "select workspace_id,version,params from platform.workspace_policy where workspace_id=$1",[workspaceId]),
    // Globally keyed environment rows must not become a false default for a foreign workspace.
    tx.query<{workspace_id:string;environment_id:string;version:number;autonomy_level:number;policy_params:Record<string,unknown>}>(
      "select workspace_id,environment_id,version,autonomy_level,policy_params from platform.environment_settings where environment_id=$1",[environmentId]),
  ]);
  const policy=policies[0],environment=environments[0];
  if(policies.length>1 || environments.length>1
    || policy && (policy.workspace_id!==workspaceId || !Number.isInteger(policy.version) || policy.version<1)
    || environment && (environment.workspace_id!==workspaceId || environment.environment_id!==environmentId
      || !Number.isInteger(environment.version) || environment.version<1 || !Number.isInteger(environment.autonomy_level)
      || environment.autonomy_level<0 || environment.autonomy_level>5)) return refuse();
  return freezeSnapshot(structuredClone({workspaceId,environmentId,
    policy:{present:!!policy,version:policy?.version??0,params:policy?.params??{}},
    environment:{present:!!environment,version:environment?.version??0,
      autonomyLevel:(environment?.autonomy_level??1) as AutonomyLevel,policyParams:environment?.policy_params??{}},
  }));
}
function beforeDeadline<T>(signal:AbortSignal,pending:Promise<T>):Promise<T> {
  return new Promise<T>((resolve,reject)=>{
    const abort=()=>{signal.removeEventListener("abort",abort);reject(new WorkflowStartIntentError());};
    signal.addEventListener("abort",abort,{once:true});
    if(signal.aborted){abort();void pending.catch(()=>undefined);return;}
    void pending.then(value=>{
      signal.removeEventListener("abort",abort);
      if(signal.aborted)reject(new WorkflowStartIntentError());else resolve(value);
    },()=>{signal.removeEventListener("abort",abort);reject(new WorkflowStartIntentError());});
  });
}
async function approval(tx:Sql,op:Operation,isolatedDependencies?:AuthorityDependencies):Promise<{proof:DispatchApprovalSnapshot;settings:SettingsSnapshot}> {
  const { createExecutionBroker } = await import("@/lib/platform/broker");
  if(!isolatedDependencies && isMemoryStoreEnabled()) return refuse();
  const signal=AbortSignal.timeout(AUTHORITY_DEADLINE_MS);
  const dependencies=isolatedDependencies ?? await canonicalDependencies(tx,signal);
  if(signal.aborted)return refuse();
  // Called only after all lease/operation/intent locks. One detached snapshot
  // feeds both evaluation and final CAS; no refresh to a changed policy state.
  const settings=await beforeDeadline(signal,captureSettings(tx,op));
  const store=new PlatformBrokerStore(tx);
  store.getWorkspacePolicy=async workspaceId=>{
    if(workspaceId!==settings.workspaceId)return refuse();
    return {workspaceId,params:settings.policy.params,version:settings.policy.version,isDefault:!settings.policy.present};
  };
  store.getEnvironmentSettings=async (workspaceId,environmentId)=>{
    if(workspaceId!==settings.workspaceId || environmentId!==settings.environmentId)return refuse();
    return {workspaceId,environmentId,autonomyLevel:settings.environment.autonomyLevel,
      version:settings.environment.version,isDefault:!settings.environment.present};
  };
  const bound=createBroker({...dependencies,store});
  const status=await beforeDeadline(signal,createExecutionBroker(tx,async()=>bound).approvalStatus(op.id));
  const proof = status.dispatchApproval;
  if (!status.approved || status.rejected || !proof || proof.proposalDigest !== op.proposal_digest
    || (proof.planDigest ?? null) !== op.plan_digest || proof.approvalRound !== op.approval_round
    || !Number.isSafeInteger(proof.requiredApprovalCount) || proof.requiredApprovalCount < 0 || proof.requiredApprovalCount > 100
    || !Array.isArray(proof.approvalIds) || proof.approvalIds.length > 100 || new Set(proof.approvalIds).size !== proof.approvalIds.length) return refuse();
  return Object.freeze({proof:Object.freeze({...proof,approvalIds:Object.freeze(proof.approvalIds.map(id))}),settings});
}
// Evaluated at the final DB clock after ALL blocking locks and fresh canonical role/policy evaluation.
const LIVE_AUTHORITY = `o.workspace_id=$1 and o.id=$2 and o.expires_at>clock_timestamp()
  and o.proposal_digest=$3 and o.input_digest=$4 and o.approval_round=$5 and o.plan_digest is not distinct from $6::text
  and (o.workflow_id is null or o.workflow_id=$7)
  and (( $8::boolean and o.status in ('approved','queued') and o.lease_scope is null and o.fence_token is null )
    or (not $8::boolean and o.status='running' and o.lease_holder is not null and o.lease_until>clock_timestamp()))
  and ((o.lease_scope is null and o.fence_token is null) or exists (
    select 1 from platform.leases l where l.scope=o.lease_scope and l.workspace_id=o.workspace_id
      and l.fence_token=o.fence_token and l.released_at is null and l.expires_at>clock_timestamp()))
  and not exists (select 1 from platform.approvals a where a.workspace_id=o.workspace_id and a.operation_id=o.id
    and a.approval_round=o.approval_round and a.proposal_digest=o.proposal_digest and a.decision='reject' and a.expires_at>clock_timestamp())
  and (select count(distinct a.approver_id) from platform.approvals a where a.workspace_id=o.workspace_id and a.operation_id=o.id
    and a.id=any($9::text[]) and a.approval_round=o.approval_round and a.proposal_digest=o.proposal_digest
    and a.approver->>'kind'='user' and a.decision='approve' and a.expires_at>clock_timestamp()
    and (($8::boolean and a.consumed_at is null) or (not $8::boolean and a.consumed_at is not null))) >= $10::integer
  and (not o.approval_required or $10::integer > 0)
  and $11::text::jsonb->>'workspaceId'=o.workspace_id and $11::text::jsonb->>'environmentId'=o.environment_id
  and (case when ($11::text::jsonb->'policy'->>'present')::boolean then exists (
    select 1 from platform.workspace_policy p where p.workspace_id=o.workspace_id
      and p.version=($11::text::jsonb->'policy'->>'version')::integer and p.params=$11::text::jsonb->'policy'->'params')
    else not exists (select 1 from platform.workspace_policy p where p.workspace_id=o.workspace_id) end)
  and (case when ($11::text::jsonb->'environment'->>'present')::boolean then exists (
    select 1 from platform.environment_settings s where s.workspace_id=o.workspace_id and s.environment_id=o.environment_id
      and s.version=($11::text::jsonb->'environment'->>'version')::integer
      and s.autonomy_level=($11::text::jsonb->'environment'->>'autonomyLevel')::integer
      and s.policy_params=$11::text::jsonb->'environment'->'policyParams')
    else not exists (select 1 from platform.environment_settings s where s.environment_id=o.environment_id) end)`;
function authorityParams(binding:StartBinding,op:Operation,proof:DispatchApprovalSnapshot,settings:SettingsSnapshot):unknown[] {
  return [op.workspace_id,op.id,binding.proposalDigest,binding.inputDigest,proof.approvalRound,proof.planDigest ?? null,
    binding.workflowId,binding.kind === "teardownReview",textArray(proof.approvalIds),proof.requiredApprovalCount,JSON.stringify(settings)];
}
async function productTopology(sql: Sql, request: StartRequest, isolatedDependencies?: AuthorityDependencies): Promise<boolean> {
  if (request.kind !== "deploy") return false;
  const rows = await sql.query<Operation>("select * from platform.operations where workspace_id=$1 and id=$2", [request.arguments.workspaceId, request.arguments.operationId]);
  if (!rows[0] || !requiresMcpDeployAuthority(request.kind, rows[0])) return false;
  // The recognized isolated store still uses real native product/source SQL.
  // Only its existing test-only broker composition omits the hosted endpoint check.
  if (!isolatedDependencies) {
    try { await assertDefaultMcpProductTopology(sql); } catch { return refuse(); }
  }
  return true;
}
async function currentMcpAuthority(tx: Sql, op: Operation) {
  try { return await captureMcpDeployAuthority(tx, op); } catch { return refuse(); }
}
/**
 * An incident remediation may start only against a repair attempt that
 * `reserveRemediation` admitted (PROD-OBS-03) and that is bound to this exact
 * operation. No reservation, a blocked one, or one for another incident refuses.
 */
async function requireRemediationAdmission(tx: Sql, request: StartRequest, op: Operation): Promise<void> {
  if (request.kind !== "remediation") return;
  const rows = await tx.query(
    "select 1 from platform.incident_remediation_attempts where workspace_id=$1 and incident_id=$2 and operation_id=$3 and status in ('reserved','succeeded') limit 1",
    [op.workspace_id, request.arguments.incidentId as string, op.id]);
  if (!rows.length) return refuse();
}
async function preparePrivate(sql:Sql,input:StartRequest,isolatedDependencies?:AuthorityDependencies):Promise<WorkflowStartIntent> {
  const request = requestCopy(input);
  // Evidence recovery of an existing intent needs no new authority, even if the operation is now terminal.
  const prior = await get(sql,request.arguments.workspaceId as string,request.arguments.operationId as string);
  if (prior) { matches(prior,request); if (prior.phase !== "prepared") return prior; }
  const owningProduct = await productTopology(sql, request, isolatedDependencies);
  return sql.tx(async tx=>{
    const op = await lockedOperation(tx,request);
    const rows = await tx.query<WorkflowStartIntent>("select * from platform.workflow_start_intents where workspace_id=$1 and operation_id=$2 for update",[op.workspace_id,op.id]);
    const retained = rows[0] ? fromRow(rows[0]) : undefined;
    if (retained) { matches(retained,request); if (retained.phase !== "prepared" || !requiresMcpDeployAuthority(request.kind,op)) return retained; }
    const binding=bind(request,op);
    await requireRemediationAdmission(tx,request,op);
    if (retained && digest(binding) !== retained.binding_digest) return refuse();
    const sourceRequired = requiresMcpDeployAuthority(request.kind, op);
    if (sourceRequired && !owningProduct) return refuse();
    const source = sourceRequired ? await currentMcpAuthority(tx, op) : undefined;
    const {proof,settings}=await approval(tx,op,isolatedDependencies);
    if (sourceRequired && !isolatedDependencies) {
      try { await assertFinalMcpProductTopology(sql, tx); } catch { return refuse(); }
    }
    const params = [...authorityParams(binding,op,proof,settings), ...(source ? [JSON.stringify(source)] : [])];
    const currentAuthority = `${LIVE_AUTHORITY}${source ? ` and ${MCP_DEPLOY_AUTHORITY}` : ""}`;
    if (retained) {
      if (!(await tx.query(`select o.id from platform.operations o where ${currentAuthority}`, params)).length) return refuse();
      return retained;
    }
    const bindingParam = source ? 13 : 12;
    const inserted=await tx.query<WorkflowStartIntent>(`insert into platform.workflow_start_intents (workspace_id,operation_id,binding,binding_digest)
      select o.workspace_id,o.id,$${bindingParam}::text::jsonb,$${bindingParam + 1} from platform.operations o where ${currentAuthority} returning *`,
      [...params,JSON.stringify(binding),digest(binding)]);
    if (!inserted[0]) return refuse();
    return fromRow(inserted[0]);
  });
}
/** Creates only a prepared intent; never consumes/reopens an operation or sends transport. */
export function prepare(sql: Sql, request: StartRequest): Promise<WorkflowStartIntent> {
  if((sql as Sql & {kind?:string}).kind !== "postgres" || isMemoryStoreEnabled()) return refuse();
  return preparePrivate(sql,request);
}
async function claimPrivate(sql:Sql,input:StartRequest,isolatedDependencies?:AuthorityDependencies):Promise<{intent:WorkflowStartIntent;dispatch:boolean}> {
  const request=requestCopy(input);
  // Retained attempted/acknowledged starts recover evidence even after product drift.
  // They never need fresh source authority and cannot authorize another transport write.
  const prior = await get(sql, request.arguments.workspaceId as string, request.arguments.operationId as string);
  if (prior && prior.phase !== "prepared") { matches(prior,request); return { intent: prior, dispatch: false }; }
  const owningProduct = await productTopology(sql, request, isolatedDependencies);
  return sql.tx(async tx=>{
    const op=await lockedOperation(tx,request);
    const rows=await tx.query<WorkflowStartIntent>("select * from platform.workflow_start_intents where workspace_id=$1 and operation_id=$2 for update",[op.workspace_id,op.id]);
    if (!rows[0]) return refuse();
    const retained=fromRow(rows[0]); matches(retained,request);
    if (retained.phase !== "prepared") return {intent:retained,dispatch:false};
    const binding=bind(request,op);
    await requireRemediationAdmission(tx,request,op);
    if (digest(binding) !== retained.binding_digest) return refuse();
    const sourceRequired = requiresMcpDeployAuthority(request.kind, op);
    if (sourceRequired && !owningProduct) return refuse();
    const source = sourceRequired ? await currentMcpAuthority(tx, op) : undefined;
    // No caller proof/callback: resolve the actual broker after the last lock wait.
    const {proof,settings}=await approval(tx,op,isolatedDependencies);
    if (sourceRequired && !isolatedDependencies) {
      try { await assertFinalMcpProductTopology(sql, tx); } catch { return refuse(); }
    }
    const attemptParam = source ? 13 : 12;
    const claimed=await tx.query<WorkflowStartIntent>(`update platform.workflow_start_intents i set phase='attempted',attempt_id=$${attemptParam},attempted_at=clock_timestamp()
      from platform.operations o where i.workspace_id=$1 and i.operation_id=$2 and i.phase='prepared' and ${LIVE_AUTHORITY}${source ? ` and ${MCP_DEPLOY_AUTHORITY}` : ""} returning i.*`,
      [...authorityParams(binding,op,proof,settings), ...(source ? [JSON.stringify(source)] : []), randomUUID()]);
    if (!claimed[0]) return refuse();
    return {intent:fromRow(claimed[0]),dispatch:true};
  });
}
/** The sole permanent attempt CAS. Its expiry never enables another writer. */
export function claim(sql: Sql, request: StartRequest): Promise<{intent:WorkflowStartIntent;dispatch:boolean}> {
  if((sql as Sql & {kind?:string}).kind !== "postgres" || isMemoryStoreEnabled()) return refuse();
  return claimPrivate(sql,request);
}
export interface StartReadback { readonly runId: string; readonly startedAt: string; readonly evidenceDigest: string }
/** Internal evidence sink. Application surfaces must call the actual Temporal reader, not expose this as a public receipt endpoint. */
export async function acknowledge(sql: Sql, intent: WorkflowStartIntent, observed: StartReadback): Promise<WorkflowStartIntent> {
  if (!UUID.test(observed.runId) || !HEX.test(observed.evidenceDigest) || !Number.isFinite(Date.parse(observed.startedAt)) || !intent.attempt_id) return refuse();
  return sql.tx(async tx=>{
    const rows=await tx.query<WorkflowStartIntent>("select * from platform.workflow_start_intents where workspace_id=$1 and operation_id=$2 for update",[intent.workspace_id,intent.operation_id]);
    if (!rows[0]) return refuse();
    const retained=fromRow(rows[0]);
    if (retained.binding_digest !== intent.binding_digest || retained.attempt_id !== intent.attempt_id || retained.phase === "prepared") return refuse();
    if (retained.phase === "acknowledged") {
      if (retained.run_id !== observed.runId || retained.evidence_digest !== observed.evidenceDigest
        || Date.parse(retained.observed_start_at!) !== Date.parse(observed.startedAt)) return refuse();
      return retained;
    }
    const updated=await tx.query<WorkflowStartIntent>(`update platform.workflow_start_intents set phase='acknowledged',run_id=$3,
      observed_start_at=$4::timestamptz,evidence_digest=$5,acknowledged_at=clock_timestamp() where workspace_id=$1 and operation_id=$2 and phase='attempted' returning *`,
      [intent.workspace_id,intent.operation_id,observed.runId,observed.startedAt,observed.evidenceDigest]);
    if (!updated[0]) return refuse();
    return fromRow(updated[0]);
  });
}
/** Actual broker only, captured once. Never export this helper through bindRepos. */
export function createIsolatedStartIntentStoreForTests(broker: Broker) {
  const guard=()=>{ if(process.env.NODE_ENV !== "test") return refuse(); };
  guard();
  const dependencies=captureDependencies(broker);
  return Object.freeze({
    prepare: (sql:Sql,input:StartRequest)=>{ guard();return preparePrivate(sql,input,dependencies); },
    claim: (sql:Sql,input:StartRequest)=>{ guard();return claimPrivate(sql,input,dependencies); },
  });
}
