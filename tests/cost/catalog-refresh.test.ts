/**
 * PROD-COST-01: catalog refresh tooling, offline from saved snapshots.
 *
 * CONTRACT-LEVEL: the snapshot files under `fixtures/price-snapshots` are
 * hand-built in the documented shape of each provider's official price file and
 * carry SHA-256 checksums in their manifest. They are not provider downloads.
 * No test here touches a network; `fetch` is exercised only with an injected
 * in-memory implementation and a closed gate.
 */
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildPriceBook, costDimensionCoverage, estimateGraphCost, loadDefaultCatalog, parseCatalog } from "@/lib/placement";
import {
  applyRefresh,
  buildTiered,
  catalogAgeDays,
  formatRefreshReport,
  loadSnapshotDirectory,
  normalizeAws,
  normalizeAzure,
  normalizeGcp,
  normalizeOci,
  parseManifest,
  refreshFromSnapshots,
  RefreshError,
  verifySnapshotBytes,
  type SnapshotEntry,
} from "@/lib/placement/catalog-refresh";
import { fetchOfficialSnapshots, refreshGateOpen } from "@/lib/cost/catalog-fetch";
import { node } from "../placement/fixtures";

const DIR = join(process.cwd(), "tests/cost/fixtures/price-snapshots");
const base = loadDefaultCatalog();
const loaded = () => loadSnapshotDirectory(DIR);
const byFile = (file: string) => loaded().find((s) => s.entry.file === file)!;
const NO_CTX = { regions: ["us-ashburn-1", "ap-mumbai-1"] };

const temps: string[] = [];
afterEach(() => {
  for (const d of temps.splice(0)) rmSync(d, { recursive: true, force: true });
});
function copyDir(): string {
  const d = mkdtempSync(join(tmpdir(), "zenith-snap-"));
  temps.push(d);
  cpSync(DIR, d, { recursive: true });
  return d;
}

describe("snapshot integrity", () => {
  it("loads a manifest whose every file matches its recorded checksum and size", () => {
    const all = loaded();
    expect(all.length).toBe(7);
    for (const s of all) expect(s.entry.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("refuses a file edited after it was saved", () => {
    const d = copyDir();
    const file = join(d, "aws-AmazonEC2-us-east-1.json");
    writeFileSync(file, readFileSync(file, "utf8").replace("0.0450000000", "0.0010000000"));
    expect(() => loadSnapshotDirectory(d)).toThrowError(RefreshError);
    expect(() => loadSnapshotDirectory(d)).toThrow(/bytes|SHA-256/);
  });

  it("refuses same-length tampering by checksum, and a missing manifest", () => {
    const d = copyDir();
    const file = join(d, "oci-price-list.json");
    writeFileSync(file, readFileSync(file, "utf8").replace("0.0255", "0.0256"));
    expect(() => loadSnapshotDirectory(d)).toThrow(/SHA-256/);
    expect(() => loadSnapshotDirectory(join(d, "nope"))).toThrow(/manifest/);
  });

  it("refuses manifests with a provider/format mismatch, an escaping path or a duplicate file", () => {
    const entry = (over: Partial<SnapshotEntry>) => ({ ...JSON.parse(readFileSync(join(DIR, "manifest.json"), "utf8")).snapshots[0], ...over });
    expect(() => parseManifest({ schema: 1, snapshots: [entry({ format: "gcp_billing_catalog" })] })).toThrow(/not a aws format/);
    expect(() => parseManifest({ schema: 1, snapshots: [entry({ file: "../x.json" })] })).toThrow(/inside the snapshot directory/);
    expect(() => parseManifest({ schema: 1, snapshots: [entry({}), entry({})] })).toThrow(/twice/);
    expect(() => parseManifest({ schema: 1, snapshots: [entry({ url: "http://insecure.example/x" })] })).toThrow();
  });

  it("verifySnapshotBytes rejects a wrong length first", () => {
    const s = loaded()[0]!;
    expect(() => verifySnapshotBytes(s.entry, Buffer.from("{}"))).toThrow(/bytes/);
  });
});

describe("tiers", () => {
  it("encodes the first paid price from 0 GB and keeps provider boundaries", () => {
    expect(buildTiered([{ from: 0, usd: 0 }, { from: 100, usd: 0.09 }, { from: 10340, usd: 0.085 }])).toEqual({
      usd: 0.09,
      tiers: [{ fromGb: 0, usd: 0.09 }, { fromGb: 10340, usd: 0.085 }],
    });
    expect(buildTiered([{ from: 0, usd: 0.05 }])).toEqual({ usd: 0.05 });
    expect(buildTiered([{ from: 0, usd: 0 }])).toBeUndefined();
    expect(buildTiered([{ from: 0, usd: 0.05 }, { from: 10, usd: 0.09 }])).toBeUndefined(); // price rising with volume is not a discount schedule
  });
});

describe("AWS normalizer", () => {
  const ec2 = normalizeAws(byFile("aws-AmazonEC2-us-east-1.json").text, byFile("aws-AmazonEC2-us-east-1.json").entry, NO_CTX);
  const dt = normalizeAws(byFile("aws-AWSDataTransfer-us-east-1.json").text, byFile("aws-AWSDataTransfer-us-east-1.json").entry, NO_CTX);
  const obs = (r: typeof ec2, sku: string) => r.observations.find((o) => o.sku === sku);

  it("reads NAT hours and GB, inter-AZ transfer, instance, block storage and snapshot prices", () => {
    expect(obs(ec2, "aws.nat_gateway.hour")).toMatchObject({ usd: 0.045, unit: "hour", region: "us-east-1" });
    expect(obs(ec2, "aws.nat_gateway.gb")).toMatchObject({ usd: 0.045, unit: "gb" });
    expect(obs(ec2, "aws.data_transfer.inter_az_gb")).toMatchObject({ usd: 0.01 });
    expect(obs(ec2, "aws.ec2.small_hour")).toMatchObject({ usd: 0.0208 });
    expect(obs(ec2, "aws.ebs.gp3_gb_month")).toMatchObject({ usd: 0.08 });
    expect(obs(ec2, "aws.ebs.snapshot_gb_month")).toMatchObject({ usd: 0.05 });
  });

  it("reads internet egress as first-paid-tier plus provider volume tiers; the free allowance is not encoded", () => {
    expect(obs(dt, "aws.data_transfer.internet_gb")).toMatchObject({
      usd: 0.09,
      tiers: [{ fromGb: 0, usd: 0.09 }, { fromGb: 10340, usd: 0.085 }, { fromGb: 51540, usd: 0.07 }, { fromGb: 153940, usd: 0.05 }],
    });
  });

  it("resolves destination-dependent inter-region transfer to the most common rate", () => {
    expect(obs(dt, "aws.data_transfer.inter_region_gb")?.usd).toBe(0.02);
  });

  it("does not report rules for offers the file is not (nothing for AmazonEC2 appears in the transfer file)", () => {
    expect(dt.observations.some((o) => o.sku.startsWith("aws.nat_gateway"))).toBe(false);
  });

  it("skips what it cannot find instead of guessing, and rejects other-region or non-JSON input", () => {
    expect(ec2.skipped.some((s) => s.sku === "aws.ec2.medium_hour" && /no matching price/.test(s.reason))).toBe(true);
    const entry = { ...byFile("aws-AmazonEC2-us-east-1.json").entry, region: "eu-west-1" };
    expect(normalizeAws(byFile("aws-AmazonEC2-us-east-1.json").text, entry, NO_CTX).observations).toEqual([]);
    expect(normalizeAws("not json", entry, NO_CTX).skipped[0]?.reason).toMatch(/not valid JSON/);
  });

  it("refuses an unexpected price unit", () => {
    const text = byFile("aws-AmazonEC2-us-east-1.json").text.replace(/"unit": "Hrs"/g, '"unit": "Fortnights"');
    const out = normalizeAws(text, byFile("aws-AmazonEC2-us-east-1.json").entry, NO_CTX);
    expect(out.observations.some((o) => o.sku === "aws.nat_gateway.hour")).toBe(false);
    expect(out.skipped.find((s) => s.sku === "aws.nat_gateway.hour")?.reason).toMatch(/unexpected price unit/);
  });
});

describe("GCP, Azure and OCI normalizers", () => {
  it("GCP reads egress tiers, inter-zone, inter-region, NAT hours and GB for the file region only", () => {
    const f = byFile("gcp-Networking-us-central1.json");
    const out = normalizeGcp(f.text, f.entry, NO_CTX);
    const get = (sku: string) => out.observations.find((o) => o.sku === sku);
    expect(get("gcp.network.internet_gb")).toMatchObject({ usd: 0.12, tiers: [{ fromGb: 0, usd: 0.12 }, { fromGb: 10240, usd: 0.11 }, { fromGb: 153600, usd: 0.08 }] });
    expect(get("gcp.network.inter_az_gb")?.usd).toBe(0.01);
    expect(get("gcp.network.inter_region_gb")?.usd).toBe(0.02);
    expect(get("gcp.cloud_nat.hour")?.usd).toBe(0.044);
    expect(get("gcp.cloud_nat.gb")?.usd).toBe(0.045);
    expect(normalizeGcp(f.text, { ...f.entry, region: "europe-west1" }, NO_CTX).observations).toEqual([]);
  });

  it("Azure ignores other currencies, reads egress tiers and IPv4, and refuses an ambiguous meter", () => {
    const bw = byFile("azure-Bandwidth-eastus.json");
    const out = normalizeAzure(bw.text, bw.entry, NO_CTX);
    expect(out.observations.find((o) => o.sku === "azure.bandwidth.internet_gb")).toMatchObject({ usd: 0.087, tiers: [{ fromGb: 0, usd: 0.087 }, { fromGb: 10100, usd: 0.083 }, { fromGb: 40100, usd: 0.07 }] });
    const nat = byFile("azure-NATGateway-eastus.json");
    const natOut = normalizeAzure(nat.text, nat.entry, NO_CTX);
    expect(natOut.observations.find((o) => o.sku === "azure.public_ip.hour")?.usd).toBe(0.005);
    expect(natOut.observations.find((o) => o.sku === "azure.nat_gateway.gb")?.usd).toBe(0.045);
    expect(natOut.observations.some((o) => o.sku === "azure.nat_gateway.hour")).toBe(false);
    expect(natOut.skipped.find((s) => s.sku === "azure.nat_gateway.hour")?.reason).toMatch(/ambiguous/);
  });

  it("OCI emits global prices for every catalog region and converts per-10,000 requests", () => {
    const f = byFile("oci-price-list.json");
    const out = normalizeOci(f.text, f.entry, NO_CTX);
    const regions = out.observations.filter((o) => o.sku === "oci.object_storage.storage_gb_month").map((o) => o.region).sort();
    expect(regions).toEqual(["ap-mumbai-1", "us-ashburn-1"]);
    expect(out.observations.find((o) => o.sku === "oci.object_storage.get_million")?.usd).toBeCloseTo(0.34, 10);
    expect(out.observations.find((o) => o.sku === "oci.network.internet_gb")).toMatchObject({ usd: 0.0085 });
  });
});

describe("applyRefresh and the refresh pipeline", () => {
  const out = refreshFromSnapshots({ base, snapshots: loaded(), version: "2026-10-07.1" });

  it("produces a valid, newer, dated catalog that records its snapshot files with checksums", () => {
    expect(out.catalog.version).toBe("2026-10-07.1");
    expect(parseCatalog(JSON.parse(JSON.stringify(out.catalog)))).toEqual(out.catalog);
    expect(out.catalog.snapshots).toHaveLength(7);
    for (const s of out.catalog.snapshots!) expect(s.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(out.catalog.sources.length).toBeGreaterThan(base.sources.length);
    expect(out.catalog.sources.at(-1)?.source).toMatch(/transcribed/i);
  });

  it("does not mutate the previous catalog", () => {
    expect(base.version).toBe("2026-10-05.2");
    expect(base.snapshots).toBeUndefined();
  });

  it("adds egress volume tiers and marks the refreshed entry as official_api with provenance in its note", () => {
    const e = out.catalog.entries.find((x) => x.sku === "aws.data_transfer.internet_gb" && x.region === "us-east-1")!;
    expect(e.tiers).toHaveLength(4);
    expect(e.verification).toBe("official_api");
    expect(e.note).toMatch(/Refreshed 2026-10-06/);
    expect(e.note).toMatch(/Snapshot sha256 [0-9a-f]{16}/);
  });

  it("adds a cost-model SKU the base catalog lacked (inter-AZ) and counts it as added", () => {
    expect(out.report.added.some((a) => a.sku === "aws.data_transfer.inter_az_gb" && a.region === "us-east-1")).toBe(true);
    expect(out.catalog.entries.find((x) => x.sku === "aws.data_transfer.inter_az_gb" && x.region === "us-east-1")?.usd).toBe(0.01);
  });

  it("flags a price jump beyond 50% and keeps the old value instead of applying it", () => {
    const f = out.report.flagged.find((x) => x.sku === "aws.fargate.vcpu_hour");
    expect(f).toMatchObject({ from: 0.04048, to: 0.1, applied: false });
    expect(out.catalog.entries.find((x) => x.sku === "aws.fargate.vcpu_hour" && x.region === "us-east-1")?.usd).toBe(0.04048);
    expect(formatRefreshReport(out.report)).toMatch(/FLAGGED aws\/us-east-1\/aws\.fargate\.vcpu_hour/);
  });

  it("applies a flagged change only when explicitly allowed, and still lists it", () => {
    const allowed = refreshFromSnapshots({ base, snapshots: loaded(), version: "2026-10-07.1", allowLargeChanges: true });
    expect(allowed.catalog.entries.find((x) => x.sku === "aws.fargate.vcpu_hour" && x.region === "us-east-1")?.usd).toBe(0.1);
    expect(allowed.report.flagged.find((x) => x.sku === "aws.fargate.vcpu_hour")?.applied).toBe(true);
  });

  it("keeps un-refreshed entries on their old value and evidence class, and says how many", () => {
    expect(out.report.notRefreshedCount).toBeGreaterThan(300);
    const old = base.entries.find((x) => x.verification === "model_knowledge")!;
    const now = out.catalog.entries.find((x) => x.provider === old.provider && x.region === old.region && x.sku === old.sku)!;
    expect(now.verification).toBe("model_knowledge");
    expect(out.report.weakRemainingCount).toBeGreaterThan(0);
  });

  it("refuses a version that is not newer, an empty refresh, and a snapshot retrieved after the version date", () => {
    expect(() => refreshFromSnapshots({ base, snapshots: loaded(), version: "2026-10-05.2" })).toThrow(/later than/);
    expect(() => refreshFromSnapshots({ base, snapshots: loaded(), version: "2026-10-05.3" })).toThrow(/retrieved after the catalog version date/);
    expect(() => refreshFromSnapshots({ base, snapshots: [], version: "2026-10-07.1" })).toThrow(/No price could be read/);
  });

  it("rejects a unit mismatch and an observation from an unlisted snapshot", () => {
    const snap = loaded()[0]!.entry;
    const real = base.entries.find((e) => e.provider === "aws" && e.region === "us-east-1" && e.sku === "aws.nat_gateway.hour")!;
    const r = applyRefresh({
      base,
      snapshots: [snap],
      version: "2026-10-07.1",
      observations: [
        { provider: "aws", region: "us-east-1", sku: real.sku, unit: "gb", usd: 1, note: "x", snapshotSha256: snap.sha256 },
        { provider: "aws", region: "us-east-1", sku: "aws.alb.hour", unit: "hour", usd: 1, note: "x", snapshotSha256: "f".repeat(64) },
        { provider: "aws", region: "us-east-1", sku: "aws.not_a_modeled_sku.hour", unit: "hour", usd: 1, note: "x", snapshotSha256: snap.sha256 },
      ],
    });
    expect(r.report.rejected.map((x) => x.reason)).toEqual(
      expect.arrayContaining([expect.stringMatching(/unit mismatch/), expect.stringMatching(/not come from a listed snapshot/), expect.stringMatching(/not part of the catalog's cost model/)]),
    );
  });

  it("reports which cost dimensions are priced for each provider after the refresh", () => {
    const before = costDimensionCoverage(base);
    const after = costDimensionCoverage(out.catalog);
    const tiers = (c: typeof before, p: string) => c.find((x) => x.provider === p && x.dimension === "internet_egress_volume_tiers")!;
    expect(tiers(before, "aws").status).toBe("not_priced");
    expect(tiers(after, "aws").pricedRegions).toContain("us-east-1");
    expect(tiers(after, "aws").status).toBe("partial"); // only the saved region was refreshed
    const az = (c: typeof before) => c.find((x) => x.provider === "aws" && x.dimension === "inter_az_transfer")!;
    expect(az(before).status).toBe("not_priced");
    expect(az(after).pricedRegions).toEqual(["us-east-1"]);
  });
});

describe("a refreshed catalog flows through the cost engine", () => {
  const out = refreshFromSnapshots({ base, snapshots: loaded(), version: "2026-10-07.1" });
  const graph = { nodes: [node("service/web", "container_service", "aws", "us-east-1", { size: "small", publicIp: true })] };

  it("applies egress volume tiers above the first boundary and states it", () => {
    const small = estimateGraphCost(graph, { catalog: out.catalog, usage: { egressGb: 100 } });
    const huge = estimateGraphCost(graph, { catalog: out.catalog, usage: { egressGb: 20000 } });
    const egress = (e: typeof small) => e.lines.find((l) => l.description === "Internet egress")!;
    expect(egress(small).monthlyUsd).toBe(9); // 100 GB x 0.09
    // 10340 GB x 0.09 + (20000 - 10340) GB x 0.085
    expect(egress(huge).monthlyUsd).toBeCloseTo(10340 * 0.09 + 9660 * 0.085, 2);
    expect(egress(huge).unitUsd).toBeLessThan(0.09);
    expect(egress(huge).basis).toMatch(/volume tiers applied/);
    expect(huge.excluded.join(" ")).toMatch(/egress volume tiers follow the catalog tier schedule/);
    expect(huge.excluded.join(" ")).not.toMatch(/first-tier per-GB price is applied to every GB/);
  });

  it("the bundled catalog (no tiers) keeps its first-tier statement", () => {
    const e = estimateGraphCost(graph, { catalog: base, usage: { egressGb: 20000 } });
    expect(e.excluded.join(" ")).toMatch(/first-tier per-GB price is applied to every GB/);
  });

  it("price book lookups keep working on the refreshed catalog", () => {
    const book = buildPriceBook(out.catalog);
    expect(book.price("aws", "us-east-1", "aws.data_transfer.internet_gb")).toBe(0.09);
  });
});

describe("catalog age and the gated download", () => {
  it("computes catalog age from the newest source retrieval, with the clock passed in", () => {
    expect(catalogAgeDays(base, new Date("2026-10-15T00:00:00Z"))).toBe(10);
  });

  it("the live download refuses unless the opt-in is set, and never calls fetch when closed", async () => {
    const fetchSpy = vi.fn();
    expect(refreshGateOpen({})).toMatchObject({ open: false });
    await expect(
      fetchOfficialSnapshots({ providers: ["oci"], regions: {}, outDir: join(tmpdir(), "zenith-never") }, { env: {}, fetch: fetchSpy as unknown as typeof fetch, today: "2026-10-06" }),
    ).rejects.toMatchObject({ code: "gate" });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("with the gate open (in-memory fetch) it saves files with checksums that the loader accepts", async () => {
    const dir = mkdtempSync(join(tmpdir(), "zenith-fetch-"));
    temps.push(dir);
    const body = readFileSync(join(DIR, "oci-price-list.json"), "utf8");
    const fakeFetch = (async () => new Response(body, { status: 200 })) as unknown as typeof fetch;
    const manifest = await fetchOfficialSnapshots({ providers: ["oci"], regions: {}, outDir: dir }, { env: { ZENITH_LIVE_CATALOG_REFRESH: "1" }, fetch: fakeFetch, today: "2026-10-06" });
    expect(manifest.snapshots).toHaveLength(1);
    expect(loadSnapshotDirectory(dir)[0]!.entry.sha256).toBe(manifest.snapshots[0]!.sha256);
  });

  it("retries a rate-limited price endpoint with bounded backoff, honoring Retry-After, and still refuses a persistent limit", async () => {
    const dir = mkdtempSync(join(tmpdir(), "zenith-fetch-"));
    temps.push(dir);
    const body = readFileSync(join(DIR, "oci-price-list.json"), "utf8");
    const waits: number[] = [];
    let calls = 0;
    const limited = (async () => ++calls <= 2 ? new Response("{}", { status: 429, headers: { "retry-after": "3" } }) : new Response(body, { status: 200 })) as unknown as typeof fetch;
    const env = { ZENITH_LIVE_CATALOG_REFRESH: "1" };
    const manifest = await fetchOfficialSnapshots({ providers: ["oci"], regions: {}, outDir: dir }, { env, fetch: limited, today: "2026-10-06", sleep: async (ms) => { waits.push(ms); } });
    expect(manifest.snapshots).toHaveLength(1); expect(calls).toBe(3); expect(waits).toEqual([3000, 3000]);
    const always = (async () => new Response("{}", { status: 429 })) as unknown as typeof fetch;
    waits.length = 0;
    await expect(fetchOfficialSnapshots({ providers: ["oci"], regions: {}, outDir: dir }, { env, fetch: always, today: "2026-10-06", sleep: async (ms) => { waits.push(ms); } }))
      .rejects.toMatchObject({ code: "format" });
    expect(waits).toHaveLength(6); expect(Math.max(...waits)).toBeLessThanOrEqual(60_000);
  });

  it("refuses a GCP download without an absolute API key file reference", async () => {
    const dir = mkdtempSync(join(tmpdir(), "zenith-fetch-"));
    temps.push(dir);
    const fakeFetch = vi.fn();
    await expect(
      fetchOfficialSnapshots({ providers: ["gcp"], regions: { gcp: ["us-central1"] }, outDir: dir }, { env: { ZENITH_LIVE_CATALOG_REFRESH: "1" }, fetch: fakeFetch as unknown as typeof fetch, today: "2026-10-06" }),
    ).rejects.toMatchObject({ code: "gate" });
    expect(fakeFetch).not.toHaveBeenCalled();
  });
});
