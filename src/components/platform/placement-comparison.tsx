"use client";
/**
 * The placement solver's chosen option beside its alternatives, and why the rest
 * were ruled out (spec §29, §30, ADR-0013).
 *
 * The solver is deterministic: the model turns words into constraints, the solver
 * chooses. This view only lays the result out:
 *  - every cost is an estimate and is labelled as one, with the catalog version;
 *  - a candidate whose price rests on weak evidence says so in its column, and its
 *    per-line detail (behind a disclosure) flags each weak line;
 *  - latency is an estimate from a latency table, not a measurement;
 *  - cross-cloud and cross-region traffic is listed with its own cost and added
 *    delay, because it is exactly what a cheaper-looking option tends to hide;
 *  - rejected options list their reasons; nothing is silently dropped;
 *  - the score is shown as the solver's penalty (lower is better) with its parts.
 */
import { Scale } from "lucide-react";
import type { PlacementCandidate, PlacementResult } from "@/lib/placement/types";
import type { FeasibilityReport } from "@/lib/placement/feasibility";
import { fmtUsd } from "@/lib/format";
import { Callout } from "@/components/ui/callout";
import { Card } from "@/components/ui/card";
import { Chip } from "@/components/ui/chip";
import { EmptyState } from "@/components/ui/empty-state";
import { SurfaceGate, type AsyncSurfaceProps } from "./async-gate";
import { Disclosure } from "./badges";
import { CostEstimateBody } from "./cost-estimate-card";
import { PROVIDER_LABEL } from "./labels";
import { summarizeWeakEvidence } from "./price-evidence";
import { humanizeToken, plural } from "./text";

/** A candidate as the contract defines it, plus the additive fields the solver may set. */
export type ComparedCandidate = PlacementCandidate & {
  topology?: "single_region" | "multi_region" | "cross_cloud";
};

export interface PlacementComparisonProps extends AsyncSurfaceProps {
  result?: Omit<PlacementResult, "chosen" | "alternatives"> & {
    chosen?: ComparedCandidate;
    alternatives: ComparedCandidate[];
  };
  title?: string;
  /** why nothing fits, when nothing does: binding blockers, the nearest budget miss and what to change */
  feasibility?: FeasibilityReport;
}

const TOPOLOGY: Record<NonNullable<ComparedCandidate["topology"]>, string> = {
  single_region: "One region",
  multi_region: "Several regions",
  cross_cloud: "Across clouds",
};

const providerName = (p: string): string => (p in PROVIDER_LABEL ? PROVIDER_LABEL[p as keyof typeof PROVIDER_LABEL] : humanizeToken(p));

/** "AWS ap-south-1" or "AWS ap-south-1 + Azure centralindia": what a reader recognises, not the candidate id. */
export function candidateLabel(c: Pick<PlacementCandidate, "assignments">): string {
  const places = new Set<string>();
  for (const a of Object.values(c.assignments)) places.add(`${providerName(a.provider)} ${a.region}`);
  return [...places].sort().join(" + ") || "No assignments";
}

function Latency({ c }: { c: PlacementCandidate }) {
  const entries = Object.entries(c.latencyMs);
  if (entries.length === 0) return <span className="text-ink-mute">No latency estimate</span>;
  return (
    <ul className="tnum space-y-0.5">
      {entries.map(([region, ms]) => (
        <li key={region}>
          <span className="text-ink-mute">{humanizeToken(region)}</span> <span className="font-mono">{Math.round(ms)} ms</span>
        </li>
      ))}
    </ul>
  );
}

export function PlacementComparison({ result, title = "Placement options", loading, error, onRetry, feasibility }: PlacementComparisonProps) {
  const candidates: { candidate: ComparedCandidate; chosen: boolean }[] = result
    ? [
        ...(result.chosen ? [{ candidate: result.chosen, chosen: true }] : []),
        ...result.alternatives.map((candidate) => ({ candidate, chosen: false })),
      ]
    : [];
  const components = [...new Set(candidates.flatMap((x) => Object.keys(x.candidate.assignments)))].sort();

  return (
    <Card
      title={title}
      subtitle="Zenith's solver picks by fixed rules from your constraints. Costs are estimates, latencies are estimated from a table, and a budget is a planning limit on estimates, not a cap on what your cloud bills."
    >
      <SurfaceGate loading={loading} error={error} onRetry={onRetry} what="placement options" rows={4}>
        {!result ? (
          <EmptyState
            icon={<Scale className="h-5 w-5" aria-hidden="true" />}
            title="No placement result yet"
            body="Describe where your users are and what you need, and Zenith will compare the options that fit."
          />
        ) : (
          <div className="space-y-6">
            {candidates.length === 0 ? (
              <Callout tone="warn" title="No placement meets every constraint">
                Zenith found no option that satisfies all of your constraints, so it is not recommending one.
                {result.rejected.length > 0 ? " The reasons each option was ruled out are listed below." : ""}
                {feasibility && !feasibility.feasible && feasibility.blockers.length > 0 && (
                  <ul className="mt-2 list-disc space-y-1 pl-5">
                    {feasibility.blockers.map((b) => (
                      <li key={b.kind}>{b.message}</li>
                    ))}
                  </ul>
                )}
                {feasibility?.budget?.cheapestOtherwiseFeasibleUsdMonthly !== undefined && (
                  <p className="mt-2">
                    The cheapest option that meets everything else is estimated at {fmtUsd(feasibility.budget.cheapestOtherwiseFeasibleUsdMonthly)} a month, {fmtUsd(feasibility.budget.shortfallUsdMonthly ?? 0)} over
                    your {fmtUsd(feasibility.budget.limitUsdMonthly)} budget. {feasibility.budget.notice}
                  </p>
                )}
                {feasibility && feasibility.remedies.length > 0 && <p className="mt-2">{feasibility.remedies.join(" ")}</p>}
              </Callout>
            ) : (
              <div className="overflow-x-auto" tabIndex={0} role="region" aria-label="Placement options compared">
                <table className="w-full min-w-[520px] border-collapse text-left">
                  <caption className="sr-only">Placement options compared</caption>
                  <thead>
                    <tr>
                      <th scope="col" className="py-2 pr-4 text-left"><span className="sr-only">Comparison</span></th>
                      {candidates.map(({ candidate, chosen }) => (
                        <th key={candidate.id} scope="col" className="min-w-[180px] py-2 pr-4 align-bottom font-normal">
                          <div className="flex flex-wrap items-center gap-1.5">
                            <span className="text-[13px] font-medium text-ink">{candidateLabel(candidate)}</span>
                            {chosen && <Chip tone="signal">Chosen</Chip>}
                          </div>
                          {candidate.topology && <div className="text-[12px] text-ink-faint">{TOPOLOGY[candidate.topology]}</div>}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    <tr className="border-t border-line align-top">
                      <th scope="row" className="py-2.5 pr-4 text-left text-[12.5px] font-medium text-ink-mute">
                        Monthly estimate
                      </th>
                      {candidates.map(({ candidate }) => {
                        const weak = summarizeWeakEvidence(candidate.cost);
                        return (
                          <td key={candidate.id} className="py-2.5 pr-4">
                            <div className="tnum font-mono text-[14px] text-ink">{fmtUsd(candidate.cost.monthlyUsd)}</div>
                            <div className="text-[12px] text-ink-faint">estimate · catalog {candidate.cost.catalogVersion}</div>
                            {weak.weak > 0 && (
                              <Chip tone="warn" className="mt-1" title="Some prices behind this estimate were not read from a price feed.">
                                {plural(weak.weak, "weak price")}
                              </Chip>
                            )}
                          </td>
                        );
                      })}
                    </tr>
                    {components.map((comp) => (
                      <tr key={comp} className="border-t border-line align-top">
                        <th scope="row" className="py-2.5 pr-4 text-left text-[12.5px] font-normal text-ink-mute">
                          <span className="font-mono">{comp}</span> runs on
                        </th>
                        {candidates.map(({ candidate }) => {
                          const a = candidate.assignments[comp];
                          return (
                            <td key={candidate.id} className="py-2.5 pr-4 text-[13px]">
                              {a ? (
                                <>
                                  {providerName(a.provider)} <span className="font-mono text-[12px]">{a.region}</span>
                                  <div className="font-mono text-[11.5px] text-ink-faint">{a.nativeType}</div>
                                </>
                              ) : (
                                <span className="text-ink-mute">Not placed in this option</span>
                              )}
                            </td>
                          );
                        })}
                      </tr>
                    ))}
                    <tr className="border-t border-line align-top">
                      <th scope="row" className="py-2.5 pr-4 text-left text-[12.5px] font-medium text-ink-mute">
                        Latency (p95, estimated)
                      </th>
                      {candidates.map(({ candidate }) => (
                        <td key={candidate.id} className="py-2.5 pr-4 text-[13px]">
                          <Latency c={candidate} />
                        </td>
                      ))}
                    </tr>
                    <tr className="border-t border-line align-top">
                      <th scope="row" className="py-2.5 pr-4 text-left text-[12.5px] font-medium text-ink-mute">
                        Traffic between regions or clouds
                      </th>
                      {candidates.map(({ candidate }) => (
                        <td key={candidate.id} className="py-2.5 pr-4 text-[12.5px]">
                          {candidate.crossBoundary.length === 0 ? (
                            <span className="text-ink-mute">None</span>
                          ) : (
                            <ul className="space-y-1">
                              {candidate.crossBoundary.map((x, i) => (
                                <li key={`${x.from}-${x.to}-${i}`}>
                                  <span className="font-mono text-[12px]">
                                    {x.from} → {x.to}
                                  </span>
                                  <div className="tnum text-ink-mute">
                                    {x.kind === "cross_cloud" ? "Across clouds" : "Across regions"} · {fmtUsd(x.egressUsdMonthly)}/mo estimate · +
                                    {Math.round(x.addedLatencyMs)} ms
                                  </div>
                                </li>
                              ))}
                            </ul>
                          )}
                        </td>
                      ))}
                    </tr>
                    <tr className="border-t border-line align-top">
                      <th scope="row" className="py-2.5 pr-4 text-left text-[12.5px] font-medium text-ink-mute">
                        Solver score (lower is better)
                      </th>
                      {candidates.map(({ candidate }) => (
                        <td key={candidate.id} className="py-2.5 pr-4 text-[13px]">
                          <span className="tnum font-mono">{Number.isFinite(candidate.score) ? candidate.score.toFixed(2) : "unavailable"}</span>
                          {Object.keys(candidate.scoreBreakdown).length > 0 && (
                            <Disclosure summary="Parts of the score" className="mt-1">
                              <dl className="tnum grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-[12px]">
                                {Object.entries(candidate.scoreBreakdown).map(([k, v]) => (
                                  <div key={k} className="contents">
                                    <dt className="text-ink-mute">{humanizeToken(k)}</dt>
                                    <dd className="font-mono text-ink">{Number.isFinite(v) ? v.toFixed(2) : "n/a"}</dd>
                                  </div>
                                ))}
                              </dl>
                            </Disclosure>
                          )}
                        </td>
                      ))}
                    </tr>
                    <tr className="border-t border-line align-top">
                      <th scope="row" className="py-2.5 pr-4 text-left text-[12.5px] font-medium text-ink-mute">
                        Warnings
                      </th>
                      {candidates.map(({ candidate }) => (
                        <td key={candidate.id} className="py-2.5 pr-4 text-[12.5px]">
                          {candidate.warnings.length === 0 ? (
                            <span className="text-ink-mute">None</span>
                          ) : (
                            <ul className="list-disc space-y-0.5 pl-4 text-warn">
                              {candidate.warnings.map((w, i) => (
                                <li key={i}>{w}</li>
                              ))}
                            </ul>
                          )}
                        </td>
                      ))}
                    </tr>
                  </tbody>
                </table>
              </div>
            )}

            {candidates.length > 0 && (
              <section aria-label="Price details" className="space-y-2">
                <h4 className="text-[13px] font-medium text-ink-mute">Estimate details per option</h4>
                {candidates.map(({ candidate, chosen }) => (
                  <Disclosure key={candidate.id} summary={`${candidateLabel(candidate)}${chosen ? " (chosen)" : ""}: price lines`}>
                    <CostEstimateBody estimate={candidate.cost} />
                  </Disclosure>
                ))}
              </section>
            )}

            {result.rejected.length > 0 && (
              <section aria-label="Ruled out" className="space-y-2">
                <h4 className="text-[13px] font-medium text-ink-mute">Ruled out · {result.rejected.length}</h4>
                <ul className="divide-y divide-line rounded-card border border-line">
                  {result.rejected.map((r) => (
                    <li key={r.id} className="space-y-1 px-4 py-2.5">
                      <div className="font-mono text-[12.5px] text-ink">{r.id}</div>
                      {r.reasons.length === 0 ? (
                        <p className="text-[12.5px] text-ink-mute">No reason was recorded.</p>
                      ) : (
                        <ul className="list-disc space-y-0.5 pl-5 text-[13px] text-ink">
                          {r.reasons.map((reason, i) => (
                            <li key={i}>{reason}</li>
                          ))}
                        </ul>
                      )}
                    </li>
                  ))}
                </ul>
              </section>
            )}

            {result.assumptions.length > 0 && (
              <section aria-label="Assumptions" className="space-y-1.5">
                <h4 className="text-[13px] font-medium text-ink-mute">What the solver assumed</h4>
                <ul className="list-disc space-y-0.5 pl-5 text-[13px] text-ink">
                  {result.assumptions.map((a, i) => (
                    <li key={i}>{a}</li>
                  ))}
                </ul>
              </section>
            )}

            <p className="flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-line pt-3 text-[12px] text-ink-faint">
              <span>Price catalog {result.catalogVersion}</span>
              <span>
                Same inputs give the same answer (seed <code className="font-mono">{result.deterministicSeed}</code>)
              </span>
            </p>
          </div>
        )}
      </SurfaceGate>
    </Card>
  );
}
