"use client";
import { useEffect, useState } from "react";
import { Card } from "@/components/ui/card";
import type { BillingView } from "@/lib/billing/service";
import type { PackageDisplay } from "@/lib/billing/plans";

type View = BillingView | { mode: "disabled"; managedTier: string; managedTierSource: "operator_configuration"; message: string };

/** Enterprise is "Talk to sales": plain text, because the app has no sales or contact link in its configuration. */
function PackageTable({ view }: { view: BillingView }) {
  return <div className="overflow-x-auto" tabIndex={0} role="region" aria-label="Zenith packages compared">
    <table className="w-full min-w-[720px] text-left text-[13px]">
      <caption className="sr-only">Zenith packages compared</caption>
      <thead className="text-[12px] text-ink-mute"><tr>
        <th scope="col" className="py-1 pr-3 font-medium"><span className="sr-only">Feature</span></th>
        {view.packages.map((p) => <th key={p.id} scope="col" className="py-1 pr-3 font-medium">{p.name}{p.id === view.plan.id ? " (current plan)" : ""}</th>)}
      </tr></thead>
      <tbody className="divide-y divide-line">{view.packageRows.map((row) => <tr key={row.key} className="align-top">
        <th scope="row" className="py-2 pr-3 font-medium">{row.label}</th>
        {view.packages.map((p) => <td key={p.id} className="py-2 pr-3">{p.display[row.key as keyof PackageDisplay]}</td>)}
      </tr>)}</tbody>
      <tfoot><tr><th scope="row" className="py-2 pr-3 font-medium">Get started</th>
        {view.packages.map((p) => <td key={p.id} className="py-2 pr-3 text-ink-mute">{p.pricing.kind === "contract" ? "Talk to sales" : p.id === view.plan.id ? "Your current plan" : ""}</td>)}
      </tr></tfoot>
    </table>
  </div>;
}

export function BillingSection({ workspaceId }: { workspaceId: string }) {
  const [view, setView] = useState<View | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    const abort = new AbortController();
    fetch("/api/platform/v1/billing", { signal: abort.signal, cache: "no-store" }).then(async r => {
      if (!r.ok) throw new Error("unavailable");
      setView(await r.json() as View);
    }).catch(() => { if (!abort.signal.aborted) setFailed(true); });
    return () => abort.abort();
  }, [workspaceId]);
  return <Card><h3>Managed hosting tier</h3>
    {failed ? <p role="alert">Billing state is unavailable. New provisioning work requires a known assignment; existing workloads, reads and export remain available.</p> : !view ? <p>Loading tier assignment…</p> : view.mode === "disabled" ?
      <><p>Billing is disabled. Hosting tier: <strong>{view.managedTier}</strong>, selected by operator configuration.</p><p>{view.message}</p></> :
      <><p>Current plan: <strong>{view.plan.name}</strong>. Hosting tier: <strong>{view.managedTier ?? "Unknown"}</strong>. Source: {view.managedTierSource === "billing_assignment" ? "workspace billing assignment" : "assignment required"}.</p>
      <p>{view.zcuDefinition} Build minutes and storage are included in the plan and never billed separately.</p>
      <PackageTable view={view} />
      <p>{view.notice}</p><p>Standing: {view.account?.status ?? "unassigned"}. {view.whatSuspensionMeans}</p><p>Tier changes govern new reviewed work. Downgrades preserve running workloads and stored data.</p></>}
  </Card>;
}
