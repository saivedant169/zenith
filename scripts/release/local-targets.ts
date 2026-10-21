/** Local scenario planning and strict receipts. No engine is started by this module. */
import { z } from "zod";
import path from "node:path";
import catalog from "../../deploy/acceptance/local-targets/scenarios.json";
import type { LocalCommandLane, Scenario } from "./scenarios";
import { DRIVER_CHECKS, OperatedReceiptSchema, OPERATED_LABEL } from "./drivers/operated-contract";
import { DRIVER_CHECKS as TENANT_EXPORT_CHECKS, validateOperatedReceipt as validateTenantExportReceipt, type LocalReceiptBinding } from "./drivers/protocol";
import { OPERATED_CHECKS as UPGRADE_RESTORE_CHECKS, operatedScenario } from "./drivers/contracts";

export { OPERATED_LABEL };

export const LOCAL_GATE = "ZENITH_LOCAL_TARGETS";
export const LOCAL_LABEL = "local_rehearsal";
export type LocalTarget = { target: string; driver?: string; owner?: string };
export const LOCAL_TARGETS: Readonly<Record<string, LocalTarget>> = {
  ...catalog.scenarios,
  "private-source": { target: "operated", driver: "scripts/release/drivers/private-source.ts", owner: "DRV-1" },
  "update-rollback": { target: "operated", driver: "scripts/release/drivers/update-rollback.ts", owner: "DRV-1" },
  "drift-repair": { target: "operated-drv2", driver: "scripts/release/drivers/drift-repair.ts", owner: "DRV-2" },
  "crash-partition": { target: "operated-drv2", driver: "scripts/release/drivers/crash-partition.ts", owner: "DRV-2" },
};
export const OPERATED_CHECKS: Readonly<Record<string, readonly string[]>> = {
  ...DRIVER_CHECKS,
  ...UPGRADE_RESTORE_CHECKS,
  ...TENANT_EXPORT_CHECKS,
  "private-source": ["preconditions", "source-build-preconditions", "browser-source-binding", "private-source-snapshot", "isolated-private-build", "provenance-verified-deploy", "browser-snapshot-approval", "source-revocation-refused", "post-revocation-proposal-refused", "independent-source-readback", "owned-cleanup", "source-unchanged"],
  "update-rollback": ["preconditions", "baseline-readback", "compatible-update-readback", "failed-rollout-readback", "browser-rollback-readback", "independent-release-readback", "owned-cleanup", "source-unchanged"],
};
function sourceScenario(id: string): boolean { return id === "private-source" || id === "update-rollback"; }

export const TARGET_CHECKS: Readonly<Record<string, readonly string[]>> = {
  "operated-two-tenants": TENANT_EXPORT_CHECKS["two-tenants"],
  "operated-export": TENANT_EXPORT_CHECKS.export,
  mixed: ["traffic-acknowledged", "independent-readback", "tls-peer-auth", "private-database"],
  pebble: ["dns-http01", "certificate-issued", "tls-hostname"],
  economics: ["priced", "transfer", "latency", "residency"],
  contracts: ["contracts"],
  billing: ["customer", "invoice", "independent-invoice-read"],
};

export function localTargetLane(scenario: Scenario): LocalCommandLane {
  const target = LOCAL_TARGETS[scenario.id];
  if (!target) throw new Error(`No local target for ${scenario.id}`);
  const drv1 = sourceScenario(scenario.id);
  const drv2 = target.target === "operated-drv2";
  const drv3 = operatedScenario(scenario.id);
  const drv4 = scenario.id === "two-tenants" || scenario.id === "export";
  return {
    id: "local-target", kind: "local_engine", files: ["scripts/release/local-target-runner.ts", "deploy/acceptance/local-targets/scenarios.json", ...(drv1 || drv2 || drv3 || drv4 ? [target.driver!, "scripts/release/drivers/operated.ts", ...(drv2 ? ["scripts/release/drivers/operated-contract.ts"] : drv3 ? ["scripts/release/drivers/contracts.ts"] : drv4 ? ["scripts/release/drivers/protocol.ts"] : [])] : []),
      ...(scenario.id === "export" ? ["scripts/release/drivers/export-data.ts", "scripts/release/drivers/export-data-plan.ts", "scripts/release/drivers/export-data-leg.ts", "scripts/release/drivers/export-data-postgres.ts", "scripts/release/drivers/export-data-mysql.ts", "scripts/release/drivers/export-data-objects.ts"] : [])],
    command: ["node", "node_modules/tsx/dist/cli.mjs", "scripts/release/local-target-runner.ts", "run", "--scenario", scenario.id],
    gates: ["ZENITH_LOCAL_TARGETS=1", "ZENITH_LOCAL_RUN_ID", "ZENITH_LOCAL_ROOT", ...(drv1 ? ["ZENITH_LOCAL_DRV1=1", "ZENITH_DEFAULT_JOURNEY=1", "ZENITH_ACCEPTANCE_DEFAULT_STACK=1", "ZENITH_LOCAL_JOURNEY_CONFIG_FILE"] : []), ...(drv2 ? ["ZENITH_LOCAL_JOINED_DRIVERS=1", "ZENITH_ACCEPTANCE_DEFAULT_STACK=1", "ZENITH_ACCEPTANCE_DEFAULT_STACK_DIR", "ZENITH_DEFAULT_JOURNEY=1", "ZENITH_LOCAL_JOURNEY_CONFIG_FILE", "ZENITH_TEST_DRV2_OPERATED=1"] : []), ...(drv3 ? ["ZENITH_LOCAL_OPERATED=1", "ZENITH_LOCAL_JOINED_DRIVERS=1", "ZENITH_ACCEPTANCE_DEFAULT_STACK=1", "ZENITH_DEFAULT_JOURNEY=1", "ZENITH_ACCEPTANCE_DEFAULT_STACK_DIR", "ZENITH_LOCAL_JOURNEY_CONFIG_FILE", ...(scenario.id === "upgrade" ? ["ZENITH_LOCAL_UPGRADE_IMAGES_FILE"] : [])] : []), ...(drv4 ? ["ZENITH_LOCAL_DRIVER_D4=1", "ZENITH_LOCAL_JOINED_DRIVERS=1", "ZENITH_DEFAULT_JOURNEY=1", "ZENITH_ACCEPTANCE_DEFAULT_STACK=1", "ZENITH_ACCEPTANCE_DEFAULT_STACK_DIR", "ZENITH_LOCAL_JOURNEY_CONFIG_FILE"] : []),
      ...(scenario.id === "export" ? ["ZENITH_LOCAL_EXPORT_DATA=1", "ZENITH_LOCAL_EXPORT_POSTGRES_IMAGE", "ZENITH_LOCAL_EXPORT_MYSQL_IMAGE", "ZENITH_LOCAL_EXPORT_MINIO_IMAGE"] : [])],
    evidenceLabel: drv1 || drv2 || drv3 || drv4 ? OPERATED_LABEL : LOCAL_LABEL,
  };
}

const Receipt = z.object({
  schema: z.literal(1), evidenceLabel: z.enum([LOCAL_LABEL, OPERATED_LABEL]),
  scenarioId: z.string().regex(/^[a-z][a-z0-9-]{1,50}$/),
  runId: z.string().regex(/^[a-z0-9][a-z0-9-]{3,19}$/),
  sourceCommit: z.string().regex(/^[a-f0-9]{40}$/),
  checks: z.array(z.object({ id: z.string().regex(/^[a-z][a-z0-9-]{1,70}$/), status: z.enum(["passed", "failed", "skipped"]) }).strict()).min(1),
  limits: z.array(z.string().min(1).max(300)).min(1),
}).strict();
const SourceBoundReceipt = Receipt.extend({
  sourceDigest: z.string().regex(/^[a-f0-9]{64}$/), dirty: z.boolean(),
}).strict();
export type SourceBoundLocalReceipt = z.infer<typeof SourceBoundReceipt>;
export type LocalReceipt = z.infer<typeof Receipt> | SourceBoundLocalReceipt | z.infer<typeof OperatedReceiptSchema> | ReturnType<typeof validateTenantExportReceipt>;

export function requiredChecks(scenarioId: string): readonly string[] {
  if (sourceScenario(scenarioId)) return OPERATED_CHECKS[scenarioId]!;
  if (scenarioId === "drift-repair" || scenarioId === "crash-partition") return DRIVER_CHECKS[scenarioId];
  if (operatedScenario(scenarioId)) return UPGRADE_RESTORE_CHECKS[scenarioId];
  if (scenarioId === "billing") return TARGET_CHECKS.billing!;
  const target = LOCAL_TARGETS[scenarioId];
  if (!target) throw new Error("Unknown local scenario");
  const checks = TARGET_CHECKS[target.target] ?? [`scenario-${scenarioId}`];
  return scenarioId === "mixed-recovery" ? [...checks, "partition-unavailable", "partition-recovered", "outage-readback"] : checks;
}

export function validateLocalReceipt<S extends string>(raw: unknown, expected: LocalReceiptBinding<S>): LocalReceipt;
export function validateLocalReceipt(raw: unknown, expected: { scenarioId: string; runId: string; sourceCommit: string; sourceDigest?: string }): LocalReceipt {
  if (expected.scenarioId === "two-tenants" || expected.scenarioId === "export") {
    if (!expected.sourceDigest) throw new Error("Local receipt source digest required");
    return validateTenantExportReceipt(raw, { scenarioId: expected.scenarioId, runId: expected.runId, sourceCommit: expected.sourceCommit, sourceDigest: expected.sourceDigest });
  }
  const drv1 = sourceScenario(expected.scenarioId);
  const drv2 = expected.scenarioId === "drift-repair" || expected.scenarioId === "crash-partition";
  const receipt = drv2 ? OperatedReceiptSchema.parse(raw) : drv1 ? SourceBoundReceipt.parse(raw) : Receipt.parse(raw);
  if (receipt.evidenceLabel !== (drv1 || drv2 || operatedScenario(expected.scenarioId) ? OPERATED_LABEL : LOCAL_LABEL)) throw new Error("Local receipt evidence label mismatch");
  for (const key of ["scenarioId", "runId", "sourceCommit"] as const) if (receipt[key] !== expected[key]) throw new Error(`Local receipt ${key} mismatch`);
  const ids = receipt.checks.map(c => c.id);
  if (new Set(ids).size !== ids.length) throw new Error("Duplicate local check");
  for (const id of requiredChecks(expected.scenarioId)) if (!ids.includes(id)) throw new Error(`Missing required local check: ${id}`);
  if ((drv1 || operatedScenario(expected.scenarioId)) && ids.some(id => !requiredChecks(expected.scenarioId).includes(id))) throw new Error("Unknown operated check");
  return receipt;
}

/** Restrict all external HTTP seams to literal loopback; redirects are refused by callers. */
export function loopbackUrl(raw: string, port: number): URL {
  const url = new URL(raw);
  if (!["127.0.0.1", "[::1]"].includes(url.hostname) || Number(url.port) !== port || url.username || url.password) throw new Error("A dedicated literal loopback target is required");
  return url;
}

export function localEnvironment(env: Readonly<Record<string, string | undefined>>): NodeJS.ProcessEnv {
  const clean: NodeJS.ProcessEnv = { NODE_ENV: "test" };
  for (const [key, value] of Object.entries(env)) {
    if (value && (/^(PATH|HOME|USERPROFILE|TMP|TEMP|TMPDIR|SystemRoot|COMSPEC|DOCKER_HOST|DOCKER_CONTEXT|KUBECONFIG)$/i.test(key) || /^ZENITH_(LOCAL_|TEST_)/.test(key) || ["ZENITH_DEFAULT_JOURNEY", "ZENITH_ACCEPTANCE_DEFAULT_STACK", "ZENITH_ACCEPTANCE_DEFAULT_STACK_DIR", "ZENITH_OPERATED_DIAGNOSTICS"].includes(key))) clean[key] = value;
  }
  clean.AWS_EC2_METADATA_DISABLED = "true";
  // Node reads extra CAs at child startup. Admit only the explicit J1 fixture's public CA.
  if (env.ZENITH_ACCEPTANCE_DEFAULT_STACK === "1" && env.ZENITH_ACCEPTANCE_DEFAULT_STACK_DIR && path.isAbsolute(env.ZENITH_ACCEPTANCE_DEFAULT_STACK_DIR)) clean.NODE_EXTRA_CA_CERTS = path.join(env.ZENITH_ACCEPTANCE_DEFAULT_STACK_DIR, "tls/ca.crt");
  return clean;
}
