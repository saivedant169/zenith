/**
 * Every `ZENITH_*` variable the server reads, in one validated place — plus
 * `SUPABASE_DB_URL`, which keeps Supabase's own name and is validated (never
 * read for its value) here alongside them.
 *
 * Before this module the 13 reads were scattered and ad-hoc: a typo in
 * `ZENITH_FAST` silently meant "slow", and `ZENITH_LLM_MODEL` — which decides
 * which model you pay for — was documented nowhere at all.
 *
 * Two deliberate exclusions:
 *
 *  - `NEXT_PUBLIC_*` (the Supabase keys) must stay as literal
 *    `process.env.NEXT_PUBLIC_…` expressions in `lib/supabase/env.ts`. Next
 *    inlines those at build time by matching the literal text; reading them
 *    through a function yields `undefined` in the browser bundle.
 *  - Provider credentials (`AWS_ACCESS_KEY_ID`, `SUPABASE_SERVICE_ROLE_KEY`,
 *    `ANTHROPIC_API_KEY`) are presence-only flags here. Their values stay at
 *    their single call site, so this module never becomes somewhere a secret
 *    can be read from by accident.
 *
 * Read on every call rather than memoised: the scripts and the test suite
 * both set `ZENITH_DATA` at runtime before importing anything, and a cached
 * snapshot would silently ignore them. The ten raw values ARE re-read every
 * time; only the zod parse of an unchanged set of them is reused, so a
 * mid-process change is still picked up on the very next call.
 */
import path from "node:path";
import { z } from "zod";

/** The model that translates Navigator goals when a key is configured. */
export const DEFAULT_LLM_MODEL = "claude-opus-5-5";

/**
 * How to produce a valid `ZENITH_SECRET_KEY`. One string, so the boot failure,
 * every refused write and the inspector's banner all say the same thing.
 */
export const SECRET_KEY_FIX =
  "Set ZENITH_SECRET_KEY in .env.local to a 32-byte key and restart the server — generate one with `openssl rand -base64 32` (hex is accepted too). Keep the same key; to rotate it, put the old key in ZENITH_VAULT_PREVIOUS_SECRET_KEYS (a JSON array) and run `npm run vault:rewrap` (docs/platform/operations/RECOVERY.md).";

/**
 * How to make email alert delivery work. One string, so the env validation
 * error, the refused send and the channel's plan all say the same thing.
 */
export const SMTP_FIX =
  "Set ZENITH_SMTP_URL in .env.local to smtp://user:pass@host:port (smtps:// for implicit TLS) and ZENITH_ALERT_FROM to the address the mail comes from, then restart the server. Webhook and Slack channels need neither.";

/**
 * The 32 raw bytes of `ZENITH_SECRET_KEY`, or undefined if it is not a key.
 * Accepts base64 (with or without padding) and hex, because both are what the
 * usual one-liners print.
 */
export function decodeSecretKey(raw: string): Buffer | undefined {
  const s = raw.trim();
  const buf = /^[0-9a-fA-F]{64}$/.test(s) ? Buffer.from(s, "hex") : Buffer.from(s, "base64");
  return buf.length === 32 ? buf : undefined;
}

const Schema = z.object({
  /** Data directory: JSON snapshot plus the event and audit logs. */
  ZENITH_DATA: z.string().min(1).prefault(path.join(process.cwd(), ".data")),
  /** "1" collapses simulated step durations. Anything else is off. */
  ZENITH_FAST: z.enum(["0", "1"]).prefault("0"),
  /**
   * Which implementation backs product A's store (`src/lib/db/store.ts`).
   * "file" is the embedded JSON snapshot + JSONL logs and the only one this
   * build ships; "postgres" parses here — the flag exists end to end — and is
   * refused by the store itself, saying so.
   */
  ZENITH_STORE: z.enum(["file", "postgres"]).prefault("file"),
  /** LocalStack's edge endpoint. */
  ZENITH_LOCALSTACK_ENDPOINT: z.string().url().prefault("http://localhost:4566"),
  /** Model id for the Navigator's optional language front-end. */
  ZENITH_LLM_MODEL: z.string().min(1).prefault(DEFAULT_LLM_MODEL),
  /** Lowest level `lib/log.ts` emits. */
  ZENITH_LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).prefault("info"),
  /**
   * How long the engine waits on one provider step before failing it. Default
   * is generous (5 min): the slowest honest step in the catalog is a 45s ECR
   * push, and a real cloud can be slower than its own estimate.
   */
  ZENITH_STEP_TIMEOUT_MS: z.coerce.number().int().positive().prefault(5 * 60_000),
  /**
   * Optional. Encrypts the secret store (`lib/secrets`). Unset means Zenith
   * has nowhere to hold a secret value and says so instead of pretending.
   * Validated for shape only — the bytes never leave `decodeSecretKey`.
   */
  ZENITH_SECRET_KEY: z
    .string()
    .refine((v) => decodeSecretKey(v) !== undefined, `must decode to exactly 32 bytes. ${SECRET_KEY_FIX}`)
    .optional(),
  /**
   * Optional. The SMTP server email alert channels send through. Unset means an
   * email channel refuses to send and says so — webhook and Slack channels are
   * unaffected. The password is in this string, so it never reaches a response.
   */
  ZENITH_SMTP_URL: z
    .string()
    .refine(
      (v) => /^smtps?:\/\/.+/.test(v.trim()),
      `must be an SMTP URL. ${SMTP_FIX}`
    )
    .optional(),
  /**
   * Optional. The Supabase Supavisor **transaction-mode** pooler URL (port
   * 6543) a Postgres-backed store connects through. Not a `ZENITH_*` name
   * because it is Supabase's, and the one exception to the rule above: it is
   * validated for shape here, never read for its value by this module. It
   * carries the database password, so it is treated exactly like
   * SUPABASE_SERVICE_ROLE_KEY — never logged, and redacted out of the
   * validation error below.
   */
  SUPABASE_DB_URL: z.string().url().optional(),
  /* -------------------------- platform control store ------------------------- */
  /*
   * The platform control store (ADR-0002, `src/lib/controlplane/db`). Its one
   * reader is `platformDbConfigFromEnv()` in `controlplane/db/open.ts`; these
   * entries exist so a malformed value fails at boot with the others.
   */
  /** "pglite" (in-process, local) or "postgres". Unset: postgres when a URL is set, else pglite. */
  ZENITH_PLATFORM_DB: z.enum(["pglite", "postgres"]).optional(),
  /** Postgres URL for schema `platform`; falls back to SUPABASE_DB_URL. Carries a password — redacted below. */
  ZENITH_PLATFORM_DB_URL: z.string().url().optional(),
  /** Connection pool size for the platform store (default 5). */
  ZENITH_PLATFORM_DB_MAX: z.coerce.number().int().positive().max(100).optional(),
  /* ---------------------- workload identity and signing ---------------------- */
  /*
   * Read in exactly one place, `loadCredentialsConfig()` in
   * `src/lib/credentials/config.ts`, which wraps every private key in a
   * SecretString and names variables — never values — in errors. Kept loose
   * here (like the agent family) because that reader validates them.
   */
  /** OIDC issuer URL for cloud workload-identity federation; required wherever tokens are minted. */
  ZENITH_OIDC_ISSUER: z.string().url().optional(),
  /** RS256 private JWK (JSON or base64 JSON) for the OIDC issuer. Secret. Prefer the KMS variant in production. */
  ZENITH_OIDC_SIGNING_JWK: z.string().optional(),
  ZENITH_OIDC_KMS_KEY_ID: z.string().optional(),
  /** Extra PUBLIC keys to publish in the JWKS during rotation (private members are refused). */
  ZENITH_OIDC_EXTRA_PUBLIC_JWKS: z.string().optional(),
  /** Ed25519 private JWK that signs capability grants, runner jobs and machine requests. Secret. */
  ZENITH_CONTROL_SIGNING_JWK: z.string().optional(),
  ZENITH_CONTROL_KMS_KEY_ID: z.string().optional(),
  ZENITH_CONTROL_EXTRA_PUBLIC_JWKS: z.string().optional(),
  /* ------------------------------ agent access ------------------------------ */
  /*
   * The `ZENITH_AGENT_*` family, which until now was read straight out of
   * `process.env` in six files and documented in three docs that could drift
   * from it (ADR D-10).
   *
   * **Every one of them is `z.string().optional()`, deliberately.** The rest of
   * this schema tightens shapes because a typo in `ZENITH_FAST` silently meant
   * "slow". These are different: they are live on a production deployment
   * today, and each already has a call site that validates it and refuses with
   * a message naming the fix — `boundary.ts` parses `ZENITH_AGENT_ORIGIN` as a
   * URL per request, `oauth.ts` parses the issuer and JWKS URLs, and the flags
   * are compared to the literal `"1"` so anything else is "off". Tightening
   * them here would move those refusals from the request that needs them to
   * boot, turning a misconfigured variable into a deployment that does not
   * start — a behaviour change this round has no business making. So the
   * family is *declared and documented* here, read through one place, and
   * validated where it already was.
   */
  /** `"1"` enables the v2 reviewed-operations control plane. Anything else is off. */
  ZENITH_AGENT_CONTROL: z.string().optional(),
  /**
   * `"1"` enables reviewed writes **on the single-writer file store only**. On
   * `ZENITH_STORE=postgres` it governs nothing: writes follow the scopes on the
   * linked credential, which a person approved in the browser.
   */
  ZENITH_AGENT_WRITES: z.string().optional(),
  /** `"1"` enables the v1 read-only reader. Anything else is off. */
  ZENITH_AGENT_READER: z.string().optional(),
  /** The origin agent transports accept and build review URLs from. Parsed as a URL at its call sites. */
  ZENITH_AGENT_ORIGIN: z.string().optional(),
  /** Absolute path to the POSIX credential file the v1 reader authenticates against. */
  ZENITH_AGENT_CREDENTIAL_FILE: z.string().optional(),
  /** External OAuth resource-server issuer, when remote origins are admitted. */
  ZENITH_AGENT_OAUTH_ISSUER: z.string().optional(),
  /** JWKS URL for that issuer. */
  ZENITH_AGENT_OAUTH_JWKS: z.string().optional(),
  /** Which claim carries the client id. Defaults to `client_id` at the call site. */
  ZENITH_AGENT_OAUTH_CLIENT_CLAIM: z.string().optional(),
  /** Which claim carries the subject. Defaults to `sub` at the call site. */
  ZENITH_AGENT_OAUTH_SUBJECT_CLAIM: z.string().optional(),
  /** Platform observability backends (PROD-OBS-02). Operator configuration, never tenant input. */
  ZENITH_OBSERVE_PROMETHEUS_URL: z.string().url().optional(),
  ZENITH_OBSERVE_PROMETHEUS_TOKEN: z.string().optional(),
  ZENITH_OBSERVE_LOKI_URL: z.string().url().optional(),
  ZENITH_OBSERVE_LOKI_TOKEN: z.string().optional(),
  /** Loki multi-tenant org id, sent as `X-Scope-OrgID`. */
  ZENITH_OBSERVE_LOKI_TENANT: z.string().optional(),
  /** Optional. The From address on alert email. Required alongside ZENITH_SMTP_URL. */
  ZENITH_ALERT_FROM: z
    .string()
    .refine(
      (v) => /.+@.+\..+/.test(v.trim()),
      'must contain an email address, e.g. "Zenith <zenith@example.com>" or "zenith@example.com".'
    )
    .optional(),
});

export type ZenithEnv = Omit<z.infer<typeof Schema>, "ZENITH_FAST"> & {
  /** True only when ZENITH_FAST is exactly "1". */
  ZENITH_FAST: boolean;
};

/** An unset variable and one set to "" mean the same thing: use the default. */
const present = (key: string): string | undefined => {
  const v = process.env[key];
  return v === undefined || v.trim() === "" ? undefined : v;
};

/** Exactly the variables `Schema` describes, in one place: read, then parse. */
const RAW_KEYS = [
  "ZENITH_DATA",
  "ZENITH_FAST",
  "ZENITH_STORE",
  "ZENITH_LOCALSTACK_ENDPOINT",
  "ZENITH_LLM_MODEL",
  "ZENITH_LOG_LEVEL",
  "ZENITH_STEP_TIMEOUT_MS",
  "ZENITH_SECRET_KEY",
  "ZENITH_SMTP_URL",
  "ZENITH_ALERT_FROM",
  "ZENITH_OBSERVE_PROMETHEUS_URL",
  "ZENITH_OBSERVE_PROMETHEUS_TOKEN",
  "ZENITH_OBSERVE_LOKI_URL",
  "ZENITH_OBSERVE_LOKI_TOKEN",
  "ZENITH_OBSERVE_LOKI_TENANT",
  "SUPABASE_DB_URL",
  "ZENITH_PLATFORM_DB",
  "ZENITH_PLATFORM_DB_URL",
  "ZENITH_PLATFORM_DB_MAX",
  "ZENITH_OIDC_ISSUER",
  "ZENITH_OIDC_SIGNING_JWK",
  "ZENITH_OIDC_KMS_KEY_ID",
  "ZENITH_OIDC_EXTRA_PUBLIC_JWKS",
  "ZENITH_CONTROL_SIGNING_JWK",
  "ZENITH_CONTROL_KMS_KEY_ID",
  "ZENITH_CONTROL_EXTRA_PUBLIC_JWKS",
  "ZENITH_AGENT_CONTROL",
  "ZENITH_AGENT_WRITES",
  "ZENITH_AGENT_READER",
  "ZENITH_AGENT_ORIGIN",
  "ZENITH_AGENT_CREDENTIAL_FILE",
  "ZENITH_AGENT_OAUTH_ISSUER",
  "ZENITH_AGENT_OAUTH_JWKS",
  "ZENITH_AGENT_OAUTH_CLIENT_CLAIM",
  "ZENITH_AGENT_OAUTH_SUBJECT_CLAIM",
] as const;

/**
 * The last successful parse, and the exact raw input that produced it. Values
 * are read fresh every call; this only saves re-running zod when nothing the
 * schema looks at has moved. A failed parse is never cached, so a broken
 * environment throws the same error every time it is asked.
 */
let memo: { fingerprint: string; data: z.infer<typeof Schema> } | undefined;

/**
 * Validated view of the environment. Throws with the offending variable, what
 * it received and what it accepts — the failure a misconfigured deployment
 * should get at boot, instead of a confusing default three screens later.
 */
export function env(): ZenithEnv {
  const raw: Record<string, string | undefined> = {};
  // `cwd` is part of the input: an unset ZENITH_DATA defaults to `.data` under
  // it, and the scripts chdir.
  let fingerprint = process.cwd();
  for (const key of RAW_KEYS) {
    const value = present(key);
    raw[key] = value;
    // Length-prefixed so no value can forge the boundary between two of them.
    // `present()` collapses unset and empty, so "" is unambiguous here.
    fingerprint += `|${key}:${value === undefined ? -1 : value.length}:${value ?? ""}`;
  }

  if (memo?.fingerprint !== fingerprint) {
    const parsed = Schema.safeParse(raw);

    if (!parsed.success) {
      const lines = parsed.error.issues.map((i) => {
        const key = String(i.path[0] ?? "(unknown)");
        const rawValue = process.env[key] ?? "";
        // A rejected key is still key material, and a rejected SMTP or
        // database URL still carries a password — echoing any of them would put
        // it in the boot log. Say how long it was; that is what makes the error
        // actionable.
        const secretish =
          key === "ZENITH_SECRET_KEY" || key === "ZENITH_SMTP_URL" || key === "SUPABASE_DB_URL" || key === "ZENITH_PLATFORM_DB_URL" ||
          key === "ZENITH_OBSERVE_PROMETHEUS_TOKEN" || key === "ZENITH_OBSERVE_LOKI_TOKEN" || key === "ZENITH_OBSERVE_PROMETHEUS_URL" || key === "ZENITH_OBSERVE_LOKI_URL" ||
          key === "ZENITH_OIDC_SIGNING_JWK" || key === "ZENITH_CONTROL_SIGNING_JWK";
        const shown = secretish ? `(${rawValue.length} chars, hidden)` : JSON.stringify(rawValue);
        return `  ${key}=${shown} — ${i.message}`;
      });
      throw new Error(
        `Invalid environment:\n${lines.join("\n")}\n\nFix these in .env.local (see .env.local.example) or in the process environment, then start again.`
      );
    }

    memo = { fingerprint, data: parsed.data };
  }

  return { ...memo.data, ZENITH_FAST: memo.data.ZENITH_FAST === "1" };
}

/** Which optional integrations this process has keys for. Never the values. */
export function configured(): { anthropic: boolean; awsCredentials: boolean } {
  return {
    anthropic: !!present("ANTHROPIC_API_KEY"),
    awsCredentials: !!present("AWS_ACCESS_KEY_ID"),
  };
}
