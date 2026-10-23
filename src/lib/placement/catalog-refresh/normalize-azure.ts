/**
 * Azure Retail Prices API normalizer. Input: one page (or the concatenated
 * pages) of `https://prices.azure.com/api/retail/prices?$filter=armRegionName eq '<region>'`
 * (an object with `Items`), saved with its checksum. Only `Consumption` items in
 * USD for the snapshot's region are read; `tierMinimumUnits` gives volume tiers.
 *
 * Same rules as the other normalizers: unit-checked, never guesses, ambiguity
 * and absence become `skipped`. Tested against recorded fixtures shaped like the
 * official response, not live pages (see `normalize-aws.ts` for the honest limit).
 */
import { buildTiered, resolveCandidates, toNumber, type Dimension, type Priced } from "@/lib/placement/catalog-refresh/common";
import type { Normalizer, PriceObservation, Skipped } from "@/lib/placement/catalog-refresh/types";
import type { PriceEntry } from "@/lib/placement/types";

interface AzureItem {
  currencyCode?: string;
  tierMinimumUnits?: number;
  retailPrice?: number;
  armRegionName?: string;
  meterName?: string;
  productName?: string;
  skuName?: string;
  serviceName?: string;
  unitOfMeasure?: string;
  type?: string;
  armSkuName?: string;
}

interface AzureRule {
  sku: string;
  unit: PriceEntry["unit"];
  match: (i: AzureItem) => boolean;
  unitOfMeasure: RegExp;
  scale?: number;
  pick: "tiers" | "first_paid";
  how?: "single" | "mode";
  note: string;
}

// Live files spell the same shape as Standard_D2s_v5 / D2s v5 / B1MS; compare one normalized form.
const shapeOf = (value: string | undefined) => (value ?? "").replace(/^Standard_/i, "").replace(/[_\s]+/g, " ").trim().toLowerCase();
const meter = (service: string, meterName: RegExp, product?: RegExp) => (i: AzureItem) =>
  i.serviceName === service && meterName.test(i.meterName ?? "") && (product ? product.test(i.productName ?? "") : true);

export const AZURE_RULES: readonly AzureRule[] = [
  ...[["small", "B1ms"], ["medium", "B2s"], ["large", "D2s_v5"]].map(([size, shape]): AzureRule => ({
    sku: `azure.vm.${size}_hour`, unit: "hour", match: i => i.serviceName === "Virtual Machines" && i.armSkuName === `Standard_${shape}` && shapeOf(i.meterName) === shapeOf(shape) && !/Windows|Spot|Low Priority/i.test(`${i.productName} ${i.skuName}`), unitOfMeasure: /^1 Hour$/i, pick: "first_paid", note: `Standard_${shape} Linux consumption VM, no Spot or Windows license`,
  })),
  ...[["nano", "B1ms"], ["small", "B2s"], ["standard", "D2ds_v5"], ["performance", "D4ds_v5"]].map(([size, shape]): AzureRule => ({
    sku: `azure.postgres_flexible.${size}_hour`, unit: "hour", match: i => i.serviceName === "Azure Database for PostgreSQL" && /Flexible Server/i.test(i.productName ?? "") && shapeOf(i.armSkuName) === shapeOf(shape) && (shapeOf(i.meterName) === shapeOf(shape) || i.meterName === "vCore") && !/Reserved|HA|High Availability/i.test(`${i.productName} ${i.skuName}`), unitOfMeasure: /^1 Hour$/i, pick: "first_paid", note: `PostgreSQL Flexible Server Standard_${shape} consumption compute, no HA`,
  })),
  { sku: "azure.public_ip.hour", unit: "hour", match: meter("Virtual Network", /^Standard IPv4 Static Public IP$/), unitOfMeasure: /^1 Hour$/i, pick: "first_paid", note: "Standard IPv4 Static Public IP per hour" },
  {
    sku: "azure.bandwidth.internet_gb",
    unit: "gb",
    // Retail Prices lists the meter under both routing preferences; the catalog prices Microsoft-network routing.
    match: (i) => meter("Bandwidth", /^Standard Data Transfer Out$/)(i) && !/Routing Preference: Internet/i.test(i.productName ?? ""),
    unitOfMeasure: /^1 GB$/i,
    pick: "tiers",
    note: "Internet data transfer out; first paid tier from 0 GB (free allowance not deducted), provider volume tiers from their cumulative boundaries",
  },
  // Live files name the meter "Standard Inter-Region Data Transfer" under the Microsoft-network product.
  { sku: "azure.bandwidth.inter_region_gb", unit: "gb", match: (i) => meter("Bandwidth", /Data Transfer Out$/, /Inter-?Region/i)(i) || (meter("Bandwidth", /^Standard Inter-Region Data Transfer$/)(i) && !/Routing Preference: Internet/i.test(i.productName ?? "")), unitOfMeasure: /^1 GB$/i, pick: "first_paid", how: "mode", note: "Inter-region data transfer out; most common rate, higher rate on a tie" },
  { sku: "azure.nat_gateway.hour", unit: "hour", match: meter("NAT Gateway", /^Standard Gateway$/), unitOfMeasure: /^1 Hour$/i, pick: "first_paid", note: "NAT Gateway resource hours" },
  { sku: "azure.nat_gateway.gb", unit: "gb", match: meter("NAT Gateway", /^Standard Data Processed$/), unitOfMeasure: /^1 GB$/i, pick: "first_paid", note: "NAT Gateway data processed per GB" },
  { sku: "azure.container_apps.vcpu_hour", unit: "hour", match: meter("Azure Container Apps", /^Standard vCPU Active Usage$/), unitOfMeasure: /second/i, scale: 3600, pick: "first_paid", note: "Container Apps active vCPU, per second converted to hours" },
  { sku: "azure.container_apps.gb_hour", unit: "hour", match: meter("Azure Container Apps", /^Standard Memory Active Usage$/), unitOfMeasure: /second/i, scale: 3600, pick: "first_paid", note: "Container Apps active memory, per GiB-second converted to hours" },
  { sku: "azure.blob.storage_gb_month", unit: "gb_month", match: meter("Storage", /^Hot LRS Data Stored$/, /General Block Blob/i), unitOfMeasure: /GB\/Month/i, pick: "first_paid", note: "Blob Hot LRS data stored, first paid tier" },
  { sku: "azure.blob.get_million", unit: "million_requests", match: meter("Storage", /^Hot Read Operations$/, /General Block Blob/i), unitOfMeasure: /^10K$/i, scale: 100, pick: "first_paid", note: "Blob Hot read operations, per 10,000 converted to per million" },
  { sku: "azure.blob.put_million", unit: "million_requests", match: meter("Storage", /^Hot Write Operations$/, /General Block Blob/i), unitOfMeasure: /^10K$/i, scale: 100, pick: "first_paid", note: "Blob Hot write operations, per 10,000 converted to per million" },
  { sku: "azure.log_analytics.logs_ingest_gb", unit: "gb", match: meter("Log Analytics", /Data Ingestion$/), unitOfMeasure: /^1 GB$/i, pick: "first_paid", note: "Log Analytics data ingestion per GB, first paid tier" },
  { sku: "azure.dns.zone_month", unit: "month", match: meter("Azure DNS", /^Public Zone$/), unitOfMeasure: /month/i, pick: "first_paid", note: "Azure DNS public hosted zone per month" },
  { sku: "azure.dns.queries_million", unit: "million_requests", match: meter("Azure DNS", /^Public Queries$/), unitOfMeasure: /^1M$/i, pick: "first_paid", note: "Azure DNS public queries per million, first paid tier" },
  { sku: "azure.postgres_flexible.storage_gb_month", unit: "gb_month", match: meter("Azure Database for PostgreSQL", /^Storage Data Stored$/), unitOfMeasure: /GB\/Month/i, pick: "first_paid", note: "PostgreSQL Flexible Server storage per GB-month" },
  { sku: "azure.postgres_flexible.backup_gb_month", unit: "gb_month", match: meter("Azure Database for PostgreSQL", /^Backup Storage LRS Data Stored$/), unitOfMeasure: /GB\/Month/i, pick: "first_paid", note: "PostgreSQL Flexible Server backup storage (LRS) per GB-month" },
];

export const normalizeAzure: Normalizer = (text, snapshot) => {
  const region = snapshot.region;
  const skipped: Skipped[] = [];
  const observations: PriceObservation[] = [];
  let json: { Items?: AzureItem[] };
  try {
    json = JSON.parse(text) as { Items?: AzureItem[] };
  } catch {
    return { observations, skipped: [{ sku: "(file)", region: region ?? "", reason: "not valid JSON" }] };
  }
  if (!region || !Array.isArray(json.Items)) return { observations, skipped: [{ sku: "(file)", region: region ?? "", reason: "not a Retail Prices response" }] };
  const items = json.Items.filter((i) => i.type === "Consumption" && i.currencyCode === "USD" && i.armRegionName === region);

  for (const rule of AZURE_RULES) {
    const matches = items.filter(rule.match);
    if (matches.length === 0) continue;
    // Retail Prices can list one meter under several SKUs; group by SKU so tier rows stay together.
    const bySku = new Map<string, AzureItem[]>();
    for (const i of matches) {
      const key = `${i.productName ?? ""}|${i.skuName ?? ""}|${i.unitOfMeasure ?? ""}`;
      bySku.set(key, [...(bySku.get(key) ?? []), i]);
    }
    const candidates: Priced[] = [];
    let problem: string | undefined;
    for (const group of bySku.values()) {
      if (!rule.unitOfMeasure.test(group[0]!.unitOfMeasure ?? "")) {
        problem = `unexpected unit "${String(group[0]!.unitOfMeasure).slice(0, 40)}"`;
        continue;
      }
      const dims: Dimension[] = [];
      for (const i of group) {
        const usd = toNumber(i.retailPrice);
        const from = toNumber(i.tierMinimumUnits ?? 0);
        if (usd !== undefined && from !== undefined) dims.push({ from, usd: usd * (rule.scale ?? 1) });
      }
      if (rule.pick === "tiers") {
        const tiered = buildTiered(dims);
        if (tiered) candidates.push(tiered);
      } else {
        const first = dims.sort((a, b) => a.from - b.from).find((d) => d.usd > 0);
        if (first) candidates.push({ usd: first.usd });
      }
    }
    if (candidates.length === 0 && problem) {
      skipped.push({ sku: rule.sku, region, reason: problem });
      continue;
    }
    const resolved = resolveCandidates(candidates, rule.how ?? "single");
    if (!resolved.ok) {
      skipped.push({ sku: rule.sku, region, reason: resolved.reason });
      continue;
    }
    observations.push({
      provider: "azure",
      region,
      sku: rule.sku,
      unit: rule.unit,
      usd: resolved.priced.usd,
      ...(resolved.priced.tiers ? { tiers: resolved.priced.tiers } : {}),
      note: `${rule.note} (Azure Retail Prices API)`,
      snapshotSha256: snapshot.sha256,
    });
  }
  return { observations, skipped };
};

export function azureRefreshableSkus(): string[] {
  return AZURE_RULES.map((r) => r.sku);
}
