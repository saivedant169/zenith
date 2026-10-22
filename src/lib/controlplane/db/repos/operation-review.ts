/**
 * Additive ledger read metadata, without changing the operation/proposal contracts.
 * Round zero is the proposal; later rounds review the write-once plan digest.
 * Plan review comes only from tenant-scoped, non-simulated planning evidence.
 * This projection contains attribute names, never attribute or output values.
 */
import { z } from "zod";
import type { OperationRecord, Sql } from "@/lib/controlplane/types";
import type { PlanView } from "@/lib/tofu/plan";
import { redactOutput } from "@/lib/tofu/redact";
import { readExecutableSemantics, type ExecutableSemantics } from "@/lib/execution/semantics/digest";
import { containsRawPlanMaterial } from "@/lib/security/raw-plan-material";

const factText = z.string().max(500);
const text = factText.transform((s) => redactOutput(s).replace(/[\u0000-\u001f\u007f]/g, " "));
const count = z.number().int().min(0).max(1_000_000);
export const ReviewFactsSchema = z.object({
  create: count, update: count, delete: count, replace: count, destroysData: z.boolean(),
  destroyedStatefulAddresses: z.array(factText).max(10_000), regions: z.array(factText).max(1000),
  statefulDeletes: z.array(factText).max(10_000).optional(), dnsDeletes: z.array(factText).max(10_000).optional(),
  publicDatabases: z.array(factText).max(10_000),
  openIngress: z.array(z.object({ address: factText, port: factText, cidr: factText })).max(10_000),
  wildcardIam: z.array(factText).max(10_000), identityChanges: z.array(factText).max(10_000),
  firewallChanges: z.array(factText).max(10_000), dnsChanges: z.array(factText).max(10_000),
  unresolved: z.array(factText).max(10_000).optional(),
}).strict();
const action = z.enum(["create", "update", "delete", "replace", "no-op", "read"]);
export const ViewSchema = z.object({
  executableSourceDigest:z.string().regex(/^[a-f0-9]{64}$/).optional(),
  approvedSources:z.array(z.object({service:z.string().regex(/^(container_service|scheduled_job)\/[A-Za-z0-9_-][A-Za-z0-9_.-]{0,127}$/),commit:z.string().regex(/^[a-f0-9]{40}$/),
    dockerfileDigest:z.string().regex(/^[a-f0-9]{64}$/),recipeDigest:z.string().regex(/^[a-f0-9]{64}$/),archiveDigest:z.string().regex(/^[a-f0-9]{64}$/),archiveFormat:z.enum(["zip","tar.gz"])}).strict()).min(1).max(64).optional(),
  approvedSourcesTruncated:z.literal(true).optional(),approvedSourcesOmitted:count.optional(),
  planDigest: z.string().regex(/^[a-f0-9]{64}$/), tofuVersion: text, empty: z.boolean(),
  summary: z.object({ create: count, update: count, delete: count, replace: count, noop: count }),
  resources: z.array(z.object({
    address: text, nodeAddress: text.optional(), type: text, action, destroysData: z.boolean(),
    changes: z.array(z.object({ path: text, forcesReplacement: z.boolean(), sensitive: z.boolean().optional() })).max(50),
    omittedChanges: count,
  })).max(200),
  outputs: z.array(z.object({ name: text, action, sensitive: z.boolean() })).max(200),
  diagnostics: z.array(z.object({ severity: z.enum(["error", "warning"]), summary: text })).max(10),
  truncated: z.boolean(), untrustedValues: z.literal(true),
}).refine(v=> (!v.executableSourceDigest && !v.approvedSources && !v.approvedSourcesTruncated && v.approvedSourcesOmitted===undefined)
  || !!v.executableSourceDigest && !!v.approvedSources?.length && new Set(v.approvedSources.map(s=>s.service)).size===v.approvedSources.length
    && (v.approvedSourcesTruncated ? (v.approvedSourcesOmitted??0)>0 : v.approvedSourcesOmitted===undefined));
const CostSchema = z.object({ deltaUsdMonthly: z.number().finite().optional(), projectedMonthlyUsd: z.number().finite().optional(), catalogVersion: text.optional() });

export interface OperationPlanReview {
  planDigest: string;
  view: PlanView;
  facts: z.infer<typeof ReviewFactsSchema>;
  cost: z.infer<typeof CostSchema>;
  /** The canonical executable-semantics digest the reviewer is shown and an approval binds (PROD-DUR-03); absent for plans reviewed before it existed. */
  semantics?: ExecutableSemantics;
}
export interface ApprovalRoundMetadata { approvalRound: number }
export type ReviewedOperation = OperationRecord & ApprovalRoundMetadata & { planReview?: OperationPlanReview };

/** Missing round metadata is legacy proposal round zero, never a plan approval. */
export function approvalRoundOf(record: object): number {
  const n = (record as Partial<ApprovalRoundMetadata>).approvalRound;
  return typeof n === "number" && Number.isInteger(n) && n >= 0 ? n : 0;
}

export function operationPlanReview(record: OperationRecord): OperationPlanReview | undefined {
  const review = (record as Partial<ReviewedOperation>).planReview;
  // Page loaders may further bound stored records. Refuse a malformed or
  // truncated shape rather than enabling approval for an unreadable artifact.
  return review && record.planDigest ? projectPlanReview({ ...review, ...(review.view.executableSourceDigest?{executableSourceDigest:review.view.executableSourceDigest}:{}), stage: "plan" }, record.planDigest) : undefined;
}

export function projectPlanReview(summary: Record<string, unknown>, planDigest: string): OperationPlanReview | undefined {
  if (summary.stage !== "plan" || summary.planDigest !== planDigest) return undefined;
  // PROD-DUR-05: a stored summary carrying raw custody material is never a reviewable PlanView; fail closed.
  if (containsRawPlanMaterial(summary)) return undefined;
  const view = ViewSchema.safeParse(summary.view);
  const facts = ReviewFactsSchema.safeParse(summary.facts);
  if(view.success && (view.data.executableSourceDigest!==summary.executableSourceDigest || Buffer.byteLength(JSON.stringify(view.data))>40_000))return undefined;
  if (!view.success || !facts.success || view.data.planDigest !== planDigest) return undefined;
  const cost = CostSchema.safeParse(summary.cost);
  // A present but malformed semantics document makes the whole review unreadable; it is never silently dropped.
  const semantics = summary.semantics === undefined ? undefined : readExecutableSemantics(summary.semantics);
  if (summary.semantics !== undefined && !semantics) return undefined;
  const review = { planDigest, view: view.data as PlanView, facts: facts.data, cost: cost.success ? cost.data : {}, ...(semantics ? { semantics } : {}) };
  return Buffer.byteLength(JSON.stringify(review)) <= 60_000 ? review : undefined;
}

/** Read only the original gated plan, never a later final-plan artifact. */
export async function withPlanReview(sql: Sql, op: ReviewedOperation): Promise<ReviewedOperation> {
  if (!op.planDigest) return op;
  const rows = await sql.query<{ summary: Record<string, unknown> }>(
    `select summary from platform.evidence where workspace_id = $1 and operation_id = $2
       and kind = 'tofu_plan' and digest = $3 and simulated = false and summary->>'stage' = 'plan'
       order by created_at, id limit 1`, [op.workspaceId, op.id, op.planDigest]);
  const summary=rows[0]?.summary;
  const sourceFields=!!summary && (Object.hasOwn(summary,"executableSourceDigest") || !!summary.view && typeof summary.view==="object"
    && ["executableSourceDigest","approvedSources","approvedSourcesTruncated","approvedSourcesOmitted"].some(key=>Object.hasOwn(summary.view as object,key)));
  const review = summary ? projectPlanReview(summary, op.planDigest) : undefined;
  function unavailable():never{throw new Error("Approved source review is unavailable; reload the operation before deciding.");}
  try{
    // Migration 13 is mandatory for the current loader, including apparently
    // source-free views: stripping every evidence field cannot hide native rows.
    const native=await sql.query<{snapshot:unknown;snapshot_digest:string}>("select snapshot,snapshot_digest from platform.approved_source_snapshots where workspace_id=$1 and operation_id=$2 order by service_address",[op.workspaceId,op.id]);
    if(sourceFields || native.length){
      if(!review?.view.executableSourceDigest || !op.projectId || !op.environmentId)unavailable();
      const {immutableSourceSnapshot,sourceSnapshotDigest,sourceSnapshotSetDigest}=await import("@/lib/execution/source-snapshot");
      const sources=native.map(row=>{const s=immutableSourceSnapshot(row.snapshot);
        if(s.workspaceId!==op.workspaceId || s.operationId!==op.id || s.projectId!==op.projectId || s.environmentId!==op.environmentId || sourceSnapshotDigest(s)!==row.snapshot_digest)unavailable();return s;
      }).sort((a,b)=>a.serviceAddress<b.serviceAddress?-1:a.serviceAddress>b.serviceAddress?1:0);
      if(!sources.length || sourceSnapshotSetDigest(sources)!==review.view.executableSourceDigest)unavailable();
      const displayed=sources.slice(0,64).map(s=>({service:s.serviceAddress,commit:s.commitSha,dockerfileDigest:s.dockerfileDigest,recipeDigest:s.recipeDigest,archiveDigest:s.archiveDigest,archiveFormat:s.archiveFormat}));
      if(JSON.stringify(displayed)!==JSON.stringify(review.view.approvedSources)
        || review.view.approvedSourcesTruncated!==(sources.length>64?true:undefined)
        || review.view.approvedSourcesOmitted!==(sources.length>64?sources.length-64:undefined))unavailable();
    }
  }catch{unavailable();}
  return review ? { ...op, planReview: review } : op;
}
