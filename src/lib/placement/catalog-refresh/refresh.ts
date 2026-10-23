/**
 * Offline refresh pipeline: verified saved snapshots -> observations -> merged,
 * validated, dated catalog. No network, clock or environment access.
 */
import type { PriceCatalog } from "@/lib/placement/types";
import { applyRefresh, type RefreshReport } from "@/lib/placement/catalog-refresh/merge";
import { awsRefreshableSkus, normalizeAws } from "@/lib/placement/catalog-refresh/normalize-aws";
import { azureRefreshableSkus, normalizeAzure } from "@/lib/placement/catalog-refresh/normalize-azure";
import { gcpRefreshableSkus, normalizeGcp } from "@/lib/placement/catalog-refresh/normalize-gcp";
import { normalizeOci, ociRefreshableSkus } from "@/lib/placement/catalog-refresh/normalize-oci";
import { RefreshError, type NormalizeContext, type Normalizer, type PriceObservation, type Skipped, type SnapshotEntry, type SnapshotFormat } from "@/lib/placement/catalog-refresh/types";
import type { LoadedSnapshot } from "@/lib/placement/catalog-refresh/snapshots";
import { verifySnapshotBytes } from "@/lib/placement/catalog-refresh/snapshots";

const REFRESHABLE: Record<SnapshotEntry["provider"], () => string[]> = { aws: awsRefreshableSkus, gcp: gcpRefreshableSkus, azure: azureRefreshableSkus, oci: ociRefreshableSkus };
const NORMALIZERS: Record<SnapshotFormat, Normalizer> = {
  aws_price_list: normalizeAws,
  gcp_billing_catalog: normalizeGcp,
  azure_retail_prices: normalizeAzure,
  oci_price_list: normalizeOci,
};

export interface RefreshFromSnapshotsInput {
  base: PriceCatalog;
  snapshots: readonly LoadedSnapshot[];
  version: string;
  maxChangeRatio?: number;
  allowLargeChanges?: boolean;
}

export interface RefreshOutput {
  catalog: PriceCatalog;
  report: RefreshReport;
  /** targets the rules looked for in a file but did not guess */
  skipped: Skipped[];
}

export function refreshFromSnapshots(input: RefreshFromSnapshotsInput): RefreshOutput {
  const observations: PriceObservation[] = [];
  const skipped: Skipped[] = [];
  const groups = new Map<string, LoadedSnapshot[]>();
  for (const loaded of input.snapshots) {
    // Re-verify here too: callers may build LoadedSnapshot values without the directory loader.
    verifySnapshotBytes(loaded.entry, Buffer.from(loaded.text, "utf8"));
    const paginated = ["gcp_billing_catalog", "azure_retail_prices"].includes(loaded.entry.format);
    const group = `${loaded.entry.provider}|${loaded.entry.format}|${loaded.entry.service}|${loaded.entry.region ?? ""}|${loaded.entry.retrievedAt}|${paginated ? "pages" : loaded.entry.file}`;
    groups.set(group, [...(groups.get(group) ?? []), loaded]);
  }
  for (const group of groups.values()) {
    const loaded = group[0]!;
    const regions = [...new Set(input.base.entries.filter((e) => e.provider === loaded.entry.provider).map((e) => e.region))].sort();
    const ctx: NormalizeContext = { regions };
    // Keep exact downloaded bytes/checksums in the manifest. Assemble checked pages only
    // for normalization so CPU/RAM and volume tiers split across pages remain one product.
    let text = loaded.text;
    if (group.length > 1 && ["gcp_billing_catalog", "azure_retail_prices"].includes(loaded.entry.format)) {
      const field = loaded.entry.format === "gcp_billing_catalog" ? "skus" : "Items";
      const pages: unknown[] = group.map(s => { try { return JSON.parse(s.text); } catch { return undefined; } });
      if (pages.some(p => !p || typeof p !== "object" || !Array.isArray((p as Record<string, unknown>)[field]))) throw new RefreshError("format", "A checked price page has an invalid collection; refusing a partial refresh.");
      text = JSON.stringify({ [field]: pages.flatMap(p => (p as Record<string, unknown[]>)[field]!) });
    }
    const out = NORMALIZERS[loaded.entry.format](text, loaded.entry, ctx);
    if (group.length > 1) for (const observation of out.observations) observation.note += `; normalized from checked page set ${group.map(s => s.entry.sha256).sort().join(", ")}`;
    observations.push(...out.observations);
    skipped.push(...out.skipped);
  }
  if (observations.length === 0) throw new RefreshError("validation", "No price could be read from the snapshots; refusing to publish a catalog that refreshed nothing.");
  // A file that lacks a price another file supplied is not a miss; a refreshable target no file answered is.
  const observed = new Set(observations.map((o) => `${o.sku}|${o.region}`));
  const reported = new Map<string, Skipped>();
  for (const s of skipped) if (!observed.has(`${s.sku}|${s.region}`) && !reported.has(`${s.sku}|${s.region}`)) reported.set(`${s.sku}|${s.region}`, s);
  for (const provider of new Set(input.snapshots.map((s) => s.entry.provider))) {
    const refreshable = new Set(REFRESHABLE[provider]());
    for (const e of input.base.entries) {
      const key = `${e.sku}|${e.region}`;
      if (e.provider === provider && refreshable.has(e.sku) && !observed.has(key) && !reported.has(key)) reported.set(key, { sku: e.sku, region: e.region, reason: "no snapshot file had a matching price" });
    }
  }
  skipped.splice(0, skipped.length, ...reported.values());
  const entries: SnapshotEntry[] = input.snapshots.map((s) => s.entry);
  const { catalog, report } = applyRefresh({
    base: input.base,
    observations,
    snapshots: entries,
    version: input.version,
    ...(input.maxChangeRatio !== undefined ? { maxChangeRatio: input.maxChangeRatio } : {}),
    ...(input.allowLargeChanges !== undefined ? { allowLargeChanges: input.allowLargeChanges } : {}),
  });
  return { catalog, report, skipped };
}

/** Days between the catalog's newest source retrieval and `now`. */
export function catalogAgeDays(catalog: PriceCatalog, now: Date): number {
  const latest = catalog.sources.map((s) => s.retrievedAt).sort().at(-1) ?? "1970-01-01";
  return Math.floor((now.getTime() - Date.parse(`${latest}T00:00:00.000Z`)) / 86_400_000);
}
