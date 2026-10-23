/**
 * Merge refreshed observations into the previous catalog and produce a NEW
 * dated catalog version plus a human-readable report.
 *
 * Guarantees:
 * - Only observations read from checksum-verified saved files are applied.
 * - An entry whose price moved by more than `maxChangeRatio` (default 50%), or
 *   fell to zero, is NOT applied and is listed under `flagged` for review;
 *   `allowLargeChanges` applies them and still lists them.
 * - A unit mismatch between the old entry and the observation is never applied.
 * - Observations for a SKU or region the previous catalog does not know are
 *   added only when the SKU is one the cost engine maps (base or extended role)
 *   and the region already exists for that provider.
 * - Entries without an observation keep their old value AND their old
 *   verification class; they are counted in `notRefreshed` so a partial refresh
 *   cannot pass as a full one.
 * - The result is validated by `parseCatalog` (sources, dates, tiers).
 */
import { SKU_ROLE_MAP } from "@/lib/placement/capabilities";
import { allExtendedSkus, costDimensionCoverage, type DimensionCoverage } from "@/lib/placement/extended-costs";
import { parseCatalog, PlacementCatalogError } from "@/lib/placement/pricebook";
import type { CatalogSnapshotRecord, PriceCatalog, PriceEntry } from "@/lib/placement/types";
import { RefreshError, type PriceObservation, type SnapshotEntry } from "@/lib/placement/catalog-refresh/types";

export const DEFAULT_MAX_CHANGE_RATIO = 0.5;

export interface RefreshOptions {
  base: PriceCatalog;
  observations: readonly PriceObservation[];
  snapshots: readonly SnapshotEntry[];
  /** new catalog version, `YYYY-MM-DD.n`; must be later than the base */
  version: string;
  maxChangeRatio?: number;
  allowLargeChanges?: boolean;
}

export interface PriceChange {
  provider: string;
  region: string;
  sku: string;
  from: number;
  to: number;
  /** relative change, (to - from) / from; absent when from is 0 */
  ratio?: number;
  applied: boolean;
  reason?: string;
}

export interface RefreshReport {
  baseVersion: string;
  newVersion: string;
  updated: PriceChange[];
  unchangedCount: number;
  added: { provider: string; region: string; sku: string; usd: number }[];
  flagged: PriceChange[];
  rejected: { provider: string; region: string; sku: string; reason: string }[];
  /** entries that kept their old value because no file priced them */
  notRefreshedCount: number;
  /** entries still resting on weak evidence after the refresh */
  weakRemainingCount: number;
  coverage: DimensionCoverage[];
}

function compareVersion(a: string, b: string): number {
  const [da, na] = a.split(".");
  const [db, nb] = b.split(".");
  if (da !== db) return da! < db! ? -1 : 1;
  return Number(na) - Number(nb);
}

const key = (p: string, r: string, s: string) => `${p}|${r}|${s}`;

function mappedSkus(providers: readonly string[]): Set<string> {
  const out = new Set<string>();
  for (const roles of Object.values(SKU_ROLE_MAP)) for (const sku of Object.values(roles)) if (sku) out.add(sku);
  for (const sku of allExtendedSkus(providers)) out.add(sku);
  return out;
}

const SOURCE_TEXT = (provider: string, count: number, files: number) =>
  `${provider.toUpperCase()} list prices parsed mechanically by the catalog refresh tool from ${files} saved official price file(s); ${count} entries were refreshed from them. ` +
  "Values were transcribed by the tool, not by hand, from files whose SHA-256 checksums are recorded in this catalog's snapshots list, and are list prices, not an invoice or a quote. " +
  "Entries outside the tool's rules were not refreshed and keep their earlier source.";

export function applyRefresh(options: RefreshOptions): { catalog: PriceCatalog; report: RefreshReport } {
  const { base } = options;
  if (compareVersion(options.version, base.version) <= 0) throw new RefreshError("version", `New version ${options.version} must be later than ${base.version}.`);
  if (options.snapshots.length === 0) throw new RefreshError("validation", "A refresh needs at least one saved snapshot.");
  const maxRatio = options.maxChangeRatio ?? DEFAULT_MAX_CHANGE_RATIO;
  const versionDate = options.version.split(".")[0]!;
  const bySha = new Map(options.snapshots.map((s) => [s.sha256, s]));
  const providers = [...new Set(base.entries.map((e) => e.provider))];
  const known = mappedSkus(providers);
  const baseRegions = new Map<string, Set<string>>();
  for (const e of base.entries) baseRegions.set(e.provider, (baseRegions.get(e.provider) ?? new Set()).add(e.region));

  const entries: PriceEntry[] = base.entries.map((e) => ({ ...e, ...(e.tiers ? { tiers: e.tiers.map((t) => ({ ...t })) } : {}) }));
  const index = new Map(entries.map((e, i) => [key(e.provider, e.region, e.sku), i]));
  const report: RefreshReport = {
    baseVersion: base.version,
    newVersion: options.version,
    updated: [],
    unchangedCount: 0,
    added: [],
    flagged: [],
    rejected: [],
    notRefreshedCount: 0,
    weakRemainingCount: 0,
    coverage: [],
  };
  const touched = new Set<string>();
  const refreshedByProvider = new Map<string, number>();
  const newEntries: PriceEntry[] = [];

  // Unit scaling and derivation multiply binary floats (0.0000004 x 1e6 = 0.39999999999999997); keep 12 significant digits.
  const price = (usd: number) => Number(usd.toPrecision(12));
  const rounded = options.observations.map((o) => ({ ...o, usd: price(o.usd), ...(o.tiers ? { tiers: o.tiers.map((t) => ({ ...t, usd: price(t.usd) })) } : {}) }));
  for (const o of rounded.sort((a, b) => (key(a.provider, a.region, a.sku) < key(b.provider, b.region, b.sku) ? -1 : 1))) {
    const snap = bySha.get(o.snapshotSha256);
    const reject = (reason: string) => report.rejected.push({ provider: o.provider, region: o.region, sku: o.sku, reason });
    if (!snap) {
      reject("observation does not come from a listed snapshot");
      continue;
    }
    if (!Number.isFinite(o.usd) || o.usd < 0) {
      reject("price is not a finite non-negative number");
      continue;
    }
    const k = key(o.provider, o.region, o.sku);
    if (touched.has(k)) {
      reject("a second observation for the same entry; first one kept");
      continue;
    }
    const at = index.get(k);
    const note = `Refreshed ${snap.retrievedAt}: ${o.note}. Snapshot sha256 ${o.snapshotSha256.slice(0, 16)}.`;
    if (at === undefined) {
      if (!known.has(o.sku) || !baseRegions.get(o.provider)?.has(o.region)) {
        reject("SKU or region is not part of the catalog's cost model");
        continue;
      }
      touched.add(k);
      newEntries.push({ provider: o.provider, region: o.region, sku: o.sku, unit: o.unit, usd: o.usd, verification: "official_api", note, ...(o.tiers ? { tiers: o.tiers } : {}) });
      report.added.push({ provider: o.provider, region: o.region, sku: o.sku, usd: o.usd });
      refreshedByProvider.set(o.provider, (refreshedByProvider.get(o.provider) ?? 0) + 1);
      continue;
    }
    const old = entries[at]!;
    if (old.unit !== o.unit) {
      reject(`unit mismatch: catalog has ${old.unit}, file gives ${o.unit}`);
      continue;
    }
    touched.add(k);
    const ratio = old.usd > 0 ? (o.usd - old.usd) / old.usd : undefined;
    const large = (ratio !== undefined && Math.abs(ratio) > maxRatio) || (old.usd > 0 && o.usd === 0);
    const change: PriceChange = { provider: o.provider, region: o.region, sku: o.sku, from: old.usd, to: o.usd, ...(ratio !== undefined ? { ratio: Math.round(ratio * 1e4) / 1e4 } : {}), applied: true };
    if (large && !options.allowLargeChanges) {
      report.flagged.push({ ...change, applied: false, reason: `change beyond ${Math.round(maxRatio * 100)}% or to zero; review the source file, then rerun with large changes allowed` });
      touched.delete(k);
      continue;
    }
    if (large) report.flagged.push({ ...change, reason: "large change applied because it was explicitly allowed" });
    refreshedByProvider.set(o.provider, (refreshedByProvider.get(o.provider) ?? 0) + 1);
    const sameTiers = JSON.stringify(old.tiers ?? null) === JSON.stringify(o.tiers ?? null);
    if (old.usd === o.usd && sameTiers && old.verification === "official_api") {
      report.unchangedCount += 1;
      entries[at] = { ...old, note };
      continue;
    }
    if (old.usd !== o.usd || !sameTiers) report.updated.push(change);
    else report.unchangedCount += 1;
    const next: PriceEntry = { ...old, usd: o.usd, verification: "official_api", note };
    if (o.tiers) next.tiers = o.tiers;
    else delete next.tiers;
    entries[at] = next;
  }

  const snapshotRecords: CatalogSnapshotRecord[] = options.snapshots.map((s) => ({
    provider: s.provider,
    url: s.url,
    retrievedAt: s.retrievedAt,
    sha256: s.sha256,
    bytes: s.bytes,
    service: s.service,
    ...(s.region ? { region: s.region } : {}),
  }));
  const sources = [...base.sources];
  for (const [provider, count] of [...refreshedByProvider.entries()].sort(([a], [b]) => (a < b ? -1 : 1))) {
    const own = options.snapshots.filter((s) => s.provider === provider);
    if (own.length === 0) continue;
    const latest = own.map((s) => s.retrievedAt).sort().at(-1)!;
    if (latest > versionDate) throw new RefreshError("validation", `Snapshot for ${provider} was retrieved after the catalog version date.`);
    sources.push({ provider, verification: "official_api", retrievedAt: latest, url: own[0]!.url, source: SOURCE_TEXT(provider, count, own.length) });
  }

  const merged: PriceCatalog = {
    version: options.version,
    sources,
    snapshots: [...(base.snapshots ?? []), ...snapshotRecords],
    entries: [...entries, ...newEntries.sort((a, b) => (key(a.provider, a.region, a.sku) < key(b.provider, b.region, b.sku) ? -1 : 1))],
  };
  let catalog: PriceCatalog;
  try {
    catalog = parseCatalog(JSON.parse(JSON.stringify(merged)));
  } catch (error) {
    if (error instanceof PlacementCatalogError) throw new RefreshError("validation", error.message);
    throw error;
  }
  report.notRefreshedCount = catalog.entries.filter((e) => !touched.has(key(e.provider, e.region, e.sku))).length;
  report.weakRemainingCount = catalog.entries.filter((e) => e.verification === "model_knowledge" || e.verification === "derived" || e.verification === "internal_assumption").length;
  report.coverage = costDimensionCoverage(catalog);
  return { catalog, report };
}

/** Plain-text summary for the CLI and for review. Deterministic. */
export function formatRefreshReport(r: RefreshReport): string {
  const lines = [
    `Catalog refresh ${r.baseVersion} -> ${r.newVersion}`,
    `  updated ${r.updated.length}, unchanged ${r.unchangedCount}, added ${r.added.length}, flagged ${r.flagged.length}, rejected ${r.rejected.length}`,
    `  not refreshed (kept earlier value and source): ${r.notRefreshedCount}; still weak evidence: ${r.weakRemainingCount}`,
  ];
  for (const f of r.flagged) lines.push(`  FLAGGED ${f.provider}/${f.region}/${f.sku}: ${f.from} -> ${f.to}${f.ratio !== undefined ? ` (${Math.round(f.ratio * 1000) / 10}%)` : ""} ${f.applied ? "applied" : "NOT applied"}: ${f.reason ?? ""}`);
  for (const x of r.rejected.slice(0, 50)) lines.push(`  rejected ${x.provider}/${x.region}/${x.sku}: ${x.reason}`);
  const open = r.coverage.filter((c) => c.status !== "priced");
  lines.push(`  cost dimensions not fully priced: ${open.length}`);
  for (const c of open) lines.push(`    ${c.provider} ${c.dimension}: ${c.status}${c.missingRegions.length ? ` (missing ${c.missingRegions.join(", ")})` : ""}`);
  return lines.join("\n");
}
