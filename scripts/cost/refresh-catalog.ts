/**
 * Price catalog refresh CLI (PROD-COST-01).
 *
 *   tsx scripts/cost/refresh-catalog.ts apply --snapshots <dir> --version <YYYY-MM-DD.n> --out <file> [--base <catalog.json>] [--allow-large-changes]
 *       OFFLINE. Verifies every saved file against manifest.json checksums, parses them with the
 *       provider normalizers and writes a NEW catalog JSON plus a report. Never edits the bundled
 *       catalog: a human reviews the report and the diff, then adopts the file.
 *
 *   tsx scripts/cost/refresh-catalog.ts fetch --providers aws,gcp,azure,oci --out <abs dir> [--base <catalog.json>] [--prefilter-aws]
 *       LIVE and GATED: refuses unless ZENITH_LIVE_CATALOG_REFRESH=1 (and, for gcp,
 *       ZENITH_LIVE_GCP_CATALOG_API_KEY_FILE). Downloads public price files into <dir> with checksums.
 *       --prefilter-aws keeps only the products the AWS rules read (scripts/cost/prefilter-aws-offer.ts),
 *       so regional EC2 offers above the size cap can be saved; <dir>/prefilter.json records each original
 *       file's SHA-256 and size. Needs a large heap (NODE_OPTIONS=--max-old-space-size=8192).
 *
 *   tsx scripts/cost/refresh-catalog.ts age [--now <ISO>] [--max-days <n>]
 *       OFFLINE. Prints the bundled catalog age; exits 1 when older than --max-days (default 45).
 */
import { readFileSync, writeFileSync } from "node:fs";
import { loadDefaultCatalog, parseCatalog } from "@/lib/placement/pricebook";
import { REFRESH_PROVIDERS, RefreshError, type RefreshProvider } from "@/lib/placement/catalog-refresh/types";
import { loadSnapshotDirectory } from "@/lib/placement/catalog-refresh/snapshots";
import { catalogAgeDays, refreshFromSnapshots } from "@/lib/placement/catalog-refresh/refresh";
import { formatRefreshReport } from "@/lib/placement/catalog-refresh/merge";
import { fetchOfficialSnapshots } from "@/lib/cost/catalog-fetch";
import { sha256Hex } from "@/lib/controlplane/digest";
import { join } from "node:path";
import { prefilterAwsOffer } from "./prefilter-aws-offer";

function parseArgs(argv: string[]): Map<string, string> {
  const out = new Map<string, string>();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (!a.startsWith("--")) continue;
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) out.set(a.slice(2), "true");
    else {
      out.set(a.slice(2), next);
      i++;
    }
  }
  return out;
}

function need(a: Map<string, string>, name: string): string {
  const v = a.get(name);
  if (!v || v === "true") throw new Error(`--${name} is required.`);
  return v;
}

async function main(): Promise<number> {
  const [command, ...rest] = process.argv.slice(2);
  const a = parseArgs(rest);
  const base = a.has("base") ? parseCatalog(JSON.parse(readFileSync(need(a, "base"), "utf8"))) : loadDefaultCatalog();

  if (command === "apply") {
    const out = refreshFromSnapshots({
      base,
      snapshots: loadSnapshotDirectory(need(a, "snapshots")),
      version: need(a, "version"),
      allowLargeChanges: a.get("allow-large-changes") === "true",
    });
    writeFileSync(need(a, "out"), `${JSON.stringify(out.catalog, null, 2)}\n`);
    console.log(formatRefreshReport(out.report));
    console.log(`Skipped targets (not guessed): ${out.skipped.length}`);
    for (const s of out.skipped.slice(0, 40)) console.log(`  ${s.sku} ${s.region}: ${s.reason}`);
    console.log(`Wrote ${need(a, "out")}. Review the report and the diff before adopting it as the bundled catalog.`);
    return out.report.flagged.some((f) => !f.applied) ? 2 : 0;
  }

  if (command === "fetch") {
    const providers = need(a, "providers").split(",") as RefreshProvider[];
    for (const p of providers) if (!REFRESH_PROVIDERS.includes(p)) throw new Error(`Unknown provider ${p}.`);
    const regions: Record<string, string[]> = {};
    for (const p of providers) regions[p] = [...new Set(base.entries.filter((e) => e.provider === p).map((e) => e.region))].sort();
    const prefiltered: { url: string; sourceSha256: string; sourceBytes: number; filteredSha256: string; filteredBytes: number }[] = [];
    const prefilterFetch: typeof fetch = async (input, init) => {
      const response = await fetch(input, init), url = String(input);
      if (!response.ok || !url.startsWith("https://pricing.us-east-1.amazonaws.com/offers/")) return response;
      const raw = Buffer.from(await response.arrayBuffer());
      const filtered = Buffer.from(JSON.stringify(prefilterAwsOffer(JSON.parse(raw.toString("utf8")))));
      prefiltered.push({ url, sourceSha256: sha256Hex(raw), sourceBytes: raw.byteLength, filteredSha256: sha256Hex(filtered), filteredBytes: filtered.byteLength });
      return new Response(filtered, { status: 200, headers: { "content-length": String(filtered.byteLength) } });
    };
    const manifest = await fetchOfficialSnapshots(
      { providers, regions, outDir: need(a, "out") },
      { env: process.env, fetch: a.has("prefilter-aws") ? prefilterFetch : fetch, today: new Date().toISOString().slice(0, 10) },
    );
    if (prefiltered.length) writeFileSync(join(need(a, "out"), "prefilter.json"), `${JSON.stringify({ schema: 1, tool: "scripts/cost/prefilter-aws-offer.ts", files: prefiltered }, null, 2)}\n`);
    console.log(`Saved ${manifest.snapshots.length} file(s) with checksums to ${need(a, "out")}.`);
    return 0;
  }

  if (command === "age") {
    const now = a.has("now") ? new Date(need(a, "now")) : new Date();
    const max = Number(a.get("max-days") ?? "45");
    const age = catalogAgeDays(base, now);
    console.log(`Catalog ${base.version}: newest source retrieval is ${age} day(s) old (limit ${max}).`);
    return age > max ? 1 : 0;
  }

  console.error("Usage: refresh-catalog.ts apply|fetch|age (see the file header).");
  return 64;
}

main().then(
  (code) => process.exit(code),
  (error: unknown) => {
    console.error(error instanceof RefreshError ? `${error.code}: ${error.message}` : error instanceof Error ? error.message : String(error));
    process.exit(1);
  },
);
