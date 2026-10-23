/**
 * Every `ZENITH_*` variable the hosted subsystem reads, validated in one place
 * — the same discipline as `@/lib/env` for `ZENITH_*`.
 *
 * Secrets are presence-only here: `ZENITH_CF_API_TOKEN`, `E2B_API_KEY`,
 * `ZENITH_BACKUP_KEY` and `ZENITH_POLICY_SHARED_SECRET` are read by exactly
 * one call site each, never through this module.
 *
 * Memoised on a fingerprint of the raw values, not on first call: a test that
 * sets a ZENITH_* variable after the module loaded still gets a fresh parse,
 * while the hot paths that call this per request stop re-running zod.
 */
import path from "node:path";
import { z } from "zod";
import { env } from "@/lib/env";

const HOST_RE = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/;

const Schema = z.object({
  /** "1" turns on hosted admission rules: no claim re-grant, fail-closed auth, gateway on. */
  ZENITH_HOSTED_MODE: z.enum(["0", "1"]).prefault("0"),
  /** Where the control app is reached by browsers; the exchange redirects come back here. */
  ZENITH_CONTROL_ORIGIN: z.string().url().prefault("http://localhost:3400"),
  /** Registrable domain under which every app gets `<slug>.<domain>`. */
  ZENITH_APP_DOMAIN: z
    .string()
    .regex(HOST_RE, "must be a bare hostname such as apps.localhost or apps.example.com")
    .prefault("apps.localhost"),
  /** Scheme app hosts are served on. http only makes sense for *.localhost. */
  ZENITH_APP_SCHEME: z.enum(["http", "https"]).prefault("http"),
  /**
   * Which implementation backs the hosted subsystem's control authority — the
   * hosted sibling of product A's `ZENITH_STORE` (`@/lib/env`). "sqlite" is the
   * embedded `control.sqlite` authority, per-app SQLite files and artifacts on
   * disk; "postgres" is the `hosted` schema in Supabase over the pooler
   * (`SUPABASE_DB_URL`), per-app rows over PostgREST and artifacts in the
   * Storage bucket. `@/lib/hosted/index` installs whichever this names at boot;
   * see docs/HOSTED-POSTGRES.md.
   */
  ZENITH_HOSTED_STORE: z.enum(["sqlite", "postgres"]).prefault("sqlite"),
  ZENITH_RUNTIME: z.enum(["local", "cloudflare"]).prefault("local"),
  /** Which build runner may run. `none` refuses every build and says why. */
  ZENITH_BUILD_RUNNER: z.enum(["none", "recipe-local", "e2b", "docker"]).prefault("none"),
  /** Immutable E2B template ID; aliases/tags (including `latest`) are rejected. */
  ZENITH_E2B_TEMPLATE: z
    .string()
    .regex(/^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/, "must be a bare E2B template ID, not a tag")
    .refine((v) => v.toLowerCase() !== "latest", "must be an immutable template ID, not latest")
    .optional(),
  /** SHA-256 digest published in the pre-baked template attestation. */
  ZENITH_E2B_TEMPLATE_DIGEST: z
    .string()
    .regex(/^sha256:[0-9a-f]{64}$/, "must be sha256:<64 lowercase hexadecimal characters>")
    .optional(),
  /** Trusted Ed25519 public key used to authenticate the template attestation. */
  ZENITH_E2B_TEMPLATE_ATTESTATION_PUBLIC_KEY: z.string().min(1).optional(),
  ZENITH_ARTIFACT_DIR: z.string().min(1).optional(),
  /** Object-storage bucket published artifacts live in when the store is not local disk. */
  ZENITH_ARTIFACT_BUCKET: z.string().prefault("zenith-artifacts"),
  ZENITH_BACKUP_TARGET: z.enum(["none", "filesystem", "s3"]).prefault("none"),
  ZENITH_BACKUP_DIR: z.string().min(1).optional(),
  ZENITH_BACKUP_S3_BUCKET: z.string().min(1).optional(),
  ZENITH_BACKUP_S3_ENDPOINT: z.string().url().optional(),
  ZENITH_CF_ACCOUNT_ID: z.string().regex(/^[0-9a-f]{32}$/).optional(),
  ZENITH_CF_NAMESPACE: z.string().regex(/^[a-z0-9-]{1,63}$/).optional(),
  /** Candidate probe URL template for the Cloudflare runtime; `{script}` and `{slug}` placeholders. */
  ZENITH_CF_PROBE_URL: z
    .string()
    .url()
    .refine((v) => v.includes("{script}") || v.includes("{slug}"), "must contain a {script} or {slug} placeholder")
    .optional(),
  /** Path to the bundled broker worker module the Cloudflare runtime uploads. */
  ZENITH_CF_BROKER_MODULE: z.string().min(1).optional(),
  /** Monthly envelope the 50/75/90 % spending alerts are measured against. */
  ZENITH_SPEND_ENVELOPE_USD: z.coerce.number().nonnegative().prefault(0),
  /** Comma-separated subjects excluded from activation metrics as founder actors. */
  ZENITH_FOUNDER_SUBJECTS: z.string().prefault(""),
  /** Comma-separated subjects classified as test actors (read by `@/lib/hosted/events`). */
  ZENITH_TEST_SUBJECTS: z.string().prefault(""),
  /** From address for app invitations; falls back to ZENITH_ALERT_FROM. */
  ZENITH_INVITE_FROM: z.string().optional(),
});

export type HostedConfig = Omit<z.infer<typeof Schema>, "ZENITH_HOSTED_MODE"> & {
  hostedMode: boolean;
  artifactDir: string;
  backupDir: string;
  founderSubjects: Set<string>;
};

const present = (key: string): string | undefined => {
  const v = process.env[key];
  return v === undefined || v.trim() === "" ? undefined : v;
};

/** The last parse and the fingerprint of the raw values it was made from. */
let memo: { key: string; config: HostedConfig } | undefined;

export function hostedConfig(): HostedConfig {
  const raw = Object.fromEntries(Object.keys(Schema.shape).map((k) => [k, present(k)]));
  const data = env().ZENITH_DATA;
  // `data` is in the key because artifactDir and backupDir are derived from it.
  const key = JSON.stringify([raw, data]);
  if (memo && memo.key === key) return memo.config;

  const parsed = Schema.safeParse(raw);
  if (!parsed.success) {
    const lines = parsed.error.issues.map(
      (i) => `  ${String(i.path[0])}=${JSON.stringify(process.env[String(i.path[0])] ?? "")} — ${i.message}`
    );
    throw new Error(`Invalid hosted environment:\n${lines.join("\n")}\n\nFix these in .env.local, then start again.`);
  }
  const d = parsed.data;
  const config: HostedConfig = {
    ...d,
    hostedMode: d.ZENITH_HOSTED_MODE === "1",
    artifactDir: d.ZENITH_ARTIFACT_DIR ?? path.join(data, "artifacts"),
    backupDir: d.ZENITH_BACKUP_DIR ?? path.join(data, "backups"),
    founderSubjects: new Set(
      d.ZENITH_FOUNDER_SUBJECTS.split(",")
        .map((s) => s.trim())
        .filter(Boolean)
    ),
  };
  memo = { key, config };
  return config;
}

/**
 * Which implementation backs the hosted control authority. Validated — an
 * unknown value throws from `hostedConfig()` rather than silently meaning
 * "sqlite".
 */
export const hostedStoreKind = (): HostedConfig["ZENITH_HOSTED_STORE"] =>
  hostedConfig().ZENITH_HOSTED_STORE;

/** True when hosted admission rules apply to this process. Safe anywhere. */
export const hostedMode = (): boolean => present("ZENITH_HOSTED_MODE") === "1";


/** Absolute path of the control authority database. */
export const controlDatabasePath = (): string => path.join(env().ZENITH_DATA, "control.sqlite");

/** Per-app data directory (local runtime): database, test database, logs. */
export const appDataDir = (appId: string): string =>
  path.join(env().ZENITH_DATA, "apps", encodeURIComponent(appId));

/** The stable app hostname for a slug, e.g. `tracker.apps.localhost`. */
export function appHostname(slug: string): string {
  return `${slug}.${hostedConfig().ZENITH_APP_DOMAIN}`;
}

/** The browser-facing origin of an app, including the control port when not standard. */
export function appOrigin(slug: string): string {
  const cfg = hostedConfig();
  const control = new URL(cfg.ZENITH_CONTROL_ORIGIN);
  const port = control.port ? `:${control.port}` : "";
  return `${cfg.ZENITH_APP_SCHEME}://${appHostname(slug)}${port}`;
}

export { slugFromHost, isValidAppSlug, gatewayPath, GATEWAY_PREFIX } from "@/lib/hosted/contracts/hosts";
