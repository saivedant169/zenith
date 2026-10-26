/**
 * Deriver behaviour on fixtures (PROD-LIFE-02): what makes a cell supported,
 * preview or unsupported, and the negative controls that keep an unproven or
 * unreachable path from ever being advertised as an offered service.
 */
import { describe, expect, it } from "vitest";
import { CAPABILITIES, type CapabilityDef } from "@/lib/capabilities/catalog";
import { deriveOfferedCatalog, type CapabilityFact, type DriverFact } from "@/lib/offered-catalog/derive";
import { DOMAINS, DOMAIN_KINDS, OfferedCatalogSchema, checkCatalogInvariants, type Cell, type Entry } from "@/lib/offered-catalog/schema";
import { NATIVE_TYPE_TABLE } from "@/lib/resources/native-types";
import { PORTABLE_KINDS } from "@/lib/resources/types";

const capabilities: Record<string, CapabilityFact> = {};
for (const [name, def] of Object.entries(CAPABILITIES as Record<string, CapabilityDef>)) {
  capabilities[name] = { name, title: def.title, mutates: def.mutates, risk: def.risk, defaultAutonomy: def.defaultAutonomy };
}

type Overrides = Partial<Omit<DriverFact, "core">> & { core?: Partial<DriverFact["core"]> };
function driver(overrides: Overrides = {}): DriverFact {
  const { core, ...rest } = overrides;
  return {
    driverId: "aws.ecs_service@1",
    provider: "aws",
    nativeType: "aws:ecs_service",
    kind: "container_service",
    registration: "registered",
    experimental: false,
    core: {
      compile: { supported: true, evidence: "emulated" },
      observe: { supported: true, evidence: "emulated" },
      runtime: { supported: false },
      verify: { supported: true, evidence: "emulated" },
      discover: { supported: false },
      ...core,
    },
    operations: [],
    refuses: [],
    ...rest,
  };
}

const derive = (drivers: DriverFact[]) => deriveOfferedCatalog({ nativeTypes: NATIVE_TYPE_TABLE, drivers, capabilities });
const entry = (drivers: DriverFact[], provider: string, kind: string): Entry => {
  const found = derive(drivers).entries.find((e) => e.provider === provider && e.kind === kind);
  if (!found) throw new Error("no entry");
  return found;
};
const lifecycle = (e: Entry, op: "provision" | "observe" | "runtime" | "verify" | "discover"): Cell => (e.lifecycle as Record<string, Cell>)[op];

describe("deriveOfferedCatalog", () => {
  it("is explicit: every provider x portable kind has an entry, even with no drivers at all", () => {
    const catalog = derive([]);
    expect(OfferedCatalogSchema.parse(catalog)).toBeTruthy();
    expect(checkCatalogInvariants(catalog)).toEqual([]);
    expect(catalog.entries).toHaveLength(catalog.providers.length * PORTABLE_KINDS.length);
    expect(catalog.entries.every((e) => e.status === "not_offered" && e.level === "unsupported" && e.reason)).toBe(true);
  });

  it("covers every required domain and places each portable kind exactly once", () => {
    expect([...DOMAINS]).toEqual(["vm", "container", "serverless", "triggers", "jobs", "data", "cache", "storage", "messaging", "network", "firewall", "dns", "tls", "identity", "secrets", "day-two"]);
    const placed = DOMAINS.flatMap((d) => DOMAIN_KINDS[d]);
    expect([...placed].sort()).toEqual([...PORTABLE_KINDS].sort());
    const catalog = derive([]);
    for (const provider of catalog.providers) expect(catalog.rollup.filter((r) => r.provider === provider).map((r) => r.domain)).toEqual([...DOMAINS]);
  });

  it("a compiler name with no driver is a schema-only gap, not an offered service", () => {
    const e = entry([], "aws", "container_service");
    expect(e).toMatchObject({ status: "not_offered", level: "unsupported", nativeType: "aws:ecs_service" });
    expect(e.reason).toMatch(/no resource driver/);
  });

  it("a kind with no native-type row is not offered", () => {
    expect(entry([], "oci", "function").reason).toMatch(/No native type maps function on oci/);
  });

  it("emulator evidence on a registered driver is supported; unimplemented operations are explicit unsupported cells", () => {
    const e = entry([driver()], "aws", "container_service");
    expect(e.status).toBe("offered");
    expect(e.level).toBe("supported");
    expect(lifecycle(e, "provision")).toEqual({ level: "supported", evidence: "emulated" });
    expect(lifecycle(e, "runtime").level).toBe("unsupported");
    expect(lifecycle(e, "runtime").reason).toMatch(/runtime/);
  });

  it("contract-only evidence is preview, never supported", () => {
    const e = entry([driver({ core: { compile: { supported: true, evidence: "contract" } } })], "aws", "container_service");
    expect(lifecycle(e, "provision").level).toBe("preview");
    expect(lifecycle(e, "provision").reason).toMatch(/contract-level only/);
    expect(lifecycle(e, "observe").level).toBe("supported");
  });

  it("an experimental driver is not offered even with emulator evidence", () => {
    const e = entry([driver({ experimental: true })], "aws", "container_service");
    expect(e).toMatchObject({ status: "not_offered", level: "unsupported", experimental: true });
    expect(e.lifecycle).toBeUndefined();
  });

  it("simulated evidence is unsupported", () => {
    const e = entry([driver({ core: { observe: { supported: true, evidence: "simulated" } } })], "aws", "container_service");
    expect(lifecycle(e, "observe")).toMatchObject({ level: "unsupported", evidence: "simulated" });
  });

  it("a flag with no valid evidence level is unsupported, not trusted", () => {
    const e = entry([driver({ core: { observe: { supported: true } } })], "aws", "container_service");
    expect(lifecycle(e, "observe")).toMatchObject({ level: "unsupported", evidence: "undeclared" });
  });

  it.each(["registrable", "module only"] as const)("a driver that is %s but not registered is unreachable, so unsupported", (registration) => {
    const e = entry([driver({ registration })], "aws", "container_service");
    expect(e.level).toBe("unsupported");
    expect(e.reason).toMatch(/nothing/);
    expect(e.registration).toBe(registration);
  });

  it("day-two operations: executable gets a level, refusal-only is unsupported, undeclared is unsupported", () => {
    const rds = driver({
      driverId: "aws.rds_instance@1",
      nativeType: "aws:rds_instance",
      kind: "postgres",
      operations: [{ capability: "database.snapshot", evidence: "emulated" }],
      refuses: [{ capability: "database.delete", evidence: "contract" }],
    });
    const catalog = derive([rds]);
    expect(catalog.dayTwoOperations.map((o) => o.name)).toEqual(["database.delete", "database.snapshot"]);
    const e = catalog.entries.find((x) => x.provider === "aws" && x.kind === "postgres") as Entry;
    expect(e.dayTwo?.["database.snapshot"]?.level).toBe("supported");
    expect(e.dayTwo?.["database.delete"]).toMatchObject({ level: "unsupported", reason: expect.stringMatching(/Refusal-only/) });
    // the same native type realizes mysql; the driver is declared for postgres, so mysql is capped at preview
    const mysql = catalog.entries.find((x) => x.provider === "aws" && x.kind === "mysql") as Entry;
    expect(mysql.dayTwo?.["database.snapshot"]?.level).toBe("preview");
    expect(mysql.dayTwo?.["database.snapshot"]?.reason).toMatch(/shared with kind postgres/);
  });

  it("the sandbox simulation is never offered, whatever drivers exist", () => {
    const sandbox = driver({ driverId: "sandbox.vpc@1", provider: "sandbox", nativeType: "sandbox:network", kind: "network" });
    const e = entry([sandbox], "sandbox", "network");
    expect(e).toMatchObject({ status: "not_offered", level: "unsupported" });
    expect(e.reason).toMatch(/simulation/);
  });

  it("fails loudly on unknown day-two capabilities and duplicate drivers", () => {
    expect(() => derive([driver({ operations: [{ capability: "made.up", evidence: "contract" }] })])).toThrow(/not in the capability catalog/);
    expect(() => derive([driver(), driver({ driverId: "aws.other@1" })])).toThrow(/Two drivers claim/);
  });

  it("reports drivers no portable kind maps to as unmapped, not offered", () => {
    const orphan = driver({ driverId: "aws.mystery@1", nativeType: "aws:mystery", kind: "provider_native" });
    const catalog = derive([orphan]);
    expect(catalog.unmappedDrivers).toEqual([expect.objectContaining({ driverId: "aws.mystery@1", provider: "aws" })]);
    expect(catalog.entries.every((e) => e.driverId !== "aws.mystery@1")).toBe(true);
  });

  it("triggers has no portable kind and rolls up unsupported with a reason", () => {
    const catalog = derive([driver()]);
    const triggers = catalog.rollup.filter((r) => r.domain === "triggers");
    expect(triggers).toHaveLength(catalog.providers.length);
    for (const r of triggers) expect(r).toMatchObject({ level: "unsupported", reason: expect.stringMatching(/trigger/) });
  });

  it("is deterministic and independent of driver order", () => {
    const a = driver();
    const b = driver({ driverId: "aws.s3_bucket@1", nativeType: "aws:s3_bucket", kind: "object_store" });
    expect(derive([a, b])).toEqual(derive([b, a]));
  });

  it("changes the version whenever any cell changes", () => {
    const base = derive([driver()]);
    const changed = derive([driver({ core: { observe: { supported: true, evidence: "contract" } } })]);
    expect(changed.contentDigest).not.toBe(base.contentDigest);
    expect(changed.catalogVersion).not.toBe(base.catalogVersion);
    expect(base.catalogVersion).toMatch(/^v1-[0-9a-f]{12}$/);
  });

  it("detects tampering: a promoted cell, a stale digest and a dropped entry all fail the invariants", () => {
    const base = derive([driver()]);
    const cloned = (): typeof base => JSON.parse(JSON.stringify(base)) as typeof base;

    const promoted = cloned();
    const e = promoted.entries.find((x) => x.status === "offered") as Entry;
    (e.lifecycle as Record<string, Cell>).runtime = { level: "supported" };
    expect(checkCatalogInvariants(promoted).join("\n")).toMatch(/contentDigest|rollup/);

    const dropped = cloned();
    dropped.entries.pop();
    expect(checkCatalogInvariants(dropped).join("\n")).toMatch(/missing explicit entry/);

    const badVersion = cloned();
    badVersion.catalogVersion = "v1-000000000000";
    expect(checkCatalogInvariants(badVersion).join("\n")).toMatch(/catalogVersion/);
  });

  it("the schema rejects an unsupported cell without a reason and a not_offered entry with cells", () => {
    const base = derive([driver()]);
    const bad = JSON.parse(JSON.stringify(base)) as typeof base;
    const offered = bad.entries.find((x) => x.status === "offered") as Entry;
    (offered.lifecycle as Record<string, Cell>).runtime = { level: "unsupported" };
    expect(OfferedCatalogSchema.safeParse(bad).success).toBe(false);
    const bad2 = JSON.parse(JSON.stringify(base)) as typeof base;
    const gap = bad2.entries.find((x) => x.status === "not_offered") as Entry;
    gap.lifecycle = {};
    expect(OfferedCatalogSchema.safeParse(bad2).success).toBe(false);
  });
});
