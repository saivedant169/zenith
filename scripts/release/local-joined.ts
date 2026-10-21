/** Adapt owned J1/J2/J4 evidence without inventing a pass for an uncovered scenario. */
import { readFileSync, writeFileSync, existsSync, lstatSync, accessSync, constants as fsConstants } from "node:fs";
import path from "node:path";
import { defaultExec } from "./acceptance-orchestrator";
import { requiredChecks, validateLocalReceipt, type LocalReceipt } from "./local-targets";
import { readiness } from "../acceptance/default-stack/readiness.mjs";
import { readState } from "../acceptance/default-stack/runtime.mjs";
import { hostEnvironment } from "../acceptance/default-stack/env.mjs";
import { j4HostEnvironment, j4Mode, recordJ4Completion, verifyJ4Prestart } from "../acceptance/default-stack/j4.mjs";
import { operatedScenario } from "./drivers/contracts";

const JOURNEY_CHECKS: Readonly<Record<string, readonly string[]>> = {
  "plan-approval": ["self-approval-refused", "bearer-approval-refused", "stale-semantics-refused", "browser-kind-execution-readback", "rest-proposal-execution-readback", "mcp-proposal-execution-readback"],
  rotation: ["connection-rotation-readback"],
  revocation: ["connection-revocation-no-fallback"],
  teardown: ["cleanup"],
};
/** J4 uses a fresh database on J1's owned local server and a separate API/namespace. */
export function maintenanceEnvironment(base: NodeJS.ProcessEnv, overlay: Record<string, string>): NodeJS.ProcessEnv {
  const allowed = new Set(["ZENITH_PLATFORM_DB_URL", "ZENITH_PLATFORM_DB_MAX", "ZENITH_TEMPORAL_ADDRESS", "ZENITH_TEMPORAL_NAMESPACE", "ZENITH_J4_API_ORIGIN", "ZENITH_J4_CRON_SECRET_FILE", "ZENITH_DATA", "ZENITH_SERVERLESS", "ZENITH_BILLING"]);
  if (Object.keys(overlay).some(key => !allowed.has(key))) throw new Error("Unknown maintenance overlay field");
  const environment = { ...base, ...overlay };
  const owner = new URL(base.ZENITH_PLATFORM_DB_URL ?? ""), database = new URL(environment.ZENITH_PLATFORM_DB_URL ?? "");
  const localHost = (hostname: string) => ["localhost", "127.0.0.1", "[::1]"].includes(hostname);
  if (!localHost(owner.hostname) || !localHost(database.hostname) || database.port !== owner.port
    || database.username !== owner.username || database.password !== owner.password || database.search !== owner.search || database.hash
    || !["postgres:", "postgresql:"].includes(database.protocol) || !/^\/[A-Za-z0-9_-]+$/.test(database.pathname)) throw new Error("Maintenance database must use J1's exact local server and credentials");
  const api = new URL(environment.ZENITH_J4_API_ORIGIN ?? "");
  if (!localHost(api.hostname) || !["http:", "https:"].includes(api.protocol) || api.username || api.password || api.pathname !== "/" || api.search || api.hash) throw new Error("Maintenance API must be local");
  if (!/^j4-[a-z0-9-]{1,50}$/.test(environment.ZENITH_TEMPORAL_NAMESPACE ?? "")
    || !/^(127\.0\.0\.1|localhost):\d+$/.test(environment.ZENITH_TEMPORAL_ADDRESS ?? "")
    || environment.ZENITH_SERVERLESS !== "1" || environment.ZENITH_BILLING !== "managed" || environment.ZENITH_PLATFORM_DB_MAX !== "2"
    || environment.ZENITH_BILLING_STRIPE_SECRET_KEY || environment.ZENITH_CONTROL_KMS_KEY_ID
    || !path.isAbsolute(environment.ZENITH_J4_CRON_SECRET_FILE ?? "") || !path.isAbsolute(environment.ZENITH_DATA ?? "")) throw new Error("Fresh isolated J4 maintenance configuration required");
  environment.SUPABASE_DB_URL = environment.ZENITH_PLATFORM_MIGRATION_URL = database.href;
  const stackDirectory = base.ZENITH_ACCEPTANCE_DEFAULT_STACK_DIR;
  const explicitOwnedJ4Local = base.ZENITH_LOCAL_JOINED_DRIVERS === "1"
    && base.ZENITH_ACCEPTANCE_DEFAULT_STACK === "1" && base.ZENITH_TEST_MAINTENANCE === "1"
    && !!stackDirectory && path.isAbsolute(stackDirectory)
    && !!base.ZENITH_LOCAL_STACK_DIRECTORY && path.resolve(base.ZENITH_LOCAL_STACK_DIRECTORY) === path.resolve(stackDirectory)
    && /^j4-[a-z0-9-]{1,50}$/.test(environment.ZENITH_TEMPORAL_NAMESPACE ?? "")
    && /^(127\.0\.0\.1|localhost):\d+$/.test(environment.ZENITH_TEMPORAL_ADDRESS ?? "");
  if (explicitOwnedJ4Local) {
    // Select only explicit host-local inputs; the runner still verifies version and binary/archive identity.
    const tofuBin = base.ZENITH_LOCAL_TOFU_BIN, identityFile = base.ZENITH_LOCAL_TOFU_IDENTITY_FILE;
    const ownedRegularFile = (file: string | undefined, executable: boolean): string => {
      if (!file || !path.isAbsolute(file)) throw new Error("Explicit owned J4 OpenTofu paths are required");
      try {
        const stat = lstatSync(file);
        const uid = process.getuid?.();
        if (uid === undefined || !stat.isFile() || stat.isSymbolicLink() || stat.uid !== uid) throw new Error();
        accessSync(file, executable ? fsConstants.X_OK : fsConstants.R_OK);
      } catch { throw new Error("Explicit owned J4 OpenTofu paths must be owned regular non-symlink files with required access"); }
      return file;
    };
    environment.NODE_ENV = "test";
    environment.ZENITH_TOFU_BIN = ownedRegularFile(tofuBin, true);
    environment.ZENITH_TOFU_IDENTITY_FILE = ownedRegularFile(identityFile, false);
  }
  return environment;
}
/** Deferred J4 admission is a machine-schedules-only readiness route. */
export function j4ReadinessRoute(state: ReturnType<typeof readState>, scenarioId: string): "j4" | "j1" {
  if (j4Mode(state) === "resuming") throw new Error("J1 and J2 remain blocked until explicit J4 resume passes ordinary readiness");
  if (j4Mode(state) === "deferred") {
    if (scenarioId !== "machine-schedules") throw new Error("Deferred J4 stack refuses J1, J2, install and non-J4 scenarios");
    return "j4";
  }
  if (scenarioId === "machine-schedules") throw new Error("J4 machine-schedules requires its owned deferred J4 stack");
  return "j1";
}
export function journeyScenarioStatus(scenario: string, evidence: unknown): "passed" | "failed" | "skipped" {
  const required = JOURNEY_CHECKS[scenario];
  if (!required) return "skipped";
  if (!evidence || typeof evidence !== "object" || !("checks" in evidence) || !Array.isArray(evidence.checks)) return "failed";
  const checks = evidence.checks as { id?: unknown; status?: unknown }[];
  if (new Set(checks.map(item => item.id)).size !== checks.length) return "failed";
  if (!required.every(id => checks.some(item => item.id === id && item.status === "passed"))) return "failed";
  return "status" in evidence && evidence.status === "passed" ? "passed" : "failed";
}
export async function runJoinedScenario(input: { scenarioId: string; runId: string; sourceCommit: string; receiptFile: string; env: NodeJS.ProcessEnv }): Promise<number> {
  const { scenarioId, runId, sourceCommit, receiptFile, env } = input;
  if (env.ZENITH_LOCAL_JOINED_DRIVERS !== "1" || env.ZENITH_ACCEPTANCE_DEFAULT_STACK !== "1" || !env.ZENITH_ACCEPTANCE_DEFAULT_STACK_DIR || existsSync(receiptFile)) throw new Error("Owned default stack and explicit joined-driver gates required");
  // J1 proves ownership, source bytes, native architecture, migrations and readiness.
  const state = readState(env.ZENITH_ACCEPTANCE_DEFAULT_STACK_DIR);
  const readinessRoute = j4ReadinessRoute(state, scenarioId);
  if (readinessRoute === "j4" && operatedScenario(scenarioId)) throw new Error("J4 does not admit operated J1 scenarios");
  if (operatedScenario(scenarioId)) {
    if (env.ZENITH_LOCAL_OPERATED !== "1") return 2;
    // Start with J1's private CA at process launch, so real Auth requests verify TLS.
    const child = await defaultExec([process.execPath, "node_modules/tsx/dist/cli.mjs", `scripts/release/drivers/${scenarioId}.ts`,
      "--run-id", runId, "--source-commit", sourceCommit, "--receipt", receiptFile],
      { cwd: process.cwd(), env: { ...env, ...hostEnvironment(state) }, timeoutMs: 3_600_000 });
    if (child.code === 2) return 2;
    const receipt = validateLocalReceipt(JSON.parse(readFileSync(receiptFile, "utf8")), { scenarioId, runId, sourceCommit });
    return child.code === 0 && receipt.checks.every(check => check.status === "passed") ? 0 : 1;
  }
  const j4 = readinessRoute === "j4";
  if (j4 && env.ZENITH_TEST_MAINTENANCE !== "1") throw new Error("J4 natural-timer gate required");
  if (j4) await verifyJ4Prestart(state);
  const ready = j4 ? { failed: 0, skipped: 0, passed: 1 } : await readiness(state);
  Object.assign(env, j4 ? j4HostEnvironment(state) : hostEnvironment(state));
  let status: "passed" | "failed" | "skipped" = "passed";
  const limits = ["Owned local rehearsal only; no live cloud or production acceptance."];
  if (scenarioId === "install") {
    if (ready.failed !== 0 || ready.skipped !== 0 || ready.passed < 1) status = "failed";
  } else if (scenarioId === "machine-schedules") {
    if (env.ZENITH_TEST_MAINTENANCE !== "1") throw new Error("J4 natural-timer gate required");
    const j4Overlay = path.join(state.directory, "j4/maintenance.env");
    const file = j4 ? j4Overlay : env.ZENITH_LOCAL_MAINTENANCE_ENV_FILE;
    if (j4 && env.ZENITH_LOCAL_MAINTENANCE_ENV_FILE && path.resolve(env.ZENITH_LOCAL_MAINTENANCE_ENV_FILE) !== j4Overlay) throw new Error("J4 uses only its owned private maintenance overlay");
    if (!file || !path.isAbsolute(file) || lstatSync(file).isSymbolicLink() || !lstatSync(file).isFile() || (lstatSync(file).mode & 0o077) !== 0) throw new Error("Private J4 maintenance overlay FILE required");
    const overlay: Record<string, string> = {};
    for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
      if (!line || line.startsWith("#")) continue;
      const match = /^([A-Z][A-Z0-9_]*)=([^\0]*)$/.exec(line);
      if (!match || match[1] in overlay) throw new Error("Malformed or duplicate maintenance overlay field");
      overlay[match[1]] = match[2];
    }
    if (j4) {
      const expected = j4HostEnvironment(state);
      if (Object.keys(overlay).length !== 9 || Object.entries(overlay).some(([key, value]) => expected[key] !== value)) {
        throw new Error("J4 overlay must exactly match this owned stack, namespace, database and private runtime");
      }
    }
    const child = await defaultExec([process.execPath, "node_modules/tsx/dist/cli.mjs", "scripts/acceptance/maintenance/run.ts"], { cwd: process.cwd(), env: maintenanceEnvironment(env, overlay), timeoutMs: 1_080_000 });
    if (child.code !== 0) throw new Error("J4 natural maintenance acceptance failed; retain the owned engines for inspection");
    const evidence = JSON.parse(child.stdout.trim()) as Record<string, unknown>;
    if (evidence.naturalTimers !== true || evidence.workerRestart !== true || evidence.fallbackResumed !== true || evidence.jobLeaseExclusion !== true) status = "failed";
    if (status === "passed") await recordJ4Completion(state, evidence);
    limits.push("J4 default scheduling evidence; provider machine transports remain separately gated.");
  } else {
    const config = env.ZENITH_LOCAL_JOURNEY_CONFIG_FILE;
    if (!config || !path.isAbsolute(config) || lstatSync(config).isSymbolicLink() || !lstatSync(config).isFile() || env.ZENITH_DEFAULT_JOURNEY !== "1") throw new Error("Private J2 configuration and journey gate required");
    const output = `${receiptFile}.journey.json`;
    const child = await defaultExec([process.execPath, "scripts/acceptance/default-journey.mjs", "--config", config, "--receipt", output], { cwd: process.cwd(), env, timeoutMs: 1_080_000 });
    status = child.code === 0 ? journeyScenarioStatus(scenarioId, JSON.parse(readFileSync(output, "utf8"))) : "failed";
    if (status === "skipped") limits.push("The J2 journey has no independent check for this scenario. This receipt is incomplete; run its dedicated acceptance lane.");
  }
  const receipt: LocalReceipt = { schema: 1, evidenceLabel: "local_rehearsal", scenarioId, runId, sourceCommit, checks: requiredChecks(scenarioId).map(id => ({ id, status })), limits };
  validateLocalReceipt(receipt, { scenarioId, runId, sourceCommit });
  writeFileSync(receiptFile, JSON.stringify(receipt, null, 2), { mode: 0o600, flag: "wx" });
  return status === "passed" ? 0 : status === "skipped" ? 3 : 1;
}
