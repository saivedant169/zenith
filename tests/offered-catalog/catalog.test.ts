/**
 * The committed offered capability catalog is derived from the real compiler
 * vocabulary and the real resource drivers, and fails when they disagree
 * (PROD-LIFE-02). The drift check is run both as the real CLI in a fresh
 * process and in-process.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ResourceDriver } from "@/lib/drivers/types";
import {
  OFFERED_CATALOG_PATH,
  getOfferedCatalog,
  offeredCatalogSummary,
  offeredSupport,
  parseCatalogFilter,
  queryOfferedCatalog,
  OfferedCatalogSchema,
  EntrySchema,
  checkCatalogInvariants,
  DOMAINS,
  PROVIDER_ORDER,
  LIFECYCLE_OPS,
  type Cell,
  type Entry,
} from "@/lib/offered-catalog";
import { NATIVE_TYPE_TABLE } from "@/lib/resources/native-types";
import { PORTABLE_KINDS } from "@/lib/resources/types";
import { deriveCurrentCatalog, renderCatalog } from "../../scripts/docs/offered-catalog";

const ROOT = path.resolve(__dirname, "..", "..");

type RegistryGlobal = typeof globalThis & { __zenithDrivers?: Map<string, ResourceDriver> };
afterEach(() => {
  // deriving registers the real drivers into the process-wide registry; start every test empty
  (globalThis as RegistryGlobal).__zenithDrivers?.clear();
});

const cells = (e: Entry): Cell[] => [...Object.values(e.lifecycle ?? {}), ...Object.values(e.dayTwo ?? {})] as Cell[];

describe("experimental AWS drivers are labelled in the offered catalog", () => {
  it.each(["aws:lambda_function", "aws:ec2_instance"])("%s is preview and says it is experimental", (nativeType) => {
    const entries = getOfferedCatalog().entries.filter((e) => e.nativeType === nativeType);
    expect(entries.length).toBeGreaterThan(0);
    for (const entry of entries) {
      expect(entry.experimental).toBe(true);
      expect(entry.level).toBe("preview");
      expect(entry.reason).toContain("The driver is experimental.");
    }
  });
});

describe("the committed offered capability catalog", () => {
  it("is exactly what `scripts/docs/offered-catalog.ts --check` accepts (run as the real CLI)", () => {
    const tsx = path.join(ROOT, "node_modules", "tsx", "dist", "cli.mjs");
    const result = spawnSync(process.execPath, [tsx, path.join("scripts", "docs", "offered-catalog.ts"), "--check"], { cwd: ROOT, encoding: "utf8", timeout: 120_000 });
    const unexpected = result.stderr.split("\n").map((l) => l.trim()).filter((l) => l !== "" && !l.startsWith("problem: "));
    expect({ status: result.status, unexpected }).toEqual({ status: 0, unexpected: [] });
    expect(result.stdout).toContain("is up to date");
  }, 150_000);

  it("equals the in-process derivation from the live drivers, byte for byte", async () => {
    const { catalog } = await deriveCurrentCatalog({ repoRoot: ROOT });
    const committed = fs.readFileSync(path.join(ROOT, OFFERED_CATALOG_PATH), "utf8").replace(/\r\n/g, "\n");
    expect(committed).toBe(renderCatalog(catalog));
  });

  it("parses against the schema and satisfies every structural invariant", () => {
    const catalog = getOfferedCatalog();
    expect(OfferedCatalogSchema.safeParse(JSON.parse(JSON.stringify(catalog))).success).toBe(true);
    expect(checkCatalogInvariants(catalog)).toEqual([]);
    expect(catalog.catalogVersion).toBe(`v${catalog.schemaVersion}-${catalog.contentDigest.slice(0, 12)}`);
  });

  it("is an explicit matrix: every provider x portable kind, every domain, every lifecycle operation", () => {
    const catalog = getOfferedCatalog();
    expect(catalog.providers).toEqual([...PROVIDER_ORDER]);
    for (const provider of PROVIDER_ORDER) {
      for (const kind of PORTABLE_KINDS) {
        const e = catalog.entries.filter((x) => x.provider === provider && x.kind === kind);
        expect(e, `${provider}/${kind}`).toHaveLength(1);
        if (e[0].status === "offered") for (const op of LIFECYCLE_OPS) expect((e[0].lifecycle as Record<string, Cell>)[op], `${provider}/${kind}/${op}`).toBeDefined();
      }
      expect(catalog.rollup.filter((r) => r.provider === provider).map((r) => r.domain)).toEqual([...DOMAINS]);
    }
  });

  it("every non-supported cell and entry says why", () => {
    for (const e of getOfferedCatalog().entries) {
      if (e.level !== "supported") expect(e.reason, `${e.provider}/${e.kind}`).toBeTruthy();
      for (const c of cells(e)) if (c.level !== "supported") expect(c.reason).toBeTruthy();
    }
  });

  it("refuses preview entries without a rationale and retains their actual lifecycle limits", async () => {
    const { catalog } = await deriveCurrentCatalog({ repoRoot: ROOT });
    const entry = catalog.entries.find((e) => e.provider === "aws" && e.kind === "network");
    if (!entry) throw new Error("The existing AWS network entry is missing.");
    expect(entry.level).toBe("preview");
    expect(entry.lifecycle?.provision?.level).toBe("preview");
    expect(entry.lifecycle?.runtime?.level).toBe("unsupported");
    expect(entry.reason).toMatch(/contract-level only/);
    expect(EntrySchema.safeParse(entry).success).toBe(true);
    expect(EntrySchema.safeParse({ ...entry, reason: undefined }).success).toBe(false);
    expect(EntrySchema.safeParse({ ...entry, reason: "" }).success).toBe(false);
    for (const preview of catalog.entries.filter((e) => e.level === "preview")) {
      const reasons = cells(preview).filter((c) => c.level === "preview").map((c) => c.reason);
      expect(reasons.length).toBeGreaterThan(0);
      for (const reason of reasons) {
        if (!reason) throw new Error("A preview cell lost its evidence rationale.");
        expect(preview.reason).toContain(reason);
      }
    }
  });

  it("never offers more than the code proves: supported needs emulator or live evidence, a registered driver and no experimental flag", () => {
    for (const e of getOfferedCatalog().entries) {
      for (const c of cells(e)) {
        if (c.level === "supported") {
          expect(["emulated", "real"]).toContain(c.evidence);
          expect(e.registration).toBe("registered");
          expect(e.experimental).not.toBe(true);
        }
        if (c.evidence === "simulated" || c.evidence === "undeclared") expect(c.level).toBe("unsupported");
      }
      if (e.registration !== undefined && e.registration !== "registered") expect(e.level).toBe("unsupported");
    }
  });

  it("schema-only, simulated and mock-only paths are not offered services", () => {
    const catalog = getOfferedCatalog();
    for (const e of catalog.entries.filter((x) => x.provider === "sandbox")) expect(e).toMatchObject({ status: "not_offered", level: "unsupported" });
    // every compiler name without a driver is not_offered; every offered entry names the driver that backs it
    for (const e of catalog.entries) {
      if (e.status === "not_offered") expect(e.driverId).toBeUndefined();
      else expect(e.driverId).toMatch(/@\d+$/);
      if (e.nativeType) expect(NATIVE_TYPE_TABLE[e.provider][e.kind]).toBe(e.nativeType);
    }
  });

  it("refusal-only handlers are unsupported operations, not offered ones", () => {
    const rds = getOfferedCatalog().entries.find((e) => e.provider === "aws" && e.kind === "postgres") as Entry;
    for (const op of ["database.delete", "database.restore"]) {
      expect(rds.dayTwo?.[op], op).toMatchObject({ level: "unsupported", reason: expect.stringMatching(/Refusal-only/) });
    }
  });

  it("states honestly that triggers are not modelled and that nothing is yet supported on contract-only evidence", () => {
    const catalog = getOfferedCatalog();
    for (const r of catalog.rollup.filter((x) => x.domain === "triggers")) expect(r.level).toBe("unsupported");
    // today's evidence is contract-level; if a driver is ever promoted this expectation should be changed on purpose
    expect(catalog.entries.filter((e) => cells(e).some((c) => c.evidence === "real"))).toEqual([]);
  });
});

describe("catalog read helpers", () => {
  it("queries narrow and never widen", () => {
    const all = queryOfferedCatalog();
    expect(all.length).toBe(PROVIDER_ORDER.length * PORTABLE_KINDS.length);
    const aws = queryOfferedCatalog({ provider: "aws" });
    expect(aws.every((e) => e.provider === "aws")).toBe(true);
    const awsData = queryOfferedCatalog({ provider: "aws", domain: "data" });
    expect(awsData.map((e) => e.kind).sort()).toEqual(["mysql", "postgres"]);
    expect(queryOfferedCatalog({ provider: "aws", kind: "postgres", level: "supported" })).toEqual([]);
  });

  it("parses filters and names the bad field without echoing its value", () => {
    const params = (q: string) => new URLSearchParams(q);
    expect(parseCatalogFilter(params("provider=aws&domain=data&level=preview&kind=postgres"))).toEqual({ ok: true, filter: { provider: "aws", domain: "data", level: "preview", kind: "postgres" } });
    for (const [q, field] of [["provider=nope", "provider"], ["domain=nope", "domain"], ["level=nope", "level"], ["kind=nope", "kind"]] as const) {
      const out = parseCatalogFilter(params(q));
      expect(out.ok).toBe(false);
      if (!out.ok) {
        expect(out.error).toContain(field);
        expect(out.error).not.toContain("nope");
      }
    }
  });

  it("summarises rollups and counts, and answers unknown combinations as unsupported", () => {
    const summary = offeredCatalogSummary();
    expect(summary.providers.map((p) => p.provider)).toEqual([...PROVIDER_ORDER]);
    for (const p of summary.providers) {
      expect(p.domains.map((d) => d.domain)).toEqual([...DOMAINS]);
      expect(p.counts.supported + p.counts.preview + p.counts.unsupported).toBe(PORTABLE_KINDS.length);
    }
    expect(offeredSupport("aws", "postgres", "provision").level).toBe("preview");
    expect(offeredSupport("aws", "postgres", "no.such.operation")).toMatchObject({ level: "unsupported" });
    expect(offeredSupport("sandbox", "network", "observe").level).toBe("unsupported");
    expect(offeredSupport("sandbox", "network").reason).toMatch(/simulation/);
  });
});
