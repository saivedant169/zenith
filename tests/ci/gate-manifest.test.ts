import { destroyApplyLaneIds, integrationWorkflowIds, integrationPlatformIds, historyCodecWorkflowId, mixedRunStorePlatformIds, wave5PlatformIds, wave5WorkflowIds, incomingPlatformIds, incomingWorkflowFiles, incomingWorkflowIds, withoutIncomingPlatform as withoutIncomingPlatformCohort } from "./incoming-cohort-fixture";
/** Shared gate commands preserve required local engines and precisely scoped external acceptance. */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { load } from "js-yaml";
import { OWNERSHIP_SNAPSHOT_CAS_POSTGRES_REQUIREMENTS, WORKFLOW_HISTORY_REPLAY_REQUIREMENTS, AGENT_JOURNAL_POSTGRES_REQUIREMENTS, CRITICAL_SCHEDULE_TEMPORAL_REQUIREMENTS, LINUX_GUEST_SERVICE_CASES, LINUX_GUEST_RUNNER_UPDATE_CASES, LINUX_GUEST_PID1_CASES, INCIDENT_OWNERSHIP_HARDENING_POSTGRES_REQUIREMENTS, SAVED_PLAN_SETTLEMENT_POSTGRES_REQUIREMENTS, WORKFLOW_NATIVE_POSTGRES_FILES, CLEANUP_WRITER_BARRIER_POSTGRES_REQUIREMENTS, KUBERNETES_CONNECTION_LINK_POSTGRES_REQUIREMENTS, MIXED_CHILD_CUSTODY_POSTGRES_REQUIREMENTS, MIXED_RUN_STORE_POSTGRES_REQUIREMENTS, PLAN_RETENTION_POSTGRES_REQUIREMENTS, KUBERNETES_VAULT_TARGET_POSTGRES_REQUIREMENTS, packagedWorkerManifest, APPLY_CURRENT_AUTHORITY_POSTGRES_REQUIREMENTS, NATIVE_OAUTH_DISPATCH_POSTGRES_REQUIREMENTS, NATIVE_CREDENTIAL_FACTORY_POSTGRES_REQUIREMENTS, OAUTH_GRANT_POSTGRES_REQUIREMENTS, PLAN_PRODUCT_RETAINED_WAIT_POSTGRES_REQUIREMENTS, PLAN_PRODUCT_AUTHORITY_POSTGRES_REQUIREMENTS, EXECUTION_LEASE_TENANT_POSTGRES_REQUIREMENTS, MCP_START_SOURCE_AUTHORITY_POSTGRES_REQUIREMENTS, MCP_START_SOURCE_AUTHORITY_SDK_REQUIREMENTS, MCP_DURABLE_ADMISSION_POSTGRES_REQUIREMENTS, AWS_BOOTSTRAP_READINESS_POSTGRES_REQUIREMENTS, FIRST_SOURCE_LEASE_POSTGRES_REQUIREMENTS, APPROVED_SOURCE_POSTGRES_REQUIREMENTS, PLAN_SOURCE_AUTHORITY_POSTGRES_REQUIREMENTS, SOURCE_FIXTURE_POSTGRES_REQUIREMENTS, SOURCE_PLAN_EVIDENCE_POSTGRES_REQUIREMENTS, assertionMatches, canonicalSuite, EXTERNAL_ACCEPTANCE, GATE_LANES, linuxGuestManifest, manifestFor, requirementId, requirementsFor, WAVE5_CONTRACT_FILES, WAVE5_EXTERNAL_FILES } from "../../scripts/ci/gate-manifest.mjs";
import { reportFailures } from "./assert-lane-report.mjs";
import { validateGoEvents } from "../../scripts/ci/run-guest-file-write-gate.mjs";


type NativeGuestCase = ReturnType<typeof linuxGuestManifest>["requiredCases"][number];
// Historical models exclude only this fixed additive service cohort; canonical requirements stay complete.
const runnerUpdateGuestIds = new Set(LINUX_GUEST_RUNNER_UPDATE_CASES.map(item => item.id));
const pid1GuestIds = new Set(LINUX_GUEST_PID1_CASES.map(item => item.id));
const serviceGuestIds = new Set(LINUX_GUEST_SERVICE_CASES.map(item => item.id));
function priorServiceLinuxCases(items: readonly NativeGuestCase[]): NativeGuestCase[] {
  return items.filter(item => !serviceGuestIds.has(item.id) && !runnerUpdateGuestIds.has(item.id) && !pid1GuestIds.has(item.id));
}

const root = process.cwd();
function modelRoot(prefix: string): string {
  const directory = fs.mkdtempSync(prefix);
  for (const relative of ["tests/effects", "tests/repair", "tests/coding-agent"]) fs.mkdirSync(path.join(directory, relative), { recursive: true });
  return directory;
}

// Discovery reads only test source files. Preserve all source bytes and every
// directory while avoiding unrelated fixture/artifact copies in deletion models.
function copyDiscoverySources(destination: string): void {
  // requirementsFor(platform-postgres) discovers exactly these directories.
  // Literal requirements remain in the manifest even when their source is absent.
  for (const directory of ["controlplane", "capabilities", "reconcile", "effects", "repair", "coding-agent"]) {
    fs.cpSync(path.join(root, "tests", directory), path.join(destination, "tests", directory), {
      recursive: true,
      filter: source => fs.statSync(source).isDirectory() || /\.test\.tsx?$/.test(source),
    });
  }
}

const scratch = modelRoot(path.join(os.tmpdir(), "zenith-manifest-"));
afterAll(() => fs.rmSync(scratch, { recursive: true, force: true }));
const ecsGrantFile = "tests/platform/ecs-replica-repair-grants.test.ts";
const ecsFiles = ["tests/execution/ecs-replica-repair.test.ts", "tests/providers/aws/drivers/compute/ecs-replica-repair-read.test.ts", ecsGrantFile, "tests/workflows/ecs-replica-repair.test.ts"];
const ecsPostgresSuites = ["initial planning authority", "planning policy denial", "browser plan approval", "resumed planning authority", "stricter approval policy", "immutable repair evidence"];
const ecsPostgresRequirements = () => requirementsFor("platform-postgres", root).filter((required) => required.file === ecsGrantFile);
const ecsGrantReport = (outer = "replica repair authority [postgres]") => ({
  success: true,
  testResults: [{ name: path.resolve(root, ecsGrantFile), status: "passed", assertionResults: ecsPostgresSuites.map((suite) => ({
    fullName: `${outer} ${suite} scenario`, ancestorTitles: [outer, suite], status: "passed",
  })) }],
});

const intentSqlFile = "tests/controlplane/workflow-start-intents.test.ts";
const intentAuthorityFile = "tests/controlplane/workflow-start-authority.test.ts";
const intentTemporalFile = "tests/workflows/start-intent.test.ts";
const membershipFile = "tests/capabilities/default-current-membership.test.ts";
const operationPostgresFiles = [intentSqlFile, intentAuthorityFile, membershipFile];
type Requirement = ReturnType<typeof requirementsFor>[number];
interface ContractAssertion { title: string; fullName: string; ancestorTitles: string[]; status: string }
interface ContractFile { name: string; status: string; assertionResults: ContractAssertion[] }
// These synthetic reports test the validator; they are never engine acceptance evidence.
function contractReport(requirements: Requirement[]) {
  const files = new Map<string, ContractFile>();
  for (const required of requirements) {
    const entry: ContractFile = files.get(required.file) ?? { name: path.resolve(root, required.file), status: "passed", assertionResults: [] };
    const title = required.test ?? "contract fixture for whole-file requirement";
    const ancestorTitles = [required.ancestorSuite, required.suite].filter((value): value is string => value !== undefined);
    entry.assertionResults.push({ title, fullName: [...ancestorTitles, title].join(" "), ancestorTitles, status: "passed" });
    files.set(required.file, entry);
  }
  return { success: true, testResults: [...files.values()] };
}
interface NamedGroup { label: string; lane: string; file: string; suite?: string; models?: boolean; count: number; sha256: string }
// Hashes pin the ordered, literal declarations, independently of source/report discovery.
const namedOperationGroups: NamedGroup[] = [
  {"label": "schedule", "lane": "reconciliation", "file": "tests/workflows/reconcile-schedule.test.ts", "count": 14, "sha256": "f5c6a5811670d9f4d7399be0dac29a43b56b0e32578abe9f0a8e82b323ec48bc", "suite": "durable schedule on an actual isolated Temporal service"},
  {"label": "composition", "lane": "reconciliation", "file": "tests/workers/reconcile-composition.test.ts", "count": 12, "sha256": "6441c9ced5b775293e17e46f6d5da1bb577e780dbca819959268cce4d1c93f12", "suite": "actual default activity composition: PostgreSQL and owned durable Temporal"},
  {"label": "intent SQL", "lane": "workflow-intents", "file": "tests/controlplane/workflow-start-intents.test.ts", "count": 20, "sha256": "9c9adf74665847d3f7957949ee7fb459ed2d7f69436ac12eaf3c8fd32a392a07", "suite": "workflow start intents [postgres]"},
  {"label": "tombstone privileges", "lane": "workflow-intents", "file": "tests/controlplane/workflow-start-intents.test.ts", "count": 2, "sha256": "71a45363befadbf623b1ef7b745ebcc21d92afa90d1f3cc3f9e8c34dc7b91e31", "suite": "workflow start tombstone privileges [postgres]"},
  {"label": "final authority", "lane": "workflow-intents", "file": "tests/controlplane/workflow-start-authority.test.ts", "count": 53, "sha256": "f07152c999ea91d78200a8565954dc1c4e8d21da5a3d7a519088c1a503f703c9", "suite": "workflow start final authority [postgres]"},
  {"label": "actual SQL and Temporal", "lane": "workflow-intents", "file": "tests/workflows/start-intent.test.ts", "count": 27, "sha256": "105f680615b41d8ee312fd5f2452f18fe05d5520b246442ceacc6e05fd1932af"},
  {"label": "supplemental wire models", "lane": "workflow-intents", "file": "tests/workflows/start-intent.test.ts", "count": 21, "sha256": "05401f52635fad996a6097bf9d0b829fe5fd5c1201756afcf540cff1aa78617a", "models": true},
  {"label": "current membership with modeled product reads", "lane": "platform-postgres", "file": "tests/capabilities/default-current-membership.test.ts", "count": 21, "sha256": "8a55df9f223ce253dbe0a96e2554c7b849fa2cfee432411f94f639ccdd2acb65", "suite": "cached default broker current membership [postgres; modeled product reads]"},
];
function namedGroup(group: NamedGroup, sourceRoot = root): Requirement[] {
  return (group.lane === "platform-postgres" ? priorG2PlatformRequirements(sourceRoot) : requirementsFor(group.lane, sourceRoot)).filter((required) => required.file === group.file && required.test !== undefined
    && (group.suite !== undefined ? required.suite === group.suite
      : group.models ? required.test.startsWith("pinned raw response model ") : required.backend === "postgres"));
}

const approvedSourceGroups: NamedGroup[] = [
  {
    "label": "native snapshots",
    "lane": "platform-postgres",
    "file": "tests/controlplane/approved-source-snapshots.test.ts",
    "suite": "permanent approved source snapshots [postgres]",
    "count": 38,
    "sha256": "045b5035f8006d8728182e0b316c2c6537567a8dbabb9a3c0b964aba483137a0"
  },
  {
    "label": "final source CAS",
    "lane": "platform-postgres",
    "file": "tests/controlplane/build-launch-broker-binding.test.ts",
    "suite": "CodeBuild transaction-bound broker [postgres]",
    "count": 17,
    "sha256": "a4f6c8e94a83025ca9511bc5a14dc7590cd53c74487c81396f291090447a5644"
  },
  {
    "label": "source schema and role permissions",
    "lane": "platform-postgres",
    "file": "tests/controlplane/migrations.test.ts",
    "suite": "migrator [postgres] concurrency and fail-closed open",
    "count": 3,
    "sha256": "6766be308717efb3799863ce483851992b50c774565831ffaf7261d827b14818"
  },
  {
    "label": "original-byte source custody",
    "lane": "platform-postgres",
    "file": "tests/tofu/plan-artifact-handoff.test.ts",
    "suite": "authenticated original cross-worker handoff [postgres]",
    "count": 1,
    "sha256": "d1914378401056d638c226fd7be17a6458b63deb74b82fbcdeb3318e32d2942f"
  },
  {
    "label": "source-bound build tenancy",
    "lane": "platform-postgres",
    "file": "tests/controlplane/tenancy.test.ts",
    "suite": "build launch tenant isolation sweep [postgres]",
    "count": 1,
    "sha256": "8bd893dd4df7c840ad5a4c047344c7da0145c6604e7b7f5cf319163164c2ea36"
  },
  {
    "label": "default owning source runtime",
    "lane": "platform-postgres",
    "file": "tests/platform/approved-source-runtime.test.ts",
    "suite": "default approved source runtime owning persistence [postgres]",
    "count": 1,
    "sha256": "86dfb9f4def20af5ce71d89095270ce8e531c7cb702551df77a47ec077ab0907"
  }
];
function approvedSourceNamed(sourceRoot = root): Requirement[] {
  const ids = new Set(APPROVED_SOURCE_POSTGRES_REQUIREMENTS.map(item => requirementId("platform-postgres", item)));
  return requirementsFor("platform-postgres", sourceRoot).filter(item => ids.has(item.id));
}
function approvedSourceGroup(group: NamedGroup, sourceRoot = root) {
  return approvedSourceNamed(sourceRoot).filter(item => item.file === group.file && item.suite === group.suite);
}
const planSourceGroups: NamedGroup[] = [
  { label: "final native original-plan admission", lane: "platform-postgres", file: "tests/controlplane/plan-artifact-source-authority.test.ts", suite: "original plan source dispatch authority [postgres]", count: 13, sha256: "1e3cb0dc9cccb9d55c5aeddaf3dd9601805e57d3c9bc644337a5e476b5002918" },
  { label: "paired original private-source binary", lane: "platform-postgres", file: "tests/tofu/plan-artifact-handoff.test.ts", suite: "authenticated original cross-worker handoff [postgres]", count: 2, sha256: "bf45fb47b7beb1b23768b3ecc70387dcc04e9a68a6441f65d7b95596f3ecbfd4" },
];
function planSourceNamed(sourceRoot = root): Requirement[] {
  const ids = new Set(PLAN_SOURCE_AUTHORITY_POSTGRES_REQUIREMENTS.map(item => requirementId("platform-postgres", item)));
  return requirementsFor("platform-postgres", sourceRoot).filter(item => ids.has(item.id));
}
function planSourceGroup(group: NamedGroup, sourceRoot = root) {
  return planSourceNamed(sourceRoot).filter(item => item.file === group.file && item.suite === group.suite);
}
const sourceCounterpartGroups: NamedGroup[] = [
  { label: "native composition", lane: "platform-postgres", file: "tests/platform/composition.test.ts", suite: "platform composition", count: 2, sha256: "60aaa62073f5c10a4e2f848fae715812a3834ee2bf95399c5f6bd70c5fdb1686" },
  { label: "native source wiring", lane: "platform-postgres", file: "tests/platform/source-bundle-composition.test.ts", suite: "source-bundle execution wiring", count: 5, sha256: "61e16834532b1d50101a4c210fb9e927ac219d2ecdfbdd940f501599777d5aa1" },
  { label: "native GitHub acquisition with modeled HTTP", lane: "platform-postgres", file: "tests/platform/source-bundle-github.test.ts", suite: "C3 default GitHub App acquisition", count: 1, sha256: "c9e4d53e3749e28956b4d598d724193fae7cc06630a68ae57531b0e220c9382e" },
  { label: "native Azure source with modeled cloud", lane: "platform-postgres", file: "tests/platform/source-bundle-azure.test.ts", suite: "provider-dispatched Azure source preparation", count: 10, sha256: "ce2e2714a2d255c5426aa65f25d3945af033805397b9e12b29fd79e139b196e7" },
  { label: "original stage evidence", lane: "platform-postgres", file: "tests/controlplane/source-plan-evidence.test.ts", suite: "source plan evidence authority [postgres]", count: 4, sha256: "8b5550d75ec4df5961ba303ab9f4ca5e5625001e664a498b1d3e2815c2075dd4" },
];
function sourceCounterpartNamed(sourceRoot = root): Requirement[] {
  const ids = new Set([...SOURCE_FIXTURE_POSTGRES_REQUIREMENTS, ...SOURCE_PLAN_EVIDENCE_POSTGRES_REQUIREMENTS].map(item => requirementId("platform-postgres", item)));
  return requirementsFor("platform-postgres", sourceRoot).filter(item => ids.has(item.id));
}
function sourceCounterpartGroup(group: NamedGroup, sourceRoot = root) {
  return sourceCounterpartNamed(sourceRoot).filter(item => item.file === group.file && item.suite === group.suite);
}
const firstSourceLeaseFile = "tests/controlplane/first-source-lease-binding.test.ts";
const firstSourceLeaseSuite = "first source worker lease binding [postgres]";
function firstSourceLeaseNamed(sourceRoot = root): Requirement[] {
  const ids = new Set(FIRST_SOURCE_LEASE_POSTGRES_REQUIREMENTS.map(item => requirementId("platform-postgres", item)));
  return requirementsFor("platform-postgres", sourceRoot).filter(item => ids.has(item.id));
}
function executionLeaseTenantNamed(sourceRoot = root): Requirement[] {
  const ids = new Set(EXECUTION_LEASE_TENANT_POSTGRES_REQUIREMENTS.map(item => requirementId("platform-postgres", item)));
  return requirementsFor("platform-postgres", sourceRoot).filter(item => ids.has(item.id));
}
const g2NativeGroups: (NamedGroup & { flag: string; offset: number; linesSha256?: string })[] = [
  { label: "MCP durable admission with modeled product protocol", lane: "platform-postgres", file: "tests/controlplane/mcp-deploy-admission.test.ts", suite: "MCP durable deployment admission [postgres; modeled product protocol]", count: 18, sha256: "ffda152bf4e864c6efbf8f9e2cd323a14fd912d9736186a3e7fc4896ad498438", flag: "ZENITH_TEST_MCP_DEPLOY_ADMISSION_REQUIRED", offset: 0 },
  { label: "current native OAuth integration membership", lane: "platform-postgres", file: membershipFile, suite: "cached default broker current membership [postgres; modeled product reads]", count: 6, sha256: "a7cec69cd64a37d27805296797b9d9a869b50e49fc51cbe18c070d7bdc5b1c39", flag: "ZENITH_TEST_DEFAULT_CURRENT_MEMBERSHIP_REQUIRED", offset: 21 },
  { label: "physical opener ownership", lane: "platform-postgres", file: "tests/controlplane/opened-handle-ownership.test.ts", suite: "opened platform handle ownership [postgres]", count: 10, sha256: "daf670b6c15ec2994f39590e2c6dfbe047026186cb8b6d4720abd0a4c870d817", flag: "ZENITH_TEST_OPENED_HANDLE_REQUIRED", offset: 0, linesSha256: "4ee95aa24a4663035fd8b7202d94818242c249c05d9a491275a62899dd6dc31a" },
  { label: "native default AWS readiness with modeled cloud reads", lane: "platform-postgres", file: "tests/platform/aws-bootstrap-preflight-admission.test.ts", suite: "native AWS bootstrap readiness admission [postgres]", count: 37, sha256: "107587a93e750cfb0af5578e9a04d48a3f7c938ea1156f37759dd24fe743229d", flag: "ZENITH_TEST_AWS_PREFLIGHT_REQUIRED", offset: 0, linesSha256: "2e48785f72d039f6e73be3961e2390442e9320b2b36b2856e34fd5bee0e7f8de" },
];
function g2NativeNamed(sourceRoot = root): Requirement[] {
  const ids = new Set([...MCP_DURABLE_ADMISSION_POSTGRES_REQUIREMENTS, ...AWS_BOOTSTRAP_READINESS_POSTGRES_REQUIREMENTS].map(item => requirementId("platform-postgres", item)));
  return requirementsFor("platform-postgres", sourceRoot).filter(item => ids.has(item.id));
}
function g2NativeGroup(group: NamedGroup, sourceRoot = root) {
  return g2NativeNamed(sourceRoot).filter(item => item.file === group.file && item.suite === group.suite);
}
const finalMcpFile = "tests/controlplane/mcp-start-source-authority.test.ts";
const finalMcpGroups: (NamedGroup & { native: boolean; untilSuite?: string })[] = [
  { label: "final native MCP source/product/member authority with modeled protocols", lane: "platform-postgres", file: finalMcpFile, suite: "MCP final start source authority [postgres; modeled external protocols]", count: 72, sha256: "e800f0667577f3e9efd9c763840a2d7d0de1e507a986856861ed0cd71d8f974c", native: true, untilSuite: "default product client provenance [SDK protocol; no network]" },
  { label: "locked SDK constructor/protocol controls without network", lane: "platform-postgres", file: finalMcpFile, suite: "default product client provenance [SDK protocol; no network]", count: 17, sha256: "c270b2a874201213090cb19555ea7a905263cd901c7fedc0ed944c49c4a08d3c", native: false },
];
function finalMcpNamed(sourceRoot = root): Requirement[] {
  const ids = new Set([...MCP_START_SOURCE_AUTHORITY_POSTGRES_REQUIREMENTS, ...MCP_START_SOURCE_AUTHORITY_SDK_REQUIREMENTS].map(item => requirementId("platform-postgres", item)));
  return requirementsFor("platform-postgres", sourceRoot).filter(item => ids.has(item.id));
}
function finalMcpGroup(group: NamedGroup, sourceRoot = root) {
  return finalMcpNamed(sourceRoot).filter(item => item.file === group.file && item.suite === group.suite);
}
const planProductDiscovered = [
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
] as const;
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
const settlementGroup = {
  file: "tests/controlplane/cleanup-writer-barriers.test.ts",
  suite: "native cleanup writer barrier [postgres; modeled hosted association and policy]",
  flag: "ZENITH_TEST_SAVED_PLAN_SETTLEMENT_REQUIRED",
  sourceSha256: "c4cd57bbe0925a846050a376b6e795ed2785aaea262e0792b054a0ae393b96c1",
  namesSha256: "5c20cb4c31e9d0b11a9774d0009203adeea0ce8c993a1f92fed077875a774f69",
} as const;
function settlementNamed(sourceRoot = root): Requirement[] {
  const ids = new Set(SAVED_PLAN_SETTLEMENT_POSTGRES_REQUIREMENTS.map(item => requirementId("platform-postgres", item)));
  return requirementsFor("platform-postgres", sourceRoot).filter(item => ids.has(item.id));
}
// Discovery successors leave historical comparisons only. They remain mandatory
// in the current manifest, and unknown future IDs are never filtered here.
// Wave-2 scheduling additions remain mandatory; only historical comparisons exclude these exact IDs.
const wave2WorkflowIds = new Set([
  "workflows:tests/workflows/critical-schedule.test.ts:4ee93ed6c454",
  "workflows:tests/platform/critical-jobs.test.ts:4ee93ed6c454",
]);
// Exactly the reviewed replay addition leaves predecessor comparisons; unknown IDs stay visible.
const replayAdditionIds = new Set([
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
const errorBoundaryWorkflowId = "workflows:tests/platform/error-boundary.test.ts:4ee93ed6c454";
function withoutKnownWorkflowSuccessors(items: Requirement[]): Requirement[] {
  return items.filter(item => !replayAdditionIds.has(item.id) && item.id !== errorBoundaryWorkflowId);
}
const criticalScheduleWorkflowIds = new Set(CRITICAL_SCHEDULE_TEMPORAL_REQUIREMENTS.map(item => requirementId("workflows", item)));
function priorCriticalScheduleWorkflowRequirements(sourceRoot = root) {
  return withoutKnownWorkflowSuccessors(requirementsFor("workflows", sourceRoot)).filter(item => !criticalScheduleWorkflowIds.has(item.id) && !incomingWorkflowIds.has(item.id) && !integrationWorkflowIds.has(item.id));
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
const currentSuccessorPlatformIds = currentSuccessorPlatformCohort.map(item => requirementId("platform-postgres", item));
function withoutCurrentSuccessorCohort(requirements: Requirement[]): Requirement[] {
  const ids = new Set(currentSuccessorPlatformIds);
  return requirements.filter(item => !ids.has(item.id));
}
// Only these five explicitly registered names leave predecessor comparisons.
// Current validation still requires every named case, even if its file is deleted.
// Only these exact ten IDs leave historical comparisons; unknown successors remain.
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
function priorOwnershipSnapshotRequirements(requirements: Requirement[]): Requirement[] {
  return requirements.filter(item => !ownershipSnapshotCasIds.has(item.id) && !destroyApplyLaneIds.has(item.id));
}
function withoutIncomingPlatform(requirements: Requirement[]): Requirement[] {
  return withoutIncomingPlatformCohort(priorOwnershipSnapshotRequirements(requirements));
}

const hardeningPlatformIds = INCIDENT_OWNERSHIP_HARDENING_POSTGRES_REQUIREMENTS.map(item => requirementId("platform-postgres", item));
function priorHardeningPlatformRequirements(sourceRoot = root) {
  const ids = new Set(hardeningPlatformIds);
  return withoutIncomingPlatform(requirementsFor("platform-postgres", sourceRoot)).filter(item => !ids.has(item.id));
}
function priorCurrentSuccessorPlatformRequirements(sourceRoot = root): Requirement[] {
  return withoutCurrentSuccessorCohort(priorHardeningPlatformRequirements(sourceRoot));
}
// Only these exact additive IDs leave historical assertions; unknown future IDs remain.
function priorSettlementPlatformRequirements(sourceRoot = root): Requirement[] {
  const ids = new Set(SAVED_PLAN_SETTLEMENT_POSTGRES_REQUIREMENTS.map(item => requirementId("platform-postgres", item)));
  return priorCurrentSuccessorPlatformRequirements(sourceRoot).filter(item => !ids.has(item.id));
}
const cleanupWriterGroup = {
  file: "tests/controlplane/cleanup-writer-barriers.test.ts",
  suite: "native cleanup writer barrier [postgres; modeled hosted association and policy]",
  backend: "postgres",
  flag: "ZENITH_TEST_CLEANUP_WRITER_BARRIER_REQUIRED",
  sourceSha256: "c4cd57bbe0925a846050a376b6e795ed2785aaea262e0792b054a0ae393b96c1",
  namesSha256: "2d476dcbcd0d95ef51b4bab8cc95e7c6c5de076b38a13fde096f2a291094d0f4",
} as const;
const cleanupWriterDiscovered = { file: cleanupWriterGroup.file, suite: cleanupWriterGroup.suite, backend: "postgres" } as const;
function cleanupWriterNamed(sourceRoot = root): Requirement[] {
  const ids = new Set(CLEANUP_WRITER_BARRIER_POSTGRES_REQUIREMENTS.map(item => requirementId("platform-postgres", item)));
  return requirementsFor("platform-postgres", sourceRoot).filter(item => ids.has(item.id));
}
// Only this exact added cohort and its genuine discovery leave historical
// assertions. The production manifest and validator retain the full successor.
function priorCleanupPlatformRequirements(sourceRoot = root): Requirement[] {
  const ids = new Set([...CLEANUP_WRITER_BARRIER_POSTGRES_REQUIREMENTS, cleanupWriterDiscovered].map(item => requirementId("platform-postgres", item)));
  return priorSettlementPlatformRequirements(sourceRoot).filter(item => !ids.has(item.id));
}
const kubernetesLinkGroup = {
  file: "tests/controlplane/kubernetes-connection-link.test.ts",
  suite: "human Kubernetes connection linking [postgres; modeled hosted association, human request and namespace API]",
  backend: "postgres",
  flag: "ZENITH_TEST_KUBERNETES_CONNECTION_LINK_REQUIRED",
  sourceSha256: "66e388f6d0d0b8e9cf8f3e7fa78a8c4f01d2ff9999cc11584c8cd4653a37e2a2",
  namesSha256: "9e62cccc28a3b83f3de420bf24954b10bbcfc188c0d1648378da38e583c66d86",
} as const;
const kubernetesLinkDiscovered = { file: kubernetesLinkGroup.file, suite: kubernetesLinkGroup.suite, backend: "postgres" } as const;
function kubernetesLinkNamed(sourceRoot = root): Requirement[] {
  const ids = new Set(KUBERNETES_CONNECTION_LINK_POSTGRES_REQUIREMENTS.map(item => requirementId("platform-postgres", item)));
  return requirementsFor("platform-postgres", sourceRoot).filter(item => ids.has(item.id));
}
// Only historical regression checks select the exact predecessor. Production
// discovery and validation require all 21 new scenarios plus their actual suite.
function priorKubernetesLinkPlatformRequirements(sourceRoot = root): Requirement[] {
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

function priorPlanProductPlatformRequirements(sourceRoot = root): Requirement[] {
  const ids = new Set([...PLAN_PRODUCT_AUTHORITY_POSTGRES_REQUIREMENTS, ...PLAN_PRODUCT_RETAINED_WAIT_POSTGRES_REQUIREMENTS, ...planProductDiscovered].map(item => requirementId("platform-postgres", item)));
  return priorNativeOAuthPlatformRequirements(sourceRoot).filter(item => !ids.has(item.id));
}
function priorRetainedWaitPlatformRequirements(sourceRoot = root): Requirement[] {
  const ids = new Set(PLAN_PRODUCT_RETAINED_WAIT_POSTGRES_REQUIREMENTS.map(item => requirementId("platform-postgres", item)));
  return priorNativeOAuthPlatformRequirements(sourceRoot).filter(item => !ids.has(item.id));
}
function planProductNamed(sourceRoot = root): Requirement[] {
  const ids = new Set(PLAN_PRODUCT_AUTHORITY_POSTGRES_REQUIREMENTS.map(item => requirementId("platform-postgres", item)));
  return requirementsFor("platform-postgres", sourceRoot).filter(item => ids.has(item.id));
}

// Only prior-cohort regression assertions use this selection. The production
// validator and full manifest retain every new named and discovered requirement.
function priorG2PlatformRequirements(sourceRoot = root): Requirement[] {
  const ids = new Set([...EXECUTION_LEASE_TENANT_POSTGRES_REQUIREMENTS, ...MCP_DURABLE_ADMISSION_POSTGRES_REQUIREMENTS, ...AWS_BOOTSTRAP_READINESS_POSTGRES_REQUIREMENTS, ...MCP_START_SOURCE_AUTHORITY_POSTGRES_REQUIREMENTS, ...MCP_START_SOURCE_AUTHORITY_SDK_REQUIREMENTS].map(item => requirementId("platform-postgres", item)));
  return priorPlanProductPlatformRequirements(sourceRoot).filter(item => !ids.has(item.id)
    && !(item.test === undefined && ["tests/controlplane/mcp-deploy-admission.test.ts", "tests/controlplane/opened-handle-ownership.test.ts", finalMcpFile].includes(item.file)));
}
/** Expand only committed flat string parameter labels; never execute fixture source. */
function sourceCounterpartDeclarations(file: string): string[] {
  const source = fs.readFileSync(path.join(root, file), "utf8");
  return [...source.matchAll(/\bit(\.skipIf\(!PG_URL\))?(?:\.each\((\[[^\]]*\])(?: as const)?\))?\("([^"\n]+)"/g)].flatMap(match => {
    if (file.startsWith("tests/platform/") && !match[1]) return [];
    if (!match[2]) return [match[3]];
    const values: unknown = JSON.parse(match[2]);
    if (!Array.isArray(values) || values.some(value => typeof value !== "string")) throw new Error("Native fixture test labels must be explicit committed strings.");
    return values.map(value => match[3].replace("%s", value));
  });
}
/** Parse only the tests' committed literal strings, without evaluating source. */
function declaredLiteralTests(file: string, suite?: string, untilSuite?: string): string[] {
  const source = fs.readFileSync(path.join(root, file), "utf8");
  const nativeStart = suite === undefined ? 0 : source.indexOf(`describe.skipIf(!PG_URL)(${JSON.stringify(suite)}`);
  const start = nativeStart >= 0 ? nativeStart : source.indexOf(`describe(${JSON.stringify(suite)}`);
  const end = untilSuite === undefined ? source.length : source.indexOf(`\ndescribe(${JSON.stringify(untilSuite)}`, start);
  if (start < 0 || end <= start) throw new Error("The exact committed suite declaration is unavailable.");
  let body = source.slice(start, end);
  if (file === finalMcpFile && body.includes("it.each(changes)(")) {
    // This packet's only named parameter list is itself a committed flat string
    // literal. Bound the suites before expanding it; never evaluate source.
    const labels = /const changes = (\[[\s\S]*?\]) as const;/.exec(body)?.[1];
    if (!labels) throw new Error("The final MCP literal source-change labels are unavailable.");
    const values: unknown = JSON.parse(labels);
    if (!Array.isArray(values) || values.some(value => typeof value !== "string")) throw new Error("Expected committed string source-change labels.");
    body = body.replace("it.each(changes)(", `it.each(${JSON.stringify(values)})(`);
  }
  return [...body.matchAll(/\bit(?:\.each\((\[[^\]]*\])(?: as const)?\))?\(\s*"([^"\n]+)"/g)].flatMap(match => {
    if (!match[1]) return [match[2]];
    const values: unknown = JSON.parse(match[1]);
    if (!Array.isArray(values) || values.some(value => typeof value !== "string")) throw new Error("Expected committed string test parameters.");
    return values.map(value => match[2].replace("%s", value));
  });
}

describe("canonical gate manifest", () => {
  it.each(Object.keys(GATE_LANES))("%s uses serial commands, stable unique IDs and retained prerequisites", (lane) => {
    const manifest = manifestFor(lane, root);
    expect(manifest.command).toContain("--maxWorkers=1");
    expect(manifest.command).toContain("--no-file-parallelism");
    expect(manifest.command).toContain(`--outputFile.json=${manifest.report}`);
    expect(manifest.prerequisites.length).toBeGreaterThan(1);
    expect(new Set(manifest.requirements.map((required: { id: string }) => required.id)).size).toBe(manifest.requirements.length);
    expect(manifest.requirements).toEqual(requirementsFor(lane, root));
    expect(manifestFor(lane, root, "captured.json").command).toContain("--outputFile.json=captured.json");
  });

  it("keeps real local codec/destroy replay required with their engine flag enabled", () => {
    const manifest = manifestFor("workflows", root);
    expect(manifest.env.ZENITH_TEST_TEMPORAL).toBe("1");
    for (const file of ["tests/workflows/codec-replay.test.ts", "tests/workflows/destroy-replay.test.ts"]) {
      expect(manifest.requirements).toContainEqual(expect.objectContaining({ file }));
      expect(manifest.excludeFiles).not.toContain(file);
    }
  });

  it("requires every source-bundle suite, including the pinned real public GitHub read", () => {
    const manifest = manifestFor("workflows", root);
    const suites = manifest.requirements.filter((required: { file: string }) => required.file === "tests/platform/source-bundle.test.ts");
    expect(suites).toHaveLength(4);
    expect(suites).toContainEqual(expect.objectContaining({ suite: "live public GitHub source (opt-in network)" }));
    expect(manifest.env).toMatchObject({ ZENITH_TEST_SOURCE_GITHUB: "1", ZENITH_TEST_SOURCE_REPO: "https://github.com/GODOSTROYER/zenith", ZENITH_TEST_SOURCE_REF: "37be7340536ccb68ae4bb49294e8ab3799d1f01b" });
    expect(manifest.excludeFiles).toEqual(["tests/workflows/mtls-live.test.ts", "tests/platform/codebuild-launch-authority.test.ts", "tests/workflows/start-intent.test.ts", "tests/workflows/history-record.test.ts"]);
  });

  it("declares mTLS prerequisites and an unverified release blocker rather than a pass", () => {
    expect(EXTERNAL_ACCEPTANCE).toHaveLength(11);
    expect(EXTERNAL_ACCEPTANCE.find(g => g.id === "wave5-mixed-lambda")).toMatchObject({ file: "tests/acceptance/mixed-lambda.gated.test.ts", wholeFile: true });
    expect(EXTERNAL_ACCEPTANCE[0]).toMatchObject({ file: "tests/workflows/mtls-live.test.ts", wholeFile: true });
    expect(EXTERNAL_ACCEPTANCE[0].prerequisites).toContain("ZENITH_TEMPORAL_TLS_KEY_FILE");
    expect(EXTERNAL_ACCEPTANCE[0].releaseBlocker).toContain("unverified");
    expect(requirementsFor("workflows", root).some((required: { file: string }) => required.file === EXTERNAL_ACCEPTANCE[0].file)).toBe(false);
  });

  it("covers direct PG-only suites and each parameterized backend suite independently", () => {
    const requirements = priorG2PlatformRequirements();
    const sourceIds = new Set([...approvedSourceNamed(), ...planSourceNamed(), ...sourceCounterpartNamed()].map(item => item.id));
    const existing = requirements.filter((required) => !operationPostgresFiles.includes(required.file)
      && !sourceIds.has(required.id) && required.file !== firstSourceLeaseFile && required.file !== "tests/controlplane/approved-source-snapshots.test.ts"
      && required.file !== "tests/controlplane/plan-artifact-source-authority.test.ts"
      && !(required.file === "tests/controlplane/source-plan-evidence.test.ts" && required.suite === "source plan evidence authority [postgres]" && required.test === undefined)
      && !(required.file === "tests/controlplane/tenancy.test.ts" && required.suite === "build launch tenant isolation sweep [postgres]" && required.test === undefined));
    expect(existing).toHaveLength(228);
    expect(existing.filter((required) => required.file !== ecsGrantFile)).toHaveLength(222);
    expect(requirements.filter(required => required.file === "tests/controlplane/tenancy.test.ts" && required.suite === "build launch tenant isolation sweep [postgres]" && required.test === undefined))
      .toEqual([expect.objectContaining({ backend: "postgres" })]);
    expect(requirements.filter((required) => operationPostgresFiles.includes(required.file) && required.test)).toHaveLength(96);
    expect(requirements).toContainEqual(expect.objectContaining({ file: "tests/controlplane/open.test.ts", suite: "platformDb() against PostgreSQL", backend: "postgres" }));
    expect(requirements).toContainEqual(expect.objectContaining({ file: "tests/controlplane/executor.test.ts", suite: "cross-engine shape identity", backend: "postgres" }));
    expect(requirements.filter((required: { file: string }) => required.file === "tests/capabilities/tenancy.test.ts")).toHaveLength(5);
  });

  it("requires fresh migration, PostgreSQL concurrency and the exact schema 6 hardening upgrade case", () => {
    const requirements = priorHardeningPlatformRequirements().filter((required) => required.file === "tests/controlplane/migrations.test.ts");
    expect(requirements.map((required) => ({ suite: required.suite, test: required.test }))).toEqual([
      { suite: "migrator [postgres]", test: undefined },
      { suite: "migrator [postgres] concurrency and fail-closed open", test: undefined },
      { suite: "migrator [postgres] concurrency and fail-closed open", test: "schema 6 emitted hardening upgrades through the canonical migrator under a distinct owner with RLS, role isolation and immutable artifacts" },
      { suite: "migrator [postgres] concurrency and fail-closed open", test: "fresh canonical migrations keep permanent agent receipts select/insert-only" },
      { suite: "migrator [postgres] concurrency and fail-closed open", test: "same-owner schema6 canonical migrations keep permanent agent receipts select/insert-only" },
      { suite: "migrator [postgres] concurrency and fail-closed open", test: "fresh canonical migrations keep permanent approved source snapshots select/insert-only" },
      { suite: "migrator [postgres] concurrency and fail-closed open", test: "same-owner schema6 canonical migrations keep permanent approved source snapshots select/insert-only" },
      { suite: "migrator [postgres] concurrency and fail-closed open", test: "schema12 refuses startup and even source-free plan review until the canonical source migration is applied" },
    ]);
    const report = {
      success: true,
      testResults: [{ name: path.resolve(root, "tests/controlplane/migrations.test.ts"), status: "passed", assertionResults: requirements.map((required) => ({ fullName: required.suite + " " + (required.test ?? "scenario"), title: required.test ?? "scenario", ancestorTitles: [required.suite], status: "passed" })) }],
    };
    expect(reportFailures(requirements, report, root)).toEqual([]);
    report.testResults[0].assertionResults.shift();
    expect(reportFailures(requirements, report, root)).toHaveLength(1);
  });

  it.each(["pglite", "skipped", "failed"])("rejects %s replacement of the real fresh migration suite even when concurrency passed", (replacement) => {
    const requirements = requirementsFor("platform-postgres", root).filter((required) => required.file === "tests/controlplane/migrations.test.ts");
    const assertions = requirements.map((required) => ({ fullName: required.suite + " " + (required.test ?? "scenario"), title: required.test ?? "scenario", ancestorTitles: [required.suite ?? ""], status: "passed" }));
    if (replacement === "pglite") {
      assertions[0].ancestorTitles = ["migrator ['pglite']"];
      assertions[0].fullName = "migrator ['pglite'] scenario";
    } else assertions[0].status = replacement;
    expect(reportFailures(requirements, { success: true, testResults: [{ name: path.resolve(root, requirements[0].file), status: "passed", assertionResults: assertions }] }, root)).toHaveLength(1);
  });

  it("retains fresh dependency installation and all core command exits", () => {
    expect(manifestFor("fresh", root).steps[0]).toEqual({ id: "install", command: ["npm", "ci", "--ignore-scripts"] });
    expect(manifestFor("core", root).steps.map((step: { id: string }) => step.id)).toEqual(["typecheck", "lint", "unit", "smoke", "gimbal"]);
  });

  it("exports a usable CLI without treating inherited object properties as lanes", () => {
    const script = path.resolve(root, "scripts/ci/gate-manifest.mjs");
    const result = spawnSync(process.execPath, [script, "external-acceptance"], { encoding: "utf8" });
    const group = JSON.parse(result.stdout).groups[0];
    expect(result.status).toBe(0);
    expect(group.status).toBe("unverified");
    expect(group.command).toContain("--testNamePattern");
    for (const lane of ["constructor", "unknown"]) {
      expect(() => manifestFor(lane, root)).toThrow("Unknown CI lane");
      expect(spawnSync(process.execPath, [script, lane], { encoding: "utf8" }).status).toBe(2);
    }
  });
});


describe("mandatory operation gates", () => {
  it.each(namedOperationGroups)("$label pins every exact named case and honest backend metadata", (group) => {
    const required = namedGroup(group);
    expect(required).toHaveLength(group.count);
    expect(createHash("sha256").update(JSON.stringify(required.map((item) => item.test))).digest("hex")).toBe(group.sha256);
    expect(new Set(required.map((item) => item.test)).size).toBe(group.count);
    for (const item of required) {
      if (group.models) { expect(item.backend).toBeUndefined(); expect(item.postgres).toBeUndefined(); }
      else expect(item.postgres === true || item.backend === "postgres").toBe(true);
    }
    expect(reportFailures(required, contractReport(required), root)).toEqual([]);
  });

  it.each(namedOperationGroups)("$label rejects each independently missing, failed or skipped requirement", (group) => {
    const required = namedGroup(group);
    for (const missing of required) {
      expect(reportFailures(required, contractReport(required.filter((item) => item.id !== missing.id)), root), missing.id).toHaveLength(1);
      for (const status of ["failed", "skipped", "pending", "todo"]) {
        const report = contractReport(required);
        const assertion = report.testResults.flatMap((file) => file.assertionResults).find((item) => item.title === missing.test)!;
        assertion.status = status;
        expect(reportFailures(required, report, root).length, `${missing.id}: ${status}`).toBeGreaterThan(0);
      }
    }
  });

  it.each(["reconciliation", "workflow-intents"])("%s has fixed serial engine requirements even when source is absent", (lane) => {
    const manifest = manifestFor(lane, root);
    expect(manifest.requirements).toHaveLength(lane === "reconciliation" ? 26 : 141);
    expect(requirementsFor(lane, scratch)).toEqual(manifest.requirements);
    expect(manifest.tools).toEqual({ node: "22.23.3", postgres: "16.15", temporal: "1.9.1" });
    expect(manifest.env).toMatchObject({ ZENITH_TEST_TEMPORAL: "1", ZENITH_TEST_TEMPORAL_DOWNLOAD: lane === "reconciliation" ? "0" : "1" });
    expect(manifest.command).not.toContain("--passWithNoTests");
    expect(manifest.excludeFiles).toEqual([]);
    if (lane === "reconciliation") {
      expect(manifest.files).toEqual(["tests/workflows/reconcile-schedule.test.ts", "tests/workers/reconcile-composition.test.ts"]);
      expect(manifest.env).toMatchObject({ ZENITH_TEST_RECONCILE_SCHEDULE: "1", ZENITH_TEST_RECONCILE_COMPOSITION: "1" });
    } else {
      expect(manifest.env.ZENITH_TEST_WORKFLOW_START_REQUIRED).toBe("1");
      expect(manifest.files).toEqual([intentSqlFile, intentAuthorityFile, intentTemporalFile, "tests/workflows/replay.test.ts", "tests/workflows/codec-replay.test.ts", "tests/workflows/destroy-replay.test.ts"]);
      expect(manifest.requirements.filter((item) => item.test?.startsWith("pinned raw response model "))).toHaveLength(21);
      expect(manifest.requirements.filter((item) => item.postgres || item.backend === "postgres")).toHaveLength(102);
      expect(manifest.requirements.every((item) => typeof item.test === "string")).toBe(true);
      expect(manifest.requirements.filter((item) => item.file.endsWith("replay.test.ts"))).toHaveLength(15);
    }
  });

  it("pins all 15 unchanged actual Temporal replay cases, independently of passing scripted siblings", () => {
    const required = requirementsFor("workflow-intents", root).filter((item) => item.file.endsWith("replay.test.ts"));
    expect(required).toHaveLength(15);
    expect(createHash("sha256").update(JSON.stringify(required.map(({ file, suite, test }) => ({ file, suite, test })))).digest("hex")).toBe("6a7656788a2343b6ccde67c0a730fb16f4f5c4338d6c835f65b4674e08459bfa");
    expect(reportFailures(required, contractReport(required), root)).toEqual([]);
    for (const missing of required) {
      expect(reportFailures(required, contractReport(required.filter((item) => item.id !== missing.id)), root)).toHaveLength(1);
      const report = contractReport(required);
      report.testResults.flatMap((file) => file.assertionResults).find((item) => item.title === missing.test)!.status = "skipped";
      expect(reportFailures(required, report, root).length).toBeGreaterThan(0);
    }
  });

  it("requires the same 75 SQL/authority and 21 named current-membership cases in the standalone PostgreSQL lane", () => {
    const manifest = manifestFor("platform-postgres", root);
    expect(manifest.env).toMatchObject({ ZENITH_TEST_WORKFLOW_START_REQUIRED: "1", ZENITH_TEST_DEFAULT_CURRENT_MEMBERSHIP_REQUIRED: "1" });
    const named = priorG2PlatformRequirements().filter((item) => operationPostgresFiles.includes(item.file) && item.test);
    expect(named).toHaveLength(96);
    const intent = named.filter((item) => item.file !== membershipFile);
    expect(intent.map(({ id: _id, ...item }) => item)).toEqual(requirementsFor("workflow-intents", root)
      .filter((item) => item.postgres).map(({ id: _id, ...item }) => item));
    // Retain the existing automatic whole-suite discovery when the integrated files are present.
    for (const file of operationPostgresFiles) {
      if (!fs.existsSync(path.join(root, file))) continue;
      expect(manifest.requirements.some((item) => item.file === file && !item.test && item.backend === "postgres")).toBe(true);
    }
  });

  it.each(operationPostgresFiles)("deleting %s cannot remove any named PostgreSQL contract", (deleted) => {
    const sourceRoot = modelRoot(path.join(scratch, "deleted-operation-"));
    for (const directory of ["tests/controlplane", "tests/capabilities", "tests/reconcile"]) fs.cpSync(path.join(root, directory), path.join(sourceRoot, directory), { recursive: true });
    const named = priorG2PlatformRequirements(sourceRoot).filter((item) => operationPostgresFiles.includes(item.file) && item.test);
    fs.rmSync(path.join(sourceRoot, deleted), { force: true });
    expect(priorG2PlatformRequirements(sourceRoot).filter((item) => operationPostgresFiles.includes(item.file) && item.test)).toEqual(named);
    expect(reportFailures(named, { success: true, testResults: [] }, sourceRoot)).toHaveLength(96);
  });

  it("cannot use wire models or a passing scalar/suite sibling as actual SQL or Temporal acceptance", () => {
    const intent = requirementsFor("workflow-intents", root);
    const actual = intent.filter((item) => item.postgres || item.backend === "postgres");
    const models = intent.filter((item) => item.test?.startsWith("pinned raw response model "));
    expect(reportFailures(actual, contractReport(models), root)).toHaveLength(102);
    const reconciliation = requirementsFor("reconciliation", root);
    const report = contractReport(reconciliation);
    for (const file of report.testResults) for (const assertion of file.assertionResults) assertion.ancestorTitles = ["supplemental modeled scheduler behavior"];
    expect(reportFailures(reconciliation, report, root)).toHaveLength(26);
    const sql = intent.filter((item) => item.postgres);
    const pglite = contractReport(sql);
    for (const file of pglite.testResults) for (const assertion of file.assertionResults) assertion.ancestorTitles = assertion.ancestorTitles.map((title) => title.replace("[postgres]", "[pglite]"));
    expect(reportFailures(sql, pglite, root)).toHaveLength(75);
  });

  it.each(["reconciliation", "workflow-intents"])("%s refuses zero, malformed, duplicate and inconsistent reports", (lane) => {
    const required = requirementsFor(lane, root);
    for (const report of [null, {}, { success: true }, { success: false, testResults: [] }, { success: true, testResults: [] }]) expect(reportFailures(required, report, root).length).toBeGreaterThan(0);
    const malformed = contractReport(required);
    malformed.testResults[0].assertionResults[0].fullName = "";
    expect(reportFailures(required, malformed, root)).toEqual(["Malformed Vitest assertion evidence"]);
    const duplicate = contractReport(required);
    duplicate.testResults.push(duplicate.testResults[0]);
    expect(reportFailures(required, duplicate, root)).toEqual(["Duplicate Vitest file evidence"]);
    expect(reportFailures(required, { ...contractReport(required), numTotalTests: 0 }, root)).toEqual(["Inconsistent Vitest report counts"]);
  });
});

describe("mandatory approved source PostgreSQL gates", () => {
  it("requires actual source13 schema, owning PostgreSQL and committed provider assets without another skip policy", () => {
    const manifest = manifestFor("platform-postgres", root);
    expect(manifest.env.ZENITH_TEST_APPROVED_SOURCE_REQUIRED).toBe("1");
    expect(manifest.env.ZENITH_TEST_APPROVED_SOURCE_RUNTIME_REQUIRED).toBe("1");
    expect(manifest.env.ZENITH_TEST_TOFU_NETWORK).toBe("1");
    expect(manifest.tools).toMatchObject({node:"22.23.3",postgres:"16.15",tofu:"1.12.5"});
    expect(manifest.prerequisites).toContain("Platform migrations applied with scripts/ci/apply-platform-migrations.sh (canonical schema13 is mandatory before every plan review)");
    expect(manifest.prerequisites).toContain("ZENITH_TEST_APPROVED_SOURCE_RUNTIME_REQUIRED=1; default owning runtime persistence requires actual PostgreSQL and canonical schema13");
    expect(manifest.files).toContain("tests/controlplane");
    expect(manifest.files).toContain("tests/tofu/plan-artifact-handoff.test.ts");
    expect(manifest.files).toContain("tests/platform/approved-source-runtime.test.ts");
    expect(manifest.command).toContain("tests/platform/approved-source-runtime.test.ts");
    expect(manifest.excludeFiles).toEqual([]);
    expect(manifest.command).not.toContain("--passWithNoTests");
    expect(approvedSourceNamed()).toHaveLength(61);
    expect(manifest.requirements.filter(item => item.file === "tests/controlplane/approved-source-snapshots.test.ts" && item.test === undefined))
      .toEqual([expect.objectContaining({suite:"permanent approved source snapshots [postgres]",backend:"postgres"})]);
  });

  it.each(approvedSourceGroups)("$label pins every committed named actual scenario independently of discovery", group => {
    const required = approvedSourceGroup(group);
    expect(required).toHaveLength(group.count);
    expect(createHash("sha256").update(JSON.stringify(required.map(item => item.test))).digest("hex")).toBe(group.sha256);
    expect(new Set(required.map(item => item.test)).size).toBe(group.count);
    for (const item of required) {
      expect(item.postgres).toBe(true);
      expect(declaredLiteralTests(group.file)).toContain(item.test);
    }
    if (group.label === "native snapshots") expect(required.map(item => item.test)).toEqual(declaredLiteralTests(group.file));
    if (group.label === "final source CAS") expect(required.map(item => item.test)).toEqual(declaredLiteralTests(group.file).filter(title =>
      ["final native source CAS", "retained-launch recovery fences", "rechecks ", "same stored digest", "native source CAS"].some(prefix => title.startsWith(prefix))));
    expect(reportFailures(required, contractReport(required), root)).toEqual([]);
  });

  it.each(approvedSourceGroups)("$label refuses each absent, failed, skipped, pending or modeled replacement", group => {
    const required = approvedSourceGroup(group);
    for (const missing of required) {
      expect(reportFailures(required, contractReport(required.filter(item => item.id !== missing.id)), root), missing.id).toHaveLength(1);
      for (const status of ["failed", "skipped", "pending", "todo"]) {
        const report = contractReport(required);
        report.testResults.flatMap(file => file.assertionResults).find(item => item.title === missing.test)!.status = status;
        expect(reportFailures(required, report, root).length, `${missing.id}: ${status}`).toBeGreaterThan(0);
      }
      for (const suite of [group.suite!.replace("[postgres]", "[pglite]"), "modeled source authority [postgres]"]) {
        const report = contractReport(required);
        report.testResults.flatMap(file => file.assertionResults).find(item => item.title === missing.test)!.ancestorTitles = [suite];
        expect(reportFailures(required, report, root), missing.id).toHaveLength(1);
      }
    }
  });

  it.each(approvedSourceGroups)("$label keeps named requirements when the trusted source file is deleted", group => {
    const sourceRoot = modelRoot(path.join(scratch, "deleted-approved-source-"));
    for (const directory of ["tests/controlplane", "tests/capabilities", "tests/reconcile"]) fs.mkdirSync(path.join(sourceRoot, directory), {recursive:true});
    fs.mkdirSync(path.dirname(path.join(sourceRoot, group.file)), {recursive:true});
    fs.copyFileSync(path.join(root, group.file), path.join(sourceRoot, group.file));
    const before = approvedSourceGroup(group, sourceRoot);
    fs.unlinkSync(path.join(sourceRoot, group.file));
    expect(approvedSourceGroup(group, sourceRoot)).toEqual(before);
    expect(before).toEqual(approvedSourceGroup(group));
    expect(reportFailures(before, {success:true,testResults:[]}, sourceRoot)).toHaveLength(group.count);
  });

  it("refuses zero/malformed/duplicate counts and one passing suite in place of exact source scenarios", () => {
    const required = approvedSourceNamed();
    for (const report of [null, {}, {success:true}, {success:true,testResults:[]}, {success:false,testResults:[]}])
      expect(reportFailures(required, report, root).length).toBeGreaterThan(0);
    const suiteOnly = contractReport(required);
    for (const file of suiteOnly.testResults) file.assertionResults = [{title:"one passing model",fullName:"one passing model",ancestorTitles:["permanent approved source snapshots [postgres]"],status:"passed"}];
    expect(reportFailures(required, suiteOnly, root)).toHaveLength(61);
    const malformed = contractReport(required);malformed.testResults[0].assertionResults[0].fullName="";
    expect(reportFailures(required, malformed, root)).toEqual(["Malformed Vitest assertion evidence"]);
    const duplicate = contractReport(required);duplicate.testResults.push(duplicate.testResults[0]);
    expect(reportFailures(required, duplicate, root)).toEqual(["Duplicate Vitest file evidence"]);
    expect(reportFailures(required, {...contractReport(required),numTotalTests:0}, root)).toEqual(["Inconsistent Vitest report counts"]);
  });
});

describe("mandatory original-plan source dispatch gates", () => {
  it("requires the exact native admission and paired binary cases while retaining the earlier source names", () => {
    const manifest = manifestFor("platform-postgres", root);
    expect(manifest.env.ZENITH_TEST_PLAN_SOURCE_AUTHORITY_REQUIRED).toBe("1");
    expect(manifest.prerequisites).toContain("ZENITH_TEST_PLAN_SOURCE_AUTHORITY_REQUIRED=1; final original-plan source admission requires actual PostgreSQL, canonical schema13 and pinned OpenTofu");
    expect(manifest.command).toContain("tests/controlplane"); expect(manifest.command).toContain("tests/tofu/plan-artifact-handoff.test.ts");
    expect(manifest.excludeFiles).toEqual([]); expect(manifest.command).not.toContain("--passWithNoTests");
    expect(planSourceNamed()).toHaveLength(15); expect(approvedSourceNamed()).toHaveLength(61);
    const defaultRuntime = approvedSourceNamed().filter(item => item.file === "tests/platform/approved-source-runtime.test.ts");
    expect(defaultRuntime).toHaveLength(1); expect(defaultRuntime[0].test).toBe("default single-pool owning runtime captures, retains and verifies the same immutable row across an independent pool");
    expect(manifest.requirements.filter(item => item.file === "tests/controlplane/plan-artifact-source-authority.test.ts" && item.test === undefined))
      .toEqual([expect.objectContaining({ suite: "original plan source dispatch authority [postgres]", backend: "postgres" })]);
  });
  it.each(planSourceGroups)("$label pins exact literal names, order, checksum and actual PostgreSQL ancestry", group => {
    const required = planSourceGroup(group);
    expect(required).toHaveLength(group.count); expect(new Set(required.map(item => item.id)).size).toBe(group.count);
    expect(createHash("sha256").update(JSON.stringify(required.map(item => item.test))).digest("hex")).toBe(group.sha256);
    for (const item of required) { expect(item.postgres).toBe(true); expect(declaredLiteralTests(group.file)).toContain(item.test); }
    const names = declaredLiteralTests(group.file);
    expect(required.map(item => item.test)).toEqual(group.file.includes("/controlplane/") ? names : names.filter(title => title.startsWith("independent saved binary")));
    expect(reportFailures(required, contractReport(required), root)).toEqual([]);
  });
  it.each(planSourceGroups)("$label refuses every missing, failed, skipped, pending, malformed or substituted scenario", group => {
    const required = planSourceGroup(group);
    for (const missing of required) {
      expect(reportFailures(required, contractReport(required.filter(item => item.id !== missing.id)), root), missing.id).toHaveLength(1);
      for (const status of ["failed", "skipped", "pending", "todo", "unknown"]) {
        const report = contractReport(required); report.testResults.flatMap(file => file.assertionResults).find(item => item.title === missing.test)!.status = status;
        expect(reportFailures(required, report, root).length, `${missing.id}: ${status}`).toBeGreaterThan(0);
      }
      for (const suite of [group.suite!.replace("[postgres]", "[pglite]"), group.suite!.replace("[postgres]", "['postgres\"]"), "source fixture model [postgres]"]) {
        const report = contractReport(required); report.testResults.flatMap(file => file.assertionResults).find(item => item.title === missing.test)!.ancestorTitles = [suite];
        expect(reportFailures(required, report, root), missing.id).toHaveLength(1);
      }
    }
  });
  it.each(planSourceGroups)("$label remains mandatory when its trusted source file is deleted", group => {
    const sourceRoot = modelRoot(path.join(scratch, "deleted-plan-source-"));
    for (const directory of ["tests/controlplane", "tests/capabilities", "tests/reconcile"]) fs.mkdirSync(path.join(sourceRoot, directory), { recursive: true });
    fs.mkdirSync(path.dirname(path.join(sourceRoot, group.file)), { recursive: true }); fs.copyFileSync(path.join(root, group.file), path.join(sourceRoot, group.file));
    const before = planSourceGroup(group, sourceRoot); fs.unlinkSync(path.join(sourceRoot, group.file));
    expect(planSourceGroup(group, sourceRoot)).toEqual(before); expect(before).toEqual(planSourceGroup(group));
    expect(reportFailures(before, { success: true, testResults: [] }, sourceRoot)).toHaveLength(group.count);
  });
  it("rejects zero, malformed, duplicate and suite-only reports and ignores caller evidence requirements", () => {
    const required = planSourceNamed();
    for (const report of [null, {}, { success: true }, { success: true, testResults: [] }, { success: false, testResults: [] }])
      expect(reportFailures(required, report, root).length).toBeGreaterThan(0);
    const suiteOnly = contractReport(required);
    for (const file of suiteOnly.testResults) file.assertionResults = [{ title: "one modeled source pass", fullName: "one modeled source pass", ancestorTitles: ["original plan source dispatch authority [postgres]"], status: "passed" }];
    expect(reportFailures(required, suiteOnly, root)).toHaveLength(15);
    const malformed = contractReport(required); malformed.testResults[0].assertionResults[0].fullName = "";
    expect(reportFailures(required, malformed, root)).toEqual(["Malformed Vitest assertion evidence"]);
    const duplicate = contractReport(required); duplicate.testResults.push(duplicate.testResults[0]);
    expect(reportFailures(required, duplicate, root)).toEqual(["Duplicate Vitest file evidence"]);
    expect(reportFailures(required, { ...contractReport(required), numTotalTests: 0 }, root)).toEqual(["Inconsistent Vitest report counts"]);
    expect(reportFailures(required, { ...contractReport([]), requirements: [], lane: "platform-postgres" }, root)).toHaveLength(15);
  });
});

describe("mandatory native source fixture and original evidence counterparts", () => {
  it("requires actual PostgreSQL guarded counterparts with unique explicit case identities and no fixture waiver", () => {
    const manifest = manifestFor("platform-postgres", root);
    expect(manifest.env.ZENITH_TEST_SOURCE_FIXTURE_REQUIRED).toBe("1"); expect(manifest.env.ZENITH_TEST_SOURCE_PLAN_EVIDENCE_REQUIRED).toBe("1");
    expect(manifest.prerequisites).toContain("ZENITH_TEST_SOURCE_FIXTURE_REQUIRED=1; native source composition fixtures require actual PostgreSQL and canonical schema13");
    expect(manifest.prerequisites).toContain("ZENITH_TEST_SOURCE_PLAN_EVIDENCE_REQUIRED=1; original stage evidence authority requires actual PostgreSQL and canonical schema13");
    for (const group of sourceCounterpartGroups.slice(0, 4)) { expect(manifest.files).toContain(group.file); expect(manifest.command).toContain(group.file); }
    expect(sourceCounterpartNamed()).toHaveLength(22); expect(new Set(sourceCounterpartNamed().map(item => item.id)).size).toBe(22);
    expect(SOURCE_FIXTURE_POSTGRES_REQUIREMENTS).toHaveLength(18); expect(SOURCE_PLAN_EVIDENCE_POSTGRES_REQUIREMENTS).toHaveLength(4);
    expect(createHash("sha256").update(JSON.stringify(SOURCE_FIXTURE_POSTGRES_REQUIREMENTS.map(item => item.test))).digest("hex")).toBe("29c1bdc98d59846123f9c2f87db4b54a4bc7f30f10f831391d5ee2717d948a7a");
    expect(approvedSourceNamed()).toHaveLength(61); expect(planSourceNamed()).toHaveLength(15); expect(manifest.excludeFiles).toEqual([]);
  });
  it.each(sourceCounterpartGroups)("$label pins exact committed cases and refuses every missing, failed, skipped or replaced case", group => {
    const required = sourceCounterpartGroup(group); expect(required).toHaveLength(group.count);
    expect(createHash("sha256").update(JSON.stringify(required.map(item => item.test))).digest("hex")).toBe(group.sha256);
    const declared = sourceCounterpartDeclarations(group.file);
    expect(required.map(item => item.test)).toEqual(group.file === "tests/platform/composition.test.ts"
      ? declared.filter(title => title.startsWith("captures optional tool authority")) : declared);
    for (const item of required) expect(item.postgres === true || item.backend === "postgres").toBe(true);
    expect(reportFailures(required, contractReport(required), root)).toEqual([]);
    for (const missing of required) {
      expect(reportFailures(required, contractReport(required.filter(item => item.id !== missing.id)), root), missing.id).toHaveLength(1);
      for (const status of ["failed", "skipped", "pending", "todo", "unknown"]) {
        const report = contractReport(required); report.testResults.flatMap(file => file.assertionResults).find(item => item.title === missing.test)!.status = status;
        expect(reportFailures(required, report, root).length).toBeGreaterThan(0);
      }
      for (const suite of [group.suite!.includes("[postgres]") ? group.suite!.replace("[postgres]", "[pglite]") : `${group.suite} [pglite]`, "source fixture model [postgres]"]) {
        const report = contractReport(required); report.testResults.flatMap(file => file.assertionResults).find(item => item.title === missing.test)!.ancestorTitles = [suite];
        expect(reportFailures(required, report, root)).toHaveLength(1);
      }
    }
  });
  it.each(sourceCounterpartGroups)("$label remains mandatory after trusted source deletion", group => {
    const sourceRoot = modelRoot(path.join(scratch, "deleted-source-counterpart-"));
    for (const directory of ["tests/controlplane", "tests/capabilities", "tests/reconcile"]) fs.mkdirSync(path.join(sourceRoot, directory), { recursive: true });
    fs.mkdirSync(path.dirname(path.join(sourceRoot, group.file)), { recursive: true }); fs.copyFileSync(path.join(root, group.file), path.join(sourceRoot, group.file));
    const before = sourceCounterpartGroup(group, sourceRoot); fs.unlinkSync(path.join(sourceRoot, group.file));
    expect(sourceCounterpartGroup(group, sourceRoot)).toEqual(before); expect(before).toEqual(sourceCounterpartGroup(group));
    expect(reportFailures(before, { success: true, testResults: [] }, sourceRoot)).toHaveLength(group.count);
  });
  it("refuses zero, malformed, duplicate and suite-only counterpart reports", () => {
    const required = sourceCounterpartNamed();
    for (const report of [null, {}, { success: true }, { success: true, testResults: [] }, { success: false, testResults: [] }]) expect(reportFailures(required, report, root).length).toBeGreaterThan(0);
    const suiteOnly = contractReport(required); for (const file of suiteOnly.testResults) file.assertionResults = [{ title: "one model", fullName: "one model", ancestorTitles: ["platform composition"], status: "passed" }];
    expect(reportFailures(required, suiteOnly, root)).toHaveLength(22);
    const malformed = contractReport(required); malformed.testResults[0].assertionResults[0].fullName = ""; expect(reportFailures(required, malformed, root)).toEqual(["Malformed Vitest assertion evidence"]);
    const duplicate = contractReport(required); duplicate.testResults.push(duplicate.testResults[0]); expect(reportFailures(required, duplicate, root)).toEqual(["Duplicate Vitest file evidence"]);
    expect(reportFailures(required, { ...contractReport(required), numTotalTests: 0 }, root)).toEqual(["Inconsistent Vitest report counts"]);
  });
});

describe("mandatory first source worker lease binding gates", () => {
  it("requires the exact 24 native cases and guarded PostgreSQL prerequisites while preserving the prior 429 requirements", () => {
    const manifest = manifestFor("platform-postgres", root);
    const required = firstSourceLeaseNamed();
    expect(manifest.env.ZENITH_TEST_FIRST_SOURCE_LEASE_REQUIRED).toBe("1");
    expect(manifest.prerequisites).toContain("ZENITH_TEST_FIRST_SOURCE_LEASE_REQUIRED=1; first worker lease binding requires actual PostgreSQL, canonical schema13 and independent native connections");
    expect(manifest.command).toContain("tests/controlplane");
    expect(manifest.excludeFiles).toEqual([]);
    expect(manifest.command).not.toContain("--passWithNoTests");
    expect(required).toHaveLength(24);
    expect(new Set(required.map(item => item.id)).size).toBe(24);
    expect(required.map(item => item.test)).toEqual(declaredLiteralTests(firstSourceLeaseFile).slice(0, 24));
    expect(createHash("sha256").update(JSON.stringify(required.map(item => item.test))).digest("hex"))
      .toBe("edb5d5a81f79f72109aab5e3b86e13833ba91483e51a058731ac57a687edda6b");
    for (const item of required) expect(item).toMatchObject({ file: firstSourceLeaseFile, suite: firstSourceLeaseSuite, postgres: true });
    expect(manifest.requirements.filter(item => item.file === firstSourceLeaseFile && item.test === undefined))
      .toEqual([expect.objectContaining({ suite: firstSourceLeaseSuite, backend: "postgres" })]);
    const prior = priorG2PlatformRequirements();
    expect(prior.filter(item => item.file !== firstSourceLeaseFile)).toHaveLength(429);
    expect(prior).toHaveLength(454);
    expect(new Set(prior.map(item => item.id)).size).toBe(454);
    expect(approvedSourceNamed()).toHaveLength(61);
    expect(planSourceNamed()).toHaveLength(15);
    expect(sourceCounterpartNamed()).toHaveLength(22);
    expect(reportFailures(required, contractReport(required), root)).toEqual([]);
  });

  it("rejects each absent, failed, skipped, pending, malformed or substituted native scenario", () => {
    const required = firstSourceLeaseNamed();
    for (const missing of required) {
      expect(reportFailures(required, contractReport(required.filter(item => item.id !== missing.id)), root), missing.id).toHaveLength(1);
      for (const status of ["failed", "skipped", "pending", "todo", "unknown"]) {
        const report = contractReport(required);
        report.testResults[0].assertionResults.find(item => item.title === missing.test)!.status = status;
        expect(reportFailures(required, report, root).length, `${missing.id}: ${status}`).toBeGreaterThan(0);
      }
      for (const suite of [
        firstSourceLeaseSuite.replace("[postgres]", "[pglite]"),
        firstSourceLeaseSuite.replace("[postgres]", "['postgres\"]"),
        firstSourceLeaseSuite.replace("[postgres]", "[\"postgres']"),
        "modeled first source worker lease binding [postgres]",
      ]) {
        const report = contractReport(required);
        report.testResults[0].assertionResults.find(item => item.title === missing.test)!.ancestorTitles = [suite];
        expect(reportFailures(required, report, root), `${missing.id}: ${suite}`).toHaveLength(1);
      }
      const malformed = contractReport(required);
      malformed.testResults[0].assertionResults.find(item => item.title === missing.test)!.fullName = "";
      expect(reportFailures(required, malformed, root), missing.id).toEqual(["Malformed Vitest assertion evidence"]);
      const renamed = contractReport(required);
      renamed.testResults[0].assertionResults.find(item => item.title === missing.test)!.title = "a different modeled acquisition";
      expect(reportFailures(required, renamed, root), missing.id).toHaveLength(1);
    }
  });

  it("accepts complete quoted PostgreSQL ancestry for every exact native case", () => {
    const required = firstSourceLeaseNamed();
    for (const label of ["['postgres']", '["postgres"]', "[ 'postgres' ]"]) {
      const report = contractReport(required);
      for (const assertion of report.testResults[0].assertionResults)
        assertion.ancestorTitles = [firstSourceLeaseSuite.replace("[postgres]", label)];
      expect(reportFailures(required, report, root), label).toEqual([]);
    }
  });

  it("retains every static case and ID after the native source file is deleted", () => {
    const sourceRoot = modelRoot(path.join(scratch, "deleted-first-source-lease-"));
    for (const directory of ["tests/controlplane", "tests/capabilities", "tests/reconcile"]) fs.mkdirSync(path.join(sourceRoot, directory), { recursive: true });
    fs.copyFileSync(path.join(root, firstSourceLeaseFile), path.join(sourceRoot, firstSourceLeaseFile));
    const before = firstSourceLeaseNamed(sourceRoot);
    fs.unlinkSync(path.join(sourceRoot, firstSourceLeaseFile));
    expect(firstSourceLeaseNamed(sourceRoot)).toEqual(before);
    expect(before).toEqual(firstSourceLeaseNamed());
    expect(reportFailures(before, { success: true, testResults: [] }, sourceRoot)).toHaveLength(24);
  });

  it("refuses zero, malformed, duplicate, suite-only and inconsistent reports without caller-defined requirements", () => {
    const required = firstSourceLeaseNamed();
    for (const report of [null, {}, { success: true }, { success: true, testResults: [] }, { success: false, testResults: [] }])
      expect(reportFailures(required, report, root).length).toBeGreaterThan(0);
    expect(reportFailures([], contractReport(required), root)).toEqual(["No required scenarios found"]);
    const suiteOnly = contractReport(required);
    suiteOnly.testResults[0].assertionResults = [{ title: "one lease model", fullName: "one lease model", ancestorTitles: [firstSourceLeaseSuite], status: "passed" }];
    expect(reportFailures(required, suiteOnly, root)).toHaveLength(24);
    const duplicate = contractReport(required);
    duplicate.testResults.push(duplicate.testResults[0]);
    expect(reportFailures(required, duplicate, root)).toEqual(["Duplicate Vitest file evidence"]);
    const valid = contractReport(required);
    const malformed = { ...valid, testResults: [{ ...valid.testResults[0], assertionResults: [
      { ...valid.testResults[0].assertionResults[0], ancestorTitles: [1] },
    ] }] };
    expect(reportFailures(required, malformed, root)).toEqual(["Malformed Vitest assertion evidence"]);
    expect(reportFailures(required, { ...contractReport(required), numTotalTests: 0 }, root)).toEqual(["Inconsistent Vitest report counts"]);
    expect(reportFailures(required, { ...contractReport(required), numFailedTests: 1 }, root)).toEqual(["Inconsistent Vitest report counts"]);
    expect(reportFailures(required, { ...contractReport([]), requirements: [], lane: "platform-postgres" }, root)).toHaveLength(24);
  });
});

describe("mandatory tenant-qualified execution lease gates", () => {
  it("retains all 617 prior identities and adds seven source-bound native cases without another discovered suite", () => {
    const manifest = manifestFor("platform-postgres", root);
    const required = executionLeaseTenantNamed();
    const ids = new Set(required.map(item => item.id));
    const prior = priorPlanProductPlatformRequirements().filter(item => !ids.has(item.id));
    expect(prior).toHaveLength(617);
    expect(createHash("sha256").update(JSON.stringify(prior.map(item => item.id).sort())).digest("hex"))
      .toBe("b6ce5d5bdbedfc582d0d2803283f51805940fe8905a78c72d875d1a6ec2268ad");
    expect(required).toHaveLength(7);
    expect(createHash("sha256").update(JSON.stringify(required.map(item => item.test))).digest("hex"))
      .toBe("d0d3da80b31794395579ce9060bd1e1f76c3fe934bd4283183693dd792374e6b");
    expect(declaredLiteralTests(firstSourceLeaseFile))
      .toEqual([...firstSourceLeaseNamed(), ...required].map(item => item.test));
    expect(priorPlanProductPlatformRequirements()).toHaveLength(624);
    expect(new Set(priorPlanProductPlatformRequirements().map(item => item.id)).size).toBe(624);
    expect(manifest.requirements.filter(item => item.file === firstSourceLeaseFile && item.test === undefined))
      .toEqual([expect.objectContaining({ suite: firstSourceLeaseSuite, backend: "postgres" })]);
    expect(manifest.env.ZENITH_TEST_FIRST_SOURCE_LEASE_REQUIRED).toBe("1");
    expect(manifest.prerequisites).toContain("ZENITH_TEST_FIRST_SOURCE_LEASE_REQUIRED=1; first worker lease binding requires actual PostgreSQL, canonical schema13 and independent native connections");
    for (const item of required) expect(item).toMatchObject({ file: firstSourceLeaseFile, suite: firstSourceLeaseSuite, postgres: true });
    expect(reportFailures(required, contractReport(required), root)).toEqual([]);
  });

  it("rejects each absent, failed, skipped, malformed or substituted tenant-scope assertion", () => {
    const required = executionLeaseTenantNamed();
    for (const missing of required) {
      expect(reportFailures(required, contractReport(required.filter(item => item.id !== missing.id)), root), missing.id).toHaveLength(1);
      for (const status of ["failed", "skipped", "pending", "todo", "unknown"]) {
        const report = contractReport(required);
        report.testResults[0].assertionResults.find(item => item.title === missing.test)!.status = status;
        expect(reportFailures(required, report, root).length, `${missing.id}: ${status}`).toBeGreaterThan(0);
      }
      for (const suite of [firstSourceLeaseSuite.replace("postgres", "pglite"), firstSourceLeaseSuite.replace("postgres", "postgres-replica"), "other lease scope [postgres]", "first source worker lease binding ['postgres\"]"]) {
        const report = contractReport(required);
        report.testResults[0].assertionResults.find(item => item.title === missing.test)!.ancestorTitles = [suite];
        expect(reportFailures(required, report, root)).toHaveLength(1);
      }
      const renamed = contractReport(required);
      renamed.testResults[0].assertionResults.find(item => item.title === missing.test)!.title = "a passing lease model";
      expect(reportFailures(required, renamed, root)).toHaveLength(1);
      const malformed = contractReport(required);
      malformed.testResults[0].assertionResults.find(item => item.title === missing.test)!.fullName = "";
      expect(reportFailures(required, malformed, root)).toEqual(["Malformed Vitest assertion evidence"]);
    }
    const foreign = contractReport(required);
    foreign.testResults[0].name = path.resolve(root, "tests/controlplane/leases.test.ts");
    expect(reportFailures(required, foreign, root)).toHaveLength(7);
  });

  it("retains all seven declared scenarios after source deletion and refuses empty native evidence", () => {
    const sourceRoot = modelRoot(path.join(scratch, "deleted-tenant-lease-"));
    for (const directory of ["tests/controlplane", "tests/capabilities", "tests/reconcile"])
      fs.mkdirSync(path.join(sourceRoot, directory), { recursive: true });
    fs.copyFileSync(path.join(root, firstSourceLeaseFile), path.join(sourceRoot, firstSourceLeaseFile));
    const before = executionLeaseTenantNamed(sourceRoot);
    fs.unlinkSync(path.join(sourceRoot, firstSourceLeaseFile));
    expect(executionLeaseTenantNamed(sourceRoot)).toEqual(before);
    expect(before).toEqual(executionLeaseTenantNamed());
    expect(reportFailures(before, { success: true, testResults: [] }, sourceRoot)).toHaveLength(7);
  });

  it("refuses zero, malformed, duplicate, suite-only and inconsistent tenant-scope reports", () => {
    const required = executionLeaseTenantNamed();
    for (const report of [null, {}, { success: true }, { success: true, testResults: [] }, { success: false, testResults: [] }])
      expect(reportFailures(required, report, root).length).toBeGreaterThan(0);
    expect(reportFailures([], contractReport(required), root)).toEqual(["No required scenarios found"]);
    const suiteOnly = contractReport(required);
    suiteOnly.testResults[0].assertionResults = [{ title: "one lease model", fullName: "one lease model", ancestorTitles: [firstSourceLeaseSuite], status: "passed" }];
    expect(reportFailures(required, suiteOnly, root)).toHaveLength(7);
    const duplicate = contractReport(required); duplicate.testResults.push(duplicate.testResults[0]);
    expect(reportFailures(required, duplicate, root)).toEqual(["Duplicate Vitest file evidence"]);
    const valid = contractReport(required);
    const malformed = { ...valid, testResults: [{ ...valid.testResults[0], assertionResults: [{ ...valid.testResults[0].assertionResults[0], ancestorTitles: [1] }] }] };
    expect(reportFailures(required, malformed, root)).toEqual(["Malformed Vitest assertion evidence"]);
    expect(reportFailures(required, { ...contractReport(required), numTotalTests: 0 }, root)).toEqual(["Inconsistent Vitest report counts"]);
    expect(reportFailures(required, { ...contractReport(required), numFailedTests: 1 }, root)).toEqual(["Inconsistent Vitest report counts"]);
  });
});

describe("mandatory G2 native admission and read-only readiness gates", () => {
  it("retains all 454 prior identities and adds exactly 71 named cases and two discovered native suites", () => {
    const manifest = manifestFor("platform-postgres", root);
    const prior = priorG2PlatformRequirements();
    expect(prior).toHaveLength(454);
    expect(createHash("sha256").update(JSON.stringify(prior.map(item => item.id).sort())).digest("hex"))
      .toBe("6d635d7ea4d84b23d03b2b9221bbf3533625fc1c4b05f5624cb198bd5be520b4");
    expect(g2NativeNamed()).toHaveLength(71);
    expect(priorPlanProductPlatformRequirements()).toHaveLength(624);
    expect(new Set(priorPlanProductPlatformRequirements().map(item => item.id)).size).toBe(624);
    const discovered = manifest.requirements.filter(item => item.test === undefined
      && ["tests/controlplane/mcp-deploy-admission.test.ts", "tests/controlplane/opened-handle-ownership.test.ts"].includes(item.file));
    expect(discovered).toEqual([
      expect.objectContaining({ file: "tests/controlplane/mcp-deploy-admission.test.ts", suite: g2NativeGroups[0].suite, backend: "postgres" }),
      expect.objectContaining({ file: "tests/controlplane/opened-handle-ownership.test.ts", suite: g2NativeGroups[2].suite, backend: "postgres" }),
    ]);
    expect(manifest.excludeFiles).toEqual([]);
    expect(manifest.command).not.toContain("--passWithNoTests");
    expect(manifest.tools).toMatchObject({ node: "22.23.3", postgres: "16.15", tofu: "1.12.5" });
    for (const group of g2NativeGroups) {
      expect(manifest.env[group.flag]).toBe("1");
      expect(manifest.command.some(argument => argument === group.file || group.file.startsWith(`${argument}/`))).toBe(true);
      expect(manifest.excludeFiles).not.toContain(group.file);
    }
    for (const prerequisite of [
      "ZENITH_TEST_MCP_DEPLOY_ADMISSION_REQUIRED=1; durable MCP admission requires actual PostgreSQL, canonical schema13 and independent native connections; product protocols remain modeled",
      "ZENITH_TEST_DEFAULT_CURRENT_MEMBERSHIP_REQUIRED=1; current OAuth integration membership requires actual PostgreSQL and uncached modeled product reads",
      "ZENITH_TEST_OPENED_HANDLE_REQUIRED=1; opener ownership requires physical openPlatformDb PostgreSQL handles and canonical schema13",
      "ZENITH_TEST_AWS_PREFLIGHT_REQUIRED=1; default AWS readiness admission requires actual PostgreSQL, canonical schema13 and genuine native owners; cloud commands remain modeled",
    ]) expect(manifest.prerequisites).toContain(prerequisite);
    expect(reportFailures(g2NativeNamed(), contractReport(g2NativeNamed()), root)).toEqual([]);
  });

  it.each(g2NativeGroups)("$label binds every exact committed native source identity", group => {
    const required = g2NativeGroup(group);
    const names = required.map(item => item.test);
    expect(required).toHaveLength(group.count);
    expect(new Set(required.map(item => item.id)).size).toBe(group.count);
    expect(names).toEqual(declaredLiteralTests(group.file, group.suite).slice(group.offset));
    expect(createHash("sha256").update(JSON.stringify(names)).digest("hex")).toBe(group.sha256);
    if (group.linesSha256)
      expect(createHash("sha256").update(names.join("\n") + "\n").digest("hex")).toBe(group.linesSha256);
    if (group.offset > 0) {
      const prior = namedOperationGroups.find(item => item.file === membershipFile)!;
      expect(declaredLiteralTests(group.file, group.suite).slice(0, group.offset)).toEqual(namedGroup(prior).map(item => item.test));
    }
    for (const item of required) {
      expect(item).toMatchObject({ file: group.file, suite: group.suite });
      expect(item.postgres === true || item.backend === "postgres").toBe(true);
    }
    const source = fs.readFileSync(path.join(root, group.file), "utf8");
    expect(source).toContain(group.flag);
    expect(source).toContain("PG_URL");
    if (group.file === membershipFile) {
      expect(source).toContain('makeHarness({ kind: "postgres" })');
      expect(fs.readFileSync(path.join(root, "tests/capabilities/support.ts"), "utf8")).toContain("openPlatformDb");
    } else expect(source).toContain("openPlatformDb");
    expect(reportFailures(required, contractReport(required), root)).toEqual([]);
  });

  it("pins the complete accepted MCP identity contract including its required flags and modeled scope", () => {
    const identities = MCP_DURABLE_ADMISSION_POSTGRES_REQUIREMENTS.map(item => ({
      file: item.file, suite: item.suite, name: item.test, backend: item.backend,
      requiredFlag: item.file === membershipFile ? "ZENITH_TEST_DEFAULT_CURRENT_MEMBERSHIP_REQUIRED=1" : "ZENITH_TEST_MCP_DEPLOY_ADMISSION_REQUIRED=1",
    }));
    expect(createHash("sha256").update(JSON.stringify(identities)).digest("hex"))
      .toBe("794eeb7b2cba67ca7f7ce1b74a3504ace8c80277c9b6f4322b595dd5fa4c0162");
  });

  it.each(g2NativeGroups)("$label rejects every absent, nonpassing, substituted or foreign-source assertion", group => {
    const required = g2NativeGroup(group);
    for (const missing of required) {
      expect(reportFailures(required, contractReport(required.filter(item => item.id !== missing.id)), root), missing.id).toHaveLength(1);
      for (const status of ["failed", "skipped", "pending", "todo", "unknown"]) {
        const report = contractReport(required);
        report.testResults[0].assertionResults.find(item => item.title === missing.test)!.status = status;
        expect(reportFailures(required, report, root).length, `${missing.id}: ${status}`).toBeGreaterThan(0);
      }
      for (const suite of [
        group.suite!.replace("postgres", "pglite"), group.suite!.replace("postgres", "postgres-replica"),
        group.suite!.replace("[postgres", "['postgres\""), group.suite!.replace("[postgres", '["postgres\''),
        `modeled substitute ${group.suite}`, `${group.suite} with a different scope`,
      ]) {
        const report = contractReport(required);
        report.testResults[0].assertionResults.find(item => item.title === missing.test)!.ancestorTitles = [suite];
        expect(reportFailures(required, report, root), `${missing.id}: ${suite}`).toHaveLength(1);
      }
      const malformed = contractReport(required);
      malformed.testResults[0].assertionResults.find(item => item.title === missing.test)!.fullName = "";
      expect(reportFailures(required, malformed, root)).toEqual(["Malformed Vitest assertion evidence"]);
      const renamed = contractReport(required);
      renamed.testResults[0].assertionResults.find(item => item.title === missing.test)!.title = "a passing modeled sibling";
      expect(reportFailures(required, renamed, root)).toHaveLength(1);
    }
    const foreign = contractReport(required);
    foreign.testResults[0].name = path.resolve(root, "tests/execution/aws-bootstrap-preflight.test.ts");
    expect(reportFailures(required, foreign, root)).toHaveLength(group.count);
  });

  it.each(g2NativeGroups)("$label accepts only correctly quoted complete native suite labels", group => {
    const required = g2NativeGroup(group);
    for (const quote of ["'", '"']) {
      const suite = group.suite!.replace(/\[([^\]]+)\]/, (_all, value: string) => `[${quote}${value}${quote}]`);
      const report = contractReport(required);
      for (const assertion of report.testResults[0].assertionResults) {
        assertion.ancestorTitles = [suite]; assertion.fullName = `${suite} ${assertion.title}`;
      }
      expect(reportFailures(required, report, root), suite).toEqual([]);
    }
  });

  it.each(g2NativeGroups)("deleting $file retains every named native identity and refuses empty evidence", group => {
    const sourceRoot = modelRoot(path.join(scratch, "deleted-g2-native-"));
    for (const directory of ["tests/controlplane", "tests/capabilities", "tests/reconcile", "tests/platform"])
      fs.mkdirSync(path.join(sourceRoot, directory), { recursive: true });
    for (const item of g2NativeGroups) fs.copyFileSync(path.join(root, item.file), path.join(sourceRoot, item.file));
    const before = g2NativeNamed(sourceRoot);
    fs.unlinkSync(path.join(sourceRoot, group.file));
    expect(g2NativeNamed(sourceRoot)).toEqual(before);
    expect(before).toEqual(g2NativeNamed());
    expect(reportFailures(before, { success: true, testResults: [] }, sourceRoot)).toHaveLength(71);
  });

  it("refuses zero, malformed, duplicate, suite-only and inconsistent G2 reports without report-defined requirements", () => {
    const required = g2NativeNamed();
    for (const report of [null, {}, { success: true }, { success: true, testResults: [] }, { success: false, testResults: [] }])
      expect(reportFailures(required, report, root).length).toBeGreaterThan(0);
    expect(reportFailures([], contractReport(required), root)).toEqual(["No required scenarios found"]);
    const suiteOnly = contractReport(required);
    for (const file of suiteOnly.testResults) file.assertionResults = [{ title: "one read-only model", fullName: "one read-only model", ancestorTitles: ["native model [postgres]"], status: "passed" }];
    expect(reportFailures(required, suiteOnly, root)).toHaveLength(71);
    const duplicate = contractReport(required); duplicate.testResults.push(duplicate.testResults[0]);
    expect(reportFailures(required, duplicate, root)).toEqual(["Duplicate Vitest file evidence"]);
    const valid = contractReport(required);
    const malformed = { ...valid, testResults: [{ ...valid.testResults[0], assertionResults: [
      { ...valid.testResults[0].assertionResults[0], ancestorTitles: [1] },
    ] }] };
    expect(reportFailures(required, malformed, root)).toEqual(["Malformed Vitest assertion evidence"]);
    expect(reportFailures(required, { ...contractReport(required), numTotalTests: 0 }, root)).toEqual(["Inconsistent Vitest report counts"]);
    expect(reportFailures(required, { ...contractReport(required), numFailedTests: 1 }, root)).toEqual(["Inconsistent Vitest report counts"]);
    expect(reportFailures(required, { ...contractReport([]), requirements: [], lane: "platform-postgres" }, root)).toHaveLength(71);
  });
});

describe("mandatory final MCP source authority and SDK protocol gates", () => {
  it("retains all prior 527 identities and adds exactly 72 native, 17 SDK and one discovered native suite", () => {
    const manifest = manifestFor("platform-postgres", root);
    const added = new Set([...finalMcpNamed(), ...executionLeaseTenantNamed()].map(item => item.id));
    const prior = priorPlanProductPlatformRequirements().filter(item => !added.has(item.id) && !(item.file === finalMcpFile && item.test === undefined));
    expect(prior).toHaveLength(527);
    expect(createHash("sha256").update(JSON.stringify(prior.map(item => item.id).sort())).digest("hex"))
      .toBe("23f4e7cdf2dcbd836fa21be07493074a0d185448390eb7b0092e123090142148");
    expect(finalMcpNamed()).toHaveLength(89);
    expect(priorPlanProductPlatformRequirements()).toHaveLength(624);
    expect(new Set(priorPlanProductPlatformRequirements().map(item => item.id)).size).toBe(624);
    expect(manifest.requirements.filter(item => item.file === finalMcpFile && item.test === undefined))
      .toEqual([expect.objectContaining({ suite: finalMcpGroups[0].suite, backend: "postgres" })]);
    expect(manifest.env.ZENITH_TEST_MCP_START_SOURCE_AUTHORITY_REQUIRED).toBe("1");
    expect(manifest.command).toContain("tests/controlplane");
    expect(manifest.excludeFiles).toEqual([]);
    expect(manifest.command).not.toContain("--passWithNoTests");
    expect(manifest.prerequisites).toContain("ZENITH_TEST_MCP_START_SOURCE_AUTHORITY_REQUIRED=1; final MCP source/product/member authority requires actual PostgreSQL, canonical schema13 and independent native connections; hosted protocols remain modeled");
    expect(manifest.prerequisites).toContain("Locked Supabase SDK constructor/protocol controls require exact source and suite; they supply no PostgreSQL, hosted-network or TLS-handshake proof");
    const source = fs.readFileSync(path.join(root, finalMcpFile), "utf8");
    const firstHook = source.indexOf("beforeAll(");
    for (const guard of [
      'const required = process.env.ZENITH_TEST_MCP_START_SOURCE_AUTHORITY_REQUIRED === "1";',
      'if (required && !PG_URL) throw new Error("MCP final start source authority requires an explicitly owned PostgreSQL database.");',
      'if (required && PLATFORM_SCHEMA_VERSION < 13) throw new Error("MCP final start source authority requires canonical schema13.");',
    ]) {
      expect(source).toContain(guard);
      expect(source.indexOf(guard)).toBeLessThan(firstHook);
    }
    expect(source).toContain('await openPlatformDb({ kind: "postgres", url: PG_URL!, migrate: true, max: 1 })');
    expect(source).toContain('await openPlatformDb({ kind: "postgres", url: PG_URL!, migrate: false, max: 1 })');
    expect(reportFailures(finalMcpNamed(), contractReport(finalMcpNamed()), root)).toEqual([]);
  });

  it.each(finalMcpGroups)("$label pins every ordered literal source declaration and distinct evidence scope", group => {
    const required = finalMcpGroup(group);
    expect(required).toHaveLength(group.count);
    const names = required.map(item => item.test);
    expect(names).toEqual(declaredLiteralTests(group.file, group.suite, group.untilSuite));
    expect(createHash("sha256").update(JSON.stringify(names)).digest("hex")).toBe(group.sha256);
    for (const item of required) {
      expect(item).toMatchObject({ file: group.file, suite: group.suite });
      if (group.native) expect(item.backend).toBe("postgres");
      else {
        expect(item).not.toHaveProperty("postgres");
        expect(item).not.toHaveProperty("backend");
      }
    }
    expect(reportFailures(required, contractReport(required), root)).toEqual([]);
  });

  it.each(finalMcpGroups)("$label rejects each missing, nonpassing, malformed, substituted and foreign assertion", group => {
    const required = finalMcpGroup(group);
    for (const missing of required) {
      expect(reportFailures(required, contractReport(required.filter(item => item.id !== missing.id)), root), missing.id).toHaveLength(1);
      for (const status of ["failed", "skipped", "pending", "todo", "unknown"]) {
        const report = contractReport(required);
        report.testResults[0].assertionResults.find(item => item.title === missing.test)!.status = status;
        expect(reportFailures(required, report, root).length, `${missing.id}: ${status}`).toBeGreaterThan(0);
      }
      for (const suite of [
        group.native ? finalMcpGroups[1].suite! : finalMcpGroups[0].suite!,
        group.suite!.replace("postgres", "pglite"), group.suite!.replace("postgres", "postgres-replica"),
        group.suite!.replace("[postgres", "['postgres\""), group.suite!.replace("[postgres", '["postgres\''),
        `modeled substitute ${group.suite}`, `${group.suite} with a different scope`,
      ].filter(suite => suite !== group.suite)) {
        const report = contractReport(required);
        report.testResults[0].assertionResults.find(item => item.title === missing.test)!.ancestorTitles = [suite];
        expect(reportFailures(required, report, root), `${missing.id}: ${suite}`).toHaveLength(1);
      }
      const malformed = contractReport(required);
      malformed.testResults[0].assertionResults.find(item => item.title === missing.test)!.fullName = "";
      expect(reportFailures(required, malformed, root)).toEqual(["Malformed Vitest assertion evidence"]);
      const renamed = contractReport(required);
      renamed.testResults[0].assertionResults.find(item => item.title === missing.test)!.title = "a passing modeled sibling";
      expect(reportFailures(required, renamed, root)).toHaveLength(1);
    }
    const foreign = contractReport(required);
    foreign.testResults[0].name = path.resolve(root, "tests/controlplane/mcp-deploy-admission.test.ts");
    expect(reportFailures(required, foreign, root)).toHaveLength(group.count);
  });

  it("accepts complete correctly quoted PostgreSQL labels without borrowing SDK protocol scope", () => {
    const required = finalMcpGroup(finalMcpGroups[0]);
    for (const quote of ["'", '"']) {
      const suite = finalMcpGroups[0].suite!.replace(/\[([^\]]+)\]/, (_all, value: string) => `[${quote}${value}${quote}]`);
      const report = contractReport(required);
      for (const assertion of report.testResults[0].assertionResults) {
        assertion.ancestorTitles = [suite]; assertion.fullName = `${suite} ${assertion.title}`;
      }
      expect(reportFailures(required, report, root), suite).toEqual([]);
    }
  });

  it("retains all 89 literal requirements when the final MCP source file is absent and refuses empty evidence", () => {
    const sourceRoot = modelRoot(path.join(scratch, "deleted-final-mcp-"));
    for (const directory of ["tests/controlplane", "tests/capabilities", "tests/reconcile"])
      fs.mkdirSync(path.join(sourceRoot, directory), { recursive: true });
    fs.copyFileSync(path.join(root, finalMcpFile), path.join(sourceRoot, finalMcpFile));
    const before = finalMcpNamed(sourceRoot);
    fs.unlinkSync(path.join(sourceRoot, finalMcpFile));
    expect(finalMcpNamed(sourceRoot)).toEqual(before);
    expect(before).toEqual(finalMcpNamed());
    expect(reportFailures(before, { success: true, testResults: [] }, sourceRoot)).toHaveLength(89);
  });

  it("refuses zero, malformed, duplicate, suite-only and inconsistent final MCP reports", () => {
    const required = finalMcpNamed();
    for (const report of [null, {}, { success: true }, { success: true, testResults: [] }, { success: false, testResults: [] }])
      expect(reportFailures(required, report, root).length).toBeGreaterThan(0);
    expect(reportFailures([], contractReport(required), root)).toEqual(["No required scenarios found"]);
    const suiteOnly = contractReport(required);
    suiteOnly.testResults[0].assertionResults = [{ title: "one source model", fullName: "one source model", ancestorTitles: [finalMcpGroups[0].suite!], status: "passed" }];
    expect(reportFailures(required, suiteOnly, root)).toHaveLength(89);
    const duplicate = contractReport(required); duplicate.testResults.push(duplicate.testResults[0]);
    expect(reportFailures(required, duplicate, root)).toEqual(["Duplicate Vitest file evidence"]);
    const valid = contractReport(required);
    const malformed = { ...valid, testResults: [{ ...valid.testResults[0], assertionResults: [{ ...valid.testResults[0].assertionResults[0], ancestorTitles: [1] }] }] };
    expect(reportFailures(required, malformed, root)).toEqual(["Malformed Vitest assertion evidence"]);
    expect(reportFailures(required, { ...contractReport(required), numTotalTests: 0 }, root)).toEqual(["Inconsistent Vitest report counts"]);
    expect(reportFailures(required, { ...contractReport(required), numFailedTests: 1 }, root)).toEqual(["Inconsistent Vitest report counts"]);
    expect(reportFailures(required, { ...contractReport([]), requirements: [], lane: "platform-postgres" }, root)).toHaveLength(89);
  });
});

describe("mandatory ECS replica repair gates", () => {
  it("executes both adapter contracts explicitly and pins all four focal files without duplicate requirements", () => {
    const workflow = manifestFor("workflows", root);
    for (const file of ecsFiles.slice(0, 2)) expect(workflow.command).toContain(file);
    for (const file of ecsFiles) {
      expect(workflow.requirements.filter((required) => required.file === file)).toHaveLength(file === ecsFiles[0] ? 3 : 1);
    }
    expect(manifestFor("platform-postgres", root).command).toContain(ecsGrantFile);
    expect(ecsPostgresRequirements().map((required) => required.suite)).toEqual(ecsPostgresSuites);
    for (const required of ecsPostgresRequirements()) {
      expect(required).toMatchObject({ ancestorSuite: "replica repair authority [postgres]", postgres: true });
    }
  });

  it("preserves suite-only PostgreSQL requirement IDs and binds case IDs to exact ancestry and titles", () => {
    for (const required of requirementsFor("platform-postgres", root).filter((item) => item.file !== ecsGrantFile)) {
      const identity = `${required.suite ?? ""}:${required.postgres ?? false}${required.ancestorSuite !== undefined ? `:${required.ancestorSuite}` : ""}${required.test ? `:test:${required.test}` : ""}`;
      const suffix = createHash("sha256").update(identity).digest("hex").slice(0, 12);
      expect(required.id).toBe(`platform-postgres:${required.file}:${suffix}`);
      if (required.test) expect(requirementId("platform-postgres", { ...required, test: "other case" })).not.toBe(required.id);
    }
    const required = ecsPostgresRequirements()[0];
    expect(requirementId("platform-postgres", { ...required, ancestorSuite: "other [postgres]" })).not.toBe(required.id);
    expect(assertionMatches({ ...required, postgres: true, ancestorSuite: "replica repair authority [pglite]" }, {
      fullName: "scenario", ancestorTitles: ["replica repair authority [pglite]", required.suite ?? ""],
    })).toBe(false);
  });

  it.each(["[postgres]", "['postgres']", '["postgres"]', "[ 'postgres' ]"])("accepts all six behaviors with genuine complete outer %s labels", (label) => {
    expect(reportFailures(ecsPostgresRequirements(), ecsGrantReport(`replica repair authority ${label}`), root)).toEqual([]);
  });

  it.each(["pglite", "failed", "skipped", "malformed"])("rejects %s grant evidence despite passing sibling behaviors", (failure) => {
    const report = ecsGrantReport();
    const assertion = report.testResults[0].assertionResults[0];
    if (failure === "pglite") assertion.ancestorTitles[0] = "replica repair authority [pglite]";
    else if (failure === "malformed") assertion.fullName = "";
    else assertion.status = failure;
    expect(reportFailures(ecsPostgresRequirements(), report, root).length).toBeGreaterThan(0);
  });

  it.each(ecsPostgresSuites)("requires the %s behavior independently", (missing) => {
    const report = ecsGrantReport();
    report.testResults[0].assertionResults = report.testResults[0].assertionResults.filter((assertion) => assertion.ancestorTitles[1] !== missing);
    expect(reportFailures(ecsPostgresRequirements(), report, root)).toHaveLength(1);
  });

  it.each(["other repair authority [postgres]", "replica repair authority ['postgres\"]", "replica repair authority [postgres-replica]", "replica repair authority [pglite]"])("rejects wrong or malformed outer %s even with a postgres test title", (outer) => {
    const report = ecsGrantReport(outer);
    for (const assertion of report.testResults[0].assertionResults) assertion.fullName += " mentions [postgres]";
    expect(reportFailures(ecsPostgresRequirements(), report, root)).toHaveLength(6);
  });

  it("rejects matching outer PostgreSQL ancestry when only leaf titles claim the required behavior", () => {
    const report = ecsGrantReport();
    for (const assertion of report.testResults[0].assertionResults) assertion.ancestorTitles = ["replica repair authority [postgres]", "other behavior"];
    expect(reportFailures(ecsPostgresRequirements(), report, root)).toHaveLength(6);
  });

  it.each(ecsFiles)("retains mandatory requirements when trusted source %s is deleted", (deleted) => {
    const sourceRoot = modelRoot(path.join(scratch, "deleted-ecs-"));
    for (const directory of ["tests/workflows", "tests/platform", "tests/controlplane", "tests/capabilities", "tests/reconcile"]) {
      fs.cpSync(path.join(root, directory), path.join(sourceRoot, directory), { recursive: true });
    }
    for (const file of ecsFiles) {
      fs.mkdirSync(path.dirname(path.join(sourceRoot, file)), { recursive: true });
      fs.copyFileSync(path.join(root, file), path.join(sourceRoot, file));
    }
    const beforeWorkflows = requirementsFor("workflows", sourceRoot);
    const beforePostgres = requirementsFor("platform-postgres", sourceRoot);
    fs.unlinkSync(path.join(sourceRoot, deleted));
    const workflows = requirementsFor("workflows", sourceRoot);
    const postgres = requirementsFor("platform-postgres", sourceRoot);
    expect(workflows).toEqual(beforeWorkflows);
    expect(postgres).toEqual(beforePostgres);
    const required = workflows.filter((item) => item.file === deleted);
    expect(required.length).toBeGreaterThan(0);
    expect(reportFailures(required, { success: true, testResults: [] }, sourceRoot)).toHaveLength(required.length);
    if (deleted === ecsGrantFile) {
      const sql = postgres.filter((item) => item.file === ecsGrantFile);
      expect(sql).toHaveLength(6);
      expect(reportFailures(sql, { success: true, testResults: [] }, sourceRoot)).toHaveLength(6);
    }
  });
});

describe("stable backend ancestry", () => {
  // A raw native report observes two quoted suites; all seven share Vitest's $name formatter.
  const quotedNativeGroups = [
    ["tests/effects/build-launch.test.ts", "build launch effects (postgres)", "66558e46614c"],
    ["tests/effects/cleanup.test.ts", "cleanup effect helpers (postgres)", "56d57a2f04e0"],
    ["tests/effects/ledger.test.ts", "external effect ledger (postgres)", "5b8ae9d0841b"],
    ["tests/effects/provider-resolvers.test.ts", "lost non-AWS launch to confirmed adoption (postgres)", "ae6277c04b4b"],
    ["tests/effects/proxy.test.ts", "runProxyJob on the control store (postgres)", "71ecab8d34b4"],
    ["tests/effects/resolvers.test.ts", "runReadback on the control store (postgres)", "514f933542c5"],
    ["tests/coding-agent/store.test.ts", "coding_agent_runs on postgres", "a2b7923f32dd"],
  ];

  it.each(quotedNativeGroups)("binds the unchanged native requirement for %s to complete quoted backend ancestry", (file, suite, suffix) => {
    const required = requirementsFor("platform-postgres", root).filter((item) => item.file === file && item.suite === suite);
    expect(required).toHaveLength(1);
    expect(required[0].id).toBe(`platform-postgres:${file}:${suffix}`);
    expect(required[0].postgres).toBe(true);
    const report = (ancestor: string, status = "passed") => ({ success: true, testResults: [{
      name: path.resolve(root, file), status: "passed", assertionResults: [{
        fullName: ancestor + " native scenario", ancestorTitles: [ancestor], title: "native scenario", status,
      }],
    }] });
    for (const quote of ["'", '"']) {
      const ancestor = suite.replace("postgres", quote + "postgres" + quote);
      expect(canonicalSuite(ancestor)).toBe(suite);
      expect(reportFailures(required, report(ancestor), root)).toEqual([]);
      for (const status of ["failed", "skipped", "pending", "todo", "unknown"]) {
        expect(reportFailures(required, report(ancestor, status), root)).toHaveLength(1);
      }
      expect(reportFailures(required, report(ancestor.replace("postgres", "pglite")), root)).toHaveLength(1);
    }
    for (const token of ["'postgres\"", "postgres-replica", "'Postgres'", "'memory'", "'postgres' trailing"]) {
      expect(reportFailures(required, report(suite.replace("postgres", token)), root)).toHaveLength(1);
    }
    const titleOnly = report(suite.replace("postgres", "pglite"));
    titleOnly.testResults[0].assertionResults[0].fullName = suite + " native scenario";
    titleOnly.testResults[0].assertionResults[0].title = suite;
    expect(reportFailures(required, titleOnly, root)).toHaveLength(1);
    expect(reportFailures(required, { success: true, testResults: [] }, root)).toHaveLength(1);
    expect(reportFailures(required, { success: true, testResults: [{ name: path.resolve(root, file), status: "passed", assertionResults: [] }] }, root)).toHaveLength(1);
  });

  it.each(["[postgres]", "['postgres']", '["postgres"]', "[ 'postgres' ]"])("accepts complete %s suite labels", (label) => {
    const assertion = { fullName: `leases ${label} passed`, ancestorTitles: ["leases " + label], status: "passed" };
    expect(assertionMatches({ suite: "leases [postgres]", postgres: true }, assertion)).toBe(true);
    expect(canonicalSuite("leases " + label)).toBe("leases [postgres]");
  });

  it.each(["['postgres\"]", "[postgres-replica]", "['pglite']", "[memory]"])("rejects %s and does not trust a postgres mention in a test title", (label) => {
    expect(assertionMatches({ suite: "leases [postgres]", postgres: true }, { fullName: `leases ${label} mentions [postgres]`, ancestorTitles: ["leases " + label] })).toBe(false);
  });

  it("accepts old unstructured backend evidence only if ancestry is unavailable", () => {
    expect(assertionMatches({ postgres: true }, { fullName: "leases ['postgres'] passed" })).toBe(true);
    expect(assertionMatches({ postgres: true }, { fullName: "leases [pglite] mentions [postgres]", ancestorTitles: ["leases [pglite]"] })).toBe(false);
  });

  it("normalizes quoted PostgresAuthority rows by exact ancestor identity", () => {
    for (const suite of ["PostgresAuthority", "'PostgresAuthority'", '"PostgresAuthority"']) {
      expect(assertionMatches({ suite: "PostgresAuthority" }, { fullName: suite + " contract", ancestorTitles: [suite] })).toBe(true);
    }
    expect(assertionMatches({ suite: "PostgresAuthority" }, { fullName: "OtherPostgresAuthority contract", ancestorTitles: ["OtherPostgresAuthority"] })).toBe(false);
  });

  it.each(["skipped", "failed", "pending", "todo", "unknown"])("rejects a %s scenario inside a mixed source file even when all other source suites passed", (status) => {
    const requirements = requirementsFor("workflows", root).filter((required: { file: string }) => required.file === "tests/platform/source-bundle.test.ts");
    const assertions = requirements.map((required) => ({ fullName: required.suite + " scenario", ancestorTitles: [required.suite], status: "passed" }));
    assertions[3].status = status;
    const report = { success: true, testResults: [{ name: path.resolve(root, requirements[0].file), status: "passed", assertionResults: assertions }] };
    expect(reportFailures(requirements, report, root).length).toBeGreaterThan(0);
  });

  it("rejects a missing live source scenario despite passing local source assertions", () => {
    const requirements = requirementsFor("workflows", root).filter((required: { file: string }) => required.file === "tests/platform/source-bundle.test.ts");
    const assertions = requirements.slice(0, 3).map((required) => ({ fullName: required.suite + " scenario", ancestorTitles: [required.suite], status: "passed" }));
    expect(reportFailures(requirements, { success: true, testResults: [{ name: path.resolve(root, requirements[0].file), status: "passed", assertionResults: assertions }] }, root)).toHaveLength(1);
  });
});


describe("canonical native Linux guest contract", () => {
  it("exposes Linux guest through the same manifest without adding a Vitest lane", () => {
    expect(Object.hasOwn(GATE_LANES, "linux-guest")).toBe(false);
    expect(manifestFor("linux-guest")).toEqual(linuxGuestManifest());
    const result = spawnSync(process.execPath, ["scripts/ci/gate-manifest.mjs", "linux-guest"], { encoding: "utf8" });
    expect(result.status).toBe(0); expect(JSON.parse(result.stdout)).toEqual(linuxGuestManifest());
  });
  it("preserves full race, exact authentic golden generation, byte/untracked comparisons and tool pins", () => {
    const manifest = linuxGuestManifest();
    expect(manifest.tools).toEqual({ node: "22.23.3", go: "1.27.1" });
    expect(manifest.env.GOTOOLCHAIN).toBe("local");
    expect(manifest.report).toBe(".data-ci-guest/attempt-{attemptId}/sanitized.json");
    expect(manifest.artifactSelection).toContain("observed CI runner outcome");
    expect(manifest.steps.map((step) => step.command)).toEqual([
      ["go", "test", "-json", "-race", "-count=1", "./...", "-skip", "^(TestPackageHelperNativeNoFollowAndCustody|TestPackageFrontendLockIndependentProcess|TestPackageNativeSignedFirstInstallAndNonReplay|TestPackageNativeDeclaredMountAndACLRefusals|TestSystemdSignedUpdateAndRollback)$"],
      ["python3", "scripts/ci/guest-package-fixtures.py", "--root", "{sourceRoot}", "--attempt", "{attemptId}", "--arch", "{nativeArch}"],
      ["python3", "-B", "scripts/ci/guest-pid1-fixtures.py", "--root", "{sourceRoot}", "--attempt", "{attemptId}", "--arch", "{nativeArch}"],
      ["go", "test", "-json", "-count=1", "./internal/machine/ops", "-run", "^TestResultGoldens$"],
      ["git", "diff", "--exit-code", "--", "internal/machine/testdata/results"],
      ["git", "--no-optional-locks", "status", "--porcelain", "--", "internal/machine/testdata/results"],
    ]);
    expect(priorServiceLinuxCases(manifest.raceCases)).toHaveLength(123); expect(manifest.packagePhase.requiredCases).toHaveLength(4); expect(manifest.pid1Phase.requiredCases).toEqual(LINUX_GUEST_PID1_CASES);
    expect(manifest.requiredCases).toEqual([...manifest.raceCases, ...manifest.packagePhase.requiredCases, ...manifest.pid1Phase.requiredCases]);
    expect(manifest.packagePhase.allowedSkips).toEqual([]); expect(manifest.packagePhase.noTestPackages).toEqual([]);
    expect(manifest.packagePhase.env).toEqual({ ZENITH_TEST_PACKAGE_INSTALL_REQUIRED: "1" });
    expect(new Set(manifest.requiredCases.map((item) => item.id)).size).toBe(manifest.requiredCases.length);
    for (const test of ["TestWriteExactMountAnchorsAndEscapes", "TestWriteConcurrentWritersAndDirectorySwapStress", "TestWriteFaultAndCancelPhases/after_renametrue", "TestWriteCrashCustodyAndRestart/directory_sync", "TestWriteRejectsActualAccessAndDefaultACLs/parent-default", "TestWriteImmutableVersionCannotBeReused/pinned-bytes", "TestResultGoldens/file.write-filesystem"]) {
      expect(manifest.requiredCases.some((item) => item.test === test)).toBe(true);
    }
    expect(manifest.allowedSkips.map((item) => item.test)).toEqual(["TestRealSystemctlAndJournalctl", "TestRealOpenTofuPlanShowApply", "TestRealOpenTofuWithProviderAndLockfile"]);
    expect(manifest.allowedSkips.every((skip) => !manifest.requiredCases.some((item) => item.package === skip.package && item.test === skip.test))).toBe(true);
  });
});


it("CI uploads one exact selected current-attempt file only after independent outcome binding", () => {
  const workflow = fs.readFileSync(path.join(root, ".github/workflows/ci.yml"), "utf8");
  const native = workflow.slice(workflow.indexOf("  go:"), workflow.indexOf("  # The Temporal workflows lane"));
  expect(native).toContain("id: native_guest");
  expect(native).toContain('echo "expected_attempt_id=$attempt_id" >> "$GITHUB_OUTPUT"');
  expect(native).toContain('ZENITH_GUEST_ATTEMPT_ID="$attempt_id" node scripts/ci/run-guest-file-write-gate.mjs --run');
  expect(native).toContain("ZENITH_EXPECTED_GUEST_ATTEMPT: ${{ steps.native_guest.outputs.expected_attempt_id }}");
  expect(native).toContain("ZENITH_GUEST_RUNNER_OUTCOME: ${{ steps.native_guest.outcome }}");
  expect(native).toContain("run: node scripts/ci/run-guest-file-write-gate.mjs --select-current");
  expect(native).toContain("steps.guest_evidence.outcome == 'success' && steps.guest_evidence.outputs.evidence_path != ''");
  expect(native).toContain("path: ${{ steps.guest_evidence.outputs.evidence_path }}");
  expect(native).not.toContain("path: .data-ci-guest/evidence.json");
  expect(native).not.toContain("path: .data-ci-guest/");
});


describe("durable build and source revocation release contracts", () => {
  const files = ["tests/controlplane/build-launches.test.ts", "tests/platform/codebuild-launch-authority.test.ts", "tests/sources/github-store.test.ts", "tests/sources/github-webhook.test.ts"];
  it("requires every build authority case and source lock regression on real PostgreSQL", () => {
    const manifest = manifestFor("platform-postgres", root);
    for (const file of files) expect(manifest.command.some(argument => argument === file || file.startsWith(`${argument}/`)), `${file} executes explicitly or through its directory`).toBe(true);
    expect(manifest.requirements.filter(item => item.file === files[1])).toHaveLength(34);
    expect(manifest.requirements.filter(item => item.file === files[2])).toHaveLength(13);
    expect(manifest.requirements.filter(item => item.file === files[3])).toHaveLength(9);
    expect(manifest.requirements).toContainEqual(expect.objectContaining({ file: "tests/controlplane/tenancy.test.ts", suite: "build launch tenant isolation sweep [postgres]", backend: "postgres" }));
    expect(manifest.requirements).toContainEqual(expect.objectContaining({ file: files[3], test: "serializes webhook revocation with a first-binding transaction holding the same epoch lock", postgres: true }));
    expect(manifest.requirements).toContainEqual(expect.objectContaining({ file: files[3], test: "refuses an actual consumed first binding after signed installation revocation", postgres: true }));
  });
  it("assigns PostgreSQL SDK authority cases to their real database lane while retaining required replay and uncertainty tests", () => {
    const manifest = manifestFor("workflows", root);
    expect(manifest.excludeFiles).toContain(files[1]);
    expect(manifest.requirements.some(item => item.file === files[1])).toBe(false);
    expect(manifest.command).toContain("tests/execution/release.test.ts");
    expect(manifest.requirements.filter(item => item.file === "tests/execution/release.test.ts")).toHaveLength(2);
    expect(manifest.requirements).toContainEqual(expect.objectContaining({ test: "pre-patch build retry history retains its original commands and failed classification on replay" }));
    expect(manifest.requirements).toContainEqual(expect.objectContaining({ test: "pre-patch build cancellation history retains its cancelled outcome on replay" }));
  });
  it.each(["missing", "failed", "pending", "pglite", "malformed", "zero"])("rejects %s current source/build evidence", (mode) => {
    const requirements = requirementsFor("platform-postgres", root).filter(item => files.includes(item.file) && item.test);
    const byFile = new Map<string, typeof requirements>();
    for (const item of requirements) byFile.set(item.file, [...(byFile.get(item.file) ?? []), item]);
    const report = { success: true, testResults: [...byFile].map(([file, items]) => ({ name: path.resolve(root, file), status: "passed", assertionResults: items.map(item => ({ title: item.test!, fullName: `${item.suite} ${item.test}`, ancestorTitles: [item.suite!], status: "passed" })) })) };
    expect(reportFailures(requirements, report, root)).toEqual([]);
    const assertion = report.testResults[0].assertionResults[0];
    if (mode === "missing") report.testResults[0].assertionResults.shift();
    else if (mode === "zero") report.testResults[0].assertionResults = [];
    else if (mode === "pglite") assertion.ancestorTitles = ["build launch authority [pglite]"];
    else if (mode === "malformed") assertion.fullName = "";
    else assertion.status = mode;
    expect(reportFailures(requirements, report, root).length).toBeGreaterThan(0);
  });
});


describe("permanent authenticated agent outcomes", () => {
  const file = "tests/runners/late-effect-receipts.test.ts";
  const requirements = () => requirementsFor("platform-postgres", root).filter(item => item.file === file);
  it("requires both agent domains and every refusal, concurrency and immutable receipt case on PostgreSQL", () => {
    const manifest = manifestFor("platform-postgres", root);
    expect(manifest.command).toContain("tests/runners");
    expect(requirements()).toHaveLength(40);
    for (const kind of ["runner", "machine"]) {
      const cases = requirements().filter(item => item.suite === `${kind} authenticated outcomes`);
      expect(cases).toHaveLength(20);
      expect(cases.every(item => item.postgres && item.ancestorSuite === "agent effect receipts [postgres]")).toBe(true);
      expect(cases.some(item => item.test?.startsWith("refuses valid encrypted outcomes under foreign SQL scope"))).toBe(true);
      expect(cases.some(item => item.test?.startsWith("observes a blocked PostgreSQL result writer"))).toBe(true);
    }
  });
  it.each(["missing", "failed", "pending", "pglite", "malformed", "zero"])("rejects %s agent receipt evidence", mode => {
    const needed = requirements();
    const report = { success: true, testResults: [{ name: path.resolve(root, file), status: "passed", assertionResults: needed.map(item => ({
      title: item.test!, fullName: `${item.ancestorSuite} ${item.suite} ${item.test}`, ancestorTitles: [item.ancestorSuite!, item.suite!], status: "passed",
    })) }] };
    expect(reportFailures(needed, report, root)).toEqual([]);
    const row = report.testResults[0].assertionResults[0];
    if (mode === "missing") report.testResults[0].assertionResults.shift();
    else if (mode === "zero") report.testResults[0].assertionResults = [];
    else if (mode === "pglite") row.ancestorTitles[0] = "agent effect receipts [pglite]";
    else if (mode === "malformed") row.fullName = "";
    else row.status = mode;
    expect(reportFailures(needed, report, root).length).toBeGreaterThan(0);
  });
});


it("keeps transaction-bound dispatch and same-owner receipt privileges mandatory on real PostgreSQL", () => {
  const required = requirementsFor("platform-postgres", root);
  const file = "tests/controlplane/build-launch-broker-binding.test.ts";
  const sourceCases = approvedSourceNamed().filter(item => item.file === file);
  const sourceIds = new Set(sourceCases.map(item => item.id));
  expect(required.filter(item => item.file === file && item.test && !sourceIds.has(item.id))).toHaveLength(44);
  expect(sourceCases).toHaveLength(17);
  expect(createHash("sha256").update(JSON.stringify(sourceCases.map(item => item.test))).digest("hex"))
    .toBe("a4f6c8e94a83025ca9511bc5a14dc7590cd53c74487c81396f291090447a5644");
  for (const mode of ["production", "isolated"])
    expect(required).toContainEqual(expect.objectContaining({ file, test: `launches with valid owning approvals on a single-connection pool through ${mode} composition`, postgres: true }));
  for (const mode of ["fresh", "same-owner schema6"])
    expect(required).toContainEqual(expect.objectContaining({ file: "tests/controlplane/migrations.test.ts", suite: "migrator [postgres] concurrency and fail-closed open",
      test: `${mode} canonical migrations keep permanent agent receipts select/insert-only`, postgres: true }));
});

const nativePlanFixtureFiles = [
  "tests/controlplane/plan-artifact-product-authority.test.ts",
  "tests/controlplane/plan-artifact-integration-authority.test.ts",
  "tests/controlplane/plan-artifact-oauth-authority.test.ts",
  "tests/controlplane/cleanup-writer-barriers.test.ts",
];
/** These reviewed suites use one genuine native database per suite and retain physical roots until its verified removal. */
function expectNativePlanFixtureSource(file: string, source: string) {
  expect(nativePlanFixtureFiles).toContain(file);
  const fixture = fs.readFileSync(path.join(root, "tests/controlplane/_support/saved-native-plan.ts"), "utf8");
  expect(createHash("sha256").update(fixture).digest("hex")).toBe("12d89201d4566f62ea355997102389511e5617226b914f8b58d2a92cd7ccf28d");
  const create = fixture.indexOf('await admin.unsafe(`create database');
  const agent = fixture.indexOf("await applyAgentSchemaMain({ ZENITH_TEST_PLATFORM_PG_URL: url })");
  const platform = fixture.indexOf('await remember(await openPlatformDb({ kind: "postgres", url, migrate: true, max: 1 }))');
  expect(fixture.indexOf("assertAgentLaneUrl(url);")).toBeGreaterThanOrEqual(0);
  expect(fixture.indexOf("assertAgentLaneUrl(url);")).toBeLessThan(create);
  expect(create).toBeGreaterThanOrEqual(0); expect(agent).toBeGreaterThan(create); expect(platform).toBeGreaterThan(agent);
  expect(fixture).toContain('current[0]!.oid !== original.oid || current[0]!.owner !== original.owner');
  expect(fixture).toContain('if ((await identity()).length !== 0) throw new Error("Native plan fixture database removal is unconfirmed.");');
  expect(fixture).toContain('isOpenedPlatformPostgresTarget(handle, target.hostname, Number(target.port), name, "postgres")');
  expect(source).toMatch(/import\s*\{[^}]*openNativePlanFixtureDatabase[^}]*\}\s*from\s*"\.\/_support\/saved-native-plan";/);
  expect(source).toContain("native=await openNativePlanFixtureDatabase(PG_URL);PG_URL=native.url;");
  expect(source).toMatch(/db\s*=\s*await\s+native!?\.remember\(await platformDb\(\)\)/);
  expect(source).toMatch(/peer\s*=\s*await native\.open\(\);\s*observer\s*=\s*await native\.open\(\);/);
  const removed = source.indexOf("const removed=await Promise.allSettled([native?.close()]);");
  const retained = source.indexOf('if(nativeCaseFailed||[...ended,...removed].some(result=>result.status==="rejected"))throw new Error("Native plan fixture teardown is unconfirmed; retaining backend roots.");');
  const roots = source.indexOf("const roots=await Promise.allSettled(");
  expect(removed).toBeGreaterThanOrEqual(0); expect(retained).toBeGreaterThan(removed); expect(roots).toBeGreaterThan(retained);
}

const planProductGroups = [
  {
    "file": "tests/controlplane/plan-artifact-product-authority.test.ts",
    "suite": "paired plan product dispatch authority [postgres; modeled current roles and hosted association]",
    "flag": "ZENITH_TEST_PLAN_PRODUCT_AUTHORITY_REQUIRED",
    "count": 52,
    "sha256": "369ef5d4add53ec82e3d39664bdd4da3b24f5ffedbcddbdb13ab5383512c9843",
    "offset": 0
  },
  {
    "file": "tests/platform/current-dispatch-requirement.test.ts",
    "suite": "current evaluated dispatch requirement [postgres; modeled policy and directory]",
    "flag": "ZENITH_TEST_PLAN_PRODUCT_AUTHORITY_REQUIRED",
    "count": 9,
    "sha256": "eb7927f2cffb384a53ed0f06a5fe6ea48f530b53e5554841440c65ec8b88e76f",
    "offset": 0
  },
  {
    "file": "tests/capabilities/default-broker-origin.test.ts",
    "suite": "private default broker origin [postgres; factory provenance only]",
    "flag": "ZENITH_TEST_PLAN_PRODUCT_AUTHORITY_REQUIRED",
    "count": 18,
    "sha256": "9f0f4898a2ef0a1844277ce34e4013c10100645edb24e2abb0d71a53485ee373",
    "offset": 0
  },
  {
    "file": "tests/tofu/plan-artifact-handoff.test.ts",
    "suite": "authenticated original cross-worker handoff [postgres]",
    "flag": "ZENITH_TEST_PLAN_PRODUCT_AUTHORITY_REQUIRED",
    "count": 7,
    "sha256": "7da4e29009c7dad9fb1efabca1af3ee057e32d5eff08b717eb1c715f5f41f229",
    "offset": 11
  },
  {
    "file": "tests/controlplane/plan-artifact-integration-authority.test.ts",
    "suite": "native linked integration original-plan dispatch [postgres; modeled hosted REST and policy]",
    "flag": "ZENITH_TEST_NATIVE_INTEGRATION_AUTHORITY_REQUIRED",
    "count": 35,
    "sha256": "d9e98f67caf345bfdb4aa6cada41d63899c176355233a6cc028c160d47b6f9ba",
    "offset": 0
  },
  {
    "file": "tests/agent-access/credential-authority-origin.test.ts",
    "suite": "native linked credential factory origin [postgres]",
    "flag": "ZENITH_TEST_NATIVE_INTEGRATION_AUTHORITY_REQUIRED",
    "count": 50,
    "sha256": "7f56ddefb39b2e90ede0053b62732e323027137c5572aff734df738747866424",
    "offset": 0
  }
];
/** Read these six committed fixture declarations only; no source/module evaluation. */
function planProductDeclarations(group: typeof planProductGroups[number], includeRetainedWait = false): string[] {
  const source = fs.readFileSync(path.join(root, group.file), "utf8");
  const start = source.indexOf(JSON.stringify(group.suite));
  if (start < 0 || !source.slice(0, start).trimEnd().endsWith("(")) throw new Error("Exact native product fixture suite unavailable.");
  let body = source.slice(start);
  if (["tests/controlplane/plan-artifact-product-authority.test.ts", "tests/controlplane/plan-artifact-integration-authority.test.ts"].includes(group.file)) {
    const labels = /const changes\s*=\s*(\[[\s\S]*?\]) as const;/.exec(body)?.[1];
    if (!labels) throw new Error("Exact committed native product change labels unavailable.");
    const values: unknown = JSON.parse(labels);
    if (!Array.isArray(values) || values.some(value => typeof value !== "string")) throw new Error("Native product change labels must be literal strings.");
    body = body.replace("it.each(changes)(", `it.each(${JSON.stringify(values)})(`);
  }
  return [...body.matchAll(/\bit(?:\.each\((\[[^\]]*\])(?: as const)?\))?\(\s*"([^"\n]+)"/g)].flatMap(match => {
    if (!match[1]) return [match[2]];
    const values: unknown = JSON.parse(match[1]);
    if (!Array.isArray(values) || values.some(value => typeof value !== "string")) throw new Error("Native product fixture labels must be literal strings.");
    return values.map(value => match[2].replace("%s", value));
  }).filter(title => includeRetainedWait || title !== PLAN_PRODUCT_RETAINED_WAIT_POSTGRES_REQUIREMENTS[0].test)
    .filter(title => group.file !== "tests/agent-access/credential-authority-origin.test.ts" || !NATIVE_CREDENTIAL_FACTORY_POSTGRES_REQUIREMENTS.some(item => item.test === title)).slice(group.offset);
}

describe("mandatory original-plan product and linked native authority gates", () => {
  it("preserves all 624 prior IDs and registers 171 literal cases plus three discovered native suites", () => {
    const manifest = manifestFor("platform-postgres", root);
    const required = planProductNamed();
    expect(required).toHaveLength(171);
    expect(new Set(required.map(item => item.id)).size).toBe(171);
    expect(priorPlanProductPlatformRequirements()).toHaveLength(624);
    expect(createHash("sha256").update(JSON.stringify(priorPlanProductPlatformRequirements().map(item => item.id).sort())).digest("hex")).toBe("09b908b83f36eb4c08bc8f241337dd03c584e8c49a4918de9d6ce0aad52ddf75");
    expect(priorRetainedWaitPlatformRequirements()).toHaveLength(798);
    expect(new Set(priorRetainedWaitPlatformRequirements().map(item => item.id)).size).toBe(798);
    for (const discovered of planProductDiscovered) expect(manifest.requirements).toContainEqual({ ...discovered, id: requirementId("platform-postgres", discovered) });
    expect(manifest.env).toMatchObject({ ZENITH_TEST_PLAN_PRODUCT_AUTHORITY_REQUIRED: "1", ZENITH_TEST_NATIVE_INTEGRATION_AUTHORITY_REQUIRED: "1" });
    for (const prerequisite of [
  "ZENITH_TEST_PLAN_PRODUCT_AUTHORITY_REQUIRED=1; original-plan product/current approval authority requires actual PostgreSQL, canonical platform schema13/product collections, independent native connections and pinned OpenTofu; hosted association/current roles/policy remain modeled",
  "ZENITH_TEST_NATIVE_INTEGRATION_AUTHORITY_REQUIRED=1; linked credential dispatch/factory origin requires actual owning PostgreSQL with explicit port, canonical platform schema13/product collections and agent linked schema1; hosted REST/scope/policy remain modeled"
]) expect(manifest.prerequisites).toContain(prerequisite);
    for (const group of planProductGroups) {
      expect(manifest.command.some(argument => argument === group.file || group.file.startsWith(`${argument}/`))).toBe(true);
      expect(manifest.excludeFiles).not.toContain(group.file);
    }
    expect(manifest.command).toContain("tests/platform/current-dispatch-requirement.test.ts");
    expect(manifest.command).toContain("tests/agent-access/credential-authority-origin.test.ts");
    expect(manifest.command).not.toContain("--passWithNoTests");
    expect(manifest.excludeFiles).toEqual([]);
    expect(manifest.tools).toEqual({ node: "22.23.3", postgres: "16.15", tofu: "1.12.5" });
    expect(reportFailures(required, contractReport(required), root)).toEqual([]);
  });

  it.each(planProductGroups)("$file pins exact native source declarations and the required pre-hook guard", group => {
    const required = planProductNamed().filter(item => item.file === group.file && item.suite === group.suite);
    expect(required).toHaveLength(group.count);
    expect(required.map(item => item.test)).toEqual(planProductDeclarations(group));
    expect(createHash("sha256").update(JSON.stringify(required.map(item => item.test))).digest("hex")).toBe(group.sha256);
    const source = fs.readFileSync(path.join(root, group.file), "utf8");
    expect(source).toContain(group.flag);
    const firstNativeRegistration = Math.min(...["beforeAll(", "beforeEach(", "afterAll(", "describe.skipIf("].map(boundary => source.indexOf(boundary)).filter(index => index >= 0));
    expect(Number.isFinite(firstNativeRegistration)).toBe(true);
    expect(source.indexOf(group.flag)).toBeLessThan(firstNativeRegistration);
    if (nativePlanFixtureFiles.includes(group.file)) expectNativePlanFixtureSource(group.file, source);
    else expect(source).toContain("openPlatformDb");
    for (const item of required) expect(item).toMatchObject({ file: group.file, suite: group.suite, backend: "postgres" });
  });

  it("refuses every missing or nonpassing product case and PGlite, foreign, malformed or substituted evidence", () => {
    const required = planProductNamed();
    for (const missing of required) {
      expect(reportFailures(required, contractReport(required.filter(item => item.id !== missing.id)), root)).toHaveLength(1);
      for (const status of ["failed", "skipped", "pending", "todo", "unknown"]) {
        const report = contractReport(required);
        report.testResults.find(file => file.name === path.resolve(root, missing.file))!.assertionResults.find(item => item.title === missing.test)!.status = status;
        expect(reportFailures(required, report, root).length).toBeGreaterThan(0);
      }
      for (const suite of [missing.suite!.replace("postgres", "pglite"), missing.suite!.replace("postgres", "postgres-replica"), "modeled unrelated authority [postgres]", "native authority ['postgres\"]"]) {
        const report = contractReport(required);
        report.testResults.find(file => file.name === path.resolve(root, missing.file))!.assertionResults.find(item => item.title === missing.test)!.ancestorTitles = [suite];
        expect(reportFailures(required, report, root)).toHaveLength(1);
      }
      const foreign = contractReport(required);
      foreign.testResults.find(file => file.name === path.resolve(root, missing.file))!.assertionResults = foreign.testResults.find(file => file.name === path.resolve(root, missing.file))!.assertionResults.filter(item => item.title !== missing.test);
      foreign.testResults.push({ name: path.resolve(root, "tests/execution/apply.test.ts"), status: "passed", assertionResults: [{ title: missing.test!, fullName: `${missing.suite} ${missing.test}`, ancestorTitles: [missing.suite!], status: "passed" }] });
      expect(reportFailures(required, foreign, root)).toHaveLength(1);
      const malformed = contractReport(required);
      malformed.testResults.find(file => file.name === path.resolve(root, missing.file))!.assertionResults.find(item => item.title === missing.test)!.fullName = "";
      expect(reportFailures(required, malformed, root)).toEqual(["Malformed Vitest assertion evidence"]);
      const substitute = contractReport(required);
      substitute.testResults.find(file => file.name === path.resolve(root, missing.file))!.assertionResults.find(item => item.title === missing.test)!.title = "a passing modeled authority";
      expect(reportFailures(required, substitute, root)).toHaveLength(1);
    }
  });

  it("retains every literal requirement after all six native fixture files are deleted", () => {
    const sourceRoot = modelRoot(path.join(scratch, "deleted-plan-product-"));
    for (const directory of ["tests/controlplane", "tests/capabilities", "tests/reconcile", "tests/platform", "tests/agent-access", "tests/tofu"]) fs.mkdirSync(path.join(sourceRoot, directory), { recursive: true });
    for (const group of planProductGroups) fs.copyFileSync(path.join(root, group.file), path.join(sourceRoot, group.file));
    const before = planProductNamed(sourceRoot);
    for (const group of planProductGroups) fs.unlinkSync(path.join(sourceRoot, group.file));
    expect(planProductNamed(sourceRoot)).toEqual(before);
    expect(before).toEqual(planProductNamed());
    expect(reportFailures(before, { success: true, testResults: [] }, sourceRoot)).toHaveLength(171);
  });

  it("refuses empty, duplicate, suite-only and inconsistent reports without caller requirement overrides", () => {
    const required = planProductNamed();
    for (const report of [null, {}, { success: true }, { success: true, testResults: [] }, { success: false, testResults: [] }]) expect(reportFailures(required, report, root).length).toBeGreaterThan(0);
    expect(reportFailures([], contractReport(required), root)).toEqual(["No required scenarios found"]);
    const suiteOnly = contractReport(required);
    for (const file of suiteOnly.testResults) file.assertionResults = [{ title: "one modeled authority", fullName: "one modeled authority", ancestorTitles: ["native authority [postgres]"], status: "passed" }];
    expect(reportFailures(required, suiteOnly, root)).toHaveLength(171);
    const duplicate = contractReport(required); duplicate.testResults.push(duplicate.testResults[0]);
    expect(reportFailures(required, duplicate, root)).toEqual(["Duplicate Vitest file evidence"]);
    expect(reportFailures(required, { ...contractReport(required), numTotalTests: 0 }, root)).toEqual(["Inconsistent Vitest report counts"]);
    expect(reportFailures(required, { ...contractReport(required), numFailedTests: 1 }, root)).toEqual(["Inconsistent Vitest report counts"]);
    expect(reportFailures(required, { ...contractReport([]), requirements: [], lane: "platform-postgres" }, root)).toHaveLength(171);
  });
});


const oauthFile = "tests/agent-control/pg-oauth-grants.test.ts";
const oauthSuite = "OAuth resource grant journal [postgres]";
const oauthNamed = (sourceRoot = root) => {
  const ids = new Set(OAUTH_GRANT_POSTGRES_REQUIREMENTS.map(item => requirementId("postgres", item)));
  return requirementsFor("postgres", sourceRoot).filter(item => ids.has(item.id));
};
/** OAuth's exact committed suite and flat literal parameters, without evaluation. */
function oauthDeclarations(): string[] {
  const source = fs.readFileSync(path.join(root, oauthFile), "utf8");
  const start = source.indexOf(`describe.skipIf(!enabled)(${JSON.stringify(oauthSuite)}`);
  if (start < 0) throw new Error("Exact native OAuth suite unavailable.");
  return [...source.slice(start).matchAll(/\bit(?:\.each\((\[[^\]]*\])(?: as const)?\))?\(\s*"([^"\n]+)"/g)].flatMap(match => {
    if (!match[1]) return [match[2]];
    const values: unknown = JSON.parse(match[1]);
    if (!Array.isArray(values) || values.some(value => typeof value !== "string")) throw new Error("OAuth parameters must be committed flat string literals.");
    return values.map(value => match[2].replace("%s", value));
  });
}

describe("mandatory native OAuth grant and additive retained destroy gates", () => {
  it("pins all 71 OAuth native source cases, original nine groups and pre-hook required admission", () => {
    const manifest = manifestFor("postgres", root), required = oauthNamed();
    expect(required).toHaveLength(71);
    expect(required.map(item => item.test)).toEqual(oauthDeclarations());
    expect(createHash("sha256").update(JSON.stringify(required.map(item => item.test))).digest("hex")).toBe("e87332ce8883f836e18a9a6fd0f34d051d0069a115b38e489b2d44e3e5ae2b00");
    expect(createHash("sha256").update(JSON.stringify(required.slice(0, 69).map(item => item.test))).digest("hex")).toBe("d9ea6ef37d03d7b5daae2c1e00b6b27a67084314845abbbb58437daa04eb0ba8");
    expect(required.slice(69).map(item => item.test)).toEqual([
      "cold native catalog preserves canonical CHECK and primary unique inheritance flags",
      "canonical verifier and migration refuse a same-named NO INHERIT CHECK constraint",
    ]);
    expect(new Set(required.map(item => item.id)).size).toBe(71);
    expect(manifest.requirements).toHaveLength(93);
    const oauthIds = new Set(required.map(item => item.id));
    const journalIds = new Set(AGENT_JOURNAL_POSTGRES_REQUIREMENTS.map(item => requirementId("postgres", item)));
    const previous = manifest.requirements.filter(item => !oauthIds.has(item.id) && !journalIds.has(item.id));
    expect(previous).toHaveLength(9);
    expect(previous.map(({ file, suite, backend }) => ({ file, suite, backend }))).toEqual([
      ...["access", "contract", "ledgers", "release"].map(name => ({ file: `tests/hosted/authority/contract/${name}.test.ts`, suite: name === "ledgers" ? "PostgresAuthority ledgers" : "PostgresAuthority", backend: "postgres" })),
      { file: "tests/scripts/migrate-hosted-to-postgres.test.ts", suite: "migrate-hosted-to-postgres — against the real Supabase project", backend: "postgres" },
      { file: "tests/agent-link/pg-contract.test.ts", suite: "AgentLinkPostgres", backend: "postgres" },
      { file: "tests/agent-control/pg-contract.test.ts", suite: "AgentControlPostgres", backend: "postgres" },
      { file: "tests/db/contract/workspace-sharing.test.ts", suite: "WorkspaceSharingPostgres", backend: "postgres" },
      { file: "tests/waitlist/pg-contract.test.ts", suite: "WaitlistPostgres", backend: "postgres" },
    ]);
    expect(manifest.env).toMatchObject({ ZENITH_CONTRACT_POSTGRES: "1", ZENITH_TEST_PG_OAUTH_GRANTS_REQUIRED: "1" });
    expect(manifest.command).toContain(oauthFile); expect(manifest.command).not.toContain("--passWithNoTests");
    expect(manifest.excludeFiles).toEqual([]);
    expect(manifest.prerequisites.some(value => value.startsWith("ZENITH_TEST_PG_OAUTH_GRANTS_REQUIRED=1;"))).toBe(true);
    const source = fs.readFileSync(path.join(root, oauthFile), "utf8");
    expect(source.indexOf("ZENITH_TEST_PG_OAUTH_GRANTS_REQUIRED")).toBeLessThan(source.indexOf("beforeAll("));
    expect(source.indexOf("ZENITH_TEST_PG_OAUTH_GRANTS_REQUIRED")).toBeLessThan(source.indexOf("describe.skipIf("));
    expect(source).toContain('if (process.env.ZENITH_TEST_PG_OAUTH_GRANTS_REQUIRED === "1" && !enabled)');
    for (const item of required) expect(item).toMatchObject({ file: oauthFile, suite: oauthSuite, postgres: true });
    expect(reportFailures(manifest.requirements, contractReport(manifest.requirements), root)).toEqual([]);
  });

  it("rejects each missing, nonpassing, PGlite, foreign, malformed or substituted native OAuth identity", () => {
    const required = oauthNamed();
    for (const missing of required) {
      expect(reportFailures(required, contractReport(required.filter(item => item.id !== missing.id)), root)).toHaveLength(1);
      for (const status of ["failed", "skipped", "pending", "todo", "unknown"]) {
        const report = contractReport(required);
        report.testResults[0].assertionResults.find(item => item.title === missing.test)!.status = status;
        expect(reportFailures(required, report, root).length).toBeGreaterThan(0);
      }
      for (const suite of ["OAuth resource grant journal [pglite]", "OAuth resource grant journal [postgres-replica]", "unrelated journal [postgres]", "OAuth resource grant journal ['postgres\"]"]) {
        const report = contractReport(required);
        report.testResults[0].assertionResults.find(item => item.title === missing.test)!.ancestorTitles = [suite];
        expect(reportFailures(required, report, root)).toHaveLength(1);
      }
      const foreign = contractReport(required);
      foreign.testResults[0].assertionResults = foreign.testResults[0].assertionResults.filter(item => item.title !== missing.test);
      foreign.testResults.push({ name: path.resolve(root, "tests/agent-control/pg-contract.test.ts"), status: "passed", assertionResults: [{ title: missing.test!, fullName: `${oauthSuite} ${missing.test}`, ancestorTitles: [oauthSuite], status: "passed" }] });
      expect(reportFailures(required, foreign, root)).toHaveLength(1);
      const malformed = contractReport(required); malformed.testResults[0].assertionResults.find(item => item.title === missing.test)!.fullName = "";
      expect(reportFailures(required, malformed, root)).toEqual(["Malformed Vitest assertion evidence"]);
      const substitute = contractReport(required); substitute.testResults[0].assertionResults.find(item => item.title === missing.test)!.title = "a passing modeled grant";
      expect(reportFailures(required, substitute, root)).toHaveLength(1);
    }
  });

  it("retains all literal OAuth requirements after source deletion and refuses zero or caller-supplied evidence", () => {
    const sourceRoot = modelRoot(path.join(scratch, "deleted-oauth-"));
    fs.mkdirSync(path.join(sourceRoot, "tests/hosted/authority/contract"), { recursive: true });
    fs.mkdirSync(path.join(sourceRoot, "tests/agent-control"), { recursive: true });
    fs.copyFileSync(path.join(root, oauthFile), path.join(sourceRoot, oauthFile));
    const before = oauthNamed(sourceRoot); fs.unlinkSync(path.join(sourceRoot, oauthFile));
    expect(oauthNamed(sourceRoot)).toEqual(before); expect(before).toEqual(oauthNamed());
    expect(reportFailures(before, { success: true, testResults: [] }, sourceRoot)).toHaveLength(71);
    for (const report of [null, {}, { success: true }, { success: false, testResults: [] }]) expect(reportFailures(before, report, root).length).toBeGreaterThan(0);
    const duplicate = contractReport(before); duplicate.testResults.push(duplicate.testResults[0]);
    expect(reportFailures(before, duplicate, root)).toEqual(["Duplicate Vitest file evidence"]);
    expect(reportFailures(before, { ...contractReport(before), numTotalTests: 0 }, root)).toEqual(["Inconsistent Vitest report counts"]);
    expect(reportFailures(before, { ...contractReport(before), numFailedTests: 1 }, root)).toEqual(["Inconsistent Vitest report counts"]);
    expect(reportFailures(before, { ...contractReport([]), lane: "postgres", requirements: [] }, root)).toHaveLength(71);
    expect(reportFailures([], contractReport(before), root)).toEqual(["No required scenarios found"]);
  });

  it("adds the observed retained destroy wait case without changing any of the 798 prior requirements", () => {
    const manifest = manifestFor("platform-postgres", root), added = PLAN_PRODUCT_RETAINED_WAIT_POSTGRES_REQUIREMENTS;
    expect(added).toHaveLength(1);
    expect(priorNativeOAuthPlatformRequirements()).toHaveLength(799); expect(new Set(priorNativeOAuthPlatformRequirements().map(item => item.id)).size).toBe(799);
    expect(priorRetainedWaitPlatformRequirements()).toHaveLength(798);
    const required = manifest.requirements.filter(item => added.some(value => requirementId("platform-postgres", value) === item.id));
    expect(required).toEqual(added.map(item => ({ ...item, id: requirementId("platform-postgres", item) })));
    const group = planProductGroups.find(item => item.file === required[0].file)!;
    const full = planProductDeclarations(group, true);
    expect(full).toHaveLength(36);
    expect(full.filter(title => title === added[0].test)).toHaveLength(1);
    expect(full.filter(title => title !== added[0].test)).toEqual(planProductNamed().filter(item => item.file === group.file).map(item => item.test));
    expect(manifest.env.ZENITH_TEST_NATIVE_INTEGRATION_AUTHORITY_REQUIRED).toBe("1");
    expect(reportFailures(required, contractReport(required), root)).toEqual([]);
    for (const status of ["failed", "pending", "skipped", "todo"]) { const report = contractReport(required); report.testResults[0].assertionResults[0].status = status; expect(reportFailures(required, report, root).length).toBeGreaterThan(0); }
    expect(reportFailures(required, { success: true, testResults: [] }, root)).toHaveLength(1);
    const model = contractReport(required); model.testResults[0].assertionResults[0].ancestorTitles = [required[0].suite!.replace("postgres", "pglite")];
    expect(reportFailures(required, model, root)).toHaveLength(1);
  });
});


const nativeOAuthGroups = [
  {
    "file": "tests/agent-access/native-oauth-origin.test.ts",
    "suite": "native OAuth journal current origin [postgres]",
    "flag": "ZENITH_TEST_NATIVE_OAUTH_DISPATCH_REQUIRED",
    "count": 49,
    "sourceSha256": "07968c79a0302182f620ab8b570c20e4d9b4b5d5f7a3f9f5acb33f650ef21242",
    "namesSha256": "9971aadde1c41430bdafc23dd36a9e639a6fc1d77f267c18690013101c7436fb",
    "priorCount": 0
  },
  {
    "file": "tests/controlplane/plan-artifact-oauth-authority.test.ts",
    "suite": "native OAuth original-plan dispatch [postgres; modeled hosted REST and policy]",
    "flag": "ZENITH_TEST_NATIVE_OAUTH_DISPATCH_REQUIRED",
    "count": 46,
    "sourceSha256": "708e11e4866b30e5acd9bd1986abde090d090676c41bd58c485b0a1695281a5d",
    "namesSha256": "12b72c88bb56763f6538df143dd3e1278dc27fbc9c800476909fa4d2d45e5de6",
    "priorCount": 0
  },
  {
    "file": "tests/agent-access/credential-authority-origin.test.ts",
    "suite": "native linked credential factory origin [postgres]",
    "flag": "ZENITH_TEST_NATIVE_INTEGRATION_AUTHORITY_REQUIRED",
    "count": 11,
    "sourceSha256": "9dec39f0bba8ec1c6b990bb82cec8ded7dc9af0f34de8e1cdf19682e4ec08a5d",
    "namesSha256": "97a39a81b107fa5106534f9f7dab6cee46c2f5550f8e89915d506833b19f7a2e",
    "priorCount": 50
  }
] as const;
function nativeOAuthNamed(sourceRoot = root): Requirement[] {
  const ids = new Set([...NATIVE_OAUTH_DISPATCH_POSTGRES_REQUIREMENTS, ...NATIVE_CREDENTIAL_FACTORY_POSTGRES_REQUIREMENTS].map(item => requirementId("platform-postgres", item)));
  return requirementsFor("platform-postgres", sourceRoot).filter(item => ids.has(item.id));
}
/** Only these committed flat string labels are expanded; fixture source is never evaluated. */
function nativeOAuthDeclarations(file: string): string[] {
  let source = fs.readFileSync(path.join(root, file), "utf8");
  if (file === "tests/controlplane/plan-artifact-oauth-authority.test.ts") {
    for (const name of ["changes", "waited"]) {
      const match = new RegExp(`const ${name}\\s*=\\s*(\\[[^\\]]*\\]) as const;`).exec(source);
      if (!match) throw new Error("Exact OAuth fixture labels are unavailable.");
      const values: unknown = JSON.parse(match[1]);
      if (!Array.isArray(values) || values.some(value => typeof value !== "string")) throw new Error("OAuth fixture labels must be literal strings.");
      source = source.replace(`it.each(${name})(`, `it.each(${JSON.stringify(values)})(`);
    }
  }
  return [...source.matchAll(/\bit(?:\.each\((\[[^\]]*\])(?: as const)?\))?\(\s*"([^"\n]+)"/g)].flatMap(match => {
    if (!match[1]) return [match[2]];
    const values: unknown = JSON.parse(match[1]);
    if (!Array.isArray(values) || values.some(value => typeof value !== "string") || match[2].split("%s").length !== 2) throw new Error("OAuth fixture labels require one literal parameter.");
    return values.map(value => match[2].replace("%s", value));
  });
}

describe("mandatory corrected native OAuth dispatch and linked factory gates", () => {
  it("preserves all 799 prior platform IDs, 80 PostgreSQL requirements and 22 native package checks while adding exact source cases", () => {
    const manifest = manifestFor("platform-postgres", root), named = nativeOAuthNamed();
    expect(NATIVE_OAUTH_DISPATCH_POSTGRES_REQUIREMENTS).toHaveLength(95);
    expect(NATIVE_CREDENTIAL_FACTORY_POSTGRES_REQUIREMENTS).toHaveLength(11);
    expect(named).toHaveLength(106); expect(new Set(named.map(item => item.id)).size).toBe(106);
    const previous = priorApplyCurrentAuthorityPlatformRequirements();
    expect(previous).toHaveLength(906); expect(new Set(previous.map(item => item.id)).size).toBe(906);
    expect(createHash("sha256").update(JSON.stringify(previous.map(item => item.id).sort())).digest("hex")).toBe("bfe33823494d47835d18bb8bddfbd373f58beb0a00f136e2b4ca229356215f18");
    const prior = priorNativeOAuthPlatformRequirements();
    expect(prior).toHaveLength(799);
    expect(createHash("sha256").update(JSON.stringify(prior.map(item => item.id).sort())).digest("hex")).toBe("4d0668f6e3fbac4acf544dbfa2bf625a96648cdb2cfc5f8039537c5961b77be6");
    expect(manifest.requirements).toContainEqual({ ...nativeOAuthDiscovered, id: requirementId("platform-postgres", nativeOAuthDiscovered) });
    expect(manifest.env).toMatchObject({ ZENITH_TEST_NATIVE_OAUTH_DISPATCH_REQUIRED: "1", ZENITH_TEST_NATIVE_INTEGRATION_AUTHORITY_REQUIRED: "1" });
    expect(manifest.prerequisites).toEqual(expect.arrayContaining(["ZENITH_TEST_NATIVE_OAUTH_DISPATCH_REQUIRED=1; OAuth original-plan dispatch and default journal origin require actual owning PostgreSQL16 with explicit ZENITH_TEST_PLATFORM_PG_URL port, canonical platform schema13/product collections and agent schemas1/2/3 through migration0015, independent native connections and positively owned disposable scratch databases/CI roles; hosted REST/current identity/policy and sealed fixture bytes remain modeled", "The additive linked factory preselection controls share ZENITH_TEST_NATIVE_INTEGRATION_AUTHORITY_REQUIRED=1 and actual owning PostgreSQL; all prior50 linked origin cases remain mandatory, tooling constructors supply no default origin"]));
    for (const group of nativeOAuthGroups) expect(manifest.command).toContain(group.file);
    expect(manifest.excludeFiles).toEqual([]); expect(manifest.command).not.toContain("--passWithNoTests");
    expect(manifestFor("postgres", root).requirements).toHaveLength(93);
    expect(packagedWorkerManifest().requiredChecks).toHaveLength(22);
    expect(reportFailures(manifest.requirements, contractReport(manifest.requirements), root)).toEqual([]);
  });

  it.each(nativeOAuthGroups)("$file pins corrected source, exact names and required admission before hooks", group => {
    const source = fs.readFileSync(path.join(root, group.file), "utf8"), required = nativeOAuthNamed().filter(item => item.file === group.file);
    expect(createHash("sha256").update(source).digest("hex")).toBe(group.sourceSha256);
    const all = nativeOAuthDeclarations(group.file);
    const declared = group.priorCount ? all.filter(title => NATIVE_CREDENTIAL_FACTORY_POSTGRES_REQUIREMENTS.some(item => item.test === title)) : all;
    expect(all).toHaveLength(group.count + group.priorCount); expect(required).toHaveLength(group.count);
    expect(required.map(item => item.test)).toEqual(declared);
    expect(createHash("sha256").update(JSON.stringify(declared)).digest("hex")).toBe(group.namesSha256);
    if (group.priorCount) expect(all.slice(group.priorCount)).toEqual(declared);
    const first = Math.min(...["beforeAll(", "beforeEach(", "afterAll(", "describe.skipIf("].map(value => source.indexOf(value)).filter(value => value >= 0));
    expect(source.indexOf(group.flag)).toBeGreaterThanOrEqual(0); expect(source.indexOf(group.flag)).toBeLessThan(first);
    if (group.file === "tests/controlplane/plan-artifact-oauth-authority.test.ts") expectNativePlanFixtureSource(group.file, source);
    else expect(source).toContain("openPlatformDb");
    expect(source).toMatch(/PLATFORM_SCHEMA_VERSION\s*<\s*13/);
    for (const item of required) expect(item).toMatchObject({ suite: group.suite, backend: "postgres" });
  });

  it("refuses every missing, nonpassing, PGlite, foreign, malformed or substituted corrected native case", () => {
    const required = nativeOAuthNamed();
    expect(reportFailures(required, contractReport(required), root)).toEqual([]);
    for (const missing of required) {
      expect(reportFailures(required, contractReport(required.filter(item => item.id !== missing.id)), root), missing.id).toHaveLength(1);
      for (const status of ["failed", "pending", "skipped", "todo"]) {
        const report = contractReport(required); report.testResults.flatMap(file => file.assertionResults).find(item => item.title === missing.test)!.status = status;
        expect(reportFailures(required, report, root).length, missing.id).toBeGreaterThan(0);
      }
      const pglite = contractReport(required); pglite.testResults.flatMap(file => file.assertionResults).find(item => item.title === missing.test)!.ancestorTitles = [missing.suite!.replace("postgres", "pglite")];
      expect(reportFailures(required, pglite, root).length).toBeGreaterThan(0);
      const foreign = contractReport(required); foreign.testResults.find(file => file.name === path.resolve(root, missing.file))!.name = path.resolve(root, "tests/platform/foreign-oauth-fixture.test.ts");
      expect(reportFailures(required, foreign, root).length).toBeGreaterThan(0);
      const malformed = contractReport(required); malformed.testResults.flatMap(file => file.assertionResults).find(item => item.title === missing.test)!.fullName = "";
      expect(reportFailures(required, malformed, root)).toEqual(["Malformed Vitest assertion evidence"]);
      const substitute = contractReport(required); substitute.testResults.flatMap(file => file.assertionResults).find(item => item.title === missing.test)!.title = "a passing OAuth model";
      expect(reportFailures(required, substitute, root).length).toBeGreaterThan(0);
    }
  });

  it("retains all committed new cases after source deletion and rejects suite-only, zero, duplicate or caller-supplied reduced reports", () => {
    const sourceRoot = modelRoot(path.join(scratch, "oauth-dispatch-"));
    for (const directory of ["tests/controlplane", "tests/capabilities", "tests/reconcile", "tests/agent-access"]) fs.mkdirSync(path.join(sourceRoot, directory), { recursive: true });
    for (const group of nativeOAuthGroups) fs.copyFileSync(path.join(root, group.file), path.join(sourceRoot, group.file));
    const before = nativeOAuthNamed(sourceRoot); expect(before).toHaveLength(106);
    for (const group of nativeOAuthGroups) fs.unlinkSync(path.join(sourceRoot, group.file));
    expect(nativeOAuthNamed(sourceRoot)).toEqual(before);
    expect(reportFailures(before, { success: true, testResults: [] }, sourceRoot)).toHaveLength(106);
    expect(reportFailures([], contractReport(before), root)).toEqual(["No required scenarios found"]);
    const suiteOnly = contractReport(before); for (const file of suiteOnly.testResults) file.assertionResults = [{ title: "one modeled grant", fullName: "one modeled grant", ancestorTitles: [], status: "passed" }];
    expect(reportFailures(before, suiteOnly, root)).toHaveLength(106);
    const duplicate = contractReport(before); duplicate.testResults.push(duplicate.testResults[0]);
    expect(reportFailures(before, duplicate, root)).toEqual(["Duplicate Vitest file evidence"]);
    expect(reportFailures(before, { ...contractReport(before), numTotalTests: 0 }, root)).toEqual(["Inconsistent Vitest report counts"]);
    expect(reportFailures(before, { ...contractReport(before), numFailedTests: 1 }, root)).toEqual(["Inconsistent Vitest report counts"]);
    expect(reportFailures(before, { ...contractReport([]), lane: "platform-postgres", requirements: [] }, root)).toHaveLength(106);
  });
});

// Source parsing and report fixtures supply contract evidence only, never a native run.
const nativeSafetyGroups = [
  {
    "file": "tests/controlplane/mixed-child-admission.test.ts",
    "suite": "native mixed child custody [postgres]",
    "flag": "ZENITH_TEST_MIXED_CHILD_CUSTODY_REQUIRED",
    "count": 37,
    "sourceSha256": "4701b41f18617ea3940ab6e9540e4349501dd70fe25459c14cd3f03b65f6f2de",
    "namesSha256": "7c4fe5ccb5f9094021b249b61b87e9b9a66a080b7b5a20c823c324d832292ce5"
  },
  {
    "file": "tests/controlplane/plan-artifact-retention.test.ts",
    "suite": "plan artifact retention preview [postgres; synthetic storage and receipt fixtures]",
    "flag": "ZENITH_TEST_PLAN_RETENTION_REQUIRED",
    "count": 27,
    "sourceSha256": "7d732dbe799758c5151beb3d269191b9007b23f1b3da131ed2570da3342c0a88",
    "namesSha256": "404ac3067866333f5a81d69a689eefd0ea4340e81a81e1b6121e25139c3fa8b3"
  },
  {
    "file": "tests/platform/kubernetes-vault-target.test.ts",
    "suite": "default Kubernetes vault target binding [postgres; modeled API boundary]",
    "flag": "ZENITH_TEST_KUBERNETES_VAULT_TARGET_REQUIRED",
    "count": 18,
    "sourceSha256": "a08599fe95710f3fa9d6b4ba4669bc63c5fe7b146b96ea7101ea73f9d9a076b9",
    "namesSha256": "bc2e272c08f46609afe3a1a830141df9204b6800642ff742381e65ec6db20f3f"
  }
] as const;
function nativeSafetyNamed(sourceRoot = root): Requirement[] {
  const ids = new Set([...MIXED_CHILD_CUSTODY_POSTGRES_REQUIREMENTS, ...PLAN_RETENTION_POSTGRES_REQUIREMENTS, ...KUBERNETES_VAULT_TARGET_POSTGRES_REQUIREMENTS].map(item => requirementId("platform-postgres", item)));
  return requirementsFor("platform-postgres", sourceRoot).filter(item => ids.has(item.id));
}

describe("mandatory human Kubernetes linking cases [report models]", () => {
  it("requires all 21 native linking scenarios and their discovered suite while preserving the exact 990 predecessor", () => {
    const manifest = manifestFor("platform-postgres", root), required = kubernetesLinkNamed();
    expect(required).toHaveLength(21); expect(new Set(required.map(item => item.id)).size).toBe(21);
    expect(priorCleanupPlatformRequirements()).toHaveLength(1012); expect(new Set(priorCleanupPlatformRequirements().map(item => item.id)).size).toBe(1012);
    const predecessor = priorKubernetesLinkPlatformRequirements();
    expect(predecessor).toHaveLength(990);
    expect(createHash("sha256").update(JSON.stringify(predecessor.map(item => item.id).sort())).digest("hex")).toBe("cd24c52f0cdddb47746e282080e1a3fcd31f8b1799ac685cf3e6f273b70e452e");
    expect(manifest.requirements).toContainEqual({ ...kubernetesLinkDiscovered, id: requirementId("platform-postgres", kubernetesLinkDiscovered) });
    expect(manifest.env[kubernetesLinkGroup.flag]).toBe("1");
    expect(manifest.prerequisites.some(value => value.startsWith(`${kubernetesLinkGroup.flag}=1;`))).toBe(true);
    expect(manifest.files).toContain("tests/controlplane"); expect(manifest.command).toContain("tests/controlplane");
    expect(manifest.excludeFiles).toEqual([]); expect(manifest.command).not.toContain("--passWithNoTests");
    for (const lane of Object.keys(GATE_LANES).filter(name => name !== "platform-postgres")) expect(manifestFor(lane, root).env[kubernetesLinkGroup.flag]).toBeUndefined();
    expect(manifestFor("postgres", root).requirements).toHaveLength(93);
    expect(packagedWorkerManifest().requiredChecks).toHaveLength(22);
    expect(reportFailures(manifest.requirements, contractReport(manifest.requirements), root)).toEqual([]);
  });

  it("binds exact expanded native linking titles to the reviewed source and required admission before hooks", () => {
    const source = fs.readFileSync(path.join(root, kubernetesLinkGroup.file), "utf8");
    const names = declaredLiteralTests(kubernetesLinkGroup.file, kubernetesLinkGroup.suite), required = kubernetesLinkNamed();
    expect(names).toHaveLength(21); expect(new Set(names).size).toBe(21); expect(required.map(item => item.test)).toEqual(names);
    expect(createHash("sha256").update(source).digest("hex")).toBe(kubernetesLinkGroup.sourceSha256);
    expect(createHash("sha256").update(names.join("\n") + "\n").digest("hex")).toBe(kubernetesLinkGroup.namesSha256);
    for (const item of required) { expect(item.backend).toBe("postgres"); expect(item.suite).toBe(kubernetesLinkGroup.suite); }
    expect(source).toContain(`describe.skipIf(!PG_URL)(${JSON.stringify(kubernetesLinkGroup.suite)}`);
    const admission = source.indexOf(`process.env.${kubernetesLinkGroup.flag} === "1"`);
    expect(admission).toBeGreaterThanOrEqual(0); expect(admission).toBeLessThan(source.indexOf("beforeAll("));
    expect(source).toContain("(!PG_URL || PLATFORM_SCHEMA_VERSION < 13)");
    expect(source).toMatch(/\bkind:\s*"postgres"/);
  });

  it("refuses every missing, failed, skipped, foreign, PGlite or substituted native linking case", () => {
    const required = kubernetesLinkNamed(); expect(reportFailures(required, contractReport(required), root)).toEqual([]);
    for (const missing of required) {
      expect(reportFailures(required, contractReport(required.filter(item => item.id !== missing.id)), root), missing.id).toHaveLength(1);
      for (const status of ["failed", "pending", "skipped", "todo", "unknown"]) {
        const report = contractReport(required); report.testResults.flatMap(file => file.assertionResults).find(item => item.title === missing.test)!.status = status;
        expect(reportFailures(required, report, root).length, missing.id).toBeGreaterThan(0);
      }
      const pglite = contractReport(required); pglite.testResults.flatMap(file => file.assertionResults).find(item => item.title === missing.test)!.ancestorTitles = [missing.suite!.replace("postgres", "pglite")];
      expect(reportFailures(required, pglite, root), missing.id).toHaveLength(1);
      const substituted = contractReport(required); substituted.testResults.flatMap(file => file.assertionResults).find(item => item.title === missing.test)!.title = "one passing pending-connection model";
      expect(reportFailures(required, substituted, root), missing.id).toHaveLength(1);
      const malformed = contractReport(required); malformed.testResults.flatMap(file => file.assertionResults).find(item => item.title === missing.test)!.fullName = "";
      expect(reportFailures(required, malformed, root)).toEqual(["Malformed Vitest assertion evidence"]);
    }
    const foreign = contractReport(required); foreign.testResults[0].name = path.resolve(root, "tests/controlplane/foreign-kubernetes-link.test.ts");
    expect(reportFailures(required, foreign, root)).toHaveLength(21);
  });

  it("keeps all native linking identities after source deletion and rejects suite-only, zero, duplicate and reduced evidence", () => {
    const sourceRoot = modelRoot(path.join(scratch, "native-kubernetes-link-"));
    for (const directory of ["tests/controlplane", "tests/capabilities", "tests/reconcile", "tests/agent-access", "tests/platform"]) fs.mkdirSync(path.join(sourceRoot, directory), { recursive: true });
    fs.copyFileSync(path.join(root, kubernetesLinkGroup.file), path.join(sourceRoot, kubernetesLinkGroup.file));
    const before = kubernetesLinkNamed(sourceRoot); expect(before).toHaveLength(21);
    expect(requirementsFor("platform-postgres", sourceRoot)).toContainEqual({ ...kubernetesLinkDiscovered, id: requirementId("platform-postgres", kubernetesLinkDiscovered) });
    fs.unlinkSync(path.join(sourceRoot, kubernetesLinkGroup.file)); expect(kubernetesLinkNamed(sourceRoot)).toEqual(before);
    expect(requirementsFor("platform-postgres", sourceRoot).some(item => item.id === requirementId("platform-postgres", kubernetesLinkDiscovered))).toBe(false);
    expect(reportFailures(before, { success: true, testResults: [] }, sourceRoot)).toHaveLength(21);
    const suiteOnly = contractReport(before); for (const file of suiteOnly.testResults) file.assertionResults = [{ title: "one passed modeled request", fullName: "one passed modeled request", ancestorTitles: [], status: "passed" }];
    expect(reportFailures(before, suiteOnly, root)).toHaveLength(21);
    const duplicate = contractReport(before); duplicate.testResults.push(duplicate.testResults[0]);
    expect(reportFailures(before, duplicate, root)).toEqual(["Duplicate Vitest file evidence"]);
    expect(reportFailures(before, { ...contractReport(before), numTotalTests: 0 }, root)).toEqual(["Inconsistent Vitest report counts"]);
    expect(reportFailures(before, { ...contractReport(before), numFailedTests: 1 }, root)).toEqual(["Inconsistent Vitest report counts"]);
    expect(reportFailures([], contractReport(before), root)).toEqual(["No required scenarios found"]);
    expect(reportFailures(before, { ...contractReport([]), lane: "platform-postgres", requirements: [] }, root)).toHaveLength(21);
  });
});

describe("mandatory native custody, retention and Kubernetes target cases [report models]", () => {
  it("pins all 81 named native cases and two discovered suites while preserving the exact 907 predecessor", () => {
    const manifest = manifestFor("platform-postgres", root), named = nativeSafetyNamed();
    expect(MIXED_CHILD_CUSTODY_POSTGRES_REQUIREMENTS).toHaveLength(37);
    expect(PLAN_RETENTION_POSTGRES_REQUIREMENTS).toHaveLength(27);
    expect(KUBERNETES_VAULT_TARGET_POSTGRES_REQUIREMENTS).toHaveLength(18);
    expect(named).toHaveLength(82); expect(new Set(named.map(item => item.id)).size).toBe(82);
    const predecessor = priorKubernetesLinkPlatformRequirements();
    expect(predecessor).toHaveLength(990); expect(new Set(predecessor.map(item => item.id)).size).toBe(990);
    const previous = priorNativeSafetyPlatformRequirements();
    expect(previous).toHaveLength(907); expect(new Set(previous.map(item => item.id)).size).toBe(907);
    expect(createHash("sha256").update(JSON.stringify(previous.map(item => item.id).sort())).digest("hex")).toBe("3192324ebd5d5db8a684fccc84173dd8be8b80efa3367f1bb57e81462d8b3c4b");
    for (const discovered of nativeSafetyDiscovered) expect(manifest.requirements).toContainEqual({ ...discovered, id: requirementId("platform-postgres", discovered) });
    expect(manifest.env).toMatchObject({ ZENITH_TEST_MIXED_CHILD_CUSTODY_REQUIRED: "1", ZENITH_TEST_PLAN_RETENTION_REQUIRED: "1", ZENITH_TEST_KUBERNETES_VAULT_TARGET_REQUIRED: "1" });
    // This historical cohort needs schema14 or newer. Current-registry and
    // emitted-SQL inventory checks elsewhere pin the complete successor.
    const schemaPrerequisite = manifest.prerequisites.flatMap(value => {
      const match = /^Canonical platform schema([1-9][0-9]*) applied\/current through scripts\/ci\/apply-platform-migrations\.sh;/.exec(value);
      return match ? [Number(match[1])] : [];
    });
    expect(schemaPrerequisite).toHaveLength(1);
    const schemaVersion = schemaPrerequisite[0];
    expect(typeof schemaVersion === "number" && Number.isSafeInteger(schemaVersion) && schemaVersion >= 14).toBe(true);
    expect(manifest.command).toContain("tests/platform/kubernetes-vault-target.test.ts");
    expect(manifest.excludeFiles).toEqual([]);
    for (const lane of Object.keys(GATE_LANES).filter(name => name !== "platform-postgres")) {
      for (const group of nativeSafetyGroups) {
        if (lane === "workflows" && group.flag === "ZENITH_TEST_KUBERNETES_VAULT_TARGET_REQUIRED") {
          expect(manifestFor(lane, root).env[group.flag]).toBe("1");
        } else {
          expect(manifestFor(lane, root).env[group.flag]).toBeUndefined();
        }
      }
    }
    expect(manifestFor("postgres", root).requirements).toHaveLength(93);
    expect(packagedWorkerManifest().requiredChecks).toHaveLength(22);
    expect(reportFailures(manifest.requirements, contractReport(manifest.requirements), root)).toEqual([]);
  });

  it.each(nativeSafetyGroups)("registers every committed $count literal native case in $file with required admission before hooks", group => {
    const source = fs.readFileSync(path.join(root, group.file), "utf8"), names = declaredLiteralTests(group.file, group.suite);
    const required = nativeSafetyNamed().filter(item => item.file === group.file);
    expect(names).toHaveLength(group.count); expect(new Set(names).size).toBe(group.count);
    expect(required.map(item => item.test)).toEqual(names);
    expect(createHash("sha256").update(names.join("\n") + "\n").digest("hex")).toBe(group.namesSha256);
    expect(createHash("sha256").update(source).digest("hex")).toBe(group.sourceSha256);
    for (const item of required) { expect(item.backend).toBe("postgres"); expect(item.suite).toBe(group.suite); }
    expect(source).toContain(`describe.skipIf(!PG_URL)(${JSON.stringify(group.suite)}`);
    expect(source.indexOf(group.flag)).toBeGreaterThanOrEqual(0);
    expect(source.indexOf(group.flag)).toBeLessThan(source.indexOf("beforeAll("));
    expect(source).toContain('=== "1"'); expect(source).toContain("!PG_URL");
    expect(source).toMatch(/\bkind:\s*"postgres"/);
    expect(manifestFor("platform-postgres", root).prerequisites.some(value => value.startsWith(`${group.flag}=1;`))).toBe(true);
  });

  it("rejects missing, failed, required skips, PGlite, foreign, malformed or substituted evidence for every native case", () => {
    const required = nativeSafetyNamed(); expect(reportFailures(required, contractReport(required), root)).toEqual([]);
    for (const missing of required) {
      expect(reportFailures(required, contractReport(required.filter(item => item.id !== missing.id)), root), missing.id).toHaveLength(1);
      for (const status of ["failed", "pending", "skipped", "todo", "unknown"]) {
        const report = contractReport(required); report.testResults.flatMap(file => file.assertionResults).find(item => item.title === missing.test)!.status = status;
        expect(reportFailures(required, report, root).length, missing.id).toBeGreaterThan(0);
      }
      const pglite = contractReport(required); pglite.testResults.flatMap(file => file.assertionResults).find(item => item.title === missing.test)!.ancestorTitles = [missing.suite!.replace("postgres", "pglite")];
      expect(reportFailures(required, pglite, root).length, missing.id).toBeGreaterThan(0);
      const foreign = contractReport(required); foreign.testResults.find(file => file.name === path.resolve(root, missing.file))!.name = path.resolve(root, "tests/platform/foreign-native-custody.test.ts");
      expect(reportFailures(required, foreign, root).length, missing.id).toBeGreaterThan(0);
      const malformed = contractReport(required); malformed.testResults.flatMap(file => file.assertionResults).find(item => item.title === missing.test)!.fullName = "";
      expect(reportFailures(required, malformed, root)).toEqual(["Malformed Vitest assertion evidence"]);
      const substitute = contractReport(required); substitute.testResults.flatMap(file => file.assertionResults).find(item => item.title === missing.test)!.title = "one passing custody model";
      expect(reportFailures(required, substitute, root).length, missing.id).toBeGreaterThan(0);
    }
  });

  it("keeps the literal native cohort after source deletion and refuses suite-only, zero, duplicate and reduced reports", () => {
    const sourceRoot = modelRoot(path.join(scratch, "native-safety-"));
    for (const directory of ["tests/controlplane", "tests/capabilities", "tests/reconcile", "tests/agent-access", "tests/platform"]) fs.mkdirSync(path.join(sourceRoot, directory), { recursive: true });
    for (const group of nativeSafetyGroups) fs.copyFileSync(path.join(root, group.file), path.join(sourceRoot, group.file));
    const before = nativeSafetyNamed(sourceRoot); expect(before).toHaveLength(82);
    for (const discovered of nativeSafetyDiscovered) expect(requirementsFor("platform-postgres", sourceRoot)).toContainEqual({ ...discovered, id: requirementId("platform-postgres", discovered) });
    for (const group of nativeSafetyGroups) fs.unlinkSync(path.join(sourceRoot, group.file));
    expect(nativeSafetyNamed(sourceRoot)).toEqual(before);
    for (const discovered of nativeSafetyDiscovered) expect(requirementsFor("platform-postgres", sourceRoot).some(item => item.id === requirementId("platform-postgres", discovered))).toBe(false);
    expect(reportFailures(before, { success: true, testResults: [] }, sourceRoot)).toHaveLength(82);
    expect(reportFailures([], contractReport(before), root)).toEqual(["No required scenarios found"]);
    const suiteOnly = contractReport(before); for (const file of suiteOnly.testResults) file.assertionResults = [{ title: "one passing native suite model", fullName: "one passing native suite model", ancestorTitles: [], status: "passed" }];
    expect(reportFailures(before, suiteOnly, root)).toHaveLength(82);
    const duplicate = contractReport(before); duplicate.testResults.push(duplicate.testResults[0]);
    expect(reportFailures(before, duplicate, root)).toEqual(["Duplicate Vitest file evidence"]);
    expect(reportFailures(before, { ...contractReport(before), numTotalTests: 0 }, root)).toEqual(["Inconsistent Vitest report counts"]);
    expect(reportFailures(before, { ...contractReport(before), numFailedTests: 1 }, root)).toEqual(["Inconsistent Vitest report counts"]);
    expect(reportFailures(before, { ...contractReport([]), lane: "platform-postgres", requirements: [] }, root)).toHaveLength(82);
  });
});

describe("mandatory native cleanup writer barrier cases [report models]", () => {
  it("requires all 61 native cleanup cases and their discovered suite while preserving the exact 1012 predecessor", () => {
    const manifest = manifestFor("platform-postgres", root), required = cleanupWriterNamed();
    expect(CLEANUP_WRITER_BARRIER_POSTGRES_REQUIREMENTS).toHaveLength(61);
    expect(required).toHaveLength(61); expect(new Set(required.map(item => item.id)).size).toBe(61);
    expect(priorSettlementPlatformRequirements()).toHaveLength(1058); expect(new Set(priorSettlementPlatformRequirements().map(item => item.id)).size).toBe(1058);
    const previous = priorCleanupPlatformRequirements();
    expect(previous).toHaveLength(1012); expect(new Set(previous.map(item => item.id)).size).toBe(1012);
    expect(createHash("sha256").update(JSON.stringify(previous.map(item => item.id).sort())).digest("hex")).toBe("436ee191fe94eb06c7c611a6477e3766b81ab9e0f1a543bdda6f328be77435de");
    expect(manifest.requirements).toContainEqual({ ...cleanupWriterDiscovered, id: requirementId("platform-postgres", cleanupWriterDiscovered) });
    expect(manifest.env[cleanupWriterGroup.flag]).toBe("1");
    expect(manifest.prerequisites.some(value => value.startsWith(`${cleanupWriterGroup.flag}=1;`))).toBe(true);
    expect(manifest.files).toContain("tests/controlplane"); expect(manifest.command).toContain("tests/controlplane");
    expect(manifest.excludeFiles).toEqual([]); expect(manifest.command).not.toContain("--passWithNoTests");
    for (const lane of Object.keys(GATE_LANES).filter(name => name !== "platform-postgres")) {
      expect(manifestFor(lane, root).env[cleanupWriterGroup.flag]).toBeUndefined();
      expect(requirementsFor(lane, root).some(item => item.file === cleanupWriterGroup.file)).toBe(false);
    }
    expect(manifestFor("postgres", root).requirements).toHaveLength(93);
    expect(priorServiceLinuxCases(linuxGuestManifest().raceCases)).toHaveLength(123);
    expect(packagedWorkerManifest().requiredChecks).toHaveLength(22);
    expect(reportFailures(manifest.requirements, contractReport(manifest.requirements), root)).toEqual([]);
    // Report models cannot supply the retained runner observation or turn a
    // nonzero engine status into success; the canonical runner is unchanged.
    const runner = fs.readFileSync(path.join(root, "scripts/ci/run-gate.mjs"), "utf8");
    expect(runner).toContain("writeExecutionReceipt(output, executionReceiptFor(originEvidence, run));");
    expect(runner).toContain("{ requireExecution: true }");
    expect(runner).toContain("return run.status === 0 && status === 0 ? 0 : 1;");
  });

  it("binds exact cleanup source and literal titles to required physical PostgreSQL admission before hooks", () => {
    const source = fs.readFileSync(path.join(root, cleanupWriterGroup.file), "utf8");
    expectNativePlanFixtureSource(cleanupWriterGroup.file, source);
    const added = new Set(SAVED_PLAN_SETTLEMENT_POSTGRES_REQUIREMENTS.map(item => item.test));
    const names = declaredLiteralTests(cleanupWriterGroup.file, cleanupWriterGroup.suite).filter(name => !added.has(name)), required = cleanupWriterNamed();
    expect(names).toHaveLength(61); expect(new Set(names).size).toBe(61); expect(required.map(item => item.test)).toEqual(names);
    expect(createHash("sha256").update(source).digest("hex")).toBe(cleanupWriterGroup.sourceSha256);
    expect(createHash("sha256").update(names.join("\n") + "\n").digest("hex")).toBe(cleanupWriterGroup.namesSha256);
    for (const item of required) expect(item).toMatchObject({ file: cleanupWriterGroup.file, suite: cleanupWriterGroup.suite, backend: "postgres" });
    expect(source).toContain(`describe.skipIf(!PG_URL)(${JSON.stringify(cleanupWriterGroup.suite)}`);
    const admission = source.indexOf(`process.env.${cleanupWriterGroup.flag}==="1"`);
    expect(admission).toBeGreaterThanOrEqual(0); expect(admission).toBeLessThan(source.indexOf("beforeAll("));
    expect(admission).toBeLessThan(source.indexOf("describe.skipIf("));
    expect(source).toContain("(!configuredNativeUrl()||PLATFORM_SCHEMA_VERSION<15)");
    expect(source).toContain("&&!!url.port"); expect(source).toContain('openPlatformDb({kind:"postgres"');
    expect(source).toContain("if(roles[0]?.n!==3)");
  });

  it("rejects every missing, nonpassing, foreign, PGlite, malformed or substituted native cleanup identity", () => {
    const required = cleanupWriterNamed(); expect(reportFailures(required, contractReport(required), root)).toEqual([]);
    for (const missing of required) {
      expect(reportFailures(required, contractReport(required.filter(item => item.id !== missing.id)), root), missing.id).toHaveLength(1);
      for (const status of ["failed", "skipped", "pending", "todo", "unknown"]) {
        const report = contractReport(required); report.testResults[0].assertionResults.find(item => item.title === missing.test)!.status = status;
        expect(reportFailures(required, report, root).length, missing.id).toBeGreaterThan(0);
      }
      for (const suite of [cleanupWriterGroup.suite.replace("postgres", "pglite"), cleanupWriterGroup.suite.replace("postgres", "postgres-replica"), "unrelated cleanup [postgres]", "native cleanup writer barrier ['postgres\"]"]) {
        const report = contractReport(required); report.testResults[0].assertionResults.find(item => item.title === missing.test)!.ancestorTitles = [suite];
        expect(reportFailures(required, report, root), missing.id).toHaveLength(1);
      }
      const foreign = contractReport(required); foreign.testResults[0].assertionResults = foreign.testResults[0].assertionResults.filter(item => item.title !== missing.test);
      foreign.testResults.push({ name: path.resolve(root, "tests/controlplane/foreign-cleanup-writer.test.ts"), status: "passed", assertionResults: [{ title: missing.test!, fullName: `${cleanupWriterGroup.suite} ${missing.test}`, ancestorTitles: [cleanupWriterGroup.suite], status: "passed" }] });
      expect(reportFailures(required, foreign, root), missing.id).toHaveLength(1);
      const malformed = contractReport(required); malformed.testResults[0].assertionResults.find(item => item.title === missing.test)!.fullName = "";
      expect(reportFailures(required, malformed, root)).toEqual(["Malformed Vitest assertion evidence"]);
      const substituted = contractReport(required); substituted.testResults[0].assertionResults.find(item => item.title === missing.test)!.title = "one passing cleanup projection";
      expect(reportFailures(required, substituted, root), missing.id).toHaveLength(1);
      const repeated = contractReport(required.filter(item => item.id !== missing.id)); repeated.testResults[0].assertionResults.push({ ...repeated.testResults[0].assertionResults[0] });
      expect(reportFailures(required, repeated, root), missing.id).toHaveLength(1);
    }
  });

  it("retains literal cleanup obligations after source deletion and refuses zero, duplicate, failed or reduced reports", () => {
    const sourceRoot = modelRoot(path.join(scratch, "native-cleanup-"));
    for (const directory of ["tests/controlplane", "tests/capabilities", "tests/reconcile"]) fs.mkdirSync(path.join(sourceRoot, directory), { recursive: true });
    const file = path.join(sourceRoot, cleanupWriterGroup.file), source = fs.readFileSync(path.join(root, cleanupWriterGroup.file), "utf8");
    fs.writeFileSync(file, source);
    const before = cleanupWriterNamed(sourceRoot); expect(before).toEqual(cleanupWriterNamed());
    expect(requirementsFor("platform-postgres", sourceRoot)).toContainEqual({ ...cleanupWriterDiscovered, id: requirementId("platform-postgres", cleanupWriterDiscovered) });
    fs.writeFileSync(file, source.replaceAll('kind:"postgres"', 'kind:"pglite"'));
    expect(createHash("sha256").update(fs.readFileSync(file)).digest("hex")).not.toBe(cleanupWriterGroup.sourceSha256);
    expect(cleanupWriterNamed(sourceRoot)).toEqual(before);
    fs.unlinkSync(file); expect(cleanupWriterNamed(sourceRoot)).toEqual(before);
    expect(requirementsFor("platform-postgres", sourceRoot).some(item => item.id === requirementId("platform-postgres", cleanupWriterDiscovered))).toBe(false);
    expect(reportFailures(before, { success: true, testResults: [] }, sourceRoot)).toHaveLength(61);
    for (const report of [null, {}, { success: true }, { ...contractReport(before), success: false }, { success: true, testResults: [{ name: path.resolve(root, cleanupWriterGroup.file) }] }]) {
      expect(reportFailures(before, report, root).length).toBeGreaterThan(0);
    }
    const suiteOnly = contractReport(before); suiteOnly.testResults[0].assertionResults = [{ title: "one passing projected cleanup", fullName: "one passing projected cleanup", ancestorTitles: [], status: "passed" }];
    expect(reportFailures(before, suiteOnly, root)).toHaveLength(61);
    const duplicate = contractReport(before); duplicate.testResults.push(duplicate.testResults[0]);
    expect(reportFailures(before, duplicate, root)).toEqual(["Duplicate Vitest file evidence"]);
    expect(reportFailures(before, { ...contractReport(before), numTotalTests: 0 }, root)).toEqual(["Inconsistent Vitest report counts"]);
    expect(reportFailures(before, { ...contractReport(before), numFailedTests: 1 }, root)).toEqual(["Inconsistent Vitest report counts"]);
    expect(reportFailures([], contractReport(before), root)).toEqual(["No required scenarios found"]);
    expect(reportFailures(before, { ...contractReport([]), lane: "platform-postgres", requirements: [] }, root)).toHaveLength(61);
  });
});


// Source/report models only. They do not provision PostgreSQL or prove native execution.
const workflowNativeGroups = [
  { file: "tests/platform/approved-source-runtime.test.ts", flag: "ZENITH_TEST_APPROVED_SOURCE_RUNTIME_REQUIRED" },
  { file: "tests/platform/aws-bootstrap-preflight-admission.test.ts", flag: "ZENITH_TEST_AWS_PREFLIGHT_REQUIRED" },
  { file: "tests/platform/composition.test.ts", flag: "ZENITH_TEST_SOURCE_FIXTURE_REQUIRED" },
  { file: "tests/platform/current-dispatch-requirement.test.ts", flag: "ZENITH_TEST_PLAN_PRODUCT_AUTHORITY_REQUIRED" },
  { file: "tests/platform/kubernetes-vault-target.test.ts", flag: "ZENITH_TEST_KUBERNETES_VAULT_TARGET_REQUIRED" },
  { file: "tests/platform/source-bundle-azure.test.ts", flag: "ZENITH_TEST_SOURCE_FIXTURE_REQUIRED" },
  { file: "tests/platform/source-bundle-composition.test.ts", flag: "ZENITH_TEST_SOURCE_FIXTURE_REQUIRED" },
  { file: "tests/platform/source-bundle-github.test.ts", flag: "ZENITH_TEST_SOURCE_FIXTURE_REQUIRED" },
] as const;
const workflowNativeFlags = [...new Set(workflowNativeGroups.map(group => group.flag))];
interface WorkflowNativeStep { name?: string; run?: string; if?: string; "continue-on-error"?: boolean; env?: Record<string, string> }
interface WorkflowNativeJob {
  services?: { postgres?: { image?: string; env?: Record<string, string>; ports?: string[]; options?: string } };
  env?: Record<string, string>; steps: WorkflowNativeStep[]; if?: string; "continue-on-error"?: boolean;
}
const workflowNativeJob = (load(fs.readFileSync(path.join(root, ".github/workflows/ci.yml"), "utf8")) as { jobs: { workflows: WorkflowNativeJob } }).jobs.workflows;
const workflowPlatformUrl = "postgresql://postgres:zenith-ci-throwaway@127.0.0.1:5432/zenith_platform_ci";
const workflowSupabaseUrl = "postgresql://postgres:zenith-ci-throwaway@127.0.0.1:5432/zenith_ci";
const workflowNativeCommands = [
  "psql --quiet --set ON_ERROR_STOP=1 --command 'create database zenith_platform_ci' \"$SUPABASE_DB_URL\"",
  "node node_modules/tsx/dist/cli.mjs scripts/agent/apply-schema.ts",
  "bash scripts/ci/apply-platform-migrations.sh",
  "bash scripts/ci/apply-supabase-migrations.sh",
  "node scripts/ci/run-gate.mjs workflows --run",
] as const;
/** Check this job's exact existing canonical prerequisites; never a report or runtime validator. */
function workflowNativeSetupProblems(job: WorkflowNativeJob): string[] {
  const problems: string[] = [], service = job.services?.postgres;
  if (job.if !== undefined || job["continue-on-error"] !== undefined) problems.push("conditional native job");
  if (service?.image !== "postgres:16.15-alpine@sha256:cf78e76683b9ca8c5733cbbdce6c9262b45b6767934dd0a95e671f9a0fc20685"
    || JSON.stringify(service.env) !== JSON.stringify({ POSTGRES_USER: "postgres", POSTGRES_PASSWORD: "zenith-ci-throwaway", POSTGRES_DB: "zenith_ci" })
    || JSON.stringify(service.ports) !== JSON.stringify(["5432:5432"])
    || service.options?.trim() !== '--health-cmd "pg_isready --username postgres --dbname zenith_ci" --health-interval 5s --health-timeout 5s --health-retries 30') problems.push("native service");
  if (job.env?.ZENITH_TEST_PLATFORM_PG_URL !== workflowPlatformUrl || job.env?.SUPABASE_DB_URL !== workflowSupabaseUrl
    || job.env?.ZENITH_PLATFORM_DB !== undefined || job.env?.ZENITH_PLATFORM_DB_URL !== undefined) problems.push("owning database targets");
  for (const flag of workflowNativeFlags) if (job.env?.[flag] !== "1") problems.push(flag);
  let previous = job.steps.findIndex(step => step.run === "npm ci --ignore-scripts");
  if (previous < 0) problems.push("locked dependencies");
  for (const command of workflowNativeCommands) {
    const matches = job.steps.flatMap((step, index) => step.run === command ? [index] : []);
    const index = matches[0], step = job.steps[index];
    if (matches.length !== 1 || index <= previous || step?.if !== undefined || step?.["continue-on-error"] !== undefined
      || step?.env !== undefined) problems.push(command);
    previous = index;
  }
  for (const command of ["node scripts/ci/lane-report.mjs workflows .data-ci-lane/workflows-lane.json",
    "node scripts/ci/run-gate.mjs workflows --validate .data-ci-lane/workflows-lane.json --require-execution"]) {
    const matches = job.steps.filter(step => step.run === command);
    if (matches.length !== 1 || matches[0].if !== "always()" || matches[0]["continue-on-error"] !== undefined) problems.push(command);
  }
  return problems;
}

describe("workflow native PostgreSQL prerequisites [source/report models]", () => {
  it("keeps all 58 workflow identities and exact native source flags while declaring real PostgreSQL", () => {
    const manifest = manifestFor("workflows", root);
    expect(manifest.requirements).toHaveLength(113);
    expect(priorCriticalScheduleWorkflowRequirements()).toHaveLength(60);
    expect(priorWave2WorkflowRequirements()).toHaveLength(58);
    expect(manifest.requirements.filter(item => wave2WorkflowIds.has(item.id)).map(item => item.id)).toEqual([...wave2WorkflowIds]);
    expect(WORKFLOW_NATIVE_POSTGRES_FILES).toEqual(workflowNativeGroups.map(group => group.file));
    expect(new Set(manifest.requirements.map(item => item.id)).size).toBe(113);
    expect(createHash("sha256").update(JSON.stringify(priorWave2WorkflowRequirements().map(item => item.id).sort())).digest("hex"))
      .toBe("d3a15adf854819fd8577c3b55b48dd55640d6522bdc57cad2c707c867ffecad3");
    expect(manifest.tools).toEqual({ node: "22.23.3", postgres: "16.15", temporal: "1.9.1" });
    expect(manifest.prerequisites).toContain("PostgreSQL 16.15: fresh separate loopback databases at ZENITH_TEST_PLATFORM_PG_URL (platform) and SUPABASE_DB_URL (Supabase)");
    expect(manifest.prerequisites.some(value => value.includes("scripts/agent/apply-schema.ts before scripts/ci/apply-platform-migrations.sh"))).toBe(true);
    expect(manifest.prerequisites.some(value => value.includes("scripts/ci/apply-supabase-migrations.sh"))).toBe(true);
    for (const { file, flag } of workflowNativeGroups) {
      expect(manifest.env[flag]).toBe("1");
      expect(workflowNativeJob.env?.[flag]).toBe("1");
      expect(manifest.requirements.filter(item => item.file === file)).toEqual([{ file, id: requirementId("workflows", { file }) }]);
      const source = fs.readFileSync(path.join(root, file), "utf8");
      expect(source).toContain(`process.env.${flag}`);
      expect(source).toContain("!PG_URL");
      expect(source).toContain("throw new Error(");
    }
  });

  it("requires separate native targets and mandatory agent-before-platform canonical initialization", () => {
    expect(workflowNativeSetupProblems(workflowNativeJob)).toEqual([]);
    const script = fs.readFileSync(path.join(root, "scripts/agent/apply-schema.ts"), "utf8");
    expect(script).toContain("assertAgentLaneUrl(raw)");
    expect(script).toContain("await admitLaneRoles(client, raw)");
    expect(script).toContain("await ports.verify(client)");
  });

  it.each(["missing service", "floating service", "foreign URL", "same database", "missing flag", "missing agent initializer",
    "platform before agent", "optional initializer", "waived run", "missing execution binding"] as const)("refuses a %s prerequisite source model", (change) => {
    const job = structuredClone(workflowNativeJob);
    const agent = job.steps.findIndex(step => step.run === workflowNativeCommands[1]);
    const platform = job.steps.findIndex(step => step.run === workflowNativeCommands[2]);
    const run = job.steps.findIndex(step => step.run === workflowNativeCommands[4]);
    if (change === "missing service") delete job.services;
    if (change === "floating service" && job.services?.postgres) job.services.postgres.image = "postgres:16-alpine";
    if (change === "foreign URL" && job.env) job.env.ZENITH_TEST_PLATFORM_PG_URL = workflowPlatformUrl.replace("127.0.0.1", "foreign.invalid");
    if (change === "same database" && job.env) job.env.SUPABASE_DB_URL = workflowPlatformUrl;
    if (change === "missing flag" && job.env) delete job.env.ZENITH_TEST_PLAN_PRODUCT_AUTHORITY_REQUIRED;
    if (change === "missing agent initializer") job.steps.splice(agent, 1);
    if (change === "platform before agent") [job.steps[agent], job.steps[platform]] = [job.steps[platform], job.steps[agent]];
    if (change === "optional initializer") job.steps[agent].if = "hashFiles('scripts/agent/apply-schema.ts') != ''";
    if (change === "waived run") job.steps[run]["continue-on-error"] = true;
    if (change === "missing execution binding") {
      const validate = job.steps.find(step => step.run?.includes("workflows --validate"));
      if (validate) validate.run = validate.run?.replace(" --require-execution", "");
    }
    expect(workflowNativeSetupProblems(job).length).toBeGreaterThan(0);
  });

  it.each(workflowNativeGroups)("keeps $file mandatory if its native source is deleted", ({ file }) => {
    const sourceRoot = modelRoot(path.join(scratch, "workflow-native-deleted-"));
    for (const directory of ["tests/workflows", "tests/platform"]) fs.cpSync(path.join(root, directory), path.join(sourceRoot, directory), { recursive: true });
    const before = requirementsFor("workflows", sourceRoot);
    fs.unlinkSync(path.join(sourceRoot, file));
    const after = requirementsFor("workflows", sourceRoot);
    expect(after.map(item => item.id).sort()).toEqual(before.map(item => item.id).sort());
    const required = after.filter(item => item.file === file);
    expect(required).toEqual([{ file, id: requirementId("workflows", { file }) }]);
    expect(reportFailures(required, { success: true, testResults: [] }, sourceRoot)).toHaveLength(1);
  });

  it.each(workflowNativeGroups)("rejects missing, failed, skipped, zero and malformed $file reports", ({ file }) => {
    const requirements = requirementsFor("workflows", root);
    const baseline = contractReport(requirements);
    expect(reportFailures(requirements, baseline, root)).toEqual([]);
    const badReports = [
      { success: true, testResults: baseline.testResults.filter(item => item.name !== path.resolve(root, file)) },
      ...["failed", "pending", "skipped", "unknown"].map(status => {
        const report = structuredClone(baseline);
        const entry = report.testResults.find(item => item.name === path.resolve(root, file))!;
        entry.assertionResults[0].status = status;
        return report;
      }),
      ...[[], undefined].map(assertions => {
        const report = structuredClone(baseline);
        return { ...report, testResults: report.testResults.map(item => item.name === path.resolve(root, file) ? { ...item, assertionResults: assertions } : item) };
      }),
    ];
    for (const report of badReports) expect(reportFailures(requirements, report, root).length).toBeGreaterThan(0);
    const duplicate = structuredClone(baseline); duplicate.testResults.push(duplicate.testResults.find(item => item.name === path.resolve(root, file))!);
    expect(reportFailures(requirements, duplicate, root)).toEqual(["Duplicate Vitest file evidence"]);
    expect(reportFailures(requirements, { ...baseline, numTotalTests: 0 }, root)).toEqual(["Inconsistent Vitest report counts"]);
    expect(reportFailures([], baseline, root)).toEqual(["No required scenarios found"]);
    expect(reportFailures(requirements, { ...baseline, success: false }, root).length).toBeGreaterThan(0);
  });

  it("isolates all production DB sources only inside the two absent-configuration fixtures", () => {
    const opener = fs.readFileSync(path.join(root, "src/lib/controlplane/db/open.ts"), "utf8");
    expect(opener).toContain("const explicit = env.ZENITH_PLATFORM_DB?.trim().toLowerCase()");
    expect(opener).toContain("const url = env.ZENITH_PLATFORM_DB_URL?.trim() || env.SUPABASE_DB_URL?.trim() || undefined");
    for (const [file, title] of [
      ["tests/platform/agent-ports.test.ts", "keeps the incident engine unavailable when platform configuration is absent"],
      ["tests/platform/composition.test.ts", "leaves the legacy app and reconcile 503 behavior alone without platform configuration"],
    ]) {
      const source = fs.readFileSync(path.join(root, file), "utf8");
      const start = source.indexOf(`it(${JSON.stringify(title)}`), end = source.indexOf("\n  });", start);
      expect(start).toBeGreaterThanOrEqual(0); expect(end).toBeGreaterThan(start);
      const body = source.slice(start, end);
      for (const name of ["ZENITH_PLATFORM_DB", "ZENITH_PLATFORM_DB_URL", "SUPABASE_DB_URL"]) expect(body).toContain(`vi.stubEnv(${JSON.stringify(name)}, "")`);
      expect(source).toContain("vi.unstubAllEnvs()");
      expect(body).not.toContain('vi.stubEnv("ZENITH_TEST_PLATFORM_PG_URL"');
    }
  });
});


// These are validator/source models, never actual command/SQL/settlement evidence.
describe("current platform discovery successors [report models]", () => {
  it("retains exactly six declared successors in the strict 1118 manifest and every historical 1112 identity", () => {
    expect(currentSuccessorPlatformIds).toEqual([
      "platform-postgres:tests/controlplane/incident-stability.test.ts:cf040b5e5c94",
      "platform-postgres:tests/controlplane/machine-runbooks.test.ts:48256d3185de",
      "platform-postgres:tests/capabilities/field-ownership-broker.test.ts:25d4762caf8a",
      "platform-postgres:tests/controlplane/ownership-transfers.test.ts:9a92131565d1",
      "platform-postgres:tests/controlplane/release-pipelines.test.ts:b09ca3c28bcc",
      "platform-postgres:tests/capabilities/portability-broker.test.ts:0285e36ab39f",
    ]);
    const current = priorHardeningPlatformRequirements();
    const added = currentSuccessorPlatformCohort.map(item => ({ ...item, id: requirementId("platform-postgres", item) }));
    expect(current.filter(item => currentSuccessorPlatformIds.includes(item.id)).sort((a, b) => a.id.localeCompare(b.id))).toEqual(added.sort((a, b) => a.id.localeCompare(b.id)));
    const historical = priorCurrentSuccessorPlatformRequirements();
    expect(historical).toHaveLength(1112);
    expect(current).toHaveLength(1118); expect(new Set(current.map(item => item.id)).size).toBe(1118);
    expect(current.map(item => item.id).sort()).toEqual([...historical, ...added].map(item => item.id).sort());
    expect(withoutIncomingPlatform(manifestFor("platform-postgres", root).requirements).filter(item => !hardeningPlatformIds.includes(item.id))).toEqual(current);
    expect(reportFailures(current, contractReport(current), root)).toEqual([]);
  });

  it("refuses absent, failed, skipped and PGlite evidence for every current successor", () => {
    const current = requirementsFor("platform-postgres", root);
    for (const id of currentSuccessorPlatformIds) {
      const item = current.find(value => value.id === id)!;
      // Named native cases can also satisfy their generic suite requirement.
      // Remove the whole owned file, or change every matching suite assertion.
      const absent = contractReport(current);
      absent.testResults = absent.testResults.filter(file => file.name !== path.resolve(root, item.file));
      expect(reportFailures([item], absent, root), id).toHaveLength(1);
      expect(reportFailures(current, absent, root).length, id).toBeGreaterThan(0);
      for (const status of ["failed", "pending", "skipped", "todo"]) {
        const report = contractReport(current);
        const assertions = report.testResults.find(file => file.name === path.resolve(root, item.file))!.assertionResults;
        const matching = assertions.filter(assertion => assertionMatches(item, assertion));
        expect(matching.length, id).toBeGreaterThan(0);
        for (const assertion of matching) assertion.status = status;
        expect(reportFailures([item], report, root), `${id}: ${status}`).toHaveLength(1);
        expect(reportFailures(current, report, root).length, `${id}: ${status}`).toBeGreaterThan(0);
      }
      const substitute = contractReport(current);
      const assertions = substitute.testResults.find(file => file.name === path.resolve(root, item.file))!.assertionResults;
      const matching = assertions.filter(assertion => assertionMatches(item, assertion));
      expect(matching.length, id).toBeGreaterThan(0);
      for (const assertion of matching) {
        assertion.ancestorTitles = [item.suite!.replace("postgres", "pglite")];
        assertion.fullName = [...assertion.ancestorTitles, assertion.title].join(" ");
      }
      expect(reportFailures([item], substitute, root), id).toHaveLength(1);
      expect(reportFailures(current, substitute, root).length, id).toBeGreaterThan(0);
    }
  });

  it("filters only exact historical IDs and keeps an unknown successor visible", () => {
    const unknown = { file: currentSuccessorPlatformCohort[0].file, suite: "incident stability additional native scope [postgres]", postgres: true };
    const required = { ...unknown, id: requirementId("platform-postgres", unknown) };
    const current = requirementsFor("platform-postgres", root);
    expect(withoutCurrentSuccessorCohort(withoutIncomingPlatform([...current, required])).filter(item => !hardeningPlatformIds.includes(item.id))).toEqual([...priorCurrentSuccessorPlatformRequirements(), required]);
    expect(reportFailures([...current, required], contractReport(current), root)).toHaveLength(1);
  });

  it("exposes deleted discovery sources while preserving every historical literal requirement", () => {
    const sourceRoot = modelRoot(path.join(scratch, "successor-source-"));
    copyDiscoverySources(sourceRoot);
    for (const item of currentSuccessorPlatformCohort) {
      const before = requirementsFor("platform-postgres", sourceRoot);
      const id = requirementId("platform-postgres", item);
      expect(before).toContainEqual({ ...item, id });
      fs.unlinkSync(path.join(sourceRoot, item.file));
      try {
        const after = requirementsFor("platform-postgres", sourceRoot);
        expect(after.some(value => value.id === id)).toBe(false);
        expect(after).toHaveLength(1176);
        expect(after.filter(value => !mixedRunStorePlatformIds.has(value.id))).toHaveLength(1171);
        expect(after.filter(value => !mixedRunStorePlatformIds.has(value.id) && !wave5PlatformIds.has(value.id))).toHaveLength(1168);
        expect(priorCurrentSuccessorPlatformRequirements(sourceRoot)).toEqual(priorCurrentSuccessorPlatformRequirements());
      } finally {
        // Each deletion still begins with the complete tree; restore its exact
        // bytes instead of copying all unrelated source files for every case.
        fs.copyFileSync(path.join(root, item.file), path.join(sourceRoot, item.file));
      }
      // Discovery itself cannot retain a deleted suite. Current source-presence
      // assertions above fail if it disappears; literal admission is a follow-up.
    }
  });
});

describe("registered incident and ownership hardening [report models]", () => {
  it("requires exactly five new native names and every original 1118 identity in the complete 1124 manifest", () => {
    expect(hardeningPlatformIds).toEqual([
      "platform-postgres:tests/controlplane/ownership-transfers.test.ts:e7a7dd4a7cfd",
      "platform-postgres:tests/controlplane/ownership-transfers.test.ts:c9862619d543",
      "platform-postgres:tests/controlplane/ownership-transfers.test.ts:6dc3043ea500",
      "platform-postgres:tests/controlplane/migrations.test.ts:4abeb5f3b239",
      "platform-postgres:tests/controlplane/migrations.test.ts:ce5f01310543",
    ]);
    const current = requirementsFor("platform-postgres", root), previous = priorHardeningPlatformRequirements();
    const added = INCIDENT_OWNERSHIP_HARDENING_POSTGRES_REQUIREMENTS.map(item => ({ ...item, id: requirementId("platform-postgres", item) }));
    expect(previous).toHaveLength(1118); expect(new Set(previous.map(item => item.id)).size).toBe(1118);
    expect(current).toHaveLength(1177); expect(new Set(current.map(item => item.id)).size).toBe(1177);
    expect(current.filter(item => hardeningPlatformIds.includes(item.id))).toEqual(added);
    expect(withoutIncomingPlatform(current).map(item => item.id).sort()).toEqual([...previous, ...added].map(item => item.id).sort());
    expect(priorCurrentSuccessorPlatformRequirements()).toHaveLength(1112);
    expect(manifestFor("platform-postgres", root).requirements).toEqual(current);
    expect(reportFailures(current, contractReport(current), root)).toEqual([]);
  });

  it("rejects missing, failed, skipped and PGlite replacement of each registered hardening case", () => {
    const current = requirementsFor("platform-postgres", root);
    for (const id of hardeningPlatformIds) {
      const item = current.find(value => value.id === id);
      if (!item?.test || !item.suite) throw new Error("Registered hardening requirement is unavailable.");
      expect(reportFailures(current, contractReport(current.filter(value => value.id !== id)), root), id).toHaveLength(1);
      for (const status of ["failed", "pending", "skipped", "todo"]) {
        const report = contractReport(current);
        const assertion = report.testResults.find(file => file.name === path.resolve(root, item.file))?.assertionResults.find(value => value.title === item.test);
        if (!assertion) throw new Error("Exact hardening evidence is unavailable.");
        assertion.status = status;
        expect(reportFailures(current, report, root).length, `${id}: ${status}`).toBeGreaterThan(0);
      }
      const report = contractReport(current);
      const assertion = report.testResults.find(file => file.name === path.resolve(root, item.file))?.assertionResults.find(value => value.title === item.test);
      if (!assertion) throw new Error("Exact hardening evidence is unavailable.");
      assertion.ancestorTitles = [item.suite.replace("postgres", "pglite")];
      assertion.fullName = [...assertion.ancestorTitles, assertion.title].join(" ");
      expect(reportFailures(current, report, root), id).toHaveLength(1);
    }
  });

  it("retains every literal hardening requirement when either native source is deleted", () => {
    for (const file of new Set(INCIDENT_OWNERSHIP_HARDENING_POSTGRES_REQUIREMENTS.map(item => item.file))) {
      const sourceRoot = modelRoot(path.join(scratch, "hardening-source-"));
      copyDiscoverySources(sourceRoot);
      const before = requirementsFor("platform-postgres", sourceRoot).filter(item => hardeningPlatformIds.includes(item.id));
      fs.unlinkSync(path.join(sourceRoot, file));
      const after = requirementsFor("platform-postgres", sourceRoot).filter(item => hardeningPlatformIds.includes(item.id));
      expect(after).toEqual(before); expect(after).toHaveLength(5);
      expect(reportFailures(after, { success: true, testResults: [] }, root)).toHaveLength(5);
    }
  });
});

// These are validator/source models, never actual command/SQL/settlement evidence.
describe("mandatory saved builtin settlement cases [report models]", () => {
  it("adds exactly 54 literal cases once and preserves every one of the 1058 predecessor IDs", () => {
    const required = settlementNamed();
    expect(SAVED_PLAN_SETTLEMENT_POSTGRES_REQUIREMENTS).toHaveLength(54);
    expect(required).toHaveLength(54); expect(new Set(required.map(item => item.id)).size).toBe(54);
    const historical = priorCurrentSuccessorPlatformRequirements();
    expect(historical).toHaveLength(1112); expect(new Set(historical.map(item => item.id)).size).toBe(1112);
    const previous = priorSettlementPlatformRequirements();
    expect(previous).toHaveLength(1058);
    expect(createHash("sha256").update(JSON.stringify(previous.map(item => item.id).sort())).digest("hex")).toBe("96d2bd4f33c4cc42b1e0df6ce4bb13537f92db7132dd43d2250b9315191e24cb");
    expect(historical).toEqual([...previous, ...required]);
    expect(cleanupWriterNamed()).toHaveLength(61); expect(priorCleanupPlatformRequirements()).toHaveLength(1012);
    expect(manifestFor("postgres", root).requirements).toHaveLength(93);
    expect(requirementsFor("workflows", root)).toHaveLength(113);
    expect(priorCriticalScheduleWorkflowRequirements()).toHaveLength(60);
    expect(priorWave2WorkflowRequirements()).toHaveLength(58);
    expect(priorServiceLinuxCases(linuxGuestManifest().requiredCases)).toHaveLength(127); expect(linuxGuestManifest().allowedSkips).toHaveLength(3);
    expect(packagedWorkerManifest().requiredChecks).toHaveLength(22);
    for (const lane of Object.keys(GATE_LANES).filter(name => name !== "platform-postgres")) {
      expect(manifestFor(lane, root).env[settlementGroup.flag]).toBeUndefined();
      expect(requirementsFor(lane, root).some(item => required.some(addition => addition.id === item.id))).toBe(false);
    }
  });

  it("binds all 115 source cases while preserving the original 46 and refusing unavailable native prerequisites before hooks", () => {
    const source = fs.readFileSync(path.join(root, settlementGroup.file), "utf8");
    expectNativePlanFixtureSource(settlementGroup.file, source);
    const all = declaredLiteralTests(settlementGroup.file, settlementGroup.suite);
    const retained = new Set(cleanupWriterNamed().map(item => item.test));
    const names = all.filter(name => !retained.has(name)), required = settlementNamed();
    expect(all).toHaveLength(115); expect(new Set(all).size).toBe(115);
    expect(names).toHaveLength(54); expect(required.map(item => item.test)).toEqual(names);
    expect(createHash("sha256").update(source).digest("hex")).toBe(settlementGroup.sourceSha256);
    expect(createHash("sha256").update(names.join("\n") + "\n").digest("hex")).toBe(settlementGroup.namesSha256);
    for (const item of required) expect(item).toMatchObject({ file: settlementGroup.file, suite: settlementGroup.suite, backend: "postgres" });
    const admission = source.indexOf(`process.env.${settlementGroup.flag}==="1"`);
    expect(admission).toBeGreaterThanOrEqual(0); expect(admission).toBeLessThan(source.indexOf("beforeAll("));
    expect(source).toContain("PLATFORM_SCHEMA_VERSION<16"); expect(source).toContain("!tofuOnPath()");
    expect(source).toContain('process.env.ZENITH_TEST_TOFU_NETWORK!=="1"');
    expect(source).toContain('openPlatformDb({kind:"postgres"'); expect(source).toContain("&&!!url.port");
    const manifest = manifestFor("platform-postgres", root);
    expect(manifest.env[settlementGroup.flag]).toBe("1");
    expect(manifest.prerequisites.some(value => value.startsWith(`${settlementGroup.flag}=1;`))).toBe(true);
    expect(manifest.excludeFiles).not.toContain(settlementGroup.file); expect(manifest.command).not.toContain("--passWithNoTests");
  });

  it("refuses each missing failed skipped pending foreign and PGlite settlement observation", () => {
    const required = settlementNamed(); expect(reportFailures(required, contractReport(required), root)).toEqual([]);
    for (const item of required) {
      const missing = contractReport(required); missing.testResults[0].assertionResults = missing.testResults[0].assertionResults.filter(assertion => assertion.title !== item.test);
      expect(reportFailures(required, missing, root), item.id).toHaveLength(1);
      for (const status of ["failed", "skipped", "pending", "todo"]) {
        const report = contractReport(required); report.testResults[0].assertionResults.find(assertion => assertion.title === item.test)!.status = status;
        expect(reportFailures(required, report, root), `${item.id}: ${status}`).toHaveLength(1);
      }
      for (const suite of [settlementGroup.suite.replace("postgres", "pglite"), settlementGroup.suite.replace("postgres", "postgres-replica"), "foreign settlement [postgres]"]) {
        const report = contractReport(required), assertion = report.testResults[0].assertionResults.find(value => value.title === item.test)!;
        assertion.ancestorTitles = [suite]; assertion.fullName = `${suite} ${item.test}`;
        expect(reportFailures(required, report, root), `${item.id}: ${suite}`).toHaveLength(1);
      }
    }
  });

  it("retains every static additive requirement after the native source is renamed or deleted", () => {
    const sourceRoot = modelRoot(path.join(os.tmpdir(), "zenith-settlement-manifest-"));
    try {
      for (const directory of ["tests/controlplane", "tests/capabilities", "tests/reconcile"]) fs.mkdirSync(path.join(sourceRoot, directory), { recursive: true });
      const file = path.join(sourceRoot, settlementGroup.file), source = fs.readFileSync(path.join(root, settlementGroup.file), "utf8");
      fs.writeFileSync(file, source); const before = settlementNamed(sourceRoot); expect(before).toHaveLength(54);
      fs.writeFileSync(file, source.replaceAll(settlementGroup.suite, "unrelated [pglite]")); expect(settlementNamed(sourceRoot)).toEqual(before);
      fs.unlinkSync(file); expect(settlementNamed(sourceRoot)).toEqual(before);
      expect(reportFailures(before, contractReport([]), root)).toHaveLength(54);
    } finally { fs.rmSync(sourceRoot, { recursive: true, force: true }); }
  });

  it("refuses zero malformed duplicate inconsistent file and output-only settlement reports", () => {
    const required = settlementNamed();
    for (const report of [null, {}, { success: true }, { ...contractReport(required), success: false }, { success: true, testResults: [{ name: path.resolve(root, settlementGroup.file) }] }])
      expect(reportFailures(required, report, root).length).toBeGreaterThan(0);
    const duplicate = contractReport(required); duplicate.testResults.push({ ...duplicate.testResults[0] });
    expect(reportFailures(required, duplicate, root)).toEqual(["Duplicate Vitest file evidence"]);
    for (const counts of [{numTotalTests:0},{numFailedTests:1}]) expect(reportFailures(required, { ...contractReport(required), ...counts }, root)).toEqual(["Inconsistent Vitest report counts"]);
    const forged = { success: true, testResults: [], lane: "platform-postgres", requirements: required.map(item => ({ ...item, status: "passed" })), cleanupComplete: true };
    expect(reportFailures(required, forged, root)).toHaveLength(54);
  });
});

// Synthetic Go event streams exercise the unchanged validator; they are never native execution evidence.
describe("mandatory native service.configure observations [report models]", () => {
  type Event = { Action: string; Package: string; Test?: string };
  const passedExit = { status: 0, signal: null, observed: true };
  const serviceContract = { requiredCases: LINUX_GUEST_SERVICE_CASES,
    requiredPackages: [...new Set(LINUX_GUEST_SERVICE_CASES.map(item => item.package))], noTestPackages: [] as string[], allowedSkips: [] };
  const stream = (events: Event[]) => events.map(event => JSON.stringify(event)).join("\n") + "\n";
  function completeEvents(requiredCases: readonly NativeGuestCase[], requiredPackages: readonly string[]): Event[] {
    const events: Event[] = [];
    for (const packageName of requiredPackages) {
      events.push({ Action: "start", Package: packageName });
      const tree = new Map<string, Set<string>>();
      const names = requiredCases.filter(item => item.package === packageName).map(item => item.test);
      for (const name of names.length ? names : ["TestExistingPackage"]) {
        const parts = name.split("/");
        for (let i = 0; i < parts.length; i++) {
          const parent = parts.slice(0, i).join("/");
          if (!tree.has(parent)) tree.set(parent, new Set());
          tree.get(parent)?.add(parts.slice(0, i + 1).join("/"));
        }
      }
      const visit = (name: string) => {
        events.push({ Action: "run", Package: packageName, Test: name });
        for (const child of tree.get(name) ?? []) visit(child);
        events.push({ Action: "pass", Package: packageName, Test: name });
      };
      for (const name of tree.get("") ?? []) visit(name);
      events.push({ Action: "pass", Package: packageName });
    }
    return events;
  }
  const serviceEvents = () => completeEvents(serviceContract.requiredCases, serviceContract.requiredPackages);

  it("adds exactly 25 fixed service observations and preserves the exact 127 predecessor IDs", () => {
    const manifest = linuxGuestManifest(), historical = priorServiceLinuxCases(manifest.requiredCases);
    expect(LINUX_GUEST_SERVICE_CASES).toHaveLength(25);
    expect(new Set(LINUX_GUEST_SERVICE_CASES.map(item => item.id)).size).toBe(25);
    expect(createHash("sha256").update(JSON.stringify(LINUX_GUEST_SERVICE_CASES.map(item => item.id).sort())).digest("hex")).toBe("ad13bf1b646b40e0c720aa7e42964ea453b04b25a43c11e6611055f0fecca3f1");
    expect(manifest.raceCases).toHaveLength(154); expect(manifest.requiredCases).toHaveLength(159);
    expect(new Set(manifest.requiredCases.map(item => item.id)).size).toBe(159);
    expect(priorServiceLinuxCases(manifest.raceCases)).toHaveLength(123); expect(historical).toHaveLength(127);
    expect(createHash("sha256").update(JSON.stringify(historical.map(item => item.id).sort())).digest("hex")).toBe("e406b4002c481023c55a418cbbfb369648f988033f4b8fa08f8d41e8dd8c51c1");
    expect(manifest.requiredCases.map(item => item.id).sort()).toEqual([...historical, ...LINUX_GUEST_SERVICE_CASES, ...LINUX_GUEST_RUNNER_UPDATE_CASES, ...LINUX_GUEST_PID1_CASES].map(item => item.id).sort());
    const future = { package: "future-package", test: "TestFuture", id: "linux-guest:future-package:TestFuture" };
    expect(priorServiceLinuxCases([...manifest.requiredCases, future])).toContainEqual(future);
    expect(manifest.packagePhase.requiredCases).toHaveLength(4); expect(manifest.packagePhase.allowedSkips).toEqual([]);
    expect(manifest.allowedSkips.map(item => item.test)).toEqual(["TestRealSystemctlAndJournalctl", "TestRealOpenTofuPlanShowApply", "TestRealOpenTofuWithProviderAndLockfile"]);
    expect(manifest.allowedSkips.some(item => LINUX_GUEST_SERVICE_CASES.some(required => required.package === item.package && required.test === item.test))).toBe(false);
    expect(manifest.goldenCases.map(item => item.test)).toEqual(["TestResultGoldens/file.write-filesystem", "TestResultGoldens/service.configure-filesystem"]);
    expect(packagedWorkerManifest().requiredChecks).toHaveLength(22); expect(manifestFor("postgres", root).requirements).toHaveLength(93);
  });

  it("binds fixed parent and child service identities to the reviewed Linux mapper sources", () => {
    const sources = [
    {
        "file": "go/internal/machine/ops/serviceconfigure_test.go",
        "sha256": "36a4f5a014d4a60d941db4faf17dfcf68d48152b9c054491820072d5b3e3e91f"
    },
    {
        "file": "go/internal/machine/ops/serviceconfigure_linux_test.go",
        "sha256": "bfb23728658dc0f61ac654aaca064301243b25f2baf16cf88af3aea6b3b1d692"
    },
    {
        "file": "go/internal/machine/serviceconfigure_test.go",
        "sha256": "afd78a9018627b9b34619b692409faef4ce62bcfe2e89f510dec12ffdb7e8731"
    },
    {
        "file": "go/internal/machine/executor_test.go",
        "sha256": "c2540ffc956ea944c376a716e4f42eef60a8f13df83239ebc853c3101dbaa86f"
    },
    {
        "file": "go/internal/machine/ops/results_golden_test.go",
        "sha256": "03ed1bdda90586982698b3e20afd13f8269f7aef4ec028e82c4ebc180c7d673c"
    },
    {
        "file": "go/internal/machine/ops/serviceconfigure_golden_linux_test.go",
        "sha256": "f62396b1a2eb64180318cb96f1572fbf18f936f9c1f9373c43c513beabdd496a"
    }
];
    for (const item of sources) expect(createHash("sha256").update(fs.readFileSync(path.join(root, item.file))).digest("hex"), item.file).toBe(item.sha256);
    for (const item of LINUX_GUEST_SERVICE_CASES.filter(item => !item.test.includes("/"))) {
      const declarations = sources.map(source => fs.readFileSync(path.join(root, source.file), "utf8")).join("\n");
      expect(declarations).toContain(`func ${item.test}(t *testing.T)`);
    }
    const native = fs.readFileSync(path.join(root, "go/internal/machine/ops/serviceconfigure_linux_test.go"), "utf8");
    expect(native).toContain('[]string{"create", "replace"}');
    expect(native).toContain('[]string{"prior-on-absent", "absence-on-existing"}');
    const golden = fs.readFileSync(path.join(root, "go/internal/machine/ops/serviceconfigure_golden_linux_test.go"), "utf8");
    expect(golden).toContain('const root = "/opt/zenith-file-write-golden"');
    expect(golden).toContain('if os.Geteuid() == 0');
    expect(golden).toContain('r.Data["transactionRef"] = "fw_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"');
    expect(fs.readFileSync(path.join(root, "go/internal/machine/ops/results_golden_test.go"), "utf8")).toContain('t.Run("service.configure-filesystem", compareServiceConfigureGolden)');
  });

  it("rejects each missing failed or skipped required service observation despite passing sibling evidence", () => {
    expect(validateGoEvents(stream(serviceEvents()), passedExit, serviceContract).verdict).toBe("passed");
    for (const item of LINUX_GUEST_SERVICE_CASES) {
      const missing = serviceEvents().filter(event => event.Package !== item.package || event.Test !== item.test);
      const absent = validateGoEvents(stream(missing), passedExit, serviceContract);
      expect(absent.verdict, item.id).toBe("failed"); expect(absent.required.find(value => value.id === item.id)?.status).toBe("missing");
      for (const status of ["fail", "skip"]) {
        const changed = serviceEvents().map(event => event.Package === item.package && event.Test === item.test && event.Action === "pass" ? { ...event, Action: status } : event);
        const result = validateGoEvents(stream(changed), passedExit, serviceContract);
        expect(result.verdict, `${item.id}: ${status}`).toBe("failed");
        expect(result.required.find(value => value.id === item.id)?.status).toBe(status === "fail" ? "failed" : "skipped");
      }
    }
  });

  it("refuses zero incomplete duplicate malformed and unobserved process outcomes for the complete service cohort", () => {
    const complete = stream(serviceEvents());
    for (const raw of ["", "\n", "{}\n", complete.slice(0, -1), stream([]), stream([...serviceEvents(), ...serviceEvents()])])
      expect(validateGoEvents(raw, passedExit, serviceContract).verdict).toBe("failed");
    for (const observation of [{ status: 1, signal: null, observed: true }, { status: null, signal: "SIGTERM", observed: true }, { status: 0, signal: null, observed: false }])
      expect(validateGoEvents(complete, observation, serviceContract).verdict).toBe("failed");
    const manifest = linuxGuestManifest(), events = completeEvents(manifest.raceCases, manifest.requiredPackages);
    for (const packageName of manifest.noTestPackages) events.push({ Action: "start", Package: packageName }, { Action: "skip", Package: packageName });
    expect(validateGoEvents(stream(events), passedExit, { ...manifest, requiredCases: manifest.raceCases }).verdict).toBe("passed");
    const missingServices = events.filter(event => !LINUX_GUEST_SERVICE_CASES.some(item => item.package === event.Package && item.test === event.Test));
    expect(validateGoEvents(stream(missingServices), passedExit, { ...manifest, requiredCases: manifest.raceCases }).verdict).toBe("failed");
  });

  it("retains every fixed service requirement after the trusted service source files are deleted", () => {
    const sourceRoot = modelRoot(path.join(scratch, "service-native-source-"));
    fs.mkdirSync(path.join(sourceRoot, "scripts/ci"), { recursive: true });
    fs.copyFileSync(path.join(root, "scripts/ci/gate-manifest.mjs"), path.join(sourceRoot, "scripts/ci/gate-manifest.mjs"));
    for (const file of ["scripts/ci/wave6-manifest.mjs", "scripts/ci/wave6-gates.json"]) fs.copyFileSync(path.join(root, file), path.join(sourceRoot, file));
    const sourceFiles = ["go/internal/machine/ops/serviceconfigure_test.go", "go/internal/machine/ops/serviceconfigure_linux_test.go", "go/internal/machine/serviceconfigure_test.go", "go/internal/machine/executor_test.go", "go/internal/machine/ops/results_golden_test.go", "go/internal/machine/ops/serviceconfigure_golden_linux_test.go"];
    for (const file of sourceFiles) {
      fs.mkdirSync(path.dirname(path.join(sourceRoot, file)), { recursive: true });
      fs.copyFileSync(path.join(root, file), path.join(sourceRoot, file));
    }
    const selected = () => {
      const result = spawnSync(process.execPath, ["scripts/ci/gate-manifest.mjs", "linux-guest"], { cwd: sourceRoot, encoding: "utf8" });
      expect(result.status).toBe(0); return JSON.parse(result.stdout) as ReturnType<typeof linuxGuestManifest>;
    };
    expect(selected().requiredCases).toEqual(linuxGuestManifest().requiredCases);
    for (const file of sourceFiles) fs.unlinkSync(path.join(sourceRoot, file));
    const after = selected(); expect(after.requiredCases).toEqual(linuxGuestManifest().requiredCases);
    expect(after.requiredCases.filter(item => serviceGuestIds.has(item.id))).toEqual(LINUX_GUEST_SERVICE_CASES);
    expect(validateGoEvents("", passedExit, { ...serviceContract, requiredCases: after.requiredCases.filter(item => serviceGuestIds.has(item.id)) }).verdict).toBe("failed");
    const runner = fs.readFileSync(path.join(root, "scripts/ci/run-guest-file-write-gate.mjs"), "utf8");
    expect(runner).toContain('step.id === "goldens" ? { requiredCases: manifest.goldenCases');
    expect(runner).toContain('step.id === "pid1-native" ? manifest.pid1Phase : step.id === "package-native" ? manifest.packagePhase : { ...manifest, requiredCases: manifest.raceCases }');
    expect(after.steps.find(step => step.id === "golden-diff")?.command).toEqual(["git", "diff", "--exit-code", "--", "internal/machine/testdata/results"]);
    expect(after.steps.find(step => step.id === "golden-status")?.command).toEqual(["git", "--no-optional-locks", "status", "--porcelain", "--", "internal/machine/testdata/results"]);
  });
});

// Synthetic report contracts never substitute for the two actual Temporal runs.
describe("mandatory owned critical scheduling [source/report models]", () => {
  const file = "tests/workflows/critical-schedule.test.ts";
  const suite = "critical maintenance schedule on an actual owned durable Temporal service";
  const names = [
    "preserves compatible schedule and queued actual workflow across server restart",
    "skips overlap while the first genuine activity is held",
  ];
  const expected = names.map(test => ({ file, suite, test }));
  const named = (sourceRoot = root) => requirementsFor("workflows", sourceRoot).filter(item => criticalScheduleWorkflowIds.has(item.id));

  it("adds exact two literal native requirements while retaining every predecessor workflow identity", () => {
    expect(CRITICAL_SCHEDULE_TEMPORAL_REQUIREMENTS).toEqual(expected);
    const manifest = manifestFor("workflows", root);
    expect(named()).toEqual(expected.map(item => ({ ...item, id: requirementId("workflows", item) })));
    expect(new Set(named().map(item => item.id)).size).toBe(2);
    expect(manifest.requirements).toHaveLength(113);
    expect(new Set(manifest.requirements.map(item => item.id)).size).toBe(113);
    expect(priorCriticalScheduleWorkflowRequirements()).toHaveLength(60);
    expect(createHash("sha256").update(JSON.stringify(priorCriticalScheduleWorkflowRequirements().map(item => item.id).sort())).digest("hex"))
      .toBe("0bd6b090ef0f7802fd97c99d267614f334193ff13400aae17758daf3f24f723b");
    expect(priorWave2WorkflowRequirements()).toHaveLength(58);
    expect(createHash("sha256").update(JSON.stringify(priorWave2WorkflowRequirements().map(item => item.id).sort())).digest("hex"))
      .toBe("d3a15adf854819fd8577c3b55b48dd55640d6522bdc57cad2c707c867ffecad3");
    expect(manifest.env.ZENITH_TEST_TEMPORAL).toBe("1");
    expect(manifest.tools.temporal).toBe("1.9.1");
    expect(manifest.prerequisites.some(value => value.startsWith("ZENITH_TEST_TEMPORAL=1; both literal critical schedule cases"))).toBe(true);
    expect(manifest.excludeFiles).not.toContain(file);
    expect(manifest.command).not.toContain("--passWithNoTests");
    expect(reportFailures(named(), contractReport(named()), root)).toEqual([]);
    expect(requirementsFor("platform-postgres", root)).toHaveLength(1177);
    expect(CLEANUP_WRITER_BARRIER_POSTGRES_REQUIREMENTS).toHaveLength(61);
    expect(SAVED_PLAN_SETTLEMENT_POSTGRES_REQUIREMENTS).toHaveLength(54);
    expect(requirementsFor("postgres", root)).toHaveLength(93);
    expect(linuxGuestManifest().requiredCases).toHaveLength(159);
    expect(linuxGuestManifest().allowedSkips).toHaveLength(3);
    expect(packagedWorkerManifest().requiredChecks).toHaveLength(22);
    for (const lane of Object.keys(GATE_LANES).filter(value => value !== "workflows"))
      expect(requirementsFor(lane, root).some(item => criticalScheduleWorkflowIds.has(item.id))).toBe(false);
  });

  it("binds the accepted actual workflow source and required offline CLI admission without altering the eight models", () => {
    const source = fs.readFileSync(path.join(root, file), "utf8");
    expect(createHash("sha256").update(source).digest("hex")).toBe("ca059bda3200b9ac56be008e9d76230c262ef9138ae2fd18b4afbaa72f583f65");
    expect([...source.matchAll(/\bactual\("([^"\n]+)"/g)].map(match => match[1])).toEqual(names);
    expect([...source.matchAll(/\bit\("([^"\n]+)"/g)]).toHaveLength(8);
    expect(source).toContain('const required = process.env.ZENITH_TEST_TEMPORAL === "1";');
    expect(source).toContain('if (!cli) throw new Error("Required pinned offline Temporal CLI is unavailable.");');
    expect(source).toContain('this.env = await TestWorkflowEnvironment.createFromExistingServer');
    expect(source).toContain('await server!.stop();');
    expect(source).toContain('await server!.start();');
    expect(source).toContain('pendingMutation = phase;');
    expect(source).toContain('cleanupUnconfirmed || pendingMutation !== null || scheduleOwned');
    expect(source).not.toContain("startTestServer(");
  });

  it.each(["missing", "failed", "pending", "skipped", "todo"])("refuses %s evidence for either exact native scheduling case", status => {
    const required = named();
    for (const item of required) {
      const report = contractReport(required);
      const entry = report.testResults[0];
      const index = entry.assertionResults.findIndex(assertion => assertion.title === item.test);
      expect(index).toBeGreaterThanOrEqual(0);
      if (status === "missing") entry.assertionResults.splice(index, 1);
      else entry.assertionResults[index].status = status;
      expect(reportFailures(required, report, root)).toHaveLength(1);
    }
  });

  it("refuses zero or malformed reports even when the outer success flag is true", () => {
    for (const report of [null, {}, { success: true, testResults: [] }, { success: true, testResults: [{ name: path.resolve(root, file), status: "passed", assertionResults: [] }] }])
      expect(reportFailures(named(), report, root).length).toBeGreaterThan(0);
    const report = contractReport(named());
    report.testResults[0].assertionResults[0].status = "unrecognized";
    expect(reportFailures(named(), report, root).length).toBeGreaterThan(0);
  });

  it("cannot substitute passing older models, a suite parent or the wrong ancestry for native executions", () => {
    const whole = requirementsFor("workflows", root).filter(item => item.file === file && item.test === undefined);
    expect(whole).toHaveLength(1);
    const models = contractReport(whole);
    expect(reportFailures(whole, models, root)).toEqual([]);
    expect(reportFailures(named(), models, root)).toHaveLength(2);
    const parent = contractReport([{ file, suite, id: requirementId("workflows", { file, suite }) }]);
    expect(reportFailures(named(), parent, root)).toHaveLength(2);
    const wrongSuite = contractReport(named());
    for (const assertion of wrongSuite.testResults[0].assertionResults) {
      assertion.ancestorTitles = ["modeled critical scheduling"];
      assertion.fullName = [...assertion.ancestorTitles, assertion.title].join(" ");
    }
    expect(reportFailures(named(), wrongSuite, root)).toHaveLength(2);
  });

  it("retains both literal native obligations when the critical schedule source is deleted", () => {
    const sourceRoot = modelRoot(path.join(scratch, "deleted-critical-schedule-"));
    try {
      for (const directory of ["tests/workflows", "tests/platform", "tests/security"])
        fs.cpSync(path.join(root, directory), path.join(sourceRoot, directory), { recursive: true });
      const before = named(sourceRoot);
      fs.unlinkSync(path.join(sourceRoot, file));
      expect(named(sourceRoot)).toEqual(before);
      expect(before).toHaveLength(2);
      expect(reportFailures(named(sourceRoot), { success: true, testResults: [] }, sourceRoot)).toHaveLength(2);
    } finally { fs.rmSync(sourceRoot, { recursive: true, force: true }); }
  });
});


// Synthetic reports below verify strict admission; only the real postgres lane is engine evidence.
const journalGroupContracts = [
  {
    "file": "tests/agent-control-journal.test.ts",
    "suite": "postgres agent journal (live)",
    "count": 7,
    "sourceSha256": "d1117823eff2ce1e07a8f1d43581a865cfdb42bdaf6b721b555fa7b79d7976a9",
    "namesSha256": "8253402b4f34d3a33c7be428613029bc45e0a9855a7601d7396898de87cefa6d"
  },
  {
    "file": "tests/agent-control-journal-fixes.test.ts",
    "suite": "postgres agent journal: lease, un-approve and the queue (live)",
    "count": 6,
    "sourceSha256": "e4746fbc375eec47d1d58f587d37d879dc8d542b92f45cd2cb0faa3ea633d3ef",
    "namesSha256": "bd06283f32748e61d481500a4327a7ac8e0d825898e3c535890dc160fe636041"
  }
] as const;
const journalLiteralIds = [
  "postgres:tests/agent-control-journal.test.ts:bbf84e602596",
  "postgres:tests/agent-control-journal.test.ts:4218ac28b693",
  "postgres:tests/agent-control-journal.test.ts:5ec48d13f1f2",
  "postgres:tests/agent-control-journal.test.ts:2541384d53a7",
  "postgres:tests/agent-control-journal.test.ts:08db90bb682d",
  "postgres:tests/agent-control-journal.test.ts:d8de9a3fddea",
  "postgres:tests/agent-control-journal.test.ts:c0c3a65e7282",
  "postgres:tests/agent-control-journal-fixes.test.ts:273d2a543765",
  "postgres:tests/agent-control-journal-fixes.test.ts:c2c56dfe9575",
  "postgres:tests/agent-control-journal-fixes.test.ts:48a3f4408833",
  "postgres:tests/agent-control-journal-fixes.test.ts:a50cff746d24",
  "postgres:tests/agent-control-journal-fixes.test.ts:51e11acab265",
  "postgres:tests/agent-control-journal-fixes.test.ts:517819ffc16f"
];
function journalNamed(sourceRoot = root): Requirement[] {
  const ids = new Set(journalLiteralIds);
  return requirementsFor("postgres", sourceRoot).filter(item => ids.has(item.id));
}

describe("mandatory live agent journal PostgreSQL cases [report models]", () => {
  it("adds exactly thirteen committed live cases while preserving every original eighty requirement", () => {
    const manifest = manifestFor("postgres", root), added = journalNamed();
    expect(added).toHaveLength(13); expect(added.map(item => item.id)).toEqual(journalLiteralIds);
    expect(new Set(manifest.requirements.map(item => item.id)).size).toBe(93);
    expect(manifest.requirements).toHaveLength(93);
    const ids = new Set(journalLiteralIds), previous = manifest.requirements.filter(item => !ids.has(item.id));
    expect(previous).toHaveLength(80);
    expect(createHash("sha256").update(JSON.stringify(previous.map(item => item.id).sort())).digest("hex")).toBe("bcf0f03d13d9da5af22a00fbf3cadd8b972ddd2df0538d5166b7ab60b2a2a920");
    expect(added).toEqual(AGENT_JOURNAL_POSTGRES_REQUIREMENTS.map(item => ({ ...item, id: requirementId("postgres", item) })));
    for (const group of journalGroupContracts) {
      const source = fs.readFileSync(path.join(root, group.file), "utf8");
      expect(createHash("sha256").update(source).digest("hex")).toBe(group.sourceSha256);
      const declaration = `describe.skipIf(!PG_LIVE)('${group.suite}',`;
      const start = source.indexOf(declaration); expect(start).toBeGreaterThan(0);
      const names = [...source.slice(start).matchAll(/\bit\('([^']+)',/g)].map(match => match[1]);
      expect(names).toHaveLength(group.count);
      expect(createHash("sha256").update(JSON.stringify(names)).digest("hex")).toBe(group.namesSha256);
      expect(added.filter(item => item.file === group.file).map(item => item.test)).toEqual(names);
      expect(source.slice(0, start)).toContain("process.env.ZENITH_CONTRACT_POSTGRES === '1' && Boolean(process.env.SUPABASE_DB_URL)");
    }
  });

  it.each(["failed", "pending", "skipped", "todo"])("refuses every live journal case when its actual status is %s", status => {
    const required = journalNamed();
    expect(reportFailures(required, contractReport(required), root)).toEqual([]);
    for (const item of required) {
      const report = contractReport(required);
      report.testResults.flatMap(file => file.assertionResults).find(assertion => assertion.title === item.test)!.status = status;
      expect(reportFailures(required, report, root).length, item.id).toBeGreaterThan(0);
    }
  });

  it("refuses missing, model-only, foreign-file and malformed journal evidence", () => {
    const required = journalNamed();
    for (const item of required) {
      expect(reportFailures(required, contractReport(required.filter(other => other.id !== item.id)), root), item.id).toHaveLength(1);
      const modeled = contractReport(required);
      modeled.testResults.flatMap(file => file.assertionResults).find(assertion => assertion.title === item.test)!.ancestorTitles = ["modeled agent journal (pglite)"];
      expect(reportFailures(required, modeled, root).length, item.id).toBeGreaterThan(0);
      const foreign = contractReport(required);
      foreign.testResults.find(file => file.name === path.resolve(root, item.file))!.name = path.resolve(root, "tests/foreign-journal.test.ts");
      expect(reportFailures(required, foreign, root).length, item.id).toBeGreaterThan(0);
      const malformed = contractReport(required);
      malformed.testResults.flatMap(file => file.assertionResults).find(assertion => assertion.title === item.test)!.fullName = "";
      expect(reportFailures(required, malformed, root)).toEqual(["Malformed Vitest assertion evidence"]);
    }
  });

  it("retains literal journal obligations after source deletion and rejects zero or duplicated reports", () => {
    const sourceRoot = modelRoot(path.join(scratch, "live-journal-"));
    const contracts = "tests/hosted/authority/contract";
    fs.mkdirSync(path.join(sourceRoot, "tests"), { recursive: true });
    fs.cpSync(path.join(root, contracts), path.join(sourceRoot, contracts), { recursive: true });
    for (const group of journalGroupContracts) fs.copyFileSync(path.join(root, group.file), path.join(sourceRoot, group.file));
    const before = journalNamed(sourceRoot); expect(before).toHaveLength(13);
    for (const group of journalGroupContracts) fs.unlinkSync(path.join(sourceRoot, group.file));
    expect(journalNamed(sourceRoot)).toEqual(before);
    expect(reportFailures(before, { success: true, testResults: [] }, sourceRoot)).toHaveLength(13);
    expect(reportFailures([], contractReport(before), root)).toEqual(["No required scenarios found"]);
    expect(reportFailures(before, { ...contractReport(before), numTotalTests: 0 }, root)).toEqual(["Inconsistent Vitest report counts"]);
    const duplicate = contractReport(before); duplicate.testResults.push(duplicate.testResults[0]);
    expect(reportFailures(before, duplicate, root)).toEqual(["Duplicate Vitest file evidence"]);
  });
});


describe("incoming platform and workflow obligations", () => {
  it("requires every fixed additive native identity without losing historical obligations", () => {
    const current = requirementsFor("platform-postgres", root);
    expect(current).toHaveLength(1177);
    const added = current.filter(item => incomingPlatformIds.has(item.id));
    expect(added).toHaveLength(23);
    expect(new Set(added.map(item => item.id))).toEqual(incomingPlatformIds);
    expect(withoutIncomingPlatform(current)).toHaveLength(1123);
    expect(withoutIncomingPlatform([...current, { ...current[0], id: "unknown-successor" }]).some(item => item.id === "unknown-successor")).toBe(true);
    for (const item of added) {
      expect(reportFailures([item], contractReport([item]), root)).toEqual([]);
      expect(reportFailures([item], { success: true, testResults: [] }, root)).toHaveLength(1);
      for (const status of ["failed", "skipped", "pending"]) {
        const report = contractReport([item]);
        report.testResults[0].assertionResults[0].status = status;
        expect(reportFailures([item], report, root)).toHaveLength(1);
      }
    }
  });
  it("keeps all eight added workflow files in the complete mandatory lane", () => {
    const current = manifestFor("workflows", root);
    expect(current.requirements).toHaveLength(113);
    expect(current.requirements.filter(item => item.id === errorBoundaryWorkflowId)).toEqual([
      { file: "tests/platform/error-boundary.test.ts", id: errorBoundaryWorkflowId },
    ]);
    const added = withoutKnownWorkflowSuccessors(current.requirements).filter(item => incomingWorkflowFiles.has(item.file));
    expect(added).toHaveLength(8);
    expect(new Set(added.map(item => item.file))).toEqual(incomingWorkflowFiles);
    for (const item of added) {
      expect(current.excludeFiles).not.toContain(item.file);
      expect(reportFailures([item], { success: true, testResults: [] }, root)).toHaveLength(1);
    }
  });
});


describe("full history codec successor admission", () => {
  it("requires the new codec file and preserves every prior workflow identity", () => {
    const current = manifestFor("workflows", root);
    const codec = current.requirements.filter(item => item.id === historyCodecWorkflowId);
    expect(codec).toHaveLength(1);
    expect(current.requirements).toHaveLength(113);
    expect(current.requirements.filter(item => item.id !== historyCodecWorkflowId)).toHaveLength(112);
    const priorWithoutCodec = withoutKnownWorkflowSuccessors(current.requirements).filter(item => item.id !== historyCodecWorkflowId && !integrationWorkflowIds.has(item.id));
    expect(priorWithoutCodec).toHaveLength(75);
    expect(priorWithoutCodec.filter(item => !wave5WorkflowIds.has(item.id))).toHaveLength(70);
    expect(current.excludeFiles).not.toContain(codec[0].file);
    expect(reportFailures(codec, contractReport(codec), root)).toEqual([]);
    expect(reportFailures(codec, { success: true, testResults: [] }, root)).toHaveLength(1);
    for (const status of ["failed", "skipped", "pending"]) {
      const report = contractReport(codec);
      report.testResults[0].assertionResults[0].status = status;
      expect(reportFailures(codec, report, root)).toHaveLength(1);
    }
    expect([...current.requirements, { ...codec[0], id: "unknown-successor" }]
      .filter(item => !incomingWorkflowIds.has(item.id)).some(item => item.id === "unknown-successor")).toBe(true);
  });
});


describe("Wave 5 additive gate inventory", () => {
  it("retains every branch test in an executable contract or external lane", () => {
    const files = WAVE5_CONTRACT_FILES;
    for (const file of files) {
      expect(fs.existsSync(path.join(root,file))).toBe(true);
      const lane = file.startsWith("tests/adversarial/") ? "adversarial" : "wave5-contract";
      expect(manifestFor(lane, root).command).toContain(file.startsWith("tests/adversarial/") ? "tests/adversarial" : file);
      expect(requirementsFor(lane, root).some(r => r.file === file)).toBe(true);
    }
    expect(files).toHaveLength(79);
    expect(WAVE5_EXTERNAL_FILES).toHaveLength(12);
    for (const file of WAVE5_EXTERNAL_FILES) expect([
      ...EXTERNAL_ACCEPTANCE.map(g=>g.file),
      ...requirementsFor("tofu", root).map(required => required.file),
      ...manifestFor("recovery",root).files,
    ]).toContain(file);
  });
});

// Report/source models for PROD-MIX-04; actual SQL evidence is the owning lane.
describe("mixed run store application-boundary gate", () => {
  const file = "tests/execution/mixed-run-store.test.ts";
  const names = [
    "refuses malformed 'state version' before create or save touches SQL",
    "refuses malformed 'child attempts' before create or save touches SQL",
    "refuses legacy logical environmentId mismatch without changing the retained row or ledger",
    "refuses legacy logical desiredDigest mismatch without changing the retained row or ledger",
    "preserves valid writes, ordered ledger and stale-version refusal",
  ];
  const named = () => requirementsFor("platform-postgres", root).filter(item => mixedRunStorePlatformIds.has(item.id));

  it("adds exactly five PostgreSQL cases while preserving the complete 1140 predecessor and native 100", () => {
    const current = requirementsFor("platform-postgres", root), required = named();
    expect(required).toHaveLength(5);
    expect(required).toEqual(names.map(test => {
      const item = { file, suite: "mixed run store validation [postgres]", test, postgres: true };
      return { ...item, id: requirementId("platform-postgres", item) };
    }));
    expect(MIXED_RUN_STORE_POSTGRES_REQUIREMENTS.map(item => item.test)).toEqual(names);
    expect(new Set(required.map(item => item.id))).toEqual(mixedRunStorePlatformIds);
    const prior = priorOwnershipSnapshotRequirements(current).filter(item => !mixedRunStorePlatformIds.has(item.id) && !integrationPlatformIds.has(item.id));
    const verifierPrior = prior.filter(item => !wave5PlatformIds.has(item.id));
    expect(current).toHaveLength(1177); expect(prior).toHaveLength(1143);
    expect(createHash("sha256").update(JSON.stringify(prior.map(item => item.id).sort())).digest("hex"))
      .toBe("35005913623966fb2520de4a69de2c172a289213a0911cd7691caf125cb0670a");
    expect(verifierPrior).toHaveLength(1140);
    expect(createHash("sha256").update(JSON.stringify(verifierPrior.map(item => item.id).sort())).digest("hex"))
      .toBe("d69bfb94043d51dd0c2631fa9a2864b08cd05b590e6c3a4d5d0380aace6c7047");
    expect(manifestFor("platform-postgres", root).files).toContain(file);
    expect(manifestFor("platform-postgres", root).excludeFiles).not.toContain(file);
    expect(CLEANUP_WRITER_BARRIER_POSTGRES_REQUIREMENTS).toHaveLength(61);
    expect(SAVED_PLAN_SETTLEMENT_POSTGRES_REQUIREMENTS).toHaveLength(54);
    const future = { ...current[0], id: "future-mixed-successor" };
    expect(withoutIncomingPlatform([...current, future])).toContainEqual(future);
  });

  it("rejects each missing failed skipped and PGlite observation despite passing siblings", () => {
    const required = named();
    expect(reportFailures(required, contractReport(required), root)).toEqual([]);
    for (const item of required) {
      const missing = contractReport(required);
      missing.testResults[0].assertionResults = missing.testResults[0].assertionResults.filter(assertion => assertion.title !== item.test);
      expect(reportFailures(required, missing, root), item.id).toHaveLength(1);
      for (const status of ["failed", "skipped", "pending"]) {
        const changed = contractReport(required);
        changed.testResults[0].assertionResults.find(assertion => assertion.title === item.test)!.status = status;
        expect(reportFailures(required, changed, root), `${item.id}: ${status}`).toHaveLength(1);
      }
      const modeled = contractReport(required);
      const assertion = modeled.testResults[0].assertionResults.find(value => value.title === item.test)!;
      assertion.ancestorTitles = ["mixed run store validation [pglite]"];
      assertion.fullName = [...assertion.ancestorTitles, assertion.title].join(" ");
      expect(reportFailures(required, modeled, root), item.id).toHaveLength(1);
    }
  });

  it("retains all five literal requirements after trusted source deletion", () => {
    const sourceRoot = modelRoot(path.join(scratch, "deleted-mixed-store-"));
    for (const directory of ["tests/controlplane", "tests/capabilities", "tests/reconcile", "tests/execution"])
      fs.mkdirSync(path.join(sourceRoot, directory), { recursive: true });
    fs.copyFileSync(path.join(root, file), path.join(sourceRoot, file));
    const select = () => requirementsFor("platform-postgres", sourceRoot).filter(item => mixedRunStorePlatformIds.has(item.id));
    const before = select(); expect(before).toHaveLength(5);
    fs.unlinkSync(path.join(sourceRoot, file));
    expect(select()).toEqual(before);
    expect(reportFailures(before, { success: true, testResults: [] }, sourceRoot)).toHaveLength(5);
    const source = fs.readFileSync(path.join(root, file));
    expect(createHash("sha256").update(source).digest("hex")).toBe("87ea55e3784a21caf21620080c4e19b99fa79904c68b0a1efc1bbaf4d489c30d");
  });
});


// Validator/source models; actual frozen-byte Worker replay is the owning workflow lane.
describe("mandatory frozen current-code workflow replay", () => {
  const named = (sourceRoot = root) => requirementsFor("workflows", sourceRoot).filter(item => replayAdditionIds.has(item.id));
  it("appends exactly 34 literal checks and preserves the exact 71 predecessor identities", () => {
    const manifest = manifestFor("workflows", root), added = named(), previous = withoutKnownWorkflowSuccessors(manifest.requirements);
    expect(manifest.requirements).toHaveLength(113);
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
    expect(WORKFLOW_HISTORY_REPLAY_REQUIREMENTS).toHaveLength(34);
    expect(added).toHaveLength(34);
    expect(new Set(added.map(item => item.id))).toEqual(replayAdditionIds);
    expect(manifest.requirements.filter(item => item.id !== errorBoundaryWorkflowId)).toEqual([...previous, ...added]);
    expect(added.filter(item => item.suite === "committed workflow histories: inventory and integrity")).toHaveLength(6);
    expect(added.filter(item => item.suite === "committed workflow histories replay against the current bundle")).toHaveLength(21);
    expect(added.filter(item => item.suite === "the replay gate has teeth")).toHaveLength(2);
    expect(added.filter(item => item.file === "tests/workflows/versioning-audit.test.ts")).toHaveLength(5);
    expect(previous).toContainEqual({ file: "tests/workflows/versioning-audit.test.ts", id: "workflows:tests/workflows/versioning-audit.test.ts:4ee93ed6c454" });
    expect(previous.some(item => item.file === "tests/workflows/history-replay.test.ts")).toBe(false);
    expect(manifest.env.ZENITH_REPLAY_LANE).toBe("1");
    expect(manifest.excludeFiles).not.toContain("tests/workflows/history-replay.test.ts");
    expect(manifest.excludeFiles).toContain("tests/workflows/history-record.test.ts");
    expect(manifest.command).not.toContain("--passWithNoTests");
    expect(withoutKnownWorkflowSuccessors([...manifest.requirements, { ...added[0], id: "unknown-successor" }]).some(item => item.id === "unknown-successor")).toBe(true);
  });

  it("binds all named checks to frozen fixture filenames, declared scenarios and real SDK replay controls", () => {
    const added = named(), file = "tests/workflows/history-replay.test.ts";
    const source = fs.readFileSync(path.join(root, file), "utf8");
    const scenarios = fs.readFileSync(path.join(root, "tests/workflows/history-scenarios.ts"), "utf8");
    const directory = path.join(root, "tests/fixtures/workflow-histories");
    const manifestBytes = fs.readFileSync(path.join(directory, "MANIFEST.json"));
    expect(createHash("sha256").update(manifestBytes).digest("hex"))
      .toBe("408b0b42800ecdb97f1e5edbd75409879a8b790f7efb0bae4aac3c447c52de02");
    const manifest = JSON.parse(manifestBytes.toString("utf8")) as { fixtures: Record<string, string> };
    const filenames = added.filter(item => item.suite === "committed workflow histories replay against the current bundle").map(item => item.test!.replace(/ replays deterministically$/, "")).sort();
    expect(Object.keys(manifest.fixtures).sort()).toEqual(filenames);
    expect(fs.readdirSync(directory).filter(file => file.endsWith(".json") && file !== "MANIFEST.json").sort()).toEqual(filenames);
    for (const filename of filenames) {
      expect(createHash("sha256").update(fs.readFileSync(path.join(directory, filename))).digest("hex")).toBe(manifest.fixtures[filename]);
      expect(scenarios).toContain(`id: ${JSON.stringify(filename.replace(/\.json$/, ""))}`);
    }
    for (const item of added.filter(item => item.suite !== "committed workflow histories replay against the current bundle")) {
      const text = fs.readFileSync(path.join(root, item.file), "utf8");
      expect(text).toContain(`it(${JSON.stringify(item.test)}`);
    }
    expect(source).toContain("Worker.runReplayHistory(");
    expect(source).toContain("rejects.toBeInstanceOf(DeterminismViolationError)");
    expect(source).toContain("rejects.toThrow()");
    expect(source).toContain('if (!lane) it.skip(');
    expect(source).not.toContain('\nit.skip(');
  });

  it("independently refuses every missing, nonpassing or wrongly identified replay check", () => {
    const required = named();
    expect(reportFailures(required, contractReport(required), root)).toEqual([]);
    for (const item of required) {
      expect(reportFailures(required, contractReport(required.filter(other => other.id !== item.id)), root), item.id).toHaveLength(1);
      for (const status of ["failed", "skipped", "pending", "todo", "unknown"]) {
        const report = contractReport(required);
        report.testResults.find(file => file.name === path.resolve(root, item.file))!.assertionResults.find(assertion => assertion.title === item.test)!.status = status;
        expect(reportFailures(required, report, root).length, `${item.id}:${status}`).toBeGreaterThan(0);
      }
      for (const change of ["file", "suite", "test"]) {
        const report = contractReport([item]);
        if (change === "file") report.testResults[0].name = path.resolve(root, "tests/workflows/foreign-history.test.ts");
        if (change === "suite") report.testResults[0].assertionResults[0].ancestorTitles = ["unrelated replay suite"];
        if (change === "test") report.testResults[0].assertionResults[0].title = "one other passing replay";
        expect(reportFailures([item], report, root), `${item.id}:${change}`).toHaveLength(1);
      }
    }
  });

  it("retains all literal requirements when fixtures, scenarios or tests disappear and rejects empty or malformed evidence", () => {
    const sourceRoot = modelRoot(path.join(os.tmpdir(), "zenith-replay-gate-"));
    try {
      for (const directory of ["tests/workflows", "tests/platform"]) fs.mkdirSync(path.join(sourceRoot, directory), { recursive: true });
      // Each required source/fixture is absent here; discovery cannot erase a literal identity.
      expect(fs.existsSync(path.join(sourceRoot, "tests/fixtures/workflow-histories"))).toBe(false);
      expect(fs.existsSync(path.join(sourceRoot, "tests/workflows/history-scenarios.ts"))).toBe(false);
      expect(fs.existsSync(path.join(sourceRoot, "tests/workflows/history-replay.test.ts"))).toBe(false);
      const before = named(), after = named(sourceRoot);
      expect(after).toEqual(before);
      expect(reportFailures(after, { success: true, testResults: [] }, sourceRoot)).toHaveLength(34);
      for (const report of [null, {}, { success: true }, { ...contractReport(before), success: false }, { success: true, testResults: [{ name: path.resolve(root, before[0].file) }] }]) {
        expect(reportFailures(before, report, root).length).toBeGreaterThan(0);
      }
      const zero = contractReport(before); zero.testResults.forEach(file => { file.assertionResults = []; });
      expect(reportFailures(before, zero, root)).toHaveLength(34);
      const duplicate = contractReport(before); duplicate.testResults.push(duplicate.testResults[0]);
      expect(reportFailures(before, duplicate, root)).toEqual(["Duplicate Vitest file evidence"]);
      expect(reportFailures(before, { ...contractReport(before), numTotalTests: 0 }, root)).toEqual(["Inconsistent Vitest report counts"]);
      expect(reportFailures(before, { ...contractReport(before), numFailedTests: 1 }, root)).toEqual(["Inconsistent Vitest report counts"]);
      expect(reportFailures([], contractReport(before), root)).toEqual(["No required scenarios found"]);
    } finally { fs.rmSync(sourceRoot, { recursive: true, force: true }); }
  });
});

describe("assembled job workflow obligations", () => {
  it("requires both exact J4 and J14 contracts and rejects missing or skipped evidence", () => {
    const manifest = manifestFor("workflows", root);
    const added = manifest.requirements.filter(item => integrationWorkflowIds.has(item.id));
    expect(added).toHaveLength(2);
    expect(new Set(added.map(item => item.id))).toEqual(integrationWorkflowIds);
    for (const item of added) {
      expect(manifest.files).toContain("tests/platform");
      expect(manifest.command).toContain("tests/platform");
      expect(manifest.excludeFiles).not.toContain(item.file);
      expect(fs.existsSync(path.join(root, item.file))).toBe(true);
      expect(reportFailures([item], { success: true, testResults: [] }, root)).toHaveLength(1);
      const report = contractReport([item]);
      report.testResults[0].assertionResults[0].status = "skipped";
      expect(reportFailures([item], report, root)).toHaveLength(1);
    }
  });
});

// Report models; genuine SQL concurrency evidence remains in the native lane.
describe("ownership snapshot final-statement PostgreSQL requirements", () => {
  it("adds ten exact native cases and preserves the complete 1145 predecessor", () => {
    const current = requirementsFor("platform-postgres", root);
    const required = current.filter(item => ownershipSnapshotCasIds.has(item.id));
    expect(current).toHaveLength(1177);
    expect(new Set(current.map(item => item.id)).size).toBe(1177);
    expect(required).toEqual(OWNERSHIP_SNAPSHOT_CAS_POSTGRES_REQUIREMENTS.map(item => ({ ...item, id: requirementId("platform-postgres", item) })));
    expect(required).toHaveLength(10);
    expect(required.every(item => item.postgres === true && item.suite === "ownership transfer immutable service-role custody [postgres]")).toBe(true);
    const prior = priorOwnershipSnapshotRequirements(current);
    expect(prior).toHaveLength(1149);
    expect(createHash("sha256").update(JSON.stringify(prior.map(item => item.id).sort())).digest("hex"))
      .toBe("92df99d8de16e4ef6e1072114c12aafff513bf43774c12c9c390998308ca5729");
    const verifierPrior = prior.filter(item => !wave5PlatformIds.has(item.id) && !integrationPlatformIds.has(item.id));
    expect(verifierPrior).toHaveLength(1145);
    expect(createHash("sha256").update(JSON.stringify(verifierPrior.map(item => item.id).sort())).digest("hex"))
      .toBe("349b983956a0d8569c4bc475584e0a6bf69cd5fa476e2b709954536aacc34c00");
    expect(INCIDENT_OWNERSHIP_HARDENING_POSTGRES_REQUIREMENTS).toHaveLength(5);
    const future = { ...current[0], id: "unknown-ownership-snapshot-successor" };
    expect(priorOwnershipSnapshotRequirements([...current, future])).toContainEqual(future);
  });
  it("rejects each missing failed skipped pending todo and non-PostgreSQL observation", () => {
    const required = requirementsFor("platform-postgres", root).filter(item => ownershipSnapshotCasIds.has(item.id));
    expect(reportFailures(required, contractReport(required), root)).toEqual([]);
    for (const item of required) {
      expect(reportFailures(required, contractReport(required.filter(value => value.id !== item.id)), root), item.id).toHaveLength(1);
      for (const status of ["failed", "skipped", "pending", "todo"]) {
        const report = contractReport(required);
        report.testResults[0].assertionResults.find(value => value.title === item.test)!.status = status;
        expect(reportFailures(required, report, root), `${item.id}: ${status}`).toHaveLength(1);
      }
      const report = contractReport(required);
      const assertion = report.testResults[0].assertionResults.find(value => value.title === item.test)!;
      assertion.ancestorTitles = ["ownership transfer immutable service-role custody [pglite]"];
      assertion.fullName = [...assertion.ancestorTitles, assertion.title].join(" ");
      expect(reportFailures(required, report, root), item.id).toHaveLength(1);
    }
  });
});
