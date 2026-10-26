"use client";
/**
 * What this environment costs: what is running now, what the working copy
 * would make it, where the money goes, and the budget it is measured against.
 * Every number is an estimate from the price table and says so.
 */
import { useMemo, useState } from "react";
import { api } from "@/lib/client/api";
import { v1View } from "@/lib/resources/upgrade";
import { monthlyCostUsd, nodeMonthlyCostUsd } from "@/lib/cost/pricing";
import type { AnyManifest, Revision } from "@/lib/domain/types";
import { fmtUsd } from "@/lib/format";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Meter } from "@/components/ui/meter";
import { Sparkline } from "@/components/ui/sparkline";
import { Chip } from "@/components/ui/chip";
import { Skeleton } from "@/components/ui/skeleton";
import type { RevisionMeta } from "@/components/screens/project-data";
import { ErrorNote } from "@/components/screens/shared";
import { useAsync } from "@/components/screens/use-async";

export interface CostCardProps {
  working: AnyManifest;
  running: Revision | undefined;
  revisions: RevisionMeta[];
  budget: number | undefined;
  environmentName: string;
  deployed: boolean;
  runningLoading: boolean;
  runningError?: unknown;
}

export function CostCard({
  working,
  running,
  revisions,
  budget,
  environmentName,
  deployed,
  runningLoading,
  runningError,
}: CostCardProps) {
  const total = monthlyCostUsd(v1View(working));
  const deployedTotal = running ? monthlyCostUsd(v1View(running.manifest)) : undefined;
  const delta = deployedTotal === undefined ? 0 : Math.round((total - deployedTotal) * 100) / 100;

  const top = useMemo(() => {
    const costView = v1View(working);
    const nodes = [
      ...working.services.map((s) => ({ id: s.id, name: s.name, kind: s.kind })),
      ...working.resources.map((r) => ({ id: r.id, name: r.name, kind: r.kind })),
    ];
    return nodes
      .map((n) => ({ ...n, usd: nodeMonthlyCostUsd(costView, n.id) }))
      .sort((a, b) => b.usd - a.usd)
      .slice(0, 5);
  }, [working]);

  const pct = budget ? Math.round((total / budget) * 100) : 0;
  const tone = !budget ? "signal" : pct > 100 ? "err" : pct > 80 ? "warn" : "ok";

  return (
    <Card
      title="Cost & budget"
      subtitle="Monthly estimates from the price table."
      actions={<Chip tone="neutral">Estimate</Chip>}
    >
      {deployed && !running ? (
        <div className="space-y-2">
          {runningLoading ? <Skeleton height={36} width="65%" /> : <p className="text-[14px] text-ink">Deployed cost unavailable</p>}
          {!!runningError && <p className="text-[12px] text-warn">The deployed revision could not be read. Retry it above to compare costs.</p>}
          <p className="text-[13px] text-ink-mute">Working copy: <span className="tnum font-mono text-ink">{fmtUsd(total)}</span> / month estimated.</p>
        </div>
      ) : deployedTotal === undefined ? (
        <>
          <p className="tnum break-all font-mono text-[28px] leading-tight tracking-[-0.04em] text-ink">{fmtUsd(total)}</p>
          <p className="mt-1 text-[12.5px] text-ink-faint">
            est. per month for the working copy — nothing is deployed to {environmentName} yet
          </p>
        </>
      ) : (
        <>
          <p className="tnum break-all font-mono text-[28px] leading-tight tracking-[-0.04em] text-ink">
            {fmtUsd(deployedTotal)}
          </p>
          <p className="mt-1 text-[12.5px] text-ink-faint">
            est. per month running now — r{running?.number} in {environmentName}
          </p>
          <p className="mt-3 border-l-2 border-signal pl-3 text-[13px] text-ink-mute">
            {delta === 0
              ? "The working copy has the same estimated monthly cost."
              : `The working copy would make it an estimated ${fmtUsd(total)} —${delta > 0 ? "+" : "−"}${fmtUsd(Math.abs(delta))}/month once deployed.`}
          </p>
        </>
      )}

      <div className="mt-5 space-y-3">
        <h4 className="text-[13px] font-medium text-ink">
          Largest costs · working copy
        </h4>
        {top.length === 0 ? (
          <p className="text-[13px] text-ink-mute">Nothing in the system yet.</p>
        ) : (
          top.map((n) => (
            <Meter
              key={n.id}
              value={n.usd}
              max={top[0].usd || 1}
              tone="signal"
              label={`${n.name} · ${n.kind}`}
              hint={`${fmtUsd(n.usd)}/mo est.`}
            />
          ))
        )}
      </div>

      <RevisionCostTrend revisions={revisions} />

      <div className="mt-6 border-t border-line pt-4">
        <h4 className="text-[13px] font-medium text-ink">Working-copy budget</h4>
        {budget ? (
          <div className="mt-2">
            {/* The bar saturates at 100% — the percentage and the overage below
                it are what stay true at 150% and at 400%. */}
            <Meter
              value={total}
              max={budget}
              tone={tone}
              label={`${environmentName} budget`}
              hint={`${fmtUsd(total)} of ${fmtUsd(budget)} (${pct}%)`}
            />
            {pct > 80 && (
              <p className={`mt-2 text-[12.5px] ${pct > 100 ? "text-err" : "text-warn"}`}>
                {pct > 100
                  ? `${fmtUsd(total - budget)} over the ${fmtUsd(budget)} budget — ${pct}% of it. Resize a node, or raise the budget in Settings → Environments.`
                  : `${fmtUsd(budget - total)} remains within the ${fmtUsd(budget)} monthly budget. Review the cost delta before deploying.`}
              </p>
            )}
          </div>
        ) : (
          <p className="mt-2 text-[12.5px] text-ink-mute">
            No budget on {environmentName}. Set one in Settings → Environments to get warned
            before a plan gets expensive.
          </p>
        )}
      </div>
    </Card>
  );
}

const TREND_REVISIONS = 8;

/**
 * Estimated cost of the last few revisions, priced now. Each revision's
 * manifest is a separate request, so it is fetched when asked for rather than
 * on every visit to this page.
 */
function RevisionCostTrend({ revisions }: { revisions: RevisionMeta[] }) {
  const recent = useMemo(
    () => [...revisions].sort((a, b) => a.number - b.number).slice(-TREND_REVISIONS),
    [revisions]
  );
  const [series, setSeries] = useState<{ number: number; usd: number }[]>();
  const { busy, error, run } = useAsync<void>();

  const load = () =>
    run(async () => {
      const loaded = await Promise.all(
        recent.map((r) => api<{ revision: Revision }>(`/api/revisions/${r.id}`))
      );
      setSeries(
        loaded.map((l) => ({
          number: l.revision.number,
          usd: monthlyCostUsd(v1View(l.revision.manifest)),
        }))
      );
    });

  if (recent.length < 2) return null;

  return (
    <div className="mt-6 border-t border-line pt-4">
      <div className="flex items-center justify-between gap-3">
        <h4 className="text-[13px] font-medium text-ink">Across revisions</h4>
        {!series && (
          <Button size="sm" variant="quiet" busy={busy} onClick={load}>
            Price the last {recent.length}
          </Button>
        )}
      </div>
      {error ? <ErrorNote error={error} className="mt-2" /> : null}
      {series && (
        <div className="mt-2 space-y-2">
          <div className="flex items-center gap-3">
            <Sparkline
              points={series.map((s) => s.usd)}
              width={140}
              label={`Estimated monthly cost, r${series[0].number} to r${series[series.length - 1].number}`}
            />
            <span className="tnum text-[12.5px] text-ink">
              {fmtUsd(series[0].usd)} → {fmtUsd(series[series.length - 1].usd)}
            </span>
          </div>
          <p className="text-[11.5px] leading-relaxed text-ink-faint">
            r{series[0].number}–r{series[series.length - 1].number}, each priced with today&apos;s
            estimate table — not what anything was billed at the time.
          </p>
        </div>
      )}
    </div>
  );
}
