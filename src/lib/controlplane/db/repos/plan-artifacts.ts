/** Database-only transactions. Lock order is live environment fence, operation, artifact, ordered source resources, use. */
import { TERMINAL_OPERATION_STATUSES, type Sql } from "@/lib/controlplane/types";
import type { PlanArtifactManifest, PlanCustodyInput, SealedStandaloneSettlement } from "@/lib/tofu/engine";
import type { Sealed } from "@/lib/secrets";
import type { DispatchApprovalSnapshot } from "@/lib/execution/ports";
import type { LeaseRef } from "@/lib/workflows/types";
import { executionHolder } from "@/lib/execution/platform";
import { digest } from "@/lib/controlplane/digest";
import { assertFence } from "./leases";
import { get } from "./operations";
import { setPlanDigest } from "@/lib/controlplane/operations/execution";
import * as evidence from "./evidence";
import { projectPlanReview } from "./operation-review";
import type { ApprovedSourceSnapshot } from "@/lib/execution/source-snapshot";
import { textArray } from "../sql";
import { ControlStoreError, requireText } from "../errors";
import { retainPublishedPlanProductAuthority, retainClaimedPlanProductAuthority, captureClaimedPlanProductAuthority,
  claimedPlanRequiresProductComposition, withCurrentPlanDispatchRequirement, planProductDispatchPredicate, type PlanProductDispatchAuthority } from "./plan-artifact-product-authority";
import { assertFinalMcpProductTopology } from "./workflow-start-deploy-authority";
import { randomUUID } from "node:crypto";
import * as cleanup from "./cleanup-writer-barriers";
import * as grants from "./grants";
import { readNativeCleanupOrigin, assertNativeCleanupOriginCurrent, readNativeStandaloneOrigin, assertNativeStandaloneOriginCurrent, type NativeCleanupOrigin } from "@/lib/platform/plan-artifacts";

export class PlanArtifactError extends Error {
  readonly code = "plan_artifact_unavailable";
  constructor() { super("Reviewed plan artifact is unavailable or changed; a new review is required."); }
}
export interface ArtifactAccess { custody: PlanCustodyInput; planDigest: string; lease: LeaseRef }
export interface ArtifactRow {
  workspace_id: string; operation_id: string; manifest: PlanArtifactManifest; manifest_digest: string; plan_digest: string;
  iv: string; auth_tag: string; ciphertext: string; expires_at: string;
}
export interface PublishArtifact { manifest: Readonly<PlanArtifactManifest>; sealed: Sealed; lease: LeaseRef; evidence: evidence.InsertEvidenceInput }
export interface StandaloneSettlementRow { readonly receipt:SealedStandaloneSettlement; readonly artifact:ArtifactRow }
/** Bounded candidate read only. A native row is never evidence of terminal provider execution. */
export async function readStandaloneSettlements(sql:Sql,custody:PlanCustodyInput,backendDigest:string):Promise<readonly StandaloneSettlementRow[]> {
  const rows=await sql.query<{receipt:SealedStandaloneSettlement;artifact:ArtifactRow|null}>(`select
    jsonb_build_object('binding',jsonb_build_object('workspaceId',r.workspace_id,'projectId',r.project_id,'environmentId',r.environment_id,
      'operationId',r.operation_id,'attemptId',r.attempt_id,'manifestDigest',r.manifest_digest,'rawSha256',r.raw_sha256,
      'backendDigest',r.backend_digest,'targetDigest',r.target_digest,'holder',r.holder,'fenceToken',r.fence_token),
      'settlementDigest',r.settlement_digest,'sealed',jsonb_build_object('iv',r.iv,'authTag',r.auth_tag,'ciphertext',r.ciphertext)) as receipt,
    case when count(*) over()<=64 and sum(octet_length(a.ciphertext)) over()<=67108864 then to_jsonb(a) else null end as artifact
    from platform.standalone_plan_settlements r
    left join platform.plan_artifact_associations association on association.workspace_id=r.workspace_id and association.operation_id=r.operation_id
    left join platform.plan_artifacts a on a.workspace_id=r.workspace_id and a.operation_id=coalesce(association.source_operation_id,r.operation_id)
    where r.workspace_id=$1 and r.project_id=$2 and r.environment_id=$3 and r.backend_digest=$4
    order by r.operation_id collate "C",r.attempt_id collate "C" limit 65`,[custody.workspaceId,custody.projectId,custody.environmentId,backendDigest]);
  if(rows.length>64)return Object.freeze([]);
  const bounded:StandaloneSettlementRow[]=[];
  for(const row of rows) { if(!row.artifact)return Object.freeze([]); bounded.push(Object.freeze({receipt:row.receipt,artifact:row.artifact})); }
  return Object.freeze(bounded);
}
// Only exact privately authenticated rows may remain selected after an inventory wait.
// The proof JSON is assembled by the repository from a genuine callback origin, never caller extras.
const LIVE_STANDALONE_SETTLEMENTS=`not exists(select 1 from jsonb_array_elements(coalesce($6::text::jsonb->'standaloneSettlements','[]'::jsonb)) settled
  where not exists(select 1 from platform.standalone_plan_settlements r
    join platform.standalone_plan_backends backend on backend.target_digest=r.target_digest
    join platform.plan_artifact_uses terminal on terminal.workspace_id=r.workspace_id and terminal.operation_id=r.operation_id
    left join platform.plan_artifact_associations association on association.workspace_id=r.workspace_id and association.operation_id=r.operation_id
    join platform.plan_artifacts artifact on artifact.workspace_id=r.workspace_id and artifact.operation_id=coalesce(association.source_operation_id,r.operation_id)
    where r.workspace_id=$1 and r.workspace_id=settled->'receipt'->'binding'->>'workspaceId'
      and r.project_id=settled->'receipt'->'binding'->>'projectId' and r.environment_id=settled->'receipt'->'binding'->>'environmentId'
      and r.operation_id=settled->'receipt'->'binding'->>'operationId' and r.attempt_id=settled->'receipt'->'binding'->>'attemptId'
      and r.manifest_digest=settled->'receipt'->'binding'->>'manifestDigest' and r.raw_sha256=settled->'receipt'->'binding'->>'rawSha256'
      and r.backend_digest=settled->'receipt'->'binding'->>'backendDigest' and r.target_digest=settled->'receipt'->'binding'->>'targetDigest'
      and r.holder=settled->'receipt'->'binding'->>'holder' and r.fence_token=(settled->'receipt'->'binding'->>'fenceToken')::bigint
      and r.settlement_digest=settled->'receipt'->>'settlementDigest' and r.iv=settled->'receipt'->'sealed'->>'iv'
      and r.auth_tag=settled->'receipt'->'sealed'->>'authTag' and r.ciphertext=settled->'receipt'->'sealed'->>'ciphertext'
      and backend.workspace_id=r.workspace_id and backend.project_id=r.project_id and backend.environment_id=r.environment_id and backend.backend_digest=r.backend_digest
      and terminal.phase='succeeded' and terminal.attempt_id=r.attempt_id and terminal.holder=r.holder and terminal.fence_token=r.fence_token
      and artifact.manifest_digest=r.manifest_digest and artifact.manifest->>'rawSha256'=r.raw_sha256 and to_jsonb(artifact)=settled->'artifact'))`;
function refuse(): never { throw new PlanArtifactError(); }
const CUSTODY_KEYS = ["workspaceId","projectId","environmentId","operationId","proposalDigest","inputDigest","expiresAt","sourceDigest","graphDigest"] as const;
/** One canonical authority tuple; repository lease rows may carry non-authorizing timestamps. */
export function captureArtifactAccess(input: ArtifactAccess): ArtifactAccess {
  return Object.freeze({ custody: Object.freeze({workspaceId:input.custody.workspaceId,projectId:input.custody.projectId,environmentId:input.custody.environmentId,operationId:input.custody.operationId,proposalDigest:input.custody.proposalDigest,inputDigest:input.custody.inputDigest,expiresAt:input.custody.expiresAt,sourceDigest:input.custody.sourceDigest,graphDigest:input.custody.graphDigest}), planDigest: input.planDigest,
    lease: Object.freeze({ scope:input.lease.scope,holder:input.lease.holder,fenceToken:input.lease.fenceToken }) });
}
async function lockOwner(tx: Sql, input: ArtifactAccess, requireDigest: boolean): Promise<void> {
  const { custody: c, lease } = input;
  if (lease.scope !== `env:${c.environmentId}` || !/^[a-f0-9]{64}$/.test(input.planDigest)) refuse();
  await assertFence(tx, lease.scope, lease.fenceToken);
  const ownedLease = await tx.query("select scope from platform.leases where scope=$1 and workspace_id=$2 and holder=$3", [lease.scope, c.workspaceId, lease.holder]);
  if (!ownedLease.length) refuse();
  const rows = await tx.query<{ live: boolean; claimed: boolean; holder: string | null; lease_scope: string | null; fence_token: number | null }>(`select expires_at > clock_timestamp() as live,
    status='running' and lease_until > clock_timestamp() as claimed, lease_holder as holder, lease_scope, fence_token from platform.operations where workspace_id=$1 and id=$2 for update`, [c.workspaceId, c.operationId]);
  if (!rows[0]?.live || !rows[0].claimed || rows[0].holder !== executionHolder(c.operationId)) refuse();
  const owner=rows[0];
  if ((owner.lease_scope === null) !== (owner.fence_token === null)) refuse();
  if (owner.lease_scope !== null && (owner.lease_scope !== lease.scope || owner.fence_token !== lease.fenceToken)) refuse();
  if (owner.lease_scope === null) {
    // The workflow claims before acquiring its env lease. Bind this live claim once; never replace a recorded fence.
    const bound = await tx.query<{lease_scope:string;fence_token:number}>(`update platform.operations set lease_scope=$3,fence_token=$4 where workspace_id=$1 and id=$2
      and status='running' and lease_scope is null and fence_token is null and lease_until > clock_timestamp() and lease_holder=$5 returning lease_scope,fence_token`,
      [c.workspaceId,c.operationId,lease.scope,lease.fenceToken,executionHolder(c.operationId)]);
    if (bound[0]?.lease_scope !== lease.scope || bound[0]?.fence_token !== lease.fenceToken) refuse();
  }
  const stillLive = await tx.query(`select id from platform.operations where workspace_id=$1 and id=$2 and status='running'
    and expires_at > clock_timestamp() and lease_until > clock_timestamp() and lease_holder=$3 and lease_scope=$4 and fence_token=$5`,
    [c.workspaceId,c.operationId,executionHolder(c.operationId),lease.scope,lease.fenceToken]);
  if (!stillLive.length) refuse();
  const op = await get(tx, c.workspaceId, c.operationId);
  if (!op || op.projectId !== c.projectId || op.environmentId !== c.environmentId || op.proposalDigest !== c.proposalDigest || op.inputDigest !== c.inputDigest
    || op.expiresAt !== c.expiresAt || op.status !== "running"
    || op.planDigest && op.planDigest !== input.planDigest || requireDigest && op.planDigest !== input.planDigest) refuse();
}
export async function publish(sql: Sql, input: PublishArtifact): Promise<ArtifactRow> {
  input = { manifest: Object.freeze(JSON.parse(JSON.stringify(input.manifest)) as PlanArtifactManifest), sealed: Object.freeze({...input.sealed}),
    lease: Object.freeze({...input.lease}), evidence: JSON.parse(JSON.stringify(input.evidence)) as evidence.InsertEvidenceInput };
  const m = input.manifest;
  return sql.tx(async (tx) => {
    await lockOwner(tx, { custody: m, planDigest: m.planDigest, lease: input.lease }, false);
    const existing = await tx.query<ArtifactRow>("select * from platform.plan_artifacts where workspace_id=$1 and operation_id=$2 for update", [m.workspaceId,m.operationId]);
    if (existing.length) {
      // Re-plans can have different binary bytes with identical approved meaning. The first immutable binary wins.
      const comparable = (manifest: Readonly<PlanArtifactManifest>) => { const { rawSha256: _raw, bytes: _bytes, ...bound } = manifest; return bound; };
      if (digest(comparable(existing[0].manifest)) !== digest(comparable(m))) refuse();
      return existing[0];
    }
    const written = await setPlanDigest(tx, { workspaceId:m.workspaceId,id:m.operationId,planDigest:m.planDigest });
    if (!written && (await get(tx,m.workspaceId,m.operationId))?.planDigest !== m.planDigest) refuse();
    if (input.evidence.workspaceId !== m.workspaceId || input.evidence.operationId !== m.operationId || input.evidence.digest !== m.planDigest
      || input.evidence.simulated || input.evidence.kind !== "tofu_plan" || input.evidence.summary.planDigest !== m.planDigest) refuse();
    await evidence.insert(tx, input.evidence);
    const rows = await tx.query<ArtifactRow>(`insert into platform.plan_artifacts
      (workspace_id,operation_id,manifest,manifest_digest,plan_digest,iv,auth_tag,ciphertext,expires_at)
      values ($1,$2,$3::text::jsonb,$4,$5,$6,$7,$8,$9::timestamptz) returning *`,
      [m.workspaceId,m.operationId,JSON.stringify(m),digest(m),m.planDigest,input.sealed.iv,input.sealed.authTag,input.sealed.ciphertext,m.expiresAt]);
    await tx.query("insert into platform.plan_artifact_uses (workspace_id,operation_id) values ($1,$2)", [m.workspaceId,m.operationId]);
    try { await retainPublishedPlanProductAuthority(tx, rows[0]); } catch { refuse(); }
    return rows[0];
  });
}
interface AssociationRow {
  workspace_id:string; operation_id:string; source_operation_id:string; source_evidence_id:string;
  source_manifest_digest:string; source_raw_sha256:string; proposal_digest:string; input_digest:string; expires_at:string;
}
export interface AssociateArtifact { workspaceId:string; sourceOperationId:string; destinationOperationId:string; sourceEvidenceId:string; planDigest:string; lease:LeaseRef }
async function lockOperations(tx:Sql, workspaceId:string, ids:readonly string[]) {
  for (const id of [...new Set(ids)].sort()) await tx.query("select id from platform.operations where workspace_id=$1 and id=$2 for update",[workspaceId,id]);
}
/** Source remains authoritative. Association never imports, copies or re-seals its bytes. */
export async function associate(sql:Sql,input:AssociateArtifact):Promise<ArtifactRow> {
  input=Object.freeze({...input,lease:Object.freeze({...input.lease})});
  return sql.tx(async tx => {
    await assertFence(tx,input.lease.scope,input.lease.fenceToken);
    await lockOperations(tx,input.workspaceId,[input.sourceOperationId,input.destinationOperationId]);
    const source=await get(tx,input.workspaceId,input.sourceOperationId);
    const destination=await get(tx,input.workspaceId,input.destinationOperationId);
    const intent=source?.proposal.input as {environmentId?:string;teardownReview?:boolean}|undefined;
    const ref=(destination?.proposal as {broker?:{destroyPlan?:{operationId?:string;evidenceId?:string}}}|undefined)?.broker?.destroyPlan;
    if (!source || !destination || source.id===destination.id || source.capability!=="infrastructure.plan" || !intent?.teardownReview
      || intent.environmentId!==source.environmentId || destination.capability!=="infrastructure.destroy" || destination.status!=="awaiting_approval"
      || destination.workspaceId!==source.workspaceId || destination.projectId!==source.projectId || destination.environmentId!==source.environmentId
      || ref?.operationId!==source.id || ref.evidenceId!==input.sourceEvidenceId || destination.planDigest!==input.planDigest || source.planDigest!==input.planDigest) refuse();
    const decisions=await tx.query(`select id from platform.approvals where workspace_id=$1 and operation_id=$2 and approval_round=(select approval_round from platform.operations where workspace_id=$1 and id=$2)`,[input.workspaceId,destination.id]);
    if (decisions.length) refuse();
    const rows=await tx.query<ArtifactRow>("select * from platform.plan_artifacts where workspace_id=$1 and operation_id=$2 and expires_at > clock_timestamp() for update",[input.workspaceId,source.id]);
    const row=rows[0];
    if (!row || row.manifest_digest!==digest(row.manifest) || row.manifest.purpose!=="destroy") refuse();
    await lockOwner(tx,{custody:row.manifest,planDigest:input.planDigest,lease:input.lease},true);
    const sourceEvidence=await tx.query("select id from platform.evidence where workspace_id=$1 and operation_id=$2 and id=$3 and digest=$4 and kind='tofu_plan' and simulated=false",[input.workspaceId,source.id,input.sourceEvidenceId,input.planDigest]);
    if (!sourceEvidence.length || Date.parse(destination.expiresAt)<=Date.now()) refuse();
    const association={workspace_id:input.workspaceId,operation_id:destination.id,source_operation_id:source.id,source_evidence_id:input.sourceEvidenceId,
      source_manifest_digest:row.manifest_digest,source_raw_sha256:row.manifest.rawSha256,proposal_digest:destination.proposalDigest,input_digest:destination.inputDigest,
      expires_at:new Date(Math.min(Date.parse(destination.expiresAt),Date.parse(row.expires_at))).toISOString()};
    const existing=await tx.query<AssociationRow>("select * from platform.plan_artifact_associations where workspace_id=$1 and operation_id=$2 for update",[input.workspaceId,destination.id]);
    if (existing.length) {
      if (Object.entries(association).some(([key,value])=>existing[0][key as keyof AssociationRow]!==value)) refuse();
      return row;
    }
    if ((await tx.query("select operation_id from platform.plan_artifacts where workspace_id=$1 and operation_id=$2",[input.workspaceId,destination.id])).length) refuse();
    await tx.query(`insert into platform.plan_artifact_associations (workspace_id,operation_id,source_operation_id,source_evidence_id,source_manifest_digest,source_raw_sha256,proposal_digest,input_digest,expires_at)
      select $1,$2,$3,$4,$5,$6,$7,$8,$9::timestamptz where exists (select 1 from platform.operations where workspace_id=$1 and id=$2 and status='awaiting_approval' and expires_at > clock_timestamp()) returning operation_id`,Object.values(association)).then(rows=>{if (!rows.length) refuse();});
    await tx.query("insert into platform.plan_artifact_uses (workspace_id,operation_id) values ($1,$2)",[input.workspaceId,destination.id]);
    return row;
  });
}
export async function read(sql: Sql, input: ArtifactAccess): Promise<ArtifactRow> {
  input = captureArtifactAccess(input);
  return sql.tx(async (tx) => {
    const associations=await tx.query<AssociationRow>("select * from platform.plan_artifact_associations where workspace_id=$1 and operation_id=$2",[input.custody.workspaceId,input.custody.operationId]);
    const association=associations[0];
    await assertFence(tx,input.lease.scope,input.lease.fenceToken);
    await lockOperations(tx,input.custody.workspaceId,[input.custody.operationId,...(association?[association.source_operation_id]:[])]);
    await lockOwner(tx,input,true);
    const sourceId=association?.source_operation_id ?? input.custody.operationId;
    const rows = await tx.query<ArtifactRow>(`select a.* from platform.plan_artifacts a where workspace_id=$1 and operation_id=$2
      and plan_digest=$3 and expires_at > clock_timestamp() for update`, [input.custody.workspaceId,sourceId,input.planDigest]);
    const row = rows[0];
    if (!row || row.manifest_digest !== digest(row.manifest)) refuse();
    if (association) {
      const source=await get(tx,input.custody.workspaceId,sourceId);
      const destination=await get(tx,input.custody.workspaceId,input.custody.operationId);
      const result=source?.result as {operationId?:string;planDigest?:string}|undefined;
      const ref=(destination?.proposal as {broker?:{destroyPlan?:{operationId?:string;evidenceId?:string}}}|undefined)?.broker?.destroyPlan;
      const live=await tx.query("select operation_id from platform.plan_artifact_associations where workspace_id=$1 and operation_id=$2 and expires_at > clock_timestamp() for update",[input.custody.workspaceId,input.custody.operationId]);
      if (!live.length || !source || source.status!=="succeeded" || result?.operationId!==input.custody.operationId || result.planDigest!==input.planDigest
        || source.planDigest!==input.planDigest || source.proposalDigest!==row.manifest.proposalDigest || source.inputDigest!==row.manifest.inputDigest
        || source.expiresAt!==row.manifest.expiresAt || ref?.operationId!==sourceId || ref.evidenceId!==association.source_evidence_id
        || row.manifest_digest!==association.source_manifest_digest || row.manifest.rawSha256!==association.source_raw_sha256 || row.manifest.purpose!=="destroy"
        || input.custody.proposalDigest!==association.proposal_digest || input.custody.inputDigest!==association.input_digest) refuse();
    }
    const originalCustody=association?{...input.custody,operationId:row.manifest.operationId,proposalDigest:row.manifest.proposalDigest,inputDigest:row.manifest.inputDigest,expiresAt:row.manifest.expiresAt}:input.custody;
    if (CUSTODY_KEYS.some(key=>row.manifest[key]!==originalCustody[key])) refuse();
    return row;
  });
}
// Checked at the CAS itself: row locks serialize mutations, not passage of time.
const LIVE_USE_AUTHORITY = `exists (select 1 from platform.operations o join platform.leases l on l.scope=o.lease_scope
  where o.workspace_id=$1 and o.id=$2 and o.status='running' and o.expires_at > clock_timestamp() and o.lease_until > clock_timestamp()
  and o.lease_holder='workflow:' || o.id and o.lease_scope='env:' || o.environment_id and o.fence_token=$5
  and (not o.approval_required or exists (select 1 from platform.approvals approved
    where approved.workspace_id=o.workspace_id and approved.operation_id=o.id and approved.approval_round=o.approval_round
      and approved.proposal_digest=o.proposal_digest and approved.decision='approve' and approved.approver->>'kind'='user'
      and approved.consumed_at is not null and approved.expires_at > clock_timestamp())) and l.workspace_id=$1 and l.holder=$4 and l.fence_token=$5 and l.expires_at > clock_timestamp())
  and (exists (select 1 from platform.plan_artifacts a where a.workspace_id=$1 and a.operation_id=$2 and a.expires_at > clock_timestamp())
  or exists (select 1 from platform.plan_artifact_associations s join platform.plan_artifacts a on a.workspace_id=s.workspace_id and a.operation_id=s.source_operation_id
    where s.workspace_id=$1 and s.operation_id=$2 and s.expires_at > clock_timestamp() and a.expires_at > clock_timestamp()))`;

interface SourceDispatchAuthority {
  operationId: string; projectId: string; environmentId: string; manifestDigest: string; planDigest: string;
  sources: readonly ApprovedSourceSnapshot[];
  recipes: readonly { snapshot: ApprovedSourceSnapshot; snapshotDigest: string; serviceSpec: Record<string, unknown>; pipelineSpec: Record<string, unknown> }[];
  setDigest: string | null;
  evidence: { id: string; summary: Record<string, unknown> } | null;
}
const SOURCE_VIEW_FIELDS = ["executableSourceDigest", "approvedSources", "approvedSourcesTruncated", "approvedSourcesOmitted"] as const;
function sourceFields(summary: Record<string, unknown>): boolean {
  return Object.hasOwn(summary, "executableSourceDigest") || !!summary.view && typeof summary.view === "object"
    && SOURCE_VIEW_FIELDS.some(key => Object.hasOwn(summary.view as object, key));
}
/** Derived from the original owning rows after current roles, never from an apply caller or a proof callback. */
async function captureSourceDispatch(tx: Sql, row: ArtifactRow): Promise<SourceDispatchAuthority> {
  const m = row.manifest;
  const native = await tx.query<{ project_id: string; environment_id: string; service_address: string; snapshot: unknown; snapshot_digest: string }>(
    "select project_id,environment_id,service_address,snapshot,snapshot_digest from platform.approved_source_snapshots where workspace_id=$1 and operation_id=$2 order by service_address collate \"C\" limit 10001",
    [m.workspaceId, m.operationId]);
  if (native.length > 10000) refuse();
  const reviews = await tx.query<{ id: string; summary: Record<string, unknown> }>(`select id,summary from platform.evidence
    where workspace_id=$1 and operation_id=$2 and kind='tofu_plan' and not simulated and digest=$3 and summary->>'stage'='plan'
    order by created_at,id`, [m.workspaceId, m.operationId, row.plan_digest]);
  const bound = native.length > 0 || reviews.some(review => sourceFields(review.summary));
  const base = { operationId: m.operationId, projectId: m.projectId, environmentId: m.environmentId,
    manifestDigest: row.manifest_digest, planDigest: row.plan_digest };
  // Historical source-free custody is admitted only after querying native absence and every matching original review.
  if (!bound) return { ...base, sources: [], recipes: [], setDigest: null, evidence: null };
  const { immutableSourceSnapshot, sourceSnapshotDigest, sourceSnapshotSetDigest, sourceRecipeMatches } = await import("@/lib/execution/source-snapshot");
  const sources = native.map(value => {
    let snapshot: ApprovedSourceSnapshot;
    try { snapshot = immutableSourceSnapshot(value.snapshot); } catch { refuse(); }
    if (snapshot.workspaceId !== m.workspaceId || snapshot.operationId !== m.operationId || snapshot.projectId !== m.projectId
      || snapshot.environmentId !== m.environmentId || value.project_id !== m.projectId || value.environment_id !== m.environmentId
      || value.service_address !== snapshot.serviceAddress || sourceSnapshotDigest(snapshot) !== value.snapshot_digest) refuse();
    return snapshot;
  }).sort((a, b) => a.serviceAddress < b.serviceAddress ? -1 : a.serviceAddress > b.serviceAddress ? 1 : 0);
  if (!sources.length) refuse();
  const original = reviews[0], review = original && projectPlanReview(original.summary, row.plan_digest);
  const setDigest = sourceSnapshotSetDigest(sources);
  const displayed = sources.slice(0,64).map(snapshot => ({ service: snapshot.serviceAddress, commit: snapshot.commitSha,
    dockerfileDigest: snapshot.dockerfileDigest, recipeDigest: snapshot.recipeDigest, archiveDigest: snapshot.archiveDigest, archiveFormat: snapshot.archiveFormat }));
  if (!original || !review || review.view.executableSourceDigest !== setDigest
    || JSON.stringify(review.view.approvedSources) !== JSON.stringify(displayed)
    || review.view.approvedSourcesTruncated !== (sources.length > 64 ? true : undefined)
    || review.view.approvedSourcesOmitted !== (sources.length > 64 ? sources.length - 64 : undefined)) refuse();
  const addresses = [...new Set(sources.flatMap(snapshot => [snapshot.serviceAddress, snapshot.pipelineAddress]))].sort();
  const resources = await tx.query<{ address: string; kind: string; provider: string; region: string; spec_digest: string; spec: Record<string, unknown>; ownership: string; status: string }>(
    "select address,kind,provider,region,spec_digest,spec,ownership,status from platform.resources where workspace_id=$1 and project_id=$2 and environment_id=$3 and address=any($4::text[]) order by address for share",
    [m.workspaceId, m.projectId, m.environmentId, textArray(addresses)]);
  const bindings = await tx.query<{ app_id: string; installation_id: number; repository_id: number; version: number; owner: string; repo: string; revoked_at: unknown }>(
    "select app_id,installation_id,repository_id,version,owner,repo,revoked_at from platform.github_source_bindings where workspace_id=$1", [m.workspaceId]);
  const current = bindings[0];
  const recipes = sources.map(snapshot => {
    const service = resources.find(resource => resource.address === snapshot.serviceAddress), pipeline = resources.find(resource => resource.address === snapshot.pipelineAddress);
    if (!service || !pipeline || !["container_service", "scheduled_job"].includes(service.kind) || pipeline.kind !== "build_pipeline"
      || [service, pipeline].some(resource => resource.provider !== snapshot.provider || resource.region !== snapshot.region
        || resource.ownership !== "managed" || resource.status === "deleted")
      || service.spec_digest !== snapshot.serviceSpecDigest || pipeline.spec_digest !== snapshot.pipelineSpecDigest
      || !sourceRecipeMatches(snapshot, { ...service, provider: snapshot.provider, specDigest: service.spec_digest },
        { ...pipeline, provider: snapshot.provider, specDigest: pipeline.spec_digest })) refuse();
    const remembered = snapshot.githubBinding;
    if (remembered ? !current || current.revoked_at || current.app_id !== remembered.appId
      || Number(current.installation_id) !== remembered.installationId || Number(current.repository_id) !== remembered.repositoryId
      || Number(current.version) !== remembered.version || current.owner !== snapshot.owner || current.repo !== snapshot.repo : !!current) refuse();
    return { snapshot, snapshotDigest: sourceSnapshotDigest(snapshot), serviceSpec: service.spec, pipelineSpec: pipeline.spec };
  });
  return { ...base, sources, recipes, setDigest, evidence: original };
}
// This parameter is produced only by captureSourceDispatch in this transaction. Every current predicate is repeated in the final statement.
const DISPATCH_SOURCE_AUTHORITY = `exists(select 1 from platform.plan_artifacts a where a.workspace_id=$1
    and a.operation_id=$7::text::jsonb->>'operationId' and a.manifest_digest=$7::text::jsonb->>'manifestDigest'
    and a.plan_digest=$7::text::jsonb->>'planDigest')
  and coalesce((select jsonb_agg(a.snapshot order by a.service_address collate "C") from platform.approved_source_snapshots a
    where a.workspace_id=$1 and a.operation_id=$7::text::jsonb->>'operationId'),'[]'::jsonb)=$7::text::jsonb->'sources'
  and (($7::text::jsonb->>'setDigest' is null and not exists(select 1 from platform.evidence e where e.workspace_id=$1
    and e.operation_id=$7::text::jsonb->>'operationId' and e.kind='tofu_plan' and not e.simulated and e.digest=$7::text::jsonb->>'planDigest'
    and e.summary->>'stage'='plan' and (e.summary ? 'executableSourceDigest'
      or e.summary->'view' ?| array['executableSourceDigest','approvedSources','approvedSourcesTruncated','approvedSourcesOmitted'])))
    or ($7::text::jsonb->>'setDigest' is not null and exists(select 1 from platform.evidence e where e.workspace_id=$1
      and e.operation_id=$7::text::jsonb->>'operationId' and e.id=$7::text::jsonb->'evidence'->>'id'
      and e.kind='tofu_plan' and not e.simulated and e.digest=$7::text::jsonb->>'planDigest' and e.summary=$7::text::jsonb->'evidence'->'summary'
      and e.summary->>'stage'='plan' and e.summary->>'planDigest'=$7::text::jsonb->>'planDigest'
      and e.summary->>'executableSourceDigest'=$7::text::jsonb->>'setDigest')))
  and not exists(select 1 from jsonb_array_elements($7::text::jsonb->'recipes') recipe where
    not exists(select 1 from platform.approved_source_snapshots a where a.workspace_id=$1
      and a.operation_id=$7::text::jsonb->>'operationId' and a.project_id=$7::text::jsonb->>'projectId'
      and a.environment_id=$7::text::jsonb->>'environmentId' and a.service_address=recipe->'snapshot'->>'serviceAddress'
      and a.snapshot=recipe->'snapshot' and a.snapshot_digest=recipe->>'snapshotDigest')
    or not exists(select 1 from platform.resources r where r.workspace_id=$1 and r.project_id=$7::text::jsonb->>'projectId'
      and r.environment_id=$7::text::jsonb->>'environmentId' and r.address=recipe->'snapshot'->>'serviceAddress'
      and r.kind in ('container_service','scheduled_job') and r.spec_digest=recipe->'snapshot'->>'serviceSpecDigest'
      and r.spec=recipe->'serviceSpec' and r.provider=recipe->'snapshot'->>'provider' and r.region=recipe->'snapshot'->>'region'
      and r.ownership='managed' and r.status<>'deleted')
    or not exists(select 1 from platform.resources r where r.workspace_id=$1 and r.project_id=$7::text::jsonb->>'projectId'
      and r.environment_id=$7::text::jsonb->>'environmentId' and r.address=recipe->'snapshot'->>'pipelineAddress'
      and r.kind='build_pipeline' and r.spec_digest=recipe->'snapshot'->>'pipelineSpecDigest' and r.spec=recipe->'pipelineSpec'
      and r.provider=recipe->'snapshot'->>'provider' and r.region=recipe->'snapshot'->>'region' and r.ownership='managed' and r.status<>'deleted')
    or not ((recipe->'snapshot'->'githubBinding'='null'::jsonb and not exists(select 1 from platform.github_source_bindings b where b.workspace_id=$1))
      or exists(select 1 from platform.github_source_bindings b where b.workspace_id=$1 and b.revoked_at is null
        and b.owner=recipe->'snapshot'->>'owner' and b.repo=recipe->'snapshot'->>'repo'
        and b.app_id=recipe->'snapshot'->'githubBinding'->>'appId'
        and b.installation_id=(recipe->'snapshot'->'githubBinding'->>'installationId')::bigint
        and b.repository_id=(recipe->'snapshot'->'githubBinding'->>'repositoryId')::bigint
        and b.version=(recipe->'snapshot'->'githubBinding'->>'version')::integer)))`;
export async function claim(sql: Sql, input: ArtifactAccess, attemptId: string): Promise<ArtifactRow> {
  input = captureArtifactAccess(input);
  return sql.tx(async (tx) => {
    const row = await read(tx,input);
    let productAuthority: PlanProductDispatchAuthority;
    try { productAuthority = await retainClaimedPlanProductAuthority(tx, row, input.custody.operationId, attemptId); } catch { return refuse(); }
    const owned = await tx.query(`select operation_id from platform.plan_artifact_uses where workspace_id=$1 and operation_id=$2 and phase='ready' for update`,
      [input.custody.workspaceId,input.custody.operationId]);
    if (owned.length !== 1) refuse();
    if (productAuthority.kind === "product") {
      try { await assertFinalMcpProductTopology(sql, tx); } catch { return refuse(); }
    }
    const changed = await tx.query(`update platform.plan_artifact_uses set phase='claimed',attempt_id=$3,holder=$4,fence_token=$5,updated_at=clock_timestamp()
      where workspace_id=$1 and operation_id=$2 and phase='ready' and (${LIVE_USE_AUTHORITY})
      and $6::text is null and $7::text is null
      and (${planProductDispatchPredicate(productAuthority)}) returning operation_id`,
      [input.custody.workspaceId,input.custody.operationId,attemptId,input.lease.holder,input.lease.fenceToken,null,null,JSON.stringify(productAuthority)]);
    if (!changed.length) refuse();
    return row;
  });
}
export async function dispatch(sql: Sql, input: ArtifactAccess, attemptId: string, authority?: Readonly<DispatchApprovalSnapshot>, cleanupOrigin?: unknown, standaloneOrigin?:unknown): Promise<void> {
  const originatedAuthority = authority;
  if(authority) {
    authority=Object.freeze({...authority,approvalIds:Object.freeze([...authority.approvalIds])});
    if(authority.proposalDigest!==input.custody.proposalDigest || authority.planDigest!==input.planDigest || !Number.isInteger(authority.approvalRound)
      || !Number.isInteger(authority.requiredApprovalCount) || authority.requiredApprovalCount<0 || authority.approvalIds.length<authority.requiredApprovalCount) refuse();
  }
  input = captureArtifactAccess(input);
  const standalone=standaloneOrigin===undefined?undefined:await readNativeStandaloneOrigin(standaloneOrigin,sql,"binding");
  if(standalone && (digest(standalone.access)!==digest(input) || standalone.attempt!==attemptId || standalone.proof!==originatedAuthority))refuse();
  await sql.tx(async (tx) => {
    const row = await read(tx,input);
    const sourceAuthority = await captureSourceDispatch(tx,row);
    let productAuthority: PlanProductDispatchAuthority;
    try { productAuthority = await captureClaimedPlanProductAuthority(tx, row, input.custody.operationId, attemptId); } catch { return refuse(); }
    // A separate post-wait statement must see revocation committed while this owning use row was blocked.
    const owned = await tx.query(`select operation_id from platform.plan_artifact_uses where workspace_id=$1 and operation_id=$2
      and phase='claimed' and attempt_id=$3 and holder=$4 and fence_token=$5 for update`,
      [input.custody.workspaceId,input.custody.operationId,attemptId,input.lease.holder,input.lease.fenceToken]);
    if (owned.length !== 1) refuse();
    if (productAuthority.kind === "product") {
      try { await assertFinalMcpProductTopology(sql, tx); } catch { return refuse(); }
      try { productAuthority = await withCurrentPlanDispatchRequirement(sql, productAuthority, originatedAuthority); } catch { return refuse(); }
    }
    if(standalone) {
      const b=standalone.binding;
      if(productAuthority.kind!=="product" || b.manifestDigest!==row.manifest_digest || b.rawSha256!==row.manifest.rawSha256 || b.backendDigest!==row.manifest.backendDigest)refuse();
      // This immutable physical target can never be rebound to another logical scope or approved path.
      await tx.query(`insert into platform.standalone_plan_backends(target_digest,workspace_id,project_id,environment_id,backend_digest)
        values($1,$2,$3,$4,$5) on conflict do nothing`,[b.targetDigest,b.workspaceId,b.projectId,b.environmentId,b.backendDigest]);
      const ownedBackend=await tx.query(`select target_digest from platform.standalone_plan_backends where target_digest=$1 and workspace_id=$2
        and project_id=$3 and environment_id=$4 and backend_digest=$5 for key share`,[b.targetDigest,b.workspaceId,b.projectId,b.environmentId,b.backendDigest]);
      if(ownedBackend.length!==1)refuse();
      await assertNativeStandaloneOriginCurrent(standaloneOrigin,sql);
    }
    let settled:readonly StandaloneSettlementRow[]=Object.freeze([]);
    if(row.manifest.purpose==="destroy") {
      if(productAuthority.kind!=="product")throw new cleanup.CleanupWriterBarrierError();
      const bound=await readNativeCleanupOrigin(cleanupOrigin,sql,"dispatch");
      if(bound.access.custody.operationId!==input.custody.operationId || digest(bound.access)!==digest(input) || bound.attempt!==attemptId
        || bound.proof!==originatedAuthority || !bound.hold || !bound.jti || bound.manifestDigest!==row.manifest_digest)throw new cleanup.CleanupWriterBarrierError();
      await lockCleanupCoordinator(tx,input.custody.workspaceId);
      await assertNativeCleanupOriginCurrent(cleanupOrigin,sql);
      const currentFrame=cleanupFrame(row,sourceAuthority,productAuthority,originatedAuthority!);
      await assertHeldCleanup(sql,tx,cleanupOrigin,bound,currentFrame);
      settled=bound.settlements;
    }
    if(standalone)await assertNativeStandaloneOriginCurrent(standaloneOrigin,sql);
    const changed = await tx.query(`update platform.plan_artifact_uses set phase='dispatched',updated_at=clock_timestamp()
      where workspace_id=$1 and operation_id=$2 and phase='claimed' and attempt_id=$3 and holder=$4 and fence_token=$5 and (${LIVE_USE_AUTHORITY})
      and (${DISPATCH_SOURCE_AUTHORITY})
      and (${planProductDispatchPredicate(productAuthority)})
      and (${LIVE_STANDALONE_SETTLEMENTS})
      and ($6::text::jsonb is null or exists (select 1 from platform.operations o where o.workspace_id=$1 and o.id=$2
        and o.approval_round=($6::text::jsonb->>'approvalRound')::integer and o.proposal_digest=$6::text::jsonb->>'proposalDigest'
        and o.plan_digest=$6::text::jsonb->>'planDigest'
        and (select count(distinct a.approver_id) from platform.approvals a where a.workspace_id=$1 and a.operation_id=$2
          and a.id in (select jsonb_array_elements_text($6::text::jsonb->'approvalIds')) and a.decision='approve'
          and a.approver->>'kind'='user' and a.approval_round=o.approval_round and a.proposal_digest=o.proposal_digest
          and a.consumed_at is not null and a.expires_at > clock_timestamp()) >= ($6::text::jsonb->>'requiredApprovalCount')::integer
        and not exists (select 1 from platform.approvals a where a.workspace_id=$1 and a.operation_id=$2 and a.approval_round=o.approval_round and a.decision='reject')))
      returning operation_id`,
      [input.custody.workspaceId,input.custody.operationId,attemptId,input.lease.holder,input.lease.fenceToken,authority?JSON.stringify({...authority,standaloneSettlements:settled}):null,JSON.stringify(sourceAuthority),JSON.stringify(productAuthority)]);
    if (!changed.length) refuse();
  });
}

interface CleanupFrame { row:ArtifactRow; source:SourceDispatchAuthority; product:PlanProductDispatchAuthority; authorityDigest:string }
function cleanupFrame(row:ArtifactRow,source:SourceDispatchAuthority,product:PlanProductDispatchAuthority,proof:Readonly<DispatchApprovalSnapshot>):CleanupFrame {
  return {row,source,product,authorityDigest:digest({manifest:row.manifest_digest,source,product,proof})};
}
async function captureCleanupFrame(sql:Sql,tx:Sql,bound:NativeCleanupOrigin):Promise<CleanupFrame> {
  const input=bound.access,row=await read(tx,input);
  const op=await get(tx,input.custody.workspaceId,input.custody.operationId);
  if(!op || op.capability!=="infrastructure.destroy" || row.manifest.purpose!=="destroy" || row.manifest_digest!==bound.manifestDigest
    || digest({manifest:row.manifest_digest,iv:row.iv,authTag:row.auth_tag,ciphertext:row.ciphertext})!==bound.rawAuthenticationDigest)throw new cleanup.CleanupWriterBarrierError();
  const source=await captureSourceDispatch(tx,row);
  let product=await captureClaimedPlanProductAuthority(tx,row,input.custody.operationId,bound.attempt);
  const owned=await tx.query("select operation_id from platform.plan_artifact_uses where workspace_id=$1 and operation_id=$2 and phase='claimed' and attempt_id=$3 and holder=$4 and fence_token=$5 for update",
    [input.custody.workspaceId,input.custody.operationId,bound.attempt,input.lease.holder,input.lease.fenceToken]);
  if(owned.length!==1 || product.kind!=="product")throw new cleanup.CleanupWriterBarrierError();
  // Reserve's existing hold FK is acquired before the final coordinator too.
  if(bound.hold) {
    const held=await tx.query("select generation from platform.cleanup_writer_holds where workspace_id=$1 and operation_id=$2 and attempt_id=$3 and generation=$4 for key share",
      [input.custody.workspaceId,input.custody.operationId,bound.attempt,bound.hold.generation]);
    if(held.length!==1)throw new cleanup.CleanupWriterBarrierError();
  }
  await assertFinalMcpProductTopology(sql,tx);
  product=await withCurrentPlanDispatchRequirement(sql,product,bound.proof);
  return cleanupFrame(row,source,product,bound.proof);
}
async function lockCleanupCoordinator(tx:Sql,workspaceId:string):Promise<void> {
  await tx.query("insert into platform.cleanup_writer_scopes(workspace_id) values($1) on conflict do nothing",[workspaceId]);
  await tx.query("select workspace_id from platform.cleanup_writer_scopes where workspace_id=$1 for update",[workspaceId]);
}
async function assertHeldCleanup(sql:Sql,tx:Sql,origin:unknown,bound:NativeCleanupOrigin,frame:CleanupFrame):Promise<void> {
  const c=bound.access.custody,h=bound.hold;
  if(!h || h.authorityDigest!==frame.authorityDigest || !bound.jti)throw new cleanup.CleanupWriterBarrierError();
  const rows=await tx.query(`select h.generation from platform.cleanup_writer_holds h join platform.cleanup_owner_grants g
    on g.workspace_id=h.workspace_id and g.operation_id=h.operation_id and g.attempt_id=h.attempt_id and g.generation=h.generation
    where h.workspace_id=$1 and h.project_id=$2 and h.environment_id=$3 and h.operation_id=$4 and h.attempt_id=$5
      and h.generation=$6 and h.manifest_digest=$7 and h.authority_digest=$8 and h.holder=$9 and h.fence_token=$10 and g.jti=$11`,
    [c.workspaceId,c.projectId,c.environmentId,c.operationId,bound.attempt,h.generation,bound.manifestDigest,frame.authorityDigest,bound.access.lease.holder,bound.access.lease.fenceToken,bound.jti]);
  if(rows.length!==1)throw new cleanup.CleanupWriterBarrierError();
  const inventory=await cleanup.inventoryForNativeOrigin(sql,tx,origin);
  cleanup.assertDrained(inventory);
}
/** Releases the scope's newest hold only when its counted inventory is zero. The caller already holds the workspace coordinator. */
async function releaseDrainedScopeHold(tx:Sql,workspaceId:string,projectId:string,environmentId:string,releasedBy:string):Promise<number> {
  const inventory=await cleanup.inventory(tx,workspaceId,projectId,environmentId);
  if(Object.values(inventory).some(n=>n!==0))return 0;
  const rows=await tx.query<{hold_seq:string}>(`insert into platform.cleanup_writer_hold_releases(workspace_id,project_id,environment_id,hold_seq,operation_id,attempt_id,generation,released_by,inventory_snapshot)
    select h.workspace_id,h.project_id,h.environment_id,h.hold_seq,h.operation_id,h.attempt_id,h.generation,$4::text,$5::text::jsonb from platform.cleanup_writer_holds h
    where h.workspace_id=$1 and h.project_id=$2 and h.environment_id=$3
      and not exists(select 1 from platform.cleanup_writer_holds n where n.workspace_id=h.workspace_id and n.project_id=h.project_id
        and n.environment_id=h.environment_id and n.hold_seq>h.hold_seq)
      and not exists(select 1 from platform.cleanup_writer_hold_releases r where r.workspace_id=h.workspace_id and r.hold_seq=h.hold_seq)
      -- A live claimed attempt keeps its freeze: a fresh zero-inventory hold must not be released before its grant.
      and not exists(select 1 from platform.plan_artifact_uses u where u.workspace_id=h.workspace_id and u.operation_id=h.operation_id
        and u.attempt_id=h.attempt_id and u.phase='claimed')
    on conflict do nothing returning hold_seq::text as hold_seq`,[workspaceId,projectId,environmentId,releasedBy,JSON.stringify(inventory)]);
  return rows.length;
}
/**
 * shortcut: until delivery settlement (WP2/WP3) exists nothing drains, so a refused attempt's own hold would freeze the
 * environment for good. The caller refuses right after this commit and a released generation can never authorize a destroy
 * grant, so it is released in the hold transaction (owner decision 2026-10-26). Remove once settlement lets a frozen scope drain.
 */
async function releaseRefusedHold(tx:Sql,workspaceId:string,operationId:string,attemptId:string,generation:string,inventory:cleanup.CleanupInventory):Promise<void> {
  if(!Object.values(inventory).some(n=>n!==0))return;
  const released=await tx.query(`insert into platform.cleanup_writer_hold_releases(workspace_id,project_id,environment_id,hold_seq,operation_id,attempt_id,generation,released_by,inventory_snapshot)
    select h.workspace_id,h.project_id,h.environment_id,h.hold_seq,h.operation_id,h.attempt_id,h.generation,$5::text,$6::text::jsonb from platform.cleanup_writer_holds h
    where h.workspace_id=$1 and h.operation_id=$2 and h.attempt_id=$3 and h.generation=$4
    on conflict do nothing returning hold_seq`,[workspaceId,operationId,attemptId,generation,`refused:${attemptId}`,JSON.stringify(inventory)]);
  if(released.length!==1)throw new cleanup.CleanupWriterBarrierError();
}
/** Guarded private origin only. Commit the hold even when the counted inventory blocks continuation. */
export async function retainCleanupWriterHold(sql:Sql,origin:unknown):Promise<Readonly<{hold:cleanup.CleanupHold;inventory:cleanup.CleanupInventory}>> {
  const bound=await readNativeCleanupOrigin(origin,sql,"hold"),c=bound.access.custody;
  return sql.tx(async tx=>{
    const frame=await captureCleanupFrame(sql,tx,bound);
    await lockCleanupCoordinator(tx,c.workspaceId);
    await assertNativeCleanupOriginCurrent(origin,sql);
    // A superseded generation is released first, and only when its scope has drained (WP5 decision 1).
    await releaseDrainedScopeHold(tx,c.workspaceId,c.projectId,c.environmentId,`retain:${bound.attempt}`);
    const generation=randomUUID();
    const input=bound.access,sourceAuthority=frame.source,productAuthority=frame.product;
    // The original full authority predicate and this inert hold INSERT share one fresh statement.
    const rows=await tx.query(`with authority as (update platform.plan_artifact_uses set updated_at=updated_at
      where workspace_id=$1 and operation_id=$2 and phase='claimed' and attempt_id=$3 and holder=$4 and fence_token=$5 and (${LIVE_USE_AUTHORITY})
      and (${DISPATCH_SOURCE_AUTHORITY})
      and (${planProductDispatchPredicate(productAuthority)})
      and (${LIVE_STANDALONE_SETTLEMENTS})
      and ($6::text::jsonb is null or exists (select 1 from platform.operations o where o.workspace_id=$1 and o.id=$2
        and o.approval_round=($6::text::jsonb->>'approvalRound')::integer and o.proposal_digest=$6::text::jsonb->>'proposalDigest'
        and o.plan_digest=$6::text::jsonb->>'planDigest'
        and (select count(distinct a.approver_id) from platform.approvals a where a.workspace_id=$1 and a.operation_id=$2
          and a.id in (select jsonb_array_elements_text($6::text::jsonb->'approvalIds')) and a.decision='approve'
          and a.approver->>'kind'='user' and a.approval_round=o.approval_round and a.proposal_digest=o.proposal_digest
          and a.consumed_at is not null and a.expires_at > clock_timestamp()) >= ($6::text::jsonb->>'requiredApprovalCount')::integer
        and not exists (select 1 from platform.approvals a where a.workspace_id=$1 and a.operation_id=$2 and a.approval_round=o.approval_round and a.decision='reject')))
      returning operation_id)
      insert into platform.cleanup_writer_holds(workspace_id,project_id,environment_id,operation_id,attempt_id,generation,manifest_digest,authority_digest,holder,fence_token)
      select $1,$9,$10,$2,$3,$11,$12,$13,$4,$5 from authority where operation_id=$2
      on conflict do nothing returning generation`,
      [input.custody.workspaceId,input.custody.operationId,bound.attempt,input.lease.holder,input.lease.fenceToken,JSON.stringify({...bound.proof,standaloneSettlements:bound.settlements}),JSON.stringify(sourceAuthority),JSON.stringify(productAuthority),c.projectId,c.environmentId,generation,bound.manifestDigest,frame.authorityDigest]);
    if(rows.length!==1)throw new cleanup.CleanupWriterBarrierError();
    const hold=Object.freeze({workspaceId:c.workspaceId,projectId:c.projectId,environmentId:c.environmentId,operationId:c.operationId,attemptId:bound.attempt,generation,manifestDigest:bound.manifestDigest,authorityDigest:frame.authorityDigest});
    const inventory=await cleanup.inventoryForNativeOrigin(sql,tx,origin);
    await releaseRefusedHold(tx,c.workspaceId,c.operationId,bound.attempt,generation,inventory);
    return Object.freeze({hold,inventory});
  });
}
/** Reserving consumes the sole held attempt slot even if signing/INSERT or its acknowledgement is subsequently lost. */
export async function reserveCleanupOwnerGrant(sql:Sql,origin:unknown,jti:string):Promise<void> {
  const bound=await readNativeCleanupOrigin(origin,sql,"grant"),c=bound.access.custody,h=bound.hold;
  if(!h || bound.jti!==jti || !/^[a-f0-9-]{36}$/.test(jti))throw new cleanup.CleanupWriterBarrierError();
  await sql.tx(async tx=>{
    const frame=await captureCleanupFrame(sql,tx,bound);
    await lockCleanupCoordinator(tx,c.workspaceId);await assertNativeCleanupOriginCurrent(origin,sql);
    if(h.authorityDigest!==frame.authorityDigest)throw new cleanup.CleanupWriterBarrierError();
    const inventory=await cleanup.inventoryForNativeOrigin(sql,tx,origin);
    cleanup.assertDrained(inventory);
    await assertNativeCleanupOriginCurrent(origin,sql);
    const input=bound.access,sourceAuthority=frame.source,productAuthority=frame.product;
    // Inventory/history awaits finish before the same-statement current authority and reservation.
    const rows=await tx.query(`with authority as (update platform.plan_artifact_uses set updated_at=updated_at
      where workspace_id=$1 and operation_id=$2 and phase='claimed' and attempt_id=$3 and holder=$4 and fence_token=$5 and (${LIVE_USE_AUTHORITY})
      and (${DISPATCH_SOURCE_AUTHORITY})
      and (${planProductDispatchPredicate(productAuthority)})
      and (${LIVE_STANDALONE_SETTLEMENTS})
      and ($6::text::jsonb is null or exists (select 1 from platform.operations o where o.workspace_id=$1 and o.id=$2
        and o.approval_round=($6::text::jsonb->>'approvalRound')::integer and o.proposal_digest=$6::text::jsonb->>'proposalDigest'
        and o.plan_digest=$6::text::jsonb->>'planDigest'
        and (select count(distinct a.approver_id) from platform.approvals a where a.workspace_id=$1 and a.operation_id=$2
          and a.id in (select jsonb_array_elements_text($6::text::jsonb->'approvalIds')) and a.decision='approve'
          and a.approver->>'kind'='user' and a.approval_round=o.approval_round and a.proposal_digest=o.proposal_digest
          and a.consumed_at is not null and a.expires_at > clock_timestamp()) >= ($6::text::jsonb->>'requiredApprovalCount')::integer
        and not exists (select 1 from platform.approvals a where a.workspace_id=$1 and a.operation_id=$2 and a.approval_round=o.approval_round and a.decision='reject')))
      returning operation_id)
      insert into platform.cleanup_owner_grants(workspace_id,operation_id,attempt_id,generation,jti,capability,audience)
      select $1,$2,$3,$9,$10,'infrastructure.destroy','worker' from authority where operation_id=$2
        and exists(select 1 from platform.cleanup_writer_holds where workspace_id=$1 and operation_id=$2 and attempt_id=$3
          and generation=$9 and authority_digest=$11)
      on conflict do nothing returning jti`,[input.custody.workspaceId,input.custody.operationId,bound.attempt,input.lease.holder,input.lease.fenceToken,JSON.stringify({...bound.proof,standaloneSettlements:bound.settlements}),JSON.stringify(sourceAuthority),JSON.stringify(productAuthority),h.generation,jti,frame.authorityDigest]);
    if(rows.length!==1)throw new cleanup.CleanupWriterBarrierError();
  });
}
/** The current original approval/member/source predicate guards the actual grant INSERT after all inventory waits. */
export async function insertCleanupOwnerGrant(sql:Sql,origin:unknown,input:grants.InsertGrantInput):Promise<void> {
  const bound=await readNativeCleanupOrigin(origin,sql,"grant"),c=bound.access.custody;
  const grant=Object.freeze({jti:requireText("jti",input.jti,128),workspaceId:requireText("workspaceId",input.workspaceId),
    operationId:requireText("operationId",input.operationId),capability:requireText("capability",input.capability,128),
    audience:requireText("audience",input.audience,256),issuedAt:input.issuedAt,expiresAt:input.expiresAt});
  const issued=Date.parse(grant.issuedAt),expires=Date.parse(grant.expiresAt);
  if(!Number.isFinite(issued)||!Number.isFinite(expires)||expires<=issued)
    throw new ControlStoreError("invalid_input","A grant must expire after it is issued.");
  if(expires-issued>60*60*1000)throw new ControlStoreError("invalid_input","A capability grant may live at most one hour.");
  if(grant.jti!==bound.jti || grant.workspaceId!==c.workspaceId || grant.operationId!==c.operationId
    || grant.capability!=="infrastructure.destroy" || grant.audience!=="worker")throw new cleanup.CleanupWriterBarrierError();
  await sql.tx(async tx=>{
    const frame=await captureCleanupFrame(sql,tx,bound);
    await lockCleanupCoordinator(tx,c.workspaceId);await assertNativeCleanupOriginCurrent(origin,sql);
    await assertHeldCleanup(sql,tx,origin,bound,frame);
    await assertNativeCleanupOriginCurrent(origin,sql);
    const input=bound.access,sourceAuthority=frame.source,productAuthority=frame.product;
    // No authority-check/await/INSERT gap: the bearer stays local until this guarded statement commits.
    const rows=await tx.query(`with authority as (update platform.plan_artifact_uses set updated_at=updated_at
      where workspace_id=$1 and operation_id=$2 and phase='claimed' and attempt_id=$3 and holder=$4 and fence_token=$5 and (${LIVE_USE_AUTHORITY})
      and (${DISPATCH_SOURCE_AUTHORITY})
      and (${planProductDispatchPredicate(productAuthority)})
      and (${LIVE_STANDALONE_SETTLEMENTS})
      and ($6::text::jsonb is null or exists (select 1 from platform.operations o where o.workspace_id=$1 and o.id=$2
        and o.approval_round=($6::text::jsonb->>'approvalRound')::integer and o.proposal_digest=$6::text::jsonb->>'proposalDigest'
        and o.plan_digest=$6::text::jsonb->>'planDigest'
        and (select count(distinct a.approver_id) from platform.approvals a where a.workspace_id=$1 and a.operation_id=$2
          and a.id in (select jsonb_array_elements_text($6::text::jsonb->'approvalIds')) and a.decision='approve'
          and a.approver->>'kind'='user' and a.approval_round=o.approval_round and a.proposal_digest=o.proposal_digest
          and a.consumed_at is not null and a.expires_at > clock_timestamp()) >= ($6::text::jsonb->>'requiredApprovalCount')::integer
        and not exists (select 1 from platform.approvals a where a.workspace_id=$1 and a.operation_id=$2 and a.approval_round=o.approval_round and a.decision='reject')))
      returning operation_id)
      insert into platform.capability_grants(jti,workspace_id,operation_id,capability,audience,issued_at,expires_at)
      select $9,$1,$2,'infrastructure.destroy','worker',$10::text::timestamptz,$11::text::timestamptz
      from authority where operation_id=$2 returning jti`,
      [input.custody.workspaceId,input.custody.operationId,bound.attempt,input.lease.holder,input.lease.fenceToken,JSON.stringify({...bound.proof,standaloneSettlements:bound.settlements}),JSON.stringify(sourceAuthority),JSON.stringify(productAuthority),grant.jti,grant.issuedAt,grant.expiresAt]);
    if(rows.length!==1)throw new cleanup.CleanupWriterBarrierError();
  });
}

/** Internal captured runtime lookup. It cannot grant custody or dispatch. */
export async function requiresProductComposition(sql: Sql, row: ArtifactRow, destination: string, attempt: string): Promise<boolean> {
  try { return await claimedPlanRequiresProductComposition(sql, row, destination, attempt); } catch { return refuse(); }
}
/** Only the captured engine can supply this completion. A terminal use row alone never clears delivery history. */
export async function finishStandalone(sql:Sql,origin:unknown):Promise<void> {
  const bound=await readNativeStandaloneOrigin(origin,sql,"completion"),receipt=bound.receipt;
  if(!receipt || digest(receipt.binding)!==digest(bound.binding))refuse();
  const input=captureArtifactAccess(bound.access),b=bound.binding;
  if(b.workspaceId!==input.custody.workspaceId || b.projectId!==input.custody.projectId || b.environmentId!==input.custody.environmentId
    || b.operationId!==input.custody.operationId || b.attemptId!==bound.attempt || b.holder!==input.lease.holder || b.fenceToken!==input.lease.fenceToken)refuse();
  await sql.tx(async tx=>{
    const row=await read(tx,input),sourceAuthority=await captureSourceDispatch(tx,row);
    let productAuthority=await captureClaimedPlanProductAuthority(tx,row,input.custody.operationId,bound.attempt);
    if(productAuthority.kind!=="product" || b.manifestDigest!==row.manifest_digest || b.rawSha256!==row.manifest.rawSha256
      || b.backendDigest!==row.manifest.backendDigest)refuse();
    const owned=await tx.query(`select operation_id from platform.plan_artifact_uses where workspace_id=$1 and operation_id=$2
      and phase='dispatched' and attempt_id=$3 and holder=$4 and fence_token=$5 for update`,
      [b.workspaceId,b.operationId,b.attemptId,b.holder,b.fenceToken]);
    if(owned.length!==1)refuse();
    const backend=await tx.query(`select target_digest from platform.standalone_plan_backends where target_digest=$1
      and workspace_id=$2 and project_id=$3 and environment_id=$4 and backend_digest=$5 for key share`,
      [b.targetDigest,b.workspaceId,b.projectId,b.environmentId,b.backendDigest]);
    if(backend.length!==1)refuse();
    await assertFinalMcpProductTopology(sql,tx);
    productAuthority=await withCurrentPlanDispatchRequirement(sql,productAuthority,bound.proof);
    // All owning row/FK locks precede the final workspace coordinator. No provider call occurs in this transaction.
    await lockCleanupCoordinator(tx,b.workspaceId);
    await assertNativeStandaloneOriginCurrent(origin,sql);
    const changed=await tx.query(`with authority as (
      update platform.plan_artifact_uses set phase='succeeded',updated_at=clock_timestamp()
      where workspace_id=$1 and operation_id=$2 and phase='dispatched' and attempt_id=$3 and holder=$4 and fence_token=$5
      and (${LIVE_USE_AUTHORITY}) and (${DISPATCH_SOURCE_AUTHORITY}) and (${planProductDispatchPredicate(productAuthority)})
      and $6::text::jsonb is not null and exists (select 1 from platform.operations o where o.workspace_id=$1 and o.id=$2
        and o.approval_round=($6::text::jsonb->>'approvalRound')::integer and o.proposal_digest=$6::text::jsonb->>'proposalDigest'
        and o.plan_digest=$6::text::jsonb->>'planDigest'
        and (select count(distinct a.approver_id) from platform.approvals a where a.workspace_id=$1 and a.operation_id=$2
          and a.id in (select jsonb_array_elements_text($6::text::jsonb->'approvalIds')) and a.decision='approve'
          and a.approver->>'kind'='user' and a.approval_round=o.approval_round and a.proposal_digest=o.proposal_digest
          and a.consumed_at is not null and a.expires_at > clock_timestamp()) >= ($6::text::jsonb->>'requiredApprovalCount')::integer
        and not exists (select 1 from platform.approvals a where a.workspace_id=$1 and a.operation_id=$2 and a.approval_round=o.approval_round and a.decision='reject'))
      and exists(select 1 from platform.standalone_plan_backends backend where backend.target_digest=$9::text::jsonb->'binding'->>'targetDigest'
        and backend.workspace_id=$1 and backend.project_id=$9::text::jsonb->'binding'->>'projectId'
        and backend.environment_id=$9::text::jsonb->'binding'->>'environmentId' and backend.backend_digest=$9::text::jsonb->'binding'->>'backendDigest')
      returning workspace_id,operation_id)
      insert into platform.standalone_plan_settlements(workspace_id,project_id,environment_id,operation_id,attempt_id,manifest_digest,raw_sha256,
        backend_digest,target_digest,holder,fence_token,settlement_digest,iv,auth_tag,ciphertext)
      select authority.workspace_id,$9::text::jsonb->'binding'->>'projectId',$9::text::jsonb->'binding'->>'environmentId',authority.operation_id,$3,
        $9::text::jsonb->'binding'->>'manifestDigest',$9::text::jsonb->'binding'->>'rawSha256',$9::text::jsonb->'binding'->>'backendDigest',
        $9::text::jsonb->'binding'->>'targetDigest',$4,$5,$9::text::jsonb->>'settlementDigest',$9::text::jsonb->'sealed'->>'iv',
        $9::text::jsonb->'sealed'->>'authTag',$9::text::jsonb->'sealed'->>'ciphertext' from authority returning operation_id`,
      [b.workspaceId,b.operationId,b.attemptId,b.holder,b.fenceToken,JSON.stringify(bound.proof),JSON.stringify(sourceAuthority),JSON.stringify(productAuthority),JSON.stringify(receipt)]);
    if(changed.length!==1)refuse();
  });
}
/** Completion never reopens a dispatched attempt, even when its operation/fence has expired. */
export async function finish(sql: Sql, input: ArtifactAccess, attemptId: string, success: boolean): Promise<void> {
  input = captureArtifactAccess(input);
  const update=async(tx:Sql)=> {
    const rows = await tx.query<{phase:string}>(`update platform.plan_artifact_uses set phase=case when phase='claimed' then 'ready' when $6::boolean then 'succeeded' else 'uncertain' end,
      updated_at=clock_timestamp() where workspace_id=$1 and operation_id=$2 and attempt_id=$3 and holder=$4 and fence_token=$5
      and phase in ('claimed','dispatched') and (not $6::boolean or phase='dispatched') and (not $6::boolean or (${LIVE_USE_AUTHORITY})) returning phase`,
      [input.custody.workspaceId,input.custody.operationId,attemptId,input.lease.holder,input.lease.fenceToken,success]);
    if (success && rows[0]?.phase !== "succeeded") refuse();
  };
  if (success) await sql.tx(async tx=>{await read(tx,input);await update(tx);});
  else await update(sql);
}
/** Logical expiry only. No ciphertext or legacy file is physically removed. */
export async function expire(sql: Sql, limit=100): Promise<number> {
  const candidates = await sql.query<{workspace_id:string;operation_id:string;source_operation_id:string}>(`select a.workspace_id,a.operation_id,a.operation_id as source_operation_id
    from platform.plan_artifacts a join platform.plan_artifact_uses u using(workspace_id,operation_id)
    where a.expires_at <= clock_timestamp() and u.phase in ('ready','claimed','dispatched')
    union all select a.workspace_id,a.operation_id,a.source_operation_id from platform.plan_artifact_associations a
    join platform.plan_artifact_uses u using(workspace_id,operation_id) where a.expires_at <= clock_timestamp() and u.phase in ('ready','claimed','dispatched')
    order by workspace_id,operation_id limit $1::bigint`, [Math.max(1,Math.min(1000,limit))]);
  let count=0;
  for (const c of candidates) count += await sql.tx(async tx => {
    // Maintenance needs no live authority, but follows the same fence-before-row lock order.
    const scopes=await tx.query<{lease_scope:string}>("select distinct lease_scope from platform.operations where workspace_id=$1 and id in ($2,$3) and lease_scope is not null order by lease_scope",[c.workspace_id,c.operation_id,c.source_operation_id]);
    for (const {lease_scope} of scopes) await tx.query("select scope from platform.leases where scope=$1 for update",[lease_scope]);
    await lockOperations(tx,c.workspace_id,[c.operation_id,c.source_operation_id]);
    await tx.query("select operation_id from platform.plan_artifacts where workspace_id=$1 and operation_id=$2 for update",[c.workspace_id,c.source_operation_id]);
    if (c.source_operation_id!==c.operation_id) await tx.query("select operation_id from platform.plan_artifact_associations where workspace_id=$1 and operation_id=$2 for update",[c.workspace_id,c.operation_id]);
    const changed = await tx.query(`update platform.plan_artifact_uses set phase=case when phase='dispatched' then 'uncertain' else 'expired' end,updated_at=clock_timestamp()
      where workspace_id=$1 and operation_id=$2 and phase in ('ready','claimed','dispatched') returning operation_id`,[c.workspace_id,c.operation_id]);
    return changed.length;
  });
  return count;
}

/** Janitor sweep beside expire: release each scope's newest hold once it drains. Writes only under the workspace coordinator. */
export async function releaseDrainedHolds(sql: Sql, limit=100): Promise<number> {
  const candidates = await sql.query<{workspace_id:string;project_id:string;environment_id:string}>(`select h.workspace_id,h.project_id,h.environment_id
    from platform.cleanup_writer_holds h
    where not exists(select 1 from platform.cleanup_writer_holds n where n.workspace_id=h.workspace_id and n.project_id=h.project_id
      and n.environment_id=h.environment_id and n.hold_seq>h.hold_seq)
    and not exists(select 1 from platform.cleanup_writer_hold_releases r where r.workspace_id=h.workspace_id and r.hold_seq=h.hold_seq)
    -- Random order: undrainable scopes (no settlement yet) must not starve drained ones beyond the limit. One newest row per scope, so no distinct.
    order by random() limit $1::bigint`, [Math.max(1,Math.min(1000,limit))]);
  let count=0;
  // The candidate list is only a hint: the newest hold and its inventory are re-read under the coordinator.
  for (const c of candidates) count += await sql.tx(async tx => {
    await lockCleanupCoordinator(tx,c.workspace_id);
    return releaseDrainedScopeHold(tx,c.workspace_id,c.project_id,c.environment_id,"janitor");
  });
  return count;
}

/** Explicit preview configuration, never deletion permission or an execution lifetime extension. */
export interface PlanArtifactRetentionPreviewInput {
  readonly workspaceId: string;
  readonly createdBefore: string;
  readonly limit: number;
  readonly holdOperationIds: readonly string[];
}
/** Only counts leave the store. An archive review means a possible future copy, with original custody retained. */
export interface PlanArtifactRetentionPreview {
  readonly mode: "dry-run";
  readonly scanned: number;
  readonly hasMore: boolean;
  readonly held: number;
  readonly active: number;
  readonly unresolved: number;
  readonly unavailable: number;
  readonly withinRetention: number;
  readonly archiveReview: number;
}
function retentionInput(value: PlanArtifactRetentionPreviewInput): PlanArtifactRetentionPreviewInput {
  const refuseInput = (): never => { throw new ControlStoreError("invalid_input", "Plan retention preview requires explicit bounded configuration."); };
  if (!value || typeof value !== "object" || Array.isArray(value)
    || JSON.stringify(Object.getOwnPropertyNames(value).sort()) !== JSON.stringify(["createdBefore", "holdOperationIds", "limit", "workspaceId"])) return refuseInput();
  const own = (object: unknown, key: string): unknown => {
    if (!object || typeof object !== "object") return refuseInput();
    const descriptor = Object.getOwnPropertyDescriptor(object, key);
    if (!descriptor || !("value" in descriptor)) return refuseInput();
    return descriptor.value;
  };
  const id = (raw: unknown): string => {
    if (typeof raw !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(raw)) return refuseInput();
    return raw;
  };
  const workspaceId = id(own(value, "workspaceId")), createdBefore = own(value, "createdBefore"), limit = own(value, "limit");
  if (typeof createdBefore !== "string" || !/^(?!0000)\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(createdBefore)
    || !Number.isFinite(Date.parse(createdBefore)) || new Date(createdBefore).toISOString() !== createdBefore
    || typeof limit !== "number" || !Number.isInteger(limit) || limit < 1 || limit > 1000) return refuseInput();
  const rawHolds = own(value, "holdOperationIds");
  if (!Array.isArray(rawHolds)) return refuseInput();
  const length = own(rawHolds, "length");
  if (typeof length !== "number" || length > 1000) return refuseInput();
  const holds: string[] = [];
  for (let i = 0; i < length; i++) holds.push(id(own(rawHolds, String(i))));
  if (new Set(holds).size !== holds.length) return refuseInput();
  return Object.freeze({ workspaceId, createdBefore, limit, holdOperationIds: Object.freeze(holds) });
}

/**
 * One current owning statement, bounded to one workspace and a stable oldest-first window.
 * No manifest, ciphertext, storage key or row identity is selected into the response.
 * This snapshot is not future cleanup authority: no archive, unlink, DELETE, phase or ledger write occurs.
 */
export async function previewRetention(sql: Sql, input: PlanArtifactRetentionPreviewInput): Promise<PlanArtifactRetentionPreview> {
  const c = retentionInput(input);
  const rows = await sql.query<{ protection: string }>(`with candidates as (
    select a.operation_id, a.created_at,
      a.created_at < $2::timestamptz and a.expires_at <= clock_timestamp() as elapsed,
      o.status, u.phase,
      a.operation_id = any($3::text[]) or exists (
        select 1 from platform.plan_artifact_associations r
        where r.workspace_id=$1 and r.source_operation_id=a.operation_id and r.operation_id=any($3::text[])
      ) as held,
      exists (
        select 1 from platform.plan_artifact_associations r
        left join platform.operations d on d.workspace_id=r.workspace_id and d.id=r.operation_id
        left join platform.plan_artifact_uses du on du.workspace_id=r.workspace_id and du.operation_id=r.operation_id
        where r.workspace_id=$1 and r.source_operation_id=a.operation_id
          and (d.id is null or du.operation_id is null or not (d.status=any($5::text[]))
            or du.phase not in ('ready','claimed','dispatched','succeeded','uncertain','expired'))
      ) as related_unavailable,
      exists (
        select 1 from platform.plan_artifact_associations r join platform.operations d
          on d.workspace_id=r.workspace_id and d.id=r.operation_id
        where r.workspace_id=$1 and r.source_operation_id=a.operation_id and not (d.status=any($6::text[]))
      ) as related_active,
      exists (
        select 1 from platform.plan_artifact_associations r join platform.operations d
          on d.workspace_id=r.workspace_id and d.id=r.operation_id
        join platform.plan_artifact_uses du on du.workspace_id=r.workspace_id and du.operation_id=r.operation_id
        where r.workspace_id=$1 and r.source_operation_id=a.operation_id
          and (d.status='uncertain' or du.phase in ('claimed','dispatched','uncertain'))
      ) or exists (
        select 1 from platform.workflow_start_intents s where s.workspace_id=$1 and s.phase='attempted'
          and (s.operation_id=a.operation_id or exists (select 1 from platform.plan_artifact_associations r
            where r.workspace_id=$1 and r.source_operation_id=a.operation_id and r.operation_id=s.operation_id))
      ) or exists (
        select 1 from platform.build_launches b where b.workspace_id=$1 and b.phase<>'terminal'
          and (b.operation_id=a.operation_id or exists (select 1 from platform.plan_artifact_associations r
            where r.workspace_id=$1 and r.source_operation_id=a.operation_id and r.operation_id=b.operation_id))
      ) as related_unresolved,
      exists (select 1 from platform.plan_artifact_associations r
        where r.workspace_id=$1 and r.source_operation_id=a.operation_id and r.expires_at > clock_timestamp()) as related_live
    from platform.plan_artifacts a
    left join platform.operations o on o.workspace_id=a.workspace_id and o.id=a.operation_id
    left join platform.plan_artifact_uses u on u.workspace_id=a.workspace_id and u.operation_id=a.operation_id
    where a.workspace_id=$1 order by a.created_at,a.operation_id limit $4::bigint
  ) select case
    when held then 'held'
    when status is null or phase is null or not (status=any($5::text[]))
      or phase not in ('ready','claimed','dispatched','succeeded','uncertain','expired') or related_unavailable then 'unavailable'
    when not (status=any($6::text[])) or related_active then 'active'
    when status='uncertain' or phase in ('claimed','dispatched','uncertain') or related_unresolved then 'unresolved'
    when not elapsed or related_live then 'withinRetention'
    else 'archiveReview' end as protection from candidates order by created_at,operation_id`,
    [c.workspaceId, c.createdBefore, textArray(c.holdOperationIds), c.limit + 1,
      textArray(["proposed", "awaiting_approval", "approved", "queued", "running", ...TERMINAL_OPERATION_STATUSES]),
      textArray(TERMINAL_OPERATION_STATUSES)]);
  const counts = { held: 0, active: 0, unresolved: 0, unavailable: 0, withinRetention: 0, archiveReview: 0 };
  for (const row of rows.slice(0, c.limit)) {
    if (!Object.hasOwn(counts, row.protection)) throw new ControlStoreError("db_error", "Plan retention preview is unavailable.");
    counts[row.protection as keyof typeof counts]++;
  }
  return Object.freeze({ mode: "dry-run", scanned: Math.min(rows.length, c.limit), hasMore: rows.length > c.limit, ...counts });
}
