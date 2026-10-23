import type { NormalizeResult } from "./types";

export interface DerivedPriceRule {
  sku: string;
  components: readonly { sku: string; quantity: number }[];
  note: string;
}

/** Composite shapes require every component from the same checked snapshot. */
export function derivePrices(result: NormalizeResult, rules: readonly DerivedPriceRule[], regions: readonly string[]): NormalizeResult {
  const internal = new Set(rules.flatMap(r => r.components.map(c => c.sku)).filter(s => s.startsWith("component.")));
  const observations = result.observations.filter(o => !internal.has(o.sku));
  const skipped = result.skipped.filter(o => !internal.has(o.sku));
  for (const region of regions) for (const rule of rules) {
    const parts = rule.components.map(c => ({ ...c, observation: result.observations.find(o => o.region === region && o.sku === c.sku) }));
    const missing = parts.filter(p => !p.observation);
    if (missing.length) {
      skipped.push({ sku: rule.sku, region, reason: `missing or ambiguous component: ${missing.map(p => p.sku).join(", ")}` });
      continue;
    }
    const first = parts[0]!.observation!;
    if (parts.some(p => p.observation!.snapshotSha256 !== first.snapshotSha256 || p.observation!.unit !== first.unit || p.observation!.tiers)) {
      skipped.push({ sku: rule.sku, region, reason: "components must be untiered prices in one unit from one snapshot" });
      continue;
    }
    observations.push({ ...first, sku: rule.sku, usd: parts.reduce((sum, p) => sum + p.quantity * p.observation!.usd, 0),
      note: `${rule.note}; ${parts.map(p => `${p.quantity} × ${p.sku}`).join(" + ")} (checked official snapshot)` });
  }
  return { observations, skipped };
}
