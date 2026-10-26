import { destroyApplyLaneIds, integrationWorkflowIds, integrationPlatformIds, incomingWorkflowIds, wave5PlatformIds, wave5WorkflowIds, withoutIncomingPlatform as withoutIncomingPlatformCohort } from "./incoming-cohort-fixture";
/**
 * Parsed workflow gates cover the platform that exists. Suite discovery catches
 * narrower filters; mandatory evidence reports catch skipped real-engine tests.
 * Cloud APIs in platform e2e are still mocked, never live acceptance evidence.
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { load } from "js-yaml";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import vitestConfig from "../../vitest.config";
import { AGENT_JOURNAL_POSTGRES_REQUIREMENTS, CRITICAL_SCHEDULE_TEMPORAL_REQUIREMENTS, LINUX_GUEST_SERVICE_CASES, LINUX_GUEST_RUNNER_UPDATE_CASES, LINUX_GUEST_PID1_CASES, INCIDENT_OWNERSHIP_HARDENING_POSTGRES_REQUIREMENTS, SAVED_PLAN_SETTLEMENT_POSTGRES_REQUIREMENTS, CLEANUP_WRITER_BARRIER_POSTGRES_REQUIREMENTS, KUBERNETES_CONNECTION_LINK_POSTGRES_REQUIREMENTS, MIXED_CHILD_CUSTODY_POSTGRES_REQUIREMENTS, PLAN_RETENTION_POSTGRES_REQUIREMENTS, KUBERNETES_VAULT_TARGET_POSTGRES_REQUIREMENTS, packagedWorkerManifest, APPLY_CURRENT_AUTHORITY_POSTGRES_REQUIREMENTS, NATIVE_OAUTH_DISPATCH_POSTGRES_REQUIREMENTS, NATIVE_CREDENTIAL_FACTORY_POSTGRES_REQUIREMENTS, OAUTH_GRANT_POSTGRES_REQUIREMENTS, PLAN_PRODUCT_RETAINED_WAIT_POSTGRES_REQUIREMENTS, PLAN_PRODUCT_AUTHORITY_POSTGRES_REQUIREMENTS, EXECUTION_LEASE_TENANT_POSTGRES_REQUIREMENTS, AWS_BOOTSTRAP_READINESS_POSTGRES_REQUIREMENTS, MCP_DURABLE_ADMISSION_POSTGRES_REQUIREMENTS, MCP_START_SOURCE_AUTHORITY_POSTGRES_REQUIREMENTS, MCP_START_SOURCE_AUTHORITY_SDK_REQUIREMENTS, CORE_CHECKS, linuxGuestManifest, manifestFor, requirementId } from "../../scripts/ci/gate-manifest.mjs";
import { reportFailures, requirementsFor, TOFU_SUITES } from "./assert-lane-report.mjs";

interface Step {
  name?: string; run?: string; if?: string; shell?: string; id?: string;
  env?: Record<string, unknown>;
  "working-directory"?: string; "continue-on-error"?: boolean;
}
interface Job { steps: Step[]; env?: Record<string, unknown>; if?: string; "continue-on-error"?: boolean }
const root = process.cwd();
function modelRoot(prefix: string): string {
  const directory = fs.mkdtempSync(prefix);
  for (const relative of ["tests/effects", "tests/repair", "tests/coding-agent"]) fs.mkdirSync(path.join(directory, relative), { recursive: true });
  return directory;
}

const workflow = load(fs.readFileSync(path.join(root, ".github/workflows/ci.yml"), "utf8")) as { jobs: Record<string, Job> };

// Only fixed service, runner-update, and SYS1 additions leave historical Linux comparisons.
// Current execution continues to require all 159 observations.
const runnerUpdateGuestIds = new Set(LINUX_GUEST_RUNNER_UPDATE_CASES.map(item => item.id));
const pid1GuestIds = new Set(LINUX_GUEST_PID1_CASES.map(item => item.id));
const serviceGuestIds = new Set(LINUX_GUEST_SERVICE_CASES.map(item => item.id));
function priorServiceLinuxCases(items: ReturnType<typeof linuxGuestManifest>["requiredCases"]) {
  return items.filter(item => !serviceGuestIds.has(item.id) && !runnerUpdateGuestIds.has(item.id) && !pid1GuestIds.has(item.id));
}

// Historical cohort checks remove only exact newly committed identities. The
// production manifest and validator continue to require the complete successor.
const nativeOAuthDiscovered = {
  "file": "tests/controlplane/plan-artifact-oauth-authority.test.ts",
  "suite": "native OAuth original-plan dispatch [postgres; modeled hosted REST and policy]",
  "backend": "postgres"
} as const;
const nativeSafetyDiscovered = [
  {
    "file": "tests/controlplane/mixed-child-admission.test.ts",
    "suite": "native mixed child custody [postgres]",
    "backend": "postgres"
  },
  {
    "file": "tests/controlplane/plan-artifact-retention.test.ts",
    "suite": "plan artifact retention preview [postgres; synthetic storage and receipt fixtures]",
    "backend": "postgres"
  }
] as const;
const kubernetesLinkDiscovered = {
  file: "tests/controlplane/kubernetes-connection-link.test.ts",
  suite: "human Kubernetes connection linking [postgres; modeled hosted association, human request and namespace API]",
  backend: "postgres",
} as const;
// Wave-2 scheduling additions remain mandatory; only historical comparisons exclude these exact IDs.
const wave2WorkflowIds = new Set([
  "workflows:tests/workflows/critical-schedule.test.ts:4ee93ed6c454",
  "workflows:tests/platform/critical-jobs.test.ts:4ee93ed6c454",
]);
// Exact reviewed replay and core workflow successors leave predecessor comparisons; unknown IDs stay visible.
const replayAdditionIds = new Set([
  "workflows:tests/platform/error-boundary.test.ts:4ee93ed6c454",
  "workflows:tests/workflows/history-replay.test.ts:11c9372298c4",
  "workflows:tests/workflows/history-replay.test.ts:ca053d4a7ffa",
  "workflows:tests/workflows/history-replay.test.ts:fd56cd941022",
  "workflows:tests/workflows/history-replay.test.ts:8744128c0a9e",
  "workflows:tests/workflows/history-replay.test.ts:1c364350141a",
  "workflows:tests/workflows/history-replay.test.ts:eaca45b6d6b7",
  "workflows:tests/workflows/history-replay.test.ts:87db48b6511e",
  "workflows:tests/workflows/history-replay.test.ts:3aef3e2319a2",
  "workflows:tests/workflows/history-replay.test.ts:2511e70410ac",
  "workflows:tests/workflows/history-replay.test.ts:f862c0ca2f28",
  "workflows:tests/workflows/history-replay.test.ts:217cee7bdf53",
  "workflows:tests/workflows/history-replay.test.ts:d24898d990cb",
  "workflows:tests/workflows/history-replay.test.ts:9bd63aa2eb20",
  "workflows:tests/workflows/history-replay.test.ts:d9916b20ed8f",
  "workflows:tests/workflows/history-replay.test.ts:10fbc2c302bb",
  "workflows:tests/workflows/history-replay.test.ts:4f2aef1cd9ac",
  "workflows:tests/workflows/history-replay.test.ts:e0a8479c4469",
  "workflows:tests/workflows/history-replay.test.ts:599d31f58731",
  "workflows:tests/workflows/history-replay.test.ts:c7ee74ad2f02",
  "workflows:tests/workflows/history-replay.test.ts:be8dffb99b65",
  "workflows:tests/workflows/history-replay.test.ts:7d76388ab023",
  "workflows:tests/workflows/history-replay.test.ts:404108cfbc97",
  "workflows:tests/workflows/history-replay.test.ts:dcdea3bad29a",
  "workflows:tests/workflows/history-replay.test.ts:b614b4ac1f76",
  "workflows:tests/workflows/history-replay.test.ts:faa76b639737",
  "workflows:tests/workflows/history-replay.test.ts:be6df6808e1a",
  "workflows:tests/workflows/history-replay.test.ts:7a72efa28e05",
  "workflows:tests/workflows/history-replay.test.ts:1bb1bc14d9b8",
  "workflows:tests/workflows/history-replay.test.ts:1ed963fe5b4e",
  "workflows:tests/workflows/versioning-audit.test.ts:42b84e22c212",
  "workflows:tests/workflows/versioning-audit.test.ts:7d93ce0f1ca7",
  "workflows:tests/workflows/versioning-audit.test.ts:05156f32cdf6",
  "workflows:tests/workflows/versioning-audit.test.ts:c336390bb162",
  "workflows:tests/workflows/versioning-audit.test.ts:daf8e7f59be8"
]);
function withoutReplayAdditions(items: ReturnType<typeof requirementsFor>): ReturnType<typeof requirementsFor> {
  return items.filter(item => !replayAdditionIds.has(item.id));
}
const criticalScheduleWorkflowIds = new Set(CRITICAL_SCHEDULE_TEMPORAL_REQUIREMENTS.map(item => requirementId("workflows", item)));
function priorCriticalScheduleWorkflowRequirements(sourceRoot = root) {
  return withoutReplayAdditions(requirementsFor("workflows", sourceRoot)).filter(item => !criticalScheduleWorkflowIds.has(item.id) && !incomingWorkflowIds.has(item.id) && !integrationWorkflowIds.has(item.id));
}
function priorWave2WorkflowRequirements() {
  return priorCriticalScheduleWorkflowRequirements().filter(item => !wave2WorkflowIds.has(item.id));
}
const currentSuccessorPlatformCohort = [
  { file: "tests/controlplane/incident-stability.test.ts", suite: "incident stability [postgres]", postgres: true },
  { file: "tests/controlplane/machine-runbooks.test.ts", suite: "machine runbook store [postgres]", postgres: true },
  { file: "tests/capabilities/field-ownership-broker.test.ts", suite: "propose field ownership [postgres]", postgres: true },
  { file: "tests/controlplane/ownership-transfers.test.ts", suite: "ownership transfer immutable service-role custody [postgres]", backend: "postgres" },
  { file: "tests/controlplane/release-pipelines.test.ts", suite: "release pipeline store [postgres]", postgres: true },
  { file: "tests/capabilities/portability-broker.test.ts", suite: "portability proposals [postgres]", postgres: true },
] as const;
// Only these five explicitly registered names leave predecessor comparisons.
// Current validation still requires every named case, even if its file is deleted.
// Exact additive snapshot IDs leave only historical comparisons; unknown successors remain.
const ownershipSnapshotCasIds = new Set([
  "platform-postgres:tests/controlplane/ownership-transfers.test.ts:7ba9c4b9e2c1",
  "platform-postgres:tests/controlplane/ownership-transfers.test.ts:01845bf26fdf",
  "platform-postgres:tests/controlplane/ownership-transfers.test.ts:2ecc5e990013",
  "platform-postgres:tests/controlplane/ownership-transfers.test.ts:65045d56d958",
  "platform-postgres:tests/controlplane/ownership-transfers.test.ts:a3e783c044c9",
  "platform-postgres:tests/controlplane/ownership-transfers.test.ts:6c2424b7f1de",
  "platform-postgres:tests/controlplane/ownership-transfers.test.ts:b0212eb1a020",
  "platform-postgres:tests/controlplane/ownership-transfers.test.ts:852f3777058a",
  "platform-postgres:tests/controlplane/ownership-transfers.test.ts:7049bff8d926",
  "platform-postgres:tests/controlplane/ownership-transfers.test.ts:10a59cc38f80"
]);
function priorOwnershipSnapshotRequirements(requirements: ReturnType<typeof requirementsFor>) {
  return requirements.filter(item => !ownershipSnapshotCasIds.has(item.id) && !destroyApplyLaneIds.has(item.id));
}
function withoutIncomingPlatform(requirements: ReturnType<typeof requirementsFor>) {
  return withoutIncomingPlatformCohort(priorOwnershipSnapshotRequirements(requirements));
}
const hardeningPlatformIds = INCIDENT_OWNERSHIP_HARDENING_POSTGRES_REQUIREMENTS.map(item => requirementId("platform-postgres", item));
function priorHardeningPlatformRequirements(sourceRoot = root) {
  const ids = new Set(hardeningPlatformIds);
  return withoutIncomingPlatform(requirementsFor("platform-postgres", sourceRoot)).filter(item => !ids.has(item.id));
}
function priorCurrentSuccessorPlatformRequirements(sourceRoot = root) {
  const ids = new Set(currentSuccessorPlatformCohort.map(item => requirementId("platform-postgres", item)));
  return priorHardeningPlatformRequirements(sourceRoot).filter(item => !ids.has(item.id));
}
function priorSettlementPlatformRequirements(sourceRoot = root) {
  const ids = new Set(SAVED_PLAN_SETTLEMENT_POSTGRES_REQUIREMENTS.map(item => requirementId("platform-postgres", item)));
  return priorCurrentSuccessorPlatformRequirements(sourceRoot).filter(item => !ids.has(item.id));
}
function priorCleanupPlatformRequirements(sourceRoot = root) {
  const discovered = { file: "tests/controlplane/cleanup-writer-barriers.test.ts", suite: "native cleanup writer barrier [postgres; modeled hosted association and policy]", backend: "postgres" } as const;
  const ids = new Set([...CLEANUP_WRITER_BARRIER_POSTGRES_REQUIREMENTS, discovered].map(item => requirementId("platform-postgres", item)));
  return priorSettlementPlatformRequirements(sourceRoot).filter(item => !ids.has(item.id));
}
function priorKubernetesLinkPlatformRequirements(sourceRoot = root) {
  const ids = new Set([...KUBERNETES_CONNECTION_LINK_POSTGRES_REQUIREMENTS, kubernetesLinkDiscovered].map(item => requirementId("platform-postgres", item)));
  return priorCleanupPlatformRequirements(sourceRoot).filter(item => !ids.has(item.id));
}
function priorNativeSafetyPlatformRequirements(sourceRoot = root) {
  const ids = new Set([...MIXED_CHILD_CUSTODY_POSTGRES_REQUIREMENTS, ...PLAN_RETENTION_POSTGRES_REQUIREMENTS, ...KUBERNETES_VAULT_TARGET_POSTGRES_REQUIREMENTS, ...nativeSafetyDiscovered].map(item => requirementId("platform-postgres", item)));
  return priorKubernetesLinkPlatformRequirements(sourceRoot).filter(item => !ids.has(item.id));
}
function priorApplyCurrentAuthorityPlatformRequirements(sourceRoot = root) {
  const ids = new Set(APPLY_CURRENT_AUTHORITY_POSTGRES_REQUIREMENTS.map(item => requirementId("platform-postgres", item)));
  return priorNativeSafetyPlatformRequirements(sourceRoot).filter(item => !ids.has(item.id));
}
function priorNativeOAuthPlatformRequirements(sourceRoot = root) {
  const ids = new Set([...NATIVE_OAUTH_DISPATCH_POSTGRES_REQUIREMENTS, ...NATIVE_CREDENTIAL_FACTORY_POSTGRES_REQUIREMENTS, nativeOAuthDiscovered].map(item => requirementId("platform-postgres", item)));
  return priorApplyCurrentAuthorityPlatformRequirements(sourceRoot).filter(item => !ids.has(item.id));
}

function priorPlanProductPlatformRequirements() {
  const extra = [
  {
    "file": "tests/controlplane/plan-artifact-product-authority.test.ts",
    "suite": "paired plan product dispatch authority [postgres; modeled current roles and hosted association]",
    "backend": "postgres"
  },
  {
    "file": "tests/capabilities/default-broker-origin.test.ts",
    "suite": "private default broker origin [postgres; factory provenance only]",
    "backend": "postgres"
  },
  {
    "file": "tests/controlplane/plan-artifact-integration-authority.test.ts",
    "suite": "native linked integration original-plan dispatch [postgres; modeled hosted REST and policy]",
    "backend": "postgres"
  }
];
  const ids = new Set([...PLAN_PRODUCT_AUTHORITY_POSTGRES_REQUIREMENTS, ...PLAN_PRODUCT_RETAINED_WAIT_POSTGRES_REQUIREMENTS, ...extra].map(item => requirementId("platform-postgres", item)));
  return priorNativeOAuthPlatformRequirements().filter(item => !ids.has(item.id));
}

function priorRetainedWaitPlatformRequirements() {
  const ids = new Set(PLAN_PRODUCT_RETAINED_WAIT_POSTGRES_REQUIREMENTS.map(item => requirementId("platform-postgres", item)));
  return priorNativeOAuthPlatformRequirements().filter(item => !ids.has(item.id));
}

function testsUnder(directory: string): string[] {
  return fs.readdirSync(path.join(root, directory), { withFileTypes: true }).flatMap((entry) => {
    const file = `${directory}/${entry.name}`;
    return entry.isDirectory() ? testsUnder(file) : /\.test\.tsx?$/.test(file) ? [file] : [];
  });
}

/** Detect executable comparisons, including static bracket access, without treating quoted source or comments as runtime gates. */
function hasTofuNetworkComparison(source: string, fileName = "fixture.test.ts"): boolean {
  // Escape sequences can spell the property without its literal source token.
  // Sources with either form still use the complete AST walk below.
  if (!source.includes("ZENITH_TEST_TOFU_NETWORK") && !source.includes("\\")) return false;
  const ast = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, fileName.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const unwrap = (input: ts.Expression): ts.Expression => {
    let node = input;
    while (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isTypeAssertionExpression(node)
      || ts.isNonNullExpression(node) || ts.isSatisfiesExpression(node)) node = node.expression;
    return node;
  };
  const member = (input: ts.Expression, name: string): ts.Expression | undefined => {
    const node = unwrap(input);
    if (ts.isPropertyAccessExpression(node) && node.name.text === name) return node.expression;
    if (ts.isElementAccessExpression(node) && node.argumentExpression && ts.isStringLiteral(node.argumentExpression)
      && node.argumentExpression.text === name) return node.expression;
    return undefined;
  };
  const network = (input: ts.Expression): boolean => {
    const environment = member(input, "ZENITH_TEST_TOFU_NETWORK"), process = environment && member(environment, "env");
    return !!process && ts.isIdentifier(unwrap(process)) && unwrap(process).getText(ast) === "process";
  };
  let found = false;
  const visit = (node: ts.Node): void => {
    if (ts.isBinaryExpression(node)
      && [ts.SyntaxKind.EqualsEqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsEqualsToken,
        ts.SyntaxKind.EqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsToken].includes(node.operatorToken.kind)
      && (network(node.left) || network(node.right))) found = true;
    ts.forEachChild(node, visit);
  };
  visit(ast);
  return found;
}

function gate(jobName: string, command: string, condition?: string): Step {
  const job = workflow.jobs[jobName];
  expect(job, `${jobName} must remain a mandatory CI job`).toBeDefined();
  expect(job.if).toBeUndefined();
  expect(job["continue-on-error"]).toBeUndefined();
  const matches = job.steps.filter((step) => step.run?.trim() === command);
  expect(matches, `${jobName} must run ${command}`).toHaveLength(1);
  expect(matches[0].if).toBe(condition);
  expect(matches[0]["continue-on-error"]).toBeUndefined();
  return matches[0];
}

describe("platform suite coverage", () => {
  it("runs both Vitest projects with every Node and DOM suite included", () => {
    gate("verify", "node scripts/ci/run-gate.mjs core --run --step unit");
    expect(CORE_CHECKS.find((check) => check.id === "unit")?.command).toEqual(["node", "node_modules/vitest/vitest.mjs", "run", "--project=node", "--project=dom", "--maxWorkers=2"]);
    const config = vitestConfig as { test?: { include?: string[]; exclude?: string[]; projects?: { test?: { name?: string; include?: string[]; exclude?: string[] } }[] } };
    expect(config.test?.include).toBeUndefined();
    expect(config.test?.exclude).toBeUndefined();
    expect(config.test?.projects).toHaveLength(2);
    for (const [name, extension] of [["node", "ts"], ["dom", "tsx"]]) {
      const project = config.test?.projects?.find((candidate) => candidate.test?.name === name);
      expect(project?.test?.include).toEqual([`tests/**/*.test.${extension}`]);
      expect(project?.test?.exclude).toBeUndefined();
    }
  });

  it.each(["agent-v3", "cli", "placement", "platform-ui", "security", "ci"])("keeps tests/%s behind the unfiltered unit gate", (directory) => {
    expect(testsUnder(`tests/${directory}`).length).toBeGreaterThan(0);
    gate("verify", "node scripts/ci/run-gate.mjs core --run --step unit");
    expect(CORE_CHECKS.find((check) => check.id === "unit")?.command).toEqual(["node", "node_modules/vitest/vitest.mjs", "run", "--project=node", "--project=dom", "--maxWorkers=2"]);
  });

  it.each([
    ["verify", "node scripts/ci/run-gate.mjs core --run --step lint"], ["verify", "node scripts/ci/run-gate.mjs core --run --step typecheck"],
    ["policy", "npm run policy:check"],
    ["generated", "npm run platform:emit-sql -- --check"],
    ["generated", "npx tsx scripts/docs/capability-matrix.ts --check"],
    ["generated", "npx vitest run tests/docs --maxWorkers=2"],
    ["ledger", "node scripts/build/ledger.mjs --check"],
  ])("requires %s: %s", (job, command) => { gate(job, command); });

  it.each([["postgres", "postgres"], ["policy", "policy"], ["tofu", "tofu"], ["workflows", "workflows"], ["platform-postgres", "platform"]])("requires real-engine evidence in %s even when Vitest fails", (lane, reportName) => {
    const job = workflow.jobs[lane];
    const report = `.data-ci-lane/${reportName}-lane.json`;
    const assertion = gate(lane, `node scripts/ci/run-gate.mjs ${lane} --validate ${report} --require-execution`, "always()");
    const manifest = manifestFor(lane, root);
    expect(manifest.report).toBe(report);
    const suiteSteps = job.steps.filter((step) => step.run === `node scripts/ci/run-gate.mjs ${lane} --run`);
    expect(suiteSteps).toHaveLength(1);
    const suites = suiteSteps[0];
    expect(suites.if).toBeUndefined();
    expect(suites["continue-on-error"]).toBeUndefined();
    expect(manifest.command).not.toContain("--passWithNoTests");
    expect(manifest.command).toContain(`--outputFile.json=${report}`);
    expect(manifest.command).toContain("--no-file-parallelism");
    expect(manifest.command).toContain("--maxWorkers=1");
    expect(job.steps.indexOf(assertion)).toBeGreaterThan(job.steps.indexOf(suites));
    const filters = manifest.files;
    for (const required of requirementsFor(lane, root)) {
      expect(filters.some((filter) => required.file === filter || required.file.startsWith(`${filter}/`)), `${lane} must execute ${required.file}`).toBe(true);
    }
  });

  it("checks every network-gated file and the actual gated suite titles", () => {
    const networkFiles = testsUnder("tests").filter((file) => hasTofuNetworkComparison(fs.readFileSync(path.join(root, file), "utf8"), file));
    expect(networkFiles.length).toBeGreaterThan(0);
    const dispatchModes = ["expired approval", "revoked approver role", "new policy denial", "expiry after authority check", "expiry during role lookup"];
    const handoffCases = [
      "producer exits and loses its directory; another worker applies ORIGINAL bytes after a separate fresh check, then destroys",
      "fresh semantic drift refuses before dispatch and has no original/fresh fallback",
      "source/config/backend/address-map/lock/tool and operation swaps refuse before mutation",
      "tampering with the original after inspection refuses before apply and preserves uncertainty after dispatch",
      "stale original state serial refuses even when independent fresh semantic plan is unchanged, with no fallback",
      "source review completes, browser human approval is consumed, and destination destroys the associated ORIGINAL",
      "restore into a fresh PostgreSQL store with matching keys preserves the original; missing keys refuse",
      "fake cipher authority and arbitrary runner handles cannot mint production admission",
      "matching immutable source identity consumes original bytes and a different source digest refuses before dispatch",
      "independent saved binary with matching native private source binding applies the exact original once",
      "independent saved binary refuses committed private source revocation before original apply without a fresh fallback",
    ];
    const productHandoffCases = [
      "saved product original binary changed owning region during paired current-role wait fences actual apply effects",
      "saved product original binary approver demotion during paired current-role wait fences actual apply effects",
      "saved product original binary benign UI pointer advance during paired current-role wait fences actual apply effects",
      "saved product original binary unchanged owning target during paired current-role wait fences actual apply effects",
      "associated saved product destroy binary fences destination subject demotion during paired current-role wait",
      "associated saved product destroy binary fences approver demotion during paired current-role wait",
      "associated saved product destroy binary fences unchanged destination during paired current-role wait",
    ];
    expect(handoffCases).toHaveLength(11);
    expect(productHandoffCases).toEqual(PLAN_PRODUCT_AUTHORITY_POSTGRES_REQUIREMENTS.filter(item => item.file === "tests/tofu/plan-artifact-handoff.test.ts").map(item => item.test));
    const allHandoffCases = [...handoffCases, ...productHandoffCases];
    expect(new Set(allHandoffCases).size).toBe(18);
    const productHandoffSourceTitles = [
      "saved product original binary %s during paired current-role wait fences actual apply effects",
      "changed owning region", "approver demotion", "benign UI pointer advance", "unchanged owning target",
      "associated saved product destroy binary fences %s during paired current-role wait",
      "destination subject demotion", "unchanged destination",
    ];
    const platformSuites: { file: string; suite: string; cases: string[]; backendCases: string[]; sourceTitles: string[] }[] = [
      { file: "tests/execution/apply.test.ts", suite: "dispatch current authority [postgres]", cases: [...dispatchModes.map((mode) => `refuses ${mode} after fresh replan and before durable dispatch`), ...APPLY_CURRENT_AUTHORITY_POSTGRES_REQUIREMENTS.map(item => item.test)], backendCases: [], sourceTitles: ["refuses %s after fresh replan and before durable dispatch", ...dispatchModes, ...APPLY_CURRENT_AUTHORITY_POSTGRES_REQUIREMENTS.map(item => item.test)] },
      { file: "tests/tofu/plan-artifact-handoff.test.ts", suite: "authenticated original cross-worker handoff [postgres]", cases: allHandoffCases, backendCases: productHandoffCases, sourceTitles: [...handoffCases, ...productHandoffSourceTitles] },
      { file: "tests/security/plan-artifact-secrecy.test.ts", suite: "encrypted plan artifact secrecy [postgres]", cases: [], backendCases: [], sourceTitles: ["sensitive read-only originals persist only ciphertext; key rotation, tenant domains and tampering fail closed"] },
    ];
    const platformManifest = manifestFor("platform-postgres", root);
    const platformNetwork = platformSuites.flatMap(({ file, suite, cases, backendCases, sourceTitles }) => {
      const required = platformManifest.requirements.filter((requirement) => requirement.file === file);
      expect(required.map((requirement) => ({ suite: requirement.suite, test: requirement.test, postgres: requirement.postgres, backend: requirement.backend })), `${file}: exact mandatory PostgreSQL scenarios`).toEqual(
        (cases.length > 0 ? cases : [undefined]).map((test) => ({ suite, test,
          postgres: backendCases.includes(test ?? "") ? undefined : true,
          backend: backendCases.includes(test ?? "") ? "postgres" : undefined }))
      );
      const source = fs.readFileSync(path.join(root, file), "utf8");
      for (const title of [suite, ...sourceTitles]) expect(source, `${file}: gated suite or case title drifted`).toContain(JSON.stringify(title));
      expect(platformManifest.files, `${file}: must execute in the canonical PostgreSQL lane`).toContain(file);
      expect(platformManifest.excludeFiles, `${file}: cannot be excluded from real-engine execution`).not.toContain(file);
      return required;
    });
    const cleanupFile = "tests/controlplane/cleanup-writer-barriers.test.ts";
    const cleanupSuite = "native cleanup writer barrier [postgres; modeled hosted association and policy]";
    const cleanupCases = [...CLEANUP_WRITER_BARRIER_POSTGRES_REQUIREMENTS, ...SAVED_PLAN_SETTLEMENT_POSTGRES_REQUIREMENTS];
    expect(CLEANUP_WRITER_BARRIER_POSTGRES_REQUIREMENTS).toHaveLength(61);
    expect(SAVED_PLAN_SETTLEMENT_POSTGRES_REQUIREMENTS).toHaveLength(54);
    expect(new Set(cleanupCases.map(item => requirementId("platform-postgres", item))).size).toBe(115);
    const cleanupNetwork = platformManifest.requirements.filter(item => item.file === cleanupFile);
    expect(cleanupNetwork).toEqual([
      { file: cleanupFile, suite: cleanupSuite, backend: "postgres", id: requirementId("platform-postgres", { file: cleanupFile, suite: cleanupSuite, backend: "postgres" }) },
      ...cleanupCases.map(item => ({ ...item, id: requirementId("platform-postgres", item) })),
    ]);
    expect(cleanupCases.every(item => item.file === cleanupFile && item.suite === cleanupSuite && item.backend === "postgres")).toBe(true);
    expect(platformManifest.command.some(argument => cleanupFile === argument || cleanupFile.startsWith(`${argument}/`))).toBe(true);
    expect(platformManifest.excludeFiles).not.toContain(cleanupFile);
    expect(platformManifest.env).toMatchObject({ ZENITH_TEST_CLEANUP_WRITER_BARRIER_REQUIRED: "1", ZENITH_TEST_SAVED_PLAN_SETTLEMENT_REQUIRED: "1" });
    // run-gate applies manifest flags to the actual child environment, including
    // the cleanup flag that is not repeated in the workflow's job environment.
    expect(fs.readFileSync(path.join(root, "scripts/ci/sanitize-evidence.mjs"), "utf8")).toContain("return { ...env, ...manifestFor(lane, root).env }");
    const commandRunner = fs.readFileSync(path.join(root, "scripts/ci/run-gate.mjs"), "utf8");
    expect(commandRunner).toContain("const env = effectiveEnvironmentFor(lane, process.cwd())");
    expect(commandRunner).toContain("spawnSync(process.execPath, command, { cwd: process.cwd(), env, stdio: \"inherit\" })");
    expect(workflow.jobs["platform-postgres"].env?.ZENITH_TEST_SAVED_PLAN_SETTLEMENT_REQUIRED).toBe("1");
    expect(platformManifest.prerequisites.some(value => value.startsWith("ZENITH_TEST_SAVED_PLAN_SETTLEMENT_REQUIRED=1;") && value.includes("OpenTofu"))).toBe(true);
    expect(networkFiles).toContain(cleanupFile);
    const tracked = new Set([...TOFU_SUITES.map(([file]) => file), ...platformNetwork.map((required) => required.file), ...cleanupNetwork.map(item => item.file)]);
    for (const file of networkFiles) expect(tracked.has(file), `${file} needs a real-engine requirement`).toBe(true);
    for (const [file, suite] of TOFU_SUITES) expect(fs.readFileSync(path.join(root, file), "utf8"), `${file}: suite title drifted`).toContain(JSON.stringify(suite));
    expect(workflow.jobs.tofu.env?.ZENITH_TEST_TOFU_NETWORK).toBe("1");
    expect(platformManifest.env.ZENITH_TEST_TOFU_NETWORK).toBe("1");
    expect(platformManifest.tools).toEqual({ node: "22.23.3", postgres: "16.15", tofu: "1.12.5" });
    expect(workflow.jobs["platform-postgres"].env?.ZENITH_TEST_TOFU_NETWORK).toBe("1");
    expect(workflow.jobs["platform-postgres"].env?.ZENITH_TEST_PLATFORM_PG_URL).toBe("postgresql://postgres:zenith-ci-throwaway@127.0.0.1:5432/zenith_platform_ci");
  });

  it("executes all 71 accepted G2 native cases with their exact source and mandatory PostgreSQL flags", () => {
    const manifest = manifestFor("platform-postgres", root);
    const required = [...MCP_DURABLE_ADMISSION_POSTGRES_REQUIREMENTS, ...AWS_BOOTSTRAP_READINESS_POSTGRES_REQUIREMENTS];
    const ids = new Set(required.map(item => requirementId("platform-postgres", item)));
    expect(required).toHaveLength(71);
    expect(manifest.requirements.filter(item => ids.has(item.id))).toEqual(required.map(item => ({ ...item, id: requirementId("platform-postgres", item) })));
    expect(priorPlanProductPlatformRequirements()).toHaveLength(624);
    expect(new Set(priorPlanProductPlatformRequirements().map(item => item.id)).size).toBe(624);
    expect(manifest.env).toMatchObject({
      ZENITH_TEST_MCP_DEPLOY_ADMISSION_REQUIRED: "1", ZENITH_TEST_DEFAULT_CURRENT_MEMBERSHIP_REQUIRED: "1",
      ZENITH_TEST_OPENED_HANDLE_REQUIRED: "1", ZENITH_TEST_AWS_PREFLIGHT_REQUIRED: "1",
    });
    for (const item of required) {
      expect(manifest.command.some(argument => argument === item.file || item.file.startsWith(`${argument}/`))).toBe(true);
      expect(manifest.excludeFiles).not.toContain(item.file);
    }
    expect(manifest.command).toContain("tests/platform/aws-bootstrap-preflight-admission.test.ts");
    expect(manifest.excludeFiles).toEqual([]);
    expect(manifest.command).not.toContain("--passWithNoTests");
  });

  it("requires every final MCP native and SDK case without substituting protocol evidence for PostgreSQL", () => {
    const manifest = manifestFor("platform-postgres", root);
    const pg = MCP_START_SOURCE_AUTHORITY_POSTGRES_REQUIREMENTS;
    const sdk = MCP_START_SOURCE_AUTHORITY_SDK_REQUIREMENTS;
    const required = [...pg, ...sdk];
    expect(pg).toHaveLength(72);
    expect(sdk).toHaveLength(17);
    const ids = new Set(required.map(item => requirementId("platform-postgres", item)));
    expect(manifest.requirements.filter(item => ids.has(item.id))).toEqual(required.map(item => ({ ...item, id: requirementId("platform-postgres", item) })));
    expect(manifest.env.ZENITH_TEST_MCP_START_SOURCE_AUTHORITY_REQUIRED).toBe("1");
    for (const item of required) {
      expect(manifest.command.some(argument => argument === item.file || item.file.startsWith(`${argument}/`))).toBe(true);
      expect(manifest.excludeFiles).not.toContain(item.file);
    }
    for (const item of pg) expect(item).toMatchObject({ backend: "postgres", suite: "MCP final start source authority [postgres; modeled external protocols]" });
    for (const item of sdk) {
      expect(item).toMatchObject({ suite: "default product client provenance [SDK protocol; no network]" });
      expect(item).not.toHaveProperty("postgres");
      expect(item).not.toHaveProperty("backend");
    }
    expect(manifest.requirements).toContainEqual(expect.objectContaining({ file: pg[0].file, suite: pg[0].suite, backend: "postgres", id: requirementId("platform-postgres", { file: pg[0].file, suite: pg[0].suite, backend: "postgres" }) }));
    expect(priorPlanProductPlatformRequirements()).toHaveLength(624);
    expect(new Set(priorPlanProductPlatformRequirements().map(item => item.id)).size).toBe(624);
    expect(manifest.command).not.toContain("--passWithNoTests");
  });

  it("requires all seven tenant-qualified native lease controls in the existing PostgreSQL lane", () => {
    const manifest = manifestFor("platform-postgres", root);
    const required = EXECUTION_LEASE_TENANT_POSTGRES_REQUIREMENTS;
    expect(required).toHaveLength(7);
    const ids = new Set(required.map(item => requirementId("platform-postgres", item)));
    expect(manifest.requirements.filter(item => ids.has(item.id))).toEqual(required.map(item => ({ ...item, id: requirementId("platform-postgres", item) })));
    expect(manifest.env.ZENITH_TEST_FIRST_SOURCE_LEASE_REQUIRED).toBe("1");
    for (const item of required) {
      expect(item).toMatchObject({ file: "tests/controlplane/first-source-lease-binding.test.ts", suite: "first source worker lease binding [postgres]", postgres: true });
      expect(manifest.command.some(argument => argument === item.file || item.file.startsWith(`${argument}/`))).toBe(true);
      expect(manifest.excludeFiles).not.toContain(item.file);
    }
    expect(priorPlanProductPlatformRequirements()).toHaveLength(624);
    expect(new Set(priorPlanProductPlatformRequirements().map(item => item.id)).size).toBe(624);
    expect(manifest.command).not.toContain("--passWithNoTests");
  });

  it("exports the Temporal variable its helper reads and enables e2e/time skipping/history checks", () => {
    const job = workflow.jobs.workflows;
    expect(job.env?.ZENITH_COMPOSE_TEMPORAL_MODE).toBe("time-skipping");
    expect(job.env?.ZENITH_TEST_TEMPORAL_DOWNLOAD).toBe("1");
    expect(job.env?.ZENITH_SEC_TEMPORAL).toBe("1");
    const installer = job.steps.find((step) => step.name === "Install pinned Temporal CLI");
    expect(installer?.run).toContain('echo "ZENITH_TEST_TEMPORAL_CLI=$RUNNER_TEMP/temporal-cli/temporal" >> "$GITHUB_ENV"');
    expect(fs.readFileSync(path.join(root, "tests/workflows/support.ts"), "utf8")).toContain("process.env.ZENITH_TEST_TEMPORAL_CLI");
    const requirements = requirementsFor("workflows", root).map((required) => required.file);
    for (const file of ["tests/platform/deploy-e2e.test.ts", "tests/workflows/approval-time.test.ts", "tests/security/workflow-history.test.ts"]) expect(requirements).toContain(file);
  });

  it("requires migrations, capability contracts and reconciliation to exercise Postgres", () => {
    const requirements = requirementsFor("platform-postgres", root);
    for (const file of ["tests/controlplane/migrations.test.ts", "tests/capabilities/store-contract.test.ts", "tests/reconcile/platform.test.ts"]) expect(requirements).toContainEqual(expect.objectContaining({ file, postgres: true, id: expect.stringContaining(`platform-postgres:${file}:`) }));
    expect(requirements).toContainEqual(expect.objectContaining({ file: "tests/controlplane/migrations.test.ts", suite: "migrator [postgres]", postgres: true }));
    expect(requirements).toContainEqual(expect.objectContaining({ file: "tests/controlplane/migrations.test.ts", suite: "migrator [postgres] concurrency and fail-closed open", backend: "postgres" }));
  });
});

describe("cross-language Go gates", () => {
  const condition = "hashFiles('go/go.mod') != ''";
  const nativeCommand = [
    "set -euo pipefail",
    'attempt_id="$(node --input-type=module -e \'import { randomBytes } from "node:crypto"; console.log(randomBytes(16).toString("hex"))\')"',
    'echo "expected_attempt_id=$attempt_id" >> "$GITHUB_OUTPUT"',
    'ZENITH_GUEST_ATTEMPT_ID="$attempt_id" node scripts/ci/run-guest-file-write-gate.mjs --run',
  ].join("\n");

  it("vets and race-tests all Go packages including OCI", () => {
    expect(fs.existsSync(path.join(root, "go/internal/oci"))).toBe(true);
    gate("go", "go vet ./...", condition);
    const native = gate("go", nativeCommand, condition);
    expect(native.id).toBe("native_guest");
    expect(native.shell).toBe("bash");
    expect(native["working-directory"]).toBe(".");
    const manifest = linuxGuestManifest();
    expect(manifest.command).toEqual(["node", "scripts/ci/run-guest-file-write-gate.mjs", "--run"]);
    expect(manifest.steps.find((step) => step.id === "race")?.command).toEqual(["go", "test", "-json", "-race", "-count=1", "./...", "-skip", "^(TestPackageHelperNativeNoFollowAndCustody|TestPackageFrontendLockIndependentProcess|TestPackageNativeSignedFirstInstallAndNonReplay|TestPackageNativeDeclaredMountAndACLRefusals|TestSystemdSignedUpdateAndRollback)$"]);
    const prerequisite = gate("go", "set -euo pipefail\ncommand -v docker >/dev/null\ncommand -v python3 >/dev/null\npython3 -c 'import sys; assert sys.version_info >= (3, 10)'", condition);
    expect(prerequisite["working-directory"]).toBe(".");
    expect(workflow.jobs.go.steps.indexOf(prerequisite)).toBeLessThan(workflow.jobs.go.steps.indexOf(native));
    expect(manifest.packagePhase.requiredCases.map(item => item.test)).toEqual(["TestPackageHelperNativeNoFollowAndCustody", "TestPackageFrontendLockIndependentProcess", "TestPackageNativeSignedFirstInstallAndNonReplay", "TestPackageNativeDeclaredMountAndACLRefusals"]);
    expect(manifest.packagePhase.allowedSkips).toEqual([]);
    expect(manifest.pid1Phase.requiredCases).toEqual(LINUX_GUEST_PID1_CASES);
    expect(manifest.pid1Phase.requiredPackages).toEqual(["github.com/GODOSTROYER/zenith/go/internal/runner/update"]);
    expect(manifest.pid1Phase.noTestPackages).toEqual([]); expect(manifest.pid1Phase.allowedSkips).toEqual([]);
    expect(manifest.pid1Phase.baseImage).toMatch(/^ubuntu:24\.04@sha256:[a-f0-9]{64}$/);
    expect(manifest.pid1Phase.builderImage).toMatch(/^moby\/buildkit:buildx-stable-1@sha256:[a-f0-9]{64}$/);
    expect(manifest.requiredCases).toEqual([...manifest.raceCases, ...manifest.packagePhase.requiredCases, ...manifest.pid1Phase.requiredCases]);
    expect(priorServiceLinuxCases(manifest.raceCases)).toHaveLength(123); expect(priorServiceLinuxCases(manifest.requiredCases)).toHaveLength(127);
    expect(manifest.raceCases).toHaveLength(154); expect(manifest.requiredCases).toHaveLength(159);
    expect(manifest.env.CGO_ENABLED).toBe("1");
    expect(manifest.env.GOTOOLCHAIN).toBe("local");
    expect(manifest.requiredPackages).toContain("github.com/GODOSTROYER/zenith/go/internal/oci");
    expect(manifest.allowedSkips.map(({ package: packageName, test }) => ({ package: packageName, test }))).toEqual([
      { package: "github.com/GODOSTROYER/zenith/go/internal/machine/ops", test: "TestRealSystemctlAndJournalctl" },
      { package: "github.com/GODOSTROYER/zenith/go/internal/runner/kinds", test: "TestRealOpenTofuPlanShowApply" },
      { package: "github.com/GODOSTROYER/zenith/go/internal/runner/kinds", test: "TestRealOpenTofuWithProviderAndLockfile" },
    ]);
  });

  it("regenerates and compares machine fixtures before TypeScript validates them", () => {
    const job = workflow.jobs.go;
    const regenerate = gate("go", nativeCommand, condition);
    const manifest = linuxGuestManifest();
    // The runner observes exits and validates complete JSON lifecycles; the
    // dedicated guest gate suite checks malformed, missing and skipped reports.
    expect(manifest.steps).toEqual([
      { id: "race", command: ["go", "test", "-json", "-race", "-count=1", "./...", "-skip", "^(TestPackageHelperNativeNoFollowAndCustody|TestPackageFrontendLockIndependentProcess|TestPackageNativeSignedFirstInstallAndNonReplay|TestPackageNativeDeclaredMountAndACLRefusals|TestSystemdSignedUpdateAndRollback)$"] },
      { id: "package-native", command: ["python3", "scripts/ci/guest-package-fixtures.py", "--root", "{sourceRoot}", "--attempt", "{attemptId}", "--arch", "{nativeArch}"] },
      { id: "pid1-native", command: ["python3", "-B", "scripts/ci/guest-pid1-fixtures.py", "--root", "{sourceRoot}", "--attempt", "{attemptId}", "--arch", "{nativeArch}"] },
      { id: "goldens", command: ["go", "test", "-json", "-count=1", "./internal/machine/ops", "-run", "^TestResultGoldens$"] },
      { id: "golden-diff", command: ["git", "diff", "--exit-code", "--", "internal/machine/testdata/results"] },
      { id: "golden-status", command: ["git", "--no-optional-locks", "status", "--porcelain", "--", "internal/machine/testdata/results"] },
    ]);
    expect(priorServiceLinuxCases(manifest.goldenCases)).toEqual([{
      package: "github.com/GODOSTROYER/zenith/go/internal/machine/ops",
      test: "TestResultGoldens/file.write-filesystem",
      id: "linux-guest:github.com/GODOSTROYER/zenith/go/internal/machine/ops:TestResultGoldens/file.write-filesystem",
    }]);
    const validate = gate("go", "npx vitest run tests/machines/go-results.test.ts --maxWorkers=2", condition);
    expect(validate["working-directory"]).toBe(".");
    expect(job.steps.indexOf(regenerate)).toBeLessThan(job.steps.indexOf(validate));
    const install = gate("go", "npm ci --ignore-scripts", condition);
    expect(install["working-directory"]).toBe(".");
    expect(job.steps.indexOf(install)).toBeLessThan(job.steps.indexOf(validate));
  });

  it("also runs the Go runner's real OpenTofu tests in the network lane", () => {
    const command = [
      "set -euo pipefail",
      'test "$(go env GOVERSION)" = "go1.27.1"',
      'ZENITH_TEST_TOFU="$ZENITH_TOFU_BIN" go -C go test -count=1 ./internal/runner/kinds -run \'^TestRealOpenTofu(PlanShowApply|WithProviderAndLockfile)$\'',
    ].join("\n");
    expect(gate("tofu", command).env?.GOTOOLCHAIN).toBe("local");
  });
  it("executes every accepted product and linked credential case under mandatory native prerequisites", () => {
    const manifest = manifestFor("platform-postgres", root);
    const required = PLAN_PRODUCT_AUTHORITY_POSTGRES_REQUIREMENTS;
    const ids = new Set(required.map(item => requirementId("platform-postgres", item)));
    expect(required).toHaveLength(171);
    expect(manifest.requirements.filter(item => ids.has(item.id))).toEqual(required.map(item => ({ ...item, id: requirementId("platform-postgres", item) })));
    expect(priorRetainedWaitPlatformRequirements()).toHaveLength(798);
    expect(new Set(priorRetainedWaitPlatformRequirements().map(item => item.id)).size).toBe(798);
    expect(priorPlanProductPlatformRequirements()).toHaveLength(624);
    expect(manifest.env).toMatchObject({ ZENITH_TEST_PLAN_PRODUCT_AUTHORITY_REQUIRED: "1", ZENITH_TEST_NATIVE_INTEGRATION_AUTHORITY_REQUIRED: "1", ZENITH_TEST_TOFU_NETWORK: "1" });
    for (const item of required) {
      expect(item.backend).toBe("postgres");
      expect(manifest.command.some(argument => argument === item.file || item.file.startsWith(`${argument}/`))).toBe(true);
      expect(manifest.excludeFiles).not.toContain(item.file);
    }
    expect(manifest.command).toContain("tests/platform/current-dispatch-requirement.test.ts");
    expect(manifest.command).toContain("tests/agent-access/credential-authority-origin.test.ts");
    expect(manifest.excludeFiles).toEqual([]);
    expect(manifest.command).not.toContain("--passWithNoTests");
  });

});


describe("native OAuth and retained destroy gate coverage", () => {
  it("executes all 71 OAuth grant controls with required PostgreSQL admission", () => {
    const manifest = manifestFor("postgres", root), required = OAUTH_GRANT_POSTGRES_REQUIREMENTS;
    expect(required).toHaveLength(71); expect(manifest.requirements).toHaveLength(93);
    const ids = new Set(required.map(item => requirementId("postgres", item)));
    expect(manifest.requirements.filter(item => ids.has(item.id))).toEqual(required.map(item => ({ ...item, id: requirementId("postgres", item) })));
    expect(manifest.env).toMatchObject({ ZENITH_CONTRACT_POSTGRES: "1", ZENITH_TEST_PG_OAUTH_GRANTS_REQUIRED: "1" });
    expect(manifest.command).toContain("tests/agent-control/pg-oauth-grants.test.ts");
    expect(manifest.excludeFiles).toEqual([]); expect(manifest.command).not.toContain("--passWithNoTests");
    for (const item of required) expect(item).toMatchObject({ suite: "OAuth resource grant journal [postgres]", postgres: true });
    gate("postgres", "node scripts/ci/run-gate.mjs postgres --run");
    gate("postgres", "node scripts/ci/run-gate.mjs postgres --validate .data-ci-lane/postgres-lane.json --require-execution", "always()");
  });
  it("executes the new observed destroy wait case while retaining all 798 earlier platform requirements", () => {
    const manifest = manifestFor("platform-postgres", root), required = PLAN_PRODUCT_RETAINED_WAIT_POSTGRES_REQUIREMENTS;
    expect(priorNativeOAuthPlatformRequirements()).toHaveLength(799); expect(new Set(priorNativeOAuthPlatformRequirements().map(item => item.id)).size).toBe(799);
    expect(priorRetainedWaitPlatformRequirements()).toHaveLength(798);
    expect(required).toHaveLength(1);
    expect(manifest.requirements).toContainEqual({ ...required[0], id: requirementId("platform-postgres", required[0]) });
    expect(manifest.env.ZENITH_TEST_NATIVE_INTEGRATION_AUTHORITY_REQUIRED).toBe("1");
    expect(manifest.command).toContain("tests/controlplane"); expect(manifest.excludeFiles).not.toContain(required[0].file);
    expect(manifest.command).not.toContain("--passWithNoTests");
  });
});


describe("corrected native OAuth dispatch and linked first-selection coverage", () => {
  it("executes all 95 OAuth dispatch and 11 additive linked controls without changing any previous mandatory requirement", () => {
    const manifest = manifestFor("platform-postgres", root), added = [...NATIVE_OAUTH_DISPATCH_POSTGRES_REQUIREMENTS, ...NATIVE_CREDENTIAL_FACTORY_POSTGRES_REQUIREMENTS];
    const ids = new Set(added.map(item => requirementId("platform-postgres", item)));
    expect(added).toHaveLength(106);
    expect(manifest.requirements.filter(item => ids.has(item.id))).toEqual(added.map(item => ({ ...item, id: requirementId("platform-postgres", item) })));
    const previous = priorApplyCurrentAuthorityPlatformRequirements();
    expect(previous).toHaveLength(906); expect(new Set(previous.map(item => item.id)).size).toBe(906);
    expect(createHash("sha256").update(JSON.stringify(previous.map(item => item.id).sort())).digest("hex")).toBe("bfe33823494d47835d18bb8bddfbd373f58beb0a00f136e2b4ca229356215f18");
    const prior = priorNativeOAuthPlatformRequirements(); expect(prior).toHaveLength(799);
    expect(createHash("sha256").update(JSON.stringify(prior.map(item => item.id).sort())).digest("hex")).toBe("4d0668f6e3fbac4acf544dbfa2bf625a96648cdb2cfc5f8039537c5961b77be6");
    expect(manifest.env).toMatchObject({ ZENITH_TEST_NATIVE_OAUTH_DISPATCH_REQUIRED: "1", ZENITH_TEST_NATIVE_INTEGRATION_AUTHORITY_REQUIRED: "1" });
    expect(manifest.prerequisites).toEqual(expect.arrayContaining(["ZENITH_TEST_NATIVE_OAUTH_DISPATCH_REQUIRED=1; OAuth original-plan dispatch and default journal origin require actual owning PostgreSQL16 with explicit ZENITH_TEST_PLATFORM_PG_URL port, canonical platform schema13/product collections and agent schemas1/2/3 through migration0015, independent native connections and positively owned disposable scratch databases/CI roles; hosted REST/current identity/policy and sealed fixture bytes remain modeled", "The additive linked factory preselection controls share ZENITH_TEST_NATIVE_INTEGRATION_AUTHORITY_REQUIRED=1 and actual owning PostgreSQL; all prior50 linked origin cases remain mandatory, tooling constructors supply no default origin"]));
    for (const file of ["tests/agent-access/native-oauth-origin.test.ts", "tests/controlplane/plan-artifact-oauth-authority.test.ts", "tests/agent-access/credential-authority-origin.test.ts"]) { expect(manifest.command).toContain(file); expect(manifest.excludeFiles).not.toContain(file); }
    for (const item of added) expect(item.backend).toBe("postgres");
    expect(manifest.excludeFiles).toEqual([]); expect(manifest.command).not.toContain("--passWithNoTests");
    expect(manifestFor("postgres", root).requirements).toHaveLength(93);
    expect(packagedWorkerManifest().requiredChecks).toHaveLength(22);
    gate("platform-postgres", "node scripts/ci/run-gate.mjs platform-postgres --run");
    gate("platform-postgres", "node scripts/ci/run-gate.mjs platform-postgres --validate .data-ci-lane/platform-lane.json --require-execution", "always()");
  });
});

describe("mandatory unchanged APPLY authority continuation [report models]", () => {
  const required = APPLY_CURRENT_AUTHORITY_POSTGRES_REQUIREMENTS.map(item => ({ ...item, id: requirementId("platform-postgres", item) }));
  const report = () => ({ success: true, numTotalTests: 1, numFailedTests: 0, testResults: [{
    name: path.resolve(root, required[0].file), status: "passed", assertionResults: [{
      title: required[0].test, fullName: `${required[0].suite} ${required[0].test}`, ancestorTitles: [required[0].suite], status: "passed",
    }],
  }] });

  it("requires the exact positive once with actual PostgreSQL admission while preserving every prior identity", () => {
    const manifest = manifestFor("platform-postgres", root);
    expect(required).toEqual([{
      file: "tests/execution/apply.test.ts", suite: "dispatch current authority [postgres]",
      test: "continues unchanged native product authority after fresh replan through the exact approved original plan", postgres: true,
      id: requirementId("platform-postgres", { file: "tests/execution/apply.test.ts", suite: "dispatch current authority [postgres]",
        test: "continues unchanged native product authority after fresh replan through the exact approved original plan", postgres: true }),
    }]);
    expect(manifest.requirements.filter(item => item.id === required[0].id)).toEqual(required);
    expect(priorNativeSafetyPlatformRequirements()).toHaveLength(907); expect(new Set(priorNativeSafetyPlatformRequirements().map(item => item.id)).size).toBe(907);
    expect(priorApplyCurrentAuthorityPlatformRequirements()).toHaveLength(906);
    expect(priorNativeOAuthPlatformRequirements()).toHaveLength(799);
    expect(manifest.env).toMatchObject({ ZENITH_TEST_PLAN_PRODUCT_AUTHORITY_REQUIRED: "1", ZENITH_TEST_TOFU_NETWORK: "1" });
    expect(manifest.command).toContain(required[0].file); expect(manifest.excludeFiles).not.toContain(required[0].file);
    expect(manifest.prerequisites.some(value => value.startsWith("ZENITH_TEST_PLAN_PRODUCT_AUTHORITY_REQUIRED=1;"))).toBe(true);
    const source = fs.readFileSync(path.join(root, required[0].file), "utf8");
    // Historical fixture binding: 3fb495f33a29736991f966c2c7c521552e864fea17d99ac39b94e63ca972e9ff.
    // The reviewed native fixture now binds real SQL semantics and audit writes.
    expect(createHash("sha256").update(source).digest("hex")).toBe("a30a056f3e5a8a1d402e9828011978aa599bf0c081355108209e15d4f727f561");
    expect(source).toContain("semantics:createPlatformSemanticsStore(h.db!)");
    expect(source).toContain("semanticsDigest:review.semantics.digest");
    const preApproval = source.indexOf("select semantics_digest from platform.approved_semantics");
    expect(preApproval).toBeGreaterThanOrEqual(0);
    expect(preApproval).toBeLessThan(source.indexOf("const approval = await h.broker.approve"));
    expect(source).toContain('const auditWrites = vi.spyOn(h.store, "appendEvent")');
    expect(source).toContain("await expect(auditWrites.mock.results[bindingIndexes[0]].value");
    expect(source).toContain("data->>'kind'='approval_semantics_bound'");
    expect(manifest.requirements.filter(item => item.file === required[0].file && item.suite === required[0].suite).map(item => item.test)).toEqual([
      ...["expired approval", "revoked approver role", "new policy denial", "expiry after authority check", "expiry during role lookup"]
        .map(mode => `refuses ${mode} after fresh replan and before durable dispatch`),
      required[0].test,
    ]);
    expect(source).toContain(JSON.stringify(required[0].test));
    expect(source.indexOf("ZENITH_TEST_PLAN_PRODUCT_AUTHORITY_REQUIRED")).toBeLessThan(source.indexOf("beforeAll("));
    expect(source).toContain('(!PG_URL || !tofuOnPath() || process.env.ZENITH_TEST_TOFU_NETWORK !== "1")');
    expect(reportFailures(required, report(), root)).toEqual([]);
    expect(manifestFor("postgres", root).requirements).toHaveLength(93); expect(packagedWorkerManifest().requiredChecks).toHaveLength(22);
  });

  it("retains the literal positive requirement after its source file is removed", () => {
    const sourceRoot = modelRoot(path.join(os.tmpdir(), "zenith-apply-gate-"));
    try {
      for (const directory of ["tests/controlplane", "tests/capabilities", "tests/reconcile", "tests/execution"]) fs.mkdirSync(path.join(sourceRoot, directory), { recursive: true });
      fs.copyFileSync(path.join(root, required[0].file), path.join(sourceRoot, required[0].file));
      const named = () => requirementsFor("platform-postgres", sourceRoot).filter(item => item.id === required[0].id);
      expect(named()).toEqual(required); fs.unlinkSync(path.join(sourceRoot, required[0].file)); expect(named()).toEqual(required);
    } finally { fs.rmSync(sourceRoot, { recursive: true, force: true }); }
  });

  it("refuses missing, malformed, zero, duplicate or unsuccessful evidence for the new required positive", () => {
    for (const value of [null, {}, { success: true }, { success: false, testResults: [] }, { success: true, testResults: [] }]) expect(reportFailures(required, value, root).length).toBeGreaterThan(0);
    for (const status of ["failed", "skipped", "pending", "todo", "unknown"]) {
      const value = report(); value.testResults[0].assertionResults[0].status = status;
      expect(reportFailures(required, value, root).length).toBeGreaterThan(0);
    }
    const missing = report(); missing.testResults[0].assertionResults = []; missing.numTotalTests = 0;
    expect(reportFailures(required, missing, root)).toHaveLength(1);
    const malformed = report(); malformed.testResults[0].assertionResults[0].fullName = "";
    expect(reportFailures(required, malformed, root)).toEqual(["Malformed Vitest assertion evidence"]);
    const duplicate = report(); duplicate.testResults.push(duplicate.testResults[0]); duplicate.numTotalTests = 2;
    expect(reportFailures(required, duplicate, root)).toEqual(["Duplicate Vitest file evidence"]);
    expect(reportFailures(required, { ...report(), numTotalTests: 0 }, root)).toEqual(["Inconsistent Vitest report counts"]);
    expect(reportFailures([], report(), root)).toEqual(["No required scenarios found"]);
  });

  it("refuses PGlite, foreign scope or substituted case titles instead of borrowing modeled authority", () => {
    for (const suite of ["dispatch current authority [pglite]", "dispatch current authority [postgres-replica]", "foreign authority [postgres]", "dispatch current authority ['postgres\"]"]) {
      const value = report(); value.testResults[0].assertionResults[0].ancestorTitles = [suite];
      expect(reportFailures(required, value, root)).toHaveLength(1);
    }
    const foreign = report(); foreign.testResults[0].name = path.resolve(root, "tests/execution/destroy-review.test.ts");
    expect(reportFailures(required, foreign, root)).toHaveLength(1);
    const substituted = report(); substituted.testResults[0].assertionResults[0].title = "a passing isolated apply";
    expect(reportFailures(required, substituted, root)).toHaveLength(1);
  });
});

describe("network gate AST detection [source models]", () => {
  it.each(["quoted assertion", "single quoted source", "template text", "regular expression", "line comment", "block comment"])("ignores %s as executable gate evidence", kind => {
    const source: Record<string, string> = {
      "quoted assertion": 'expect(source).toContain(\'(!PG_URL || process.env.ZENITH_TEST_TOFU_NETWORK !== "1")\');',
      "single quoted source": 'const fixture = \'process.env.ZENITH_TEST_TOFU_NETWORK === "1"\';',
      "template text": 'const fixture = `process.env.ZENITH_TEST_TOFU_NETWORK !== "1"`;',
      "regular expression": 'const fixture = /process.env.ZENITH_TEST_TOFU_NETWORK !== "1"/;',
      "line comment": '// process.env.ZENITH_TEST_TOFU_NETWORK === "1"\nconst enabled = true;',
      "block comment": '/* process.env.ZENITH_TEST_TOFU_NETWORK !== "1" */ const enabled = true;',
    };
    expect(hasTofuNetworkComparison(source[kind])).toBe(false);
  });
  it.each(["strict equal", "strict unequal", "reversed", "loose equal", "loose unequal", "static bracket", "escaped bracket", "optional chain", "parenthesized", "typed expression", "template interpolation"])("detects actual %s runtime comparison without a file exemption", kind => {
    const source: Record<string, string> = {
      "strict equal": 'describe.skipIf(process.env.ZENITH_TEST_TOFU_NETWORK === "1")("suite", () => {});',
      "strict unequal": 'describe.skipIf(process.env.ZENITH_TEST_TOFU_NETWORK !== "1")("suite", () => {});',
      reversed: 'describe.skipIf("1" !== process.env.ZENITH_TEST_TOFU_NETWORK)("suite", () => {});',
      "loose equal": 'const enabled = process.env.ZENITH_TEST_TOFU_NETWORK == "1";',
      "loose unequal": 'const enabled = process.env.ZENITH_TEST_TOFU_NETWORK != "1";',
      "static bracket": 'const enabled = process["env"]["ZENITH_TEST_TOFU_NETWORK"] === "1";',
      "escaped bracket": 'const enabled = process["env"]["\\u005aENITH_TEST_TOFU_NETWORK"] === "1";',
      "optional chain": 'const enabled = process?.env?.ZENITH_TEST_TOFU_NETWORK !== "1";',
      parenthesized: 'const enabled = (((process.env.ZENITH_TEST_TOFU_NETWORK))) !== "1";',
      "typed expression": 'const enabled = (process.env.ZENITH_TEST_TOFU_NETWORK as string | undefined) === "1";',
      "template interpolation": 'const enabled = `${process.env.ZENITH_TEST_TOFU_NETWORK !== "1"}`;',
    };
    expect(hasTofuNetworkComparison(source[kind], "platform-coverage.test.ts")).toBe(true);
  });
  it("keeps a genuine comparison visible beside quoted false-positive text", () => {
    const source = 'expect(source).toContain(\'process.env.ZENITH_TEST_TOFU_NETWORK !== "1"\');\nconst gated = process.env.ZENITH_TEST_TOFU_NETWORK !== "1";';
    expect(hasTofuNetworkComparison(source)).toBe(true);
  });
  it("does not mistake another flag object or unevaluated type for the exact process environment comparison", () => {
    for (const source of ['const enabled = manifest.env.ZENITH_TEST_TOFU_NETWORK === "1";',
      'const enabled = process.env.OTHER_NETWORK === "1";', 'type Example = { "process.env.ZENITH_TEST_TOFU_NETWORK !== 1": true };'])
      expect(hasTofuNetworkComparison(source)).toBe(false);
  });
});

describe("mandatory native custody, retention and Kubernetes target execution", () => {
  it("executes every one of the 81 named cases and both genuine discovered suites with no predecessor loss", () => {
    const manifest = manifestFor("platform-postgres", root);
    const added = [...MIXED_CHILD_CUSTODY_POSTGRES_REQUIREMENTS, ...PLAN_RETENTION_POSTGRES_REQUIREMENTS, ...KUBERNETES_VAULT_TARGET_POSTGRES_REQUIREMENTS];
    const ids = new Set(added.map(item => requirementId("platform-postgres", item)));
    expect(added).toHaveLength(82); expect(ids.size).toBe(82);
    expect(manifest.requirements.filter(item => ids.has(item.id))).toEqual(added.map(item => ({ ...item, id: requirementId("platform-postgres", item) })));
    for (const discovered of nativeSafetyDiscovered) expect(manifest.requirements).toContainEqual({ ...discovered, id: requirementId("platform-postgres", discovered) });
    const previous = priorNativeSafetyPlatformRequirements();
    expect(previous).toHaveLength(907); expect(new Set(previous.map(item => item.id)).size).toBe(907);
    expect(createHash("sha256").update(JSON.stringify(previous.map(item => item.id).sort())).digest("hex")).toBe("3192324ebd5d5db8a684fccc84173dd8be8b80efa3367f1bb57e81462d8b3c4b");
    const predecessor = priorKubernetesLinkPlatformRequirements();
    expect(predecessor).toHaveLength(990); expect(new Set(predecessor.map(item => item.id)).size).toBe(990);
    expect(manifestFor("postgres", root).requirements).toHaveLength(93); expect(packagedWorkerManifest().requiredChecks).toHaveLength(22);
    expect(manifest.excludeFiles).toEqual([]); expect(manifest.command).not.toContain("--passWithNoTests");
    gate("platform-postgres", "node scripts/ci/run-gate.mjs platform-postgres --run");
    gate("platform-postgres", "node scripts/ci/run-gate.mjs platform-postgres --validate .data-ci-lane/platform-lane.json --require-execution", "always()");
  });

  it.each([
  {
    "file": "tests/controlplane/mixed-child-admission.test.ts",
    "suite": "native mixed child custody [postgres]",
    "flag": "ZENITH_TEST_MIXED_CHILD_CUSTODY_REQUIRED",
    "count": 37
  },
  {
    "file": "tests/controlplane/plan-artifact-retention.test.ts",
    "suite": "plan artifact retention preview [postgres; synthetic storage and receipt fixtures]",
    "flag": "ZENITH_TEST_PLAN_RETENTION_REQUIRED",
    "count": 27
  },
  {
    "file": "tests/platform/kubernetes-vault-target.test.ts",
    "suite": "default Kubernetes vault target binding [postgres; modeled API boundary]",
    "flag": "ZENITH_TEST_KUBERNETES_VAULT_TARGET_REQUIRED",
    "count": 18
  }
])("requires $flag and actual native $count-case execution from $file", group => {
    const manifest = manifestFor("platform-postgres", root);
    const required = manifest.requirements.filter(item => item.file === group.file && item.test !== undefined);
    expect(required).toHaveLength(group.count); expect(required.every(item => item.suite === group.suite && item.backend === "postgres")).toBe(true);
    expect(manifest.env[group.flag]).toBe("1");
    expect(manifest.prerequisites.some(value => value.startsWith(`${group.flag}=1;`))).toBe(true);
    expect(manifest.files.some(filter => group.file === filter || group.file.startsWith(`${filter}/`))).toBe(true);
    expect(manifest.excludeFiles).not.toContain(group.file);
    for (const check of CORE_CHECKS) expect(check.command.join(" ")).not.toContain(`${group.flag}=1`);
    const source = fs.readFileSync(path.join(root, group.file), "utf8");
    expect(source).toContain(`describe.skipIf(!PG_URL)(${JSON.stringify(group.suite)}`);
    expect(source.indexOf(group.flag)).toBeGreaterThanOrEqual(0);
    expect(source.indexOf(group.flag)).toBeLessThan(source.indexOf("beforeAll("));
  });

  it("requires all 21 native human Kubernetes linking cases without changing the exact 990 predecessor", () => {
    const manifest = manifestFor("platform-postgres", root), required = KUBERNETES_CONNECTION_LINK_POSTGRES_REQUIREMENTS;
    const ids = new Set(required.map(item => requirementId("platform-postgres", item)));
    expect(required).toHaveLength(21); expect(ids.size).toBe(21);
    expect(manifest.requirements.filter(item => ids.has(item.id))).toEqual(required.map(item => ({ ...item, id: requirementId("platform-postgres", item) })));
    expect(required.every(item => item.file === kubernetesLinkDiscovered.file && item.suite === kubernetesLinkDiscovered.suite && item.backend === "postgres")).toBe(true);
    expect(manifest.requirements).toContainEqual({ ...kubernetesLinkDiscovered, id: requirementId("platform-postgres", kubernetesLinkDiscovered) });
    expect(priorCleanupPlatformRequirements()).toHaveLength(1012); expect(new Set(priorCleanupPlatformRequirements().map(item => item.id)).size).toBe(1012);
    const predecessor = priorKubernetesLinkPlatformRequirements();
    expect(predecessor).toHaveLength(990);
    expect(createHash("sha256").update(JSON.stringify(predecessor.map(item => item.id).sort())).digest("hex")).toBe("cd24c52f0cdddb47746e282080e1a3fcd31f8b1799ac685cf3e6f273b70e452e");
    expect(manifest.env.ZENITH_TEST_KUBERNETES_CONNECTION_LINK_REQUIRED).toBe("1");
    expect(manifest.prerequisites.some(value => value.startsWith("ZENITH_TEST_KUBERNETES_CONNECTION_LINK_REQUIRED=1;"))).toBe(true);
    expect(manifest.files).toContain("tests/controlplane"); expect(manifest.command).toContain("tests/controlplane");
    expect(manifest.excludeFiles).not.toContain(kubernetesLinkDiscovered.file);
    gate("platform-postgres", "node scripts/ci/run-gate.mjs platform-postgres --run");
    gate("platform-postgres", "node scripts/ci/run-gate.mjs platform-postgres --validate .data-ci-lane/platform-lane.json --require-execution", "always()");
    expect(manifestFor("postgres", root).requirements).toHaveLength(93); expect(packagedWorkerManifest().requiredChecks).toHaveLength(22);
  });

  it("initializes canonical schema16 and agent prerequisites before the unchanged mandatory lane", () => {
    const job = workflow.jobs["platform-postgres"], steps = job.steps;
    const migrate = steps.findIndex(step => step.run === "bash scripts/ci/apply-platform-migrations.sh");
    const agent = steps.findIndex(step => step.run === "node node_modules/tsx/dist/cli.mjs scripts/agent/apply-schema.ts");
    const run = steps.findIndex(step => step.run === "node scripts/ci/run-gate.mjs platform-postgres --run");
    expect(agent).toBeGreaterThanOrEqual(0); expect(migrate).toBeGreaterThan(agent); expect(run).toBeGreaterThan(migrate);
    expect(steps[agent].if).toBeUndefined(); expect(steps[agent]["continue-on-error"]).toBeUndefined();
    // This historical admission requires schema16 or newer; the emitted list
    // below and current registry inventory retain every successor migration.
    const schemaPrerequisites = manifestFor("platform-postgres", root).prerequisites.flatMap(value => {
      const match = /^Canonical platform schema([1-9][0-9]*) applied\/current through scripts\/ci\/apply-platform-migrations\.sh;/.exec(value);
      return match ? [Number(match[1])] : [];
    });
    expect(schemaPrerequisites).toHaveLength(1);
    const schemaVersion = schemaPrerequisites[0];
    expect(typeof schemaVersion === "number" && Number.isSafeInteger(schemaVersion) && schemaVersion >= 16).toBe(true);
    const script = fs.readFileSync(path.join(root, "scripts/ci/apply-supabase-migrations.sh"), "utf8");
    const committed = fs.readdirSync(path.join(root, "supabase/migrations")).filter(file => file.endsWith(".sql")).sort();
    const declaration = script.match(/^MIGRATIONS=\(\r?\n([\s\S]*?)^\)/m)?.[1];
    expect(declaration).toBeDefined();
    expect([...(declaration ?? "").matchAll(/"([^"\n]+\.sql)"/g)].map(match => match[1])).toEqual(committed);
    expect(committed.slice(-12)).toEqual(["0016_platform_core.sql", "0017_platform_core.sql", "0018_platform_core.sql", "0019_platform_core.sql", "0020_platform_core.sql", "0021_platform_core.sql", "0022_platform_core.sql", "0023_platform_core.sql", "0024_platform_core.sql", "0025_platform_core.sql", "0026_platform_core.sql", "0027_product_flush_atomic.sql"]);
    expect(fs.readFileSync(path.join(root, "scripts/ci/apply-platform-migrations.sh"), "utf8")).toContain("scripts/platform/migrate.ts");
    expect(script).toContain('"$TSX" "$PLATFORM_VERIFIER"');
  });
});


describe("saved builtin settlement mandatory CI admission", () => {
  it("keeps all six current discovery successors in the executable strict platform lane", () => {
    const manifest = manifestFor("platform-postgres", root);
    const added = currentSuccessorPlatformCohort.map(item => ({ ...item, id: requirementId("platform-postgres", item) }));
    expect(manifest.requirements.filter(item => added.some(value => value.id === item.id)).sort((a, b) => a.id.localeCompare(b.id))).toEqual(added.sort((a, b) => a.id.localeCompare(b.id)));
    expect(manifest.requirements).toHaveLength(1177);
    expect(new Set(manifest.requirements.map(item => item.id)).size).toBe(1177);
    const mixedStore = manifest.requirements.filter(item => item.file === "tests/execution/mixed-run-store.test.ts");
    expect(mixedStore).toHaveLength(5);
    expect(mixedStore.every(item => item.postgres && item.suite === "mixed run store validation [postgres]" && item.test)).toBe(true);
    const beforeMixedStore = manifest.requirements.filter(item => !mixedStore.some(addition => addition.id === item.id));
    expect(beforeMixedStore).toHaveLength(1172);
    expect(beforeMixedStore.filter(item => !wave5PlatformIds.has(item.id))).toHaveLength(1169);
    const prior = priorOwnershipSnapshotRequirements(manifest.requirements);
    expect(prior).toHaveLength(1149);
    expect(createHash("sha256").update(JSON.stringify(prior.map(item => item.id).sort())).digest("hex"))
      .toBe("92df99d8de16e4ef6e1072114c12aafff513bf43774c12c9c390998308ca5729");
    const verifierPrior = prior.filter(item => !wave5PlatformIds.has(item.id) && !integrationPlatformIds.has(item.id));
    expect(verifierPrior).toHaveLength(1145);
    expect(createHash("sha256").update(JSON.stringify(verifierPrior.map(item => item.id).sort())).digest("hex"))
      .toBe("349b983956a0d8569c4bc475584e0a6bf69cd5fa476e2b709954536aacc34c00");
    const priorMixedStore = verifierPrior.filter(item => !mixedStore.some(addition => addition.id === item.id));
    expect(priorMixedStore).toHaveLength(1140);
    expect(createHash("sha256").update(JSON.stringify(priorMixedStore.map(item => item.id).sort())).digest("hex"))
      .toBe("d69bfb94043d51dd0c2631fa9a2864b08cd05b590e6c3a4d5d0380aace6c7047");
    const future = { ...manifest.requirements[0], id: "unknown-snapshot-platform-successor" };
    expect(priorOwnershipSnapshotRequirements([...manifest.requirements, future])).toContainEqual(future);
    expect(withoutIncomingPlatform(manifest.requirements).map(item => item.id).sort()).toEqual([...priorCurrentSuccessorPlatformRequirements(), ...added, ...INCIDENT_OWNERSHIP_HARDENING_POSTGRES_REQUIREMENTS.map(item => ({ ...item, id: requirementId("platform-postgres", item) }))].map(item => item.id).sort());
    for (const item of added) {
      expect(manifest.command.some(argument => argument === item.file || item.file.startsWith(`${argument}/`))).toBe(true);
      expect(manifest.excludeFiles).not.toContain(item.file);
    }
    expect(manifest.command).not.toContain("--passWithNoTests");
    gate("platform-postgres", "node scripts/ci/run-gate.mjs platform-postgres --run");
    gate("platform-postgres", "node scripts/ci/run-gate.mjs platform-postgres --validate .data-ci-lane/platform-lane.json --require-execution", "always()");
  });

  it("keeps all five registered native hardening cases in the real strict platform command", () => {
    const manifest = manifestFor("platform-postgres", root);
    const added = INCIDENT_OWNERSHIP_HARDENING_POSTGRES_REQUIREMENTS.map(item => ({ ...item, id: requirementId("platform-postgres", item) }));
    expect(added).toHaveLength(5); expect(new Set(added.map(item => item.id)).size).toBe(5);
    expect(manifest.requirements.filter(item => hardeningPlatformIds.includes(item.id))).toEqual(added);
    expect(priorHardeningPlatformRequirements()).toHaveLength(1118);
    for (const item of added) {
      expect(item.postgres).toBe(true);
      expect(manifest.command.some(argument => argument === item.file || item.file.startsWith(`${argument}/`))).toBe(true);
      expect(manifest.excludeFiles).not.toContain(item.file);
    }
    expect(manifest.command).not.toContain("--passWithNoTests");
    gate("platform-postgres", "node scripts/ci/run-gate.mjs platform-postgres --run");
    gate("platform-postgres", "node scripts/ci/run-gate.mjs platform-postgres --validate .data-ci-lane/platform-lane.json --require-execution", "always()");
  });

  it("retains all 115 literal cleanup and settlement network requirements after source deletion", () => {
    const sourceRoot = modelRoot(path.join(os.tmpdir(), "zenith-cleanup-coverage-"));
    try {
      fs.cpSync(path.join(root, "tests"), path.join(sourceRoot, "tests"), { recursive: true });
      const required = [...CLEANUP_WRITER_BARRIER_POSTGRES_REQUIREMENTS, ...SAVED_PLAN_SETTLEMENT_POSTGRES_REQUIREMENTS];
      const ids = new Set(required.map(item => requirementId("platform-postgres", item)));
      const expected = required.map(item => ({ ...item, id: requirementId("platform-postgres", item) }));
      expect(ids.size).toBe(115);
      expect(requirementsFor("platform-postgres", sourceRoot).filter(item => ids.has(item.id))).toEqual(expected);
      fs.unlinkSync(path.join(sourceRoot, "tests/controlplane/cleanup-writer-barriers.test.ts"));
      expect(requirementsFor("platform-postgres", sourceRoot).filter(item => ids.has(item.id))).toEqual(expected);
      expect(reportFailures(expected, { success: true, testResults: [] }, root)).toHaveLength(115);
    } finally { fs.rmSync(sourceRoot, { recursive: true, force: true }); }
  });

  it("requires the exact additive 54 only in the real platform lane and preserves all previous obligations", () => {
    const manifest = manifestFor("platform-postgres", root), added = SAVED_PLAN_SETTLEMENT_POSTGRES_REQUIREMENTS;
    const ids = new Set(added.map(item => requirementId("platform-postgres", item)));
    expect(added).toHaveLength(54); expect(ids.size).toBe(54);
    expect(manifest.requirements.filter(item => ids.has(item.id))).toEqual(added.map(item => ({ ...item, id: requirementId("platform-postgres", item) })));
    expect(priorCurrentSuccessorPlatformRequirements()).toHaveLength(1112);
    expect(priorSettlementPlatformRequirements()).toHaveLength(1058);
    expect(createHash("sha256").update(JSON.stringify(priorSettlementPlatformRequirements().map(item => item.id).sort())).digest("hex")).toBe("96d2bd4f33c4cc42b1e0df6ce4bb13537f92db7132dd43d2250b9315191e24cb");
    expect(manifest.env.ZENITH_TEST_SAVED_PLAN_SETTLEMENT_REQUIRED).toBe("1");
    expect(workflow.jobs["platform-postgres"].env?.ZENITH_TEST_SAVED_PLAN_SETTLEMENT_REQUIRED).toBe("1");
    expect(manifest.prerequisites.some(value => value.startsWith("ZENITH_TEST_SAVED_PLAN_SETTLEMENT_REQUIRED=1;"))).toBe(true);
    expect(manifest.command).not.toContain("--passWithNoTests"); expect(manifest.excludeFiles).toEqual([]);
    gate("platform-postgres", "node scripts/ci/run-gate.mjs platform-postgres --run");
    gate("platform-postgres", "node scripts/ci/run-gate.mjs platform-postgres --validate .data-ci-lane/platform-lane.json --require-execution", "always()");
    expect(manifestFor("postgres", root).requirements).toHaveLength(93);
    expect(requirementsFor("workflows", root)).toHaveLength(113);
    expect(priorCriticalScheduleWorkflowRequirements()).toHaveLength(60);
    expect(priorWave2WorkflowRequirements()).toHaveLength(58);
    expect(priorServiceLinuxCases(linuxGuestManifest().requiredCases)).toHaveLength(127); expect(linuxGuestManifest().requiredCases).toHaveLength(159); expect(linuxGuestManifest().allowedSkips).toHaveLength(3);
    expect(packagedWorkerManifest().requiredChecks).toHaveLength(22);
  });
});

describe("critical scheduling native admission [workflow source models]", () => {
  it("requires both exact actual Temporal cases on the existing pinned CLI workflow route", () => {
    const file = "tests/workflows/critical-schedule.test.ts";
    const suite = "critical maintenance schedule on an actual owned durable Temporal service";
    const expected = [
      { file, suite, test: "preserves compatible schedule and queued actual workflow across server restart" },
      { file, suite, test: "skips overlap while the first genuine activity is held" },
    ];
    expect(CRITICAL_SCHEDULE_TEMPORAL_REQUIREMENTS).toEqual(expected);
    const manifest = manifestFor("workflows", root), job = workflow.jobs.workflows;
    expect(manifest.requirements.filter(item => criticalScheduleWorkflowIds.has(item.id)))
      .toEqual(expected.map(item => ({ ...item, id: requirementId("workflows", item) })));
    expect(manifest.requirements).toHaveLength(113);
    expect(new Set(manifest.requirements.map(item => item.id)).size).toBe(113);
    const previous = withoutReplayAdditions(manifest.requirements);
    expect(previous).toHaveLength(78);
    const historicalPrevious = previous.filter(item => !integrationWorkflowIds.has(item.id));
    expect(historicalPrevious).toHaveLength(76);
    expect(createHash("sha256").update(JSON.stringify(historicalPrevious.map(item => item.id).sort())).digest("hex"))
      .toBe("a44fa4e252de4b6c3236294297ede9d4c97f0b151971ebee1c7ccfe06590796b");
    expect(createHash("sha256").update(JSON.stringify(previous.map(item => item.id).sort())).digest("hex"))
      .toBe("c67cf195ffe79a8ecdad106be0c2bdbf2033cd5fe515cac98752a1d03de1655c");
    const verifierPrevious = historicalPrevious.filter(item => !wave5WorkflowIds.has(item.id));
    expect(verifierPrevious).toHaveLength(71);
    expect(createHash("sha256").update(JSON.stringify(verifierPrevious.map(item => item.id).sort())).digest("hex"))
      .toBe("5d59799c849b2180643bdbdbd2196c2cef6a966a9fc703d78208f27a617dd77d");
    expect(withoutReplayAdditions([...manifest.requirements, { ...manifest.requirements[0], id: "unknown-successor" }]).some(item => item.id === "unknown-successor")).toBe(true);
    expect(priorCriticalScheduleWorkflowRequirements()).toHaveLength(60);
    expect(createHash("sha256").update(JSON.stringify(priorCriticalScheduleWorkflowRequirements().map(item => item.id).sort())).digest("hex"))
      .toBe("0bd6b090ef0f7802fd97c99d267614f334193ff13400aae17758daf3f24f723b");
    expect(priorWave2WorkflowRequirements()).toHaveLength(58);
    expect(manifest.env.ZENITH_TEST_TEMPORAL).toBe("1");
    expect(job.env?.ZENITH_TEST_TEMPORAL).toBe("1");
    expect(manifest.tools.temporal).toBe("1.9.1");
    const installer = job.steps.find(step => step.name === "Install pinned Temporal CLI");
    expect(installer?.run).toContain("temporal_cli_1.9.1_linux_amd64.tar.gz");
    expect(installer?.run).toContain("09a0326a51db84d02735e53542b9ebd8c4758daf47482a9ab0abce15844e60d5");
    expect(installer?.run).toContain('echo "ZENITH_TEST_TEMPORAL_CLI=$RUNNER_TEMP/temporal-cli/temporal" >> "$GITHUB_ENV"');
    expect(installer?.["continue-on-error"]).toBeUndefined();
    expect(job["continue-on-error"]).toBeUndefined();
    expect(manifest.excludeFiles).not.toContain(file);
    expect(manifest.command).not.toContain("--passWithNoTests");
    gate("workflows", "node scripts/ci/run-gate.mjs workflows --run");
    gate("workflows", "node scripts/ci/run-gate.mjs workflows --validate .data-ci-lane/workflows-lane.json --require-execution", "always()");
  });
});


describe("mandatory live agent journal lane coverage", () => {
  it("runs both existing live files with all thirteen requirements and preserves the seventy-one OAuth cases", () => {
    const manifest = manifestFor("postgres", root), added = AGENT_JOURNAL_POSTGRES_REQUIREMENTS;
    expect(manifest.requirements).toHaveLength(93); expect(added).toHaveLength(13);
    const ids = new Set(added.map(item => requirementId("postgres", item)));
    expect(manifest.requirements.filter(item => ids.has(item.id))).toEqual(added.map(item => ({ ...item, id: requirementId("postgres", item) })));
    expect(OAUTH_GRANT_POSTGRES_REQUIREMENTS).toHaveLength(71);
    expect(manifest.env).toMatchObject({ ZENITH_CONTRACT_POSTGRES: "1", ZENITH_TEST_PG_OAUTH_GRANTS_REQUIRED: "1" });
    for (const file of ["tests/agent-control-journal.test.ts", "tests/agent-control-journal-fixes.test.ts"]) {
      expect(manifest.files).toContain(file); expect(manifest.command).toContain(file);
    }
    for (const item of added) expect(item.backend).toBe("postgres");
    expect(manifest.excludeFiles).toEqual([]); expect(manifest.command).toContain("--no-file-parallelism");
    expect(manifest.command).toContain("--maxWorkers=1"); expect(manifest.command).not.toContain("--passWithNoTests");
    gate("postgres", "node scripts/ci/run-gate.mjs postgres --run");
    gate("postgres", "node scripts/ci/run-gate.mjs postgres --validate .data-ci-lane/postgres-lane.json --require-execution", "always()");
  });
});
