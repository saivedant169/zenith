/**
 * PROD-COST-01 engine-level acceptance, local and offline: the operator's real
 * refresh (`scripts/cost/refresh-catalog.ts apply`) and dry-run
 * (`src/lib/cost/catalog-dry-run-cli.ts`) commands run as subprocesses on the
 * committed price-snapshot fixtures, and the written catalog is loaded through
 * the product's own `parseCatalog`. Nothing is mocked or downloaded.
 *
 * CONTRACT-LEVEL INPUT: the fixtures are hand-built in each provider's file
 * shape (see fixtures/price-snapshots/README.md), not provider downloads. This
 * proves the pipeline mechanics, not current provider prices.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { compareEstimateToActual, forecastFromActual, isActualSpend, isEstimate, isForecast, newActualSpend } from "@/lib/cost/kinds";
import { readSpendView, type SpendDeps } from "@/lib/cost/spend-service";
import { catalogSnapshotAt, estimateGraphCost, loadDefaultCatalog, parseCatalog } from "@/lib/placement";
import type { PriceCatalog } from "@/lib/placement/types";
import { node } from "../placement/fixtures";

const ROOT = process.cwd();
const FIXTURES = join(ROOT, "tests/cost/fixtures/price-snapshots");
const TSX = join(ROOT, "node_modules/tsx/dist/cli.mjs");
const VERSION = "2026-10-07.1";
const WEAK = ["model_knowledge", "derived", "internal_assumption"];
const key = (e: { provider: string; region: string; sku: string }) => `${e.provider}|${e.region}|${e.sku}`;

function run(script: string, args: string[]) {
  const r = spawnSync(process.execPath, [TSX, join(ROOT, script), ...args], { cwd: ROOT, encoding: "utf8", timeout: 120_000, env: { ...process.env, ZENITH_LIVE_CATALOG_REFRESH: "", NODE_OPTIONS: "" } });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
}

const baseline = loadDefaultCatalog();
let dir: string;
let snapshots: string;
let refreshed: PriceCatalog;
let refreshedFile: string;
let applied: ReturnType<typeof run>;
let dry: ReturnType<typeof run>;
let held: ReturnType<typeof run>;
let heldCatalog: PriceCatalog;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "zenith-cost01-"));
  snapshots = join(dir, "snapshots");
  cpSync(FIXTURES, snapshots, { recursive: true });
  refreshedFile = join(dir, "candidate.json");
  dry = run("src/lib/cost/catalog-dry-run-cli.ts", [snapshots, VERSION]);
  held = run("scripts/cost/refresh-catalog.ts", ["apply", "--snapshots", snapshots, "--version", VERSION, "--out", join(dir, "held.json")]);
  applied = run("scripts/cost/refresh-catalog.ts", ["apply", "--snapshots", snapshots, "--version", VERSION, "--out", refreshedFile, "--allow-large-changes"]);
  refreshed = parseCatalog(JSON.parse(readFileSync(refreshedFile, "utf8")));
  heldCatalog = parseCatalog(JSON.parse(readFileSync(join(dir, "held.json"), "utf8")));
}, 180_000);

afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("operator refresh on the committed snapshots", () => {
  it("dry run reviews the candidate, exits 2 on held large changes and writes nothing", () => {
    expect(dry.code).toBe(2);
    expect(dry.out).toMatch(/Dry run only\. \d+ unmatched targets; no catalog adopted or written\./);
    expect(dry.out).toMatch(/FLAGGED aws\/us-east-1\/aws\.fargate\.vcpu_hour/);
    expect(readdirSync(snapshots).sort()).toEqual(readdirSync(FIXTURES).sort());
  });

  it("apply holds a flagged jump by default and applies it only with --allow-large-changes", () => {
    expect(held.code).toBe(2);
    expect(applied.code).toBe(0);
    const usd = (c: PriceCatalog) => c.entries.find((e) => key(e) === "aws|us-east-1|aws.fargate.vcpu_hour")!.usd;
    expect(usd(heldCatalog)).toBe(0.04048);
    expect(usd(refreshed)).toBe(0.1);
  });

  it("(a) the refreshed catalog has a newer date and a different digest than the committed baseline", () => {
    const digest = (c: PriceCatalog) => createHash("sha256").update(JSON.stringify(c)).digest("hex");
    expect(baseline.version).toBe("2026-10-05.2");
    expect(refreshed.version).toBe(VERSION);
    expect(catalogSnapshotAt(refreshed) > catalogSnapshotAt(baseline)).toBe(true);
    expect(digest(refreshed)).not.toBe(digest(baseline));
    expect(createHash("sha256").update(readFileSync(refreshedFile)).digest("hex")).toMatch(/^[0-9a-f]{64}$/);
    expect(refreshed.snapshots).toHaveLength(7);
    expect(baseline.snapshots).toBeUndefined();
  });

  it("(b) weak or placeholder baseline entries are replaced by source-backed values with a source URL and date", () => {
    const after = new Map(refreshed.entries.map((e) => [key(e), e]));
    const replaced = baseline.entries.filter((e) => WEAK.includes(e.verification ?? "") && ["official_api", "official_page"].includes(after.get(key(e))?.verification ?? ""));
    expect(replaced.length).toBeGreaterThan(0);
    for (const was of replaced) {
      const now = after.get(key(was))!;
      expect(now.usd).toBeGreaterThan(0);
      const date = /Refreshed (\d{4}-\d{2}-\d{2})/.exec(now.note ?? "")?.[1];
      expect(date).toBeDefined();
      const source = refreshed.sources.find((s) => s.provider === now.provider && s.verification === now.verification && s.retrievedAt === date)!;
      expect(source).toBeDefined();
      expect(source.url).toMatch(/^https:\/\//);
      expect(source.retrievedAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(source.retrievedAt <= VERSION.split(".")[0]!).toBe(true);
      expect(refreshed.snapshots!.some((s) => s.provider === now.provider && s.retrievedAt === source.retrievedAt && /^[0-9a-f]{64}$/.test(s.sha256))).toBe(true);
    }
    // entries the fixtures do not cover keep their weak class instead of being relabelled
    const untouched = refreshed.entries.filter((e) => WEAK.includes(e.verification ?? ""));
    expect(untouched.length).toBeGreaterThan(0);
  });
});

describe("(c) estimate, forecast and actual spend stay distinct on the refreshed catalog", () => {
  const graph = { nodes: [node("service/web", "container_service", "aws", "us-east-1", { size: "small", publicIp: true })] };
  const now = new Date("2026-10-11T12:00:00.000Z");

  it("builds three kinds from the refreshed catalog and never converts one into another", async () => {
    const estimate = estimateGraphCost(graph, { catalog: refreshed });
    const actual = newActualSpend({
      provider: "aws",
      scope: "123456789012",
      periodStart: "2026-10-01",
      periodEnd: "2026-11-01",
      totalUsd: 100,
      lines: [{ service: "Amazon Elastic Compute Cloud - Compute", usd: 100 }],
      costBasis: "test",
      finalization: "provisional",
      source: { adapter: "test", endpoint: "https://example.invalid/", retrievedAt: now.toISOString(), responseSha256: "c".repeat(64) },
    });
    const forecast = forecastFromActual(actual, now.toISOString());
    expect(estimate.catalogVersion).toBe(VERSION);
    expect([estimate.kind, forecast.kind, actual.kind]).toEqual(["estimate", "forecast", "actual_spend"]);
    expect(isEstimate(estimate) && !isForecast(estimate) && !isActualSpend(estimate)).toBe(true);
    expect(isForecast(forecast) && !isEstimate(forecast) && !isActualSpend(forecast)).toBe(true);
    expect(forecast.basedOn.responseSha256).toBe(actual.source.responseSha256);
    expect(compareEstimateToActual(estimate, actual)).toMatchObject({ kind: "estimate_vs_actual", estimateCatalogVersion: VERSION, actualUsd: 100 });

    const deps: SpendDeps = {
      environment: async () => ({ id: "env-a", projectId: "proj-a" }),
      connectionConfig: async () => null,
      latestEstimate: async () => estimate,
      listActualSpend: async () => [{ id: "s1", snapshot: actual, recordedAt: now.toISOString() }],
      saveActualSpend: async () => {
        throw new Error("not expected");
      },
      liveReader: async () => {
        throw new Error("no live billing read in an offline test");
      },
      now: () => now,
      env: {},
    };
    const view = await readSpendView(deps, "ws-a", "env-a");
    expect(view.estimate?.kind).toBe("estimate");
    expect(view.estimate?.catalogVersion).toBe(VERSION);
    expect(view.actualSpend.map((a) => a.kind)).toEqual(["actual_spend"]);
    expect(view.forecast?.kind).toBe("forecast");
    expect(view.forecast?.floorUsd).toBe(100);
    expect(view.disclosure).toMatchObject({ isBillingCap: false });
  });
});
