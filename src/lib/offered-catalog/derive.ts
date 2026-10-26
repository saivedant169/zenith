/**
 * Derive the offered capability catalog from what the code declares
 * (PROD-LIFE-02). Pure: callers supply the compiler vocabulary and the resource
 * drivers' own declarations (the generator script loads the real drivers; tests
 * pass fixtures). Nothing here is hand-asserted about a provider.
 *
 * Inputs and what each decides:
 *   nativeTypes   `NATIVE_TYPE_TABLE`: which (provider, kind) the compiler can
 *                 even name. A missing row is `not_offered`.
 *   drivers       each driver's `capabilities` (compile/observe/runtime/verify/
 *                 discover flags, executable `operations`, refusal-only
 *                 `refuses`, per-operation evidence, `experimental`) plus how
 *                 it is registered. A flag with no evidence, simulated evidence,
 *                 an unregistered driver or a refusal-only handler is never
 *                 `supported`.
 *   capabilities  the capability catalog, for day-two operation metadata.
 */
import type { PortableKind, ProviderKey } from "@/lib/resources/types";
import { PORTABLE_KINDS } from "@/lib/resources/types";
import {
  DOMAINS,
  DOMAIN_DESCRIPTIONS,
  DOMAIN_KINDS,
  LEVEL_POLICY,
  LIFECYCLE_DRIVER_FLAG,
  LIFECYCLE_OPS,
  OFFERED_CATALOG_SCHEMA_VERSION,
  PROVIDER_ORDER,
  bestLevel,
  catalogContentDigest,
  catalogVersionFor,
  rollupFor,
  type Cell,
  type Domain,
  type Entry,
  type LifecycleOp,
  type OfferedCatalog,
  type SupportLevel,
} from "./schema";

type Evidence = "real" | "emulated" | "contract" | "simulated" | "undeclared";

/** The subset of a driver row the deriver reads; `DriverRow` from the matrix generator satisfies it. */
export interface DriverFact {
  driverId: string;
  provider: string;
  nativeType: string;
  kind: string;
  registration: "registered" | "registrable" | "module only";
  experimental: boolean;
  core: Record<"compile" | "observe" | "runtime" | "verify" | "discover", { supported: boolean; evidence?: string }>;
  operations: readonly { capability: string; evidence: string }[];
  refuses: readonly { capability: string; evidence: string }[];
}

export interface CapabilityFact {
  name: string;
  title: string;
  mutates: boolean;
  risk: "low" | "medium" | "high" | "critical";
  defaultAutonomy: number;
}

export interface DeriveInput {
  nativeTypes: Readonly<Record<ProviderKey, Readonly<Partial<Record<PortableKind, string>>>>>;
  drivers: readonly DriverFact[];
  capabilities: Readonly<Record<string, CapabilityFact>>;
}

const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const asEvidence = (value: string | undefined): Evidence => (value === "real" || value === "emulated" || value === "contract" || value === "simulated" ? value : "undeclared");

const NOT_IMPLEMENTED: Record<LifecycleOp, string> = {
  provision: "The driver has no OpenTofu compile(); this provider applies through its own native apply path, which this catalog does not attest per kind.",
  observe: "The driver does not implement observe.",
  runtime: "The driver does not implement runtime state reads.",
  verify: "The driver does not implement verify.",
  discover: "The driver does not implement discovery.",
};

/** The level and reason for one implemented operation, from its evidence and the driver's standing. */
function implementedCell(evidence: Evidence, driver: DriverFact, sharedWith: string | undefined): Cell {
  if (driver.registration !== "registered") {
    return {
      level: "unsupported",
      evidence,
      reason: driver.registration === "registrable" ? "The driver exists but nothing in the application registers it, so no operation can reach it." : "The driver is only a module; nothing registers it, so no operation can reach it.",
    };
  }
  if (evidence === "simulated") return { level: "unsupported", evidence, reason: "Evidence is simulated (generated data); a simulated path is not an offered service." };
  if (evidence === "undeclared") return { level: "unsupported", evidence, reason: "The driver declares no valid evidence level for this operation." };
  const caveats: string[] = [];
  if (evidence === "contract") caveats.push("Evidence is contract-level only (mocked SDK or HTTP tests); no emulator or live-account acceptance run.");
  if (sharedWith !== undefined) caveats.push(`The native type is shared with kind ${sharedWith}; the driver is declared for ${sharedWith} and disambiguates by spec.`);
  if (caveats.length > 0) return { level: "preview", evidence, reason: caveats.join(" ") };
  return { level: "supported", evidence };
}

function offeredEntry(provider: ProviderKey, kind: PortableKind, domain: Domain, nativeType: string, driver: DriverFact, dayTwoNames: readonly string[]): Entry {
  // Beta (2026-10-26): an experimental driver is not offered to customers, whatever its evidence. The driver's own flag decides.
  if (driver.experimental) {
    return { provider, kind, domain, status: "not_offered", level: "unsupported", nativeType, experimental: true, reason: "The driver is experimental and is not offered in the private beta." };
  }
  const sharedWith = (PORTABLE_KINDS as readonly string[]).includes(driver.kind) && driver.kind !== kind ? driver.kind : undefined;
  const lifecycle: Partial<Record<LifecycleOp, Cell>> = {};
  for (const op of LIFECYCLE_OPS) {
    const core = driver.core[LIFECYCLE_DRIVER_FLAG[op]];
    lifecycle[op] = core.supported ? implementedCell(asEvidence(core.evidence), driver, sharedWith) : { level: "unsupported", reason: NOT_IMPLEMENTED[op] };
  }
  const executable = new Map(driver.operations.map((o) => [o.capability, o]));
  const refused = new Map(driver.refuses.map((o) => [o.capability, o]));
  const dayTwo: Record<string, Cell> = {};
  for (const name of dayTwoNames) {
    const run = executable.get(name);
    const refusal = refused.get(name);
    if (run !== undefined) dayTwo[name] = implementedCell(asEvidence(run.evidence), driver, sharedWith);
    else if (refusal !== undefined) dayTwo[name] = { level: "unsupported", evidence: asEvidence(refusal.evidence), reason: "Refusal-only: the handler declines to execute this operation." };
    else dayTwo[name] = { level: "unsupported", reason: "The driver does not declare this operation." };
  }
  const cells = [...Object.values(lifecycle), ...Object.values(dayTwo)] as Cell[];
  const level = bestLevel(cells.map((c) => c.level));
  const entry: Entry = {
    provider,
    kind,
    domain,
    status: "offered",
    level,
    nativeType,
    driverId: driver.driverId,
    registration: driver.registration,
    lifecycle,
    dayTwo,
  };
  if (level === "unsupported") {
    const registrationReason = driver.registration !== "registered" ? cells.find((c) => c.evidence !== undefined)?.reason : undefined;
    entry.reason = registrationReason ?? [...new Set(cells.map((c) => c.reason ?? ""))].filter(Boolean).sort(cmp)[0] ?? "No operation is implemented.";
  } else if (level === "preview") {
    entry.reason = [...new Set(cells.filter((c) => c.level === "preview").map((c) => c.reason ?? ""))].filter(Boolean).sort(cmp).join(" ");
  }
  return entry;
}

export function deriveOfferedCatalog(input: DeriveInput): OfferedCatalog {
  // every kind has exactly one domain
  const domainOf = new Map<PortableKind, Domain>();
  for (const domain of DOMAINS) for (const kind of DOMAIN_KINDS[domain]) domainOf.set(kind, domain);
  for (const kind of PORTABLE_KINDS) if (!domainOf.has(kind)) throw new Error(`Portable kind ${kind} is not placed in any catalog domain (src/lib/offered-catalog/schema.ts DOMAIN_KINDS).`);

  const byTypeKey = new Map<string, DriverFact>();
  for (const d of [...input.drivers].sort((a, b) => cmp(a.driverId, b.driverId))) {
    const key = `${d.provider}|${d.nativeType}`;
    const prior = byTypeKey.get(key);
    if (prior && prior.driverId !== d.driverId) throw new Error(`Two drivers claim ${d.provider} ${d.nativeType}: ${prior.driverId} and ${d.driverId}.`);
    byTypeKey.set(key, d);
  }

  // day-two columns: every capability any driver executes or refuses; each must be a known capability
  const dayTwoSet = new Set<string>();
  for (const d of input.drivers) for (const o of [...d.operations, ...d.refuses]) dayTwoSet.add(o.capability);
  const dayTwoNames = [...dayTwoSet].sort(cmp);
  for (const name of dayTwoNames) if (!input.capabilities[name]) throw new Error(`A driver declares the operation ${name}, which is not in the capability catalog.`);

  const entries: Entry[] = [];
  const mapped = new Set<string>();
  for (const provider of PROVIDER_ORDER) {
    for (const kind of PORTABLE_KINDS) {
      const domain = domainOf.get(kind) as Domain;
      const nativeType = input.nativeTypes[provider]?.[kind];
      if (nativeType === undefined) {
        entries.push({ provider, kind, domain, status: "not_offered", level: "unsupported", reason: `No native type maps ${kind} on ${provider}; expansion reports it as unsupported.` });
        continue;
      }
      mapped.add(`${provider}|${nativeType}`);
      if (provider === "sandbox") {
        entries.push({ provider, kind, domain, status: "not_offered", level: "unsupported", nativeType, reason: "The sandbox is a simulation: it generates data and provisions nothing. A simulated path is not an offered service." });
        continue;
      }
      const driver = byTypeKey.get(`${provider}|${nativeType}`);
      if (!driver) {
        entries.push({ provider, kind, domain, status: "not_offered", level: "unsupported", nativeType, reason: `The compiler names ${nativeType}, but no resource driver implements it (schema or vocabulary only).` });
        continue;
      }
      entries.push(offeredEntry(provider, kind, domain, nativeType, driver, dayTwoNames));
    }
  }

  const unmappedDrivers = input.drivers
    .filter((d) => !mapped.has(`${d.provider}|${d.nativeType}`) && (PROVIDER_ORDER as readonly string[]).includes(d.provider))
    .map((d) => ({ driverId: d.driverId, provider: d.provider as ProviderKey, nativeType: d.nativeType, reason: "No portable kind maps to this native type, so it is not an offered service." }))
    .sort((a, b) => cmp(a.driverId, b.driverId));

  const dayTwoOperations = dayTwoNames.map((name) => {
    const c = input.capabilities[name] as CapabilityFact;
    return { name, title: c.title, mutates: c.mutates, risk: c.risk, defaultAutonomy: c.defaultAutonomy };
  });

  const body: Omit<OfferedCatalog, "contentDigest" | "catalogVersion"> = {
    schemaVersion: OFFERED_CATALOG_SCHEMA_VERSION,
    levelPolicy: { ...LEVEL_POLICY },
    providers: [...PROVIDER_ORDER],
    domains: DOMAINS.map((id) => ({ id, description: DOMAIN_DESCRIPTIONS[id], kinds: [...DOMAIN_KINDS[id]] })),
    dayTwoOperations,
    entries,
    rollup: PROVIDER_ORDER.flatMap((p) => DOMAINS.map((d) => rollupFor(p, d, entries))),
    unmappedDrivers,
  };
  const contentDigest = catalogContentDigest(body);
  return { catalogVersion: catalogVersionFor(contentDigest), contentDigest, ...body };
}

export type { SupportLevel };
