/**
 * OPS-05 live: the runner's Zenith stack as a key-rotation target. The rotation is the installation's own
 * (scripts/deploy/installation.mjs rotateKeys); the API and worker containers are removed and created again from the
 * rotated env files, together, so Temporal payloads and results are read and written on one keyring. Temporal histories
 * are read with the pinned Temporal CLI over the stack's mutual TLS, as an operator would for `key-custody.ts codec`.
 *
 * Nothing here prints a URL, key or secret; refusals name the step only. Histories go to a private runner directory.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { EnvLike } from "../../config";
import { openPlatformDb } from "@/lib/controlplane/db";
import { execRunner, temporalConnectionArgs, temporalTlsFromEnv, toolsFromEnv } from "@/lib/ops/recovery/process";
import { compose, readState } from "../../default-stack/runtime.mjs";
import { readPrepared, rotateKeys } from "../../../deploy/installation.mjs";
import { refuse } from "./mix-03";
import { named, runnerOps04Stack } from "./ops-04-stack";

/** Every key variable an installation holds or a rotation writes (KEY-CUSTODY.md purposes table). */
export const KEY_VARIABLES = ["ZENITH_SECRET_KEY", "ZENITH_VAULT_PREVIOUS_SECRET_KEYS", "ZENITH_TEMPORAL_PAYLOAD_KEY", "ZENITH_TEMPORAL_PREVIOUS_SECRET_KEYS",
  "ZENITH_PLAN_ARTIFACT_KEY", "ZENITH_PLAN_ARTIFACT_PREVIOUS_KEYS", "ZENITH_RUNNER_RESULT_KEY", "ZENITH_RUNNER_RESULT_PREVIOUS_KEYS",
  "ZENITH_CONTROL_SIGNING_JWK", "ZENITH_CONTROL_EXTRA_PUBLIC_JWKS", "ZENITH_OIDC_SIGNING_JWK", "ZENITH_OIDC_EXTRA_PUBLIC_JWKS"] as const;

export interface Ops05Stack {
  /** The installation's key variables as they are now (absent ones omitted), for the operator commands. */
  keys(): Record<string, string>;
  /** Every secret value seen so far (before and after rotation), for the no-key-material scan of operator output. */
  secrets(): string[];
  /** Rotate every generated key, then remove and recreate the API and worker from the rotated env files. */
  rotate(): Promise<void>;
  /** `temporal workflow show --output json` of the operation's workflow, written to a private file; returns its path. */
  history(operationId: string, label: string): Promise<string>;
  close(): Promise<void>;
}

/**
 * The private values a key variable holds: a plain key, each key of a previous-key list, and the private members of a
 * signing JWK. Public JWKs and key ids (`kid`) are not secret; diagnose prints the ids on purpose.
 */
export function privateMaterial(name: string, value: string): string[] {
  if (name.endsWith("_EXTRA_PUBLIC_JWKS")) return [];
  let parsed: unknown;
  try { parsed = JSON.parse(value); } catch { return [value]; }
  if (Array.isArray(parsed)) return parsed.filter((v): v is string => typeof v === "string");
  const jwk = parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : {};
  return ["d", "p", "q", "dp", "dq", "qi", "k"].map(member => jwk[member]).filter((v): v is string => typeof v === "string");
}

export function runnerOps05Stack(env: EnvLike, runId: string): Ops05Stack {
  const directory = env.ZENITH_DEFAULT_STACK_DIRECTORY?.trim() || refuse("no stack directory");
  const platformUrl = env.ZENITH_PLATFORM_DB_URL?.trim() || refuse("no platform database");
  const root = path.join(env.RUNNER_TEMP?.trim() || refuse("no runner temp"), "zenith-ops05");
  const install = path.join(directory, "installation");
  const base = runnerOps04Stack(env, runId);
  const active = readState(directory);
  const seen = new Set<string>();
  const prepared = (): Record<string, string> => (readPrepared(install) as { environment: Record<string, string> }).environment;
  const keys = (): Record<string, string> => {
    const environment = prepared();
    const out: Record<string, string> = {};
    for (const name of KEY_VARIABLES) if (environment[name]) out[name] = environment[name]!;
    for (const [name, value] of Object.entries(out)) for (const secret of privateMaterial(name, value)) seen.add(secret);
    return out;
  };
  keys();
  let db: Awaited<ReturnType<typeof openPlatformDb>> | undefined;
  const live = async () => db ??= await openPlatformDb({ kind: "postgres", url: platformUrl, max: 1, migrate: false });
  return {
    keys,
    secrets: () => [...seen],
    rotate: () => named("the key rotation", async () => {
      await compose(active, ["rm", "--stop", "--force", "api", "execution-worker"]);
      await named("rotating the installation keys", async () => { rotateKeys(install); });
      keys();
      await base.start("api");
      await base.start("execution-worker");
    }),
    history: (operationId, label) => named(`reading the ${label} workflow history`, async () => {
      if (!/^[a-z0-9-]{1,40}$/.test(label)) refuse("an unsafe history label");
      const rows = await (await live()).query<{ workflow_id: string | null }>(
        "select binding->>'workflowId' as workflow_id from platform.workflow_start_intents where operation_id = $1 and phase = 'acknowledged'", [operationId]);
      const workflowId = rows[0]?.workflow_id ?? refuse(`the ${label} operation has no acknowledged workflow start`);
      const namespace = prepared().ZENITH_TEMPORAL_NAMESPACE ?? refuse("no Temporal namespace");
      const shown = await execRunner(toolsFromEnv(env).temporal, ["workflow", "show", ...temporalConnectionArgs(env.ZENITH_TEMPORAL_ADDRESS, temporalTlsFromEnv(env)),
        "--namespace", namespace, "--workflow-id", workflowId, "--output", "json"], { timeoutMs: 120_000 });
      if (shown.code !== 0) refuse(`temporal workflow show exited ${shown.code}`);
      mkdirSync(root, { recursive: true, mode: 0o700 });
      const file = path.join(root, `history-${label}.json`);
      writeFileSync(file, shown.stdout, { mode: 0o600, flag: "wx" });
      return file;
    }),
    async close() {
      await db?.close().catch(() => undefined);
      await base.close();
    },
  };
}
