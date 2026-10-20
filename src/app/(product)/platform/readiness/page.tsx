/** Can this install really run changes on a real cloud? One answer per provider, with the fix for every missing piece. */
import Link from "next/link";
import { Callout } from "@/components/ui/callout";
import { Chip } from "@/components/ui/chip";
import { PROVIDER_LABEL } from "@/components/platform/labels";
import { humanizeToken } from "@/components/platform/text";
import { EvidenceNote, PageState } from "../_components/page-state";
import { loadReadiness, type Search } from "../_lib/loaders";
export const dynamic = "force-dynamic";

export default async function ReadinessPage({ searchParams }: { searchParams: Promise<Search> }) {
  const result = await loadReadiness(await searchParams);
  if ("error" in result) return <PageState {...result} />;
  const { data } = result;
  const label = (p: string) => (PROVIDER_LABEL as Record<string, string>)[p] ?? p;
  return <div className="space-y-5">
    <h1 className="app-page-title">Readiness</h1><EvidenceNote />
    <form action="/platform/readiness" className="flex flex-wrap items-end gap-4">
      <label className="text-[13px]">Provider<select name="provider" defaultValue={data.selected} className="ml-2 rounded-ctl border border-line bg-bg1 p-2">{data.providers.map((p) => <option key={p} value={p}>{label(p)}</option>)}</select></label>
      <button className="rounded-ctl bg-signal px-4 py-2 text-[13px] text-on-signal">Check readiness</button>
    </form>
    {!data.visible || !data.readiness ? <Callout tone="info" title="Readiness is shown to editors and admins">The checks name configuration of this install. Ask a workspace editor or admin to review them.</Callout> : <>
      <section aria-labelledby="ready-h" className="space-y-3">
        <h2 id="ready-h" className="flex flex-wrap items-center gap-2 text-[15px] font-medium text-ink">{label(data.readiness.provider)} <Chip tone={data.readiness.ready ? "ok" : "warn"}>{data.readiness.ready ? "Prerequisites present" : "Not ready"}</Chip></h2>
        <p className="text-[13px] text-ink-mute">Checked <time dateTime={data.readiness.checkedAt}>{data.readiness.checkedAt}</time>. Prerequisites existing is not proof of a working deploy: nothing here has been exercised against a real account, and a reachable Temporal server does not prove a worker is polling.</p>
        {!data.readiness.ready && <Callout tone="warn" title="Real changes stay in Preview until every check passes">Plans and exports still work. Applying to this provider is not offered until the items below are fixed.</Callout>}
        <div className="overflow-x-auto" tabIndex={0} role="region" aria-label="Execution plane prerequisites"><table className="w-full min-w-[640px] text-left text-[13px]">
          <caption className="sr-only">Execution plane prerequisites for {label(data.readiness.provider)}</caption>
          <thead className="text-[12px] text-ink-mute"><tr><th scope="col" className="py-1 pr-3 font-medium">Check</th><th scope="col" className="py-1 pr-3 font-medium">Result</th><th scope="col" className="py-1 pr-3 font-medium">What was observed</th><th scope="col" className="py-1 font-medium">What to do</th></tr></thead>
          <tbody className="divide-y divide-line">{data.readiness.checks.map((c) => <tr key={c.id} className="align-top">
            <th scope="row" className="py-2 pr-3 font-normal">{humanizeToken(c.id)}</th>
            <td className="py-2 pr-3"><Chip tone={c.ok ? "ok" : "err"}>{c.ok ? "Passed" : "Missing"}</Chip></td>
            <td className="py-2 pr-3 text-ink-mute">{c.detail}</td>
            <td className="py-2 text-ink-mute">{c.fix}</td></tr>)}</tbody>
        </table></div>
      </section>
      <p className="text-[13px] text-ink-mute">Cloud connections are managed on the <Link className="text-signal underline" href="/platform/connections">connections</Link> pages; the guided AWS setup is at <Link className="text-signal hover:underline" href="/platform/connections/aws">Connect AWS</Link>.</p>
    </>}
  </div>;
}
