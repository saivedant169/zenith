/** An authorized operation, its recorded evidence and its browser-only decision controls. */
import { OperationTimeline } from "@/components/platform/operation-timeline";
import { PlanChangesTable } from "@/components/platform/plan-changes-table";
import { PolicyDecisionPanel } from "@/components/platform/policy-decision-panel";
import { CostEstimateCard } from "@/components/platform/cost-estimate-card";
import { Callout } from "@/components/ui/callout";
import { loadOperation } from "../../_lib/loaders";
import { EvidenceNote, PageState } from "../../_components/page-state";
import { OperationActions } from "./operation-actions";
import { EffectsActions } from "./effects-actions";
import Link from "next/link";
import { OwnershipTransferReview } from "@/components/platform/ownership-transfer-review";
import { ownershipTransferRows, ownershipWarnings, projectPlatformOperation } from "@/lib/platform/operator-journey";
import { JourneyLive } from "../../_components/journey-live";
import { operationPlanReview } from "@/lib/controlplane/db/repos/operation-review";
export const dynamic = "force-dynamic";
export default async function OperationPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const result = await loadOperation(id);
  if ("error" in result) return <PageState {...result} />;
  const { data, context } = result;
  // Loader data from an older shape (or an isolated page test) may carry no ledger rows.
  const effects = data.effects ?? [];
  const review = operationPlanReview(data.operation);
  const journey = projectPlatformOperation({ ...data.operation, effects });
  const transfers = ownershipTransferRows(data.operation.proposal);
  return <div className="space-y-5"><h1 className="app-page-title">Operation details</h1><EvidenceNote />
    <JourneyLive key={effects.map((e) => `${e.effectId}:${e.version}`).join(",")} workspaceId={context.workspaceId} target={{ kind: "platform_operation", operationId: data.operation.id }} initial={journey} effects={effects} />
    <EffectsActions effects={effects} viewerRole={context.role} workspaceId={context.workspaceId} />
    {data.linkedDeploymentId && <p className="text-[13px] text-ink-mute">This operation is also shown as a deployment: <Link className="text-signal underline" href={`/platform/deployments/${encodeURIComponent(data.linkedDeploymentId)}`}>open the deployment view</Link>. Both views read the same state.</p>}
    <OwnershipTransferReview transfers={transfers} warnings={ownershipWarnings(data.operation.proposal)} proposalDigest={data.operation.proposalDigest} />
    <OperationActions key={`${data.operation.updatedAt}:${data.approvals.map((a) => a.id).join(",")}`} operation={data.operation} decision={data.decision} approvals={data.approvals} viewer={{ id: context.principal.id, role: context.role, reviewedDigest: data.operation.proposalDigest }} workspaceId={context.workspaceId} plan={review?.view} semanticsDigest={review?.semantics?.digest} planCostDeltaUsd={review ? review.cost.deltaUsdMonthly ?? null : undefined} />
    <OperationTimeline events={data.events} operation={data.operation} />
    {data.timelineTruncated && <Callout tone="info">Showing the first 500 recorded events. More events may exist.</Callout>}
    <PolicyDecisionPanel decision={data.decision} />
    <PlanChangesTable plan={review?.view} />
    {data.operation.planDigest && !review && <Callout tone="info">This operation is bound to plan digest <code>{data.operation.planDigest}</code>. Its recorded plan is unavailable for review; approval is disabled until the planning evidence is restored.</Callout>}
    <CostEstimateCard estimate={data.estimate} />
  </div>;
}
