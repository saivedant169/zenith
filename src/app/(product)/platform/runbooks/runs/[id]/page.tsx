/** One runbook run: exact effect diff against the previous version, bound approval, live progress, cancellation, uncertainty. */
import Link from "next/link";
import { Callout } from "@/components/ui/callout";
import { Chip } from "@/components/ui/chip";
import { DigestValue } from "@/components/platform/badges";
import { projectRunbookRun, runbookApprovalEligibility, type RunbookRunLike, type RunbookStepLike, type StepDiffRow } from "@/lib/platform/operator-journey";
import { JourneyLive } from "../../../_components/journey-live";
import { EvidenceNote, PageState } from "../../../_components/page-state";
import { loadRunbookRun } from "../../../_lib/loaders";
import { RunActions } from "./run-actions";
export const dynamic = "force-dynamic";

const KIND_WORD: Record<StepDiffRow["kind"], string> = { added: "Added", removed: "Removed", changed: "Changed", unchanged: "Unchanged" };
const argsText = (args: Record<string, unknown>) => { const t = JSON.stringify(args); return t.length > 400 ? `${t.slice(0, 400)}...` : t; };
type AuditRow = { seq: number; event: string; actor: string; createdAt: string };
type TargetRow = { transport: string; resourceId: string; targetId: string };

export default async function RunbookRunPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const result = await loadRunbookRun(id);
  if ("error" in result) return <PageState {...result} />;
  const { data, context } = result;
  const run = data.run as unknown as RunbookRunLike & { runbookId: string; version: number; definitionDigest: string; requester: { id: string; name: string; onBehalfOf?: string }; deadlineAt: string; maxParallelTargets: number };
  const steps = data.steps as unknown as RunbookStepLike[];
  const diff = data.diff as unknown as StepDiffRow[];
  const audit = data.audit as unknown as AuditRow[];
  const targets = data.targets as unknown as TargetRow[];
  const titles = Object.fromEntries(diff.map((r) => [r.id, r.step.title]));
  const view = projectRunbookRun(run, steps, titles);
  const eligibility = runbookApprovalEligibility({ status: run.status, viewerId: context.principal.id, viewerRole: context.role, requester: run.requester });
  const cls = data.classification;
  return <div className="space-y-5">
    <nav aria-label="Breadcrumb" className="text-[12.5px]"><Link className="text-signal hover:underline" href="/platform/runbooks">Runbooks</Link><span aria-hidden="true"> / </span><span aria-current="page">Run</span></nav>
    <h1 className="app-page-title">{data.name}, version {run.version}</h1><EvidenceNote />
    <JourneyLive workspaceId={context.workspaceId} target={{ kind: "runbook_run", runId: run.id, stepTitles: titles }} initial={view} heading="Run progress"
      actions={<RunActions workspaceId={context.workspaceId} runId={run.id} bindingDigest={run.bindingDigest} approve={eligibility} cancel={view.cancel} />} />

    <section aria-labelledby="effect-h" className="space-y-3 rounded-card border border-line bg-bg1 p-4">
      <h2 id="effect-h" className="text-[15px] font-medium text-ink">Exact effect</h2>
      <p className="text-[13px] text-ink-mute">Approval binds digest <DigestValue digest={run.bindingDigest} what="binding digest" />: this runbook version ({run.runbookId} v{run.version}, definition <DigestValue digest={run.definitionDigest} what="definition digest" />), these targets and these bounds. A different version, target set or bound needs its own approval.</p>
      {cls && <div className="flex flex-wrap gap-2"><Chip tone={cls.risk === "critical" || cls.risk === "high" ? "err" : cls.risk === "medium" ? "warn" : "ok"}>Risk: {cls.risk}</Chip>{cls.requiresApproval ? <Chip tone="warn">Needs an independent approver</Chip> : <Chip>Read-only</Chip>}</div>}
      {cls && cls.escapeHatchSteps.length > 0 && <Callout tone="err" title="Raw command steps">Steps {cls.escapeHatchSteps.join(", ")} run caller-supplied command lines. Zenith does not inspect them or treat them as safe: they are an approved high-risk escape hatch, never a sandbox.</Callout>}
      <p className="text-[12.5px] text-ink-mute">{data.hasPrevious ? `Compared with version ${run.version - 1}.` : "This is the first version, so every step is new."} Up to {run.maxParallelTargets} target(s) at once. Deadline <time dateTime={run.deadlineAt}>{run.deadlineAt}</time>.</p>
      <div className="overflow-x-auto" tabIndex={0} role="region" aria-label="Runbook steps"><table className="w-full min-w-[640px] text-left text-[13px]">
        <caption className="sr-only">Runbook steps and how they differ from the previous version</caption>
        <thead className="text-[12px] text-ink-mute"><tr><th scope="col" className="py-1 pr-3 font-medium">Change</th><th scope="col" className="py-1 pr-3 font-medium">Step</th><th scope="col" className="py-1 pr-3 font-medium">Operation</th><th scope="col" className="py-1 font-medium">Arguments</th></tr></thead>
        <tbody className="divide-y divide-line">{diff.map((r) => <tr key={r.id} className="align-top">
          <td className="py-2 pr-3"><Chip tone={r.kind === "added" ? "info" : r.kind === "removed" ? "err" : r.kind === "changed" ? "warn" : "neutral"}>{KIND_WORD[r.kind]}</Chip>{r.fields.length > 0 && <span className="block text-[12px] text-ink-mute">{r.fields.join(", ")}</span>}</td>
          <th scope="row" className="py-2 pr-3 font-normal">{r.step.title}<span className="block font-mono text-[12px] text-ink-mute">{r.id}</span></th>
          <td className="py-2 pr-3 font-mono text-[12px]">{r.step.operation}<span className="block text-ink-mute">on failure: {r.step.onFailure}, {r.step.timeoutSec}s</span></td>
          <td className="break-all py-2 font-mono text-[12px]">{argsText(r.step.args)}</td></tr>)}</tbody>
      </table></div>
      <h3 className="text-[13px] font-medium text-ink">Targets ({targets.length})</h3>
      <ul className="list-disc pl-5 text-[12.5px] text-ink-mute">{targets.map((t) => <li key={`${t.transport}:${t.targetId}`} className="break-all font-mono">{t.transport} / {t.resourceId} / {t.targetId}</li>)}</ul>
    </section>

    <section aria-labelledby="audit-h" className="space-y-2 rounded-card border border-line bg-bg1 p-4">
      <h2 id="audit-h" className="text-[15px] font-medium text-ink">Audit trail</h2>
      {audit.length === 0 ? <p className="text-[13px] text-ink-mute">No audit entries are recorded yet.</p> :
        <ol className="divide-y divide-line text-[13px]">{audit.map((a) => <li key={a.seq} className="flex flex-wrap justify-between gap-2 py-2"><span><span className="font-mono text-[12px]">{a.event}</span> by {a.actor}</span><time className="text-[12px] text-ink-faint" dateTime={a.createdAt}>{a.createdAt}</time></li>)}</ol>}
    </section>
  </div>;
}
