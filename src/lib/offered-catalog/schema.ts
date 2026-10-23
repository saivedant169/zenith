/**
 * Versioned offered capability catalog: the schema and the pure invariants
 * (PROD-LIFE-02).
 *
 * The catalog answers one question per provider x portable kind x lifecycle
 * operation: is this actually offered, in preview, or unsupported, and why?
 * It is DERIVED (`derive.ts`) from the compiler vocabulary
 * (`NATIVE_TYPE_TABLE`) and the real resource drivers' own declarations, never
 * written by hand, and committed as `offered-catalog.json`. A drift check
 * (`scripts/docs/offered-catalog.ts --check`, `tests/offered-catalog`) fails
 * when the committed file and the code disagree.
 *
 * What "offered" means here. A schema entry, a native-type name, a refusal
 * handler, a simulated (sandbox) path or a driver nothing registers is NOT an
 * offered service. Levels:
 *   supported   a registered, non-experimental driver implements the operation
 *               and it has been exercised against an emulator or a real
 *               account (evidence `emulated` or `real`).
 *   preview     implemented and reachable, but only contract-level evidence
 *               (mocked SDK/HTTP), or experimental, or an ambiguous shared
 *               native type. Usable behind review; never advertised as proven.
 *   unsupported not implemented, refusal-only, simulated-only, no driver, no
 *               native-type mapping or not registered. Always carries a reason.
 *
 * This module has no I/O and no provider imports so the API, MCP and scripts
 * can all use it.
 */
import { z } from "zod";
import { digest } from "@/lib/controlplane/digest";
import { PORTABLE_KINDS, type PortableKind, type ProviderKey } from "@/lib/resources/types";

export const OFFERED_CATALOG_SCHEMA_VERSION = 1 as const;

export const SUPPORT_LEVELS = ["supported", "preview", "unsupported"] as const;
export type SupportLevel = (typeof SUPPORT_LEVELS)[number];
const LEVEL_RANK: Record<SupportLevel, number> = { unsupported: 0, preview: 1, supported: 2 };
export const bestLevel = (levels: readonly SupportLevel[]): SupportLevel => levels.reduce<SupportLevel>((a, b) => (LEVEL_RANK[b] > LEVEL_RANK[a] ? b : a), "unsupported");

/** Declarative lifecycle (`provision` is the driver's OpenTofu `compile`) plus the native read operations. */
export const LIFECYCLE_OPS = ["provision", "observe", "runtime", "verify", "discover"] as const;
export type LifecycleOp = (typeof LIFECYCLE_OPS)[number];
/** The driver flag each lifecycle operation is derived from. */
export const LIFECYCLE_DRIVER_FLAG: Record<LifecycleOp, "compile" | "observe" | "runtime" | "verify" | "discover"> = {
  provision: "compile",
  observe: "observe",
  runtime: "runtime",
  verify: "verify",
  discover: "discover",
};

/** Every provider key, in presentation order. A new `ProviderKey` fails to compile here until it is placed. */
export const PROVIDER_ORDER = ["aws", "gcp", "azure", "oci", "kubernetes", "zenith", "localstack", "sandbox"] as const satisfies readonly ProviderKey[];
type AssertNever<T extends never> = T;
export type ProvidersCovered = AssertNever<Exclude<ProviderKey, (typeof PROVIDER_ORDER)[number]>>;

export const DOMAINS = ["vm", "container", "serverless", "triggers", "jobs", "data", "cache", "storage", "messaging", "network", "firewall", "dns", "tls", "identity", "secrets", "day-two"] as const;
export type Domain = (typeof DOMAINS)[number];

/**
 * Which domain each portable kind belongs to. Every `PortableKind` must appear
 * exactly once (checked here and by the generator): a new kind cannot be added
 * to the compiler without being placed in the catalog.
 */
export const DOMAIN_KINDS: Readonly<Record<Domain, readonly PortableKind[]>> = {
  vm: ["compute_instance"],
  container: ["container_service", "container_registry", "kubernetes_cluster", "kubernetes_namespace", "build_pipeline"],
  serverless: ["function", "static_site"],
  // No portable kind models event, queue or HTTP triggers; schedules belong to `jobs`.
  triggers: [],
  jobs: ["scheduled_job"],
  data: ["postgres", "mysql"],
  cache: ["redis"],
  storage: ["object_store", "volume"],
  messaging: ["queue", "pubsub"],
  network: ["network", "subnet", "load_balancer"],
  firewall: ["firewall"],
  dns: ["dns_zone", "dns_record"],
  tls: ["tls_certificate"],
  identity: ["identity"],
  secrets: ["secret"],
  // log groups are the kind; the day-two operations (restart, scale, logs, ...) roll up here as well.
  "day-two": ["log_group"],
};

export const DOMAIN_DESCRIPTIONS: Readonly<Record<Domain, string>> = {
  vm: "Virtual machines.",
  container: "Container services, registries, clusters, namespaces and image build pipelines.",
  serverless: "Functions and static sites.",
  triggers: "Event, queue and HTTP triggers. Not modelled by any portable kind.",
  jobs: "Scheduled jobs.",
  data: "Relational databases.",
  cache: "In-memory caches.",
  storage: "Object stores and block volumes.",
  messaging: "Queues and pub/sub topics.",
  network: "Networks, subnets and load balancers.",
  firewall: "Firewall and network policy rules.",
  dns: "DNS zones and records.",
  tls: "TLS certificates.",
  identity: "Workload identities and roles.",
  secrets: "Secret stores.",
  "day-two": "Log groups and day-two operations (restart, scale, logs, snapshot, rollback).",
};

export const LEVEL_POLICY = {
  supported: "A registered, non-experimental driver implements the operation and it has emulator or live-account evidence.",
  preview: "Implemented and reachable, but only contract-level evidence (mocked SDK or HTTP), or experimental, or an ambiguous shared native type.",
  unsupported: "Not implemented, refusal-only, simulated-only, no driver, no native-type mapping, or the driver is not registered by the application. Always carries a reason.",
} as const satisfies Record<SupportLevel, string>;

/* --------------------------------- schema ---------------------------------- */

const Reason = z.string().min(1).max(1200);
const Level = z.enum(SUPPORT_LEVELS);
const Evidence = z.enum(["real", "emulated", "contract", "simulated", "undeclared"]);

export const CellSchema = z
  .strictObject({ level: Level, reason: Reason.optional(), evidence: Evidence.optional() })
  .superRefine((cell, ctx) => {
    if (cell.level !== "supported" && cell.reason === undefined) ctx.addIssue({ code: "custom", message: `a ${cell.level} cell must say why` });
  });
export type Cell = z.infer<typeof CellSchema>;

const Registration = z.enum(["registered", "registrable", "module only"]);

export const EntrySchema = z
  .strictObject({
    provider: z.enum(PROVIDER_ORDER),
    kind: z.enum(PORTABLE_KINDS),
    domain: z.enum(DOMAINS),
    status: z.enum(["offered", "not_offered"]),
    level: Level,
    reason: Reason.optional(),
    nativeType: z.string().min(1).optional(),
    driverId: z.string().min(1).optional(),
    registration: Registration.optional(),
    experimental: z.boolean().optional(),
    lifecycle: z.partialRecord(z.enum(LIFECYCLE_OPS), CellSchema).optional(),
    dayTwo: z.record(z.string().min(1), CellSchema).optional(),
  })
  .superRefine((e, ctx) => {
    const bad = (message: string): void => void ctx.addIssue({ code: "custom", message });
    if (e.status === "not_offered") {
      if (e.level !== "unsupported") bad("a not_offered entry must be unsupported");
      if (e.reason === undefined) bad("a not_offered entry must say why");
      if (e.lifecycle !== undefined || e.dayTwo !== undefined) bad("a not_offered entry carries no cells");
      return;
    }
    if (e.nativeType === undefined || e.driverId === undefined || e.registration === undefined) bad("an offered entry names its native type, driver and registration");
    for (const op of LIFECYCLE_OPS) if (e.lifecycle?.[op] === undefined) bad(`an offered entry has an explicit ${op} cell`);
    if (e.dayTwo === undefined) bad("an offered entry has explicit day-two cells");
    const cells = [...Object.values(e.lifecycle ?? {}), ...Object.values(e.dayTwo ?? {})];
    if (e.level !== bestLevel(cells.map((c) => c.level))) bad("entry level must be the best of its cells");
    if (e.level === "unsupported" && e.reason === undefined) bad("an unsupported entry must say why");
    if (e.level === "preview" && e.reason === undefined) bad("a preview entry must say why");
  });
export type Entry = z.infer<typeof EntrySchema>;

export const RollupSchema = z.strictObject({ provider: z.enum(PROVIDER_ORDER), domain: z.enum(DOMAINS), level: Level, reason: Reason.optional() });
export type Rollup = z.infer<typeof RollupSchema>;

export const UnmappedDriverSchema = z.strictObject({ driverId: z.string().min(1), provider: z.enum(PROVIDER_ORDER), nativeType: z.string().min(1), reason: Reason });

export const DayTwoOperationSchema = z.strictObject({
  name: z.string().min(1),
  title: z.string().min(1),
  mutates: z.boolean(),
  risk: z.enum(["low", "medium", "high", "critical"]),
  defaultAutonomy: z.number().int().min(0).max(6),
});

export const OfferedCatalogSchema = z.strictObject({
  schemaVersion: z.literal(OFFERED_CATALOG_SCHEMA_VERSION),
  /** `v<schemaVersion>-<first 12 hex of contentDigest>`: changes whenever any cell changes. */
  catalogVersion: z.string().regex(/^v\d+-[0-9a-f]{12}$/),
  contentDigest: z.string().regex(/^[0-9a-f]{64}$/),
  levelPolicy: z.strictObject({ supported: z.string(), preview: z.string(), unsupported: z.string() }),
  providers: z.array(z.enum(PROVIDER_ORDER)),
  domains: z.array(z.strictObject({ id: z.enum(DOMAINS), description: z.string(), kinds: z.array(z.enum(PORTABLE_KINDS)) })),
  dayTwoOperations: z.array(DayTwoOperationSchema),
  entries: z.array(EntrySchema),
  rollup: z.array(RollupSchema),
  unmappedDrivers: z.array(UnmappedDriverSchema),
});
export type OfferedCatalog = z.infer<typeof OfferedCatalogSchema>;

/* ------------------------------- invariants -------------------------------- */

/** Digest of everything except the two self-describing identity fields. */
export function catalogContentDigest(catalog: Omit<OfferedCatalog, "contentDigest" | "catalogVersion">): string {
  return digest(catalog);
}

export function catalogVersionFor(contentDigest: string): string {
  return `v${OFFERED_CATALOG_SCHEMA_VERSION}-${contentDigest.slice(0, 12)}`;
}

/** Roll a provider x domain up from its entries. Pure; used by the deriver and re-checked on load. */
export function rollupFor(provider: ProviderKey, domain: Domain, entries: readonly Entry[]): Rollup {
  const kinds = DOMAIN_KINDS[domain];
  const mine = entries.filter((e) => e.provider === provider && kinds.includes(e.kind));
  const levels: SupportLevel[] = mine.map((e) => e.level);
  if (domain === "day-two") {
    for (const e of entries.filter((x) => x.provider === provider)) for (const c of Object.values(e.dayTwo ?? {})) levels.push(c.level);
  }
  const level = bestLevel(levels);
  if (level !== "unsupported") return { provider, domain, level };
  if (mine.length === 0) {
    return { provider, domain, level, reason: domain === "triggers" ? "No portable kind models event, queue or HTTP triggers; scheduled triggers are the jobs domain." : "No portable kind belongs to this domain." };
  }
  const reasons = [...new Set(mine.map((e) => e.reason ?? "no cell is offered"))].sort();
  return { provider, domain, level, reason: reasons.join("; ").slice(0, 1200) };
}

/** Structural invariants the zod shape cannot express. Returns messages; empty means consistent. */
export function checkCatalogInvariants(catalog: OfferedCatalog): string[] {
  const problems: string[] = [];
  const kindCount = new Map<string, number>();
  for (const domain of DOMAINS) for (const kind of DOMAIN_KINDS[domain]) kindCount.set(kind, (kindCount.get(kind) ?? 0) + 1);
  for (const kind of PORTABLE_KINDS) if (kindCount.get(kind) !== 1) problems.push(`portable kind ${kind} must belong to exactly one domain (found ${kindCount.get(kind) ?? 0})`);

  const keys = new Set<string>();
  const expectedDayTwo = catalog.dayTwoOperations.map((o) => o.name).sort();
  for (const e of catalog.entries) {
    const key = `${e.provider}/${e.kind}`;
    if (keys.has(key)) problems.push(`duplicate entry ${key}`);
    keys.add(key);
    if (!DOMAIN_KINDS[e.domain].includes(e.kind)) problems.push(`entry ${key} is filed under the wrong domain ${e.domain}`);
    if (e.status === "offered" && Object.keys(e.dayTwo ?? {}).sort().join("|") !== expectedDayTwo.join("|")) problems.push(`entry ${key} day-two cells do not match the catalog's day-two operations`);
  }
  for (const provider of catalog.providers) for (const kind of PORTABLE_KINDS) if (!keys.has(`${provider}/${kind}`)) problems.push(`missing explicit entry ${provider}/${kind}`);
  if (catalog.providers.join("|") !== PROVIDER_ORDER.join("|")) problems.push("providers must list every provider key in presentation order");

  const expectedRollup = catalog.providers.flatMap((p) => DOMAINS.map((d) => rollupFor(p, d, catalog.entries)));
  if (digest(expectedRollup) !== digest(catalog.rollup)) problems.push("rollup does not match the entries");

  const { contentDigest, catalogVersion, ...body } = catalog;
  if (contentDigest !== catalogContentDigest(body)) problems.push("contentDigest does not match the catalog content");
  if (catalogVersion !== catalogVersionFor(contentDigest)) problems.push("catalogVersion does not match the contentDigest");
  return problems;
}
