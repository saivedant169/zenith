/** Canonical local/CI execution contract. Report payloads never define requirements. */
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { WAVE6_LANES, wave6Manifest } from "./wave6-manifest.mjs";

export const TOFU_SUITES = [
  ["tests/tofu/network.test.ts", "real provider install through the committed lockfile (network)"],
  ["tests/tofu/network.test.ts", "AWS provider blocks validate against the real provider schema (network, ~160 MB first run)"],
  ["tests/tofu/backends.test.ts", "real backend block validation (network gate, no cloud calls)"],
  ["tests/tofu/destroy-real.test.ts", "real tofu destroy (ZENITH_TEST_TOFU_NETWORK=1)"],
  ["tests/providers/aws/drivers/compute/assemble.test.ts", "real `tofu validate` against hashicorp/aws 6.66.0 (network, plugin cache)"],
  ["tests/providers/aws/drivers/compute/ecs-ownership-tofu.test.ts", "tofu ignores desired_count once an autoscaler owns it (real OpenTofu, mock aws provider)"],
  ["tests/providers/aws/drivers/data/assemble.test.ts", "compiled data fragments validate against the real hashicorp/aws provider (network)"],
  ["tests/providers/aws/drivers/messaging/assemble.test.ts", "OpenTofu AWS 6.66.0 schema validation (requires binary/network)"],
  ["tests/providers/aws/drivers/network/compile-graph.test.ts", "tofu validate over the real aws 6.66.0 provider schema (gated: ZENITH_TEST_TOFU_NETWORK=1)"],
  ["tests/providers/aws/drivers/e2e-compile.test.ts", "real OpenTofu AWS 6.66.0 schema validation (opt-in)"],
  ["tests/providers/aws/identity/trust.test.ts", "IRSA pinned provider schema"],
  ["tests/providers/gcp/tofu-validate.test.ts", "tofu validate against hashicorp/google 8.5.0 (network)"],
  ["tests/providers/gcp/bootstrap.test.ts", "tofu validate (network)"],
  ["tests/providers/gcp/identity/trust.test.ts", "GKE trust pinned provider schema"],
  ["tests/providers/azure/validate.test.ts", "compiled Azure OpenTofu validates against the real azurerm 5.7.0 schema (network)"],
  ["tests/providers/azure/deploy.test.ts", "deploy/azure validates against the real azurerm 5.7.0 schema (network)"],
  ["tests/providers/azure/identity/trust.test.ts", "AKS trust pinned provider schema"],
  ["tests/providers/oci/validate.test.ts", "tofu validate against oracle/oci 9.7.1 (network)"],
  ["tests/providers/oci/validate.test.ts", "the customer bootstrap module (deploy/oci) validates against the locked provider (network)"],
  ["tests/execution/compile-refs-providers.test.ts", "real AWS schema validation through the execution compiler (opt-in)"],
  ["tests/security/tofu-secrets.test.ts", "part 3: real OpenTofu 1.12.5, plan -> approve -> apply, scanning every surface"],
  ["tests/security/tofu-runner-env.test.ts", "part 1: a provisioner inside real tofu inherits nothing of the control plane's environment"],
  ["tests/security/tofu-workspace-injection.test.ts", "what the assembler ACCEPTS, real OpenTofu must not turn into a file read or a path leak (SEC-F5)"],
  ["tests/execution/journey.test.ts", "deploy journey on the real OpenTofu engine, platform store and product store"],
  ["tests/tofu/ephemeral-network.test.ts", "real ephemeral resources (network)"],
  ["tests/tofu/typed-inputs.test.ts", "typed inputs and output capture (real tofu 1.12.5, local backend)"],
  ["tests/tofu/typed-substitution.test.ts", "manifest references reach resources through declared variables (real tofu 1.12.5, local backend)"],
  ["tests/providers/azure/mysql.test.ts", "Azure MySQL real pinned tofu validate (network, no Azure account)"],
  ["tests/providers/oci/mysql.test.ts", "OCI MySQL real pinned tofu schema and persistence controls (network)"],
];

export const APPLY_CURRENT_AUTHORITY_POSTGRES_REQUIREMENTS = [{
  file: "tests/execution/apply.test.ts",
  suite: "dispatch current authority [postgres]",
  test: "continues unchanged native product authority after fresh replan through the exact approved original plan",
  postgres: true,
}];


export const EXTERNAL_ACCEPTANCE = [
  {
    id: "external-temporal-mtls", file: "tests/workflows/mtls-live.test.ts",
    suite: "external Temporal mTLS (ZENITH_TEST_TEMPORAL_MTLS=1)", wholeFile: true,
    prerequisites: ["An authorized external Temporal namespace", "ZENITH_TEMPORAL_ADDRESS", "ZENITH_TEMPORAL_NAMESPACE", "ZENITH_TEMPORAL_TLS_CERT_FILE", "ZENITH_TEMPORAL_TLS_KEY_FILE", "ZENITH_TEST_TEMPORAL_MTLS=1"],
    releaseBlocker: "External Temporal mTLS execution remains unverified until separate authorized acceptance passes.",
  },

  { id: "wave5-mixed-lambda", file: "tests/acceptance/mixed-lambda.gated.test.ts", suite: "mixed Lambda endpoint [needs explicit LocalStack or deferred live AWS gate and credential files]", wholeFile: true,
    prerequisites: ["ZENITH_TEST_MIXED_LAMBDA=1 (owned LocalStack) or ZENITH_LIVE_AWS_LAMBDA=1 (separately authorized live target)", "Published numeric Lambda ARN, reviewed package digest, explicit private credential file"],
    releaseBlocker: "Real Lambda endpoint acceptance remains unverified; live cloud acceptance is deferred." },
  { id: "wave5-legacy-archive-postgres", file: "tests/retention/restore-destination.test.ts", suite: "legacy archive CLI [real PostgreSQL]", wholeFile: false,
    prerequisites: ["ZENITH_TEST_RETENTION_PG=1", "Owned disposable ZENITH_TEST_PLATFORM_PG_URL with current schema and no shared tenant data"], releaseBlocker: "Real PostgreSQL legacy archive CLI verification remains unverified until the gated Mac test passes." },
  { id: "wave5-mixed-lambda-package", file: "tests/acceptance/mixed-lambda-package.gated.test.ts", suite: "mixed Lambda package [real zip and unzip]", wholeFile: true,
    prerequisites: ["ZENITH_TEST_MIXED_LAMBDA_PACKAGE=1", "zip and unzip on the Mac verifier"], releaseBlocker: "Real ZIP/source binding CLI acceptance remains unverified until the gated Mac test passes." },
  { id: "wave5-gaps-ui", file: "tests/acceptance/w5-gaps-ui.gated.test.ts", suite: "W5 gaps UI [owned local server and browser]", wholeFile: true,
    prerequisites: ["ZENITH_TEST_W5_GAPS_UI=1", "Owned local Zenith server, real browser and private authenticated operator browser state"], releaseBlocker: "W5 gaps UI browser acceptance remains unverified until the gated Mac test passes." },
  {"id": "wave5-managed-onboarding", "file": "tests/isolation/managed-onboarding-readiness.test.ts", "suite": "managed onboarding readiness", "wholeFile": false, "prerequisites": ["ZENITH_TEST_MANAGED_ONBOARDING=1", "Docker, kind, kubectl", "KUBECONFIG, prepared approved tenant namespace"], "releaseBlocker": "Wave 5 real service acceptance remains unverified until the gated harness passes."},
  {"id": "wave5-tenant-isolation", "file": "tests/isolation/tenant-isolation-acceptance.test.ts", "suite": "PROD-MAN-04/05 acceptance (gated)", "wholeFile": false, "prerequisites": ["ZENITH_TEST_TENANT_ISOLATION=1", "KUBECONFIG", "Calico or pinned Cilium, digest-pinned probe image"], "releaseBlocker": "Wave 5 real service acceptance remains unverified until the gated harness passes."},
  {"id": "wave5-mixed-connectivity", "file": "tests/live/mixed-connectivity.live.test.ts", "suite": "live protected-endpoint probes", "wholeFile": false, "prerequisites": ["ZENITH_LIVE_MIXED=1", "Separate DEC-CLOUD approval and budget", "Deployed endpoints, external credential files"], "releaseBlocker": "Wave 5 real service acceptance remains unverified until the gated harness passes."},
  {"id": "wave5-managed-serving", "file": "tests/managed-serving/serving-kind.test.ts", "suite": "managed serving on a real kind cluster", "wholeFile": false, "prerequisites": ["ZENITH_TEST_MANAGED_SERVING_KIND=1", "Docker, kind, kubectl, Gateway API"], "releaseBlocker": "Wave 5 real service acceptance remains unverified until the gated harness passes."},
  {"id": "wave5-storage-emulator", "file": "tests/managed-serving/storage-emulator.test.ts", "suite": "scoped object storage against an IAM + S3 emulator", "wholeFile": false, "prerequisites": ["ZENITH_TEST_IAM_ENDPOINT, ZENITH_TEST_IAM_ADMIN_KEY_ID, ZENITH_TEST_IAM_ADMIN_SECRET", "ZENITH_TEST_IAM_ENFORCED=1; IAM-enforcing S3 emulator"], "releaseBlocker": "Wave 5 real service acceptance remains unverified until the gated harness passes."},
  {"id": "wave5-managed-substrate", "file": "tests/providers/zenith/managed-kind.test.ts", "suite": "Zenith-managed substrate on a real kind cluster", "wholeFile": false, "prerequisites": ["ZENITH_TEST_MANAGED_KIND=1", "Docker, kind, kubectl, Gateway API", "Two digest-pinned images"], "releaseBlocker": "Wave 5 real service acceptance remains unverified until the gated harness passes."},
];

export const CORE_CHECKS = [
  { id: "typecheck", command: ["npm", "run", "typecheck"] },
  { id: "lint", command: ["npm", "run", "lint"] },
  { id: "unit", command: ["node", "node_modules/vitest/vitest.mjs", "run", "--project=node", "--project=dom", "--maxWorkers=2"] },
  { id: "smoke", command: ["npm", "run", "smoke"] },
  { id: "gimbal", command: ["npm", "run", "gimbal:verify"] },
];

const ECS_REPLICA_REPAIR_FILES = {
  execution: "tests/execution/ecs-replica-repair.test.ts",
  ownership: "tests/providers/aws/drivers/compute/ecs-replica-repair-read.test.ts",
  grants: "tests/platform/ecs-replica-repair-grants.test.ts",
  workflows: "tests/workflows/ecs-replica-repair.test.ts",
};
const ECS_REPLICA_REPAIR_WORKFLOW_REQUIREMENTS = [
  ...["immutable ECS replica materialization", "raw full-environment repair plan", "existing plan/apply activity integration"]
    .map((suite) => ({ file: ECS_REPLICA_REPAIR_FILES.execution, suite })),
  { file: ECS_REPLICA_REPAIR_FILES.ownership, suite: "ECS replica ownership reads" },
  { file: ECS_REPLICA_REPAIR_FILES.grants },
  { file: ECS_REPLICA_REPAIR_FILES.workflows },
];
const ECS_REPLICA_REPAIR_POSTGRES_SUITES = [
  "initial planning authority", "planning policy denial", "browser plan approval",
  "resumed planning authority", "stricter approval policy", "immutable repair evidence",
];


// Predispatch, uncertainty and legacy replay contracts stay mandatory even when source files disappear.
const BUILD_SOURCE_POSTGRES_REQUIREMENTS = [
  {
    "file": "tests/controlplane/build-launches.test.ts",
    "suite": "build launch authority [postgres]",
    "test": "commits one permanent predispatch claim across independent workers",
    "postgres": true
  },
  {
    "file": "tests/controlplane/build-launches.test.ts",
    "suite": "build launch authority [postgres]",
    "test": "a committed claim without a provider receipt never becomes dispatchable again",
    "postgres": true
  },
  {
    "file": "tests/controlplane/build-launches.test.ts",
    "suite": "build launch authority [postgres]",
    "test": "a rollback before commit leaves no external launch intent and can be claimed",
    "postgres": true
  },
  {
    "file": "tests/controlplane/build-launches.test.ts",
    "suite": "build launch authority [postgres]",
    "test": "refuses expired consumed approvals at the CAS while operation and fence remain live",
    "postgres": true
  },
  {
    "file": "tests/controlplane/build-launches.test.ts",
    "suite": "build launch authority [postgres]",
    "test": "keeps the isolated actual-broker claimer unavailable in production and outside bound SQL repositories",
    "postgres": true
  },
  {
    "file": "tests/controlplane/build-launches.test.ts",
    "suite": "build launch authority [postgres]",
    "test": "records a late accepted receipt after cancellation without reopening the writer",
    "postgres": true
  },
  {
    "file": "tests/controlplane/build-launches.test.ts",
    "suite": "build launch authority [postgres]",
    "test": "rejects stale fences, foreign tenants, absent original-use authority and revoked account bindings",
    "postgres": true
  },
  {
    "file": "tests/controlplane/build-launches.test.ts",
    "suite": "build launch authority [postgres]",
    "test": "retains an immutable terminal receipt independently of operation projections and provider-token expiry",
    "postgres": true
  },
  {
    "file": "tests/controlplane/build-launches.test.ts",
    "suite": "build launch authority [postgres]",
    "test": "refuses receipt substitution and preserves the first acknowledgement",
    "postgres": true
  },
  {
    "file": "tests/controlplane/build-launches.test.ts",
    "suite": "build launch authority [postgres]",
    "test": "rechecks fence expiry after an observed resource lock wait before committing dispatch",
    "postgres": true
  },
  {
    "file": "tests/controlplane/build-launches.test.ts",
    "suite": "build launch authority [postgres]",
    "test": "rechecks execution-lease expiry after an observed resource lock wait before committing dispatch",
    "postgres": true
  },
  {
    "file": "tests/controlplane/build-launches.test.ts",
    "suite": "build launch authority [postgres]",
    "test": "rechecks operation expiry after an observed resource lock wait before committing dispatch",
    "postgres": true
  },
  {
    "file": "tests/controlplane/build-launches.test.ts",
    "suite": "build launch authority [postgres]",
    "test": "rechecks consumed-approval expiry after an observed resource lock wait before committing dispatch",
    "postgres": true
  },
  {
    "file": "tests/platform/codebuild-launch-authority.test.ts",
    "suite": "CodeBuild launch authority [postgres]",
    "test": "keeps the isolated actual-broker launcher unavailable in production",
    "postgres": true
  },
  {
    "file": "tests/platform/codebuild-launch-authority.test.ts",
    "suite": "CodeBuild launch authority [postgres]",
    "test": "commits one claim across competing workers and sends the bound ZIP once",
    "postgres": true
  },
  {
    "file": "tests/platform/codebuild-launch-authority.test.ts",
    "suite": "CodeBuild launch authority [postgres]",
    "test": "keeps an accepted-but-lost response permanently unconfirmed, including after token expiry",
    "postgres": true
  },
  {
    "file": "tests/platform/codebuild-launch-authority.test.ts",
    "suite": "CodeBuild launch authority [postgres]",
    "test": "rejects altered input/settings and missing ownership or stored checksum before another dispatch",
    "postgres": true
  },
  {
    "file": "tests/platform/codebuild-launch-authority.test.ts",
    "suite": "CodeBuild launch authority [postgres]",
    "test": "retains a provider-complete failure receipt independently of cancelled UI status",
    "postgres": true
  },
  {
    "file": "tests/platform/codebuild-launch-authority.test.ts",
    "suite": "CodeBuild launch authority [postgres]",
    "test": "refuses terminal status without completion, a foreign build, and a polling deadline as clean failure",
    "postgres": true
  },
  {
    "file": "tests/platform/codebuild-launch-authority.test.ts",
    "suite": "CodeBuild launch authority [postgres]",
    "test": "refuses expired approval through canonical current authority with a live operation and fence",
    "postgres": true
  },
  {
    "file": "tests/platform/codebuild-launch-authority.test.ts",
    "suite": "CodeBuild launch authority [postgres]",
    "test": "refuses revoked approver role through canonical current authority with a live operation and fence",
    "postgres": true
  },
  {
    "file": "tests/platform/codebuild-launch-authority.test.ts",
    "suite": "CodeBuild launch authority [postgres]",
    "test": "refuses new approval count through canonical current authority with a live operation and fence",
    "postgres": true
  },
  {
    "file": "tests/platform/codebuild-launch-authority.test.ts",
    "suite": "CodeBuild launch authority [postgres]",
    "test": "refuses current policy deny through canonical current authority with a live operation and fence",
    "postgres": true
  },
  {
    "file": "tests/platform/codebuild-launch-authority.test.ts",
    "suite": "CodeBuild launch authority [postgres]",
    "test": "refuses missing plan evidence through canonical current authority with a live operation and fence",
    "postgres": true
  },
  {
    "file": "tests/platform/codebuild-launch-authority.test.ts",
    "suite": "CodeBuild launch authority [postgres]",
    "test": "refuses moved approval round through canonical current authority with a live operation and fence",
    "postgres": true
  },
  {
    "file": "tests/platform/codebuild-launch-authority.test.ts",
    "suite": "CodeBuild launch authority [postgres]",
    "test": "reevaluates unchanged authority after an observed PostgreSQL resource lock wait before any launch",
    "postgres": true
  },
  {
    "file": "tests/platform/codebuild-launch-authority.test.ts",
    "suite": "CodeBuild launch authority [postgres]",
    "test": "reevaluates revoked approver role after an observed PostgreSQL resource lock wait before any launch",
    "postgres": true
  },
  {
    "file": "tests/platform/codebuild-launch-authority.test.ts",
    "suite": "CodeBuild launch authority [postgres]",
    "test": "reevaluates new approval count after an observed PostgreSQL resource lock wait before any launch",
    "postgres": true
  },
  {
    "file": "tests/platform/codebuild-launch-authority.test.ts",
    "suite": "CodeBuild launch authority [postgres]",
    "test": "reevaluates current policy deny after an observed PostgreSQL resource lock wait before any launch",
    "postgres": true
  },
  {
    "file": "tests/platform/codebuild-launch-authority.test.ts",
    "suite": "CodeBuild launch authority [postgres]",
    "test": "returns verified executed output with omitted NO_ARTIFACTS readback through canonical authority",
    "postgres": true
  },
  {
    "file": "tests/platform/codebuild-launch-authority.test.ts",
    "suite": "CodeBuild launch authority [postgres]",
    "test": "returns verified executed output with empty NO_ARTIFACTS readback through canonical authority",
    "postgres": true
  },
  {
    "file": "tests/platform/codebuild-launch-authority.test.ts",
    "suite": "CodeBuild launch authority [postgres]",
    "test": "returns verified executed output with default-flags NO_ARTIFACTS readback through canonical authority",
    "postgres": true
  },
  {
    "file": "tests/platform/codebuild-launch-authority.test.ts",
    "suite": "CodeBuild launch authority [postgres]",
    "test": "refuses a changed executed image even after the project was restored",
    "postgres": true
  },
  {
    "file": "tests/platform/codebuild-launch-authority.test.ts",
    "suite": "CodeBuild launch authority [postgres]",
    "test": "refuses a changed executed environment even after the project was restored",
    "postgres": true
  },
  {
    "file": "tests/platform/codebuild-launch-authority.test.ts",
    "suite": "CodeBuild launch authority [postgres]",
    "test": "refuses a changed executed repository even after the project was restored",
    "postgres": true
  },
  {
    "file": "tests/platform/codebuild-launch-authority.test.ts",
    "suite": "CodeBuild launch authority [postgres]",
    "test": "refuses a changed executed role even after the project was restored",
    "postgres": true
  },
  {
    "file": "tests/platform/codebuild-launch-authority.test.ts",
    "suite": "CodeBuild launch authority [postgres]",
    "test": "refuses a changed executed encryption even after the project was restored",
    "postgres": true
  },
  {
    "file": "tests/platform/codebuild-launch-authority.test.ts",
    "suite": "CodeBuild launch authority [postgres]",
    "test": "refuses a changed executed vpc even after the project was restored",
    "postgres": true
  },
  {
    "file": "tests/platform/codebuild-launch-authority.test.ts",
    "suite": "CodeBuild launch authority [postgres]",
    "test": "refuses a changed executed source even after the project was restored",
    "postgres": true
  },
  {
    "file": "tests/platform/codebuild-launch-authority.test.ts",
    "suite": "CodeBuild launch authority [postgres]",
    "test": "refuses a changed executed artifacts even after the project was restored",
    "postgres": true
  },
  {
    "file": "tests/platform/codebuild-launch-authority.test.ts",
    "suite": "CodeBuild launch authority [postgres]",
    "test": "refuses a changed executed secondaryArtifacts even after the project was restored",
    "postgres": true
  },
  {
    "file": "tests/platform/codebuild-launch-authority.test.ts",
    "suite": "CodeBuild launch authority [postgres]",
    "test": "refuses a changed executed missingEnvironment even after the project was restored",
    "postgres": true
  },
  {
    "file": "tests/platform/codebuild-launch-authority.test.ts",
    "suite": "CodeBuild launch authority [postgres]",
    "test": "refuses a changed executed duplicateEnvironment even after the project was restored",
    "postgres": true
  },
  {
    "file": "tests/platform/codebuild-launch-authority.test.ts",
    "suite": "CodeBuild launch authority [postgres]",
    "test": "refuses a changed executed duplicateDigest even after the project was restored",
    "postgres": true
  },
  {
    "file": "tests/platform/codebuild-launch-authority.test.ts",
    "suite": "CodeBuild launch authority [postgres]",
    "test": "refuses a changed executed digestType even after the project was restored",
    "postgres": true
  },
  {
    "file": "tests/platform/codebuild-launch-authority.test.ts",
    "suite": "CodeBuild launch authority [postgres]",
    "test": "refuses a changed executed retryLimit even after the project was restored",
    "postgres": true
  },
  {
    "file": "tests/platform/codebuild-launch-authority.test.ts",
    "suite": "CodeBuild launch authority [postgres]",
    "test": "refuses a changed executed retryAncestor even after the project was restored",
    "postgres": true
  },
  {
    "file": "tests/sources/github-store.test.ts",
    "suite": "GitHub source Postgres store (opt-in)",
    "test": "persists only identifiers and proof digests, and resolves bindings by workspace",
    "backend": "postgres"
  },
  {
    "file": "tests/sources/github-store.test.ts",
    "suite": "GitHub source Postgres store (opt-in)",
    "test": "refuses a changed callback workspace without consuming the legitimate intent",
    "backend": "postgres"
  },
  {
    "file": "tests/sources/github-store.test.ts",
    "suite": "GitHub source Postgres store (opt-in)",
    "test": "refuses a changed callback actor without consuming the legitimate intent",
    "backend": "postgres"
  },
  {
    "file": "tests/sources/github-store.test.ts",
    "suite": "GitHub source Postgres store (opt-in)",
    "test": "refuses a changed callback browser without consuming the legitimate intent",
    "backend": "postgres"
  },
  {
    "file": "tests/sources/github-store.test.ts",
    "suite": "GitHub source Postgres store (opt-in)",
    "test": "refuses a changed callback state without consuming the legitimate intent",
    "backend": "postgres"
  },
  {
    "file": "tests/sources/github-store.test.ts",
    "suite": "GitHub source Postgres store (opt-in)",
    "test": "refuses expired intents at both transitions using database time",
    "backend": "postgres"
  },
  {
    "file": "tests/sources/github-store.test.ts",
    "suite": "GitHub source Postgres store (opt-in)",
    "test": "allows only one racing setup and one racing OAuth callback",
    "backend": "postgres"
  },
  {
    "file": "tests/sources/github-store.test.ts",
    "suite": "GitHub source Postgres store (opt-in)",
    "test": "stores hashed state/proof and never lets an install callback skip OAuth",
    "backend": "postgres"
  },
  {
    "file": "tests/sources/github-store.test.ts",
    "suite": "GitHub source Postgres store (opt-in)",
    "test": "rejects stale/racing bind intents rather than overwriting another admin's binding",
    "backend": "postgres"
  },
  {
    "file": "tests/sources/github-store.test.ts",
    "suite": "GitHub source Postgres store (opt-in)",
    "test": "revokes new access, preserves a monotonic version and requires a new install intent",
    "backend": "postgres"
  },
  {
    "file": "tests/sources/github-store.test.ts",
    "suite": "GitHub source Postgres store (opt-in)",
    "test": "blocks a consumed callback and serializes competing revocation and replacement",
    "backend": "postgres"
  },
  {
    "file": "tests/sources/github-store.test.ts",
    "suite": "GitHub source Postgres store (opt-in)",
    "test": "scopes revocation by workspace and exact version; failed attempts retain legitimate intents",
    "backend": "postgres"
  },
  {
    "file": "tests/sources/github-store.test.ts",
    "suite": "GitHub source Postgres store (opt-in)",
    "test": "validates identifiers and numeric IDs without reflecting malicious data",
    "backend": "postgres"
  }
];
const BUILD_WORKFLOW_REQUIREMENTS = [
  {
    "file": "tests/workflows/deploy.test.ts",
    "suite": "deploy: lease loss and mutating-step failures",
    "test": "an unknown build launch outcome is uncertain and never automatically retried"
  },
  {
    "file": "tests/workflows/deploy.test.ts",
    "suite": "deploy: lease loss and mutating-step failures",
    "test": "pre-patch build retry history retains its original commands and failed classification on replay"
  },
  {
    "file": "tests/workflows/deploy.test.ts",
    "suite": "deploy: lease loss and mutating-step failures",
    "test": "a build that fails after the apply is failed, and says the apply stays"
  },
  {
    "file": "tests/workflows/deploy.test.ts",
    "suite": "deploy: cancellation",
    "test": "cancelling a pending build retains an uncertain accepted writer"
  },
  {
    "file": "tests/workflows/deploy.test.ts",
    "suite": "deploy: cancellation",
    "test": "pre-patch build cancellation history retains its cancelled outcome on replay"
  },
  {
    "file": "tests/workflows/failures.test.ts",
    "suite": "classifyFailure: the failure -> status table",
    "test": "retains unconfirmed patched build errors and timeouts as uncertain without changing legacy classification"
  },
  {
    "file": "tests/workflows/failures.test.ts",
    "suite": "the may-have-acted table and retry policies (policies.ts)",
    "test": "gives the patched build one attempt and waits for cancellation while retaining historical build options"
  },
  {
    "file": "tests/execution/release.test.ts",
    "suite": "buildArtifacts",
    "test": "retains a later parallel lost-response uncertainty over an earlier definitive failure and starts no fourth build"
  },
  {
    "file": "tests/execution/release.test.ts",
    "suite": "buildArtifacts",
    "test": "retains a later parallel polling-deadline uncertainty over an earlier definitive failure and starts no fourth build"
  }
];
const CODEBUILD_POSTGRES_FILE = "tests/platform/codebuild-launch-authority.test.ts";
const GITHUB_WEBHOOK_POSTGRES_CASES = [
  "duplicates and concurrent redeliveries commit one receipt, version change and audit per tenant",
  "refuses a delivery GUID reused with a different signed body without partial mutations",
  "changing the unsigned GUID cannot replay signed bytes against a freshly rebound row",
  "receipt, epoch, audit and intent invalidation roll back on an actual SQL audit failure",
  "fences consumed callbacks including expectedVersion=0 before any binding row exists",
  "refuses an actual consumed first binding after signed installation revocation",
  "refuses an actual consumed existing binding after signed installation revocation",
  "serializes webhook revocation with a first-binding transaction holding the same epoch lock"
].map(test => ({ file: "tests/sources/github-webhook.test.ts", suite: "GitHub webhook SQL [postgres]", test, postgres: true }));
const GITHUB_WEBHOOK_POSTGRES_REQUIREMENT = { file: "tests/sources/github-webhook.test.ts", suite: "GitHub webhook SQL [postgres]", postgres: true };

// Committed source13 scenarios are mandatory even when a suite/source file is
// missing. SQL/Tofu receipts do not establish live GitHub or cloud acceptance.
// Exact owning fixture and stage evidence counterparts are separate reviewed prerequisites.
export const SOURCE_FIXTURE_POSTGRES_REQUIREMENTS = [
  {
    "file": "tests/platform/composition.test.ts",
    "suite": "platform composition",
    "test": "captures optional tool authority absent at composition before lazy resolution",
    "backend": "postgres"
  },
  {
    "file": "tests/platform/composition.test.ts",
    "suite": "platform composition",
    "test": "captures optional tool authority present at composition before lazy resolution",
    "backend": "postgres"
  },
  {
    "file": "tests/platform/source-bundle-composition.test.ts",
    "suite": "source-bundle execution wiring",
    "test": "forwards the download configuration and preserves resource overrides",
    "backend": "postgres"
  },
  {
    "file": "tests/platform/source-bundle-composition.test.ts",
    "suite": "source-bundle execution wiring",
    "test": "uses the injected resource store with the activity's workspace and environment",
    "backend": "postgres"
  },
  {
    "file": "tests/platform/source-bundle-composition.test.ts",
    "suite": "source-bundle execution wiring",
    "test": "composes Azure preparation, stored-source reading and the SQL launch journal by default",
    "backend": "postgres"
  },
  {
    "file": "tests/platform/source-bundle-composition.test.ts",
    "suite": "source-bundle execution wiring",
    "test": "uses the trusted connection binding without a source resolver override through ACR launch",
    "backend": "postgres"
  },
  {
    "file": "tests/platform/source-bundle-composition.test.ts",
    "suite": "source-bundle execution wiring",
    "test": "refuses an Azure environment without a binding in the composed preparation port",
    "backend": "postgres"
  },
  {
    "file": "tests/platform/source-bundle-github.test.ts",
    "suite": "C3 default GitHub App acquisition",
    "test": "uses the default connector in the existing composition hook and returns archive identifiers only",
    "backend": "postgres"
  },
  {
    "file": "tests/platform/source-bundle-azure.test.ts",
    "suite": "provider-dispatched Azure source preparation",
    "test": "prepares canonical tar.gz in the bound container and passes exact bytes to ACR",
    "backend": "postgres"
  },
  {
    "file": "tests/platform/source-bundle-azure.test.ts",
    "suite": "provider-dispatched Azure source preparation",
    "test": "rereads the stored bundle on another instance without downloading a moving GitHub ref",
    "backend": "postgres"
  },
  {
    "file": "tests/platform/source-bundle-azure.test.ts",
    "suite": "provider-dispatched Azure source preparation",
    "test": "clearly refuses missing storage bindings before downloading source: undefined",
    "backend": "postgres"
  },
  {
    "file": "tests/platform/source-bundle-azure.test.ts",
    "suite": "provider-dispatched Azure source preparation",
    "test": "clearly refuses missing storage bindings before downloading source: resolver returning null",
    "backend": "postgres"
  },
  {
    "file": "tests/platform/source-bundle-azure.test.ts",
    "suite": "provider-dispatched Azure source preparation",
    "test": "refuses a cross-tenant workspaceId resource lookup",
    "backend": "postgres"
  },
  {
    "file": "tests/platform/source-bundle-azure.test.ts",
    "suite": "provider-dispatched Azure source preparation",
    "test": "refuses a cross-tenant environmentId resource lookup",
    "backend": "postgres"
  },
  {
    "file": "tests/platform/source-bundle-azure.test.ts",
    "suite": "provider-dispatched Azure source preparation",
    "test": "refuses a different pipeline source and a mismatched provider/session before acquisition",
    "backend": "postgres"
  },
  {
    "file": "tests/platform/source-bundle-azure.test.ts",
    "suite": "provider-dispatched Azure source preparation",
    "test": "refuses changed stored bytes before an ACR upload or schedule",
    "backend": "postgres"
  },
  {
    "file": "tests/platform/source-bundle-azure.test.ts",
    "suite": "provider-dispatched Azure source preparation",
    "test": "propagates C3's lowered compressed-size ceiling to the stored source reader",
    "backend": "postgres"
  },
  {
    "file": "tests/platform/source-bundle-azure.test.ts",
    "suite": "provider-dispatched Azure source preparation",
    "test": "binds the private GitHub connector to the activity's tenant and environment",
    "backend": "postgres"
  }
];
export const SOURCE_PLAN_EVIDENCE_POSTGRES_REQUIREMENTS = [
  {
    "file": "tests/controlplane/source-plan-evidence.test.ts",
    "suite": "source plan evidence authority [postgres]",
    "test": "selects the original plan after a later final plan with the same digest without deleting either row",
    "postgres": true
  },
  {
    "file": "tests/controlplane/source-plan-evidence.test.ts",
    "suite": "source plan evidence authority [postgres]",
    "test": "keeps plan selection scoped to the exact tenant operation kind digest and stage",
    "postgres": true
  },
  {
    "file": "tests/controlplane/source-plan-evidence.test.ts",
    "suite": "source plan evidence authority [postgres]",
    "test": "refuses final-only source evidence before a build or tool mutation",
    "postgres": true
  },
  {
    "file": "tests/controlplane/source-plan-evidence.test.ts",
    "suite": "source plan evidence authority [postgres]",
    "test": "retains the non-simulated review guard when selecting a plan stage",
    "postgres": true
  }
];

// Accepted G2 native cases are literal requirements; source deletion cannot remove them.
// Final MCP admission uses native SQL; hosted role/source protocols remain explicit models.
export const MCP_START_SOURCE_AUTHORITY_POSTGRES_REQUIREMENTS = [
  {
    "file": "tests/controlplane/mcp-start-source-authority.test.ts",
    "suite": "MCP final start source authority [postgres; modeled external protocols]",
    "test": "final native start CAS refuses full manifest JSON committed during delayed human role lookup",
    "backend": "postgres"
  },
  {
    "file": "tests/controlplane/mcp-start-source-authority.test.ts",
    "suite": "MCP final start source authority [postgres; modeled external protocols]",
    "test": "final native start CAS refuses revision number committed during delayed human role lookup",
    "backend": "postgres"
  },
  {
    "file": "tests/controlplane/mcp-start-source-authority.test.ts",
    "suite": "MCP final start source authority [postgres; modeled external protocols]",
    "test": "final native start CAS refuses foreign revision tenant committed during delayed human role lookup",
    "backend": "postgres"
  },
  {
    "file": "tests/controlplane/mcp-start-source-authority.test.ts",
    "suite": "MCP final start source authority [postgres; modeled external protocols]",
    "test": "final native start CAS refuses foreign project tenant committed during delayed human role lookup",
    "backend": "postgres"
  },
  {
    "file": "tests/controlplane/mcp-start-source-authority.test.ts",
    "suite": "MCP final start source authority [postgres; modeled external protocols]",
    "test": "final native start CAS refuses environment region committed during delayed human role lookup",
    "backend": "postgres"
  },
  {
    "file": "tests/controlplane/mcp-start-source-authority.test.ts",
    "suite": "MCP final start source authority [postgres; modeled external protocols]",
    "test": "final native start CAS refuses replaced environment connection committed during delayed human role lookup",
    "backend": "postgres"
  },
  {
    "file": "tests/controlplane/mcp-start-source-authority.test.ts",
    "suite": "MCP final start source authority [postgres; modeled external protocols]",
    "test": "final native start CAS refuses removed environment connection committed during delayed human role lookup",
    "backend": "postgres"
  },
  {
    "file": "tests/controlplane/mcp-start-source-authority.test.ts",
    "suite": "MCP final start source authority [postgres; modeled external protocols]",
    "test": "final native start CAS refuses foreign environment tenant committed during delayed human role lookup",
    "backend": "postgres"
  },
  {
    "file": "tests/controlplane/mcp-start-source-authority.test.ts",
    "suite": "MCP final start source authority [postgres; modeled external protocols]",
    "test": "final native start CAS refuses foreign deployment association committed during delayed human role lookup",
    "backend": "postgres"
  },
  {
    "file": "tests/controlplane/mcp-start-source-authority.test.ts",
    "suite": "MCP final start source authority [postgres; modeled external protocols]",
    "test": "final native start CAS refuses missing deployment committed during delayed human role lookup",
    "backend": "postgres"
  },
  {
    "file": "tests/controlplane/mcp-start-source-authority.test.ts",
    "suite": "MCP final start source authority [postgres; modeled external protocols]",
    "test": "final native start CAS refuses foreign deployment tenant committed during delayed human role lookup",
    "backend": "postgres"
  },
  {
    "file": "tests/controlplane/mcp-start-source-authority.test.ts",
    "suite": "MCP final start source authority [postgres; modeled external protocols]",
    "test": "final native start CAS refuses foreign connection tenant committed during delayed human role lookup",
    "backend": "postgres"
  },
  {
    "file": "tests/controlplane/mcp-start-source-authority.test.ts",
    "suite": "MCP final start source authority [postgres; modeled external protocols]",
    "test": "final native start CAS refuses foreign manifest tenant committed during delayed human role lookup",
    "backend": "postgres"
  },
  {
    "file": "tests/controlplane/mcp-start-source-authority.test.ts",
    "suite": "MCP final start source authority [postgres; modeled external protocols]",
    "test": "final native start CAS refuses missing manifest committed during delayed human role lookup",
    "backend": "postgres"
  },
  {
    "file": "tests/controlplane/mcp-start-source-authority.test.ts",
    "suite": "MCP final start source authority [postgres; modeled external protocols]",
    "test": "final native start CAS refuses revoked provider connection committed during delayed human role lookup",
    "backend": "postgres"
  },
  {
    "file": "tests/controlplane/mcp-start-source-authority.test.ts",
    "suite": "MCP final start source authority [postgres; modeled external protocols]",
    "test": "subject demotion during a held valid modeled grant is checked by the final native membership predicate",
    "backend": "postgres"
  },
  {
    "file": "tests/controlplane/mcp-start-source-authority.test.ts",
    "suite": "MCP final start source authority [postgres; modeled external protocols]",
    "test": "subject removal during a held valid modeled grant is checked by the final native membership predicate",
    "backend": "postgres"
  },
  {
    "file": "tests/controlplane/mcp-start-source-authority.test.ts",
    "suite": "MCP final start source authority [postgres; modeled external protocols]",
    "test": "subject foreign workspace during a held valid modeled grant is checked by the final native membership predicate",
    "backend": "postgres"
  },
  {
    "file": "tests/controlplane/mcp-start-source-authority.test.ts",
    "suite": "MCP final start source authority [postgres; modeled external protocols]",
    "test": "subject unchanged membership during a held valid modeled grant is checked by the final native membership predicate",
    "backend": "postgres"
  },
  {
    "file": "tests/controlplane/mcp-start-source-authority.test.ts",
    "suite": "MCP final start source authority [postgres; modeled external protocols]",
    "test": "subject benign member metadata during a held valid modeled grant is checked by the final native membership predicate",
    "backend": "postgres"
  },
  {
    "file": "tests/controlplane/mcp-start-source-authority.test.ts",
    "suite": "MCP final start source authority [postgres; modeled external protocols]",
    "test": "initial prepared intent refuses full manifest JSON committed during delayed human role lookup",
    "backend": "postgres"
  },
  {
    "file": "tests/controlplane/mcp-start-source-authority.test.ts",
    "suite": "MCP final start source authority [postgres; modeled external protocols]",
    "test": "initial prepared intent refuses revision number committed during delayed human role lookup",
    "backend": "postgres"
  },
  {
    "file": "tests/controlplane/mcp-start-source-authority.test.ts",
    "suite": "MCP final start source authority [postgres; modeled external protocols]",
    "test": "initial prepared intent refuses replaced environment connection committed during delayed human role lookup",
    "backend": "postgres"
  },
  {
    "file": "tests/controlplane/mcp-start-source-authority.test.ts",
    "suite": "MCP final start source authority [postgres; modeled external protocols]",
    "test": "initial prepared intent refuses revoked provider connection committed during delayed human role lookup",
    "backend": "postgres"
  },
  {
    "file": "tests/controlplane/mcp-start-source-authority.test.ts",
    "suite": "MCP final start source authority [postgres; modeled external protocols]",
    "test": "unchanged owning projection and genuine source-free absence permit one permanent start across independent pools",
    "backend": "postgres"
  },
  {
    "file": "tests/controlplane/mcp-start-source-authority.test.ts",
    "suite": "MCP final start source authority [postgres; modeled external protocols]",
    "test": "benign working copy and display advance during role lookup preserves the exact original saved operation",
    "backend": "postgres"
  },
  {
    "file": "tests/controlplane/mcp-start-source-authority.test.ts",
    "suite": "MCP final start source authority [postgres; modeled external protocols]",
    "test": "benign history progress and newer UI pointer advance during role lookup preserves the exact original saved operation",
    "backend": "postgres"
  },
  {
    "file": "tests/controlplane/mcp-start-source-authority.test.ts",
    "suite": "MCP final start source authority [postgres; modeled external protocols]",
    "test": "retained native source start fences unchanged private binding during delayed human role lookup",
    "backend": "postgres"
  },
  {
    "file": "tests/controlplane/mcp-start-source-authority.test.ts",
    "suite": "MCP final start source authority [postgres; modeled external protocols]",
    "test": "retained native source start fences revoked private binding during delayed human role lookup",
    "backend": "postgres"
  },
  {
    "file": "tests/controlplane/mcp-start-source-authority.test.ts",
    "suite": "MCP final start source authority [postgres; modeled external protocols]",
    "test": "retained native source start fences removed private binding during delayed human role lookup",
    "backend": "postgres"
  },
  {
    "file": "tests/controlplane/mcp-start-source-authority.test.ts",
    "suite": "MCP final start source authority [postgres; modeled external protocols]",
    "test": "retained native source start fences replaced private binding during delayed human role lookup",
    "backend": "postgres"
  },
  {
    "file": "tests/controlplane/mcp-start-source-authority.test.ts",
    "suite": "MCP final start source authority [postgres; modeled external protocols]",
    "test": "retained native source start fences introduced public binding during delayed human role lookup",
    "backend": "postgres"
  },
  {
    "file": "tests/controlplane/mcp-start-source-authority.test.ts",
    "suite": "MCP final start source authority [postgres; modeled external protocols]",
    "test": "final native source start refuses full service JSON mutation with unchanged stored digest during role lookup",
    "backend": "postgres"
  },
  {
    "file": "tests/controlplane/mcp-start-source-authority.test.ts",
    "suite": "MCP final start source authority [postgres; modeled external protocols]",
    "test": "final native source start refuses full pipeline JSON mutation with unchanged stored digest during role lookup",
    "backend": "postgres"
  },
  {
    "file": "tests/controlplane/mcp-start-source-authority.test.ts",
    "suite": "MCP final start source authority [postgres; modeled external protocols]",
    "test": "final native source start refuses changed planning evidence JSON with the same concrete plan digest during role lookup",
    "backend": "postgres"
  },
  {
    "file": "tests/controlplane/mcp-start-source-authority.test.ts",
    "suite": "MCP final start source authority [postgres; modeled external protocols]",
    "test": "native source start refuses missing source before creating any intent",
    "backend": "postgres"
  },
  {
    "file": "tests/controlplane/mcp-start-source-authority.test.ts",
    "suite": "MCP final start source authority [postgres; modeled external protocols]",
    "test": "native source start refuses foreign source before creating any intent",
    "backend": "postgres"
  },
  {
    "file": "tests/controlplane/mcp-start-source-authority.test.ts",
    "suite": "MCP final start source authority [postgres; modeled external protocols]",
    "test": "native source start refuses stripped source before creating any intent",
    "backend": "postgres"
  },
  {
    "file": "tests/controlplane/mcp-start-source-authority.test.ts",
    "suite": "MCP final start source authority [postgres; modeled external protocols]",
    "test": "concrete managed Git prepare refuses combined native source and every review-field absence committed by an independent pool",
    "backend": "postgres"
  },
  {
    "file": "tests/controlplane/mcp-start-source-authority.test.ts",
    "suite": "MCP final start source authority [postgres; modeled external protocols]",
    "test": "concrete managed Git claim refuses combined native source and every review-field absence committed by an independent pool",
    "backend": "postgres"
  },
  {
    "file": "tests/controlplane/mcp-start-source-authority.test.ts",
    "suite": "MCP final start source authority [postgres; modeled external protocols]",
    "test": "initial managed Git planning start with null plan digest and genuine native source-review absence remains permitted once",
    "backend": "postgres"
  },
  {
    "file": "tests/controlplane/mcp-start-source-authority.test.ts",
    "suite": "MCP final start source authority [postgres; modeled external protocols]",
    "test": "native source start refuses revoked modeled integration during its delayed current role lookup",
    "backend": "postgres"
  },
  {
    "file": "tests/controlplane/mcp-start-source-authority.test.ts",
    "suite": "MCP final start source authority [postgres; modeled external protocols]",
    "test": "native source start refuses demoted current human during its delayed current role lookup",
    "backend": "postgres"
  },
  {
    "file": "tests/controlplane/mcp-start-source-authority.test.ts",
    "suite": "MCP final start source authority [postgres; modeled external protocols]",
    "test": "immutable MCP argument binding refuses changed connectionId before source admission",
    "backend": "postgres"
  },
  {
    "file": "tests/controlplane/mcp-start-source-authority.test.ts",
    "suite": "MCP final start source authority [postgres; modeled external protocols]",
    "test": "immutable MCP argument binding refuses changed preApproved before source admission",
    "backend": "postgres"
  },
  {
    "file": "tests/controlplane/mcp-start-source-authority.test.ts",
    "suite": "MCP final start source authority [postgres; modeled external protocols]",
    "test": "matching arbitrary public rows cannot replace default opener and configured product topology provenance",
    "backend": "postgres"
  },
  {
    "file": "tests/controlplane/mcp-start-source-authority.test.ts",
    "suite": "MCP final start source authority [postgres; modeled external protocols]",
    "test": "genuine explicit-port native opener target remains equal only to its immutable opening host database and user",
    "backend": "postgres"
  },
  {
    "file": "tests/controlplane/mcp-start-source-authority.test.ts",
    "suite": "MCP final start source authority [postgres; modeled external protocols]",
    "test": "genuine cached native handle refuses a changed shared-host pooler realm configuration without relabeling its opening target",
    "backend": "postgres"
  },
  {
    "file": "tests/controlplane/mcp-start-source-authority.test.ts",
    "suite": "MCP final start source authority [postgres; modeled external protocols]",
    "test": "opening option mutation after its awaited driver boundary cannot rewrite genuine target provenance",
    "backend": "postgres"
  },
  {
    "file": "tests/controlplane/mcp-start-source-authority.test.ts",
    "suite": "MCP final start source authority [postgres; modeled external protocols]",
    "test": "missing explicit port and PGPORT mutation across opening cannot acquire target provenance",
    "backend": "postgres"
  },
  {
    "file": "tests/controlplane/mcp-start-source-authority.test.ts",
    "suite": "MCP final start source authority [postgres; modeled external protocols]",
    "test": "native startup query user override cannot obtain opening-target provenance from the URL realm",
    "backend": "postgres"
  },
  {
    "file": "tests/controlplane/mcp-start-source-authority.test.ts",
    "suite": "MCP final start source authority [postgres; modeled external protocols]",
    "test": "native startup query database override cannot obtain opening-target provenance from the URL realm",
    "backend": "postgres"
  },
  {
    "file": "tests/controlplane/mcp-start-source-authority.test.ts",
    "suite": "MCP final start source authority [postgres; modeled external protocols]",
    "test": "native opener preserves legacy construction but refuses options URL options for new fixed target provenance",
    "backend": "postgres"
  },
  {
    "file": "tests/controlplane/mcp-start-source-authority.test.ts",
    "suite": "MCP final start source authority [postgres; modeled external protocols]",
    "test": "native opener preserves legacy construction but refuses application_name URL options for new fixed target provenance",
    "backend": "postgres"
  },
  {
    "file": "tests/controlplane/mcp-start-source-authority.test.ts",
    "suite": "MCP final start source authority [postgres; modeled external protocols]",
    "test": "native opener preserves legacy construction but refuses unknown URL options for new fixed target provenance",
    "backend": "postgres"
  },
  {
    "file": "tests/controlplane/mcp-start-source-authority.test.ts",
    "suite": "MCP final start source authority [postgres; modeled external protocols]",
    "test": "native opener preserves legacy construction but refuses duplicate sslmode URL options for new fixed target provenance",
    "backend": "postgres"
  },
  {
    "file": "tests/controlplane/mcp-start-source-authority.test.ts",
    "suite": "MCP final start source authority [postgres; modeled external protocols]",
    "test": "native opener preserves legacy construction but refuses unproved TLS mode URL options for new fixed target provenance",
    "backend": "postgres"
  },
  {
    "file": "tests/controlplane/mcp-start-source-authority.test.ts",
    "suite": "MCP final start source authority [postgres; modeled external protocols]",
    "test": "one target-neutral sslmode require retains genuine fixed opener provenance without claiming a TLS handshake",
    "backend": "postgres"
  },
  {
    "file": "tests/controlplane/mcp-start-source-authority.test.ts",
    "suite": "MCP final start source authority [postgres; modeled external protocols]",
    "test": "one target-neutral sslmode verify-full retains genuine fixed opener provenance without claiming a TLS handshake",
    "backend": "postgres"
  },
  {
    "file": "tests/controlplane/mcp-start-source-authority.test.ts",
    "suite": "MCP final start source authority [postgres; modeled external protocols]",
    "test": "closed or accessor-tampered genuine opener cannot satisfy the scalar target predicate",
    "backend": "postgres"
  },
  {
    "file": "tests/controlplane/mcp-start-source-authority.test.ts",
    "suite": "MCP final start source authority [postgres; modeled external protocols]",
    "test": "a retained prepared intent recaptures current native semantics without replacing its immutable binding",
    "backend": "postgres"
  },
  {
    "file": "tests/controlplane/mcp-start-source-authority.test.ts",
    "suite": "MCP final start source authority [postgres; modeled external protocols]",
    "test": "lost permanent attempt commit acknowledgement leaves no false dispatch proof and never replays after product drift",
    "backend": "postgres"
  },
  {
    "file": "tests/controlplane/mcp-start-source-authority.test.ts",
    "suite": "MCP final start source authority [postgres; modeled external protocols]",
    "test": "attempted and acknowledged recovery remains evidence only after topology source and current roles become unavailable",
    "backend": "postgres"
  },
  {
    "file": "tests/controlplane/mcp-start-source-authority.test.ts",
    "suite": "MCP final start source authority [postgres; modeled external protocols]",
    "test": "post-role native CAS rechecks unchanged under explicit modeled hosted composition",
    "backend": "postgres"
  },
  {
    "file": "tests/controlplane/mcp-start-source-authority.test.ts",
    "suite": "MCP final start source authority [postgres; modeled external protocols]",
    "test": "post-role native CAS rechecks restored nested REST transport under explicit modeled hosted composition",
    "backend": "postgres"
  },
  {
    "file": "tests/controlplane/mcp-start-source-authority.test.ts",
    "suite": "MCP final start source authority [postgres; modeled external protocols]",
    "test": "post-role native CAS rechecks default REST method under explicit modeled hosted composition",
    "backend": "postgres"
  },
  {
    "file": "tests/controlplane/mcp-start-source-authority.test.ts",
    "suite": "MCP final start source authority [postgres; modeled external protocols]",
    "test": "post-role native CAS rechecks default REST fetch under explicit modeled hosted composition",
    "backend": "postgres"
  },
  {
    "file": "tests/controlplane/mcp-start-source-authority.test.ts",
    "suite": "MCP final start source authority [postgres; modeled external protocols]",
    "test": "post-role native CAS rechecks default REST accessor under explicit modeled hosted composition",
    "backend": "postgres"
  },
  {
    "file": "tests/controlplane/mcp-start-source-authority.test.ts",
    "suite": "MCP final start source authority [postgres; modeled external protocols]",
    "test": "post-role native CAS rechecks store selection under explicit modeled hosted composition",
    "backend": "postgres"
  },
  {
    "file": "tests/controlplane/mcp-start-source-authority.test.ts",
    "suite": "MCP final start source authority [postgres; modeled external protocols]",
    "test": "post-role native CAS rechecks opening pooler realm under explicit modeled hosted composition",
    "backend": "postgres"
  },
  {
    "file": "tests/controlplane/mcp-start-source-authority.test.ts",
    "suite": "MCP final start source authority [postgres; modeled external protocols]",
    "test": "post-role native CAS rechecks configured database under explicit modeled hosted composition",
    "backend": "postgres"
  },
  {
    "file": "tests/controlplane/mcp-start-source-authority.test.ts",
    "suite": "MCP final start source authority [postgres; modeled external protocols]",
    "test": "post-role native CAS rechecks startup override under explicit modeled hosted composition",
    "backend": "postgres"
  }
];

// Locked SDK constructor/protocol controls require no network and supply no PostgreSQL substitute.
export const MCP_START_SOURCE_AUTHORITY_SDK_REQUIREMENTS = [
  {
    "file": "tests/controlplane/mcp-start-source-authority.test.ts",
    "suite": "default product client provenance [SDK protocol; no network]",
    "test": "only the privately created default client satisfies the fixed owning target predicate"
  },
  {
    "file": "tests/controlplane/mcp-start-source-authority.test.ts",
    "suite": "default product client provenance [SDK protocol; no network]",
    "test": "changed cached default method refuses private factory provenance"
  },
  {
    "file": "tests/controlplane/mcp-start-source-authority.test.ts",
    "suite": "default product client provenance [SDK protocol; no network]",
    "test": "changed cached default method accessor refuses private factory provenance"
  },
  {
    "file": "tests/controlplane/mcp-start-source-authority.test.ts",
    "suite": "default product client provenance [SDK protocol; no network]",
    "test": "changed cached default rest URL refuses private factory provenance"
  },
  {
    "file": "tests/controlplane/mcp-start-source-authority.test.ts",
    "suite": "default product client provenance [SDK protocol; no network]",
    "test": "changed cached default rest schema refuses private factory provenance"
  },
  {
    "file": "tests/controlplane/mcp-start-source-authority.test.ts",
    "suite": "default product client provenance [SDK protocol; no network]",
    "test": "changing process configuration after module capture cannot relabel the existing cached client"
  },
  {
    "file": "tests/controlplane/mcp-start-source-authority.test.ts",
    "suite": "default product client provenance [SDK protocol; no network]",
    "test": "actual cached SDK REST from substitution refuses and exact original restoration permits native provenance"
  },
  {
    "file": "tests/controlplane/mcp-start-source-authority.test.ts",
    "suite": "default product client provenance [SDK protocol; no network]",
    "test": "actual cached SDK REST schema substitution refuses and exact original restoration permits native provenance"
  },
  {
    "file": "tests/controlplane/mcp-start-source-authority.test.ts",
    "suite": "default product client provenance [SDK protocol; no network]",
    "test": "actual cached SDK REST fetch substitution refuses and exact original restoration permits native provenance"
  },
  {
    "file": "tests/controlplane/mcp-start-source-authority.test.ts",
    "suite": "default product client provenance [SDK protocol; no network]",
    "test": "actual cached SDK REST fetch accessor substitution refuses and exact original restoration permits native provenance"
  },
  {
    "file": "tests/controlplane/mcp-start-source-authority.test.ts",
    "suite": "default product client provenance [SDK protocol; no network]",
    "test": "actual cached SDK REST method accessor substitution refuses and exact original restoration permits native provenance"
  },
  {
    "file": "tests/controlplane/mcp-start-source-authority.test.ts",
    "suite": "default product client provenance [SDK protocol; no network]",
    "test": "actual cached SDK REST prototype substitution refuses and exact original restoration permits native provenance"
  },
  {
    "file": "tests/controlplane/mcp-start-source-authority.test.ts",
    "suite": "default product client provenance [SDK protocol; no network]",
    "test": "actual cached SDK REST prototype from substitution refuses and exact original restoration permits native provenance"
  },
  {
    "file": "tests/controlplane/mcp-start-source-authority.test.ts",
    "suite": "default product client provenance [SDK protocol; no network]",
    "test": "actual cached SDK REST prototype schema substitution refuses and exact original restoration permits native provenance"
  },
  {
    "file": "tests/controlplane/mcp-start-source-authority.test.ts",
    "suite": "default product client provenance [SDK protocol; no network]",
    "test": "actual cached SDK REST fetch descriptor substitution refuses and exact original restoration permits native provenance"
  },
  {
    "file": "tests/controlplane/mcp-start-source-authority.test.ts",
    "suite": "default product client provenance [SDK protocol; no network]",
    "test": "actual cached SDK REST object substitution refuses and exact original restoration permits native provenance"
  },
  {
    "file": "tests/controlplane/mcp-start-source-authority.test.ts",
    "suite": "default product client provenance [SDK protocol; no network]",
    "test": "actual cached SDK REST own descriptor substitution refuses and exact original restoration permits native provenance"
  }
];

export const MCP_DURABLE_ADMISSION_POSTGRES_REQUIREMENTS = [
  {
    "file": "tests/controlplane/mcp-deploy-admission.test.ts",
    "suite": "MCP durable deployment admission [postgres; modeled product protocol]",
    "test": "commits the owning product projection before proposal and binds that same persisted row before execution",
    "backend": "postgres"
  },
  {
    "file": "tests/controlplane/mcp-deploy-admission.test.ts",
    "suite": "MCP durable deployment admission [postgres; modeled product protocol]",
    "test": "same immutable request recovers one reservation and one broker operation across an independent pool",
    "backend": "postgres"
  },
  {
    "file": "tests/controlplane/mcp-deploy-admission.test.ts",
    "suite": "MCP durable deployment admission [postgres; modeled product protocol]",
    "test": "same key with changed saved semantics refuses without replacing the retained operation association",
    "backend": "postgres"
  },
  {
    "file": "tests/controlplane/mcp-deploy-admission.test.ts",
    "suite": "MCP durable deployment admission [postgres; modeled product protocol]",
    "test": "same human and key from another integration reserves a distinct deployment identity",
    "backend": "postgres"
  },
  {
    "file": "tests/controlplane/mcp-deploy-admission.test.ts",
    "suite": "MCP durable deployment admission [postgres; modeled product protocol]",
    "test": "precommit projection interruption leaves no approved semantics or deployment row",
    "backend": "postgres"
  },
  {
    "file": "tests/controlplane/mcp-deploy-admission.test.ts",
    "suite": "MCP durable deployment admission [postgres; modeled product protocol]",
    "test": "lost projection commit acknowledgement recovers the committed reservation without minting a new identity",
    "backend": "postgres"
  },
  {
    "file": "tests/controlplane/mcp-deploy-admission.test.ts",
    "suite": "MCP durable deployment admission [postgres; modeled product protocol]",
    "test": "lost native proposal acknowledgement recovers the same operation then commits its owning association",
    "backend": "postgres"
  },
  {
    "file": "tests/controlplane/mcp-deploy-admission.test.ts",
    "suite": "MCP durable deployment admission [postgres; modeled product protocol]",
    "test": "lost association commit acknowledgement can recover the same association but cannot force a replacement",
    "backend": "postgres"
  },
  {
    "file": "tests/controlplane/mcp-deploy-admission.test.ts",
    "suite": "MCP durable deployment admission [postgres; modeled product protocol]",
    "test": "a competing association version change refuses rather than overwriting the committed operation link",
    "backend": "postgres"
  },
  {
    "file": "tests/controlplane/mcp-deploy-admission.test.ts",
    "suite": "MCP durable deployment admission [postgres; modeled product protocol]",
    "test": "foreign and missing product scope cannot create a deployment or native proposal",
    "backend": "postgres"
  },
  {
    "file": "tests/controlplane/mcp-deploy-admission.test.ts",
    "suite": "MCP durable deployment admission [postgres; modeled product protocol]",
    "test": "foreign returned manifest workspace and missing or malformed native manifest refuse product mutation",
    "backend": "postgres"
  },
  {
    "file": "tests/controlplane/mcp-deploy-admission.test.ts",
    "suite": "MCP durable deployment admission [postgres; modeled product protocol]",
    "test": "a missing or foreign deployment association refuses before native execution claim",
    "backend": "postgres"
  },
  {
    "file": "tests/controlplane/mcp-deploy-admission.test.ts",
    "suite": "MCP durable deployment admission [postgres; modeled product protocol]",
    "test": "uncached current full manifest recipe mutation refuses despite the stale enclosing tool snapshot",
    "backend": "postgres"
  },
  {
    "file": "tests/controlplane/mcp-deploy-admission.test.ts",
    "suite": "MCP durable deployment admission [postgres; modeled product protocol]",
    "test": "current environment or owning connection change refuses the saved deployment source semantics",
    "backend": "postgres"
  },
  {
    "file": "tests/controlplane/mcp-deploy-admission.test.ts",
    "suite": "MCP durable deployment admission [postgres; modeled product protocol]",
    "test": "expired or revoked current requester cannot reserve a projection or claim its approved native operation",
    "backend": "postgres"
  },
  {
    "file": "tests/controlplane/mcp-deploy-admission.test.ts",
    "suite": "MCP durable deployment admission [postgres; modeled product protocol]",
    "test": "the exact persisted deployment input yields one permanent native start attempt across independent pools",
    "backend": "postgres"
  },
  {
    "file": "tests/controlplane/mcp-deploy-admission.test.ts",
    "suite": "MCP durable deployment admission [postgres; modeled product protocol]",
    "test": "malformed or foreign native deployment arguments cannot reserve a start intent for the owning operation",
    "backend": "postgres"
  },
  {
    "file": "tests/controlplane/mcp-deploy-admission.test.ts",
    "suite": "MCP durable deployment admission [postgres; modeled product protocol]",
    "test": "an uncertain attempted native start remains nonreplayable and an unrecorded claim supplies no recovery proof",
    "backend": "postgres"
  },
  {
    "file": "tests/capabilities/default-current-membership.test.ts",
    "suite": "cached default broker current membership [postgres; modeled product reads]",
    "test": "the cached native broker admits one current OAuth grant and consumes only its owning approval",
    "backend": "postgres"
  },
  {
    "file": "tests/capabilities/default-current-membership.test.ts",
    "suite": "cached default broker current membership [postgres; modeled product reads]",
    "test": "a cached native broker refuses an OAuth grant that became revoked before claim",
    "backend": "postgres"
  },
  {
    "file": "tests/capabilities/default-current-membership.test.ts",
    "suite": "cached default broker current membership [postgres; modeled product reads]",
    "test": "a cached native broker refuses an OAuth grant that became expired before claim",
    "backend": "postgres"
  },
  {
    "file": "tests/capabilities/default-current-membership.test.ts",
    "suite": "cached default broker current membership [postgres; modeled product reads]",
    "test": "a cached native broker refuses an OAuth grant that became foreign issuer before claim",
    "backend": "postgres"
  },
  {
    "file": "tests/capabilities/default-current-membership.test.ts",
    "suite": "cached default broker current membership [postgres; modeled product reads]",
    "test": "a cached native broker refuses an OAuth grant that became duplicate before claim",
    "backend": "postgres"
  },
  {
    "file": "tests/capabilities/default-current-membership.test.ts",
    "suite": "cached default broker current membership [postgres; modeled product reads]",
    "test": "OAuth revocation committed during the held current membership reply is observed before native claim",
    "backend": "postgres"
  }
];
export const AWS_BOOTSTRAP_READINESS_POSTGRES_REQUIREMENTS = [
  {
    "file": "tests/controlplane/opened-handle-ownership.test.ts",
    "suite": "opened platform handle ownership [postgres]",
    "test": "recognizes only the real open PostgreSQL handle and refuses its copied shape",
    "postgres": true
  },
  {
    "file": "tests/controlplane/opened-handle-ownership.test.ts",
    "suite": "opened platform handle ownership [postgres]",
    "test": "refuses an opened handle with replaced query until its exact descriptor is restored",
    "postgres": true
  },
  {
    "file": "tests/controlplane/opened-handle-ownership.test.ts",
    "suite": "opened platform handle ownership [postgres]",
    "test": "refuses an opened handle with replaced tx until its exact descriptor is restored",
    "postgres": true
  },
  {
    "file": "tests/controlplane/opened-handle-ownership.test.ts",
    "suite": "opened platform handle ownership [postgres]",
    "test": "refuses an opened handle with replaced exec until its exact descriptor is restored",
    "postgres": true
  },
  {
    "file": "tests/controlplane/opened-handle-ownership.test.ts",
    "suite": "opened platform handle ownership [postgres]",
    "test": "refuses an opened handle with replaced close until its exact descriptor is restored",
    "postgres": true
  },
  {
    "file": "tests/controlplane/opened-handle-ownership.test.ts",
    "suite": "opened platform handle ownership [postgres]",
    "test": "refuses an opened handle with replaced identity until its exact descriptor is restored",
    "postgres": true
  },
  {
    "file": "tests/controlplane/opened-handle-ownership.test.ts",
    "suite": "opened platform handle ownership [postgres]",
    "test": "refuses an opened handle with replaced kind until its exact descriptor is restored",
    "postgres": true
  },
  {
    "file": "tests/controlplane/opened-handle-ownership.test.ts",
    "suite": "opened platform handle ownership [postgres]",
    "test": "invalidates opener ownership synchronously when real close begins",
    "postgres": true
  },
  {
    "file": "tests/controlplane/opened-handle-ownership.test.ts",
    "suite": "opened platform handle ownership [postgres]",
    "test": "retains genuine membership and the process-wide pool across module reload",
    "postgres": true
  },
  {
    "file": "tests/controlplane/opened-handle-ownership.test.ts",
    "suite": "opened platform handle ownership [postgres]",
    "test": "keeps a genuine PGlite handle unsupported as PostgreSQL without relabeling it",
    "postgres": true
  },
  {
    "file": "tests/platform/aws-bootstrap-preflight-admission.test.ts",
    "suite": "native AWS bootstrap readiness admission [postgres]",
    "test": "uses native owners and a dedicated exact seven-policy observe session while retaining incomplete child-role coverage",
    "postgres": true
  },
  {
    "file": "tests/platform/aws-bootstrap-preflight-admission.test.ts",
    "suite": "native AWS bootstrap readiness admission [postgres]",
    "test": "inspects an exact current observed role but keeps legacy migration explicit without write admission",
    "postgres": true
  },
  {
    "file": "tests/platform/aws-bootstrap-preflight-admission.test.ts",
    "suite": "native AWS bootstrap readiness admission [postgres]",
    "test": "preserves a conflicting cloud boundary as an explicit operator result",
    "postgres": true
  },
  {
    "file": "tests/platform/aws-bootstrap-preflight-admission.test.ts",
    "suite": "native AWS bootstrap readiness admission [postgres]",
    "test": "keeps app compiler-parent inventory explicitly incomplete without inventing child role ARNs",
    "postgres": true
  },
  {
    "file": "tests/platform/aws-bootstrap-preflight-admission.test.ts",
    "suite": "native AWS bootstrap readiness admission [postgres]",
    "test": "keeps build compiler-parent inventory explicitly incomplete without inventing child role ARNs",
    "postgres": true
  },
  {
    "file": "tests/platform/aws-bootstrap-preflight-admission.test.ts",
    "suite": "native AWS bootstrap readiness admission [postgres]",
    "test": "keeps machine compiler-parent inventory explicitly incomplete without inventing child role ARNs",
    "postgres": true
  },
  {
    "file": "tests/platform/aws-bootstrap-preflight-admission.test.ts",
    "suite": "native AWS bootstrap readiness admission [postgres]",
    "test": "keeps scheduler compiler-parent inventory explicitly incomplete without inventing child role ARNs",
    "postgres": true
  },
  {
    "file": "tests/platform/aws-bootstrap-preflight-admission.test.ts",
    "suite": "native AWS bootstrap readiness admission [postgres]",
    "test": "keeps eksCluster compiler-parent inventory explicitly incomplete without inventing child role ARNs",
    "postgres": true
  },
  {
    "file": "tests/platform/aws-bootstrap-preflight-admission.test.ts",
    "suite": "native AWS bootstrap readiness admission [postgres]",
    "test": "keeps eksNode compiler-parent inventory explicitly incomplete without inventing child role ARNs",
    "postgres": true
  },
  {
    "file": "tests/platform/aws-bootstrap-preflight-admission.test.ts",
    "suite": "native AWS bootstrap readiness admission [postgres]",
    "test": "keeps unknown native role provenance unresolved without using older success or guessing absence",
    "postgres": true
  },
  {
    "file": "tests/platform/aws-bootstrap-preflight-admission.test.ts",
    "suite": "native AWS bootstrap readiness admission [postgres]",
    "test": "keeps simulated native role provenance unresolved without using older success or guessing absence",
    "postgres": true
  },
  {
    "file": "tests/platform/aws-bootstrap-preflight-admission.test.ts",
    "suite": "native AWS bootstrap readiness admission [postgres]",
    "test": "keeps error native role provenance unresolved without using older success or guessing absence",
    "postgres": true
  },
  {
    "file": "tests/platform/aws-bootstrap-preflight-admission.test.ts",
    "suite": "native AWS bootstrap readiness admission [postgres]",
    "test": "keeps stale native role provenance unresolved without using older success or guessing absence",
    "postgres": true
  },
  {
    "file": "tests/platform/aws-bootstrap-preflight-admission.test.ts",
    "suite": "native AWS bootstrap readiness admission [postgres]",
    "test": "keeps contradictory native role provenance unresolved without using older success or guessing absence",
    "postgres": true
  },
  {
    "file": "tests/platform/aws-bootstrap-preflight-admission.test.ts",
    "suite": "native AWS bootstrap readiness admission [postgres]",
    "test": "keeps deleted native role provenance unresolved without using older success or guessing absence",
    "postgres": true
  },
  {
    "file": "tests/platform/aws-bootstrap-preflight-admission.test.ts",
    "suite": "native AWS bootstrap readiness admission [postgres]",
    "test": "keeps unobserved native role provenance unresolved without using older success or guessing absence",
    "postgres": true
  },
  {
    "file": "tests/platform/aws-bootstrap-preflight-admission.test.ts",
    "suite": "native AWS bootstrap readiness admission [postgres]",
    "test": "refuses an unknown credential owner and a structurally labeled SQL owner before SDK calls",
    "postgres": true
  },
  {
    "file": "tests/platform/aws-bootstrap-preflight-admission.test.ts",
    "suite": "native AWS bootstrap readiness admission [postgres]",
    "test": "refuses a replaced registered credential callback before SDK calls",
    "postgres": true
  },
  {
    "file": "tests/platform/aws-bootstrap-preflight-admission.test.ts",
    "suite": "native AWS bootstrap readiness admission [postgres]",
    "test": "refuses a closed native owner and a genuine unsupported PGlite owner before SDK calls",
    "postgres": true
  },
  {
    "file": "tests/platform/aws-bootstrap-preflight-admission.test.ts",
    "suite": "native AWS bootstrap readiness admission [postgres]",
    "test": "refuses cancelled native authority before SDK calls",
    "postgres": true
  },
  {
    "file": "tests/platform/aws-bootstrap-preflight-admission.test.ts",
    "suite": "native AWS bootstrap readiness admission [postgres]",
    "test": "refuses uncertain native authority before SDK calls",
    "postgres": true
  },
  {
    "file": "tests/platform/aws-bootstrap-preflight-admission.test.ts",
    "suite": "native AWS bootstrap readiness admission [postgres]",
    "test": "refuses MCP holder native authority before SDK calls",
    "postgres": true
  },
  {
    "file": "tests/platform/aws-bootstrap-preflight-admission.test.ts",
    "suite": "native AWS bootstrap readiness admission [postgres]",
    "test": "refuses expired claim native authority before SDK calls",
    "postgres": true
  },
  {
    "file": "tests/platform/aws-bootstrap-preflight-admission.test.ts",
    "suite": "native AWS bootstrap readiness admission [postgres]",
    "test": "refuses expired lease native authority before SDK calls",
    "postgres": true
  },
  {
    "file": "tests/platform/aws-bootstrap-preflight-admission.test.ts",
    "suite": "native AWS bootstrap readiness admission [postgres]",
    "test": "refuses changed digest native authority before SDK calls",
    "postgres": true
  },
  {
    "file": "tests/platform/aws-bootstrap-preflight-admission.test.ts",
    "suite": "native AWS bootstrap readiness admission [postgres]",
    "test": "refuses revoked grant native authority before SDK calls",
    "postgres": true
  },
  {
    "file": "tests/platform/aws-bootstrap-preflight-admission.test.ts",
    "suite": "native AWS bootstrap readiness admission [postgres]",
    "test": "refuses foreign grant native authority before SDK calls",
    "postgres": true
  },
  {
    "file": "tests/platform/aws-bootstrap-preflight-admission.test.ts",
    "suite": "native AWS bootstrap readiness admission [postgres]",
    "test": "refuses a verified same-workspace connection outside the exact native environment mapping",
    "postgres": true
  },
  {
    "file": "tests/platform/aws-bootstrap-preflight-admission.test.ts",
    "suite": "native AWS bootstrap readiness admission [postgres]",
    "test": "refuses connection revocation committed during federation before the first inspector command",
    "postgres": true
  },
  {
    "file": "tests/platform/aws-bootstrap-preflight-admission.test.ts",
    "suite": "native AWS bootstrap readiness admission [postgres]",
    "test": "refuses credential callback replacement committed during federation before the first inspector command",
    "postgres": true
  },
  {
    "file": "tests/platform/aws-bootstrap-preflight-admission.test.ts",
    "suite": "native AWS bootstrap readiness admission [postgres]",
    "test": "refuses native method replacement committed during federation before the first inspector command",
    "postgres": true
  },
  {
    "file": "tests/platform/aws-bootstrap-preflight-admission.test.ts",
    "suite": "native AWS bootstrap readiness admission [postgres]",
    "test": "refuses resource removal during readback without persisting a compatible result",
    "postgres": true
  },
  {
    "file": "tests/platform/aws-bootstrap-preflight-admission.test.ts",
    "suite": "native AWS bootstrap readiness admission [postgres]",
    "test": "refuses resource addition during readback without persisting a compatible result",
    "postgres": true
  },
  {
    "file": "tests/platform/aws-bootstrap-preflight-admission.test.ts",
    "suite": "native AWS bootstrap readiness admission [postgres]",
    "test": "refuses observation replacement during readback without persisting a compatible result",
    "postgres": true
  },
  {
    "file": "tests/platform/aws-bootstrap-preflight-admission.test.ts",
    "suite": "native AWS bootstrap readiness admission [postgres]",
    "test": "refuses connection mapping during readback without persisting a compatible result",
    "postgres": true
  },
  {
    "file": "tests/platform/aws-bootstrap-preflight-admission.test.ts",
    "suite": "native AWS bootstrap readiness admission [postgres]",
    "test": "default observation composition preserves drift results and records supplemental incomplete readiness with default credentials",
    "postgres": true
  },
  {
    "file": "tests/platform/aws-bootstrap-preflight-admission.test.ts",
    "suite": "native AWS bootstrap readiness admission [postgres]",
    "test": "default observation composition retains observed results when supplemental native readiness is unavailable",
    "postgres": true
  }
];

// First-source binding scenarios remain mandatory even when their native test source disappears.
// Tenant-qualified worker acquisition controls retain the original 24 binding requirements.
// Exact accepted original-plan product and linked native authority cases. Models are named in their source suites.
export const PLAN_PRODUCT_AUTHORITY_POSTGRES_REQUIREMENTS = [
  {
    "file": "tests/controlplane/plan-artifact-product-authority.test.ts",
    "suite": "paired plan product dispatch authority [postgres; modeled current roles and hosted association]",
    "test": "final original-plan product dispatch fences environment region committed during held current role lookup",
    "backend": "postgres"
  },
  {
    "file": "tests/controlplane/plan-artifact-product-authority.test.ts",
    "suite": "paired plan product dispatch authority [postgres; modeled current roles and hosted association]",
    "test": "final original-plan product dispatch fences environment policies committed during held current role lookup",
    "backend": "postgres"
  },
  {
    "file": "tests/controlplane/plan-artifact-product-authority.test.ts",
    "suite": "paired plan product dispatch authority [postgres; modeled current roles and hosted association]",
    "test": "final original-plan product dispatch fences environment base domain committed during held current role lookup",
    "backend": "postgres"
  },
  {
    "file": "tests/controlplane/plan-artifact-product-authority.test.ts",
    "suite": "paired plan product dispatch authority [postgres; modeled current roles and hosted association]",
    "test": "final original-plan product dispatch fences replaced public connection committed during held current role lookup",
    "backend": "postgres"
  },
  {
    "file": "tests/controlplane/plan-artifact-product-authority.test.ts",
    "suite": "paired plan product dispatch authority [postgres; modeled current roles and hosted association]",
    "test": "final original-plan product dispatch fences removed public connection committed during held current role lookup",
    "backend": "postgres"
  },
  {
    "file": "tests/controlplane/plan-artifact-product-authority.test.ts",
    "suite": "paired plan product dispatch authority [postgres; modeled current roles and hosted association]",
    "test": "final original-plan product dispatch fences public connection mapping committed during held current role lookup",
    "backend": "postgres"
  },
  {
    "file": "tests/controlplane/plan-artifact-product-authority.test.ts",
    "suite": "paired plan product dispatch authority [postgres; modeled current roles and hosted association]",
    "test": "final original-plan product dispatch fences public connection region committed during held current role lookup",
    "backend": "postgres"
  },
  {
    "file": "tests/controlplane/plan-artifact-product-authority.test.ts",
    "suite": "paired plan product dispatch authority [postgres; modeled current roles and hosted association]",
    "test": "final original-plan product dispatch fences deleted environment committed during held current role lookup",
    "backend": "postgres"
  },
  {
    "file": "tests/controlplane/plan-artifact-product-authority.test.ts",
    "suite": "paired plan product dispatch authority [postgres; modeled current roles and hosted association]",
    "test": "final original-plan product dispatch fences foreign environment workspace committed during held current role lookup",
    "backend": "postgres"
  },
  {
    "file": "tests/controlplane/plan-artifact-product-authority.test.ts",
    "suite": "paired plan product dispatch authority [postgres; modeled current roles and hosted association]",
    "test": "final original-plan product dispatch fences foreign environment project committed during held current role lookup",
    "backend": "postgres"
  },
  {
    "file": "tests/controlplane/plan-artifact-product-authority.test.ts",
    "suite": "paired plan product dispatch authority [postgres; modeled current roles and hosted association]",
    "test": "final original-plan product dispatch fences deleted project committed during held current role lookup",
    "backend": "postgres"
  },
  {
    "file": "tests/controlplane/plan-artifact-product-authority.test.ts",
    "suite": "paired plan product dispatch authority [postgres; modeled current roles and hosted association]",
    "test": "final original-plan product dispatch fences foreign project workspace committed during held current role lookup",
    "backend": "postgres"
  },
  {
    "file": "tests/controlplane/plan-artifact-product-authority.test.ts",
    "suite": "paired plan product dispatch authority [postgres; modeled current roles and hosted association]",
    "test": "final original-plan product dispatch fences deleted approved revision committed during held current role lookup",
    "backend": "postgres"
  },
  {
    "file": "tests/controlplane/plan-artifact-product-authority.test.ts",
    "suite": "paired plan product dispatch authority [postgres; modeled current roles and hosted association]",
    "test": "final original-plan product dispatch fences foreign approved revision workspace committed during held current role lookup",
    "backend": "postgres"
  },
  {
    "file": "tests/controlplane/plan-artifact-product-authority.test.ts",
    "suite": "paired plan product dispatch authority [postgres; modeled current roles and hosted association]",
    "test": "final original-plan product dispatch fences full approved manifest JSON committed during held current role lookup",
    "backend": "postgres"
  },
  {
    "file": "tests/controlplane/plan-artifact-product-authority.test.ts",
    "suite": "paired plan product dispatch authority [postgres; modeled current roles and hosted association]",
    "test": "final original-plan product dispatch fences deleted deployment committed during held current role lookup",
    "backend": "postgres"
  },
  {
    "file": "tests/controlplane/plan-artifact-product-authority.test.ts",
    "suite": "paired plan product dispatch authority [postgres; modeled current roles and hosted association]",
    "test": "final original-plan product dispatch fences foreign deployment scope committed during held current role lookup",
    "backend": "postgres"
  },
  {
    "file": "tests/controlplane/plan-artifact-product-authority.test.ts",
    "suite": "paired plan product dispatch authority [postgres; modeled current roles and hosted association]",
    "test": "final original-plan product dispatch fences native provider config committed during held current role lookup",
    "backend": "postgres"
  },
  {
    "file": "tests/controlplane/plan-artifact-product-authority.test.ts",
    "suite": "paired plan product dispatch authority [postgres; modeled current roles and hosted association]",
    "test": "final original-plan product dispatch fences native provider revocation committed during held current role lookup",
    "backend": "postgres"
  },
  {
    "file": "tests/controlplane/plan-artifact-product-authority.test.ts",
    "suite": "paired plan product dispatch authority [postgres; modeled current roles and hosted association]",
    "test": "final original-plan product dispatch fences subject demotion committed during held current role lookup",
    "backend": "postgres"
  },
  {
    "file": "tests/controlplane/plan-artifact-product-authority.test.ts",
    "suite": "paired plan product dispatch authority [postgres; modeled current roles and hosted association]",
    "test": "final original-plan product dispatch fences subject removal committed during held current role lookup",
    "backend": "postgres"
  },
  {
    "file": "tests/controlplane/plan-artifact-product-authority.test.ts",
    "suite": "paired plan product dispatch authority [postgres; modeled current roles and hosted association]",
    "test": "final original-plan product dispatch fences foreign subject workspace committed during held current role lookup",
    "backend": "postgres"
  },
  {
    "file": "tests/controlplane/plan-artifact-product-authority.test.ts",
    "suite": "paired plan product dispatch authority [postgres; modeled current roles and hosted association]",
    "test": "final original-plan product dispatch fences approver demotion committed during held current role lookup",
    "backend": "postgres"
  },
  {
    "file": "tests/controlplane/plan-artifact-product-authority.test.ts",
    "suite": "paired plan product dispatch authority [postgres; modeled current roles and hosted association]",
    "test": "final original-plan product dispatch fences approver removal committed during held current role lookup",
    "backend": "postgres"
  },
  {
    "file": "tests/controlplane/plan-artifact-product-authority.test.ts",
    "suite": "paired plan product dispatch authority [postgres; modeled current roles and hosted association]",
    "test": "final original-plan product dispatch fences foreign approver workspace committed during held current role lookup",
    "backend": "postgres"
  },
  {
    "file": "tests/controlplane/plan-artifact-product-authority.test.ts",
    "suite": "paired plan product dispatch authority [postgres; modeled current roles and hosted association]",
    "test": "final original-plan product dispatch fences workspace policy replacement committed during held current role lookup",
    "backend": "postgres"
  },
  {
    "file": "tests/controlplane/plan-artifact-product-authority.test.ts",
    "suite": "paired plan product dispatch authority [postgres; modeled current roles and hosted association]",
    "test": "final original-plan product dispatch fences environment settings introduction committed during held current role lookup",
    "backend": "postgres"
  },
  {
    "file": "tests/controlplane/plan-artifact-product-authority.test.ts",
    "suite": "paired plan product dispatch authority [postgres; modeled current roles and hosted association]",
    "test": "final original-plan product dispatch fences foreign environment settings introduction committed during held current role lookup",
    "backend": "postgres"
  },
  {
    "file": "tests/controlplane/plan-artifact-product-authority.test.ts",
    "suite": "paired plan product dispatch authority [postgres; modeled current roles and hosted association]",
    "test": "final original-plan product dispatch fences plan evidence mutation committed during held current role lookup",
    "backend": "postgres"
  },
  {
    "file": "tests/controlplane/plan-artifact-product-authority.test.ts",
    "suite": "paired plan product dispatch authority [postgres; modeled current roles and hosted association]",
    "test": "final original-plan product dispatch fences benign UI pointers committed during held current role lookup",
    "backend": "postgres"
  },
  {
    "file": "tests/controlplane/plan-artifact-product-authority.test.ts",
    "suite": "paired plan product dispatch authority [postgres; modeled current roles and hosted association]",
    "test": "final original-plan product dispatch fences unchanged target committed during held current role lookup",
    "backend": "postgres"
  },
  {
    "file": "tests/controlplane/plan-artifact-product-authority.test.ts",
    "suite": "paired plan product dispatch authority [postgres; modeled current roles and hosted association]",
    "test": "observed three-connection original use-row wait refuses committed environment region before provider dispatch",
    "backend": "postgres"
  },
  {
    "file": "tests/controlplane/plan-artifact-product-authority.test.ts",
    "suite": "paired plan product dispatch authority [postgres; modeled current roles and hosted association]",
    "test": "observed three-connection original use-row wait refuses committed subject demotion before provider dispatch",
    "backend": "postgres"
  },
  {
    "file": "tests/controlplane/plan-artifact-product-authority.test.ts",
    "suite": "paired plan product dispatch authority [postgres; modeled current roles and hosted association]",
    "test": "observed three-connection original use-row wait refuses committed approver demotion before provider dispatch",
    "backend": "postgres"
  },
  {
    "file": "tests/controlplane/plan-artifact-product-authority.test.ts",
    "suite": "paired plan product dispatch authority [postgres; modeled current roles and hosted association]",
    "test": "observed three-connection original use-row wait refuses committed native provider revocation before provider dispatch",
    "backend": "postgres"
  },
  {
    "file": "tests/controlplane/plan-artifact-product-authority.test.ts",
    "suite": "paired plan product dispatch authority [postgres; modeled current roles and hosted association]",
    "test": "current native full service recipe mutation with unchanged spec digest refuses original product dispatch",
    "backend": "postgres"
  },
  {
    "file": "tests/controlplane/plan-artifact-product-authority.test.ts",
    "suite": "paired plan product dispatch authority [postgres; modeled current roles and hosted association]",
    "test": "current native full pipeline recipe mutation with unchanged spec digest refuses original product dispatch",
    "backend": "postgres"
  },
  {
    "file": "tests/controlplane/plan-artifact-product-authority.test.ts",
    "suite": "paired plan product dispatch authority [postgres; modeled current roles and hosted association]",
    "test": "observed three-connection ready use-row wait refuses changed product target before original claim",
    "backend": "postgres"
  },
  {
    "file": "tests/controlplane/plan-artifact-product-authority.test.ts",
    "suite": "paired plan product dispatch authority [postgres; modeled current roles and hosted association]",
    "test": "exact native claimed witness missing refuses original product dispatch",
    "backend": "postgres"
  },
  {
    "file": "tests/controlplane/plan-artifact-product-authority.test.ts",
    "suite": "paired plan product dispatch authority [postgres; modeled current roles and hosted association]",
    "test": "exact native claimed witness malformed refuses original product dispatch",
    "backend": "postgres"
  },
  {
    "file": "tests/controlplane/plan-artifact-product-authority.test.ts",
    "suite": "paired plan product dispatch authority [postgres; modeled current roles and hosted association]",
    "test": "exact native claimed witness foreign attempt refuses original product dispatch",
    "backend": "postgres"
  },
  {
    "file": "tests/controlplane/plan-artifact-product-authority.test.ts",
    "suite": "paired plan product dispatch authority [postgres; modeled current roles and hosted association]",
    "test": "published product origin refuses combined public owning-row removal before first claim",
    "backend": "postgres"
  },
  {
    "file": "tests/controlplane/plan-artifact-product-authority.test.ts",
    "suite": "paired plan product dispatch authority [postgres; modeled current roles and hosted association]",
    "test": "associated product destroy keeps original revision and rechecks destination subject demotion after held roles",
    "backend": "postgres"
  },
  {
    "file": "tests/controlplane/plan-artifact-product-authority.test.ts",
    "suite": "paired plan product dispatch authority [postgres; modeled current roles and hosted association]",
    "test": "associated product destroy keeps original revision and rechecks original subject demotion after held roles",
    "backend": "postgres"
  },
  {
    "file": "tests/controlplane/plan-artifact-product-authority.test.ts",
    "suite": "paired plan product dispatch authority [postgres; modeled current roles and hosted association]",
    "test": "associated product destroy keeps original revision and rechecks approver demotion after held roles",
    "backend": "postgres"
  },
  {
    "file": "tests/controlplane/plan-artifact-product-authority.test.ts",
    "suite": "paired plan product dispatch authority [postgres; modeled current roles and hosted association]",
    "test": "associated product destroy keeps original revision and rechecks retained historical recipe mutation after held roles",
    "backend": "postgres"
  },
  {
    "file": "tests/controlplane/plan-artifact-product-authority.test.ts",
    "suite": "paired plan product dispatch authority [postgres; modeled current roles and hosted association]",
    "test": "associated product destroy keeps original revision and rechecks retained historical deletion after held roles",
    "backend": "postgres"
  },
  {
    "file": "tests/controlplane/plan-artifact-product-authority.test.ts",
    "suite": "paired plan product dispatch authority [postgres; modeled current roles and hosted association]",
    "test": "associated product destroy keeps original revision and rechecks retained historical foreign scope after held roles",
    "backend": "postgres"
  },
  {
    "file": "tests/controlplane/plan-artifact-product-authority.test.ts",
    "suite": "paired plan product dispatch authority [postgres; modeled current roles and hosted association]",
    "test": "associated product destroy keeps original revision and rechecks changed deployed destroy pointer after held roles",
    "backend": "postgres"
  },
  {
    "file": "tests/controlplane/plan-artifact-product-authority.test.ts",
    "suite": "paired plan product dispatch authority [postgres; modeled current roles and hosted association]",
    "test": "associated product destroy keeps original revision and rechecks unchanged destination after held roles",
    "backend": "postgres"
  },
  {
    "file": "tests/controlplane/plan-artifact-product-authority.test.ts",
    "suite": "paired plan product dispatch authority [postgres; modeled current roles and hosted association]",
    "test": "lost native claimed commit response retains the attempt and a second claim cannot replay",
    "backend": "postgres"
  },
  {
    "file": "tests/controlplane/plan-artifact-product-authority.test.ts",
    "suite": "paired plan product dispatch authority [postgres; modeled current roles and hosted association]",
    "test": "lost native dispatched commit response and uncertain completion never admit a new original dispatch",
    "backend": "postgres"
  },
  {
    "file": "tests/platform/current-dispatch-requirement.test.ts",
    "suite": "current evaluated dispatch requirement [postgres; modeled policy and directory]",
    "test": "exact factory snapshot binds deeply immutable evaluated requirement and native approval records",
    "backend": "postgres"
  },
  {
    "file": "tests/platform/current-dispatch-requirement.test.ts",
    "suite": "current evaluated dispatch requirement [postgres; modeled policy and directory]",
    "test": "private requirement refuses copied snapshot",
    "backend": "postgres"
  },
  {
    "file": "tests/platform/current-dispatch-requirement.test.ts",
    "suite": "current evaluated dispatch requirement [postgres; modeled policy and directory]",
    "test": "private requirement refuses forged snapshot",
    "backend": "postgres"
  },
  {
    "file": "tests/platform/current-dispatch-requirement.test.ts",
    "suite": "current evaluated dispatch requirement [postgres; modeled policy and directory]",
    "test": "private requirement refuses foreign workspace",
    "backend": "postgres"
  },
  {
    "file": "tests/platform/current-dispatch-requirement.test.ts",
    "suite": "current evaluated dispatch requirement [postgres; modeled policy and directory]",
    "test": "private requirement refuses foreign operation",
    "backend": "postgres"
  },
  {
    "file": "tests/platform/current-dispatch-requirement.test.ts",
    "suite": "current evaluated dispatch requirement [postgres; modeled policy and directory]",
    "test": "private requirement refuses different owning pool",
    "backend": "postgres"
  },
  {
    "file": "tests/platform/current-dispatch-requirement.test.ts",
    "suite": "current evaluated dispatch requirement [postgres; modeled policy and directory]",
    "test": "changed current policy version refuses an earlier genuine same-attempt snapshot",
    "backend": "postgres"
  },
  {
    "file": "tests/platform/current-dispatch-requirement.test.ts",
    "suite": "current evaluated dispatch requirement [postgres; modeled policy and directory]",
    "test": "inconsistent evaluated input digest supplies no private dispatch authority",
    "backend": "postgres"
  },
  {
    "file": "tests/platform/current-dispatch-requirement.test.ts",
    "suite": "current evaluated dispatch requirement [postgres; modeled policy and directory]",
    "test": "default paired runtime refuses unproven native absence before callback or provider dispatch",
    "backend": "postgres"
  },
  {
    "file": "tests/capabilities/default-broker-origin.test.ts",
    "suite": "private default broker origin [postgres; factory provenance only]",
    "test": "actual default broker and genuine same-target owning pools retain private origin",
    "backend": "postgres"
  },
  {
    "file": "tests/capabilities/default-broker-origin.test.ts",
    "suite": "private default broker origin [postgres; factory provenance only]",
    "test": "private default origin refuses copied broker",
    "backend": "postgres"
  },
  {
    "file": "tests/capabilities/default-broker-origin.test.ts",
    "suite": "private default broker origin [postgres; factory provenance only]",
    "test": "private default origin refuses constructed broker",
    "backend": "postgres"
  },
  {
    "file": "tests/capabilities/default-broker-origin.test.ts",
    "suite": "private default broker origin [postgres; factory provenance only]",
    "test": "private default origin refuses override broker",
    "backend": "postgres"
  },
  {
    "file": "tests/capabilities/default-broker-origin.test.ts",
    "suite": "private default broker origin [postgres; factory provenance only]",
    "test": "private default origin refuses registered store",
    "backend": "postgres"
  },
  {
    "file": "tests/capabilities/default-broker-origin.test.ts",
    "suite": "private default broker origin [postgres; factory provenance only]",
    "test": "private default origin refuses registered roles",
    "backend": "postgres"
  },
  {
    "file": "tests/capabilities/default-broker-origin.test.ts",
    "suite": "private default broker origin [postgres; factory provenance only]",
    "test": "private default origin refuses registered scopes",
    "backend": "postgres"
  },
  {
    "file": "tests/capabilities/default-broker-origin.test.ts",
    "suite": "private default broker origin [postgres; factory provenance only]",
    "test": "method and descriptor provenance refuses store method without evaluating getters",
    "backend": "postgres"
  },
  {
    "file": "tests/capabilities/default-broker-origin.test.ts",
    "suite": "private default broker origin [postgres; factory provenance only]",
    "test": "method and descriptor provenance refuses broker method without evaluating getters",
    "backend": "postgres"
  },
  {
    "file": "tests/capabilities/default-broker-origin.test.ts",
    "suite": "private default broker origin [postgres; factory provenance only]",
    "test": "method and descriptor provenance refuses role method without evaluating getters",
    "backend": "postgres"
  },
  {
    "file": "tests/capabilities/default-broker-origin.test.ts",
    "suite": "private default broker origin [postgres; factory provenance only]",
    "test": "method and descriptor provenance refuses scope method without evaluating getters",
    "backend": "postgres"
  },
  {
    "file": "tests/capabilities/default-broker-origin.test.ts",
    "suite": "private default broker origin [postgres; factory provenance only]",
    "test": "method and descriptor provenance refuses dependency getter without evaluating getters",
    "backend": "postgres"
  },
  {
    "file": "tests/capabilities/default-broker-origin.test.ts",
    "suite": "private default broker origin [postgres; factory provenance only]",
    "test": "method and descriptor provenance refuses global getter without evaluating getters",
    "backend": "postgres"
  },
  {
    "file": "tests/capabilities/default-broker-origin.test.ts",
    "suite": "private default broker origin [postgres; factory provenance only]",
    "test": "current configuration startup override user refuses genuine cached broker origin",
    "backend": "postgres"
  },
  {
    "file": "tests/capabilities/default-broker-origin.test.ts",
    "suite": "private default broker origin [postgres; factory provenance only]",
    "test": "current configuration startup override database refuses genuine cached broker origin",
    "backend": "postgres"
  },
  {
    "file": "tests/capabilities/default-broker-origin.test.ts",
    "suite": "private default broker origin [postgres; factory provenance only]",
    "test": "current configuration startup override options refuses genuine cached broker origin",
    "backend": "postgres"
  },
  {
    "file": "tests/capabilities/default-broker-origin.test.ts",
    "suite": "private default broker origin [postgres; factory provenance only]",
    "test": "closed genuine owner and copied SQL handle cannot establish default mutation origin",
    "backend": "postgres"
  },
  {
    "file": "tests/capabilities/default-broker-origin.test.ts",
    "suite": "private default broker origin [postgres; factory provenance only]",
    "test": "public registered test broker remains usable while its mutation origin refuses",
    "backend": "postgres"
  },
  {
    "file": "tests/tofu/plan-artifact-handoff.test.ts",
    "suite": "authenticated original cross-worker handoff [postgres]",
    "test": "saved product original binary changed owning region during paired current-role wait fences actual apply effects",
    "backend": "postgres"
  },
  {
    "file": "tests/tofu/plan-artifact-handoff.test.ts",
    "suite": "authenticated original cross-worker handoff [postgres]",
    "test": "saved product original binary approver demotion during paired current-role wait fences actual apply effects",
    "backend": "postgres"
  },
  {
    "file": "tests/tofu/plan-artifact-handoff.test.ts",
    "suite": "authenticated original cross-worker handoff [postgres]",
    "test": "saved product original binary benign UI pointer advance during paired current-role wait fences actual apply effects",
    "backend": "postgres"
  },
  {
    "file": "tests/tofu/plan-artifact-handoff.test.ts",
    "suite": "authenticated original cross-worker handoff [postgres]",
    "test": "saved product original binary unchanged owning target during paired current-role wait fences actual apply effects",
    "backend": "postgres"
  },
  {
    "file": "tests/tofu/plan-artifact-handoff.test.ts",
    "suite": "authenticated original cross-worker handoff [postgres]",
    "test": "associated saved product destroy binary fences destination subject demotion during paired current-role wait",
    "backend": "postgres"
  },
  {
    "file": "tests/tofu/plan-artifact-handoff.test.ts",
    "suite": "authenticated original cross-worker handoff [postgres]",
    "test": "associated saved product destroy binary fences approver demotion during paired current-role wait",
    "backend": "postgres"
  },
  {
    "file": "tests/tofu/plan-artifact-handoff.test.ts",
    "suite": "authenticated original cross-worker handoff [postgres]",
    "test": "associated saved product destroy binary fences unchanged destination during paired current-role wait",
    "backend": "postgres"
  },
  {
    "file": "tests/controlplane/plan-artifact-integration-authority.test.ts",
    "suite": "native linked integration original-plan dispatch [postgres; modeled hosted REST and policy]",
    "test": "genuine default linked credential admits exactly the original sealed plan bytes once",
    "backend": "postgres"
  },
  {
    "file": "tests/controlplane/plan-artifact-integration-authority.test.ts",
    "suite": "native linked integration original-plan dispatch [postgres; modeled hosted REST and policy]",
    "test": "final linked credential dispatch fences revoked committed during held approving-human read",
    "backend": "postgres"
  },
  {
    "file": "tests/controlplane/plan-artifact-integration-authority.test.ts",
    "suite": "native linked integration original-plan dispatch [postgres; modeled hosted REST and policy]",
    "test": "final linked credential dispatch fences expired committed during held approving-human read",
    "backend": "postgres"
  },
  {
    "file": "tests/controlplane/plan-artifact-integration-authority.test.ts",
    "suite": "native linked integration original-plan dispatch [postgres; modeled hosted REST and policy]",
    "test": "final linked credential dispatch fences issued tuple replaced committed during held approving-human read",
    "backend": "postgres"
  },
  {
    "file": "tests/controlplane/plan-artifact-integration-authority.test.ts",
    "suite": "native linked integration original-plan dispatch [postgres; modeled hosted REST and policy]",
    "test": "final linked credential dispatch fences subject replaced committed during held approving-human read",
    "backend": "postgres"
  },
  {
    "file": "tests/controlplane/plan-artifact-integration-authority.test.ts",
    "suite": "native linked integration original-plan dispatch [postgres; modeled hosted REST and policy]",
    "test": "final linked credential dispatch fences workspace replaced committed during held approving-human read",
    "backend": "postgres"
  },
  {
    "file": "tests/controlplane/plan-artifact-integration-authority.test.ts",
    "suite": "native linked integration original-plan dispatch [postgres; modeled hosted REST and policy]",
    "test": "final linked credential dispatch fences project scope narrowed committed during held approving-human read",
    "backend": "postgres"
  },
  {
    "file": "tests/controlplane/plan-artifact-integration-authority.test.ts",
    "suite": "native linked integration original-plan dispatch [postgres; modeled hosted REST and policy]",
    "test": "final linked credential dispatch fences environment scope narrowed committed during held approving-human read",
    "backend": "postgres"
  },
  {
    "file": "tests/controlplane/plan-artifact-integration-authority.test.ts",
    "suite": "native linked integration original-plan dispatch [postgres; modeled hosted REST and policy]",
    "test": "final linked credential dispatch fences write scope removed committed during held approving-human read",
    "backend": "postgres"
  },
  {
    "file": "tests/controlplane/plan-artifact-integration-authority.test.ts",
    "suite": "native linked integration original-plan dispatch [postgres; modeled hosted REST and policy]",
    "test": "final linked credential dispatch fences credential removed committed during held approving-human read",
    "backend": "postgres"
  },
  {
    "file": "tests/controlplane/plan-artifact-integration-authority.test.ts",
    "suite": "native linked integration original-plan dispatch [postgres; modeled hosted REST and policy]",
    "test": "final linked credential dispatch fences requester demoted committed during held approving-human read",
    "backend": "postgres"
  },
  {
    "file": "tests/controlplane/plan-artifact-integration-authority.test.ts",
    "suite": "native linked integration original-plan dispatch [postgres; modeled hosted REST and policy]",
    "test": "final linked credential dispatch fences approver demoted committed during held approving-human read",
    "backend": "postgres"
  },
  {
    "file": "tests/controlplane/plan-artifact-integration-authority.test.ts",
    "suite": "native linked integration original-plan dispatch [postgres; modeled hosted REST and policy]",
    "test": "final linked credential dispatch fences provider revoked committed during held approving-human read",
    "backend": "postgres"
  },
  {
    "file": "tests/controlplane/plan-artifact-integration-authority.test.ts",
    "suite": "native linked integration original-plan dispatch [postgres; modeled hosted REST and policy]",
    "test": "final linked credential dispatch fences authority method replaced committed during held approving-human read",
    "backend": "postgres"
  },
  {
    "file": "tests/controlplane/plan-artifact-integration-authority.test.ts",
    "suite": "native linked integration original-plan dispatch [postgres; modeled hosted REST and policy]",
    "test": "final linked credential dispatch fences client method replaced committed during held approving-human read",
    "backend": "postgres"
  },
  {
    "file": "tests/controlplane/plan-artifact-integration-authority.test.ts",
    "suite": "native linked integration original-plan dispatch [postgres; modeled hosted REST and policy]",
    "test": "final linked credential dispatch fences cached authority target replaced committed during held approving-human read",
    "backend": "postgres"
  },
  {
    "file": "tests/controlplane/plan-artifact-integration-authority.test.ts",
    "suite": "native linked integration original-plan dispatch [postgres; modeled hosted REST and policy]",
    "test": "final linked credential dispatch fences default authority selector changed committed during held approving-human read",
    "backend": "postgres"
  },
  {
    "file": "tests/controlplane/plan-artifact-integration-authority.test.ts",
    "suite": "native linked integration original-plan dispatch [postgres; modeled hosted REST and policy]",
    "test": "final linked credential dispatch fences benign credential usage committed during held approving-human read",
    "backend": "postgres"
  },
  {
    "file": "tests/controlplane/plan-artifact-integration-authority.test.ts",
    "suite": "native linked integration original-plan dispatch [postgres; modeled hosted REST and policy]",
    "test": "final linked credential dispatch fences unchanged credential committed during held approving-human read",
    "backend": "postgres"
  },
  {
    "file": "tests/controlplane/plan-artifact-integration-authority.test.ts",
    "suite": "native linked integration original-plan dispatch [postgres; modeled hosted REST and policy]",
    "test": "observed three-connection original use-row wait fences linked credential revoked",
    "backend": "postgres"
  },
  {
    "file": "tests/controlplane/plan-artifact-integration-authority.test.ts",
    "suite": "native linked integration original-plan dispatch [postgres; modeled hosted REST and policy]",
    "test": "observed three-connection original use-row wait fences linked credential expired",
    "backend": "postgres"
  },
  {
    "file": "tests/controlplane/plan-artifact-integration-authority.test.ts",
    "suite": "native linked integration original-plan dispatch [postgres; modeled hosted REST and policy]",
    "test": "observed three-connection original use-row wait fences linked credential project scope narrowed",
    "backend": "postgres"
  },
  {
    "file": "tests/controlplane/plan-artifact-integration-authority.test.ts",
    "suite": "native linked integration original-plan dispatch [postgres; modeled hosted REST and policy]",
    "test": "observed three-connection original use-row wait fences linked credential write scope removed",
    "backend": "postgres"
  },
  {
    "file": "tests/controlplane/plan-artifact-integration-authority.test.ts",
    "suite": "native linked integration original-plan dispatch [postgres; modeled hosted REST and policy]",
    "test": "a plan-only viewer publishes source-free Git destroy custody with zero provider writes",
    "backend": "postgres"
  },
  {
    "file": "tests/controlplane/plan-artifact-integration-authority.test.ts",
    "suite": "native linked integration original-plan dispatch [postgres; modeled hosted REST and policy]",
    "test": "read-only viewer plan publication refuses removed current human before retaining original custody",
    "backend": "postgres"
  },
  {
    "file": "tests/controlplane/plan-artifact-integration-authority.test.ts",
    "suite": "native linked integration original-plan dispatch [postgres; modeled hosted REST and policy]",
    "test": "read-only viewer plan publication refuses foreign current human before retaining original custody",
    "backend": "postgres"
  },
  {
    "file": "tests/controlplane/plan-artifact-integration-authority.test.ts",
    "suite": "native linked integration original-plan dispatch [postgres; modeled hosted REST and policy]",
    "test": "viewer planning provenance cannot authorize ordinary apply or approve its own destroy review",
    "backend": "postgres"
  },
  {
    "file": "tests/controlplane/plan-artifact-integration-authority.test.ts",
    "suite": "native linked integration original-plan dispatch [postgres; modeled hosted REST and policy]",
    "test": "browser-approved exact delegated destroy fences unchanged planning credential after held current admin read",
    "backend": "postgres"
  },
  {
    "file": "tests/controlplane/plan-artifact-integration-authority.test.ts",
    "suite": "native linked integration original-plan dispatch [postgres; modeled hosted REST and policy]",
    "test": "browser-approved exact delegated destroy fences revoked planning credential after held current admin read",
    "backend": "postgres"
  },
  {
    "file": "tests/controlplane/plan-artifact-integration-authority.test.ts",
    "suite": "native linked integration original-plan dispatch [postgres; modeled hosted REST and policy]",
    "test": "browser-approved exact delegated destroy fences plan scope removed after held current admin read",
    "backend": "postgres"
  },
  {
    "file": "tests/controlplane/plan-artifact-integration-authority.test.ts",
    "suite": "native linked integration original-plan dispatch [postgres; modeled hosted REST and policy]",
    "test": "browser-approved exact delegated destroy fences foreign requester after held current admin read",
    "backend": "postgres"
  },
  {
    "file": "tests/controlplane/plan-artifact-integration-authority.test.ts",
    "suite": "native linked integration original-plan dispatch [postgres; modeled hosted REST and policy]",
    "test": "browser-approved exact delegated destroy fences admin demoted after held current admin read",
    "backend": "postgres"
  },
  {
    "file": "tests/controlplane/plan-artifact-integration-authority.test.ts",
    "suite": "native linked integration original-plan dispatch [postgres; modeled hosted REST and policy]",
    "test": "browser-approved exact delegated destroy fences admin removed after held current admin read",
    "backend": "postgres"
  },
  {
    "file": "tests/controlplane/plan-artifact-integration-authority.test.ts",
    "suite": "native linked integration original-plan dispatch [postgres; modeled hosted REST and policy]",
    "test": "browser-approved exact delegated destroy fences changed destroy pointer after held current admin read",
    "backend": "postgres"
  },
  {
    "file": "tests/controlplane/plan-artifact-integration-authority.test.ts",
    "suite": "native linked integration original-plan dispatch [postgres; modeled hosted REST and policy]",
    "test": "uncertain linked credential dispatch retains its original attempt and never admits a fresh replay",
    "backend": "postgres"
  },
  {
    "file": "tests/agent-access/credential-authority-origin.test.ts",
    "suite": "native linked credential factory origin [postgres]",
    "test": "actual cached native client and linked authority prove the same owning opening target",
    "backend": "postgres"
  },
  {
    "file": "tests/agent-access/credential-authority-origin.test.ts",
    "suite": "native linked credential factory origin [postgres]",
    "test": "native factory origin refuses copied authority",
    "backend": "postgres"
  },
  {
    "file": "tests/agent-access/credential-authority-origin.test.ts",
    "suite": "native linked credential factory origin [postgres]",
    "test": "native factory origin refuses constructed authority",
    "backend": "postgres"
  },
  {
    "file": "tests/agent-access/credential-authority-origin.test.ts",
    "suite": "native linked credential factory origin [postgres]",
    "test": "native factory origin refuses copied client",
    "backend": "postgres"
  },
  {
    "file": "tests/agent-access/credential-authority-origin.test.ts",
    "suite": "native linked credential factory origin [postgres]",
    "test": "native factory origin refuses tooling client",
    "backend": "postgres"
  },
  {
    "file": "tests/agent-access/credential-authority-origin.test.ts",
    "suite": "native linked credential factory origin [postgres]",
    "test": "native provenance refuses authority method without evaluating hostile getters",
    "backend": "postgres"
  },
  {
    "file": "tests/agent-access/credential-authority-origin.test.ts",
    "suite": "native linked credential factory origin [postgres]",
    "test": "native provenance refuses authority accessor without evaluating hostile getters",
    "backend": "postgres"
  },
  {
    "file": "tests/agent-access/credential-authority-origin.test.ts",
    "suite": "native linked credential factory origin [postgres]",
    "test": "native provenance refuses authority selector accessor without evaluating hostile getters",
    "backend": "postgres"
  },
  {
    "file": "tests/agent-access/credential-authority-origin.test.ts",
    "suite": "native linked credential factory origin [postgres]",
    "test": "native provenance refuses client method without evaluating hostile getters",
    "backend": "postgres"
  },
  {
    "file": "tests/agent-access/credential-authority-origin.test.ts",
    "suite": "native linked credential factory origin [postgres]",
    "test": "native provenance refuses client selector accessor without evaluating hostile getters",
    "backend": "postgres"
  },
  {
    "file": "tests/agent-access/credential-authority-origin.test.ts",
    "suite": "native linked credential factory origin [postgres]",
    "test": "native provenance refuses client startup without evaluating hostile getters",
    "backend": "postgres"
  },
  {
    "file": "tests/agent-access/credential-authority-origin.test.ts",
    "suite": "native linked credential factory origin [postgres]",
    "test": "native provenance refuses text parser without evaluating hostile getters",
    "backend": "postgres"
  },
  {
    "file": "tests/agent-access/credential-authority-origin.test.ts",
    "suite": "native linked credential factory origin [postgres]",
    "test": "native provenance refuses text serializer without evaluating hostile getters",
    "backend": "postgres"
  },
  {
    "file": "tests/agent-access/credential-authority-origin.test.ts",
    "suite": "native linked credential factory origin [postgres]",
    "test": "current authority target refuses cached config replacement",
    "backend": "postgres"
  },
  {
    "file": "tests/agent-access/credential-authority-origin.test.ts",
    "suite": "native linked credential factory origin [postgres]",
    "test": "current authority target refuses shared pooler username",
    "backend": "postgres"
  },
  {
    "file": "tests/agent-access/credential-authority-origin.test.ts",
    "suite": "native linked credential factory origin [postgres]",
    "test": "current authority target refuses database replacement",
    "backend": "postgres"
  },
  {
    "file": "tests/agent-access/credential-authority-origin.test.ts",
    "suite": "native linked credential factory origin [postgres]",
    "test": "current authority target refuses missing explicit port",
    "backend": "postgres"
  },
  {
    "file": "tests/agent-access/credential-authority-origin.test.ts",
    "suite": "native linked credential factory origin [postgres]",
    "test": "current authority target refuses startup user",
    "backend": "postgres"
  },
  {
    "file": "tests/agent-access/credential-authority-origin.test.ts",
    "suite": "native linked credential factory origin [postgres]",
    "test": "current authority target refuses startup database",
    "backend": "postgres"
  },
  {
    "file": "tests/agent-access/credential-authority-origin.test.ts",
    "suite": "native linked credential factory origin [postgres]",
    "test": "current authority target refuses unknown startup option",
    "backend": "postgres"
  },
  {
    "file": "tests/agent-access/credential-authority-origin.test.ts",
    "suite": "native linked credential factory origin [postgres]",
    "test": "separate genuine owning database target and closed genuine native client refuse",
    "backend": "postgres"
  },
  {
    "file": "tests/agent-access/credential-authority-origin.test.ts",
    "suite": "native linked credential factory origin [postgres]",
    "test": "current native linked directory refuses revoked without alternate authority fallback",
    "backend": "postgres"
  },
  {
    "file": "tests/agent-access/credential-authority-origin.test.ts",
    "suite": "native linked credential factory origin [postgres]",
    "test": "current native linked directory refuses expired without alternate authority fallback",
    "backend": "postgres"
  },
  {
    "file": "tests/agent-access/credential-authority-origin.test.ts",
    "suite": "native linked credential factory origin [postgres]",
    "test": "current native linked directory refuses future issued without alternate authority fallback",
    "backend": "postgres"
  },
  {
    "file": "tests/agent-access/credential-authority-origin.test.ts",
    "suite": "native linked credential factory origin [postgres]",
    "test": "current native linked directory refuses foreign subject without alternate authority fallback",
    "backend": "postgres"
  },
  {
    "file": "tests/agent-access/credential-authority-origin.test.ts",
    "suite": "native linked credential factory origin [postgres]",
    "test": "current native linked directory refuses foreign workspace without alternate authority fallback",
    "backend": "postgres"
  },
  {
    "file": "tests/agent-access/credential-authority-origin.test.ts",
    "suite": "native linked credential factory origin [postgres]",
    "test": "current native linked directory refuses missing identity without alternate authority fallback",
    "backend": "postgres"
  },
  {
    "file": "tests/agent-access/credential-authority-origin.test.ts",
    "suite": "native linked credential factory origin [postgres]",
    "test": "current native linked directory refuses duplicate scope without alternate authority fallback",
    "backend": "postgres"
  },
  {
    "file": "tests/agent-access/credential-authority-origin.test.ts",
    "suite": "native linked credential factory origin [postgres]",
    "test": "current native linked directory refuses malformed scope without alternate authority fallback",
    "backend": "postgres"
  },
  {
    "file": "tests/agent-access/credential-authority-origin.test.ts",
    "suite": "native linked credential factory origin [postgres]",
    "test": "missing native linked schema version fails closed with sanitized diagnostics",
    "backend": "postgres"
  },
  {
    "file": "tests/agent-access/credential-authority-origin.test.ts",
    "suite": "native linked credential factory origin [postgres]",
    "test": "current file selector cannot revive a previously captured native grant",
    "backend": "postgres"
  },
  {
    "file": "tests/agent-access/credential-authority-origin.test.ts",
    "suite": "native linked credential factory origin [postgres]",
    "test": "genuine owning handle accessor replacement refuses native credential provenance without getter effects",
    "backend": "postgres"
  },
  {
    "file": "tests/agent-access/credential-authority-origin.test.ts",
    "suite": "native linked credential factory origin [postgres]",
    "test": "private opener refuses branded handle kind accessor with zero getter calls",
    "backend": "postgres"
  },
  {
    "file": "tests/agent-access/credential-authority-origin.test.ts",
    "suite": "native linked credential factory origin [postgres]",
    "test": "private opener refuses branded handle identity accessor with zero getter calls",
    "backend": "postgres"
  },
  {
    "file": "tests/agent-access/credential-authority-origin.test.ts",
    "suite": "native linked credential factory origin [postgres]",
    "test": "private opener refuses branded handle query accessor with zero getter calls",
    "backend": "postgres"
  },
  {
    "file": "tests/agent-access/credential-authority-origin.test.ts",
    "suite": "native linked credential factory origin [postgres]",
    "test": "private opener refuses branded handle tx accessor with zero getter calls",
    "backend": "postgres"
  },
  {
    "file": "tests/agent-access/credential-authority-origin.test.ts",
    "suite": "native linked credential factory origin [postgres]",
    "test": "private opener refuses branded handle exec accessor with zero getter calls",
    "backend": "postgres"
  },
  {
    "file": "tests/agent-access/credential-authority-origin.test.ts",
    "suite": "native linked credential factory origin [postgres]",
    "test": "private opener refuses branded handle close accessor with zero getter calls",
    "backend": "postgres"
  },
  {
    "file": "tests/agent-access/credential-authority-origin.test.ts",
    "suite": "native linked credential factory origin [postgres]",
    "test": "boolean parser replacement cannot hide a foreign native OAuth identity or reach journal fallback",
    "backend": "postgres"
  },
  {
    "file": "tests/agent-access/credential-authority-origin.test.ts",
    "suite": "native linked credential factory origin [postgres]",
    "test": "boolean serializer replacement refuses genuine native client provenance and restores exactly",
    "backend": "postgres"
  },
  {
    "file": "tests/agent-access/credential-authority-origin.test.ts",
    "suite": "native linked credential factory origin [postgres]",
    "test": "native opening host array slot accessor refuses without invoking its getter",
    "backend": "postgres"
  },
  {
    "file": "tests/agent-access/credential-authority-origin.test.ts",
    "suite": "native linked credential factory origin [postgres]",
    "test": "native opening port array slot accessor refuses without invoking its getter",
    "backend": "postgres"
  },
  {
    "file": "tests/agent-access/credential-authority-origin.test.ts",
    "suite": "native linked credential factory origin [postgres]",
    "test": "native opening host array changed target refuses and original target restores",
    "backend": "postgres"
  },
  {
    "file": "tests/agent-access/credential-authority-origin.test.ts",
    "suite": "native linked credential factory origin [postgres]",
    "test": "native opening port array changed target refuses and original target restores",
    "backend": "postgres"
  },
  {
    "file": "tests/agent-access/credential-authority-origin.test.ts",
    "suite": "native linked credential factory origin [postgres]",
    "test": "native opening host array replaced prototype refuses without inherited getter effects",
    "backend": "postgres"
  },
  {
    "file": "tests/agent-access/credential-authority-origin.test.ts",
    "suite": "native linked credential factory origin [postgres]",
    "test": "native opening port array replaced prototype refuses without inherited getter effects",
    "backend": "postgres"
  },
  {
    "file": "tests/agent-access/credential-authority-origin.test.ts",
    "suite": "native linked credential factory origin [postgres]",
    "test": "native opening host array copied equal target refuses private identity",
    "backend": "postgres"
  },
  {
    "file": "tests/agent-access/credential-authority-origin.test.ts",
    "suite": "native linked credential factory origin [postgres]",
    "test": "native opening port array copied equal target refuses private identity",
    "backend": "postgres"
  },
  {
    "file": "tests/agent-access/credential-authority-origin.test.ts",
    "suite": "native linked credential factory origin [postgres]",
    "test": "native opening host array appended target refuses exact descriptor inventory",
    "backend": "postgres"
  },
  {
    "file": "tests/agent-access/credential-authority-origin.test.ts",
    "suite": "native linked credential factory origin [postgres]",
    "test": "native opening port array appended target refuses exact descriptor inventory",
    "backend": "postgres"
  }
];

export const EXECUTION_LEASE_TENANT_POSTGRES_REQUIREMENTS = [
  {
    "file": "tests/controlplane/first-source-lease-binding.test.ts",
    "suite": "first source worker lease binding [postgres]",
    "test": "refuses a missing execution lease workspace before native acquisition and retains the current binding",
    "postgres": true
  },
  {
    "file": "tests/controlplane/first-source-lease-binding.test.ts",
    "suite": "first source worker lease binding [postgres]",
    "test": "refuses live foreign scope collisions before acquisition without changing any retained lease or binding",
    "postgres": true
  },
  {
    "file": "tests/controlplane/first-source-lease-binding.test.ts",
    "suite": "first source worker lease binding [postgres]",
    "test": "refuses expired foreign scope collisions before acquisition without changing any retained lease or binding",
    "postgres": true
  },
  {
    "file": "tests/controlplane/first-source-lease-binding.test.ts",
    "suite": "first source worker lease binding [postgres]",
    "test": "refuses released foreign scope collisions before acquisition without changing any retained lease or binding",
    "postgres": true
  },
  {
    "file": "tests/controlplane/first-source-lease-binding.test.ts",
    "suite": "first source worker lease binding [postgres]",
    "test": "refuses expired NULL scope collisions before acquisition without changing any retained lease or binding",
    "postgres": true
  },
  {
    "file": "tests/controlplane/first-source-lease-binding.test.ts",
    "suite": "first source worker lease binding [postgres]",
    "test": "refuses a foreign scope inserted after the owning lock found no row without adopting or renewing it",
    "postgres": true
  },
  {
    "file": "tests/controlplane/first-source-lease-binding.test.ts",
    "suite": "first source worker lease binding [postgres]",
    "test": "two genuine owning acquisitions crossing an absent-row collision retain one same-holder fence and one consumed approval",
    "postgres": true
  }
];

export const FIRST_SOURCE_LEASE_POSTGRES_REQUIREMENTS = [
  "binds the first real worker lease before default source capture and native retain after a claim without a lease",
  "reuses the same live native fence after an acquisition acknowledgement is lost without consuming approval twice",
  "keeps plain and reconcile lease reacquisition incrementing fences",
  "binds a new fence only after genuine plan review approval and a separate claim resets the recorded pair",
  "refuses a changed proposal digest and rolls back the newly acquired lease",
  "refuses a foreign workspace at native binding and rolls back the newly acquired lease",
  "refuses a foreign environment scope at native binding and rolls back the newly acquired lease",
  "refuses a live MCP execution holder at native binding and rolls back the newly acquired lease",
  "refuses a replaced workflow execution holder at native binding and rolls back the newly acquired lease",
  "refuses uncertain operations without creating a lease",
  "refuses cancelled operations without creating a lease",
  "refuses an expired operation without creating a lease",
  "refuses an expired execution claim without creating a lease",
  "refuses a partially recorded fence pair with scope only and leaves both columns unchanged",
  "refuses a partially recorded fence pair with token only and leaves both columns unchanged",
  "refuses a NULL lease workspace before binding",
  "refuses a foreign lease workspace before binding",
  "refuses a mismatched recorded fence without replacing it",
  "refuses a released recorded fence after reacquisition without replacing it",
  "refuses a taken-over recorded fence after expiry without replacing it",
  "refuses a stale native binding after the acquired lease is released",
  "refuses a worker holder naming another operation even when the environment lease is live",
  "refuses cancellation committed during an observed native operation lock wait",
  "refuses execution expiry committed during an observed native operation lock wait"
].map(test => ({
  file: "tests/controlplane/first-source-lease-binding.test.ts", suite: "first source worker lease binding [postgres]", test, postgres: true,
}));

// Native final raw-plan source admission remains mandatory when either trusted source file disappears.
export const PLAN_SOURCE_AUTHORITY_POSTGRES_REQUIREMENTS = [
  {
    "file": "tests/controlplane/plan-artifact-source-authority.test.ts",
    "suite": "original plan source dispatch authority [postgres]",
    "test": "final original-plan source admission fences unchanged private binding during delayed current human role lookup",
    "postgres": true
  },
  {
    "file": "tests/controlplane/plan-artifact-source-authority.test.ts",
    "suite": "original plan source dispatch authority [postgres]",
    "test": "final original-plan source admission fences revoked private binding during delayed current human role lookup",
    "postgres": true
  },
  {
    "file": "tests/controlplane/plan-artifact-source-authority.test.ts",
    "suite": "original plan source dispatch authority [postgres]",
    "test": "final original-plan source admission fences removed private binding during delayed current human role lookup",
    "postgres": true
  },
  {
    "file": "tests/controlplane/plan-artifact-source-authority.test.ts",
    "suite": "original plan source dispatch authority [postgres]",
    "test": "final original-plan source admission fences replaced private binding during delayed current human role lookup",
    "postgres": true
  },
  {
    "file": "tests/controlplane/plan-artifact-source-authority.test.ts",
    "suite": "original plan source dispatch authority [postgres]",
    "test": "final original-plan source admission fences introduced public binding during delayed current human role lookup",
    "postgres": true
  },
  {
    "file": "tests/controlplane/plan-artifact-source-authority.test.ts",
    "suite": "original plan source dispatch authority [postgres]",
    "test": "full service recipe JSON mutation with unchanged stored digest refuses original dispatch",
    "postgres": true
  },
  {
    "file": "tests/controlplane/plan-artifact-source-authority.test.ts",
    "suite": "original plan source dispatch authority [postgres]",
    "test": "full pipeline recipe JSON mutation with unchanged stored digest refuses original dispatch",
    "postgres": true
  },
  {
    "file": "tests/controlplane/plan-artifact-source-authority.test.ts",
    "suite": "original plan source dispatch authority [postgres]",
    "test": "native original-plan custody refuses missing source without entering dispatch",
    "postgres": true
  },
  {
    "file": "tests/controlplane/plan-artifact-source-authority.test.ts",
    "suite": "original plan source dispatch authority [postgres]",
    "test": "native original-plan custody refuses foreign source without entering dispatch",
    "postgres": true
  },
  {
    "file": "tests/controlplane/plan-artifact-source-authority.test.ts",
    "suite": "original plan source dispatch authority [postgres]",
    "test": "native original-plan custody refuses stripped source without entering dispatch",
    "postgres": true
  },
  {
    "file": "tests/controlplane/plan-artifact-source-authority.test.ts",
    "suite": "original plan source dispatch authority [postgres]",
    "test": "genuine native source-free absence retains historical original dispatch compatibility",
    "postgres": true
  },
  {
    "file": "tests/controlplane/plan-artifact-source-authority.test.ts",
    "suite": "original plan source dispatch authority [postgres]",
    "test": "mixed-case multi-source review and final native aggregate share exact ASCII lexical service ordering",
    "postgres": true
  },
  {
    "file": "tests/controlplane/plan-artifact-source-authority.test.ts",
    "suite": "original plan source dispatch authority [postgres]",
    "test": "committed private revocation during an observed three-connection use-row waiter refuses the final original dispatch CAS",
    "postgres": true
  },
  {
    "file": "tests/tofu/plan-artifact-handoff.test.ts",
    "suite": "authenticated original cross-worker handoff [postgres]",
    "test": "independent saved binary with matching native private source binding applies the exact original once",
    "postgres": true
  },
  {
    "file": "tests/tofu/plan-artifact-handoff.test.ts",
    "suite": "authenticated original cross-worker handoff [postgres]",
    "test": "independent saved binary refuses committed private source revocation before original apply without a fresh fallback",
    "postgres": true
  }
];

export const APPROVED_SOURCE_POSTGRES_REQUIREMENTS = [
  ...[
    "persists one immutable row across two actual independent handles and reuses it after producer loss",
    "rollback before commit retains no partial source row and allows a subsequent capture",
    "a lost acknowledgement leaves the same permanent row for an independent retry",
    "retained main bytes remain pinned after branch/tag movement across source-bound plan recording",
    "retained v1.0.0 bytes remain pinned after branch/tag movement across source-bound plan recording",
    "a different canonical archive for the same commit refuses while preserving the original row",
    "same spec_digest with changed service JSON cannot establish native recipe authority",
    "same spec_digest with changed pipeline JSON cannot establish native recipe authority",
    "retained service JSON mutation with unchanged digest refuses current authority",
    "retained pipeline JSON mutation with unchanged digest refuses current authority",
    "authentic capture at a different requested ref cannot borrow the owning recipe digest",
    "foreign workspaceId cannot read or retain another scope",
    "foreign operationId cannot read or retain another scope",
    "foreign projectId cannot read or retain another scope",
    "foreign environmentId cannot read or retain another scope",
    "raw/as-cast metadata cannot forge actual archive capture provenance",
    "expired operation authority refuses both first capture and current retained row",
    "expired execution authority refuses both first capture and current retained row",
    "expired fence authority refuses both first capture and current retained row",
    "remembered private binding revoked never becomes anonymous even when repository is public",
    "remembered private binding removed never becomes anonymous even when repository is public",
    "remembered private binding replaced never becomes anonymous even when repository is public",
    "retains a matching bound identity and refuses missing App configuration after capture",
    "repository reuse/replacement at the same canonical slug refuses immutable numeric identity",
    "owning PostgreSQL withPlanReview returns the source-bound normalized plan and safe metadata",
    "owning PostgreSQL legacy source-free view remains byte-compatible when no native snapshots exist",
    "owning PostgreSQL browser projection refuses foreign source set and display without returning a source-less approval",
    "owning PostgreSQL browser projection refuses changed display without returning a source-less approval",
    "owning PostgreSQL browser projection refuses absent native row without returning a source-less approval",
    "owning PostgreSQL browser projection refuses foreign project row without returning a source-less approval",
    "owning PostgreSQL browser projection refuses wrong native hash without returning a source-less approval",
    "owning PostgreSQL browser projection refuses all source fields stripped without returning a source-less approval",
    "only exact source-bound nonsimulated plan evidence enables native upload readiness",
    "rejects new source attachment once an old plan digest is recorded",
    "revocation during a delayed archive read refuses capture before native persistence",
    "a proved resource waiter rechecks current operation clock after release, without capturing a stale source row",
    "permanent rows refuse UPDATE, DELETE and TRUNCATE while no-op UPDATE preserves identity",
    "schema rejects missing/nonnumeric/foreign provider-format metadata independently of TypeScript"
  ].map(test => ({file:"tests/controlplane/approved-source-snapshots.test.ts",suite:"permanent approved source snapshots [postgres]",test,postgres:true})),
  ...[
    "final native source CAS fences unchanged binding during delayed current approver lookup",
    "final native source CAS fences binding revoked during delayed current approver lookup",
    "final native source CAS fences binding removed during delayed current approver lookup",
    "final native source CAS fences binding replaced during delayed current approver lookup",
    "final native source CAS fences public absence replaced during delayed current approver lookup",
    "retained-launch recovery fences unchanged binding during delayed approver lookup without another SDK attempt",
    "retained-launch recovery fences binding revoked during delayed approver lookup without another SDK attempt",
    "retained-launch recovery fences binding removed during delayed approver lookup without another SDK attempt",
    "retained-launch recovery fences public absence replaced during delayed approver lookup without another SDK attempt",
    "rechecks unchanged binding after an exact three-connection retained launch lock wait",
    "rechecks binding revoked after an exact three-connection retained launch lock wait",
    "same stored digest with changed service recipe JSON refuses before native launch and SDK mutation",
    "same stored digest with changed pipeline recipe JSON refuses before native launch and SDK mutation",
    "native source CAS refuses missing row without a new launch",
    "native source CAS refuses foreign project row without a new launch",
    "native source CAS refuses wrong approved set without a new launch",
    "native source CAS refuses simulated approval evidence without a new launch"
  ].map(test => ({file:"tests/controlplane/build-launch-broker-binding.test.ts",suite:"CodeBuild transaction-bound broker [postgres]",test,postgres:true})),
  ...[
    "fresh canonical migrations keep permanent approved source snapshots select/insert-only",
    "same-owner schema6 canonical migrations keep permanent approved source snapshots select/insert-only",
    "schema12 refuses startup and even source-free plan review until the canonical source migration is applied"
  ].map(test => ({file:"tests/controlplane/migrations.test.ts",suite:"migrator [postgres] concurrency and fail-closed open",test,postgres:true})),
  ...[
    "matching immutable source identity consumes original bytes and a different source digest refuses before dispatch"
  ].map(test => ({file:"tests/tofu/plan-artifact-handoff.test.ts",suite:"authenticated original cross-worker handoff [postgres]",test,postgres:true})),
  ...[
    "sweeps claim/get/acknowledge/observeTerminal with current owning authority and preserves A exactly"
  ].map(test => ({file:"tests/controlplane/tenancy.test.ts",suite:"build launch tenant isolation sweep [postgres]",test,postgres:true})),
  {
    file: "tests/platform/approved-source-runtime.test.ts",
    suite: "default approved source runtime owning persistence [postgres]",
    test: "default single-pool owning runtime captures, retains and verifies the same immutable row across an independent pool",
    postgres: true,
  },
];

const BOUND_BUILD_POSTGRES_CASES = [
  ...["production", "isolated"].map(mode => `launches with valid owning approvals on a single-connection pool through ${mode} composition`),
  "ignores a permissive global memory policy and authentic approval IDs when owning PostgreSQL policy denies",
  "rebinds the captured isolated broker store instead of admitting its memory policy",
  ...["unchanged authority", "current approver demotion", "current requester removal", "raised policy count", "current policy deny"].map(change => `uses ${change} after an observed PostgreSQL resource lock wait`),
  ...["unchanged settings", "two-person policy", "denying policy", "lower autonomy", "same-value policy version", "same-value environment version", "same-version policy params", "same-version autonomy", "same-version environment params", "deleted policy row", "deleted environment row"].map(change => `fences insertion when ${change} is observed during a delayed approver read`),
  ...["unchanged defaults", "new default policy row", "new default environment row", "new foreign environment row"].map(change => `fences explicit absent settings when ${change} occurs during approver lookup`),
  ...["unchanged recovery", "two-person policy", "denying policy", "lower autonomy", "same-value policy version", "same-value environment version", "same-version policy params", "same-version autonomy", "same-version environment params", "deleted policy row", "deleted environment row", "new default policy row", "new default environment row", "new foreign environment row"].map(change => `fences retained-launch recovery under ${change} without a second SDK attempt`),
  "cannot continue a claim from a late membership success after the bounded read is aborted",
  "captures isolated evaluator ports once while always rebinding its store",
  ...["foreign membership", "malformed membership", "inaccessible membership"].map(change => `refuses ${change} with live owning approval before any launch`),
  "refuses expired consumed approval even with current product admin and live operation/fence",
].map(test => ({ file: "tests/controlplane/build-launch-broker-binding.test.ts", suite: "CodeBuild transaction-bound broker [postgres]", test, postgres: true }));

// Permanent signed outcome evidence must execute every owning/refusal case on real PostgreSQL.
const AGENT_EFFECT_POSTGRES_CASES = [
  "settles active work atomically and accepts an identical signed retry without replacing the first evidence",
  "retains a cancelled-after-claimed outcome without reopening the job or clearing operation uncertainty",
  "retains a cancelled-after-running outcome without reopening the job or clearing operation uncertainty",
  "retains an authenticated result after reaper timeout independently of its terminal projection",
  "refuses queued work with no original claim and retains no synthetic receipt",
  "refuses cancelled-unclaimed work with no original claim and retains no synthetic receipt",
  "refuses expired work with no original claim and retains no synthetic receipt",
  "refuses foreign workspace, agent, job and invalid signature without recording evidence",
  "refuses valid encrypted outcomes under foreign SQL scope while retaining owning evidence",
  "rechecks revocation after request authentication and refuses the previously valid identity",
  "refuses unknown fields and non-JSON/deep result values with fixed-safe errors",
  "serializes independent matching deliveries and retains exactly the first immutable receipt",
  "serializes divergent deliveries across independent workers and refuses the losing logical outcome",
  "retains committed evidence when the caller loses the acknowledgement and refuses any replay of work",
  "commits active settlement and receipt before advisory audit delivery, retaining evidence when delivery fails",
  "binds sealed evidence to workspace, agent kind, job, agent key and original envelope without an old-key fallback",
  "copies returned evidence and validates ciphertext rather than accepting raw proof-shaped results",
  "rolls back the receipt and active projection together, then accepts a fresh delivery",
  "makes receipt update/delete and original assignment substitution fail at the database boundary",
  "observes a blocked PostgreSQL result writer and retains late evidence when cancellation wins the job lock",
];
const AGENT_EFFECT_POSTGRES_REQUIREMENTS = ["runner", "machine"].flatMap(kind => AGENT_EFFECT_POSTGRES_CASES.map(test => ({
  file: "tests/runners/late-effect-receipts.test.ts", suite: `${kind} authenticated outcomes`,
  ancestorSuite: "agent effect receipts [postgres]", test, postgres: true,
})));

// Fixed operation contracts survive missing source files and reports. Backend
// metadata describes actual SQL; product-port and wire models remain labelled.
const WORKFLOW_INTENT_SQL_FILE = "tests/controlplane/workflow-start-intents.test.ts";
const WORKFLOW_INTENT_AUTHORITY_FILE = "tests/controlplane/workflow-start-authority.test.ts";
const WORKFLOW_INTENT_TEMPORAL_FILE = "tests/workflows/start-intent.test.ts";
const CURRENT_MEMBERSHIP_FILE = "tests/capabilities/default-current-membership.test.ts";
const RECONCILE_SCHEDULE_CASES = [
  "creates one compatible schedule, provisions concurrently and preserves an operator pause",
  "refuses changed configuration and foreign ownership without updating the existing action",
  "a real concurrent operator pause invalidates activation CAS and is preserved",
  "refuses absent prerequisites and a production PGlite store before schedule creation",
  "proves SKIP overlap while the first scheduled activity is actually held",
  "the global database lease refuses a direct concurrent sweep despite distinct workflow IDs",
  "the valid sweep-v1 environment retains its distinct lease while the global sweep runs",
  "keeps durable minute scheduling active after an actual database statement failure and recovers",
  "preserves the schedule and queued execution through an actual server process restart",
  "a completed pass replays after a worker restart without rerunning its SQL activity",
  "cancellation reaches a held controller read, releases the global lease and runs no compensation",
  "claims a bounded fair SQL batch and leaves unvisited environments due for the next pass",
  "checks every authority-bearing schedule field on a genuine describe result",
  "refuses persisted raw versioning and workflow-ID policies that SDK decoding omits"
];
const RECONCILE_COMPOSITION_CASES = [
  "refuses actual PGlite, closes a refused handle, and does not inherit a global broker ready flag",
  "confirms its real configured namespace, closes its client, and refuses an unavailable namespace",
  "owning PostgreSQL canonical broker with modeled current product membership: unchanged",
  "owning PostgreSQL canonical broker with modeled current product membership: demoted",
  "owning PostgreSQL canonical broker with modeled current product membership: cancelled",
  "polls the full default activity set before provisioning and observes encrypted real SQL results",
  "preserves operator pause and refuses incompatible ownership/routing in both permission modes",
  "a held actual fleet lease reports busy and cannot advertise successful observation",
  "bounded real PostgreSQL lock outage defers a pass and the unpaused schedule recovers",
  "pre-acquisition cancellation during an observed schema prerequisite waiter starts no compensation",
  "default controller cancellation after an observed post-acquisition SQL waiter releases its exact live fleet lease",
  "a canonical eligible empty graph completes in SQL, then owned worker restart services the same schedule"
];
const WORKFLOW_INTENT_SQL_CASES = [
  "commits typed immutable intent before a sole claim; competing workers retain one permanent attempt",
  "rebinds an alternative broker store to the actual locked SQL authority rather than trusting another approval ledger",
  "rollback leaves no prepared intent or attempt; commit acknowledgement loss preserves the attempted tombstone",
  "different arguments, kind, destination, queue and foreign tenant cannot replace the first binding",
  "refuses new dispatch under expired approval",
  "refuses new dispatch under revoked role",
  "refuses new dispatch under raised count",
  "refuses new dispatch under policy deny",
  "refuses new dispatch under expired operation",
  "refuses new dispatch under cancelled",
  "refuses new dispatch under lost fence",
  "late matching acknowledgement survives cancellation and reaper; first receipt wins and queue never reopens",
  "proposal-approved deploy starts before executable plan approval; preApproved cannot supply missing authority",
  "approved read-only teardown review may be admitted before its worker claims the operation",
  "an approved but unclaimed mutation operation cannot use workflow admission to consume or bypass its execution claim",
  "after an observed final intent-row lock wait, unchanged is evaluated freshly",
  "after an observed final intent-row lock wait, demoted approver is evaluated freshly",
  "after an observed final intent-row lock wait, raised count is evaluated freshly",
  "after an observed final intent-row lock wait, current deny is evaluated freshly",
  "after an observed final intent-row lock wait, approval expiry is evaluated freshly"
];
const WORKFLOW_INTENT_PRIVILEGE_CASES = [
  "fresh migration12 refuses inherited TRUNCATE and retains the attempted tombstone",
  "same-owner schema6 migration12 refuses inherited TRUNCATE and retains the attempted tombstone"
];
const WORKFLOW_INTENT_AUTHORITY_CASES = [
  "uses the owning single-connection transaction through production composition",
  "uses the owning single-connection transaction through isolated composition",
  "ignores a permissive global memory broker at prepare with authentic owning consumed approvals",
  "ignores a permissive global memory broker at claim with authentic owning consumed approvals",
  "refuses explicit process memory mode before prepare reads the durable store",
  "refuses explicit process memory mode before claim reads the durable store",
  "captures isolated ports once and discards the broker's mutable/alternative store",
  "refuses freshly removed requester at prepare despite the old bulk snapshot",
  "refuses freshly removed approver at prepare despite the old bulk snapshot",
  "refuses freshly removed requester at claim despite the old bulk snapshot",
  "refuses freshly removed approver at claim despite the old bulk snapshot",
  "prepare fences unchanged settings committed during a delayed consumed-approver read",
  "prepare fences two-person policy committed during a delayed consumed-approver read",
  "prepare fences denying policy committed during a delayed consumed-approver read",
  "prepare fences policy version committed during a delayed consumed-approver read",
  "prepare fences policy JSON same version committed during a delayed consumed-approver read",
  "prepare fences deleted policy committed during a delayed consumed-approver read",
  "prepare fences replaced policy same version committed during a delayed consumed-approver read",
  "prepare fences autonomy committed during a delayed consumed-approver read",
  "prepare fences environment version committed during a delayed consumed-approver read",
  "prepare fences autonomy same version committed during a delayed consumed-approver read",
  "prepare fences environment JSON same version committed during a delayed consumed-approver read",
  "prepare fences deleted environment committed during a delayed consumed-approver read",
  "prepare fences unchanged defaults committed during a delayed consumed-approver read",
  "prepare fences insert default policy committed during a delayed consumed-approver read",
  "prepare fences insert default environment committed during a delayed consumed-approver read",
  "prepare fences insert foreign environment committed during a delayed consumed-approver read",
  "claim fences unchanged settings committed during a delayed consumed-approver read",
  "claim fences two-person policy committed during a delayed consumed-approver read",
  "claim fences denying policy committed during a delayed consumed-approver read",
  "claim fences policy version committed during a delayed consumed-approver read",
  "claim fences policy JSON same version committed during a delayed consumed-approver read",
  "claim fences deleted policy committed during a delayed consumed-approver read",
  "claim fences replaced policy same version committed during a delayed consumed-approver read",
  "claim fences autonomy committed during a delayed consumed-approver read",
  "claim fences environment version committed during a delayed consumed-approver read",
  "claim fences autonomy same version committed during a delayed consumed-approver read",
  "claim fences environment JSON same version committed during a delayed consumed-approver read",
  "claim fences deleted environment committed during a delayed consumed-approver read",
  "claim fences unchanged defaults committed during a delayed consumed-approver read",
  "claim fences insert default policy committed during a delayed consumed-approver read",
  "claim fences insert default environment committed during a delayed consumed-approver read",
  "claim fences insert foreign environment committed during a delayed consumed-approver read",
  "refuses an already foreign globally keyed environment before prepare",
  "refuses an already foreign globally keyed environment before claim",
  "prepare resolves unchanged after an exact observed operation-row lock waiter",
  "prepare resolves removed requester after an exact observed operation-row lock waiter",
  "prepare resolves demoted approver after an exact observed operation-row lock waiter",
  "claim resolves unchanged after an exact observed operation-row lock waiter",
  "claim resolves removed requester after an exact observed operation-row lock waiter",
  "claim resolves demoted approver after an exact observed operation-row lock waiter",
  "prepare authority abort rolls back and a late member answer cannot commit",
  "claim authority abort rolls back and a late member answer cannot commit"
];
const WORKFLOW_INTENT_TEMPORAL_CASES = [
  "independent SQL workers and SDK connections commit one exact accepted start and retain the same completed execution",
  "accepted start followed by connection loss is recovered by an independent reader without another Start RPC",
  "SQL claim commit acknowledgement loss prevents transport and remains unconfirmed when Temporal has no execution",
  "a prepared-intent commit acknowledgement loss recovers that same row and permits only its first authorized transport",
  "an accepted start whose readback cannot be committed recovers the retained original, never a new execution",
  "foreign legacy execution with the same workflow ID is refused rather than adopted or restarted",
  "mutated argument, type, namespace or queue requests cannot replace the retained writer",
  "actual Temporal original with wrong type cannot acknowledge a retained attempt",
  "actual Temporal original with wrong arguments cannot acknowledge a retained attempt",
  "actual Temporal original with wrong memo cannot acknowledge a retained attempt",
  "actual Temporal raw Start with priority key is not the retained canonical configuration",
  "actual Temporal raw Start with fairness key is not the retained canonical configuration",
  "actual Temporal raw Start with fairness weight is not the retained canonical configuration",
  "actual Temporal raw Start with enabled time skipping is not the retained canonical configuration",
  "actual Temporal raw Start with disabled propagation is not the retained canonical configuration",
  "actual Temporal raw Start with skip-count override is not the retained canonical configuration",
  "actual Temporal raw Start with continued failure is not the retained canonical configuration",
  "actual Temporal raw Start with last completion result is not the retained canonical configuration",
  "actual Temporal raw Start with explicit parentless priority and disabled time-skipping defaults confirms the same original",
  "real PostgreSQL final lock waiter unchanged permits only a fresh canonical Temporal dispatch",
  "real PostgreSQL final lock waiter demoted approver permits only a fresh canonical Temporal dispatch",
  "real PostgreSQL final lock waiter raised approval count permits only a fresh canonical Temporal dispatch",
  "real PostgreSQL final lock waiter current policy deny permits only a fresh canonical Temporal dispatch",
  "retention-equivalent deletion of this owned closed Temporal history preserves the SQL tombstone and never authorizes replay",
  "encrypted original input and memo round-trip through the configured codecs on independent readers",
  "cancelled operation keeps an exact late accepted-start receipt and denies a new attempted writer",
  "current role or policy revocation refuses a prepared intent before any Temporal Start call"
];
const WORKFLOW_INTENT_WIRE_MODELS = [
  "pinned raw response model omitted accepts defaults without another Start",
  "pinned raw response model null accepts defaults without another Start",
  "pinned raw response model empty nested messages accepts defaults without another Start",
  "pinned raw response model explicit zero knobs accepts defaults without another Start",
  "pinned raw response model documented unit fairness weight accepts defaults without another Start",
  "pinned raw response model eager acceptance refuses confirmation without another Start",
  "pinned raw response model priority key refuses confirmation without another Start",
  "pinned raw response model fairness key refuses confirmation without another Start",
  "pinned raw response model fairness weight refuses confirmation without another Start",
  "pinned raw response model time skipping enabled refuses confirmation without another Start",
  "pinned raw response model empty fast-forward wrapper refuses confirmation without another Start",
  "pinned raw response model propagation disabled refuses confirmation without another Start",
  "pinned raw response model skip-count override refuses confirmation without another Start",
  "pinned raw response model propagated skipped seconds refuses confirmation without another Start",
  "pinned raw response model propagated skipped nanos refuses confirmation without another Start",
  "pinned raw response model invalid duration cancelling to zero refuses confirmation without another Start",
  "pinned raw response model propagated skip count refuses confirmation without another Start",
  "pinned raw response model empty fast-forward target wrapper refuses confirmation without another Start",
  "pinned raw response model declined unversioned target wrapper refuses confirmation without another Start",
  "pinned raw response model empty continued-failure wrapper refuses confirmation without another Start",
  "pinned raw response model empty last-completion-result wrapper refuses confirmation without another Start"
];
const DEFAULT_CURRENT_MEMBERSHIP_CASES = [
  "same owning current requester and approver permit one canonical signed claim",
  "the same cached broker refuses a demoted requester without a snapshot fallback",
  "the same cached broker refuses a deleted requester without a snapshot fallback",
  "missing hosted member bob receives no empty-workspace or local authority",
  "missing hosted member local receives no empty-workspace or local authority",
  "a cached requester approval cannot survive a demoted consumed human approver",
  "a cached requester approval cannot survive a deleted consumed human approver",
  "a demoted requester cannot claim an already approved operation",
  "a deleted requester cannot claim an already approved operation",
  "current membership response error refuses before proposal authority or privileged fallback",
  "current membership thrown error refuses before proposal authority or privileged fallback",
  "current membership foreign workspace refuses before proposal authority or privileged fallback",
  "current membership foreign human refuses before proposal authority or privileged fallback",
  "current membership unsupported role refuses before proposal authority or privileged fallback",
  "a real eight-second role deadline refuses late successful modeled PostgREST completion on the cached broker",
  "integration authority retains credential scope and target attenuation while rereading its human",
  "a revoked integration credential cannot be restored by current admin membership",
  "a expired integration credential cannot be restored by current admin membership",
  "a foreign workspace integration credential cannot be restored by current admin membership",
  "a missing integration credential cannot be restored by current admin membership",
  "system principals remain nonmembers governed by canonical policy, never human approvers"
];
const RECONCILIATION_REQUIREMENTS = [
  ...RECONCILE_SCHEDULE_CASES.map(test => ({file:"tests/workflows/reconcile-schedule.test.ts",suite:"durable schedule on an actual isolated Temporal service",test,backend:"postgres"})),
  ...RECONCILE_COMPOSITION_CASES.map(test => ({file:"tests/workers/reconcile-composition.test.ts",suite:"actual default activity composition: PostgreSQL and owned durable Temporal",test,backend:"postgres"})),
];
const WORKFLOW_INTENT_POSTGRES_REQUIREMENTS = [
  ...WORKFLOW_INTENT_SQL_CASES.map(test=>({file:WORKFLOW_INTENT_SQL_FILE,suite:"workflow start intents [postgres]",test,postgres:true})),
  ...WORKFLOW_INTENT_PRIVILEGE_CASES.map(test=>({file:WORKFLOW_INTENT_SQL_FILE,suite:"workflow start tombstone privileges [postgres]",test,postgres:true})),
  ...WORKFLOW_INTENT_AUTHORITY_CASES.map(test=>({file:WORKFLOW_INTENT_AUTHORITY_FILE,suite:"workflow start final authority [postgres]",test,postgres:true})),
];
const DEFAULT_CURRENT_MEMBERSHIP_REQUIREMENTS = DEFAULT_CURRENT_MEMBERSHIP_CASES.map(test=>({
  file:CURRENT_MEMBERSHIP_FILE,suite:"cached default broker current membership [postgres; modeled product reads]",test,backend:"postgres",
}));
// Real Temporal replay with scripted activities; these do not claim provider effects.
const WORKFLOW_INTENT_REPLAY_REQUIREMENTS = [
  {
    "file": "tests/workflows/replay.test.ts",
    "suite": "replaying histories recorded by the current workflows",
    "test": "deploy: happy path"
  },
  {
    "file": "tests/workflows/replay.test.ts",
    "suite": "replaying histories recorded by the current workflows",
    "test": "deploy: approval wait, signal, and a second lease"
  },
  {
    "file": "tests/workflows/replay.test.ts",
    "suite": "replaying histories recorded by the current workflows",
    "test": "deploy: a failure path (lease lost during apply)"
  },
  {
    "file": "tests/workflows/replay.test.ts",
    "suite": "replaying histories recorded by the current workflows",
    "test": "deploy: cancellation mid-flight"
  },
  {
    "file": "tests/workflows/replay.test.ts",
    "suite": "replaying histories recorded by the current workflows",
    "test": "deploy: retried reads (activity attempts do not disturb replay)"
  },
  {
    "file": "tests/workflows/replay.test.ts",
    "suite": "replaying histories recorded by the current workflows",
    "test": "day-two, remediation and reconcile"
  },
  {
    "file": "tests/workflows/replay.test.ts",
    "suite": "the replay check has teeth",
    "test": "the same history is rejected by a workflow that schedules its activities in a different order"
  },
  {
    "file": "tests/workflows/codec-replay.test.ts",
    "suite": "codec histories on local Temporal (ZENITH_TEST_TEMPORAL=1)",
    "test": "encrypts workflow/activity payloads, supports queries/signals and replays with retained keys"
  },
  {
    "file": "tests/workflows/codec-replay.test.ts",
    "suite": "codec histories on local Temporal (ZENITH_TEST_TEMPORAL=1)",
    "test": "replays a legacy plaintext history with an encrypted converter"
  },
  {
    "file": "tests/workflows/destroy-replay.test.ts",
    "suite": "real destroy workflow histories (ZENITH_TEST_TEMPORAL=1)",
    "test": "happy runs and replays against the current definitions"
  },
  {
    "file": "tests/workflows/destroy-replay.test.ts",
    "suite": "real destroy workflow histories (ZENITH_TEST_TEMPORAL=1)",
    "test": "plan_changed runs and replays against the current definitions"
  },
  {
    "file": "tests/workflows/destroy-replay.test.ts",
    "suite": "real destroy workflow histories (ZENITH_TEST_TEMPORAL=1)",
    "test": "lease_lost runs and replays against the current definitions"
  },
  {
    "file": "tests/workflows/destroy-replay.test.ts",
    "suite": "real destroy workflow histories (ZENITH_TEST_TEMPORAL=1)",
    "test": "approval_reject runs and replays against the current definitions"
  },
  {
    "file": "tests/workflows/destroy-replay.test.ts",
    "suite": "real destroy workflow histories (ZENITH_TEST_TEMPORAL=1)",
    "test": "unknown_absence runs and replays against the current definitions"
  },
  {
    "file": "tests/workflows/destroy-replay.test.ts",
    "suite": "real destroy workflow histories (ZENITH_TEST_TEMPORAL=1)",
    "test": "preserves and replays the deploy command sequence"
  }
];
const WORKFLOW_INTENT_REQUIREMENTS = [
  ...WORKFLOW_INTENT_POSTGRES_REQUIREMENTS,
  ...WORKFLOW_INTENT_TEMPORAL_CASES.map(test=>({file:WORKFLOW_INTENT_TEMPORAL_FILE,test,backend:"postgres"})),
  // Supplemental wire models cannot match any actual scenario's exact title.
  ...WORKFLOW_INTENT_WIRE_MODELS.map(test=>({file:WORKFLOW_INTENT_TEMPORAL_FILE,test})),
  {file:WORKFLOW_INTENT_SQL_FILE,test:"test-only captured broker authority is unavailable in production at creation and invocation"},
  ...["own scalar snapshot rejects accessors before store or SDK and strips extra serialization hooks","production start refuses missing durable store and test seam is unavailable in production"]
    .map(test=>({file:WORKFLOW_INTENT_TEMPORAL_FILE,test})),
  ...WORKFLOW_INTENT_REPLAY_REQUIREMENTS,
];

// Native OAuth persistence cases remain mandatory if their source file disappears.
export const OAUTH_GRANT_POSTGRES_REQUIREMENTS = [
  {
    "file": "tests/agent-control/pg-oauth-grants.test.ts",
    "suite": "OAuth resource grant journal [postgres]",
    "test": "verifies the canonical agent migration registry and native OAuth table boundary",
    "postgres": true
  },
  {
    "file": "tests/agent-control/pg-oauth-grants.test.ts",
    "suite": "OAuth resource grant journal [postgres]",
    "test": "persists only the owning non-secret Grant tuple across independent clients",
    "postgres": true
  },
  {
    "file": "tests/agent-control/pg-oauth-grants.test.ts",
    "suite": "OAuth resource grant journal [postgres]",
    "test": "the default PostgreSQL journal reads the same retained native grant",
    "postgres": true
  },
  {
    "file": "tests/agent-control/pg-oauth-grants.test.ts",
    "suite": "OAuth resource grant journal [postgres]",
    "test": "subject client and workspace lookups never cross their exact stored tuple",
    "postgres": true
  },
  {
    "file": "tests/agent-control/pg-oauth-grants.test.ts",
    "suite": "OAuth resource grant journal [postgres]",
    "test": "the same human and client can retain distinct grants in two workspaces",
    "postgres": true
  },
  {
    "file": "tests/agent-control/pg-oauth-grants.test.ts",
    "suite": "OAuth resource grant journal [postgres]",
    "test": "the same client can retain distinct grants for two humans in one workspace",
    "postgres": true
  },
  {
    "file": "tests/agent-control/pg-oauth-grants.test.ts",
    "suite": "OAuth resource grant journal [postgres]",
    "test": "retains revoked and expired records for browser withdrawal and renewal",
    "postgres": true
  },
  {
    "file": "tests/agent-control/pg-oauth-grants.test.ts",
    "suite": "OAuth resource grant journal [postgres]",
    "test": "fresh persisted scope attenuates the already-verified OAuth identity",
    "postgres": true
  },
  {
    "file": "tests/agent-control/pg-oauth-grants.test.ts",
    "suite": "OAuth resource grant journal [postgres]",
    "test": "persisted grant cannot authorize a mismatched OAuth issuer",
    "postgres": true
  },
  {
    "file": "tests/agent-control/pg-oauth-grants.test.ts",
    "suite": "OAuth resource grant journal [postgres]",
    "test": "persisted grant cannot authorize a mismatched OAuth subject",
    "postgres": true
  },
  {
    "file": "tests/agent-control/pg-oauth-grants.test.ts",
    "suite": "OAuth resource grant journal [postgres]",
    "test": "persisted grant cannot authorize a mismatched OAuth client",
    "postgres": true
  },
  {
    "file": "tests/agent-control/pg-oauth-grants.test.ts",
    "suite": "OAuth resource grant journal [postgres]",
    "test": "persisted grant cannot authorize a mismatched OAuth expiry",
    "postgres": true
  },
  {
    "file": "tests/agent-control/pg-oauth-grants.test.ts",
    "suite": "OAuth resource grant journal [postgres]",
    "test": "revocation committed by another client refuses the next OAuth binding",
    "postgres": true
  },
  {
    "file": "tests/agent-control/pg-oauth-grants.test.ts",
    "suite": "OAuth resource grant journal [postgres]",
    "test": "renewal and scope replacement preserve the original integration identity",
    "postgres": true
  },
  {
    "file": "tests/agent-control/pg-oauth-grants.test.ts",
    "suite": "OAuth resource grant journal [postgres]",
    "test": "a competing integration identity cannot replace the retained scoped binding",
    "postgres": true
  },
  {
    "file": "tests/agent-control/pg-oauth-grants.test.ts",
    "suite": "OAuth resource grant journal [postgres]",
    "test": "an integration identity cannot move to a foreign native tuple",
    "postgres": true
  },
  {
    "file": "tests/agent-control/pg-oauth-grants.test.ts",
    "suite": "OAuth resource grant journal [postgres]",
    "test": "racing first consent retains exactly one immutable native binding",
    "postgres": true
  },
  {
    "file": "tests/agent-control/pg-oauth-grants.test.ts",
    "suite": "OAuth resource grant journal [postgres]",
    "test": "racing same-identity replacements commit complete scopes without mixing fields",
    "postgres": true
  },
  {
    "file": "tests/agent-control/pg-oauth-grants.test.ts",
    "suite": "OAuth resource grant journal [postgres]",
    "test": "native SQL cannot replace immutable integration_id",
    "postgres": true
  },
  {
    "file": "tests/agent-control/pg-oauth-grants.test.ts",
    "suite": "OAuth resource grant journal [postgres]",
    "test": "native SQL cannot replace immutable subject",
    "postgres": true
  },
  {
    "file": "tests/agent-control/pg-oauth-grants.test.ts",
    "suite": "OAuth resource grant journal [postgres]",
    "test": "native SQL cannot replace immutable client_id",
    "postgres": true
  },
  {
    "file": "tests/agent-control/pg-oauth-grants.test.ts",
    "suite": "OAuth resource grant journal [postgres]",
    "test": "native SQL cannot replace immutable workspace_id",
    "postgres": true
  },
  {
    "file": "tests/agent-control/pg-oauth-grants.test.ts",
    "suite": "OAuth resource grant journal [postgres]",
    "test": "service role can insert read and replace a grant without DELETE or TRUNCATE",
    "postgres": true
  },
  {
    "file": "tests/agent-control/pg-oauth-grants.test.ts",
    "suite": "OAuth resource grant journal [postgres]",
    "test": "anon cannot read or mutate OAuth grants",
    "postgres": true
  },
  {
    "file": "tests/agent-control/pg-oauth-grants.test.ts",
    "suite": "OAuth resource grant journal [postgres]",
    "test": "authenticated cannot read or mutate OAuth grants",
    "postgres": true
  },
  {
    "file": "tests/agent-control/pg-oauth-grants.test.ts",
    "suite": "OAuth resource grant journal [postgres]",
    "test": "RLS still hides grant rows if clients receive accidental SELECT in a disposable transaction",
    "postgres": true
  },
  {
    "file": "tests/agent-control/pg-oauth-grants.test.ts",
    "suite": "OAuth resource grant journal [postgres]",
    "test": "missing OAuth migration refuses grants while prior non-OAuth journal work remains valid",
    "postgres": true
  },
  {
    "file": "tests/agent-control/pg-oauth-grants.test.ts",
    "suite": "OAuth resource grant journal [postgres]",
    "test": "wrong migration name refuses grant reads and emits only fixed verifier diagnostics",
    "postgres": true
  },
  {
    "file": "tests/agent-control/pg-oauth-grants.test.ts",
    "suite": "OAuth resource grant journal [postgres]",
    "test": "safe migration reapplication retains grant identity scope and ledger timestamp",
    "postgres": true
  },
  {
    "file": "tests/agent-control/pg-oauth-grants.test.ts",
    "suite": "OAuth resource grant journal [postgres]",
    "test": "migration refuses an incompatible partial grant table without recording success",
    "postgres": true
  },
  {
    "file": "tests/agent-control/pg-oauth-grants.test.ts",
    "suite": "OAuth resource grant journal [postgres]",
    "test": "same-named weakened check constraint cannot certify canonical grant schema",
    "postgres": true
  },
  {
    "file": "tests/agent-control/pg-oauth-grants.test.ts",
    "suite": "OAuth resource grant journal [postgres]",
    "test": "same-named weakened binding constraint cannot certify canonical grant schema",
    "postgres": true
  },
  {
    "file": "tests/agent-control/pg-oauth-grants.test.ts",
    "suite": "OAuth resource grant journal [postgres]",
    "test": "native schema verifier refuses restored DELETE privilege",
    "postgres": true
  },
  {
    "file": "tests/agent-control/pg-oauth-grants.test.ts",
    "suite": "OAuth resource grant journal [postgres]",
    "test": "rejects unknown accessToken data before grant persistence",
    "postgres": true
  },
  {
    "file": "tests/agent-control/pg-oauth-grants.test.ts",
    "suite": "OAuth resource grant journal [postgres]",
    "test": "rejects unknown refreshToken data before grant persistence",
    "postgres": true
  },
  {
    "file": "tests/agent-control/pg-oauth-grants.test.ts",
    "suite": "OAuth resource grant journal [postgres]",
    "test": "rejects unknown secret data before grant persistence",
    "postgres": true
  },
  {
    "file": "tests/agent-control/pg-oauth-grants.test.ts",
    "suite": "OAuth resource grant journal [postgres]",
    "test": "rejects malformed grant projects without storing a row",
    "postgres": true
  },
  {
    "file": "tests/agent-control/pg-oauth-grants.test.ts",
    "suite": "OAuth resource grant journal [postgres]",
    "test": "rejects malformed grant duplicate without storing a row",
    "postgres": true
  },
  {
    "file": "tests/agent-control/pg-oauth-grants.test.ts",
    "suite": "OAuth resource grant journal [postgres]",
    "test": "rejects malformed grant scope without storing a row",
    "postgres": true
  },
  {
    "file": "tests/agent-control/pg-oauth-grants.test.ts",
    "suite": "OAuth resource grant journal [postgres]",
    "test": "rejects malformed grant issuer without storing a row",
    "postgres": true
  },
  {
    "file": "tests/agent-control/pg-oauth-grants.test.ts",
    "suite": "OAuth resource grant journal [postgres]",
    "test": "rejects malformed grant expiry without storing a row",
    "postgres": true
  },
  {
    "file": "tests/agent-control/pg-oauth-grants.test.ts",
    "suite": "OAuth resource grant journal [postgres]",
    "test": "concurrent new client grants cannot exceed the existing browser owner quota",
    "postgres": true
  },
  {
    "file": "tests/agent-control/pg-oauth-grants.test.ts",
    "suite": "OAuth resource grant journal [postgres]",
    "test": "full retained quota permits same-identity renewal and revocation without pruning",
    "postgres": true
  },
  {
    "file": "tests/agent-control/pg-oauth-grants.test.ts",
    "suite": "OAuth resource grant journal [postgres]",
    "test": "owner quota does not consume a different workspace or subject allowance",
    "postgres": true
  },
  {
    "file": "tests/agent-control/pg-oauth-grants.test.ts",
    "suite": "OAuth resource grant journal [postgres]",
    "test": "scoped listing refuses overflow rather than hiding another current grant",
    "postgres": true
  },
  {
    "file": "tests/agent-control/pg-oauth-grants.test.ts",
    "suite": "OAuth resource grant journal [postgres]",
    "test": "a closed native client yields a fixed grant refusal without database details",
    "postgres": true
  },
  {
    "file": "tests/agent-control/pg-oauth-grants.test.ts",
    "suite": "OAuth resource grant journal [postgres]",
    "test": "browser duration and derived digest metadata never become stored grant authority",
    "postgres": true
  },
  {
    "file": "tests/agent-control/pg-oauth-grants.test.ts",
    "suite": "OAuth resource grant journal [postgres]",
    "test": "canonical verifier refuses identity trigger delete-only even with the original function",
    "postgres": true
  },
  {
    "file": "tests/agent-control/pg-oauth-grants.test.ts",
    "suite": "OAuth resource grant journal [postgres]",
    "test": "canonical verifier refuses identity trigger after-update even with the original function",
    "postgres": true
  },
  {
    "file": "tests/agent-control/pg-oauth-grants.test.ts",
    "suite": "OAuth resource grant journal [postgres]",
    "test": "canonical verifier refuses identity trigger statement even with the original function",
    "postgres": true
  },
  {
    "file": "tests/agent-control/pg-oauth-grants.test.ts",
    "suite": "OAuth resource grant journal [postgres]",
    "test": "canonical verifier refuses identity trigger column-restricted even with the original function",
    "postgres": true
  },
  {
    "file": "tests/agent-control/pg-oauth-grants.test.ts",
    "suite": "OAuth resource grant journal [postgres]",
    "test": "canonical verifier refuses identity trigger conditional even with the original function",
    "postgres": true
  },
  {
    "file": "tests/agent-control/pg-oauth-grants.test.ts",
    "suite": "OAuth resource grant journal [postgres]",
    "test": "canonical verifier refuses identity trigger arguments even with the original function",
    "postgres": true
  },
  {
    "file": "tests/agent-control/pg-oauth-grants.test.ts",
    "suite": "OAuth resource grant journal [postgres]",
    "test": "canonical verifier refuses identity trigger disabled even with the original function",
    "postgres": true
  },
  {
    "file": "tests/agent-control/pg-oauth-grants.test.ts",
    "suite": "OAuth resource grant journal [postgres]",
    "test": "canonical verifier refuses identity trigger additional even with the original function",
    "postgres": true
  },
  {
    "file": "tests/agent-control/pg-oauth-grants.test.ts",
    "suite": "OAuth resource grant journal [postgres]",
    "test": "canonical verifier refuses changed identity function body",
    "postgres": true
  },
  {
    "file": "tests/agent-control/pg-oauth-grants.test.ts",
    "suite": "OAuth resource grant journal [postgres]",
    "test": "canonical verifier refuses changed ids function body",
    "postgres": true
  },
  {
    "file": "tests/agent-control/pg-oauth-grants.test.ts",
    "suite": "OAuth resource grant journal [postgres]",
    "test": "canonical verifier refuses identity function security definer",
    "postgres": true
  },
  {
    "file": "tests/agent-control/pg-oauth-grants.test.ts",
    "suite": "OAuth resource grant journal [postgres]",
    "test": "canonical verifier refuses ids function security definer",
    "postgres": true
  },
  {
    "file": "tests/agent-control/pg-oauth-grants.test.ts",
    "suite": "OAuth resource grant journal [postgres]",
    "test": "canonical verifier refuses changed identity function search path",
    "postgres": true
  },
  {
    "file": "tests/agent-control/pg-oauth-grants.test.ts",
    "suite": "OAuth resource grant journal [postgres]",
    "test": "canonical verifier refuses changed ids function search path",
    "postgres": true
  },
  {
    "file": "tests/agent-control/pg-oauth-grants.test.ts",
    "suite": "OAuth resource grant journal [postgres]",
    "test": "canonical verifier refuses changed identity function volatility",
    "postgres": true
  },
  {
    "file": "tests/agent-control/pg-oauth-grants.test.ts",
    "suite": "OAuth resource grant journal [postgres]",
    "test": "canonical verifier refuses changed ids function volatility",
    "postgres": true
  },
  {
    "file": "tests/agent-control/pg-oauth-grants.test.ts",
    "suite": "OAuth resource grant journal [postgres]",
    "test": "canonical verifier refuses changed identity function strictness",
    "postgres": true
  },
  {
    "file": "tests/agent-control/pg-oauth-grants.test.ts",
    "suite": "OAuth resource grant journal [postgres]",
    "test": "canonical verifier refuses changed ids function strictness",
    "postgres": true
  },
  {
    "file": "tests/agent-control/pg-oauth-grants.test.ts",
    "suite": "OAuth resource grant journal [postgres]",
    "test": "canonical verifier refuses changed identity function parallel contract",
    "postgres": true
  },
  {
    "file": "tests/agent-control/pg-oauth-grants.test.ts",
    "suite": "OAuth resource grant journal [postgres]",
    "test": "canonical verifier refuses changed ids function parallel contract",
    "postgres": true
  },
  {
    "file": "tests/agent-control/pg-oauth-grants.test.ts",
    "suite": "OAuth resource grant journal [postgres]",
    "test": "canonical verifier refuses identity function client execution privilege",
    "postgres": true
  },
  {
    "file": "tests/agent-control/pg-oauth-grants.test.ts",
    "suite": "OAuth resource grant journal [postgres]",
    "test": "canonical verifier refuses ids function client execution privilege",
    "postgres": true
  },
  {
    "file": "tests/agent-control/pg-oauth-grants.test.ts",
    "suite": "OAuth resource grant journal [postgres]",
    "test": "cold native catalog preserves canonical CHECK and primary unique inheritance flags",
    "postgres": true
  },
  {
    "file": "tests/agent-control/pg-oauth-grants.test.ts",
    "suite": "OAuth resource grant journal [postgres]",
    "test": "canonical verifier and migration refuse a same-named NO INHERIT CHECK constraint",
    "postgres": true
  }
];

// Additive post-use-row-wait identity; the historical 171-case table remains exact.
export const PLAN_PRODUCT_RETAINED_WAIT_POSTGRES_REQUIREMENTS = [
  {
    "file": "tests/controlplane/plan-artifact-integration-authority.test.ts",
    "suite": "native linked integration original-plan dispatch [postgres; modeled hosted REST and policy]",
    "test": "observed three-connection delegated destroy use-row wait refuses newly retained historical resource before original dispatch",
    "backend": "postgres"
  }
];

// Exact reviewed OAuth dispatch and first-selection factory cases survive source deletion.
export const NATIVE_OAUTH_DISPATCH_POSTGRES_REQUIREMENTS = [
  {
    "file": "tests/agent-access/native-oauth-origin.test.ts",
    "suite": "native OAuth journal current origin [postgres]",
    "test": "genuine default journal and selector capture the exact nonsecret owning OAuth tuple",
    "backend": "postgres"
  },
  {
    "file": "tests/agent-access/native-oauth-origin.test.ts",
    "suite": "native OAuth journal current origin [postgres]",
    "test": "native OAuth origin refuses copied journal",
    "backend": "postgres"
  },
  {
    "file": "tests/agent-access/native-oauth-origin.test.ts",
    "suite": "native OAuth journal current origin [postgres]",
    "test": "native OAuth origin refuses constructed journal",
    "backend": "postgres"
  },
  {
    "file": "tests/agent-access/native-oauth-origin.test.ts",
    "suite": "native OAuth journal current origin [postgres]",
    "test": "native OAuth origin refuses foreign owning handle",
    "backend": "postgres"
  },
  {
    "file": "tests/agent-access/native-oauth-origin.test.ts",
    "suite": "native OAuth journal current origin [postgres]",
    "test": "native OAuth provenance refuses journal method with zero hostile getter effects",
    "backend": "postgres"
  },
  {
    "file": "tests/agent-access/native-oauth-origin.test.ts",
    "suite": "native OAuth journal current origin [postgres]",
    "test": "native OAuth provenance refuses journal accessor with zero hostile getter effects",
    "backend": "postgres"
  },
  {
    "file": "tests/agent-access/native-oauth-origin.test.ts",
    "suite": "native OAuth journal current origin [postgres]",
    "test": "native OAuth provenance refuses journal client getter with zero hostile getter effects",
    "backend": "postgres"
  },
  {
    "file": "tests/agent-access/native-oauth-origin.test.ts",
    "suite": "native OAuth journal current origin [postgres]",
    "test": "native OAuth provenance refuses journal checked getter with zero hostile getter effects",
    "backend": "postgres"
  },
  {
    "file": "tests/agent-access/native-oauth-origin.test.ts",
    "suite": "native OAuth journal current origin [postgres]",
    "test": "native OAuth provenance refuses journal cache replaced with zero hostile getter effects",
    "backend": "postgres"
  },
  {
    "file": "tests/agent-access/native-oauth-origin.test.ts",
    "suite": "native OAuth journal current origin [postgres]",
    "test": "native OAuth provenance refuses journal prototype with zero hostile getter effects",
    "backend": "postgres"
  },
  {
    "file": "tests/agent-access/native-oauth-origin.test.ts",
    "suite": "native OAuth journal current origin [postgres]",
    "test": "native OAuth provenance refuses native selector getter with zero hostile getter effects",
    "backend": "postgres"
  },
  {
    "file": "tests/agent-access/native-oauth-origin.test.ts",
    "suite": "native OAuth journal current origin [postgres]",
    "test": "native OAuth provenance refuses runtime selector getter with zero hostile getter effects",
    "backend": "postgres"
  },
  {
    "file": "tests/agent-access/native-oauth-origin.test.ts",
    "suite": "native OAuth journal current origin [postgres]",
    "test": "native OAuth provenance refuses runtime selector setter with zero hostile getter effects",
    "backend": "postgres"
  },
  {
    "file": "tests/agent-access/native-oauth-origin.test.ts",
    "suite": "native OAuth journal current origin [postgres]",
    "test": "native OAuth provenance refuses client method with zero hostile getter effects",
    "backend": "postgres"
  },
  {
    "file": "tests/agent-access/native-oauth-origin.test.ts",
    "suite": "native OAuth journal current origin [postgres]",
    "test": "native OAuth provenance refuses boolean parser with zero hostile getter effects",
    "backend": "postgres"
  },
  {
    "file": "tests/agent-access/native-oauth-origin.test.ts",
    "suite": "native OAuth journal current origin [postgres]",
    "test": "runtime lazy journal selection refuses an awaited getter replacement",
    "backend": "postgres"
  },
  {
    "file": "tests/agent-access/native-oauth-origin.test.ts",
    "suite": "native OAuth journal current origin [postgres]",
    "test": "runtime lazy journal selection refuses an awaited setter replacement",
    "backend": "postgres"
  },
  {
    "file": "tests/agent-access/native-oauth-origin.test.ts",
    "suite": "native OAuth journal current origin [postgres]",
    "test": "runtime lazy journal selection refuses an awaited foreign value replacement",
    "backend": "postgres"
  },
  {
    "file": "tests/agent-access/native-oauth-origin.test.ts",
    "suite": "native OAuth journal current origin [postgres]",
    "test": "a known linked OAuth-shaped revoked identity never falls back to its live OAuth row",
    "backend": "postgres"
  },
  {
    "file": "tests/agent-access/native-oauth-origin.test.ts",
    "suite": "native OAuth journal current origin [postgres]",
    "test": "a known linked OAuth-shaped expired identity never falls back to its live OAuth row",
    "backend": "postgres"
  },
  {
    "file": "tests/agent-access/native-oauth-origin.test.ts",
    "suite": "native OAuth journal current origin [postgres]",
    "test": "a known linked OAuth-shaped foreign workspace identity never falls back to its live OAuth row",
    "backend": "postgres"
  },
  {
    "file": "tests/agent-access/native-oauth-origin.test.ts",
    "suite": "native OAuth journal current origin [postgres]",
    "test": "a known linked OAuth-shaped foreign subject identity never falls back to its live OAuth row",
    "backend": "postgres"
  },
  {
    "file": "tests/agent-access/native-oauth-origin.test.ts",
    "suite": "native OAuth journal current origin [postgres]",
    "test": "native OAuth tuple provenance refuses changed configured issuer",
    "backend": "postgres"
  },
  {
    "file": "tests/agent-access/native-oauth-origin.test.ts",
    "suite": "native OAuth journal current origin [postgres]",
    "test": "native OAuth tuple provenance refuses changed configured jwks",
    "backend": "postgres"
  },
  {
    "file": "tests/agent-access/native-oauth-origin.test.ts",
    "suite": "native OAuth journal current origin [postgres]",
    "test": "native OAuth tuple provenance refuses changed configured client claim",
    "backend": "postgres"
  },
  {
    "file": "tests/agent-access/native-oauth-origin.test.ts",
    "suite": "native OAuth journal current origin [postgres]",
    "test": "native OAuth tuple provenance refuses changed configured subject claim",
    "backend": "postgres"
  },
  {
    "file": "tests/agent-access/native-oauth-origin.test.ts",
    "suite": "native OAuth journal current origin [postgres]",
    "test": "native OAuth tuple provenance refuses changed configured origin",
    "backend": "postgres"
  },
  {
    "file": "tests/agent-access/native-oauth-origin.test.ts",
    "suite": "native OAuth journal current origin [postgres]",
    "test": "native OAuth product provenance preserves exact null app metadata",
    "backend": "postgres"
  },
  {
    "file": "tests/agent-access/native-oauth-origin.test.ts",
    "suite": "native OAuth journal current origin [postgres]",
    "test": "native OAuth product provenance preserves exact empty app metadata",
    "backend": "postgres"
  },
  {
    "file": "tests/agent-access/native-oauth-origin.test.ts",
    "suite": "native OAuth journal current origin [postgres]",
    "test": "native OAuth product provenance preserves exact nonempty app metadata",
    "backend": "postgres"
  },
  {
    "file": "tests/agent-access/native-oauth-origin.test.ts",
    "suite": "native OAuth journal current origin [postgres]",
    "test": "native OAuth provenance refuses default target drift and restores the genuine current target",
    "backend": "postgres"
  },
  {
    "file": "tests/agent-access/native-oauth-origin.test.ts",
    "suite": "native OAuth journal current origin [postgres]",
    "test": "default native OAuth readiness refuses an owning scratch database without agent migration three",
    "backend": "postgres"
  },
  {
    "file": "tests/agent-access/native-oauth-origin.test.ts",
    "suite": "native OAuth journal current origin [postgres]",
    "test": "current native OAuth read refuses unknown identity without dispatch provenance",
    "backend": "postgres"
  },
  {
    "file": "tests/agent-access/native-oauth-origin.test.ts",
    "suite": "native OAuth journal current origin [postgres]",
    "test": "current native OAuth read refuses foreign subject without dispatch provenance",
    "backend": "postgres"
  },
  {
    "file": "tests/agent-access/native-oauth-origin.test.ts",
    "suite": "native OAuth journal current origin [postgres]",
    "test": "current native OAuth read refuses foreign workspace without dispatch provenance",
    "backend": "postgres"
  },
  {
    "file": "tests/agent-access/native-oauth-origin.test.ts",
    "suite": "native OAuth journal current origin [postgres]",
    "test": "current native OAuth read refuses expired grant without dispatch provenance",
    "backend": "postgres"
  },
  {
    "file": "tests/agent-access/native-oauth-origin.test.ts",
    "suite": "native OAuth journal current origin [postgres]",
    "test": "current native OAuth read refuses revoked grant without dispatch provenance",
    "backend": "postgres"
  },
  {
    "file": "tests/agent-access/native-oauth-origin.test.ts",
    "suite": "native OAuth journal current origin [postgres]",
    "test": "current native OAuth read refuses wrong issuer without dispatch provenance",
    "backend": "postgres"
  },
  {
    "file": "tests/agent-access/native-oauth-origin.test.ts",
    "suite": "native OAuth journal current origin [postgres]",
    "test": "current native OAuth read refuses malformed issuer without dispatch provenance",
    "backend": "postgres"
  },
  {
    "file": "tests/agent-access/native-oauth-origin.test.ts",
    "suite": "native OAuth journal current origin [postgres]",
    "test": "default runtime journal refuses client selector getters before selection with zero effects",
    "backend": "postgres"
  },
  {
    "file": "tests/agent-access/native-oauth-origin.test.ts",
    "suite": "native OAuth journal current origin [postgres]",
    "test": "default runtime journal refuses client selector getters during lazy import with zero effects",
    "backend": "postgres"
  },
  {
    "file": "tests/agent-access/native-oauth-origin.test.ts",
    "suite": "native OAuth journal current origin [postgres]",
    "test": "default OAuth preselection refuses canonical journal ready accessor with zero callbacks",
    "backend": "postgres"
  },
  {
    "file": "tests/agent-access/native-oauth-origin.test.ts",
    "suite": "native OAuth journal current origin [postgres]",
    "test": "default OAuth preselection refuses canonical journal ready method with zero callbacks",
    "backend": "postgres"
  },
  {
    "file": "tests/agent-access/native-oauth-origin.test.ts",
    "suite": "native OAuth journal current origin [postgres]",
    "test": "default OAuth preselection refuses canonical journal grants accessor with zero callbacks",
    "backend": "postgres"
  },
  {
    "file": "tests/agent-access/native-oauth-origin.test.ts",
    "suite": "native OAuth journal current origin [postgres]",
    "test": "default OAuth preselection refuses canonical journal grants method with zero callbacks",
    "backend": "postgres"
  },
  {
    "file": "tests/agent-access/native-oauth-origin.test.ts",
    "suite": "native OAuth journal current origin [postgres]",
    "test": "default OAuth preselection refuses canonical journal getGrant accessor with zero callbacks",
    "backend": "postgres"
  },
  {
    "file": "tests/agent-access/native-oauth-origin.test.ts",
    "suite": "native OAuth journal current origin [postgres]",
    "test": "default OAuth preselection refuses canonical journal getGrant method with zero callbacks",
    "backend": "postgres"
  },
  {
    "file": "tests/agent-access/native-oauth-origin.test.ts",
    "suite": "native OAuth journal current origin [postgres]",
    "test": "default OAuth preselection refuses a changed canonical journal prototype parent with zero callbacks",
    "backend": "postgres"
  },
  {
    "file": "tests/agent-access/native-oauth-origin.test.ts",
    "suite": "native OAuth journal current origin [postgres]",
    "test": "default OAuth preselection refuses an extra canonical journal method with zero callbacks",
    "backend": "postgres"
  },
  {
    "file": "tests/controlplane/plan-artifact-oauth-authority.test.ts",
    "suite": "native OAuth original-plan dispatch [postgres; modeled hosted REST and policy]",
    "test": "genuine default OAuth grant admits exactly its original sealed bytes once",
    "backend": "postgres"
  },
  {
    "file": "tests/controlplane/plan-artifact-oauth-authority.test.ts",
    "suite": "native OAuth original-plan dispatch [postgres; modeled hosted REST and policy]",
    "test": "final native OAuth dispatch fences grant revoked committed during held approving-human read",
    "backend": "postgres"
  },
  {
    "file": "tests/controlplane/plan-artifact-oauth-authority.test.ts",
    "suite": "native OAuth original-plan dispatch [postgres; modeled hosted REST and policy]",
    "test": "final native OAuth dispatch fences grant expired committed during held approving-human read",
    "backend": "postgres"
  },
  {
    "file": "tests/controlplane/plan-artifact-oauth-authority.test.ts",
    "suite": "native OAuth original-plan dispatch [postgres; modeled hosted REST and policy]",
    "test": "final native OAuth dispatch fences grant removed committed during held approving-human read",
    "backend": "postgres"
  },
  {
    "file": "tests/controlplane/plan-artifact-oauth-authority.test.ts",
    "suite": "native OAuth original-plan dispatch [postgres; modeled hosted REST and policy]",
    "test": "final native OAuth dispatch fences issuer replaced committed during held approving-human read",
    "backend": "postgres"
  },
  {
    "file": "tests/controlplane/plan-artifact-oauth-authority.test.ts",
    "suite": "native OAuth original-plan dispatch [postgres; modeled hosted REST and policy]",
    "test": "final native OAuth dispatch fences client replaced committed during held approving-human read",
    "backend": "postgres"
  },
  {
    "file": "tests/controlplane/plan-artifact-oauth-authority.test.ts",
    "suite": "native OAuth original-plan dispatch [postgres; modeled hosted REST and policy]",
    "test": "final native OAuth dispatch fences subject replaced committed during held approving-human read",
    "backend": "postgres"
  },
  {
    "file": "tests/controlplane/plan-artifact-oauth-authority.test.ts",
    "suite": "native OAuth original-plan dispatch [postgres; modeled hosted REST and policy]",
    "test": "final native OAuth dispatch fences workspace replaced committed during held approving-human read",
    "backend": "postgres"
  },
  {
    "file": "tests/controlplane/plan-artifact-oauth-authority.test.ts",
    "suite": "native OAuth original-plan dispatch [postgres; modeled hosted REST and policy]",
    "test": "final native OAuth dispatch fences project scope narrowed committed during held approving-human read",
    "backend": "postgres"
  },
  {
    "file": "tests/controlplane/plan-artifact-oauth-authority.test.ts",
    "suite": "native OAuth original-plan dispatch [postgres; modeled hosted REST and policy]",
    "test": "final native OAuth dispatch fences environment scope narrowed committed during held approving-human read",
    "backend": "postgres"
  },
  {
    "file": "tests/controlplane/plan-artifact-oauth-authority.test.ts",
    "suite": "native OAuth original-plan dispatch [postgres; modeled hosted REST and policy]",
    "test": "final native OAuth dispatch fences write scope removed committed during held approving-human read",
    "backend": "postgres"
  },
  {
    "file": "tests/controlplane/plan-artifact-oauth-authority.test.ts",
    "suite": "native OAuth original-plan dispatch [postgres; modeled hosted REST and policy]",
    "test": "final native OAuth dispatch fences nonempty app scope committed during held approving-human read",
    "backend": "postgres"
  },
  {
    "file": "tests/controlplane/plan-artifact-oauth-authority.test.ts",
    "suite": "native OAuth original-plan dispatch [postgres; modeled hosted REST and policy]",
    "test": "final native OAuth dispatch fences null app metadata replaced committed during held approving-human read",
    "backend": "postgres"
  },
  {
    "file": "tests/controlplane/plan-artifact-oauth-authority.test.ts",
    "suite": "native OAuth original-plan dispatch [postgres; modeled hosted REST and policy]",
    "test": "final native OAuth dispatch fences requester demoted committed during held approving-human read",
    "backend": "postgres"
  },
  {
    "file": "tests/controlplane/plan-artifact-oauth-authority.test.ts",
    "suite": "native OAuth original-plan dispatch [postgres; modeled hosted REST and policy]",
    "test": "final native OAuth dispatch fences approver demoted committed during held approving-human read",
    "backend": "postgres"
  },
  {
    "file": "tests/controlplane/plan-artifact-oauth-authority.test.ts",
    "suite": "native OAuth original-plan dispatch [postgres; modeled hosted REST and policy]",
    "test": "final native OAuth dispatch fences provider revoked committed during held approving-human read",
    "backend": "postgres"
  },
  {
    "file": "tests/controlplane/plan-artifact-oauth-authority.test.ts",
    "suite": "native OAuth original-plan dispatch [postgres; modeled hosted REST and policy]",
    "test": "final native OAuth dispatch fences journal method replaced committed during held approving-human read",
    "backend": "postgres"
  },
  {
    "file": "tests/controlplane/plan-artifact-oauth-authority.test.ts",
    "suite": "native OAuth original-plan dispatch [postgres; modeled hosted REST and policy]",
    "test": "final native OAuth dispatch fences runtime selector getter committed during held approving-human read",
    "backend": "postgres"
  },
  {
    "file": "tests/controlplane/plan-artifact-oauth-authority.test.ts",
    "suite": "native OAuth original-plan dispatch [postgres; modeled hosted REST and policy]",
    "test": "final native OAuth dispatch fences client method replaced committed during held approving-human read",
    "backend": "postgres"
  },
  {
    "file": "tests/controlplane/plan-artifact-oauth-authority.test.ts",
    "suite": "native OAuth original-plan dispatch [postgres; modeled hosted REST and policy]",
    "test": "final native OAuth dispatch fences configured issuer replaced committed during held approving-human read",
    "backend": "postgres"
  },
  {
    "file": "tests/controlplane/plan-artifact-oauth-authority.test.ts",
    "suite": "native OAuth original-plan dispatch [postgres; modeled hosted REST and policy]",
    "test": "final native OAuth dispatch fences configured jwks replaced committed during held approving-human read",
    "backend": "postgres"
  },
  {
    "file": "tests/controlplane/plan-artifact-oauth-authority.test.ts",
    "suite": "native OAuth original-plan dispatch [postgres; modeled hosted REST and policy]",
    "test": "final native OAuth dispatch fences authority target replaced committed during held approving-human read",
    "backend": "postgres"
  },
  {
    "file": "tests/controlplane/plan-artifact-oauth-authority.test.ts",
    "suite": "native OAuth original-plan dispatch [postgres; modeled hosted REST and policy]",
    "test": "final native OAuth dispatch fences foreign linked collision introduced committed during held approving-human read",
    "backend": "postgres"
  },
  {
    "file": "tests/controlplane/plan-artifact-oauth-authority.test.ts",
    "suite": "native OAuth original-plan dispatch [postgres; modeled hosted REST and policy]",
    "test": "final native OAuth dispatch fences benign product progress committed during held approving-human read",
    "backend": "postgres"
  },
  {
    "file": "tests/controlplane/plan-artifact-oauth-authority.test.ts",
    "suite": "native OAuth original-plan dispatch [postgres; modeled hosted REST and policy]",
    "test": "final native OAuth dispatch fences unchanged grant committed during held approving-human read",
    "backend": "postgres"
  },
  {
    "file": "tests/controlplane/plan-artifact-oauth-authority.test.ts",
    "suite": "native OAuth original-plan dispatch [postgres; modeled hosted REST and policy]",
    "test": "observed three-connection original use-row wait fences OAuth grant revoked",
    "backend": "postgres"
  },
  {
    "file": "tests/controlplane/plan-artifact-oauth-authority.test.ts",
    "suite": "native OAuth original-plan dispatch [postgres; modeled hosted REST and policy]",
    "test": "observed three-connection original use-row wait fences OAuth grant expired",
    "backend": "postgres"
  },
  {
    "file": "tests/controlplane/plan-artifact-oauth-authority.test.ts",
    "suite": "native OAuth original-plan dispatch [postgres; modeled hosted REST and policy]",
    "test": "observed three-connection original use-row wait fences OAuth project scope narrowed",
    "backend": "postgres"
  },
  {
    "file": "tests/controlplane/plan-artifact-oauth-authority.test.ts",
    "suite": "native OAuth original-plan dispatch [postgres; modeled hosted REST and policy]",
    "test": "observed three-connection original use-row wait fences OAuth environment scope narrowed",
    "backend": "postgres"
  },
  {
    "file": "tests/controlplane/plan-artifact-oauth-authority.test.ts",
    "suite": "native OAuth original-plan dispatch [postgres; modeled hosted REST and policy]",
    "test": "observed three-connection original use-row wait fences OAuth write scope removed",
    "backend": "postgres"
  },
  {
    "file": "tests/controlplane/plan-artifact-oauth-authority.test.ts",
    "suite": "native OAuth original-plan dispatch [postgres; modeled hosted REST and policy]",
    "test": "observed three-connection original use-row wait fences OAuth issuer replaced",
    "backend": "postgres"
  },
  {
    "file": "tests/controlplane/plan-artifact-oauth-authority.test.ts",
    "suite": "native OAuth original-plan dispatch [postgres; modeled hosted REST and policy]",
    "test": "observed three-connection original use-row wait fences OAuth client replaced",
    "backend": "postgres"
  },
  {
    "file": "tests/controlplane/plan-artifact-oauth-authority.test.ts",
    "suite": "native OAuth original-plan dispatch [postgres; modeled hosted REST and policy]",
    "test": "observed three-connection original use-row wait fences OAuth subject replaced",
    "backend": "postgres"
  },
  {
    "file": "tests/controlplane/plan-artifact-oauth-authority.test.ts",
    "suite": "native OAuth original-plan dispatch [postgres; modeled hosted REST and policy]",
    "test": "observed three-connection original use-row wait fences OAuth workspace replaced",
    "backend": "postgres"
  },
  {
    "file": "tests/controlplane/plan-artifact-oauth-authority.test.ts",
    "suite": "native OAuth original-plan dispatch [postgres; modeled hosted REST and policy]",
    "test": "observed three-connection original use-row wait fences OAuth null app metadata replaced",
    "backend": "postgres"
  },
  {
    "file": "tests/controlplane/plan-artifact-oauth-authority.test.ts",
    "suite": "native OAuth original-plan dispatch [postgres; modeled hosted REST and policy]",
    "test": "observed three-connection original use-row wait fences OAuth foreign linked collision introduced",
    "backend": "postgres"
  },
  {
    "file": "tests/controlplane/plan-artifact-oauth-authority.test.ts",
    "suite": "native OAuth original-plan dispatch [postgres; modeled hosted REST and policy]",
    "test": "observed three-connection original use-row wait fences OAuth configured issuer replaced",
    "backend": "postgres"
  },
  {
    "file": "tests/controlplane/plan-artifact-oauth-authority.test.ts",
    "suite": "native OAuth original-plan dispatch [postgres; modeled hosted REST and policy]",
    "test": "observed three-connection original use-row wait fences OAuth runtime selector getter",
    "backend": "postgres"
  },
  {
    "file": "tests/controlplane/plan-artifact-oauth-authority.test.ts",
    "suite": "native OAuth original-plan dispatch [postgres; modeled hosted REST and policy]",
    "test": "observed three-connection original use-row wait fences OAuth authority target replaced",
    "backend": "postgres"
  },
  {
    "file": "tests/controlplane/plan-artifact-oauth-authority.test.ts",
    "suite": "native OAuth original-plan dispatch [postgres; modeled hosted REST and policy]",
    "test": "observed three-connection original use-row wait fences OAuth unchanged grant",
    "backend": "postgres"
  },
  {
    "file": "tests/controlplane/plan-artifact-oauth-authority.test.ts",
    "suite": "native OAuth original-plan dispatch [postgres; modeled hosted REST and policy]",
    "test": "OAuth plan-only viewer publication retains source-free Git destroy custody without provider writes",
    "backend": "postgres"
  },
  {
    "file": "tests/controlplane/plan-artifact-oauth-authority.test.ts",
    "suite": "native OAuth original-plan dispatch [postgres; modeled hosted REST and policy]",
    "test": "browser-approved exact OAuth delegated destroy fences unchanged planning grant after held admin read",
    "backend": "postgres"
  },
  {
    "file": "tests/controlplane/plan-artifact-oauth-authority.test.ts",
    "suite": "native OAuth original-plan dispatch [postgres; modeled hosted REST and policy]",
    "test": "browser-approved exact OAuth delegated destroy fences revoked planning grant after held admin read",
    "backend": "postgres"
  },
  {
    "file": "tests/controlplane/plan-artifact-oauth-authority.test.ts",
    "suite": "native OAuth original-plan dispatch [postgres; modeled hosted REST and policy]",
    "test": "browser-approved exact OAuth delegated destroy fences plan scope removed after held admin read",
    "backend": "postgres"
  },
  {
    "file": "tests/controlplane/plan-artifact-oauth-authority.test.ts",
    "suite": "native OAuth original-plan dispatch [postgres; modeled hosted REST and policy]",
    "test": "browser-approved exact OAuth delegated destroy fences current admin demoted after held admin read",
    "backend": "postgres"
  },
  {
    "file": "tests/controlplane/plan-artifact-oauth-authority.test.ts",
    "suite": "native OAuth original-plan dispatch [postgres; modeled hosted REST and policy]",
    "test": "uncertain OAuth dispatch retains its original attempt and refuses a fresh replay",
    "backend": "postgres"
  }
];

// Additive linked controls; the historical50 and171 tables remain exact.
export const NATIVE_CREDENTIAL_FACTORY_POSTGRES_REQUIREMENTS = [
  {
    "file": "tests/agent-access/credential-authority-origin.test.ts",
    "suite": "native linked credential factory origin [postgres]",
    "test": "pre-selection linked factory refuses ready method before registering or invoking callbacks",
    "backend": "postgres"
  },
  {
    "file": "tests/agent-access/credential-authority-origin.test.ts",
    "suite": "native linked credential factory origin [postgres]",
    "test": "pre-selection linked factory refuses ready accessor before registering or invoking callbacks",
    "backend": "postgres"
  },
  {
    "file": "tests/agent-access/credential-authority-origin.test.ts",
    "suite": "native linked credential factory origin [postgres]",
    "test": "pre-selection linked factory refuses getCredential method before registering or invoking callbacks",
    "backend": "postgres"
  },
  {
    "file": "tests/agent-access/credential-authority-origin.test.ts",
    "suite": "native linked credential factory origin [postgres]",
    "test": "pre-selection linked factory refuses getCredential accessor before registering or invoking callbacks",
    "backend": "postgres"
  },
  {
    "file": "tests/agent-access/credential-authority-origin.test.ts",
    "suite": "native linked credential factory origin [postgres]",
    "test": "pre-selection linked factory refuses listCredentials method before registering or invoking callbacks",
    "backend": "postgres"
  },
  {
    "file": "tests/agent-access/credential-authority-origin.test.ts",
    "suite": "native linked credential factory origin [postgres]",
    "test": "pre-selection linked factory refuses listCredentials accessor before registering or invoking callbacks",
    "backend": "postgres"
  },
  {
    "file": "tests/agent-access/credential-authority-origin.test.ts",
    "suite": "native linked credential factory origin [postgres]",
    "test": "pre-selection linked factory refuses a changed canonical prototype parent and restores native authority",
    "backend": "postgres"
  },
  {
    "file": "tests/agent-access/credential-authority-origin.test.ts",
    "suite": "native linked credential factory origin [postgres]",
    "test": "pre-selection linked factory refuses authority selector accessors with zero getter or setter effects",
    "backend": "postgres"
  },
  {
    "file": "tests/agent-access/credential-authority-origin.test.ts",
    "suite": "native linked credential factory origin [postgres]",
    "test": "pre-selection linked factory refuses client selector accessors with zero getter or setter effects",
    "backend": "postgres"
  },
  {
    "file": "tests/agent-access/credential-authority-origin.test.ts",
    "suite": "native linked credential factory origin [postgres]",
    "test": "cached linked readiness and native read refuse a client selector getter before calling its factory",
    "backend": "postgres"
  },
  {
    "file": "tests/agent-access/credential-authority-origin.test.ts",
    "suite": "native linked credential factory origin [postgres]",
    "test": "tooling linked constructor retains native readiness without acquiring default factory origin",
    "backend": "postgres"
  }
];


// Literal native custody, retention-preview and Kubernetes target cases survive source deletion.
// PROD-MIX-04: exact application-boundary observations require native SQL.
// PGlite/memory siblings never satisfy these five literal PostgreSQL cases.
export const MIXED_RUN_STORE_POSTGRES_REQUIREMENTS = [
  "refuses malformed 'state version' before create or save touches SQL",
  "refuses malformed 'child attempts' before create or save touches SQL",
  "refuses legacy logical environmentId mismatch without changing the retained row or ledger",
  "refuses legacy logical desiredDigest mismatch without changing the retained row or ledger",
  "preserves valid writes, ordered ledger and stale-version refusal",
].map(test => ({file:"tests/execution/mixed-run-store.test.ts",suite:"mixed run store validation [postgres]",test,postgres:true}));

export const MIXED_CHILD_CUSTODY_POSTGRES_REQUIREMENTS = [
  {
    "file": "tests/controlplane/mixed-child-admission.test.ts",
    "suite": "native mixed child custody [postgres]",
    "test": "retains an immutable native child candidate with separate provider and backend identities but no execution authority",
    "backend": "postgres"
  },
  {
    "file": "tests/controlplane/mixed-child-admission.test.ts",
    "suite": "native mixed child custody [postgres]",
    "test": "duplicate independent-pool retention yields one exact immutable descriptor and prepared intent",
    "backend": "postgres"
  },
  {
    "file": "tests/controlplane/mixed-child-admission.test.ts",
    "suite": "native mixed child custody [postgres]",
    "test": "foreign workspace reads and retention neither expose nor mutate native custody or approvals",
    "backend": "postgres"
  },
  {
    "file": "tests/controlplane/mixed-child-admission.test.ts",
    "suite": "native mixed child custody [postgres]",
    "test": "the native repository refuses structural database branding before any callback",
    "backend": "postgres"
  },
  {
    "file": "tests/controlplane/mixed-child-admission.test.ts",
    "suite": "native mixed child custody [postgres]",
    "test": "native ID capture refuses hostile getters and supplied approval flags without evaluating them",
    "backend": "postgres"
  },
  {
    "file": "tests/controlplane/mixed-child-admission.test.ts",
    "suite": "native mixed child custody [postgres]",
    "test": "a genuinely reviewed child still cannot reserve Start when mixed parent effects are unsupported",
    "backend": "postgres"
  },
  {
    "file": "tests/controlplane/mixed-child-admission.test.ts",
    "suite": "native mixed child custody [postgres]",
    "test": "missing child concrete review cannot borrow parent approvals",
    "backend": "postgres"
  },
  {
    "file": "tests/controlplane/mixed-child-admission.test.ts",
    "suite": "native mixed child custody [postgres]",
    "test": "child approval consumption cannot be inferred or performed by custody retention",
    "backend": "postgres"
  },
  {
    "file": "tests/controlplane/mixed-child-admission.test.ts",
    "suite": "native mixed child custody [postgres]",
    "test": "parent plan digest edits refuse native child retention",
    "backend": "postgres"
  },
  {
    "file": "tests/controlplane/mixed-child-admission.test.ts",
    "suite": "native mixed child custody [postgres]",
    "test": "child plan digest edits refuse native child retention",
    "backend": "postgres"
  },
  {
    "file": "tests/controlplane/mixed-child-admission.test.ts",
    "suite": "native mixed child custody [postgres]",
    "test": "requester current human demotion refuses custody despite retained approved rows",
    "backend": "postgres"
  },
  {
    "file": "tests/controlplane/mixed-child-admission.test.ts",
    "suite": "native mixed child custody [postgres]",
    "test": "approver current human demotion refuses custody despite retained approved rows",
    "backend": "postgres"
  },
  {
    "file": "tests/controlplane/mixed-child-admission.test.ts",
    "suite": "native mixed child custody [postgres]",
    "test": "parent current connection revocation refuses custody",
    "backend": "postgres"
  },
  {
    "file": "tests/controlplane/mixed-child-admission.test.ts",
    "suite": "native mixed child custody [postgres]",
    "test": "child current connection revocation refuses custody",
    "backend": "postgres"
  },
  {
    "file": "tests/controlplane/mixed-child-admission.test.ts",
    "suite": "native mixed child custody [postgres]",
    "test": "a parent environment lease that is expired cannot qualify native custody",
    "backend": "postgres"
  },
  {
    "file": "tests/controlplane/mixed-child-admission.test.ts",
    "suite": "native mixed child custody [postgres]",
    "test": "a parent environment lease that is foreign cannot qualify native custody",
    "backend": "postgres"
  },
  {
    "file": "tests/controlplane/mixed-child-admission.test.ts",
    "suite": "native mixed child custody [postgres]",
    "test": "a parent environment lease that is taken over cannot qualify native custody",
    "backend": "postgres"
  },
  {
    "file": "tests/controlplane/mixed-child-admission.test.ts",
    "suite": "native mixed child custody [postgres]",
    "test": "a parent environment lease that is partial pair cannot qualify native custody",
    "backend": "postgres"
  },
  {
    "file": "tests/controlplane/mixed-child-admission.test.ts",
    "suite": "native mixed child custody [postgres]",
    "test": "an existing foreign settings row cannot masquerade as absent owning environment policy",
    "backend": "postgres"
  },
  {
    "file": "tests/controlplane/mixed-child-admission.test.ts",
    "suite": "native mixed child custody [postgres]",
    "test": "a child environment cannot redirect custody to a second unrelated same-workspace connection",
    "backend": "postgres"
  },
  {
    "file": "tests/controlplane/mixed-child-admission.test.ts",
    "suite": "native mixed child custody [postgres]",
    "test": "original plan evidence edits refuse immutable metadata reapplication without consuming another approval",
    "backend": "postgres"
  },
  {
    "file": "tests/controlplane/mixed-child-admission.test.ts",
    "suite": "native mixed child custody [postgres]",
    "test": "foreign project or revision cannot be copied into a child's immutable scope",
    "backend": "postgres"
  },
  {
    "file": "tests/controlplane/mixed-child-admission.test.ts",
    "suite": "native mixed child custody [postgres]",
    "test": "changed provider backend identity cannot replace previously retained child custody",
    "backend": "postgres"
  },
  {
    "file": "tests/controlplane/mixed-child-admission.test.ts",
    "suite": "native mixed child custody [postgres]",
    "test": "committed connection change during an observed native outbox row wait refuses custody reapplication",
    "backend": "postgres"
  },
  {
    "file": "tests/controlplane/mixed-child-admission.test.ts",
    "suite": "native mixed child custody [postgres]",
    "test": "committed approver change during an observed native outbox row wait refuses custody reapplication",
    "backend": "postgres"
  },
  {
    "file": "tests/controlplane/mixed-child-admission.test.ts",
    "suite": "native mixed child custody [postgres]",
    "test": "committed evidence change during an observed native outbox row wait refuses custody reapplication",
    "backend": "postgres"
  },
  {
    "file": "tests/controlplane/mixed-child-admission.test.ts",
    "suite": "native mixed child custody [postgres]",
    "test": "committed parent approval change during an observed native outbox row wait refuses custody reapplication",
    "backend": "postgres"
  },
  {
    "file": "tests/controlplane/mixed-child-admission.test.ts",
    "suite": "native mixed child custody [postgres]",
    "test": "committed child approval change during an observed native outbox row wait refuses custody reapplication",
    "backend": "postgres"
  },
  {
    "file": "tests/controlplane/mixed-child-admission.test.ts",
    "suite": "native mixed child custody [postgres]",
    "test": "committed settings change during an observed native outbox row wait refuses custody reapplication",
    "backend": "postgres"
  },
  {
    "file": "tests/controlplane/mixed-child-admission.test.ts",
    "suite": "native mixed child custody [postgres]",
    "test": "immutable descriptor rows cannot be edited or deleted and prepared outbox rows cannot be promoted",
    "backend": "postgres"
  },
  {
    "file": "tests/controlplane/mixed-child-admission.test.ts",
    "suite": "native mixed child custody [postgres]",
    "test": "an explicitly synthetic attempted tombstone remains diagnostic and cannot supply a second Start",
    "backend": "postgres"
  },
  {
    "file": "tests/controlplane/mixed-child-admission.test.ts",
    "suite": "native mixed child custody [postgres]",
    "test": "an explicitly synthetic acknowledged tombstone remains diagnostic and cannot supply a second Start",
    "backend": "postgres"
  },
  {
    "file": "tests/controlplane/mixed-child-admission.test.ts",
    "suite": "native mixed child custody [postgres]",
    "test": "an uncertain native parent cannot provide a new child custody continuation",
    "backend": "postgres"
  },
  {
    "file": "tests/controlplane/mixed-child-admission.test.ts",
    "suite": "native mixed child custody [postgres]",
    "test": "a direct SQL candidate cannot set executionEnabled or omit its non-authority bound",
    "backend": "postgres"
  },
  {
    "file": "tests/controlplane/mixed-child-admission.test.ts",
    "suite": "native mixed child custody [postgres]",
    "test": "a direct SQL candidate cannot set artifactBytesAuthenticated or omit its non-authority bound",
    "backend": "postgres"
  },
  {
    "file": "tests/controlplane/mixed-child-admission.test.ts",
    "suite": "native mixed child custody [postgres]",
    "test": "a missing child operation cannot manufacture a retained candidate or a parent fallback Start",
    "backend": "postgres"
  },
  {
    "file": "tests/controlplane/mixed-child-admission.test.ts",
    "suite": "native mixed child custody [postgres]",
    "test": "RLS and exact narrower service grants do not expose child custody to browser roles",
    "backend": "postgres"
  }
];

export const PLAN_RETENTION_POSTGRES_REQUIREMENTS = [
  {
    "file": "tests/controlplane/plan-artifact-retention.test.ts",
    "suite": "plan artifact retention preview [postgres; synthetic storage and receipt fixtures]",
    "test": "previews one expired terminal artifact for archive copy review while retaining all original rows",
    "backend": "postgres"
  },
  {
    "file": "tests/controlplane/plan-artifact-retention.test.ts",
    "suite": "plan artifact retention preview [postgres; synthetic storage and receipt fixtures]",
    "test": "protects current proposed operation before archive review",
    "backend": "postgres"
  },
  {
    "file": "tests/controlplane/plan-artifact-retention.test.ts",
    "suite": "plan artifact retention preview [postgres; synthetic storage and receipt fixtures]",
    "test": "protects current awaiting_approval operation before archive review",
    "backend": "postgres"
  },
  {
    "file": "tests/controlplane/plan-artifact-retention.test.ts",
    "suite": "plan artifact retention preview [postgres; synthetic storage and receipt fixtures]",
    "test": "protects current approved operation before archive review",
    "backend": "postgres"
  },
  {
    "file": "tests/controlplane/plan-artifact-retention.test.ts",
    "suite": "plan artifact retention preview [postgres; synthetic storage and receipt fixtures]",
    "test": "protects current queued operation before archive review",
    "backend": "postgres"
  },
  {
    "file": "tests/controlplane/plan-artifact-retention.test.ts",
    "suite": "plan artifact retention preview [postgres; synthetic storage and receipt fixtures]",
    "test": "protects current running operation before archive review",
    "backend": "postgres"
  },
  {
    "file": "tests/controlplane/plan-artifact-retention.test.ts",
    "suite": "plan artifact retention preview [postgres; synthetic storage and receipt fixtures]",
    "test": "protects terminal uncertain operation independently of its use phase",
    "backend": "postgres"
  },
  {
    "file": "tests/controlplane/plan-artifact-retention.test.ts",
    "suite": "plan artifact retention preview [postgres; synthetic storage and receipt fixtures]",
    "test": "protects claimed original-byte attempt even with a terminal owner",
    "backend": "postgres"
  },
  {
    "file": "tests/controlplane/plan-artifact-retention.test.ts",
    "suite": "plan artifact retention preview [postgres; synthetic storage and receipt fixtures]",
    "test": "protects dispatched original-byte attempt even with a terminal owner",
    "backend": "postgres"
  },
  {
    "file": "tests/controlplane/plan-artifact-retention.test.ts",
    "suite": "plan artifact retention preview [postgres; synthetic storage and receipt fixtures]",
    "test": "protects uncertain original-byte attempt even with a terminal owner",
    "backend": "postgres"
  },
  {
    "file": "tests/controlplane/plan-artifact-retention.test.ts",
    "suite": "plan artifact retention preview [postgres; synthetic storage and receipt fixtures]",
    "test": "refuses archive classification when the original use row is absent",
    "backend": "postgres"
  },
  {
    "file": "tests/controlplane/plan-artifact-retention.test.ts",
    "suite": "plan artifact retention preview [postgres; synthetic storage and receipt fixtures]",
    "test": "protects an explicitly held original without extending operation or artifact expiry",
    "backend": "postgres"
  },
  {
    "file": "tests/controlplane/plan-artifact-retention.test.ts",
    "suite": "plan artifact retention preview [postgres; synthetic storage and receipt fixtures]",
    "test": "propagates a same-workspace destination hold to its retained source artifact",
    "backend": "postgres"
  },
  {
    "file": "tests/controlplane/plan-artifact-retention.test.ts",
    "suite": "plan artifact retention preview [postgres; synthetic storage and receipt fixtures]",
    "test": "protects a source used by a current active associated destination",
    "backend": "postgres"
  },
  {
    "file": "tests/controlplane/plan-artifact-retention.test.ts",
    "suite": "plan artifact retention preview [postgres; synthetic storage and receipt fixtures]",
    "test": "protects a source with an uncertain associated original-byte attempt",
    "backend": "postgres"
  },
  {
    "file": "tests/controlplane/plan-artifact-retention.test.ts",
    "suite": "plan artifact retention preview [postgres; synthetic storage and receipt fixtures]",
    "test": "protects a source when an associated destination use row is missing",
    "backend": "postgres"
  },
  {
    "file": "tests/controlplane/plan-artifact-retention.test.ts",
    "suite": "plan artifact retention preview [postgres; synthetic storage and receipt fixtures]",
    "test": "protects a source whose associated custody has not expired",
    "backend": "postgres"
  },
  {
    "file": "tests/controlplane/plan-artifact-retention.test.ts",
    "suite": "plan artifact retention preview [postgres; synthetic storage and receipt fixtures]",
    "test": "requires both explicit creation cutoff and native artifact expiry before archive review",
    "backend": "postgres"
  },
  {
    "file": "tests/controlplane/plan-artifact-retention.test.ts",
    "suite": "plan artifact retention preview [postgres; synthetic storage and receipt fixtures]",
    "test": "bounds the oldest-first window and reports additional rows without claiming a complete inventory",
    "backend": "postgres"
  },
  {
    "file": "tests/controlplane/plan-artifact-retention.test.ts",
    "suite": "plan artifact retention preview [postgres; synthetic storage and receipt fixtures]",
    "test": "never lets another workspace artifact or hold alter the selected workspace preview",
    "backend": "postgres"
  },
  {
    "file": "tests/controlplane/plan-artifact-retention.test.ts",
    "suite": "plan artifact retention preview [postgres; synthetic storage and receipt fixtures]",
    "test": "captures holds before an awaited native query without invoking a replacement hold accessor",
    "backend": "postgres"
  },
  {
    "file": "tests/controlplane/plan-artifact-retention.test.ts",
    "suite": "plan artifact retention preview [postgres; synthetic storage and receipt fixtures]",
    "test": "fresh independent-pool operation mutation changes the next preview instead of trusting an earlier candidate",
    "backend": "postgres"
  },
  {
    "file": "tests/controlplane/plan-artifact-retention.test.ts",
    "suite": "plan artifact retention preview [postgres; synthetic storage and receipt fixtures]",
    "test": "protects permanent attempted workflow tombstones with an unconfirmed external start",
    "backend": "postgres"
  },
  {
    "file": "tests/controlplane/plan-artifact-retention.test.ts",
    "suite": "plan artifact retention preview [postgres; synthetic storage and receipt fixtures]",
    "test": "protects permanent build launch inventory until its terminal observation is retained",
    "backend": "postgres"
  },
  {
    "file": "tests/controlplane/plan-artifact-retention.test.ts",
    "suite": "plan artifact retention preview [postgres; synthetic storage and receipt fixtures]",
    "test": "preserves audit evidence idempotency leases original custody and acknowledged start and terminal build receipts byte for byte",
    "backend": "postgres"
  },
  {
    "file": "tests/controlplane/plan-artifact-retention.test.ts",
    "suite": "plan artifact retention preview [postgres; synthetic storage and receipt fixtures]",
    "test": "returns counts without plan state ciphertext digests keys or row identities",
    "backend": "postgres"
  },
  {
    "file": "tests/controlplane/plan-artifact-retention.test.ts",
    "suite": "plan artifact retention preview [postgres; synthetic storage and receipt fixtures]",
    "test": "preview holds do not waive existing logical expiry or remove original encrypted bytes",
    "backend": "postgres"
  }
];

export const KUBERNETES_VAULT_TARGET_POSTGRES_REQUIREMENTS = [
  {
    "file": "tests/platform/kubernetes-vault-target.test.ts",
    "suite": "default Kubernetes vault target binding [postgres; modeled API boundary]",
    "test": "a full tenant-sealed kubeconfig reaches every modeled namespace read without recording automatic verification",
    "backend": "postgres"
  },
  {
    "file": "tests/platform/kubernetes-vault-target.test.ts",
    "suite": "default Kubernetes vault target binding [postgres; modeled API boundary]",
    "test": "the same verified native target admits one callback and closes its retained accessor",
    "backend": "postgres"
  },
  {
    "file": "tests/platform/kubernetes-vault-target.test.ts",
    "suite": "default Kubernetes vault target binding [postgres; modeled API boundary]",
    "test": "native verification refuses raw token before API admission",
    "backend": "postgres"
  },
  {
    "file": "tests/platform/kubernetes-vault-target.test.ts",
    "suite": "default Kubernetes vault target binding [postgres; modeled API boundary]",
    "test": "native verification refuses different server before API admission",
    "backend": "postgres"
  },
  {
    "file": "tests/platform/kubernetes-vault-target.test.ts",
    "suite": "default Kubernetes vault target binding [postgres; modeled API boundary]",
    "test": "native verification refuses different CA before API admission",
    "backend": "postgres"
  },
  {
    "file": "tests/platform/kubernetes-vault-target.test.ts",
    "suite": "default Kubernetes vault target binding [postgres; modeled API boundary]",
    "test": "native verification refuses unknown context before API admission",
    "backend": "postgres"
  },
  {
    "file": "tests/platform/kubernetes-vault-target.test.ts",
    "suite": "default Kubernetes vault target binding [postgres; modeled API boundary]",
    "test": "native verification refuses insecure cluster override before API admission",
    "backend": "postgres"
  },
  {
    "file": "tests/platform/kubernetes-vault-target.test.ts",
    "suite": "default Kubernetes vault target binding [postgres; modeled API boundary]",
    "test": "refuses a provider session for a stored grant revoked since issue, before any credential is resolved",
    "backend": "postgres"
  },
  {
    "file": "tests/platform/kubernetes-vault-target.test.ts",
    "suite": "default Kubernetes vault target binding [postgres; modeled API boundary]",
    "test": "a same-named foreign sealed value never supplies the owning target or credential",
    "backend": "postgres"
  },
  {
    "file": "tests/platform/kubernetes-vault-target.test.ts",
    "suite": "default Kubernetes vault target binding [postgres; modeled API boundary]",
    "test": "a revoked native connection never resolves a stored bound credential or reactivates",
    "backend": "postgres"
  },
  {
    "file": "tests/platform/kubernetes-vault-target.test.ts",
    "suite": "default Kubernetes vault target binding [postgres; modeled API boundary]",
    "test": "native callback recaptures current scope after vault unchanged",
    "backend": "postgres"
  },
  {
    "file": "tests/platform/kubernetes-vault-target.test.ts",
    "suite": "default Kubernetes vault target binding [postgres; modeled API boundary]",
    "test": "native callback recaptures current scope after vault server drift",
    "backend": "postgres"
  },
  {
    "file": "tests/platform/kubernetes-vault-target.test.ts",
    "suite": "default Kubernetes vault target binding [postgres; modeled API boundary]",
    "test": "native callback recaptures current scope after vault CA drift",
    "backend": "postgres"
  },
  {
    "file": "tests/platform/kubernetes-vault-target.test.ts",
    "suite": "default Kubernetes vault target binding [postgres; modeled API boundary]",
    "test": "native callback recaptures current scope after vault revocation",
    "backend": "postgres"
  },
  {
    "file": "tests/platform/kubernetes-vault-target.test.ts",
    "suite": "default Kubernetes vault target binding [postgres; modeled API boundary]",
    "test": "native callback recaptures current scope after audit unchanged",
    "backend": "postgres"
  },
  {
    "file": "tests/platform/kubernetes-vault-target.test.ts",
    "suite": "default Kubernetes vault target binding [postgres; modeled API boundary]",
    "test": "native callback recaptures current scope after audit server drift",
    "backend": "postgres"
  },
  {
    "file": "tests/platform/kubernetes-vault-target.test.ts",
    "suite": "default Kubernetes vault target binding [postgres; modeled API boundary]",
    "test": "native callback recaptures current scope after audit CA drift",
    "backend": "postgres"
  },
  {
    "file": "tests/platform/kubernetes-vault-target.test.ts",
    "suite": "default Kubernetes vault target binding [postgres; modeled API boundary]",
    "test": "native callback recaptures current scope after audit revocation",
    "backend": "postgres"
  }
];

// Exact native onboarding scenarios survive source deletion; hosted association and namespace API remain modeled.
export const KUBERNETES_CONNECTION_LINK_POSTGRES_REQUIREMENTS = [
  {
    "file": "tests/controlplane/kubernetes-connection-link.test.ts",
    "suite": "human Kubernetes connection linking [postgres; modeled hosted association, human request and namespace API]",
    "test": "pending native same-ID onboarding becomes verified only after the saved bound namespace read",
    "backend": "postgres"
  },
  {
    "file": "tests/controlplane/kubernetes-connection-link.test.ts",
    "suite": "human Kubernetes connection linking [postgres; modeled hosted association, human request and namespace API]",
    "test": "held native namespace read refuses changed config before recording verification or product health",
    "backend": "postgres"
  },
  {
    "file": "tests/controlplane/kubernetes-connection-link.test.ts",
    "suite": "human Kubernetes connection linking [postgres; modeled hosted association, human request and namespace API]",
    "test": "held native namespace read refuses changed legacy link before recording verification or product health",
    "backend": "postgres"
  },
  {
    "file": "tests/controlplane/kubernetes-connection-link.test.ts",
    "suite": "human Kubernetes connection linking [postgres; modeled hosted association, human request and namespace API]",
    "test": "held native namespace read refuses changed revocation before recording verification or product health",
    "backend": "postgres"
  },
  {
    "file": "tests/controlplane/kubernetes-connection-link.test.ts",
    "suite": "human Kubernetes connection linking [postgres; modeled hosted association, human request and namespace API]",
    "test": "held native namespace read refuses changed status before recording verification or product health",
    "backend": "postgres"
  },
  {
    "file": "tests/controlplane/kubernetes-connection-link.test.ts",
    "suite": "human Kubernetes connection linking [postgres; modeled hosted association, human request and namespace API]",
    "test": "held native namespace read refuses changed creator before recording verification or product health",
    "backend": "postgres"
  },
  {
    "file": "tests/controlplane/kubernetes-connection-link.test.ts",
    "suite": "human Kubernetes connection linking [postgres; modeled hosted association, human request and namespace API]",
    "test": "held native namespace read refuses changed actor demotion before recording verification or product health",
    "backend": "postgres"
  },
  {
    "file": "tests/controlplane/kubernetes-connection-link.test.ts",
    "suite": "human Kubernetes connection linking [postgres; modeled hosted association, human request and namespace API]",
    "test": "held native namespace read refuses changed product projection before recording verification or product health",
    "backend": "postgres"
  },
  {
    "file": "tests/controlplane/kubernetes-connection-link.test.ts",
    "suite": "human Kubernetes connection linking [postgres; modeled hosted association, human request and namespace API]",
    "test": "observed native verification update waiter refuses changed same DTO microsecond after its original capture",
    "backend": "postgres"
  },
  {
    "file": "tests/controlplane/kubernetes-connection-link.test.ts",
    "suite": "human Kubernetes connection linking [postgres; modeled hosted association, human request and namespace API]",
    "test": "observed native verification update waiter refuses changed config after its original capture",
    "backend": "postgres"
  },
  {
    "file": "tests/controlplane/kubernetes-connection-link.test.ts",
    "suite": "human Kubernetes connection linking [postgres; modeled hosted association, human request and namespace API]",
    "test": "observed native verification update waiter refuses changed legacy link after its original capture",
    "backend": "postgres"
  },
  {
    "file": "tests/controlplane/kubernetes-connection-link.test.ts",
    "suite": "human Kubernetes connection linking [postgres; modeled hosted association, human request and namespace API]",
    "test": "observed native verification update waiter refuses changed mode after its original capture",
    "backend": "postgres"
  },
  {
    "file": "tests/controlplane/kubernetes-connection-link.test.ts",
    "suite": "human Kubernetes connection linking [postgres; modeled hosted association, human request and namespace API]",
    "test": "observed native verification update waiter refuses changed status after its original capture",
    "backend": "postgres"
  },
  {
    "file": "tests/controlplane/kubernetes-connection-link.test.ts",
    "suite": "human Kubernetes connection linking [postgres; modeled hosted association, human request and namespace API]",
    "test": "current actor demotion during the observed original-row wait refuses native verification and product health",
    "backend": "postgres"
  },
  {
    "file": "tests/controlplane/kubernetes-connection-link.test.ts",
    "suite": "human Kubernetes connection linking [postgres; modeled hosted association, human request and namespace API]",
    "test": "current actor removal during the observed original-row wait refuses native verification and product health",
    "backend": "postgres"
  },
  {
    "file": "tests/controlplane/kubernetes-connection-link.test.ts",
    "suite": "human Kubernetes connection linking [postgres; modeled hosted association, human request and namespace API]",
    "test": "current actor foreign workspace during the observed original-row wait refuses native verification and product health",
    "backend": "postgres"
  },
  {
    "file": "tests/controlplane/kubernetes-connection-link.test.ts",
    "suite": "human Kubernetes connection linking [postgres; modeled hosted association, human request and namespace API]",
    "test": "copied, wrong-owner and reused verification captures never originate native status updates",
    "backend": "postgres"
  },
  {
    "file": "tests/controlplane/kubernetes-connection-link.test.ts",
    "suite": "human Kubernetes connection linking [postgres; modeled hosted association, human request and namespace API]",
    "test": "contradictory physical provider and config refuse before capture or namespace probing",
    "backend": "postgres"
  },
  {
    "file": "tests/controlplane/kubernetes-connection-link.test.ts",
    "suite": "human Kubernetes connection linking [postgres; modeled hosted association, human request and namespace API]",
    "test": "contradictory physical mode and config refuse before capture or namespace probing",
    "backend": "postgres"
  },
  {
    "file": "tests/controlplane/kubernetes-connection-link.test.ts",
    "suite": "human Kubernetes connection linking [postgres; modeled hosted association, human request and namespace API]",
    "test": "unsupported FILE topology leaves the created native connection pending and refuses before any namespace probe",
    "backend": "postgres"
  },
  {
    "file": "tests/controlplane/kubernetes-connection-link.test.ts",
    "suite": "human Kubernetes connection linking [postgres; modeled hosted association, human request and namespace API]",
    "test": "foreign scope and a revoked owning link never resolve the saved namespace credential",
    "backend": "postgres"
  }
];

/** Exactly the additive saved-builtin settlement cases; retained cleanup obligations stay separate. */
export const SAVED_PLAN_SETTLEMENT_POSTGRES_REQUIREMENTS = [
  {
    "file": "tests/controlplane/cleanup-writer-barriers.test.ts",
    "suite": "native cleanup writer barrier [postgres; modeled hosted association and policy]",
    "test": "real original builtin apply retains one authenticated immutable settlement and refuses replay",
    "backend": "postgres"
  },
  {
    "file": "tests/controlplane/cleanup-writer-barriers.test.ts",
    "suite": "native cleanup writer barrier [postgres; modeled hosted association and policy]",
    "test": "new default paired codec reconciles only completed builtin plan history before exact same-scope destroy",
    "backend": "postgres"
  },
  {
    "file": "tests/controlplane/cleanup-writer-barriers.test.ts",
    "suite": "native cleanup writer barrier [postgres; modeled hosted association and policy]",
    "test": "lost completion acknowledgement stays unconfirmed while independently retained proof permits a newly approved destroy",
    "backend": "postgres"
  },
  {
    "file": "tests/controlplane/cleanup-writer-barriers.test.ts",
    "suite": "native cleanup writer barrier [postgres; modeled hosted association and policy]",
    "test": "accepted builtin apply without a committed settlement remains uncertain and blocks later destroy",
    "backend": "postgres"
  },
  {
    "file": "tests/controlplane/cleanup-writer-barriers.test.ts",
    "suite": "native cleanup writer barrier [postgres; modeled hosted association and policy]",
    "test": "status-only terminal use and invented SQL settlement never remove unresolved plan history",
    "backend": "postgres"
  },
  {
    "file": "tests/controlplane/cleanup-writer-barriers.test.ts",
    "suite": "native cleanup writer barrier [postgres; modeled hosted association and policy]",
    "test": "authenticated settlement refuses copied workspaceId tuple",
    "backend": "postgres"
  },
  {
    "file": "tests/controlplane/cleanup-writer-barriers.test.ts",
    "suite": "native cleanup writer barrier [postgres; modeled hosted association and policy]",
    "test": "authenticated settlement refuses copied projectId tuple",
    "backend": "postgres"
  },
  {
    "file": "tests/controlplane/cleanup-writer-barriers.test.ts",
    "suite": "native cleanup writer barrier [postgres; modeled hosted association and policy]",
    "test": "authenticated settlement refuses copied environmentId tuple",
    "backend": "postgres"
  },
  {
    "file": "tests/controlplane/cleanup-writer-barriers.test.ts",
    "suite": "native cleanup writer barrier [postgres; modeled hosted association and policy]",
    "test": "authenticated settlement refuses copied operationId tuple",
    "backend": "postgres"
  },
  {
    "file": "tests/controlplane/cleanup-writer-barriers.test.ts",
    "suite": "native cleanup writer barrier [postgres; modeled hosted association and policy]",
    "test": "authenticated settlement refuses copied attemptId tuple",
    "backend": "postgres"
  },
  {
    "file": "tests/controlplane/cleanup-writer-barriers.test.ts",
    "suite": "native cleanup writer barrier [postgres; modeled hosted association and policy]",
    "test": "authenticated settlement refuses copied manifestDigest tuple",
    "backend": "postgres"
  },
  {
    "file": "tests/controlplane/cleanup-writer-barriers.test.ts",
    "suite": "native cleanup writer barrier [postgres; modeled hosted association and policy]",
    "test": "authenticated settlement refuses copied rawSha256 tuple",
    "backend": "postgres"
  },
  {
    "file": "tests/controlplane/cleanup-writer-barriers.test.ts",
    "suite": "native cleanup writer barrier [postgres; modeled hosted association and policy]",
    "test": "authenticated settlement refuses copied backendDigest tuple",
    "backend": "postgres"
  },
  {
    "file": "tests/controlplane/cleanup-writer-barriers.test.ts",
    "suite": "native cleanup writer barrier [postgres; modeled hosted association and policy]",
    "test": "authenticated settlement refuses copied targetDigest tuple",
    "backend": "postgres"
  },
  {
    "file": "tests/controlplane/cleanup-writer-barriers.test.ts",
    "suite": "native cleanup writer barrier [postgres; modeled hosted association and policy]",
    "test": "authenticated settlement refuses copied holder tuple",
    "backend": "postgres"
  },
  {
    "file": "tests/controlplane/cleanup-writer-barriers.test.ts",
    "suite": "native cleanup writer barrier [postgres; modeled hosted association and policy]",
    "test": "authenticated settlement refuses copied fenceToken tuple",
    "backend": "postgres"
  },
  {
    "file": "tests/controlplane/cleanup-writer-barriers.test.ts",
    "suite": "native cleanup writer barrier [postgres; modeled hosted association and policy]",
    "test": "corrupt settlement ciphertext and wrong purpose-separated key refuse independently",
    "backend": "postgres"
  },
  {
    "file": "tests/controlplane/cleanup-writer-barriers.test.ts",
    "suite": "native cleanup writer barrier [postgres; modeled hosted association and policy]",
    "test": "fresh engine accepts retained old settlement key only during explicit overlap and refuses retirement",
    "backend": "postgres"
  },
  {
    "file": "tests/controlplane/cleanup-writer-barriers.test.ts",
    "suite": "native cleanup writer barrier [postgres; modeled hosted association and policy]",
    "test": "current completion readback refuses changed state while immutable earlier settlement remains historical",
    "backend": "postgres"
  },
  {
    "file": "tests/controlplane/cleanup-writer-barriers.test.ts",
    "suite": "native cleanup writer barrier [postgres; modeled hosted association and policy]",
    "test": "different logical product scopes cannot bind the same actual local backend",
    "backend": "postgres"
  },
  {
    "file": "tests/controlplane/cleanup-writer-barriers.test.ts",
    "suite": "native cleanup writer barrier [postgres; modeled hosted association and policy]",
    "test": "mutable nonsticky grandparent refuses standalone admission before tool execution",
    "backend": "postgres"
  },
  {
    "file": "tests/controlplane/cleanup-writer-barriers.test.ts",
    "suite": "native cleanup writer barrier [postgres; modeled hosted association and policy]",
    "test": "fabricated readback with restored prototypes and genuine cleanup cannot mint settlement",
    "backend": "postgres"
  },
  {
    "file": "tests/controlplane/cleanup-writer-barriers.test.ts",
    "suite": "native cleanup writer barrier [postgres; modeled hosted association and policy]",
    "test": "incomplete actual checked cleanup cannot mint settlement or replay accepted apply",
    "backend": "postgres"
  },
  {
    "file": "tests/controlplane/cleanup-writer-barriers.test.ts",
    "suite": "native cleanup writer barrier [postgres; modeled hosted association and policy]",
    "test": "prior issued grant remains unresolved despite builtin settlement",
    "backend": "postgres"
  },
  {
    "file": "tests/controlplane/cleanup-writer-barriers.test.ts",
    "suite": "native cleanup writer barrier [postgres; modeled hosted association and policy]",
    "test": "final builtin receipt fences requester demotion during post-readback current-role wait",
    "backend": "postgres"
  },
  {
    "file": "tests/controlplane/cleanup-writer-barriers.test.ts",
    "suite": "native cleanup writer barrier [postgres; modeled hosted association and policy]",
    "test": "final builtin receipt fences approver removal during post-readback current-role wait",
    "backend": "postgres"
  },
  {
    "file": "tests/controlplane/cleanup-writer-barriers.test.ts",
    "suite": "native cleanup writer barrier [postgres; modeled hosted association and policy]",
    "test": "final builtin receipt fences approval expiry during post-readback current-role wait",
    "backend": "postgres"
  },
  {
    "file": "tests/controlplane/cleanup-writer-barriers.test.ts",
    "suite": "native cleanup writer barrier [postgres; modeled hosted association and policy]",
    "test": "final builtin receipt fences provider revocation during post-readback current-role wait",
    "backend": "postgres"
  },
  {
    "file": "tests/controlplane/cleanup-writer-barriers.test.ts",
    "suite": "native cleanup writer barrier [postgres; modeled hosted association and policy]",
    "test": "final builtin receipt fences unchanged current authority during post-readback current-role wait",
    "backend": "postgres"
  },
  {
    "file": "tests/controlplane/cleanup-writer-barriers.test.ts",
    "suite": "native cleanup writer barrier [postgres; modeled hosted association and policy]",
    "test": "foreign provider resources in protected local state refuse before standalone tool admission",
    "backend": "postgres"
  },
  {
    "file": "tests/controlplane/cleanup-writer-barriers.test.ts",
    "suite": "native cleanup writer barrier [postgres; modeled hosted association and policy]",
    "test": "observed native completion coordinator wait fences region replacement before terminal receipt insert",
    "backend": "postgres"
  },
  {
    "file": "tests/controlplane/cleanup-writer-barriers.test.ts",
    "suite": "native cleanup writer barrier [postgres; modeled hosted association and policy]",
    "test": "observed native completion coordinator wait fences approver demotion before terminal receipt insert",
    "backend": "postgres"
  },
  {
    "file": "tests/controlplane/cleanup-writer-barriers.test.ts",
    "suite": "native cleanup writer barrier [postgres; modeled hosted association and policy]",
    "test": "observed native completion coordinator wait fences lease expiry before terminal receipt insert",
    "backend": "postgres"
  },
  {
    "file": "tests/controlplane/cleanup-writer-barriers.test.ts",
    "suite": "native cleanup writer barrier [postgres; modeled hosted association and policy]",
    "test": "observed native completion coordinator wait fences state replacement before terminal receipt insert",
    "backend": "postgres"
  },
  {
    "file": "tests/controlplane/cleanup-writer-barriers.test.ts",
    "suite": "native cleanup writer barrier [postgres; modeled hosted association and policy]",
    "test": "observed native completion coordinator wait fences unchanged final tuple before terminal receipt insert",
    "backend": "postgres"
  },
  {
    "file": "tests/controlplane/cleanup-writer-barriers.test.ts",
    "suite": "native cleanup writer barrier [postgres; modeled hosted association and policy]",
    "test": "structural fake producer run cannot seal chosen bytes as a finite builtin original",
    "backend": "postgres"
  },
  {
    "file": "tests/controlplane/cleanup-writer-barriers.test.ts",
    "suite": "native cleanup writer barrier [postgres; modeled hosted association and policy]",
    "test": "registered finite producer refuses own init method with backend override before command launch",
    "backend": "postgres"
  },
  {
    "file": "tests/controlplane/cleanup-writer-barriers.test.ts",
    "suite": "native cleanup writer barrier [postgres; modeled hosted association and policy]",
    "test": "registered finite producer refuses own plan method with backend override before command launch",
    "backend": "postgres"
  },
  {
    "file": "tests/controlplane/cleanup-writer-barriers.test.ts",
    "suite": "native cleanup writer barrier [postgres; modeled hosted association and policy]",
    "test": "registered finite producer refuses accessor init fields changed during the prelaunch filesystem wait",
    "backend": "postgres"
  },
  {
    "file": "tests/controlplane/cleanup-writer-barriers.test.ts",
    "suite": "native cleanup writer barrier [postgres; modeled hosted association and policy]",
    "test": "registered finite producer refuses replacement target init fields changed during the prelaunch filesystem wait",
    "backend": "postgres"
  },
  {
    "file": "tests/controlplane/cleanup-writer-barriers.test.ts",
    "suite": "native cleanup writer barrier [postgres; modeled hosted association and policy]",
    "test": "registered cleanup refuses a substituted absent root and then permits actual original cleanup",
    "backend": "postgres"
  },
  {
    "file": "tests/controlplane/cleanup-writer-barriers.test.ts",
    "suite": "native cleanup writer barrier [postgres; modeled hosted association and policy]",
    "test": "registered cleanup field accessor during removal cannot mark a run cleaned or mint settlement",
    "backend": "postgres"
  },
  {
    "file": "tests/controlplane/cleanup-writer-barriers.test.ts",
    "suite": "native cleanup writer barrier [postgres; modeled hosted association and policy]",
    "test": "registered finite producer refuses altered init command arguments before tool launch",
    "backend": "postgres"
  },
  {
    "file": "tests/controlplane/cleanup-writer-barriers.test.ts",
    "suite": "native cleanup writer barrier [postgres; modeled hosted association and policy]",
    "test": "registered finite producer refuses altered plan command arguments before tool launch",
    "backend": "postgres"
  },
  {
    "file": "tests/controlplane/cleanup-writer-barriers.test.ts",
    "suite": "native cleanup writer barrier [postgres; modeled hosted association and policy]",
    "test": "genuine registered producer with a foreign workspace refuses before its first init",
    "backend": "postgres"
  },
  {
    "file": "tests/controlplane/cleanup-writer-barriers.test.ts",
    "suite": "native cleanup writer barrier [postgres; modeled hosted association and policy]",
    "test": "post-inspection producer own method accessor refuses before the next finite engine member read",
    "backend": "postgres"
  },
  {
    "file": "tests/controlplane/cleanup-writer-barriers.test.ts",
    "suite": "native cleanup writer barrier [postgres; modeled hosted association and policy]",
    "test": "post-inspection producer prototype method accessor refuses before the next finite engine member read",
    "backend": "postgres"
  },
  {
    "file": "tests/controlplane/cleanup-writer-barriers.test.ts",
    "suite": "native cleanup writer barrier [postgres; modeled hosted association and policy]",
    "test": "post-inspection apply own method accessor refuses before the next finite engine member read",
    "backend": "postgres"
  },
  {
    "file": "tests/controlplane/cleanup-writer-barriers.test.ts",
    "suite": "native cleanup writer barrier [postgres; modeled hosted association and policy]",
    "test": "post-inspection apply prototype method accessor refuses before the next finite engine member read",
    "backend": "postgres"
  },
  {
    "file": "tests/controlplane/cleanup-writer-barriers.test.ts",
    "suite": "native cleanup writer barrier [postgres; modeled hosted association and policy]",
    "test": "post-inspection readback prototype method accessor refuses before the next finite engine member read",
    "backend": "postgres"
  },
  {
    "file": "tests/controlplane/cleanup-writer-barriers.test.ts",
    "suite": "native cleanup writer barrier [postgres; modeled hosted association and policy]",
    "test": "registered apply refuses a plan-file method accessor installed during its awaited admission callback",
    "backend": "postgres"
  },
  {
    "file": "tests/controlplane/cleanup-writer-barriers.test.ts",
    "suite": "native cleanup writer barrier [postgres; modeled hosted association and policy]",
    "test": "registered runner finally refuses a dispose accessor after actual apply without invoking it or replaying",
    "backend": "postgres"
  },
  {
    "file": "tests/controlplane/cleanup-writer-barriers.test.ts",
    "suite": "native cleanup writer barrier [postgres; modeled hosted association and policy]",
    "test": "registered apply refuses an init-field accessor installed during its awaited admission callback",
    "backend": "postgres"
  },
  {
    "file": "tests/controlplane/cleanup-writer-barriers.test.ts",
    "suite": "native cleanup writer barrier [postgres; modeled hosted association and policy]",
    "test": "unknown proxy producer origin refuses before any descriptor or method trap",
    "backend": "postgres"
  }
];

// Named SQL authority cases survive missing files and cannot substitute PGlite.
// Bounded final-statement ownership snapshot authority; no all-writer/preissued closure claim.
export const OWNERSHIP_SNAPSHOT_CAS_POSTGRES_REQUIREMENTS = [
  {
    "file": "tests/controlplane/ownership-transfers.test.ts",
    "suite": "ownership transfer immutable service-role custody [postgres]",
    "test": "refuses claim after a resource autoscaling fact commits during the owning operation wait",
    "postgres": true
  },
  {
    "file": "tests/controlplane/ownership-transfers.test.ts",
    "suite": "ownership transfer immutable service-role custody [postgres]",
    "test": "refuses claim after a newly inserted autoscaler commits during the owning operation wait",
    "postgres": true
  },
  {
    "file": "tests/controlplane/ownership-transfers.test.ts",
    "suite": "ownership transfer immutable service-role custody [postgres]",
    "test": "refuses a mutation grant after a new autoscaler commits through the environment coordinator",
    "postgres": true
  },
  {
    "file": "tests/controlplane/ownership-transfers.test.ts",
    "suite": "ownership transfer immutable service-role custody [postgres]",
    "test": "retains uncertain late evidence for a preissued write after current ownership changes",
    "postgres": true
  },
  {
    "file": "tests/controlplane/ownership-transfers.test.ts",
    "suite": "ownership transfer immutable service-role custody [postgres]",
    "test": "refuses a grant after a direct service-role autoscaler INSERT commits during its coordinator wait",
    "postgres": true
  },
  {
    "file": "tests/controlplane/ownership-transfers.test.ts",
    "suite": "ownership transfer immutable service-role custody [postgres]",
    "test": "blocks an independent owner INSERT while retaining final-statement snapshot refusal",
    "postgres": true
  },
  {
    "file": "tests/controlplane/ownership-transfers.test.ts",
    "suite": "ownership transfer immutable service-role custody [postgres]",
    "test": "admits an unchanged inventory without rounding PostgreSQL JSONB numeric facts",
    "postgres": true
  },
  {
    "file": "tests/controlplane/ownership-transfers.test.ts",
    "suite": "ownership transfer immutable service-role custody [postgres]",
    "test": "keeps unrelated workspace and environment ownership inventories outside grant admission",
    "postgres": true
  },
  {
    "file": "tests/controlplane/ownership-transfers.test.ts",
    "suite": "ownership transfer immutable service-role custody [postgres]",
    "test": "refuses grant admission when its scoped resource target is missing",
    "postgres": true
  },
  {
    "file": "tests/controlplane/ownership-transfers.test.ts",
    "suite": "ownership transfer immutable service-role custody [postgres]",
    "test": "refuses grant admission when the complete ownership inventory exceeds 2000 nodes",
    "postgres": true
  }
];

export const INCIDENT_OWNERSHIP_HARDENING_POSTGRES_REQUIREMENTS = [
  ...[
    "records and replays an exact human-approved transfer without immutable-column UPDATE privileges",
    "two independent service-role replay transactions preserve the original immutable receipt",
    "foreign, differently approved and revoked replays cannot rewrite or revive the stored transfer",
  ].map(test => ({ file: "tests/controlplane/ownership-transfers.test.ts", suite: "ownership transfer immutable service-role custody [postgres]", test, postgres: true })),
  ...[
    "fresh direct migration and emitted SQL have identical incident RLS and exact grants",
    "schema20 upgrade preserves incident rows and old ledger while adding exact hardening and tenant index",
  ].map(test => ({ file: "tests/controlplane/migrations.test.ts", suite: "migrator [postgres] concurrency and fail-closed open", test, postgres: true })),
];

export const CLEANUP_WRITER_BARRIER_POSTGRES_REQUIREMENTS = [
  {
    "file": "tests/controlplane/cleanup-writer-barriers.test.ts",
    "suite": "native cleanup writer barrier [postgres; modeled hosted association and policy]",
    "test": "genuine default paired codec commits an exact scoped native hold before entering the callback",
    "backend": "postgres"
  },
  {
    "file": "tests/controlplane/cleanup-writer-barriers.test.ts",
    "suite": "native cleanup writer barrier [postgres; modeled hosted association and policy]",
    "test": "direct repository and copied DTO calls cannot create a native hold",
    "backend": "postgres"
  },
  {
    "file": "tests/controlplane/cleanup-writer-barriers.test.ts",
    "suite": "native cleanup writer barrier [postgres; modeled hosted association and policy]",
    "test": "isolated custody never issues native cleanup authority or a destructive grant",
    "backend": "postgres"
  },
  {
    "file": "tests/controlplane/cleanup-writer-barriers.test.ts",
    "suite": "native cleanup writer barrier [postgres; modeled hosted association and policy]",
    "test": "wrong authenticated bytes refuse before retaining any native hold",
    "backend": "postgres"
  },
  {
    "file": "tests/controlplane/cleanup-writer-barriers.test.ts",
    "suite": "native cleanup writer barrier [postgres; modeled hosted association and policy]",
    "test": "a copied owning SQL handle cannot originate a hold even with authentic bytes",
    "backend": "postgres"
  },
  {
    "file": "tests/controlplane/cleanup-writer-barriers.test.ts",
    "suite": "native cleanup writer barrier [postgres; modeled hosted association and policy]",
    "test": "one active authenticated held attempt reserves and inserts exactly one native owner JTI",
    "backend": "postgres"
  },
  {
    "file": "tests/controlplane/cleanup-writer-barriers.test.ts",
    "suite": "native cleanup writer barrier [postgres; modeled hosted association and policy]",
    "test": "a prior same-operation issued grant is retained as a blocker after claimed use returns ready",
    "backend": "postgres"
  },
  {
    "file": "tests/controlplane/cleanup-writer-barriers.test.ts",
    "suite": "native cleanup writer barrier [postgres; modeled hosted association and policy]",
    "test": "an earlier unconsumed mutation grant blocks callback entry while the new hold still commits",
    "backend": "postgres"
  },
  {
    "file": "tests/controlplane/cleanup-writer-barriers.test.ts",
    "suite": "native cleanup writer barrier [postgres; modeled hosted association and policy]",
    "test": "expiry or revocation of an issued grant never supplies provider nondelivery proof",
    "backend": "postgres"
  },
  {
    "file": "tests/controlplane/cleanup-writer-barriers.test.ts",
    "suite": "native cleanup writer barrier [postgres; modeled hosted association and policy]",
    "test": "a pre-epoch operation remains unknown even when terminal projections and handoffs are empty",
    "backend": "postgres"
  },
  {
    "file": "tests/controlplane/cleanup-writer-barriers.test.ts",
    "suite": "native cleanup writer barrier [postgres; modeled hosted association and policy]",
    "test": "an unknown product scope creation time cannot be inferred fresh from zero native writers",
    "backend": "postgres"
  },
  {
    "file": "tests/controlplane/cleanup-writer-barriers.test.ts",
    "suite": "native cleanup writer barrier [postgres; modeled hosted association and policy]",
    "test": "a new scoped mutation grant waits on the actual final coordinator then refuses the committed hold",
    "backend": "postgres"
  },
  {
    "file": "tests/controlplane/cleanup-writer-barriers.test.ts",
    "suite": "native cleanup writer barrier [postgres; modeled hosted association and policy]",
    "test": "scope inventory sees an independently committed grant after the real hold coordinator wait",
    "backend": "postgres"
  },
  {
    "file": "tests/controlplane/cleanup-writer-barriers.test.ts",
    "suite": "native cleanup writer barrier [postgres; modeled hosted association and policy]",
    "test": "current human demotion committed during the actual coordinator wait refuses hold insertion",
    "backend": "postgres"
  },
  {
    "file": "tests/controlplane/cleanup-writer-barriers.test.ts",
    "suite": "native cleanup writer barrier [postgres; modeled hosted association and policy]",
    "test": "fresh post-signing current human refusal never inserts or returns a bearer and retains its JTI reservation",
    "backend": "postgres"
  },
  {
    "file": "tests/controlplane/cleanup-writer-barriers.test.ts",
    "suite": "native cleanup writer barrier [postgres; modeled hosted association and policy]",
    "test": "a detached async child cannot retain the active paired issuance context after callback disposal",
    "backend": "postgres"
  },
  {
    "file": "tests/controlplane/cleanup-writer-barriers.test.ts",
    "suite": "native cleanup writer barrier [postgres; modeled hosted association and policy]",
    "test": "direct Kubernetes or Zenith-style destroy issuance refuses without any private held context",
    "backend": "postgres"
  },
  {
    "file": "tests/controlplane/cleanup-writer-barriers.test.ts",
    "suite": "native cleanup writer barrier [postgres; modeled hosted association and policy]",
    "test": "read attenuation remains available under a retained hold and does not imply write authority",
    "backend": "postgres"
  },
  {
    "file": "tests/controlplane/cleanup-writer-barriers.test.ts",
    "suite": "native cleanup writer barrier [postgres; modeled hosted association and policy]",
    "test": "an actual unrelated immutable environment scope remains writable while an unscoped writer refuses",
    "backend": "postgres"
  },
  {
    "file": "tests/controlplane/cleanup-writer-barriers.test.ts",
    "suite": "native cleanup writer barrier [postgres; modeled hosted association and policy]",
    "test": "changed promoted scope cannot hide a writer behind another environment",
    "backend": "postgres"
  },
  {
    "file": "tests/controlplane/cleanup-writer-barriers.test.ts",
    "suite": "native cleanup writer barrier [postgres; modeled hosted association and policy]",
    "test": "foreign workspace inventory never sees the owning held operation or its grants",
    "backend": "postgres"
  },
  {
    "file": "tests/controlplane/cleanup-writer-barriers.test.ts",
    "suite": "native cleanup writer barrier [postgres; modeled hosted association and policy]",
    "test": "raw native dispatch without authenticated paired origin cannot use a seeded hold as approval",
    "backend": "postgres"
  },
  {
    "file": "tests/controlplane/cleanup-writer-barriers.test.ts",
    "suite": "native cleanup writer barrier [postgres; modeled hosted association and policy]",
    "test": "held epoch and possible-delivery records cannot be cleared by native UPDATE DELETE or TRUNCATE grants",
    "backend": "postgres"
  },
  {
    "file": "tests/controlplane/cleanup-writer-barriers.test.ts",
    "suite": "native cleanup writer barrier [postgres; modeled hosted association and policy]",
    "test": "every native mutation writer family records possible delivery before any hold",
    "backend": "postgres"
  },
  {
    "file": "tests/controlplane/cleanup-writer-barriers.test.ts",
    "suite": "native cleanup writer barrier [postgres; modeled hosted association and policy]",
    "test": "a held scope refuses a new native workflow handoff before possible delivery",
    "backend": "postgres"
  },
  {
    "file": "tests/controlplane/cleanup-writer-barriers.test.ts",
    "suite": "native cleanup writer barrier [postgres; modeled hosted association and policy]",
    "test": "a held scope refuses a new native plan handoff before possible delivery",
    "backend": "postgres"
  },
  {
    "file": "tests/controlplane/cleanup-writer-barriers.test.ts",
    "suite": "native cleanup writer barrier [postgres; modeled hosted association and policy]",
    "test": "a held scope refuses a new native build handoff before possible delivery",
    "backend": "postgres"
  },
  {
    "file": "tests/controlplane/cleanup-writer-barriers.test.ts",
    "suite": "native cleanup writer barrier [postgres; modeled hosted association and policy]",
    "test": "a held scope refuses a new native runner handoff before possible delivery",
    "backend": "postgres"
  },
  {
    "file": "tests/controlplane/cleanup-writer-barriers.test.ts",
    "suite": "native cleanup writer barrier [postgres; modeled hosted association and policy]",
    "test": "a held scope refuses a new native machine handoff before possible delivery",
    "backend": "postgres"
  },
  {
    "file": "tests/controlplane/cleanup-writer-barriers.test.ts",
    "suite": "native cleanup writer barrier [postgres; modeled hosted association and policy]",
    "test": "late workflow acknowledgement and build terminal receipts remain immutable history under a diagnostic hold",
    "backend": "postgres"
  },
  {
    "file": "tests/controlplane/cleanup-writer-barriers.test.ts",
    "suite": "native cleanup writer barrier [postgres; modeled hosted association and policy]",
    "test": "queued runner and machine work cannot cross into running after a native hold commits",
    "backend": "postgres"
  },
  {
    "file": "tests/controlplane/cleanup-writer-barriers.test.ts",
    "suite": "native cleanup writer barrier [postgres; modeled hosted association and policy]",
    "test": "discarding an acknowledged hold result never authorizes another consume or destructive grant",
    "backend": "postgres"
  },
  {
    "file": "tests/controlplane/cleanup-writer-barriers.test.ts",
    "suite": "native cleanup writer barrier [postgres; modeled hosted association and policy]",
    "test": "every cleanup authority table retains exact RLS and client denial without DELETE TRUNCATE or TRIGGER rights",
    "backend": "postgres"
  },
  {
    "file": "tests/controlplane/cleanup-writer-barriers.test.ts",
    "suite": "native cleanup writer barrier [postgres; modeled hosted association and policy]",
    "test": "a workspace foreign key mismatch never reaches any possible-delivery ledger",
    "backend": "postgres"
  },
  {
    "file": "tests/controlplane/cleanup-writer-barriers.test.ts",
    "suite": "native cleanup writer barrier [postgres; modeled hosted association and policy]",
    "test": "current consumed human approver demotion during the real coordinator wait refuses hold insertion",
    "backend": "postgres"
  },
  {
    "file": "tests/controlplane/cleanup-writer-barriers.test.ts",
    "suite": "native cleanup writer barrier [postgres; modeled hosted association and policy]",
    "test": "a current human rejection committed during the actual coordinator wait refuses hold insertion",
    "backend": "postgres"
  },
  {
    "file": "tests/controlplane/cleanup-writer-barriers.test.ts",
    "suite": "native cleanup writer barrier [postgres; modeled hosted association and policy]",
    "test": "expiration during the actual coordinator wait refuses the still-owned fence and hold",
    "backend": "postgres"
  },
  {
    "file": "tests/controlplane/cleanup-writer-barriers.test.ts",
    "suite": "native cleanup writer barrier [postgres; modeled hosted association and policy]",
    "test": "requester demotion during the final native grant inventory wait refuses the bearer and retains its JTI",
    "backend": "postgres"
  },
  {
    "file": "tests/controlplane/cleanup-writer-barriers.test.ts",
    "suite": "native cleanup writer barrier [postgres; modeled hosted association and policy]",
    "test": "consumed approver demotion during the final native grant inventory wait refuses the bearer and retains its JTI",
    "backend": "postgres"
  },
  {
    "file": "tests/controlplane/cleanup-writer-barriers.test.ts",
    "suite": "native cleanup writer barrier [postgres; modeled hosted association and policy]",
    "test": "native source connection revocation during the final grant inventory wait refuses the bearer and retains its JTI",
    "backend": "postgres"
  },
  {
    "file": "tests/controlplane/cleanup-writer-barriers.test.ts",
    "suite": "native cleanup writer barrier [postgres; modeled hosted association and policy]",
    "test": "reviewed revision source replacement during the final grant inventory wait refuses the bearer and retains its JTI",
    "backend": "postgres"
  },
  {
    "file": "tests/controlplane/cleanup-writer-barriers.test.ts",
    "suite": "native cleanup writer barrier [postgres; modeled hosted association and policy]",
    "test": "current target replacement during the final grant inventory wait refuses the bearer and retains its JTI",
    "backend": "postgres"
  },
  {
    "file": "tests/controlplane/cleanup-writer-barriers.test.ts",
    "suite": "native cleanup writer barrier [postgres; modeled hosted association and policy]",
    "test": "lease expiry during the final grant inventory wait refuses the bearer and retains its JTI",
    "backend": "postgres"
  },
  {
    "file": "tests/controlplane/cleanup-writer-barriers.test.ts",
    "suite": "native cleanup writer barrier [postgres; modeled hosted association and policy]",
    "test": "unchanged current authority after the final native grant inventory wait returns exactly its one retained JTI",
    "backend": "postgres"
  },
  {
    "file": "tests/controlplane/cleanup-writer-barriers.test.ts",
    "suite": "native cleanup writer barrier [postgres; modeled hosted association and policy]",
    "test": "requester demotion during final native reservation inventory refuses before signing and preserves the hold",
    "backend": "postgres"
  },
  {
    "file": "tests/controlplane/cleanup-writer-barriers.test.ts",
    "suite": "native cleanup writer barrier [postgres; modeled hosted association and policy]",
    "test": "consumed approver demotion during final native reservation inventory refuses before signing and preserves the hold",
    "backend": "postgres"
  }
];

// These existing whole-file workflow requirements stay visible when native source is missing.
// The workflow lane still requires every discovered platform/workflow file as before.
export const WORKFLOW_NATIVE_POSTGRES_FILES = [
  "tests/platform/approved-source-runtime.test.ts",
  "tests/platform/aws-bootstrap-preflight-admission.test.ts",
  "tests/platform/composition.test.ts",
  "tests/platform/current-dispatch-requirement.test.ts",
  "tests/platform/kubernetes-vault-target.test.ts",
  "tests/platform/source-bundle-azure.test.ts",
  "tests/platform/source-bundle-composition.test.ts",
  "tests/platform/source-bundle-github.test.ts",
];

// Actual owned Temporal executions stay mandatory if their source disappears.
// Controlled maintenance activities supply no default job or catch-up evidence.
export const CRITICAL_SCHEDULE_TEMPORAL_REQUIREMENTS = [
  {
    file: "tests/workflows/critical-schedule.test.ts",
    suite: "critical maintenance schedule on an actual owned durable Temporal service",
    test: "preserves compatible schedule and queued actual workflow across server restart",
  },
  {
    file: "tests/workflows/critical-schedule.test.ts",
    suite: "critical maintenance schedule on an actual owned durable Temporal service",
    test: "skips overlap while the first genuine activity is held",
  },
];

// Existing direct PostgreSQL journal races stay mandatory independently of discovery.
export const AGENT_JOURNAL_POSTGRES_REQUIREMENTS = [
  {
    "file": "tests/agent-control-journal.test.ts",
    "suite": "postgres agent journal (live)",
    "test": "two connections racing one claim: exactly one wins, the other sees the row unchanged",
    "backend": "postgres"
  },
  {
    "file": "tests/agent-control-journal.test.ts",
    "suite": "postgres agent journal (live)",
    "test": "a lease past its end reconciles to uncertain, and is never re-dispatched",
    "backend": "postgres"
  },
  {
    "file": "tests/agent-control-journal.test.ts",
    "suite": "postgres agent journal (live)",
    "test": "a finalize with a stale fence changes zero rows",
    "backend": "postgres"
  },
  {
    "file": "tests/agent-control-journal.test.ts",
    "suite": "postgres agent journal (live)",
    "test": "an application authority that moved during dispatch refuses to finalize",
    "backend": "postgres"
  },
  {
    "file": "tests/agent-control-journal.test.ts",
    "suite": "postgres agent journal (live)",
    "test": "(workspace, subject, request_key) is unique, so prepare is idempotent in the database",
    "backend": "postgres"
  },
  {
    "file": "tests/agent-control-journal.test.ts",
    "suite": "postgres agent journal (live)",
    "test": "claims, finalizes and reads back through the same interface the file store satisfies",
    "backend": "postgres"
  },
  {
    "file": "tests/agent-control-journal.test.ts",
    "suite": "postgres agent journal (live)",
    "test": "refuses every read and write until the schema ledger is what this build needs",
    "backend": "postgres"
  },
  {
    "file": "tests/agent-control-journal-fixes.test.ts",
    "suite": "postgres agent journal: lease, un-approve and the queue (live)",
    "test": "refuses a finalize after the lease lapsed, and the row is resolved as uncertain, never as a success",
    "backend": "postgres"
  },
  {
    "file": "tests/agent-control-journal-fixes.test.ts",
    "suite": "postgres agent journal: lease, un-approve and the queue (live)",
    "test": "still finalizes while the lease holds",
    "backend": "postgres"
  },
  {
    "file": "tests/agent-control-journal-fixes.test.ts",
    "suite": "postgres agent journal: lease, un-approve and the queue (live)",
    "test": "withdraws an approval: phase, columns and document all go back, and it cannot be claimed",
    "backend": "postgres"
  },
  {
    "file": "tests/agent-control-journal-fixes.test.ts",
    "suite": "postgres agent journal: lease, un-approve and the queue (live)",
    "test": "refuses to withdraw a claimed, foreign, changed or unapproved operation, and changes nothing",
    "backend": "postgres"
  },
  {
    "file": "tests/agent-control-journal-fixes.test.ts",
    "suite": "postgres agent journal: lease, un-approve and the queue (live)",
    "test": "an un-approve racing a claim on two connections has exactly one winner, whichever gets the row first",
    "backend": "postgres"
  },
  {
    "file": "tests/agent-control-journal-fixes.test.ts",
    "suite": "postgres agent journal: lease, un-approve and the queue (live)",
    "test": "lists an uncertain operation in the review queue, read-only",
    "backend": "postgres"
  }
];

/** Recording remains opt-in; the frozen current-code corpus replays in the canonical workflow lane.
 * These literal case identities survive missing/deleted test sources and fixtures. They
 * prove current synthetic history compatibility, not histories from a prior release.
 * The dedicated workflow-history-replay lane is mandatory when fixtures exist or are committed.
 * Deleting committed fixtures cannot disable it; an explicit invocation fails on missing or partial fixtures.
 */
export const WORKFLOW_HISTORY_REPLAY_REQUIREMENTS = [
  {
    "file": "tests/workflows/history-replay.test.ts",
    "suite": "committed workflow histories: inventory and integrity",
    "test": "fixtures exist"
  },
  {
    "file": "tests/workflows/history-replay.test.ts",
    "suite": "committed workflow histories: inventory and integrity",
    "test": "every fixture is listed in MANIFEST.json with an identical hash, and nothing else is listed"
  },
  {
    "file": "tests/workflows/history-replay.test.ts",
    "suite": "committed workflow histories: inventory and integrity",
    "test": "every scenario has exactly its committed fixture, and no fixture is orphaned"
  },
  {
    "file": "tests/workflows/history-replay.test.ts",
    "suite": "committed workflow histories: inventory and integrity",
    "test": "every registered workflow type (including wave-3 codingAgentRunWorkflow, teardown review, sweep and maintenance) has a scenario and a fixture"
  },
  {
    "file": "tests/workflows/history-replay.test.ts",
    "suite": "committed workflow histories: inventory and integrity",
    "test": "each fixture's recorded history starts with the workflow type it declares"
  },
  {
    "file": "tests/workflows/history-replay.test.ts",
    "suite": "committed workflow histories: inventory and integrity",
    "test": "every active patch id has at least one committed history that carries its marker"
  },
  {
    "file": "tests/workflows/history-replay.test.ts",
    "suite": "the replay gate has teeth",
    "test": "a deploy history is rejected by a workflow that schedules its activities in a different order"
  },
  {
    "file": "tests/workflows/history-replay.test.ts",
    "suite": "the replay gate has teeth",
    "test": "a history with its activity events removed is rejected"
  },
  {
    "file": "tests/workflows/history-replay.test.ts",
    "suite": "committed workflow histories replay against the current bundle",
    "test": "coding-agent-run-step-failure.json replays deterministically"
  },
  {
    "file": "tests/workflows/history-replay.test.ts",
    "suite": "committed workflow histories replay against the current bundle",
    "test": "coding-agent-run-steps.json replays deterministically"
  },
  {
    "file": "tests/workflows/history-replay.test.ts",
    "suite": "committed workflow histories replay against the current bundle",
    "test": "critical-maintenance.json replays deterministically"
  },
  {
    "file": "tests/workflows/history-replay.test.ts",
    "suite": "committed workflow histories replay against the current bundle",
    "test": "day-two-drift-repair-ecs.json replays deterministically"
  },
  {
    "file": "tests/workflows/history-replay.test.ts",
    "suite": "committed workflow histories replay against the current bundle",
    "test": "day-two-restart.json replays deterministically"
  },
  {
    "file": "tests/workflows/history-replay.test.ts",
    "suite": "committed workflow histories replay against the current bundle",
    "test": "deploy-approval-signal.json replays deterministically"
  },
  {
    "file": "tests/workflows/history-replay.test.ts",
    "suite": "committed workflow histories replay against the current bundle",
    "test": "deploy-cancelled.json replays deterministically"
  },
  {
    "file": "tests/workflows/history-replay.test.ts",
    "suite": "committed workflow histories replay against the current bundle",
    "test": "deploy-happy-build.json replays deterministically"
  },
  {
    "file": "tests/workflows/history-replay.test.ts",
    "suite": "committed workflow histories replay against the current bundle",
    "test": "deploy-lease-lost.json replays deterministically"
  },
  {
    "file": "tests/workflows/history-replay.test.ts",
    "suite": "committed workflow histories replay against the current bundle",
    "test": "deploy-pinned-images-no-build.json replays deterministically"
  },
  {
    "file": "tests/workflows/history-replay.test.ts",
    "suite": "committed workflow histories replay against the current bundle",
    "test": "deploy-retried-read.json replays deterministically"
  },
  {
    "file": "tests/workflows/history-replay.test.ts",
    "suite": "committed workflow histories replay against the current bundle",
    "test": "deploy-started-by-client.json replays deterministically"
  },
  {
    "file": "tests/workflows/history-replay.test.ts",
    "suite": "committed workflow histories replay against the current bundle",
    "test": "destroy-happy.json replays deterministically"
  },
  {
    "file": "tests/workflows/history-replay.test.ts",
    "suite": "committed workflow histories replay against the current bundle",
    "test": "destroy-plan-changed.json replays deterministically"
  },
  {
    "file": "tests/workflows/history-replay.test.ts",
    "suite": "committed workflow histories replay against the current bundle",
    "test": "mixed-parent-all-children-succeed.json replays deterministically"
  },
  {
    "file": "tests/workflows/history-replay.test.ts",
    "suite": "committed workflow histories replay against the current bundle",
    "test": "mixed-parent-child-fails.json replays deterministically"
  },
  {
    "file": "tests/workflows/history-replay.test.ts",
    "suite": "committed workflow histories replay against the current bundle",
    "test": "reconcile-auto-repair.json replays deterministically"
  },
  {
    "file": "tests/workflows/history-replay.test.ts",
    "suite": "committed workflow histories replay against the current bundle",
    "test": "reconcile-observe-only.json replays deterministically"
  },
  {
    "file": "tests/workflows/history-replay.test.ts",
    "suite": "committed workflow histories replay against the current bundle",
    "test": "reconcile-sweep.json replays deterministically"
  },
  {
    "file": "tests/workflows/history-replay.test.ts",
    "suite": "committed workflow histories replay against the current bundle",
    "test": "remediation.json replays deterministically"
  },
  {
    "file": "tests/workflows/history-replay.test.ts",
    "suite": "committed workflow histories replay against the current bundle",
    "test": "teardown-review.json replays deterministically"
  },
  {
    "file": "tests/workflows/versioning-audit.test.ts",
    "suite": "patched()/deprecatePatch() audit",
    "test": "every patch marker in definitions/ is registered with the workflow that contains it"
  },
  {
    "file": "tests/workflows/versioning-audit.test.ts",
    "suite": "patched()/deprecatePatch() audit",
    "test": "every registry entry is still present in the code (remove it with the deprecation, not before)"
  },
  {
    "file": "tests/workflows/versioning-audit.test.ts",
    "suite": "registered workflow types",
    "test": "definitions/index.ts exports exactly the registered workflow types"
  },
  {
    "file": "tests/workflows/versioning-audit.test.ts",
    "suite": "registered workflow types",
    "test": "every registered type is startable by name from WORKFLOW_TYPES"
  },
  {
    "file": "tests/workflows/versioning-audit.test.ts",
    "suite": "registered workflow types",
    "test": "every registered type is a real exported async function in definitions/"
  }
];
export const REPLAY_OPT_IN_FILES = ["tests/workflows/history-record.test.ts"];

/** Wave 5 contract controls use local doubles/PGlite; no engine or cloud acceptance is inferred. */
export const WAVE5_CONTRACT_FILES = [
  "tests/billing/managed-tier.engine.test.ts",
  "tests/resources/function-manifest.test.ts",
  "tests/acceptance/mixed-lambda.test.ts",
  "tests/ops/recovery-health.test.ts",

  "tests/acceptance/mixed-connectivity-probe.test.ts",
  "tests/acceptance/mixed-failure-scenarios.test.ts",
  "tests/acceptance/mixed-live-recovery.test.ts",
  "tests/acceptance/mixed-live-run.test.ts",
  "tests/acceptance/mixed-traffic.test.ts",
  "tests/adversarial/approvals-forgery.test.ts",
  "tests/adversarial/build-exfiltration.test.ts",
  "tests/adversarial/cross-tenant.test.ts",
  "tests/adversarial/integration-compromise.test.ts",
  "tests/adversarial/malicious-archives.test.ts",
  "tests/adversarial/prompt-injection.test.ts",
  "tests/adversarial/residual-hardening.test.ts",
  "tests/adversarial/role-escalation.test.ts",
  "tests/adversarial/ssrf-rebinding.test.ts",
  "tests/adversarial/token-forgery.test.ts",
  "tests/audit-export/audit-export.test.ts",
  "tests/audit-export/purpose.test.ts",
  "tests/billing/billing-routes.test.ts",
  "tests/billing/billing-unit.test.ts",
  "tests/billing/billing.engine.test.ts",
  "tests/ci/release-workflow.test.ts",
  "tests/ci/vulnerability-triage.test.ts",
  "tests/connections/zenith-connection.test.ts",
  "tests/controlplane/mixed-follow-up.test.ts",
  "tests/controlplane/recovery-epoch.test.ts",
  "tests/controlplane/wave5-compat.test.ts",
  "tests/execution/mixed-orchestration-signals.test.ts",
  "tests/execution/mixed/connectivity.test.ts",
  "tests/execution/mixed/economics.test.ts",
  "tests/execution/mixed/output-reader.test.ts",
  "tests/execution/mixed/typed-delivery.test.ts",
  "tests/execution/mixed/typed-inputs-activities.test.ts",
  "tests/execution/mixed/typed-substitution.test.ts",
  "tests/execution/tenant-isolation.test.ts",
  "tests/execution/zenith-destroy-databases.test.ts",
  "tests/execution/zenith-graph-problems.test.ts",
  "tests/execution/zenith-managed-journey.test.ts",
  "tests/execution/zenith-semantics.test.ts",
  "tests/isolation/isolation-profile.test.ts",
  "tests/managed-serving/catalog.test.ts",
  "tests/managed-serving/domain-routes.test.ts",
  "tests/managed-serving/domain-store.test.ts",
  "tests/managed-serving/domains.test.ts",
  "tests/managed-serving/integration-readiness.test.ts",
  "tests/managed-serving/services-route.test.ts",
  "tests/managed-serving/serving-contract.test.ts",
  "tests/managed-serving/serving-render.test.ts",
  "tests/managed-serving/storage.test.ts",
  "tests/ops/recovery-manifest.test.ts",
  "tests/platform/managed-reconcile.test.ts",
  "tests/platform/recovery-service.test.ts",
  "tests/platform/zenith-build.test.ts",
  "tests/platform/zenith-managed-composition.test.ts",
  "tests/platform/zenith-onboarding.test.ts",
  "tests/providers/zenith/isolation-bundle.test.ts",
  "tests/providers/zenith/managed-profile.test.ts",
  "tests/providers/zenith/managed-substrate.test.ts",
  "tests/release/acceptance-scenarios.test.ts",
  "tests/release/drivers/drv1.test.ts",
  "tests/release/checkpoint.test.ts",
  "tests/release/dossier.test.ts",
  "tests/release/live-scope-coverage.test.ts",
  "tests/release/orchestrator.test.ts",
  "tests/release/scope.test.ts",
  "tests/retention/admin-routes.test.ts",
  "tests/retention/key-purpose.test.ts",
  "tests/retention/restore-destination.test.ts",
  "tests/retention/retention.test.ts",
  "tests/slo/definitions.test.ts",
  "tests/slo/restore-sink.test.ts",
  "tests/slo/sli-budget.test.ts",
  "tests/slo/slo-artifacts.test.ts",
  "tests/slo/slo.engine.test.ts",
  "tests/supply-chain/release.test.ts",
  "tests/supply-chain/sbom.test.ts"
];
export const WAVE5_EXTERNAL_FILES = [
  "tests/acceptance/mixed-lambda-package.gated.test.ts",
  "tests/acceptance/w5-gaps-ui.gated.test.ts",
  "tests/acceptance/mixed-lambda.gated.test.ts",
  "tests/isolation/managed-onboarding-readiness.test.ts",
  "tests/isolation/tenant-isolation-acceptance.test.ts",
  "tests/live/mixed-connectivity.live.test.ts",
  "tests/managed-serving/serving-kind.test.ts",
  "tests/managed-serving/storage-emulator.test.ts",
  "tests/ops/recovery-rehearsal.test.ts",
  "tests/providers/zenith/managed-kind.test.ts",
  "tests/tofu/typed-inputs.test.ts",
  "tests/tofu/typed-substitution.test.ts"
];

function committedWorkflowHistoryFiles(root) {
  if (!fs.existsSync(path.join(root, ".git"))) return [];
  const result = spawnSync("git", ["ls-tree", "-r", "--name-only", "HEAD", "--", "tests/fixtures/workflow-histories"], { cwd: root, encoding: "utf8", timeout: 10_000, stdio: ["ignore", "pipe", "ignore"] });
  if (result.status !== 0 || result.error) throw new Error("Committed replay fixture inventory unavailable; cannot disable the gate");
  return result.stdout.trim().split(/\r?\n/).filter(Boolean);
}

/**
 * Presence activates the ratchet; deleting committed histories cannot disable it.
 * @param {string} root
 * @param {(root: string) => string[]} committedInventory
 */
export function workflowHistoryReplayStatus(root = process.cwd(), committedInventory = committedWorkflowHistoryFiles) {
  const directory = path.join(root, "tests/fixtures/workflow-histories");
  const present = fs.existsSync(directory) && fs.readdirSync(directory).some(file => file.endsWith(".json"));
  const committed = committedInventory(root).some(file => /^tests\/fixtures\/workflow-histories\/[^/]+\.json$/.test(file));
  return { required: present || committed, reason: present || committed ? "Recorded fixture set present or committed; replay is mandatory and integrity/coverage must pass" : "not run (needs replay:record fixtures from the Mac Temporal verifier)" };
}

export const GATE_LANES = {
  "drv2-drift-repair": {
    files: ["tests/acceptance/drift-repair.operated.test.ts"],
    env: { ZENITH_TEST_DRV2_OPERATED: "1", ZENITH_LOCAL_TARGETS: "1", ZENITH_LOCAL_JOINED_DRIVERS: "1", ZENITH_ACCEPTANCE_DEFAULT_STACK: "1", ZENITH_DEFAULT_JOURNEY: "1" },
    report: ".data-ci-lane/drv2-drift-repair.json", tools: { node: "22.23.3" },
    prerequisites: ["Native Mac ARM64, Node22, Docker Desktop4GiB, Chromium with the J1 CA trusted, kind and kubectl", "Fresh owned lean J1 stack and J2 prepared kind fixture; driver consumes and cleans both", "Private ZENITH_LOCAL_ROOT, ZENITH_LOCAL_RUN_ID, ZENITH_ACCEPTANCE_DEFAULT_STACK_DIR and ZENITH_LOCAL_JOURNEY_CONFIG_FILE; see verify/DRV-2.md", "No live credentials or provider API; local_operated_rehearsal receipts only"],
  },
  "drv2-crash-partition": {
    files: ["tests/acceptance/crash-partition.operated.test.ts"],
    env: { ZENITH_TEST_DRV2_OPERATED: "1", ZENITH_LOCAL_TARGETS: "1", ZENITH_LOCAL_JOINED_DRIVERS: "1", ZENITH_ACCEPTANCE_DEFAULT_STACK: "1", ZENITH_DEFAULT_JOURNEY: "1" },
    report: ".data-ci-lane/drv2-crash-partition.json", tools: { node: "22.23.3" },
    prerequisites: ["Native Mac ARM64, Node22, Docker Desktop4GiB, Chromium with the J1 CA trusted, kind and kubectl", "Fresh owned lean J1 stack and J2 prepared kind fixture; driver consumes and cleans both", "Run after the drift fixture has been removed, with a new runId/root/stack/config; see verify/DRV-2.md", "No live credentials or provider API; local_operated_rehearsal receipts only"],
  },
  "j15-operated-upgrade": {
    files: ["tests/acceptance/operated-upgrade.engine.test.ts"],
    env: { ZENITH_LOCAL_OPERATED: "1", ZENITH_LOCAL_TARGETS: "1", ZENITH_LOCAL_JOINED_DRIVERS: "1", ZENITH_ACCEPTANCE_DEFAULT_STACK: "1", ZENITH_DEFAULT_JOURNEY: "1" },
    report: ".data-ci-lane/j15-operated-upgrade.json", tools: { node: "22.23.3" },
    prerequisites: ["Fresh lean J1 stack and private J2 kind configuration; native Mac ARM64 Chromium/Docker/kind/Temporal", "ZENITH_LOCAL_ROOT, ZENITH_LOCAL_RUN_ID, ZENITH_ACCEPTANCE_DEFAULT_STACK_DIR, ZENITH_LOCAL_JOURNEY_CONFIG_FILE, ZENITH_LOCAL_UPGRADE_IMAGES_FILE; see verify/DRV-3.md", "Distinct owned immutable local candidate API/worker/migration images and recorded replay histories; cleanup consumes this stack"],
  },
  "j15-operated-restore": {
    files: ["tests/acceptance/operated-restore.engine.test.ts"],
    env: { ZENITH_LOCAL_OPERATED: "1", ZENITH_LOCAL_TARGETS: "1", ZENITH_LOCAL_JOINED_DRIVERS: "1", ZENITH_ACCEPTANCE_DEFAULT_STACK: "1", ZENITH_DEFAULT_JOURNEY: "1" },
    report: ".data-ci-lane/j15-operated-restore.json", tools: { node: "22.23.3" },
    prerequisites: ["Fresh lean J1 stack and private J2 kind configuration; native Mac ARM64 Chromium/Docker/kind/Temporal", "ZENITH_LOCAL_ROOT, ZENITH_LOCAL_RUN_ID, ZENITH_ACCEPTANCE_DEFAULT_STACK_DIR, ZENITH_LOCAL_JOURNEY_CONFIG_FILE; see verify/DRV-3.md", "pg_dump/pg_restore clients matching actual J1 PostgreSQL major, Temporal CLI; cleanup consumes this stack"],
  },
  "drv1-private-source": {
    files: ["tests/acceptance/drv1-private-source.operated.test.ts"],
    env: { ZENITH_LOCAL_DRV1: "1", ZENITH_LOCAL_TARGETS: "1", ZENITH_DEFAULT_JOURNEY: "1", ZENITH_ACCEPTANCE_DEFAULT_STACK: "1" },
    report: ".data-ci-lane/drv1-private-source.json", tools: { node: "22.23.3" },
    prerequisites: ["Native Mac ARM64, Node 22, actual Chromium trusting the J1 CA, owned lean J1 and two-node J2 kind fixture", "Fresh private ZENITH_LOCAL_ROOT, ZENITH_LOCAL_RUN_ID, ZENITH_ACCEPTANCE_DEFAULT_STACK_DIR, ZENITH_LOCAL_JOURNEY_CONFIG_FILE", "Private ZENITH_LOCAL_SOURCE_BUILD_DECLARATION_FILE, ZENITH_LOCAL_SOURCE_BINARY_FILE, pinned ZENITH_LOCAL_SOURCE_REGISTRY_IMAGE; actual J6 runtime/profiles and enforcing CNI, all runtime probes must pass", "Run sequentially; no LocalStack/Pebble/stripe-mock profile alongside J1; no live credentials or provider APIs"],
  },
  "drv1-update-rollback": {
    files: ["tests/acceptance/drv1-update-rollback.operated.test.ts"],
    env: { ZENITH_LOCAL_DRV1: "1", ZENITH_LOCAL_TARGETS: "1", ZENITH_DEFAULT_JOURNEY: "1", ZENITH_ACCEPTANCE_DEFAULT_STACK: "1" },
    report: ".data-ci-lane/drv1-update-rollback.json", tools: { node: "22.23.3" },
    prerequisites: ["Native Mac ARM64, Node 22, actual Chromium trusting the J1 CA, owned lean J1 and J2 kind fixture", "Fresh private ZENITH_LOCAL_ROOT, ZENITH_LOCAL_RUN_ID, ZENITH_ACCEPTANCE_DEFAULT_STACK_DIR, ZENITH_LOCAL_JOURNEY_CONFIG_FILE", "Local pinned J2 witness image present; actual failed rollout waits for the Kubernetes progress deadline", "Run sequentially; no LocalStack/Pebble/stripe-mock profile alongside J1; no live credentials or provider APIs"],
  },
  ...Object.fromEntries(["two-tenants", "export"].map(scenario => [`drivers-d4-${scenario}`, {
    files: ["tests/release/drivers/d4.operated.test.ts"], testNamePattern: `^J15 DRV-4 actual owned operated stack ${scenario}: browser authority, independent readback and owned cleanup$`,
    env: {}, report: `.data-ci-lane/drivers-d4-${scenario}.json`, tools: { node: "22.23.3", tofu: "1.12.5" },
    prerequisites: ["ZENITH_LOCAL_DRIVER_D4=1; fresh J1 lean/J2 config in the scenario's ZENITH_LOCAL_TWO_TENANTS_CONFIG_FILE or ZENITH_LOCAL_EXPORT_CONFIG_FILE", "Native arm64 Mac, local Docker, real PostgreSQL/Temporal, one owned kind node, Mailpit, Chromium and trusted J1 CA", "Owned stack/kind cleanup transfers to this driver; prepare the fixtures sequentially (see verify/DRV-4.md)", "Native pinned J15 LocalStack image cached locally for export; no live cloud credentials or API calls",
      ...(scenario === "export" ? ["ZENITH_LOCAL_EXPORT_DATA=1 and native digest-pinned ZENITH_LOCAL_EXPORT_POSTGRES_IMAGE, ZENITH_LOCAL_EXPORT_MYSQL_IMAGE, ZENITH_LOCAL_EXPORT_MINIO_IMAGE cached locally; verified MySQL TLS, exact customer-data witnesses required (verify/PROD-LIFE-11.md)"] : [])],
  }])),
  "wave5-contract": {
    files: WAVE5_CONTRACT_FILES.filter(file => !file.startsWith("tests/adversarial/")), env: {}, report: ".data-ci-lane/wave5-contract.json",
    tools: { node: "22.23.3", go: "1.27.1" }, prerequisites: ["Node 22.23.3", "Go1.27.1 at ZENITH_TEST_GO, GOTOOLCHAIN=local for SBOM build-info", "Local PGlite/contract tests; provider protocols are modeled"],
  },
  adversarial: {
    files: ["tests/adversarial"], env: {}, report: ".data-ci-lane/adversarial.json", tools: { node: "22.23.3" },
    prerequisites: ["Node 22.23.3", "Local protocol/adversarial fixtures; real Windows ACL and Linux systemd stay in their native lanes"],
  },
  recovery: {
    files: ["tests/ops/recovery-rehearsal.test.ts"], env: { ZENITH_TEST_RECOVERY_REQUIRED: "1", ZENITH_TEST_TEMPORAL: "1" }, report: ".data-ci-lane/recovery.json",
    tools: { node: "22.23.3", postgres: "16.15", temporal: "1.9.1" },
    prerequisites: ["Owned PostgreSQL16, pg_dump/pg_restore and scratch database privileges", "Pinned Temporal CLI1.9.1 and owned local dev server", "ZENITH_TEST_PLATFORM_PG_URL and ZENITH_TEST_TEMPORAL_CLI"],
  },
  "workflow-history-replay": {
    files: ["tests/workflows/history-replay.test.ts", "tests/workflows/versioning-audit.test.ts"],
    env: { ZENITH_REPLAY_LANE: "1" }, report: ".data-ci-lane/workflow-history-replay-lane.json",
    prerequisites: ["Node 22.23.3", "Recorded and reviewed tests/fixtures/workflow-histories including MANIFEST.json; run npm run replay:record on the Mac with pinned Temporal CLI 1.9.1", "Native Temporal replay library and workflow bundler; no server needed for replay; missing, partial, tampered or nondeterministic histories fail"],
    tools: { node: "22.23.3", temporal: "1.9.1" },
  },
  postgres: {
    files: ["tests/hosted/authority/contract", "tests/scripts/migrate-hosted-to-postgres.test.ts", "tests/agent-link/pg-contract.test.ts", "tests/agent-control/pg-contract.test.ts", "tests/db/contract/workspace-sharing.test.ts", "tests/waitlist/pg-contract.test.ts", "tests/agent-control/pg-oauth-grants.test.ts", "tests/agent-control-journal.test.ts", "tests/agent-control-journal-fixes.test.ts"],
    env: { ZENITH_CONTRACT_POSTGRES: "1", ZENITH_FAST: "1", ZENITH_TEST_PG_OAUTH_GRANTS_REQUIRED: "1" }, report: ".data-ci-lane/postgres-lane.json",
    prerequisites: ["Node 22.23.3", "npm ci --ignore-scripts", "PostgreSQL 16.15 at SUPABASE_DB_URL", "Hosted, agent, membership and waitlist migrations applied with scripts/ci/apply-supabase-migrations.sh", "ZENITH_CONTRACT_POSTGRES=1 and SUPABASE_DB_URL enable all13 literal live agent journal races; serial canonical migration setup preserves existing agent1/2/3 and OAuth grants; no missing, skipped or modeled case supplies execution evidence", "ZENITH_TEST_PG_OAUTH_GRANTS_REQUIRED=1; native OAuth grant persistence requires real PostgreSQL16, canonical agent schemas1/2/3 through migration0015, positively owned disposable CREATEDB/DROP DATABASE and existing canonical CI roles; upstream OAuth identity remains modeled"],
    tools: { node: "22.23.3", postgres: "16.15" },
  },
  policy: {
    files: ["tests/policy"], env: {}, report: ".data-ci-lane/policy-lane.json",
    prerequisites: ["Node 22.23.3", "npm ci --ignore-scripts", "OPA 1.19.1 at ZENITH_OPA_BIN", "Committed policy bundle verified with policy/build.mjs --check"],
    tools: { node: "22.23.3", opa: "1.19.1" },
  },
  tofu: {
    files: ["tests/tofu", "tests/providers/aws/drivers", "tests/providers/aws/identity", "tests/providers/gcp", "tests/providers/azure", "tests/providers/oci", "tests/execution/compile-refs-providers.test.ts", "tests/execution/journey.test.ts", "tests/security/tofu-secrets.test.ts", "tests/security/tofu-runner-env.test.ts", "tests/security/tofu-workspace-injection.test.ts"],
    env: { ZENITH_TEST_TOFU_NETWORK: "1" }, report: ".data-ci-lane/tofu-lane.json",
    prerequisites: ["Node 22.23.3", "npm ci --ignore-scripts", "OpenTofu 1.12.5 at ZENITH_TOFU_BIN", "Provider registry network access and committed lockfiles", "Writable plugin cache at ZENITH_TOFU_PLUGIN_CACHE"],
    tools: { node: "22.23.3", tofu: "1.12.5" },
  },
  workflows: {
    files: ["tests/workflows", "tests/platform", "tests/security/workflow-history.test.ts", ECS_REPLICA_REPAIR_FILES.execution, ECS_REPLICA_REPAIR_FILES.ownership, "tests/execution/release.test.ts"],
    excludeFiles: ["tests/workflows/mtls-live.test.ts", CODEBUILD_POSTGRES_FILE, WORKFLOW_INTENT_TEMPORAL_FILE, ...REPLAY_OPT_IN_FILES],
    env: { ZENITH_REPLAY_LANE: "1", ZENITH_COMPOSE_TEMPORAL_MODE: "time-skipping", ZENITH_TEST_TEMPORAL_DOWNLOAD: "1", ZENITH_SEC_TEMPORAL: "1", ZENITH_TEST_TEMPORAL: "1", ZENITH_TEST_SOURCE_GITHUB: "1", ZENITH_TEST_SOURCE_REPO: "https://github.com/GODOSTROYER/zenith", ZENITH_TEST_SOURCE_REF: "37be7340536ccb68ae4bb49294e8ab3799d1f01b", ZENITH_TEST_APPROVED_SOURCE_RUNTIME_REQUIRED: "1", ZENITH_TEST_SOURCE_FIXTURE_REQUIRED: "1", ZENITH_TEST_AWS_PREFLIGHT_REQUIRED: "1", ZENITH_TEST_PLAN_PRODUCT_AUTHORITY_REQUIRED: "1", ZENITH_TEST_KUBERNETES_VAULT_TARGET_REQUIRED: "1" },
    report: ".data-ci-lane/workflows-lane.json",
    prerequisites: ["Node 22.23.3", "npm ci --ignore-scripts", "PostgreSQL 16.15: fresh separate loopback databases at ZENITH_TEST_PLATFORM_PG_URL (platform) and SUPABASE_DB_URL (Supabase)", "Canonical agent schemas1/2/3 applied and verified with scripts/agent/apply-schema.ts before scripts/ci/apply-platform-migrations.sh applies and verifies the current platform registry", "Canonical Supabase migrations and schema verification through scripts/ci/apply-supabase-migrations.sh; fixed CI roles are local stand-ins, never hosted acceptance", "ZENITH_TEST_APPROVED_SOURCE_RUNTIME_REQUIRED=1, ZENITH_TEST_SOURCE_FIXTURE_REQUIRED=1, ZENITH_TEST_AWS_PREFLIGHT_REQUIRED=1, ZENITH_TEST_PLAN_PRODUCT_AUTHORITY_REQUIRED=1 and ZENITH_TEST_KUBERNETES_VAULT_TARGET_REQUIRED=1; native platform tests cannot skip or substitute PGlite; cloud/product protocols remain explicitly modeled", "Temporal CLI 1.9.1 at ZENITH_TEST_TEMPORAL_CLI", "Local Temporal dev and time-skipping servers; SDK test-server cache or download access", "Public GitHub codeload access for the immutable source fixture", "ZENITH_TEST_TEMPORAL=1; both literal critical schedule cases require explicit pinned CLI1.9.1 and fresh owned loopback SQLite/Worker execution; no missing prerequisite, skip or model-only sibling satisfies them; default maintenance effects and missed-interval catchup remain separate"],
    tools: { node: "22.23.3", postgres: "16.15", temporal: "1.9.1" },
  },
  reconciliation: {
    files:["tests/workflows/reconcile-schedule.test.ts","tests/workers/reconcile-composition.test.ts"],
    env:{ZENITH_TEST_TEMPORAL:"1",ZENITH_TEST_TEMPORAL_DOWNLOAD:"0",ZENITH_TEST_RECONCILE_SCHEDULE:"1",ZENITH_TEST_RECONCILE_COMPOSITION:"1"},
    report:".data-ci-lane/reconciliation-lane.json",
    prerequisites:["Node 22.23.3","npm ci --ignore-scripts","PostgreSQL 16.15: fresh owned loopback database at ZENITH_TEST_PLATFORM_PG_URL","Platform migrator applied/current via scripts/ci/apply-platform-migrations.sh","Temporal CLI 1.9.1 at ZENITH_TEST_TEMPORAL_CLI; owned durable SQLite dev servers, no ambient frontend or test-server download","Committed policy/dist WASM and manifest hash checked; canonical in-process OPA loader"],
    tools:{node:"22.23.3",postgres:"16.15",temporal:"1.9.1"},
  },
  "workflow-intents": {
    files:[WORKFLOW_INTENT_SQL_FILE,WORKFLOW_INTENT_AUTHORITY_FILE,WORKFLOW_INTENT_TEMPORAL_FILE,"tests/workflows/replay.test.ts","tests/workflows/codec-replay.test.ts","tests/workflows/destroy-replay.test.ts"],
    env:{ZENITH_TEST_TEMPORAL:"1",ZENITH_TEST_TEMPORAL_DOWNLOAD:"1",ZENITH_TEST_WORKFLOW_START_REQUIRED:"1"},
    report:".data-ci-lane/workflow-intents-lane.json",
    prerequisites:["Node 22.23.3","npm ci --ignore-scripts","PostgreSQL 16.15 at ZENITH_TEST_PLATFORM_PG_URL; owned scratch CREATEDB and test-role administration","Platform migration12 registered/applied/current via scripts/ci/apply-platform-migrations.sh","Temporal CLI 1.9.1 at ZENITH_TEST_TEMPORAL_CLI; owned persistent local servers for new outbox cases; unchanged historical destroy replay also needs SDK time-skipping cache/binary or existing permitted download policy (ZENITH_TEST_TEMPORAL_DOWNLOAD=1, optional ZENITH_TEST_TEMPORAL_SERVER)","Committed policy/dist WASM and manifest hash checked; product REST/directory/policy fixtures remain explicit models"],
    tools:{node:"22.23.3",postgres:"16.15",temporal:"1.9.1"},
  },
  "platform-postgres": {
    files: ["tests/slo/slo.engine.test.ts", "tests/billing/billing.engine.test.ts", "tests/controlplane", "tests/capabilities", "tests/runners", "tests/reconcile/platform.test.ts", "tests/tofu/plan-artifact-handoff.test.ts", "tests/security/plan-artifact-secrecy.test.ts", "tests/execution/destroy-review.test.ts", "tests/execution/apply.test.ts", "tests/platform/plan-approval.test.ts", ECS_REPLICA_REPAIR_FILES.grants, CODEBUILD_POSTGRES_FILE, "tests/sources/github-store.test.ts", "tests/sources/github-webhook.test.ts", "tests/platform/approved-source-runtime.test.ts", "tests/platform/composition.test.ts", "tests/platform/source-bundle-composition.test.ts", "tests/platform/source-bundle-github.test.ts", "tests/platform/source-bundle-azure.test.ts", "tests/platform/aws-bootstrap-preflight-admission.test.ts", "tests/platform/current-dispatch-requirement.test.ts", "tests/agent-access/credential-authority-origin.test.ts", "tests/agent-access/native-oauth-origin.test.ts", "tests/controlplane/plan-artifact-oauth-authority.test.ts", "tests/platform/kubernetes-vault-target.test.ts", "tests/effects", "tests/repair/lifecycle.platform.test.ts", "tests/coding-agent/store.test.ts", "tests/agent-v3/stream-store.test.ts", "tests/ops/store.engine.test.ts", "tests/execution/mixed-run-store.test.ts"],
    env: { ZENITH_FAST: "1", ZENITH_TEST_TOFU_NETWORK: "1", ZENITH_TEST_WORKFLOW_START_REQUIRED: "1", ZENITH_TEST_DEFAULT_CURRENT_MEMBERSHIP_REQUIRED: "1", ZENITH_TEST_APPROVED_SOURCE_REQUIRED: "1", ZENITH_TEST_APPROVED_SOURCE_RUNTIME_REQUIRED: "1", ZENITH_TEST_PLAN_SOURCE_AUTHORITY_REQUIRED: "1", ZENITH_TEST_SOURCE_FIXTURE_REQUIRED: "1", ZENITH_TEST_SOURCE_PLAN_EVIDENCE_REQUIRED: "1", ZENITH_TEST_FIRST_SOURCE_LEASE_REQUIRED: "1", ZENITH_TEST_MCP_DEPLOY_ADMISSION_REQUIRED: "1", ZENITH_TEST_OPENED_HANDLE_REQUIRED: "1", ZENITH_TEST_AWS_PREFLIGHT_REQUIRED: "1", ZENITH_TEST_MCP_START_SOURCE_AUTHORITY_REQUIRED: "1", ZENITH_TEST_PLAN_PRODUCT_AUTHORITY_REQUIRED: "1", ZENITH_TEST_NATIVE_INTEGRATION_AUTHORITY_REQUIRED: "1", ZENITH_TEST_NATIVE_OAUTH_DISPATCH_REQUIRED: "1", ZENITH_TEST_MIXED_CHILD_CUSTODY_REQUIRED: "1", ZENITH_TEST_PLAN_RETENTION_REQUIRED: "1", ZENITH_TEST_KUBERNETES_VAULT_TARGET_REQUIRED: "1", ZENITH_TEST_KUBERNETES_CONNECTION_LINK_REQUIRED: "1", ZENITH_TEST_CLEANUP_WRITER_BARRIER_REQUIRED: "1", ZENITH_TEST_SAVED_PLAN_SETTLEMENT_REQUIRED: "1" }, report: ".data-ci-lane/platform-lane.json",
    prerequisites: ["ZENITH_TEST_SAVED_PLAN_SETTLEMENT_REQUIRED=1; all54 additive saved-plan settlement cases require actual owning PostgreSQL16, canonical agent roles before current platform schema41 and emitted0023, explicit owning port, pinned OpenTofu1.12.5, genuine paired codec/command/cleanup/cipher origin and independent connections; only finite generated builtin JSON/local-backend/session-free work is eligible, hosted association/policy and deliberate faults remain modeled", "ZENITH_TEST_CLEANUP_WRITER_BARRIER_REQUIRED=1; all46 actual owning PostgreSQL cleanup writer cases require canonical fixed agent roles before platform schema15, emitted0017, explicit owning port, authenticated default paired codec/current product proof, independent native connections and observed lock waits; hosted association/policy are modeled and no provider settlement is inferred", "Node 22.23.3", "npm ci --ignore-scripts", "PostgreSQL 16.15", "pg_dump and pg_restore of the same full client version and server major (optional absolute ZENITH_TEST_PG_DUMP_BIN / ZENITH_TEST_PG_RESTORE_BIN overrides)", "ZENITH_TEST_PLATFORM_PG_URL points to the real test database", "Platform migrations applied with scripts/ci/apply-platform-migrations.sh (canonical schema13 is mandatory before every plan review)", "ZENITH_TEST_APPROVED_SOURCE_REQUIRED=1; actual PostgreSQL source/custody scenarios cannot skip", "ZENITH_TEST_APPROVED_SOURCE_RUNTIME_REQUIRED=1; default owning runtime persistence requires actual PostgreSQL and canonical schema13", "ZENITH_TEST_PLAN_SOURCE_AUTHORITY_REQUIRED=1; final original-plan source admission requires actual PostgreSQL, canonical schema13 and pinned OpenTofu", "ZENITH_TEST_SOURCE_FIXTURE_REQUIRED=1; native source composition fixtures require actual PostgreSQL and canonical schema13", "ZENITH_TEST_SOURCE_PLAN_EVIDENCE_REQUIRED=1; original stage evidence authority requires actual PostgreSQL and canonical schema13", "ZENITH_TEST_FIRST_SOURCE_LEASE_REQUIRED=1; first worker lease binding requires actual PostgreSQL, canonical schema13 and independent native connections", "ZENITH_TEST_MCP_DEPLOY_ADMISSION_REQUIRED=1; durable MCP admission requires actual PostgreSQL, canonical schema13 and independent native connections; product protocols remain modeled", "ZENITH_TEST_DEFAULT_CURRENT_MEMBERSHIP_REQUIRED=1; current OAuth integration membership requires actual PostgreSQL and uncached modeled product reads", "ZENITH_TEST_OPENED_HANDLE_REQUIRED=1; opener ownership requires physical openPlatformDb PostgreSQL handles and canonical schema13", "ZENITH_TEST_AWS_PREFLIGHT_REQUIRED=1; default AWS readiness admission requires actual PostgreSQL, canonical schema13 and genuine native owners; cloud commands remain modeled", "ZENITH_TEST_MCP_START_SOURCE_AUTHORITY_REQUIRED=1; final MCP source/product/member authority requires actual PostgreSQL, canonical schema13 and independent native connections; hosted protocols remain modeled", "ZENITH_TEST_PLAN_PRODUCT_AUTHORITY_REQUIRED=1; original-plan product/current approval authority requires actual PostgreSQL, canonical platform schema13/product collections, independent native connections and pinned OpenTofu; hosted association/current roles/policy remain modeled", "ZENITH_TEST_NATIVE_INTEGRATION_AUTHORITY_REQUIRED=1; linked credential dispatch/factory origin requires actual owning PostgreSQL with explicit port, canonical platform schema13/product collections and agent linked schema1; hosted REST/scope/policy remain modeled", "ZENITH_TEST_NATIVE_OAUTH_DISPATCH_REQUIRED=1; OAuth original-plan dispatch and default journal origin require actual owning PostgreSQL16 with explicit ZENITH_TEST_PLATFORM_PG_URL port, canonical platform schema13/product collections and agent schemas1/2/3 through migration0015, independent native connections and positively owned disposable scratch databases/CI roles; hosted REST/current identity/policy and sealed fixture bytes remain modeled", "The additive linked factory preselection controls share ZENITH_TEST_NATIVE_INTEGRATION_AUTHORITY_REQUIRED=1 and actual owning PostgreSQL; all prior50 linked origin cases remain mandatory, tooling constructors supply no default origin", "Locked Supabase SDK constructor/protocol controls require exact source and suite; they supply no PostgreSQL, hosted-network or TLS-handshake proof", "OpenTofu 1.12.5 at ZENITH_TOFU_BIN", "ZENITH_TEST_TOFU_NETWORK=1", "Provider registry network access and writable plugin cache", "Canonical platform schema29 applied/current through scripts/ci/apply-platform-migrations.sh; committed Supabase bootstrap appends supabase/migrations/0021_platform_core.sql after unchanged prior migrations through0020", "ZENITH_TEST_MIXED_CHILD_CUSTODY_REQUIRED=1; native mixed custody requires actual owning PostgreSQL, canonical schema14 and independent connections; custody does not enable child execution", "ZENITH_TEST_PLAN_RETENTION_REQUIRED=1; counts-only non-destructive retention preview requires actual PostgreSQL and independent connections; synthetic storage/receipt fixtures do not prove archive or deletion", "ZENITH_TEST_KUBERNETES_VAULT_TARGET_REQUIRED=1; default target binding requires actual owning PostgreSQL and tenant-sealed FILE vault; namespace API and upstream grants remain modeled", "ZENITH_TEST_KUBERNETES_CONNECTION_LINK_REQUIRED=1; human Kubernetes linking requires actual opened PostgreSQL owners, canonical platform schema13 or newer, canonical public.members from migration0001, three independent native connections and an encrypted tenant FILE vault; hosted association, human request and namespace API are modeled, production FILE/custom/separate activation remains refused"],
    tools: { node: "22.23.3", postgres: "16.15", tofu: "1.12.5" },
  },
};

// Native Go evidence is a separate contract, never a Vitest lane. IDs are
// committed requirements, not discovered from a possibly incomplete report.
const GO_MODULE = "github.com/GODOSTROYER/zenith/go";
const OPS = `${GO_MODULE}/internal/machine/ops`;
const MACHINE = `${GO_MODULE}/internal/machine`;
/** @param {string} packageName @param {readonly string[]} names @returns {{ package: string, test: string, id: string }[]} */
const cases = (packageName, names) => names.map((test) => ({ package: packageName, test, id: `linux-guest:${packageName}:${test}` }));
const subcases = (test, names) => names.map((name) => `${test}/${name}`);
// Exact native upload observations supplement every historical write ID.
// A modeled receipt or parent pass never satisfies a missing leaf.
export const LINUX_GUEST_UPLOAD_CASES = [
  ...cases(OPS, [
    "TestUploadBinaryCreateReplaceNoopAndPurposeReceipt",
    "TestUploadExactPriorAndNativeSourceGuards",
    "TestUploadExactPriorAndNativeSourceGuards/absence-on-existing",
    "TestUploadExactPriorAndNativeSourceGuards/prior-on-absent",
    "TestUploadExactPriorAndNativeSourceGuards/wrong-prior",
    "TestUploadExactPriorAndNativeSourceGuards/source-digest",
    "TestUploadExactPriorAndNativeSourceGuards/source-symlink",
    "TestUploadExactPriorAndNativeSourceGuards/target-symlink",
    "TestUploadExactPriorAndNativeSourceGuards/target-mode",
    "TestUploadExactPriorAndNativeSourceGuards/source-budget",
    "TestUploadExactPriorAndNativeSourceGuards/backup-budget",
    "TestUploadCurrentProfileRecheckedBeforeEffectsAndCommit",
    "TestUploadCurrentProfileRecheckedBeforeEffectsAndCommit/disabled-before-run",
    "TestUploadCurrentProfileRecheckedBeforeEffectsAndCommit/removed-before-run",
    "TestUploadCurrentProfileRecheckedBeforeEffectsAndCommit/disabled-before-rename",
    "TestUploadCurrentProfileRecheckedBeforeEffectsAndCommit/removed-before-rename",
    "TestUploadCurrentProfileRecheckedBeforeEffectsAndCommit/source-swap-before-rename",
    "TestUploadCurrentProfileRecheckedBeforeEffectsAndCommit/inactive-write-source-before-rename",
    "TestUploadFaultCustodyAndNoAutomaticReplay",
    "TestUploadFaultCustodyAndNoAutomaticReplay/file_sync",
    "TestUploadFaultCustodyAndNoAutomaticReplay/backup_file_sync",
    "TestUploadFaultCustodyAndNoAutomaticReplay/intent_file_sync",
    "TestUploadFaultCustodyAndNoAutomaticReplay/backup_directory_sync",
    "TestUploadFaultCustodyAndNoAutomaticReplay/before_rename",
    "TestUploadFaultCustodyAndNoAutomaticReplay/after_rename",
    "TestUploadFaultCustodyAndNoAutomaticReplay/directory_sync",
    "TestUploadFaultCustodyAndNoAutomaticReplay/postcondition",
    "TestUploadRejectsActualAccessAndDefaultACLs",
    "TestUploadRejectsActualAccessAndDefaultACLs/target-access",
    "TestUploadRejectsActualAccessAndDefaultACLs/parent-default",
    "TestUploadCancellationBeforeEffects",
    "TestUploadAndWriteShareBackupCapacityAcrossConcurrentOperations",
    "TestUploadExactMountedParentAndMountedFileRefusal",
  ]),
  ...cases(MACHINE, [
    "TestE2ESignedUploadNativeCustodyAndGrantRefusal",
    "TestE2ESignedUploadNativeCustodyAndGrantRefusal/foreign_audience",
    "TestE2ESignedUploadNativeCustodyAndGrantRefusal/foreign_capability",
    "TestE2ESignedUploadNativeCustodyAndGrantRefusal/foreign_operation",
    "TestE2ESignedUploadNativeCustodyAndGrantRefusal/foreign_workspace",
    "TestE2ESignedUploadNativeCustodyAndGrantRefusal/missing_resource",
    "TestE2ESignedUploadNativeCustodyAndGrantRefusal/foreign_path_constraint",
    "TestE2ESignedUploadNativeCustodyAndGrantRefusal/inline_bytes",
    "TestE2ESignedUploadResultGolden",
    "TestE2ESignedUploadResultGolden/foreign_audience",
    "TestE2ESignedUploadResultGolden/foreign_capability",
    "TestE2ESignedUploadResultGolden/foreign_operation",
    "TestE2ESignedUploadResultGolden/foreign_workspace",
    "TestE2ESignedUploadResultGolden/missing_resource",
    "TestE2ESignedUploadResultGolden/foreign_path_constraint",
    "TestE2ESignedUploadResultGolden/inline_bytes",
  ]),
];
// Fixed service.configure observations use actual Linux file custody; systemctl replies remain modeled.
export const LINUX_GUEST_SERVICE_CASES = [
  ...cases(OPS, [
    "TestServiceConfigureStrictArgsAndPriorPreconditions",
    "TestServiceConfigureVersionSeparatesPurposeAndBindsAllLocalSemantics",
    "TestServiceConfigureRejectsUnsafeProfiles",
    "TestServiceConfigureDefaultsOffAndRequiresRestartAuthority",
    "TestServiceConfigureCustodyIsSeparateFromFileOperations",
    "TestServiceConfigureCreateReplaceNoopAndConvergence",
    "TestServiceConfigureReloadActionIsClosedByProfile",
    "TestServiceConfigureInactiveReloadProfileRestartsWithExactCustody",
    "TestServiceConfigureInactiveReloadProfileRefusesInexactPrior",
    "TestServiceConfigureInactiveReloadProfileRequiresRestartAuthority",
    "TestServiceConfigureUnitFailureAfterCommitIsDefiniteAndRetained",
    "TestServiceConfigureSlowStartWithinBoundSettles",
    "TestServiceConfigureCancellationDuringActionIsUncertain",
    "TestServiceConfigureGuardsRefuseWithoutAnyServiceEffect",
    "TestServiceConfigureAdmissionIsExactAndUsesExistingRestartAuthority",
    "TestServiceConfigureUnloadedUnitRefusesBeforeAnyFileOrServiceEffect",
  ]),
  ...cases(MACHINE, [
    "TestServiceConfigureConfigLoadingAndVersionsCLI",
    "TestServiceConfigureVerifyRequiresResourceGrantAndRefusesForeignConstraints",
    "TestServiceConfigureDefaultsOffNotAdvertisedAndRefused",
    "TestServiceConfigureAuditCompletionFailureIsUncertainAndWireIsMetadataOnly",
  ]),
  ...cases(OPS, [
    "TestServiceConfigureInactiveReloadProfileRestartsWithExactCustody/create",
    "TestServiceConfigureInactiveReloadProfileRestartsWithExactCustody/replace",
    "TestServiceConfigureInactiveReloadProfileRefusesInexactPrior/prior-on-absent",
    "TestServiceConfigureInactiveReloadProfileRefusesInexactPrior/absence-on-existing",
    "TestResultGoldens/service.configure-filesystem",
  ]),
];
export const LINUX_GUEST_RUNNER_UPDATE_CASES = cases(`${GO_MODULE}/internal/runner/update`, [
  "TestDirectiveRefusesWrongAuthorityAndBindings",
  "TestHoldPersistsAndRevisionsCannotBeReplayed",
  "TestCorruptionAndPersistenceFailureDoNotGrantAuthority",
  "TestFreshnessIsRequiredAfterRestartAndExpiry",
  "TestStageRequiresExactRequestedEnvelopeAndIndependentReleaseSignature",
  "TestDisabledLocalUpdatesCannotBeEnabledRemotely",
]);
export const LINUX_GUEST_CASES = [
  ...cases(OPS, [
    "TestWriteCreateReplaceNoop", "TestWriteStrictArgsAndConstraints", "TestWriteDisabledAndInvalidProfiles",
    "TestImmutableProfileVersionCanonicalContract", "TestFileWriteDefaultsDisabled",
    "TestWriteSymlinkFIFODeviceMountAndOwnership", "TestWriteConcurrentWritersAndDirectorySwapStress",
    "TestWriteExactMountAnchorsAndEscapes", "TestWriteBackupByteBudgetRetainsSparseCustody",
    ...subcases("TestWritePriorVersionSourceAndCapacityRefusal", ["prior", "create-only", "version", "source", "capacity", "private-store", "target-mode", "target-hardlink", "source-hardlink", "source-symlink", "parent-mode"]),
    ...subcases("TestWriteSymlinkFIFODeviceMountAndOwnership", ["symlink", "parent-symlink", "fifo"]),
    ...subcases("TestWriteFaultAndCancelPhases", ["file_sync", "prepared", "backup_file_sync", "intent_file_sync", "backup_directory_sync", "backup", "before_rename", "after_rename", "before_directory_sync", "directory_sync", "postcondition"].flatMap((phase) => [phase + "false", phase + "true"])),
    ...subcases("TestWriteIndependentPostconditionAndTargetSwap", ["before_rename", "postcondition", "noop"]),
    ...subcases("TestWriteCrashCustodyAndRestart", ["file_sync", "prepared", "backup", "after_rename", "before_directory_sync", "directory_sync"]),
    ...subcases("TestWriteModeBoundsBackupExhaustionAndSourceSwap", ["fixed0640", "bounded-source", "retained-capacity", "source-swapped-before-commit"]),
    ...subcases("TestWriteImmutableVersionCannotBeReused", ["pinned-bytes", "mode", "path", "ref", "source", "byte-bound", "backup-dir", "backup-bytes", "backup-count"]),
    ...subcases("TestWriteRejectsActualAccessAndDefaultACLs", ["target-access", "parent-default"]),
    "TestResultGoldens/file.write-filesystem",
  ]),
  ...cases(MACHINE, ["TestLocalTemplateConfigDefaultAndValidation", "TestFileWriteVersionsCLIUsesMetadataOnlyAndLoadingEnforcesVersion", "TestWriteWirePreservesUncertainCustodyWithoutOutput", "TestWriteAuditCompletionFailureIsUncertain"]),
  ...LINUX_GUEST_UPLOAD_CASES,
  ...LINUX_GUEST_SERVICE_CASES,
  ...LINUX_GUEST_RUNNER_UPDATE_CASES,
];
// Mandatory root-phase routing, never an optional skip or imported receipt.
export const LINUX_GUEST_PACKAGE_CASES = cases(MACHINE, [
  "TestPackageHelperNativeNoFollowAndCustody",
  "TestPackageFrontendLockIndependentProcess",
  "TestPackageNativeSignedFirstInstallAndNonReplay",
  "TestPackageNativeDeclaredMountAndACLRefusals",
]);
export const LINUX_GUEST_PACKAGE_PATTERN = "^(TestPackageHelperNativeNoFollowAndCustody|TestPackageFrontendLockIndependentProcess|TestPackageNativeSignedFirstInstallAndNonReplay|TestPackageNativeDeclaredMountAndACLRefusals)$";
export const LINUX_GUEST_PACKAGE_COMMAND = ["python3", "scripts/ci/guest-package-fixtures.py", "--root", "{sourceRoot}", "--attempt", "{attemptId}", "--arch", "{nativeArch}"];
export const LINUX_GUEST_PID1_CASES = cases(`${GO_MODULE}/internal/runner/update`, ["TestSystemdSignedUpdateAndRollback"]);
// This exact exclusion is valid only with the mandatory fresh owned-PID1 phase below.
export const LINUX_GUEST_RACE_EXCLUSION = LINUX_GUEST_PACKAGE_PATTERN.slice(0, -2) + "|TestSystemdSignedUpdateAndRollback)$";
export const LINUX_GUEST_PID1_COMMAND = ["python3", "-B", "scripts/ci/guest-pid1-fixtures.py", "--root", "{sourceRoot}", "--attempt", "{attemptId}", "--arch", "{nativeArch}"];
export const LINUX_GUEST_PACKAGES = ["internal/agent", "internal/agent/spool", "internal/agent/update", "internal/awsauth", "internal/machine", "internal/machine/ops", "internal/miniyaml", "internal/netguard", "internal/oci", "internal/protocol", "internal/redact", "internal/release", "internal/runner", "internal/runner/kinds", "internal/runner/update"].map((name) => `${GO_MODULE}/${name}`);
export const LINUX_GUEST_NO_TEST_PACKAGES = ["cmd/zenith-release", "cmd/zenith-runner", "cmd/zenithd", "internal/agent/fakecp", "internal/proc", "internal/protocol/protocoltest", "internal/version"].map((name) => `${GO_MODULE}/${name}`);
export const LINUX_GUEST_ALLOWED_SKIPS = [
  { package: OPS, test: "TestRealSystemctlAndJournalctl", reason: "Separately opted-in actual systemd acceptance; this gate starts no services." },
  ...cases(`${GO_MODULE}/internal/runner/kinds`, ["TestRealOpenTofuPlanShowApply", "TestRealOpenTofuWithProviderAndLockfile"]).map(({ package: packageName, test }) => ({ package: packageName, test, reason: "The existing dedicated OpenTofu workflow gate retains actual binary/provider evidence." })),
];
// This is executed package evidence, never a Vitest report or a test-count waiver.
export const PACKAGED_WORKER_PLATFORMS = ["linux/amd64", "linux/arm64"];
export const PACKAGED_WORKER_CHECKS = [
  "native-architecture", "fresh-source-image", "actual-entrypoint", "private-tls-custody",
  "temporal-mtls-positive-and-negative", "owned-namespace", "startup-refusals",
  "readiness-and-liveness", "owned-reconcile-schedule", "permitted-read-operation",
  "packaged-assets-and-plan-retention", "sql-prerequisite-outage-and-recovery",
  "store-outage-and-recovery", "temporal-outage-and-recovery", "durable-temporal-restart",
  "operator-pause-and-resume", "actual-inflight-drain-and-fresh-worker", "idle-drain",
  "private-files-and-owned-services-cleanup", "owned-builder-cache-cleanup", "owned-context-cleanup", "baseline-preserved",
];
/** @param {string | null} [platform] */
export function packagedWorkerManifest(platform = null) {
  if (platform !== null && !PACKAGED_WORKER_PLATFORMS.includes(platform)) throw new Error("Unsupported packaged-worker platform");
  return {
    schemaVersion: 1, lane: "packaged-worker", kind: "native-packaged-worker",
    files: ["scripts/acceptance/packaged-worker.mjs", "scripts/ci/packaged-worker-native.mjs"],
    excludeFiles: [], requirements: [], externalAcceptance: [], steps: [],
    env: { ZENITH_PACKAGED_WORKER_ACCEPTANCE: "1" }, tools: { node: "22.23.3" },
    platforms: PACKAGED_WORKER_PLATFORMS, requiredChecks: PACKAGED_WORKER_CHECKS,
    report: "{outside-source-evidence}/sanitized.json",
    command: ["node", "scripts/ci/packaged-worker-native.mjs", "--run", "--platform", platform ?? "{linux/amd64|linux/arm64}", "--evidence", "{outside-source-evidence}/sanitized.json"],
    prerequisites: [
      "Native Linux Node 22.23.3 and local unix-socket Docker server matching the requested platform; emulated:false",
      "Measured free disk >=18 GiB on source, temporary and Docker-root filesystems; total host/Docker RAM >=12 GiB and available host RAM >=8 GiB",
      "Explicit ZENITH_PACKAGED_WORKER_ACCEPTANCE=1; clean exact committed source; Docker/buildx, Git and OpenSSL 3 tools",
      "New named owned local Docker context on the verified Unix socket, scoped DOCKER_CONTEXT and exact native context cleanup; original selection preserved",
      "New uniquely owned docker-container BuildKit builder with pinned image and memory=4g; original baseline remains intact",
      "CI uses only standard public ubuntu-24.04 and ubuntu-24.04-arm runners; private/internal or unrecognized hosted context refuses",
      "Fresh harness-owned PostgreSQL/Temporal services, real frontend/internode mTLS and generated private files outside source; no account credentials",
    ],
    reportValidation: "Observed child exit zero, one complete source-bound harness result, every fixed executed check passed, native architecture and independently verified owned cleanup; missing/failed/skipped/unknown results fail. Raw streams and private files never enter uploads.",
    limitations: [
      "The permitted operation is a signed read grant with an expected missing-target refusal; cloud mutation, human browser approval and consumed write-grant recovery are unverified.",
      "Disposable Temporal mTLS proves certificate authentication, not production namespace authorization, Temporal Cloud or HA.",
      "A source fixture is not native runtime proof; both architecture jobs and their exact sanitized artifacts must actually complete.",
      "Source is measured before/after the fresh image build, not an immutable context snapshot. Hosted capacity is checked, never enlarged or silently skipped.",
    ],
  };
}

export function linuxGuestManifest() {
  return {
    schemaVersion: 1, lane: "linux-guest", kind: "native-go", files: [], excludeFiles: [], requirements: [], externalAcceptance: [], report: ".data-ci-guest/attempt-{attemptId}/sanitized.json",
    artifactSelection: "Fresh wrapper attempt ID, exact runner outputs, sanitized digest and observed CI runner outcome must agree; missing/mismatched selection fails.",
    env: { GOTOOLCHAIN: "local", CGO_ENABLED: "1", ZENITH_FILE_WRITE_TEST_ROOT: "/opt/zenith-file-write-tests", ZENITH_FILE_WRITE_MOUNT_FIXTURES: "/opt/zenith-file-write-mounts" },
    tools: { node: "22.23.3", go: "1.27.1" },
    command: ["node", "scripts/ci/run-guest-file-write-gate.mjs", "--run"],
    steps: [
      { id: "race", command: ["go", "test", "-json", "-race", "-count=1", "./...", "-skip", LINUX_GUEST_RACE_EXCLUSION] },
      { id: "package-native", command: LINUX_GUEST_PACKAGE_COMMAND },
      { id: "pid1-native", command: LINUX_GUEST_PID1_COMMAND },
      { id: "goldens", command: ["go", "test", "-json", "-count=1", "./internal/machine/ops", "-run", "^TestResultGoldens$"] },
      { id: "golden-diff", command: ["git", "diff", "--exit-code", "--", "internal/machine/testdata/results"] },
      { id: "golden-status", command: ["git", "--no-optional-locks", "status", "--porcelain", "--", "internal/machine/testdata/results"] },
    ],
    requiredCases: [...LINUX_GUEST_CASES, ...LINUX_GUEST_PACKAGE_CASES, ...LINUX_GUEST_PID1_CASES],
    raceCases: LINUX_GUEST_CASES,
    packagePhase: {
      requiredCases: LINUX_GUEST_PACKAGE_CASES, requiredPackages: [MACHINE], noTestPackages: [], allowedSkips: [],
      env: { ZENITH_TEST_PACKAGE_INSTALL_REQUIRED: "1" },
      imageIndex: "sha256:3783cc01769c7b2b1b83a5c5ad96c815348e28ed7da68e2e3687004faa906251",
      rootBytes: 2684354560, memoryBytes: 2147483648, hostReserveBytes: 8589934592,
      scope: "Direct signed helper/native kernel and dpkg only; installed unit, default backend and full lifecycle remain separate acceptance.",
    },
    pid1Phase: {
      requiredCases: LINUX_GUEST_PID1_CASES, requiredPackages: [`${GO_MODULE}/internal/runner/update`], noTestPackages: [], allowedSkips: [],
      baseImage: "ubuntu:24.04@sha256:08571ca13e00ca07a2a84eab83a959b4242e22cceb16486a11bef1428c9e93a7",
      baseImageByArch: {
        amd64: "ubuntu:24.04@sha256:f610ab94648195aa356059f5b41d6085c9d4d903c072430cdd1af7bdb646106b",
        arm64: "ubuntu:24.04@sha256:08571ca13e00ca07a2a84eab83a959b4242e22cceb16486a11bef1428c9e93a7",
      },
      builderImage: "moby/buildkit:buildx-stable-1@sha256:cec9f139f45e93c5c69c60f8b07cfad9f43f4ef6b6a6cd917527fea5ff2e3dea",
      scope: "Actual installed signed update/rollback in fresh isolated native Linux PID1/cgroup guest; modeled control protocol, no default backend or production signing authority.",
    },
    goldenCases: cases(OPS, ["TestResultGoldens/file.write-filesystem", "TestResultGoldens/service.configure-filesystem"]),
    requiredPackages: LINUX_GUEST_PACKAGES, noTestPackages: LINUX_GUEST_NO_TEST_PACKAGES, allowedSkips: LINUX_GUEST_ALLOWED_SKIPS,
    prerequisites: ["Linux; unprivileged test UID/GID", "Node 22.23.3; Go 1.27.1; GOTOOLCHAIN=local; cgo C compiler", "Persistent ext-family, XFS or Btrfs root filesystem (no overlay/tmpfs/FUSE/network filesystem)", "/proc/self/fdinfo mount IDs; POSIX access/default ACL xattrs", "Python 3; util-linux mount/umount/flock; explicitly authorized disposable root fixture setup", "Owned exact four /opt fixture roots, including private empty /opt/zenith-file-upload-golden, and unchanged four actual bind mounts checked by guest-file-write-fixtures.sh", "Integrated frozen writer/upload source, five actual Linux-generated committed file.write goldens and authentic signed-daemon file.upload.json captured only by the root verification owner", "Every exact upload native event, including signed grant refusal/replay and actual golden comparison, is mandatory; source/model fixtures do not satisfy missing Linux evidence", "Every exact service.configure event and authentic filesystem golden comparison is mandatory; it reuses the existing unprivileged filesystem-golden root after file.write cleanup, real atomic file/intent custody with modeled systemctl replies supplies no installed-systemd or default-daemon acceptance", "Docker local Unix socket and server matching actual Linux amd64/arm64 host; Python3 and pinned native Debian12/dpkg1.21.23", "Root package phase is mandatory: fresh owned capped ext4 guest, genuine original registry/config, fixed setup-only capabilities, no host binds/emulation and no unknown Docker delivery; exact owned cleanup before phase success", "Mandatory SYS1 phase: local root-owned Docker Unix socket, pinned native Ubuntu and BuildKit images, isolated private-cgroup PID1 guest, genuine signed fixture binaries, 12 GB continuous free-disk floor plus 2 GB setup headroom and exact owned cleanup; no imported receipts or fourth allowed skip", "No active fixture users during validated cleanup"],
    reportValidation: "Strict complete Go JSON lifecycles plus observed successful exits; absent or skipped required cases fail. Raw streams remain private.",
  };
}

// Explicit tagged real-systemd evidence is separate from the native guest gate.
export function linuxSystemdManifest() {
  const phase = (id, packageName, relativePackage, parent, leaves) => ({
    id, command: ["go", "test", "-p=1", "-tags=zenith_systemd_acceptance", "-json", "-count=1", relativePackage, "-run", `^${parent}$`],
    requiredCases: [parent, ...leaves.map((leaf) => `${parent}/${leaf}`)].map((test) => ({ package: packageName, test, id: `linux-systemd:${packageName}:${test}` })),
    requiredPackages: [packageName], noTestPackages: [], allowedSkips: [],
  });
  const steps = [
    phase("ops", OPS, "./internal/machine/ops", "TestRealServiceConfigureSystemdOps", ["create-and-real-restart", "active-noop-keeps-invocation", "replace-retains-backup-and-restarts", "wrong-prior-has-no-effect", "stale-profile-has-no-effect", "foreign-unit-has-no-effect", "polkit-permits-restart-only"]),
    phase("signed", MACHINE, "./internal/machine", "TestRealServiceConfigureSystemdSignedExecutor", ["signed-create-through-default-runner", "persistent-replay-after-executor-reopen", "missing-resource-has-no-effect", "unknown-constraint-has-no-effect", "stale-profile-has-no-effect", "foreign-unit-has-no-effect"]),
  ];
  return {
    schemaVersion: 1, lane: "linux-systemd", kind: "native-go-systemd", steps,
    requiredCases: steps.flatMap((step) => step.requiredCases),
    env: { GOTOOLCHAIN: "local", CGO_ENABLED: "1", GOMAXPROCS: "2", ZENITH_TEST_SERVICE_CONFIGURE_SYSTEMD: "1", ZENITH_FILE_WRITE_TEST_ROOT: "/opt/zenith-file-write-tests" },
    tools: { node: "22.23.3", go: "1.27.1" },
    helper: "scripts/ci/service-configure-systemd-fixtures.py",
    cleanupCommand: ["sudo", "--preserve-env=GITHUB_ACTIONS,RUNNER_ENVIRONMENT,RUNNER_OS", "--", "python3", "scripts/ci/service-configure-systemd-fixtures.py", "cleanup", "{uid}", "{gid}", "{runId}"],
    report: ".data-ci-guest/systemd-attempt-{attemptId}/final.json",
    prerequisites: ["Current158 native phase passed", "Actual Linux hosted disposable runner, PID1 systemd and already-active polkit.service", "Existing nonzero UID/primary GID, zero effective/permitted/inheritable/ambient capabilities and NoNewPrivs1", "Owned inert unit plus exact restart-only polkit rule; no account or installed daemon startup", "Ops invocation first, signed invocation second, exact15 terminal events with no skips", "Settled children, positive current owned systemd cleanup, then canonical four-root cleanup and independent absence"],
    limitations: ["CP issuer is modeled. Actual unprivileged default runner, signed executor, systemd/polkit/files/replay are exercised.", "The inert unit does not consume application config. Installed daemon, browser/default API and cloud acceptance remain separate."],
  };
}

/** @param {string} root @param {string} directory @returns {string[]} */
export function testFiles(root, directory) {
  return fs.readdirSync(path.join(root, directory), { withFileTypes: true }).flatMap((entry) => {
    const relative = `${directory}/${entry.name}`;
    return entry.isDirectory() ? testFiles(root, relative) : relative.endsWith(".test.ts") ? [relative] : [];
  }).sort();
}

/** Normalize only complete backend labels; mismatched quotes never identify a backend. */
export function canonicalSuite(value) {
  return String(value)
    .replace(/^(['"])(PostgresAuthority)\1(?=\s|$)/, "$2")
    .replace(/\[\s*(?:'([^']+)'|"([^"]+)"|([a-z]+))\s*\]/gi, (_all, single, double, bare) => `[${single ?? double ?? bare}]`)
    .replace(/\((['"])(postgres|pglite)\1\)$/, "($2)")
    .replace(/\bon (['"])(postgres|pglite)\1$/, "on $2");
}

export function assertionMatches(required, assertion) {
  if (!assertion || typeof assertion.fullName !== "string") return false;
  if (required.test && assertion.title !== required.test) return false;
  const ancestors = Array.isArray(assertion.ancestorTitles) ? assertion.ancestorTitles : [];
  if (required.suite && !ancestors.some((title) => typeof title === "string" && canonicalSuite(title) === canonicalSuite(required.suite))) return false;
  if (required.ancestorSuite && !ancestors.some((title) => typeof title === "string" && canonicalSuite(title) === canonicalSuite(required.ancestorSuite))) return false;
  if (required.excludeSuites?.some((suite) => ancestors.includes(suite))) return false;
  if (!required.postgres) return true;
  // Prefer suite ancestry. A test title mentioning PostgreSQL cannot turn a
  // PGlite suite into real-engine evidence. Older reports omit the ancestry.
  const labels = ancestors.length > 0 ? ancestors : [assertion.fullName];
  return labels.some((title) => typeof title === "string" && (/\[postgres\]/.test(canonicalSuite(title)) || /(?:\(postgres\)|\bon postgres)$/.test(canonicalSuite(title))));
}

/** Stable IDs contain only trusted source paths and a digest of the owned suite. */
export function requirementId(lane, required) {
  const identity = `${required.suite ?? ""}:${required.postgres ?? false}${required.ancestorSuite !== undefined ? `:${required.ancestorSuite}` : ""}`;
  const suffix = createHash("sha256").update(identity + (required.test ? `:test:${required.test}` : "")).digest("hex").slice(0, 12);
  return `${lane}:${required.file}:${suffix}`;
}

/** @typedef {Readonly<{ file: string, suite?: string, test?: string, ancestorSuite?: string, postgres?: boolean, backend?: string, id: string, excludeSuites?: readonly string[] }>} GateRequirement */
/**
 * Backend suite identity comes from committed gate declarations, never assertions.
 * @param {string} lane
 * @param {string} root
 * @returns {GateRequirement[]}
 */
export function requirementsFor(lane, root) {
  if (lane.startsWith("wave6-")) return wave6Manifest(lane, root).requirements;
  let requirements;
  switch (lane) {
    case "drv2-drift-repair":
    case "drv2-crash-partition":
      requirements = [{ file: `tests/acceptance/${lane.slice(5)}.operated.test.ts`, suite: "DRV-2 owned operated scenarios", test: `${lane.slice(5)} produces complete local_operated_rehearsal evidence and owned cleanup` }];
      break;
    case "j15-operated-upgrade":
      requirements = [{ file: "tests/acceptance/operated-upgrade.engine.test.ts", suite: "DRV-3 operated upgrade", test: "operates upgrade with independent readback and owned cleanup" }];
      break;
    case "j15-operated-restore":
      requirements = [{ file: "tests/acceptance/operated-restore.engine.test.ts", suite: "DRV-3 operated restore", test: "operates restore with independent readback and owned cleanup" }];
      break;
    case "drv1-private-source":
      requirements = [{ file: "tests/acceptance/drv1-private-source.operated.test.ts", suite: "DRV-1 private-source operated", test: "admits an exact private snapshot through browser approval and refuses revoked execution with owned cleanup" }];
      break;
    case "drv1-update-rollback":
      requirements = [{ file: "tests/acceptance/drv1-update-rollback.operated.test.ts", suite: "DRV-1 update-rollback operated", test: "updates a compatible image, observes a real failed rollout and browser-approved rollback with owned cleanup" }];
      break;
    case "drivers-d4-two-tenants":
    case "drivers-d4-export":
      requirements = [{ file: "tests/release/drivers/d4.operated.test.ts", suite: "J15 DRV-4 actual owned operated stack", test: `${lane.slice("drivers-d4-".length)}: browser authority, independent readback and owned cleanup` }];
      break;
    case "wave5-contract":
      requirements = WAVE5_CONTRACT_FILES.filter(file => !file.startsWith("tests/adversarial/")).map(file => ({ file }));
      break;
    case "adversarial":
      requirements = testFiles(root, "tests/adversarial").map(file => ({ file }));
      break;
    case "recovery":
      requirements = ["backup", "clean-host restore", "temporal"].map(suite => ({ file: "tests/ops/recovery-rehearsal.test.ts", suite, backend: "postgres" }));
      break;
    case "workflow-history-replay":
      requirements = WORKFLOW_HISTORY_REPLAY_REQUIREMENTS;
      break;
    case "postgres":
      requirements = [
        ...testFiles(root, "tests/hosted/authority/contract").map((file) => ({ file, suite: file.endsWith("ledgers.test.ts") ? "PostgresAuthority ledgers" : "PostgresAuthority", backend: "postgres" })),
        { file: "tests/scripts/migrate-hosted-to-postgres.test.ts", suite: "migrate-hosted-to-postgres — against the real Supabase project", backend: "postgres" },
        ...[["tests/agent-link/pg-contract.test.ts", "AgentLinkPostgres"], ["tests/agent-control/pg-contract.test.ts", "AgentControlPostgres"], ["tests/db/contract/workspace-sharing.test.ts", "WorkspaceSharingPostgres"], ["tests/waitlist/pg-contract.test.ts", "WaitlistPostgres"]].map(([file, suite]) => ({ file, suite, backend: "postgres" })),
        ...OAUTH_GRANT_POSTGRES_REQUIREMENTS,
        ...AGENT_JOURNAL_POSTGRES_REQUIREMENTS,
      ];
      break;
    case "policy":
      requirements = testFiles(root, "tests/policy").map((file) => ({ file }));
      break;
    case "tofu":
      requirements = TOFU_SUITES.map(([file, suite]) => ({ file, suite }));
      // The runner binary tests must not disappear behind passing mocked tests.
      requirements.push({ file: "tests/tofu/runner.test.ts" });
      break;
    case "workflows":
      requirements = [...testFiles(root, "tests/workflows"), ...new Set([...testFiles(root, "tests/platform"), ...WORKFLOW_NATIVE_POSTGRES_FILES]), "tests/security/workflow-history.test.ts"]
        .filter((file) => !EXTERNAL_ACCEPTANCE.some((group) => group.wholeFile && group.file === file))
        .filter((file) => !Object.values(ECS_REPLICA_REPAIR_FILES).includes(file))
        .filter((file) => file !== CODEBUILD_POSTGRES_FILE && file !== WORKFLOW_INTENT_TEMPORAL_FILE)
        .filter((file) => !REPLAY_OPT_IN_FILES.includes(file) && file !== "tests/workflows/history-replay.test.ts")
        .flatMap((file) => file === "tests/platform/source-bundle.test.ts"
          ? ["source acquisition and canonical archives", "customer source bucket uploads", "GCS source upload through authorizedFetch", "live public GitHub source (opt-in network)"].map((suite) => ({ file, suite }))
          : [{ file }]);
      requirements.push(...ECS_REPLICA_REPAIR_WORKFLOW_REQUIREMENTS, ...BUILD_WORKFLOW_REQUIREMENTS, ...CRITICAL_SCHEDULE_TEMPORAL_REQUIREMENTS, ...WORKFLOW_HISTORY_REPLAY_REQUIREMENTS);
      break;
    case "reconciliation":
      requirements = RECONCILIATION_REQUIREMENTS;
      break;
    case "workflow-intents":
      requirements = WORKFLOW_INTENT_REQUIREMENTS;
      break;
    case "platform-postgres":
      requirements = ["tests/controlplane", "tests/capabilities", "tests/reconcile", "tests/effects", "tests/repair", "tests/coding-agent"].flatMap((directory) => testFiles(root, directory).filter(file => file !== "tests/controlplane/mixed-follow-up.test.ts").flatMap((file) => {
        const source = fs.readFileSync(path.join(root, file), "utf8");
        const backendSuites = [...source.matchAll(/describe\.each\((?:LANES|STORE_KINDS|lanes)\)\(\s*(["'])(.*?)\1/g)].map((match) => ({
          file, suite: match[2].replace("$name", "postgres").replace("%s", "postgres"), postgres: true,
        }));
        const postgresOnly = [...source.matchAll(/describe\.skipIf\(!PG_URL\)\(\s*(["'])(.*?)\1/g)].map((match) => ({ file, suite: match[2], backend: "postgres" }));
        return [...backendSuites, ...postgresOnly];
      }));
      requirements.push(
        {file:"tests/controlplane/mixed-follow-up.test.ts",suite:"mixed follow-up: producer outputs and ordering signals [postgres]",postgres:true},
        {file:"tests/slo/slo.engine.test.ts",suite:"service objectives [postgres]",postgres:true},
        {file:"tests/billing/billing.engine.test.ts",suite:"separable metering and billing [postgres]",postgres:true},
      );
      requirements.push({file:"tests/controlplane/migrations.test.ts",suite:"migrator [postgres] concurrency and fail-closed open",test:"schema 6 emitted hardening upgrades through the canonical migrator under a distinct owner with RLS, role isolation and immutable artifacts",postgres:true});
      // These require independent PostgreSQL handles; they are not registered as isolated PGlite skips.
      requirements.push(...[
        "publisher and reader barriers serialize visible commit, then losing fence cannot dispatch",
        "a committed dispatch CAS with lost response remains uncertain and refuses another claim",
        "source association locks both operations and loses safely to a partially decided browser round",
        "lost durable completion response refuses replay even when the commit succeeded",
        "a serialized canonical proof with 0 required humans permits exactly one live durable dispatch",
        "a serialized canonical proof with 2 required humans permits exactly one live durable dispatch",
      ].map(test=>({file:"tests/controlplane/plan-artifacts.test.ts",suite:"plan artifacts [postgres]",test,postgres:true})));
      requirements.push({file:"tests/controlplane/operations.test.ts",suite:"operations [postgres]",ancestorSuite:"claimForExecution",test:"a blocked environment fence is acquired before the operation row across independent PostgreSQL handles",postgres:true});
      // Explicit combined contract: each scenario is mandatory, with no discovery/skip fallback.
      requirements.push(...[
        "producer exits and loses its directory; another worker applies ORIGINAL bytes after a separate fresh check, then destroys",
        "fresh semantic drift refuses before dispatch and has no original/fresh fallback",
        "source/config/backend/address-map/lock/tool and operation swaps refuse before mutation",
        "tampering with the original after inspection refuses before apply and preserves uncertainty after dispatch",
        "stale original state serial refuses even when independent fresh semantic plan is unchanged, with no fallback",
        "source review completes, browser human approval is consumed, and destination destroys the associated ORIGINAL",
        "restore into a fresh PostgreSQL store with matching keys preserves the original; missing keys refuse",
        "fake cipher authority and arbitrary runner handles cannot mint production admission",
      ].map(test => ({file:"tests/tofu/plan-artifact-handoff.test.ts",suite:"authenticated original cross-worker handoff [postgres]",test,postgres:true})));
      requirements.push(...["expired approval","revoked approver role","new policy denial","expiry after authority check","expiry during role lookup"].map(mode=>({file:"tests/execution/apply.test.ts",suite:"dispatch current authority [postgres]",test:`refuses ${mode} after fresh replan and before durable dispatch`,postgres:true})));
      requirements.push(...APPLY_CURRENT_AUTHORITY_POSTGRES_REQUIREMENTS);
      requirements.push({file:"tests/platform/plan-approval.test.ts",suite:"immutable source review approval [postgres]",postgres:true});
      requirements.push({file:"tests/execution/destroy-review.test.ts",suite:"undecided teardown supersession [postgres]",postgres:true});
      requirements.push({file:"tests/security/plan-artifact-secrecy.test.ts",suite:"encrypted plan artifact secrecy [postgres]",postgres:true});
      requirements.push(...ECS_REPLICA_REPAIR_POSTGRES_SUITES.map((suite) => ({ file: ECS_REPLICA_REPAIR_FILES.grants, suite, ancestorSuite: "replica repair authority [postgres]", postgres: true })));
      requirements.push(...BOUND_BUILD_POSTGRES_CASES);
      requirements.push(...["fresh", "same-owner schema6"].map(mode => ({
        file: "tests/controlplane/migrations.test.ts", suite: "migrator [postgres] concurrency and fail-closed open",
        test: `${mode} canonical migrations keep permanent agent receipts select/insert-only`, postgres: true,
      })));
      requirements.push(...AGENT_EFFECT_POSTGRES_REQUIREMENTS);
      requirements.push(...BUILD_SOURCE_POSTGRES_REQUIREMENTS, GITHUB_WEBHOOK_POSTGRES_REQUIREMENT, ...GITHUB_WEBHOOK_POSTGRES_CASES);
      // Discovery above remains; these named cases survive source deletion.
      requirements.push(...WORKFLOW_INTENT_POSTGRES_REQUIREMENTS,...DEFAULT_CURRENT_MEMBERSHIP_REQUIREMENTS,...APPROVED_SOURCE_POSTGRES_REQUIREMENTS,...PLAN_SOURCE_AUTHORITY_POSTGRES_REQUIREMENTS,...SOURCE_FIXTURE_POSTGRES_REQUIREMENTS,...SOURCE_PLAN_EVIDENCE_POSTGRES_REQUIREMENTS,...FIRST_SOURCE_LEASE_POSTGRES_REQUIREMENTS,...MCP_DURABLE_ADMISSION_POSTGRES_REQUIREMENTS,...AWS_BOOTSTRAP_READINESS_POSTGRES_REQUIREMENTS,...MCP_START_SOURCE_AUTHORITY_POSTGRES_REQUIREMENTS,...MCP_START_SOURCE_AUTHORITY_SDK_REQUIREMENTS,...EXECUTION_LEASE_TENANT_POSTGRES_REQUIREMENTS,...PLAN_PRODUCT_AUTHORITY_POSTGRES_REQUIREMENTS,...PLAN_PRODUCT_RETAINED_WAIT_POSTGRES_REQUIREMENTS,...NATIVE_OAUTH_DISPATCH_POSTGRES_REQUIREMENTS,...NATIVE_CREDENTIAL_FACTORY_POSTGRES_REQUIREMENTS, ...MIXED_CHILD_CUSTODY_POSTGRES_REQUIREMENTS, ...MIXED_RUN_STORE_POSTGRES_REQUIREMENTS, ...PLAN_RETENTION_POSTGRES_REQUIREMENTS, ...KUBERNETES_VAULT_TARGET_POSTGRES_REQUIREMENTS, ...KUBERNETES_CONNECTION_LINK_POSTGRES_REQUIREMENTS, ...CLEANUP_WRITER_BARRIER_POSTGRES_REQUIREMENTS, ...SAVED_PLAN_SETTLEMENT_POSTGRES_REQUIREMENTS, ...INCIDENT_OWNERSHIP_HARDENING_POSTGRES_REQUIREMENTS, ...OWNERSHIP_SNAPSHOT_CAS_POSTGRES_REQUIREMENTS);
      break;
    default:
      throw new Error("Unknown CI lane");
  }
  return requirements.map((required) => ({ ...required, id: requirementId(lane, required) }));
}

/**
 * @typedef {object} GateManifest
 * @property {number} schemaVersion
 * @property {string} lane
 * @property {string[]} files
 * @property {string[]} excludeFiles
 * @property {Record<string, string>} env
 * @property {string} report
 * @property {string[]} command
 * @property {GateRequirement[]} requirements
 * @property {typeof EXTERNAL_ACCEPTANCE} externalAcceptance
 * @property {{ id: string, command: string[] }[]} steps
 * @property {Record<string, string>} tools
 * @property {string[]} prerequisites
 * @property {string} [reportValidation]
 * @property {boolean} [required]
 * @property {string} [activationReason]
 */
/** @param {string} lane @param {string} [root] @param {string} [reportPath] @returns {GateManifest} */
export function manifestFor(lane, root = process.cwd(), reportPath) {
  if (lane.startsWith("wave6-")) return wave6Manifest(lane, root, reportPath);
  if (lane === "linux-guest") return linuxGuestManifest();
  if (lane === "packaged-worker") return packagedWorkerManifest();
  if (lane === "core" || lane === "fresh") return { schemaVersion: 1, lane, files: [], excludeFiles: [], env: {}, report: "", command: [], requirements: [], externalAcceptance: [], tools: { node: "22.23.3" }, prerequisites: ["Node 22.23.3", "npm ci --ignore-scripts"], steps: lane === "fresh" ? [{ id: "install", command: ["npm", "ci", "--ignore-scripts"] }, ...CORE_CHECKS] : CORE_CHECKS, reportValidation: "Command exits establish core checks; real-engine requirements are validated by their dedicated lanes." };
  if (!Object.hasOwn(GATE_LANES, lane)) throw new Error("Unknown CI lane");
  const config = GATE_LANES[lane];
  const report = reportPath ?? config.report;
  const args = ["run", ...config.files, ...(config.excludeFiles ?? []).flatMap((file) => ["--exclude", file]), ...(config.testNamePattern ? ["--testNamePattern", config.testNamePattern] : []), "--maxWorkers=1", "--no-file-parallelism", "--reporter=default", "--reporter=json", `--outputFile.json=${report}`];
  const activation = lane === "workflow-history-replay" ? workflowHistoryReplayStatus(root) : undefined;
  return { schemaVersion: 1, lane, ...config, ...(activation ? { required: activation.required, activationReason: activation.reason } : {}), excludeFiles: config.excludeFiles ?? [], steps: [], report, command: ["node", "node_modules/vitest/vitest.mjs", ...args], requirements: requirementsFor(lane, root), externalAcceptance: lane === "workflows" ? EXTERNAL_ACCEPTANCE : [] };
}

export function main(args) {
  try {
    if (args.length > 1) throw new Error("usage");
    const result = args[0] === "external-acceptance" ? { schemaVersion: 1, groups: EXTERNAL_ACCEPTANCE.map((group) => ({ ...group, status: "unverified", command: ["node", "node_modules/vitest/vitest.mjs", "run", group.file, "--testNamePattern", group.suite.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "--maxWorkers=1"] })) } : args[0] ? manifestFor(args[0]) : { schemaVersion: 1, lanes: ["fresh", "core", ...Object.keys(GATE_LANES), ...WAVE6_LANES, "linux-guest", "packaged-worker"].map((lane) => manifestFor(lane)) };
    console.log(JSON.stringify(result, null, 2));
    return 0;
  } catch {
    console.error("usage: node scripts/ci/gate-manifest.mjs [fresh|core|postgres|policy|tofu|workflows|workflow-history-replay|reconciliation|workflow-intents|platform-postgres|wave5-contract|adversarial|recovery|linux-guest|packaged-worker|external-acceptance]");
    return 2;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = main(process.argv.slice(2));
