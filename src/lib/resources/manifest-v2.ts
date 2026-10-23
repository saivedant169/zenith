/**
 * Manifest V2 (ADR-0003): V1's application description plus placement,
 * constraints, policies, per-node placement, typed provider config and the
 * schema-validated `native` escape hatch.
 *
 * Compatibility contract:
 *   - `services`, `resources`, `routes`, `bindings` are V1's zod pieces,
 *     imported and reused — identical fields, defaults and meaning. V2 adds
 *     nothing to them, so `downgradeToV1()` is exact (see `upgrade.ts`).
 *   - The V2-only sections are `.strict()`. An unknown key in `placement`,
 *     `policies`, `providerConfig`… is rejected, not dropped: a typo in
 *     `polcies: { deletion: "deny" }` silently losing a safety policy is the
 *     failure this prevents. The V2 top level is strict for the same reason.
 *   - Everything an author can write here ends up inside generated
 *     infrastructure, so free-text fields are constrained by pattern (CIDRs,
 *     names, classes), not merely typed as strings.
 *   - No secret values: `native[].config` is scanned for inline credentials
 *     and rejected; secrets are referenced (`{ "secretRef": "vault:…" }`).
 *
 * Pure: no fs, no env, no store.
 */
import { z } from "zod";
import {
  Binding,
  Manifest as ManifestV1Schema,
  Resource,
  Route,
  Service,
  type Manifest as ManifestV1,
} from "@/lib/domain/types";
import { findNativeType, parseNativeConfig } from "./native-registry";
import { NATIVE_PREFIX } from "./native-types";
import { findInlineSecretPaths, urlHasCredentials } from "./secrets";

/* ------------------------------ vocabulary ------------------------------- */

export const PLACEMENT_PROVIDERS = ["aws", "gcp", "azure", "oci", "kubernetes", "zenith", "sandbox", "localstack", "auto"] as const;
export const PlacementProvider = z.enum(PLACEMENT_PROVIDERS);
export type PlacementProvider = z.infer<typeof PlacementProvider>;

/** A concrete provider: `auto` is a request to the placement solver, never a place. */
export const ConcreteProvider = z.enum(["aws", "gcp", "azure", "oci", "kubernetes", "zenith", "sandbox", "localstack"]);

/** Regions/zones/contexts end up in provider calls: lowercase alphanumerics, dot, dash, underscore. */
const REGION = /^[a-z0-9][a-z0-9._-]{0,62}$/;
export const RegionName = z.string().regex(REGION, "region: lowercase letters, digits, '.', '_' and '-' only");

const NODE_NAME = /^[a-z][a-z0-9-]{1,30}$/;

/** A DNS-1123 label: Kubernetes namespace names, resource-group-ish names. */
const DNS_LABEL = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;

const Cidr = z
  .string()
  .regex(/^(\d{1,3}\.){3}\d{1,3}\/\d{1,2}$/, "CIDR like 10.0.0.0/16")
  .refine((s) => {
    const [ip, bits] = s.split("/");
    return ip.split(".").every((o) => Number(o) <= 255) && Number(bits) >= 16 && Number(bits) <= 20;
  }, "CIDR octets must be ≤ 255 and the prefix length between /16 and /20 (subnets are carved as /24–/28 slices)");

/* ------------------------------- sections -------------------------------- */

export const Placement = z
  .object({
    provider: PlacementProvider,
    /** primary region first; required unless provider is `auto` */
    regions: z.array(RegionName).max(8).prefault([]),
    zones: z.number().int().min(1).max(3).optional(),
    /** data residency: allowed jurisdictions (`eu`, `in`, `us`…). Declared here, evaluated by placement/policy. */
    residency: z.array(z.string().regex(/^[A-Za-z][A-Za-z0-9-]{0,30}$/)).max(16).optional(),
  })
  .strict()
  .superRefine((p, ctx) => {
    if (p.provider !== "auto" && p.regions.length === 0)
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["regions"], message: `regions needs at least one region when provider is "${p.provider}" (use provider "auto" to let placement choose)` });
  });
export type Placement = z.infer<typeof Placement>;

export const Constraints = z
  .object({
    budgetUsdMonthly: z.number().positive().optional(),
    /** e.g. 99.9 — drives zone and HA derivation */
    availabilityTarget: z.number().gt(0).lte(100).optional(),
    latencyTargetMs: z.number().positive().optional(),
    userRegions: z.array(z.string().regex(/^[A-Za-z][A-Za-z0-9 _-]{0,40}$/)).max(32).optional(),
    tolerateSingleFailure: z.boolean().optional(),
  })
  .strict();
export type Constraints = z.infer<typeof Constraints>;

export const DELETION_POLICIES = ["deny", "approval", "allow"] as const;
export const BACKUP_POLICIES = ["none", "daily", "hourly"] as const;

export const PoliciesV2 = z
  .object({
    deletion: z.enum(DELETION_POLICIES).prefault("approval"),
    /** applies to stateful resources */
    backup: z.enum(BACKUP_POLICIES).prefault("daily"),
    approvalRequired: z.boolean().optional(),
    allowStatefulDeletion: z.boolean().optional(),
  })
  .strict();
export type PoliciesV2 = z.infer<typeof PoliciesV2>;

export const NodePlacementEntry = z
  .object({ provider: ConcreteProvider, region: RegionName.optional() })
  .strict();
export type NodePlacementEntry = z.infer<typeof NodePlacementEntry>;

const InstanceClass = z.string().regex(/^[a-z0-9]+(?:\.[a-z0-9-]+){1,2}$|^[A-Za-z0-9_-]{2,40}$/, "instance class / SKU like db.t4g.small or Standard_D2s_v3");

export const AwsConfig = z
  .object({
    vpcCidr: Cidr.optional(),
    natGateways: z.enum(["none", "single", "per_az"]).optional(),
    fargatePlatformVersion: z.string().regex(/^(LATEST|\d+\.\d+\.\d+)$/).optional(),
    rdsEngineVersion: z.string().regex(/^\d{1,3}(\.\d{1,3})?$/).optional(),
    multiAz: z.boolean().optional(),
    /** resource or service NAME → instance class */
    instanceClassOverrides: z.record(z.string().regex(NODE_NAME), InstanceClass).optional(),
  })
  .strict();
export type AwsConfig = z.infer<typeof AwsConfig>;

export const GcpConfig = z
  .object({
    vpcCidr: Cidr.optional(),
    cloudSqlTier: z.string().regex(/^db-[a-z0-9-]{2,40}$/).optional(),
    highAvailability: z.boolean().optional(),
    cloudRunIngress: z.enum(["all", "internal", "internal-and-cloud-load-balancing"]).optional(),
  })
  .strict();
export type GcpConfig = z.infer<typeof GcpConfig>;

export const AzureConfig = z
  .object({
    vnetCidr: Cidr.optional(),
    postgresSku: z.string().regex(/^[A-Za-z][A-Za-z0-9_]{1,40}$/).optional(),
    zoneRedundant: z.boolean().optional(),
    resourceGroup: z.string().regex(/^[A-Za-z0-9._()-]{1,90}$/).optional(),
  })
  .strict();
export type AzureConfig = z.infer<typeof AzureConfig>;

export const OciConfig = z
  .object({ vcnCidr: Cidr.optional(), shape: z.string().regex(/^[A-Za-z0-9._-]{2,60}$/).optional() })
  .strict();
export type OciConfig = z.infer<typeof OciConfig>;

export const KubernetesConfig = z
  .object({
    namespace: z.string().regex(DNS_LABEL).optional(),
    ingressClass: z.string().regex(DNS_LABEL).optional(),
    storageClass: z.string().regex(DNS_LABEL).optional(),
    /** `default-deny` isolates the namespace's egress too (DNS stays open); needs a CNI that enforces NetworkPolicy */
    egress: z.enum(["open", "default-deny"]).optional(),
    /** applies to every cron service on this cluster */
    cronJob: z
      .object({
        concurrencyPolicy: z.enum(["Allow", "Forbid", "Replace"]).optional(),
        startingDeadlineSeconds: z.number().int().min(10).max(86_400).optional(),
        successfulJobsHistoryLimit: z.number().int().min(0).max(100).optional(),
        failedJobsHistoryLimit: z.number().int().min(0).max(100).optional(),
        timeZone: z.string().regex(/^[A-Za-z][A-Za-z0-9_+-]*(\/[A-Za-z0-9_+-]+){0,2}$/).max(64).optional(),
      })
      .strict()
      .optional(),
  })
  .strict();
export type KubernetesConfig = z.infer<typeof KubernetesConfig>;

export const ProviderConfig = z
  .object({
    aws: AwsConfig.optional(),
    gcp: GcpConfig.optional(),
    azure: AzureConfig.optional(),
    oci: OciConfig.optional(),
    kubernetes: KubernetesConfig.optional(),
  })
  .strict();
export type ProviderConfig = z.infer<typeof ProviderConfig>;

export const NativeNode = z
  .object({
    id: z.string().regex(NODE_NAME, "native id: lowercase letters, digits, dashes"),
    provider: ConcreteProvider,
    /** full native type, e.g. `aws:dynamodb_table`; must be registered (see native-registry.ts) */
    type: z.string().min(1).max(100),
    /** region for this node when its provider differs from the environment's; a nodePlacement entry wins over it */
    region: RegionName.optional(),
    config: z.record(z.string(), z.unknown()).prefault({}),
    /** ids or names of services, resources or other native entries */
    dependsOn: z.array(z.string().min(1)).max(200).optional(),
  })
  .strict();
export type NativeNode = z.infer<typeof NativeNode>;

/* ------------------------------- release --------------------------------- */

/** One argv element of a release command: bounded, no control characters, no credentials in a URL. */
const ReleaseArg = z
  .string()
  .min(1, "an argv element cannot be empty")
  .max(1024)
  .regex(/^[^\u0000-\u001f\u007f]*$/, "an argv element cannot contain control characters")
  .refine((a) => !urlHasCredentials(a), "an argv element embeds credentials in a URL; pass secrets through the service's environment references, never on the command line");

/**
 * A database migration (or any other one-off release task) run after the
 * workloads deploy: the `command` argv runs ONCE as a one-off task of the named
 * service, in that service's image, network and environment. It is an argv
 * vector, never a shell string: Zenith does not interpret it, so there is
 * nothing to quote and nothing to inject into.
 */
export const MigrateHook = z
  .object({
    /** service NAME; must be a managed web, worker or cron service (a static site has nothing to run a task in) */
    service: z.string().regex(NODE_NAME, "service: the name of a service in this manifest"),
    command: z.array(ReleaseArg).min(1).max(32),
    /** how long the one-off task may run; the deploy's own step deadline still applies */
    timeoutSec: z.number().int().min(1).max(3600).optional(),
    /**
     * What the migration does to the database, declared by a person because an argv is opaque to
     * Zenith. `expand` is additive and backward compatible and runs after the normal deployment
     * approval. `data` (backfills) and `contract` (removes or changes schema the previous code
     * needs) each need a SEPARATE approval of the exact migration by someone other than the
     * requester. Absent is treated as `contract`: an unclassified migration is never assumed safe.
     */
    class: z.enum(["expand", "data", "contract"]).optional(),
  })
  .strict();
export type MigrateHook = z.infer<typeof MigrateHook>;

/**
 * How the new image takes traffic. `rolling` (default) is the provider's own replacement.
 * `progressive` sends the listed percentages to the candidate (a canary) with a bake period
 * between steps; the last step must be 100 and is the cutover. Providers whose release adapter
 * cannot split traffic refuse a progressive rollout before anything is deployed.
 */
export const RolloutHook = z
  .object({
    strategy: z.enum(["rolling", "progressive"]).prefault("rolling"),
    steps: z.array(z.number().int().min(1).max(100)).min(1).max(6).optional(),
    bakeSec: z.number().int().min(0).max(3600).optional(),
  })
  .strict();
export type RolloutHook = z.infer<typeof RolloutHook>;

/**
 * V2 addition (additive): steps that run as part of a release. Only `migrate`
 * exists today. Absent means "no release steps"; nothing is defaulted.
 */
export const Release = z.object({ migrate: MigrateHook.optional(), rollout: RolloutHook.optional() }).strict();
export type Release = z.infer<typeof Release>;

/** Experimental runnable function. S3 version and both source/package digests are immutable review inputs. */
export const ManifestFunction = z.object({
  id: z.string().regex(/^[a-z][a-z0-9-]{1,30}$/), name: z.string().regex(/^[a-z][a-z0-9-]{1,30}$/), kind: z.literal("function"),
  provider: z.literal("aws"), region: RegionName,
  runtime: z.string().regex(/^[a-z][a-z0-9.]{1,30}$/), handler: z.string().regex(/^[A-Za-z0-9._/:-]{1,128}$/),
  memoryMb: z.number().int().min(128).max(10240).prefault(256), timeoutSec: z.number().int().min(1).max(900).prefault(30),
  architecture: z.enum(["x86_64", "arm64"]).prefault("x86_64"),
  source: z.object({ type: z.literal("s3"), bucket: z.string().regex(/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/),
    key: z.string().regex(/^[A-Za-z0-9!_.*'()/=+@:-]{1,900}$/).refine(k => !k.includes("..")),
    version: z.string().regex(/^[A-Za-z0-9._-]{1,1024}$/).refine(v => v !== "null"),
    sha256: z.string().regex(/^[a-f0-9]{64}$/), sourceDigest: z.string().regex(/^[a-f0-9]{64}$/) }).strict(),
  env: z.array(z.object({ key: z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,254}$/), value: z.string().max(4096) }).strict()).max(50).prefault([]),
  /** Service ids that invoke this function using separately scoped IAM credentials. No public URL is generated. */
  invokedBy: z.array(z.string()).max(32).prefault([]),
}).strict();
export type ManifestFunction = z.infer<typeof ManifestFunction>;

/* ------------------------------- manifest -------------------------------- */

/** The strict object, before cross-field checks (`.shape` stays reachable). */
export const ManifestV2Object = z
  .object({
    version: z.literal(2),
    services: z.array(Service).max(500).prefault([]),
    resources: z.array(Resource).max(500).prefault([]),
    routes: z.array(Route).max(500).prefault([]),
    bindings: z.array(Binding).max(500).prefault([]),
    placement: Placement.optional(),
    constraints: Constraints.optional(),
    policies: PoliciesV2.optional(),
    /** node id (or name) → provider/region override, for multi-cloud */
    nodePlacement: z.record(z.string(), NodePlacementEntry).optional(),
    providerConfig: ProviderConfig.optional(),
    native: z.array(NativeNode).max(500).optional(),
    functions: z.array(ManifestFunction).max(32).optional(),
    /** release-time steps (migrations); see `Release` */
    release: Release.optional(),
  })
  .strict();

function crossChecks(m: z.infer<typeof ManifestV2Object>, ctx: z.RefinementCtx): void {
  const issue = (path: (string | number)[], message: string) =>
    ctx.addIssue({ code: z.ZodIssueCode.custom, path, message });

  const allIds = new Set([...m.services, ...m.resources, ...m.routes, ...(m.native ?? [])].map(n => n.id));
  const allNames = new Set([...m.services, ...m.resources].map(n => n.name));
  (m.functions ?? []).forEach((f, i) => {
    if (allIds.has(f.id) || allNames.has(f.name)) issue(["functions", i], "Function id and name must be unique across manifest nodes.");
    allIds.add(f.id); allNames.add(f.name);
    f.invokedBy.forEach((id, j) => { if (!m.services.some(s => s.id === id && s.ownership === "managed")) issue(["functions", i, "invokedBy", j], "Name a managed invoking service."); });
    for (const path of findInlineSecretPaths(Object.fromEntries(f.env.map(e => [e.key, e.value])))) issue(["functions", i, "env"], `Inline credential ${path} is refused; function secrets require runtime SDK reads.`);
    const override = m.nodePlacement?.[f.id] ?? m.nodePlacement?.[f.name];
    if (override && (override.provider !== f.provider || (override.region && override.region !== f.region))) issue(["functions", i], "Function placement must agree with its explicit provider and region.");
  });
  const natives = m.native ?? [];
  const nativeIds = new Set<string>();
  natives.forEach((n, i) => {
    if (nativeIds.has(n.id)) issue(["native", i, "id"], `duplicate native id "${n.id}"`);
    nativeIds.add(n.id);

    const prefix = NATIVE_PREFIX[n.provider];
    if (!n.type.startsWith(`${prefix}:`))
      issue(["native", i, "type"], `type must start with "${prefix}:" for provider ${n.provider}`);
    else if (!findNativeType(n.provider, n.type)) {
      const parsed = parseNativeConfig(n.provider, n.type, n.config);
      issue(["native", i, "type"], parsed.ok ? "unknown native type" : parsed.issues[0].message);
    } else {
      const parsed = parseNativeConfig(n.provider, n.type, n.config);
      if (!parsed.ok) for (const p of parsed.issues) issue(["native", i, "config", ...p.path], p.message);
    }

    for (const path of findInlineSecretPaths(n.config))
      issue(
        ["native", i, "config", ...path.split(".")],
        `config.${path} looks like a secret value. Put a reference there ({ "secretRef": "vault:…" }); manifests never hold secret values.`
      );
  });

  const nodeKeys = new Set<string>();
  for (const n of [...m.services, ...m.resources, ...(m.functions ?? [])]) {
    nodeKeys.add(n.id);
    nodeKeys.add(n.name);
  }

  natives.forEach((n, i) =>
    (n.dependsOn ?? []).forEach((d, j) => {
      if (d === n.id) issue(["native", i, "dependsOn", j], `native "${n.id}" cannot depend on itself`);
      else if (!nativeIds.has(d) && !nodeKeys.has(d))
        issue(["native", i, "dependsOn", j], `"${d}" is not a service, resource or native id in this manifest`);
    })
  );

  /* A dependency cycle among native entries can never be applied. */
  const deps = new Map(natives.map((n) => [n.id, (n.dependsOn ?? []).filter((d) => nativeIds.has(d))]));
  const state = new Map<string, 1 | 2>();
  const visit = (id: string, trail: string[]): string[] | undefined => {
    if (state.get(id) === 2) return undefined;
    if (state.get(id) === 1) return [...trail.slice(trail.indexOf(id)), id];
    state.set(id, 1);
    for (const d of deps.get(id) ?? []) {
      const cycle = visit(d, [...trail, id]);
      if (cycle) return cycle;
    }
    state.set(id, 2);
    return undefined;
  };
  for (const id of [...deps.keys()].sort()) {
    const cycle = visit(id, []);
    if (cycle) {
      issue(["native"], `native entries depend on each other in a cycle: ${cycle.join(" → ")}`);
      break;
    }
  }

  for (const key of Object.keys(m.nodePlacement ?? {}))
    if (!nodeKeys.has(key) && !nativeIds.has(key))
      issue(["nodePlacement", key], `"${key}" is not a service, resource or native id in this manifest`);

  const migrate = m.release?.migrate;
  if (migrate) {
    const target = m.services.find((s) => s.name === migrate.service);
    if (!target) issue(["release", "migrate", "service"], `"${migrate.service}" is not a service in this manifest`);
    else if (target.kind === "static") issue(["release", "migrate", "service"], `"${migrate.service}" is a static site; a migration needs a web, worker or cron service to run in`);
    else if (target.ownership !== "managed")
      issue(["release", "migrate", "service"], `"${migrate.service}" is ${target.ownership}; Zenith does not run it, so it cannot run a migration task there`);
  }
}

export const ManifestV2 = ManifestV2Object.superRefine(crossChecks);
export type ManifestV2 = z.infer<typeof ManifestV2>;

export type AnyManifest = ManifestV1 | ManifestV2;

export const isV2 = (m: AnyManifest): m is ManifestV2 => m.version === 2;
export const isV1 = (m: AnyManifest): m is ManifestV1 => m.version === 1;

/* -------------------------------- parsing -------------------------------- */

export interface ManifestIssue {
  /** dotted path into the manifest, e.g. `services.0.name` or `native.1.config.hashKey` */
  path: string;
  message: string;
}

export type ParseManifestResult =
  | { ok: true; manifest: AnyManifest; errors?: undefined }
  | { ok: false; manifest?: undefined; errors: ManifestIssue[] };

/**
 * zod echoes the offending value in some messages ("received 'x'"). A manifest
 * field is not supposed to be secret, but nothing forces its author to know
 * that, and error text travels into logs and API responses.
 */
const stripReceived = (message: string) => message.replace(/,?\s*received\s+('[^']*'|"[^"]*"|\S+)/gi, "");

const toIssues = (error: z.ZodError): ManifestIssue[] =>
  error.issues.map((i) => ({ path: i.path.join("."), message: stripReceived(i.message) }));

/**
 * Parse a manifest of either version. Dispatches on `version`; anything else
 * is a single clear error. V1 is never rewritten to V2 here — upgrading is an
 * explicit, separate act (`upgradeManifest`).
 */
export function parseManifest(input: unknown): ParseManifestResult {
  if (input === null || typeof input !== "object" || Array.isArray(input))
    return { ok: false, errors: [{ path: "", message: "A manifest must be a JSON object." }] };
  const version = (input as { version?: unknown }).version;
  if (version === 1) {
    const r = ManifestV1Schema.safeParse(input);
    return r.success ? { ok: true, manifest: r.data } : { ok: false, errors: toIssues(r.error) };
  }
  if (version === 2) {
    const r = ManifestV2.safeParse(input);
    return r.success ? { ok: true, manifest: r.data } : { ok: false, errors: toIssues(r.error) };
  }
  return { ok: false, errors: [{ path: "version", message: "version must be 1 or 2." }] };
}

/* ------------------------------ policy view ------------------------------ */

export interface EffectivePolicies {
  deletion: (typeof DELETION_POLICIES)[number];
  backup: (typeof BACKUP_POLICIES)[number];
  approvalRequired: boolean;
  allowStatefulDeletion: boolean;
}

/** V2 policies with defaults applied; V1 manifests (and V2 without policies) get the defaults. */
export function resolvePolicies(m: AnyManifest): EffectivePolicies {
  const p = isV2(m) ? m.policies : undefined;
  return {
    deletion: p?.deletion ?? "approval",
    backup: p?.backup ?? "daily",
    approvalRequired: p?.approvalRequired ?? false,
    allowStatefulDeletion: p?.allowStatefulDeletion ?? false,
  };
}
