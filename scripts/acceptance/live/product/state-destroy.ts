/**
 * Live-sandbox cleanup for product scenarios that deploy through OpenTofu. The product refuses teardown after a deploy
 * (docs/LIMITATIONS.md, "Teardown after deploy"), so the harness destroys exactly what the environment's recorded state
 * holds: an empty configuration over the product's own S3 state, applied with the connection's deploy role. Nothing
 * outside that state is touched, and the state is re-read afterwards: any resource left is a leak.
 *
 * Credentials arrive in memory only (an STS session of the sandbox deploy role) and reach OpenTofu through its process
 * environment. They are never written to the work directory, logged or returned. Output from OpenTofu is withheld.
 */
import { execFile } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { backendFile } from "@/lib/tofu/backend-config";
import type { BackendConfig } from "@/lib/tofu/backend-config";

export interface SessionCredentials { accessKeyId: string; secretAccessKey: string; sessionToken: string }
export type Exec = (file: string, args: string[], options: { cwd: string; env: Record<string, string | undefined>; timeoutMs: number }) => Promise<{ code: number; stdout: string }>;
export interface StateDestroyInput {
  tofu: string;
  region: string;
  backend: BackendConfig;
  stateKey: string;
  credentials: SessionCredentials;
  exec?: Exec;
}

const REGION = /^[a-z]{2}(-[a-z]+)+-\d$/;
const AWS_PROVIDER = /^provider\["registry\.opentofu\.org\/hashicorp\/aws"\](?:\.([a-z0-9_]{1,40}))?$/;

const defaultExec: Exec = (file, args, options) => new Promise(resolve => {
  execFile(file, args, { cwd: options.cwd, env: options.env as NodeJS.ProcessEnv, timeout: options.timeoutMs, maxBuffer: 64 * 1024 * 1024 }, (error, stdout) => {
    const code = error ? (typeof (error as { code?: unknown }).code === "number" ? (error as { code: number }).code : 1) : 0;
    resolve({ code, stdout: String(stdout ?? "") });
  });
});

/** Aliased AWS providers in the state need a configuration block; only region-named aliases (us_east_1) are accepted. */
export function providerBlocks(state: unknown, region: string): Record<string, unknown>[] {
  const resources = (state as { resources?: unknown })?.resources;
  if (resources !== undefined && !Array.isArray(resources)) throw new Error("The recorded state is not readable.");
  const blocks: Record<string, unknown>[] = [{ region }];
  const aliases = new Set<string>();
  for (const resource of (resources ?? []) as { provider?: unknown }[]) {
    if (typeof resource.provider !== "string" || !resource.provider.includes("/hashicorp/aws\"]")) continue;
    const match = AWS_PROVIDER.exec(resource.provider);
    if (!match) throw new Error("The recorded state uses an AWS provider address this cleanup does not accept.");
    if (match[1]) aliases.add(match[1]);
  }
  for (const alias of [...aliases].sort()) {
    const aliasRegion = alias.replace(/_/g, "-");
    if (!REGION.test(aliasRegion)) throw new Error("The recorded state uses an AWS provider alias that is not a region name.");
    blocks.push({ alias, region: aliasRegion });
  }
  return blocks;
}

/** One OpenTofu work directory over the recorded state, with the session credentials only in the child environment. */
async function withState<T>(input: StateDestroyInput, work: (tofu: { run: (args: string[], what: string, timeoutMs?: number) => Promise<string>; write: (providers: Record<string, unknown>[]) => void; state: unknown }) => Promise<T>): Promise<T> {
  if (!REGION.test(input.region)) throw new Error("Invalid cleanup region.");
  const exec = input.exec ?? defaultExec;
  const dir = mkdtempSync(path.join(os.tmpdir(), "zenith-state-destroy-"));
  const env: Record<string, string | undefined> = {
    PATH: process.env.PATH, HOME: dir, TF_IN_AUTOMATION: "1", TF_INPUT: "0", CHECKPOINT_DISABLE: "1",
    AWS_ACCESS_KEY_ID: input.credentials.accessKeyId, AWS_SECRET_ACCESS_KEY: input.credentials.secretAccessKey,
    AWS_SESSION_TOKEN: input.credentials.sessionToken, AWS_REGION: input.region, AWS_EC2_METADATA_DISABLED: "true",
  };
  const run = async (args: string[], what: string, timeoutMs = 10 * 60_000) => {
    const result = await exec(input.tofu, [...args, "-no-color"], { cwd: dir, env, timeoutMs });
    if (result.code !== 0) throw new Error(`OpenTofu ${what} failed during cleanup; resources may remain.`);
    return result.stdout;
  };
  const write = (providers: Record<string, unknown>[]) => writeFileSync(path.join(dir, "main.tf.json"),
    JSON.stringify({ ...backendFile(input.backend, input.region, input.stateKey).file, provider: { aws: providers } }), { mode: 0o600 });
  try {
    write([{ region: input.region }]);
    await run(["init", "-input=false"], "init");
    let state: unknown;
    try { state = JSON.parse((await run(["state", "pull"], "state read")) || "{}"); } catch (error) {
      if (error instanceof SyntaxError) throw new Error("The recorded state is not readable.");
      throw error;
    }
    return await work({ run, write, state });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** The recorded state document, read-only (for readback of what the product deployed). */
export function readState(input: StateDestroyInput): Promise<unknown> {
  return withState(input, async ({ state }) => state);
}

/**
 * Destroys everything in the recorded state, then proves the state is empty. Throws a fixed message on any failure.
 * Returns the ARNs it destroyed: some linger in the tag inventory after deletion (INACTIVE ECS clusters and task
 * definitions, deleted security-group rules).
 */
export function destroyFromState(input: StateDestroyInput): Promise<{ destroyed: number; destroyedArns: string[] }> {
  return withState(input, async ({ run, write, state }) => {
    const count = Array.isArray((state as { resources?: unknown })?.resources) ? ((state as { resources: unknown[] }).resources).length : 0;
    write(providerBlocks(state, input.region));
    if (count > 0) await run(["apply", "-auto-approve", "-input=false", "-lock-timeout=120s"], "destroy", 45 * 60_000);
    // `state list` fails on an empty or absent state ("No state file was found!"); re-read the document instead.
    let after: unknown;
    try { after = JSON.parse((await run(["state", "pull"], "state re-read")) || "{}"); } catch (error) {
      if (error instanceof SyntaxError) throw new Error("The recorded state is not readable after cleanup.");
      throw error;
    }
    const left = Array.isArray((after as { resources?: unknown })?.resources) ? ((after as { resources: unknown[] }).resources).length : 0;
    if (left !== 0) throw new Error(`${left} resource(s) remain in the recorded state after cleanup.`);
    const resources = (state as { resources?: { type?: unknown; instances?: { attributes?: { arn?: unknown } }[] }[] })?.resources;
    const destroyedArns = (Array.isArray(resources) ? resources : [])
      .flatMap(r => (Array.isArray(r.instances) ? r.instances : []).map(i => i.attributes?.arn)).filter((a): a is string => typeof a === "string");
    return { destroyed: count, destroyedArns };
  });
}

/** First instance attribute of a resource type in the state, if any. */
export function stateAttribute(state: unknown, type: string, attribute: string): unknown {
  const resources = (state as { resources?: { type?: unknown; instances?: { attributes?: Record<string, unknown> }[] }[] })?.resources;
  for (const resource of Array.isArray(resources) ? resources : []) {
    if (resource.type !== type) continue;
    for (const instance of Array.isArray(resource.instances) ? resource.instances : []) {
      if (instance.attributes && Object.hasOwn(instance.attributes, attribute)) return instance.attributes[attribute];
    }
  }
  return undefined;
}
