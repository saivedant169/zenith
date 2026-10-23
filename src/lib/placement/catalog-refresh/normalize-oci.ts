/**
 * OCI public price list normalizer. Input: the JSON from
 * `https://apexapps.oracle.com/pls/apex/cetools/api/v1/products/?currencyCode=USD`
 * (an object with `items`), saved with its checksum. OCI list prices are the
 * same in every commercial region, so each observation is emitted for every
 * region in `ctx.regions`. Only `PAY_AS_YOU_GO` prices in USD are read;
 * `rangeMin` gives volume tiers.
 *
 * Same rules as the other normalizers: unit-checked (via the metric name),
 * never guesses, ambiguity and absence become `skipped`. Tested against
 * recorded fixtures shaped like the official response, not the live API.
 */
import { buildTiered, resolveCandidates, toNumber, type Dimension, type Priced } from "@/lib/placement/catalog-refresh/common";
import type { Normalizer, PriceObservation, Skipped } from "@/lib/placement/catalog-refresh/types";
import type { PriceEntry } from "@/lib/placement/types";
import { derivePrices, type DerivedPriceRule } from "./derived";

interface OciItem {
  partNumber?: string;
  displayName?: string;
  metricName?: string;
  serviceCategory?: string;
  currencyCodeLocalizations?: { currencyCode?: string; prices?: { model?: string; value?: number | string; rangeMin?: number | string }[] }[];
}

interface OciRule {
  sku: string;
  unit: PriceEntry["unit"];
  display: RegExp;
  metric: RegExp;
  scale?: number;
  pick: "tiers" | "first_paid";
  note: string;
}

export const OCI_RULES: readonly OciRule[] = [
  { sku: "component.oci.e4.cpu", unit: "hour", display: /^(?:Oracle Cloud Infrastructure - |OCI )?Compute - Standard - E4(?: - OCPU)?$/i, metric: /^OCPU Per Hour$/i, pick: "first_paid", note: "Standard E4 OCPU-hour" },
  { sku: "component.oci.e4.memory", unit: "hour", display: /^(?:Oracle Cloud Infrastructure - |OCI )?Compute - Standard - E4 - Memory$/i, metric: /^(?:GB|Gigabyte) Per Hour$/i, pick: "first_paid", note: "Standard E4 memory GB-hour" },
  { sku: "component.oci.pg.cpu", unit: "hour", display: /^(?:Oracle Cloud Infrastructure |OCI )?Database with PostgreSQL(?: - Compute| - X86)?$/i, metric: /^OCPU Per Hour$/i, pick: "first_paid", note: "Database with PostgreSQL X86 OCPU-hour; optional additional memory/VPU fees are not included" },
  { sku: "oci.postgres.storage_gb_month", unit: "gb_month", display: /Database (?:with PostgreSQL - |Optimized )Storage/i, metric: /^(?:GB|Gigabyte) Storage Capacity Per Month$/i, pick: "first_paid", note: "PostgreSQL database optimized storage" },
  {
    sku: "oci.network.internet_gb",
    unit: "gb",
    display: /Outbound Data Transfer/i,
    metric: /Gigabyte Outbound Data Transfer Per Month/i,
    pick: "tiers",
    note: "Outbound data transfer; first paid tier from 0 GB (the monthly free allowance is not deducted), provider volume tiers from their cumulative boundaries",
  },
  { sku: "oci.object_storage.storage_gb_month", unit: "gb_month", display: /Object Storage - Storage/i, metric: /^(?:GB|Gigabyte) Storage Capacity Per Month$/i, pick: "first_paid", note: "Object Storage standard storage per GB-month" },
  { sku: "oci.object_storage.get_million", unit: "million_requests", display: /Object Storage - Requests/i, metric: /10,000 Requests Per Month/i, scale: 100, pick: "first_paid", note: "Object Storage requests, per 10,000 converted to per million (OCI prices read and write alike)" },
  { sku: "oci.object_storage.put_million", unit: "million_requests", display: /Object Storage - Requests/i, metric: /10,000 Requests Per Month/i, scale: 100, pick: "first_paid", note: "Object Storage requests, per 10,000 converted to per million (OCI prices read and write alike)" },
  // The catalog's block volume is the Balanced tier: storage plus 10 performance units per GB (derived below).
  { sku: "component.oci.block.storage", unit: "gb_month", display: /^Storage - Block Volume - Storage$/i, metric: /^(?:GB|Gigabyte) Storage Capacity Per Month$/i, pick: "first_paid", note: "Block Volume storage per GB-month" },
  { sku: "component.oci.block.vpu", unit: "gb_month", display: /^Storage - Block Volume - Performance Units$/i, metric: /^Performance Units Per Gigabyte Per Month$/i, pick: "first_paid", note: "Block Volume performance unit per GB-month" },
  { sku: "oci.flexible_lb.hour", unit: "hour", display: /Load Balancer Base/i, metric: /^Load Balancer(?: Hour)?$/i, pick: "first_paid", note: "Flexible Load Balancer base hour" },
  { sku: "component.oci.lb.mbps", unit: "hour", display: /^Load Balancer Bandwidth$/i, metric: /^Mbps Per Hour$/i, pick: "first_paid", note: "Flexible Load Balancer bandwidth per Mbps-hour" },
  { sku: "component.oci.redis.gb", unit: "hour", display: /^Oracle Cloud Infrastructure Cache with Redis - Low Memory\b/i, metric: /^Redis Memory Gigabyte per Hour$/i, pick: "first_paid", note: "OCI Cache with Redis low-memory tier per GB-hour" },
];

export const normalizeOci: Normalizer = (text, snapshot, ctx) => {
  const skipped: Skipped[] = [];
  const observations: PriceObservation[] = [];
  let json: { items?: OciItem[] };
  try {
    json = JSON.parse(text) as { items?: OciItem[] };
  } catch {
    return { observations, skipped: [{ sku: "(file)", region: "", reason: "not valid JSON" }] };
  }
  if (!Array.isArray(json.items)) return { observations, skipped: [{ sku: "(file)", region: "", reason: "not an OCI price list" }] };

  for (const rule of OCI_RULES) {
    const candidates: Priced[] = [];
    for (const item of json.items) {
      // The public list has stray double spaces (e.g. "Compute - Standard - E4  - Memory").
      if (!rule.display.test((item.displayName ?? "").replace(/\s+/g, " ")) || !rule.metric.test((item.metricName ?? "").replace(/\s+/g, " "))) continue;
      const usd = item.currencyCodeLocalizations?.find((l) => l.currencyCode === "USD");
      const dims: Dimension[] = [];
      for (const p of usd?.prices ?? []) {
        if (p.model !== "PAY_AS_YOU_GO") continue;
        const value = toNumber(p.value);
        const from = toNumber(p.rangeMin ?? 0);
        if (value !== undefined && from !== undefined) dims.push({ from, usd: value * (rule.scale ?? 1) });
      }
      if (rule.pick === "tiers") {
        const tiered = buildTiered(dims);
        if (tiered) candidates.push(tiered);
      } else {
        const first = dims.sort((a, b) => a.from - b.from).find((d) => d.usd > 0);
        if (first) candidates.push({ usd: first.usd });
      }
    }
    const resolved = resolveCandidates(candidates, "single");
    for (const region of ctx.regions) {
      if (!resolved.ok) {
        skipped.push({ sku: rule.sku, region, reason: resolved.reason });
        continue;
      }
      observations.push({
        provider: "oci",
        region,
        sku: rule.sku,
        unit: rule.unit,
        usd: resolved.priced.usd,
        ...(resolved.priced.tiers ? { tiers: resolved.priced.tiers } : {}),
        note: `${rule.note} (OCI public price list, global list price)`,
        snapshotSha256: snapshot.sha256,
      });
    }
  }
  return derivePrices({ observations, skipped }, OCI_DERIVED_RULES, ctx.regions);
};

const OCI_DERIVED_RULES: DerivedPriceRule[] = [
  ...[["small", 2], ["medium", 4], ["large", 8]].map(([size, memory]) => ({ sku: `oci.compute.${size}_hour`, components: [{ sku: "component.oci.e4.cpu", quantity: 1 }, { sku: "component.oci.e4.memory", quantity: Number(memory) }], note: `VM.Standard.E4.Flex 1 OCPU and ${memory} GB` })),
  ...[["nano", 1], ["small", 1], ["standard", 2], ["performance", 4]].map(([size, cpu]) => ({ sku: `oci.postgres.${size}_hour`, components: [{ sku: "component.oci.pg.cpu", quantity: Number(cpu) }], note: `Database with PostgreSQL ${cpu} OCPU, no HA` })),
  { sku: "oci.block_volume.gb_month", components: [{ sku: "component.oci.block.storage", quantity: 1 }, { sku: "component.oci.block.vpu", quantity: 10 }], note: "Balanced block volume: storage plus 10 VPU per GB-month" },
  { sku: "oci.flexible_lb.lcu_hour", components: [{ sku: "component.oci.lb.mbps", quantity: 10 }], note: "capacity unit = 10 Mbps minimum flexible bandwidth" },
  ...[["nano", 1], ["small", 2], ["standard", 4], ["performance", 8]].map(([size, gb]) => ({ sku: `oci.redis.${size}_hour`, components: [{ sku: "component.oci.redis.gb", quantity: Number(gb) }], note: `OCI Cache with Redis low-memory tier ${gb} GB` })),
];

export function ociRefreshableSkus(): string[] {
  return [...OCI_RULES.map(r => r.sku).filter(s => !s.startsWith("component.")), ...OCI_DERIVED_RULES.map(r => r.sku)];
}
