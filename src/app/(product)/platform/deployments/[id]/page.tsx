/** A legacy product deployment through the same journey projection as a platform operation. */
import Link from "next/link";
import { JourneyLive } from "../../_components/journey-live";
import { EvidenceNote, PageState } from "../../_components/page-state";
import { loadDeployment } from "../../_lib/loaders";
import { projectLegacyDeployment, type LegacyDeploymentLike } from "@/lib/platform/operator-journey";
import { LegacyCancel } from "./legacy-cancel";
export const dynamic = "force-dynamic";
export default async function DeploymentPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const result = await loadDeployment(id);
  if ("error" in result) return <PageState {...result} />;
  const { data, context } = result;
  const dep = data.deployment as unknown as LegacyDeploymentLike & { changeSummary?: string; createdAt: string };
  const view = projectLegacyDeployment(dep, data.linked);
  return <div className="space-y-5"><h1 className="app-page-title">Deployment</h1><EvidenceNote />
    {dep.changeSummary && <p className="text-[13px] text-ink-mute">{dep.changeSummary}</p>}
    <JourneyLive workspaceId={context.workspaceId} target={{ kind: "legacy_deployment", deploymentId: dep.id, operationId: dep.operationId }} initial={view} />
    {dep.executor !== "workflow" && view.cancel.available && <LegacyCancel deploymentId={dep.id} canCancel={context.role === "editor" || context.role === "admin"} />}
    {dep.operationId && <p className="text-[13px] text-ink-mute">The control plane records this deployment as an operation. <Link className="text-signal underline" href={`/platform/operations/${encodeURIComponent(dep.operationId)}`}>Review its plan, approvals and timeline</Link>.</p>}
  </div>;
}
