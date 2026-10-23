/**
 * Level 3 — the provider-native escape hatch's allowlist (ADR-0003).
 *
 * A V2 manifest may carry `native` entries: a provider, a native type and a
 * free-form `config`. "Free-form" is exactly what must never reach a driver
 * unchecked, so a native entry is only accepted when its `(provider, type)` is
 * registered here with a zod schema, and its config parses against that schema.
 * Unknown types are rejected with the list of what is registered.
 *
 * Conventions:
 *   - `type` is the FULL native type as it appears on `ResourceNode.nativeType`
 *     and as a driver registers it: `aws:dynamodb_table`, `k8s:CronJob`.
 *     It must carry the provider's prefix (`NATIVE_PREFIX`).
 *   - Object schemas must be `.strict()`: an unknown key is a typo or an attack,
 *     never something to pass through to a cloud API. Registration refuses
 *     non-strict object schemas.
 *   - The registry lives on `globalThis` for the same reason the driver
 *     registry does: Next bundles duplicate module state per route.
 *
 * What registration does NOT mean: that a driver can compile, observe or verify
 * the type. Whether one can is `findDriver(provider, type)` — a separate
 * registry with its own evidence levels. The seeded types below are validated
 * SHAPES only; no driver for them exists yet.
 */
import { z } from "zod";
import type { ProviderKey } from "./types";
import { NATIVE_PREFIX } from "./native-types";
import { CronJobNativeConfig, StatefulSetNativeConfig } from "./native-k8s-workloads";

export interface NativeTypeEntry {
  provider: ProviderKey;
  /** full native type, e.g. `aws:dynamodb_table` */
  type: string;
  schema: z.ZodTypeAny;
  description?: string;
}

type G = typeof globalThis & { __zenithNativeTypes?: Map<string, NativeTypeEntry> };

const key = (provider: ProviderKey, type: string) => `${provider}|${type}`;

const NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;

/** Seeds: small, conservative shapes. Real drivers replace them via `registerNativeType`. */
const SEEDS: NativeTypeEntry[] = [
  {
    provider: "aws",
    type: "aws:sns_topic",
    description: "SNS topic",
    schema: z
      .object({ name: z.string().regex(NAME).optional(), fifo: z.boolean().optional(), encrypted: z.boolean().optional() })
      .strict(),
  },
  {
    provider: "aws",
    type: "aws:dynamodb_table",
    description: "DynamoDB table",
    schema: z
      .object({
        name: z.string().regex(NAME).optional(),
        hashKey: z.object({ name: z.string().regex(NAME), type: z.enum(["S", "N", "B"]) }).strict(),
        rangeKey: z.object({ name: z.string().regex(NAME), type: z.enum(["S", "N", "B"]) }).strict().optional(),
        billingMode: z.enum(["PAY_PER_REQUEST", "PROVISIONED"]).prefault("PAY_PER_REQUEST"),
        pointInTimeRecovery: z.boolean().optional(),
        ttlAttribute: z.string().regex(NAME).optional(),
      })
      .strict(),
  },
  {
    provider: "aws",
    type: "aws:kms_key",
    description: "KMS customer-managed key",
    schema: z
      .object({
        alias: z.string().regex(/^[A-Za-z0-9/_-]{1,250}$/),
        rotation: z.boolean().optional(),
        description: z.string().max(200).optional(),
      })
      .strict(),
  },
  {
    provider: "gcp",
    type: "gcp:pubsub_topic",
    description: "Pub/Sub topic",
    schema: z
      .object({ name: z.string().regex(NAME).optional(), messageRetentionSeconds: z.number().int().min(600).max(2678400).optional() })
      .strict(),
  },
  ...(["kubernetes", "zenith"] as const).map(
    (provider): NativeTypeEntry => ({
      provider,
      type: "k8s:HorizontalPodAutoscaler",
      description: "HorizontalPodAutoscaler for a workload in this environment",
      schema: z
        .object({
          target: z.string().min(1).max(253),
          minReplicas: z.number().int().min(1).max(100),
          maxReplicas: z.number().int().min(1).max(100),
          cpuUtilizationPercent: z.number().int().min(1).max(100).optional(),
        })
        .strict()
        .refine((c) => c.minReplicas <= c.maxReplicas, { message: "minReplicas must not exceed maxReplicas", path: ["minReplicas"] }),
    })
  ),
  // The managed Zenith substrate refuses StatefulSets and renders its own CronJobs, so these are
  // customer-cluster types only (PROD-LIFE-07).
  {
    provider: "kubernetes",
    type: "k8s:StatefulSet",
    description: "StatefulSet with persistent volume claim templates, ordered rollout and an explicit PVC retention policy",
    schema: StatefulSetNativeConfig,
  },
  {
    provider: "kubernetes",
    type: "k8s:CronJob",
    description: "CronJob with explicit concurrency policy, history limits and time zone",
    schema: CronJobNativeConfig,
  },
];

function assertRegistrable(provider: ProviderKey, type: string, schema: z.ZodTypeAny): void {
  const prefix = NATIVE_PREFIX[provider];
  if (prefix === undefined) throw new Error(`Unknown provider "${provider}".`);
  if (!new RegExp(`^${prefix}:[A-Za-z][A-Za-z0-9_]{0,80}$`).test(type))
    throw new Error(`Native type "${type}" must look like "${prefix}:<name>" for provider ${provider}.`);
  // Unwrap transforms (pipes) so a `.strict().transform(...)` schema is still recognised as strict; refine keeps the type.
  let inner: z.ZodType = schema;
  while (inner instanceof z.ZodPipe) inner = inner._zod.def.in as z.ZodType;
  if (inner instanceof z.ZodObject && !(inner._zod.def.catchall instanceof z.ZodNever))
    throw new Error(`Native schema for ${provider} ${type} must be .strict(): unknown keys must be rejected, not passed to a provider API.`);
}

function registry(): Map<string, NativeTypeEntry> {
  const g = globalThis as G;
  if (!g.__zenithNativeTypes) {
    g.__zenithNativeTypes = new Map();
    for (const s of SEEDS) g.__zenithNativeTypes.set(key(s.provider, s.type), s);
  }
  return g.__zenithNativeTypes;
}

/** Allow a native type. Last registration for `(provider, type)` wins, so a real driver can tighten a seed. */
export function registerNativeType(provider: ProviderKey, type: string, schema: z.ZodTypeAny, description?: string): void {
  assertRegistrable(provider, type, schema);
  registry().set(key(provider, type), { provider, type, schema, description });
}

/** Remove a registration (tests, or a driver being unloaded). Returns whether one existed. */
export function unregisterNativeType(provider: ProviderKey, type: string): boolean {
  return registry().delete(key(provider, type));
}

export function findNativeType(provider: ProviderKey, type: string): NativeTypeEntry | undefined {
  return registry().get(key(provider, type));
}

export function isNativeTypeRegistered(provider: ProviderKey, type: string): boolean {
  return registry().has(key(provider, type));
}

/** Registered types, sorted, optionally for one provider. */
export function listNativeTypes(provider?: ProviderKey): NativeTypeEntry[] {
  return [...registry().values()]
    .filter((e) => !provider || e.provider === provider)
    .sort((a, b) => (a.provider + a.type < b.provider + b.type ? -1 : 1));
}

export type NativeConfigResult =
  | { ok: true; config: Record<string, unknown> }
  | { ok: false; issues: { path: (string | number)[]; message: string }[] };

/**
 * Validate a native entry's config against its registered schema. Returns the
 * PARSED config (defaults applied), which is what a driver should compile from;
 * the manifest keeps the config exactly as authored.
 */
export function parseNativeConfig(provider: ProviderKey, type: string, config: unknown): NativeConfigResult {
  const entry = findNativeType(provider, type);
  if (!entry) {
    const known = listNativeTypes(provider).map((e) => e.type);
    return {
      ok: false,
      issues: [
        {
          path: [],
          message: `Unknown native type "${type}" for provider ${provider}. ${
            known.length ? `Registered: ${known.join(", ")}.` : "None are registered."
          } Use a portable resource, or register the type with registerNativeType().`,
        },
      ],
    };
  }
  const parsed = entry.schema.safeParse(config);
  if (!parsed.success) return { ok: false, issues: parsed.error.issues.map((i) => ({ path: i.path.map((key) => (typeof key === "symbol" ? String(key) : key)), message: i.message })) };
  return { ok: true, config: parsed.data as Record<string, unknown> };
}
