# PROD-LIFE-11 Backup export import and adoption

## Adopted-object decommissioning, 23 October 2026

Gap found: adoption flips the stored resource row to `managed`, but destroy reviewed the manifest graph, where the
resource is still `referenced`. The decommission gate never saw adopted nodes, and Kubernetes teardown deletes only
objects carrying Zenith's label, so an adopted object was neither refused nor deleted.

Fix (`b09ec4d8`):
- `execution/destroy.ts` takes ownership from the stored row, so the gate refuses an adopted node whose active claim is
  `manage`, before any provider call.
- For an active `manage_and_destroy` claim on a Kubernetes StatefulSet or PVC, destroy passes the exact object to
  teardown (`adopted`). An adopted StatefulSet takes the claims its `volumeClaimTemplates` created
  (`<template>-<name>-<ordinal>`). An object another Zenith environment labels as its own is never deleted. Adopted
  objects are retained while stateful data is retained; malformed identities report uncertain.

Evidence:
- Contract: `tests/providers/kubernetes/teardown.test.ts` (adopted block), `tests/execution/destroy-providers.test.ts`
  (adopted data service block); the PROD-LIFE-11 wave6 batch passed 173/0/0 on the Mac.
- Real engine: `tests/providers/kubernetes/adoption-kind.test.ts` (`wave6-63ad274188ce3c88`) on a disposable kind
  cluster: retain, dry-run plan of exactly three objects, delete, unrelated StatefulSet and claims survive, clean
  repeat. Passed on the Mac kind node and on a fresh GitHub-hosted runner (`clean-host-kind-adoption.yml`).

Still open for this requirement: tenant backup beyond data export, MinIO Linux/ARM64 runtime, MySQL DNS/TLS, and the
adopt/release journey through the product API on an operated stack.

## MinIO R11 cross-compile checkpoint, 11 October 2026

The pinned MinIO release source cross-compiled successfully on Darwin/ARM64 with Go1.24.2 for Linux/ARM64; the root command exited0 and the staged binary SHA-256 is recorded in the [sanitized evidence](../evidence/PROD-LIFE-11/2026-10-11-minio-r11-cross-compile.json). Runtime execution remains pending. The R9 historical refusal is permanent; no historical binary/run/audit adoption is claimed and the old marker remains retained. R7 proves current observed closure only. Wider backup adoption, decommissioning and MySQL DNS/TLS acceptance remain open.


## DRV-4 customer DATA operated rehearsal (8 October 2026)

The `export` J15 driver now runs LIFE-11 exports and imports through real browser
capability proposals, another enrolled admin's UI approval, and the browser-only
`start-portability` path. It seeds three known rows per tenant in separate
PostgreSQL/MySQL databases and three objects per tenant in separate MinIO buckets.
Fresh owned target containers hold empty matching databases/buckets. The driver
requires exact counts and per-row/object SHA-256 witnesses from independent host
connections, the product's verified export/restore digest binding, unchanged
source/foreign tenant content, an empty foreign target, and scoped API refusals.
It also exercises an approved nonempty-target import refusal, a foreign-workspace
export-ID import refusal, and MySQL's verified TLS hostname rejection. All checks
and owned cleanup must pass; a partial receipt cannot establish acceptance.

Fixture setup writes **only** explicit `platform.resources` descriptors for the
independently ready owned local containers. Source/target descriptors are managed;
artifact storage is referenced. Their `aws` provider field selects existing
LIFE-11 SQL/S3-compatible engines. This does not claim AWS provisioning, observation
or ownership-tag verification. No operation, approval or portability evidence row
is seeded. Runtime credentials are encrypted through `system.setSecret`; the
private worker alone gets the explicit private-network opt-in. MySQL uses the J1
CA, certificates valid for the actual Docker DNS name, and the existing DNS
transport with verified chain and hostname. There is no TLS verification bypass.

The split leg contract is `scripts/release/drivers/export-data-leg.ts`. SQL legs
derive `tenant_a`/`tenant_b` from the admin endpoint and preserve `knownData` rows;
object legs use `drv4-<runId>-data-a/b` buckets and preserve its object keys.
Fixture provisioning and `seedSource` prepare both empty target units and return independently read source
content. `readTarget` supports empty targets and source-as-target readback.
Ownership-checked cleanup attempts both endpoints even after a failure. PostgreSQL,
MySQL and object legs compose through `export-data.ts`; receipt validation is
closed over all three independent witnesses. Data fixtures are settled before
the existing independent OpenTofu/LocalStack infrastructure-export leg starts.

### Exact sequential lean-profile Mac command

Not run on the Windows builder: requires native arm64 Mac Docker, real local
PostgreSQL/Temporal, owned kind, Mailpit, Chromium, OpenSSL and trusted J1 browser
CA. Use Node22 as a disposable unprivileged verifier. No live gates or real cloud
credential variables may be set. Confirm memory headroom: SQL pairs run one at a
time with two bounded MinIO containers; up to 1 GiB additional container limits
are used beyond J1/J2. A 6 GiB Docker allocation is recommended; no measured 4 GiB
fit is claimed. The driver destroys this fresh J1/J2 fixture.

Provide approved native digest references for PostgreSQL17, MySQL8.4 and MinIO,
and J1/J2's existing build/registry/kind pins. Install prerequisites and add
`supabase.localhost`/`issuer.zenith.localhost` loopback hosts first as documented
in `PKG-04.md`, `PKG-05.md` and `tests/e2e/default/prepare.mjs`. Never use floating fixture image tags.

```bash
export PATH="$HOME/.local/sdk/node22:$PATH"
set -euo pipefail
test "$(node -p 'process.versions.node.split(".")[0]')" = 22
test "$(uname -m)" = arm64
: "${GO_BUILDER_IMAGE:?native approved digest required}"
: "${DISTROLESS_IMAGE:?native approved digest required}"
: "${KIND_NODE_IMAGE:?native approved digest required}"
: "${ZENITH_DEFAULT_STACK_REGISTRY_IMAGE:?native approved registry digest required}"
: "${ZENITH_LOCAL_EXPORT_POSTGRES_IMAGE:?native PostgreSQL17 digest required}"
: "${ZENITH_LOCAL_EXPORT_MYSQL_IMAGE:?native MySQL8.4 digest required}"
: "${ZENITH_LOCAL_EXPORT_MINIO_IMAGE:?native MinIO digest required}"
export ZENITH_ACCEPTANCE_DEFAULT_STACK=1 ZENITH_DEFAULT_JOURNEY=1
export ZENITH_LOCAL_TARGETS=1 ZENITH_LOCAL_JOINED_DRIVERS=1 ZENITH_LOCAL_DRIVER_D4=1
export ZENITH_LOCAL_EXPORT_DATA=1 ZENITH_LOCAL_RUN_ID=drv4-export

docker build -f tests/e2e/default/zenithd.Dockerfile \
  --build-arg GO_BUILDER_IMAGE="$GO_BUILDER_IMAGE" \
  --build-arg DISTROLESS_IMAGE="$DISTROLESS_IMAGE" \
  -t localhost:5000/zenith-j2-witness:drv4 .
npx --no-install playwright install chromium
for image in "$ZENITH_LOCAL_EXPORT_POSTGRES_IMAGE" "$ZENITH_LOCAL_EXPORT_MYSQL_IMAGE" "$ZENITH_LOCAL_EXPORT_MINIO_IMAGE"; do docker pull "$image"; done
LOCALSTACK_IMAGE="$(node -e 'const fs=require("node:fs"); const s=fs.readFileSync("deploy/acceptance/local-targets/compose.yml","utf8"); process.stdout.write(s.match(/image: (localstack\/localstack:[^\s]+)/)[1])')"
docker pull "$LOCALSTACK_IMAGE"

PRIVATE_PARENT="$(node -e 'process.stdout.write(require("node:fs").realpathSync(require("node:os").tmpdir()))')"
export ZENITH_LOCAL_ROOT="$(mktemp -d "$PRIVATE_PARENT/zenith-j15-$ZENITH_LOCAL_RUN_ID-XXXXXX")"
chmod 700 "$ZENITH_LOCAL_ROOT"
STACK="$ZENITH_LOCAL_ROOT/stack"
TARGETS="$ZENITH_LOCAL_ROOT/targets"
export ZENITH_ACCEPTANCE_DEFAULT_STACK_DIR="$STACK"
export ZENITH_LOCAL_JOURNEY_CONFIG_FILE="$TARGETS/journey.json"
export ZENITH_LOCAL_EXPORT_CONFIG_FILE="$ZENITH_LOCAL_JOURNEY_CONFIG_FILE"
trap 'if test -f "$STACK/state.json" && test -f "$STACK/input.json"; then node scripts/acceptance/default-stack/down.mjs "$STACK"; fi' EXIT
node scripts/acceptance/default-stack/up.mjs --profile lean --directory "$STACK"
node scripts/acceptance/default-stack/env.mjs "$STACK" "$ZENITH_LOCAL_ROOT/host.env"
while IFS='=' read -r key value; do export "$key=$value"; done < "$ZENITH_LOCAL_ROOT/host.env"

# Trust this invocation's STACK/tls/ca.crt in the disposable browser/keychain
# using J1/J2's trust procedure before Auth. Never disable TLS verification.
docker push localhost:5000/zenith-j2-witness:drv4
WITNESS_IMAGE="$(docker image inspect localhost:5000/zenith-j2-witness:drv4 --format '{{index .RepoDigests 0}}')"
node tests/e2e/default/prepare.mjs --directory "$TARGETS" --stack "$STACK" \
  --node-image "$KIND_NODE_IMAGE" --witness-image "$WITNESS_IMAGE" \
  --mailpit-url http://127.0.0.1:8025
node scripts/ci/gate-manifest.mjs drivers-d4-export
node scripts/ci/run-gate.mjs drivers-d4-export --run \
  --report "$ZENITH_LOCAL_ROOT/vitest.json" --evidence "$ZENITH_LOCAL_ROOT/gate-evidence.json"
node scripts/ci/run-gate.mjs drivers-d4-export --validate "$ZENITH_LOCAL_ROOT/vitest.json" \
  --require-execution --evidence "$ZENITH_LOCAL_ROOT/gate-evidence.json"
trap - EXIT
```

Expected: one selected required operated case passes; its receipt has 17 passed,
0 failed, 0 skipped checks and all three data witnesses. The other scenario case
is filtered, not evidence. The private receipt is
`$ZENITH_LOCAL_ROOT/export.operated-receipt.json`, labelled
`local_operated_rehearsal` and bound to this checkout's commit/content digest.
Raw SQL rows, object keys/bodies, passwords, certificates, sessions and vault refs
are absent from it. A failed cleanup prevents a pass. For a forced process/machine
failure, use the J1/J2 owned recovery runbook plus exact `io.zenith.driver=DRV4-DATA`
and `io.zenith.driver.run=<runId>` inventories; independently inspect IDs/labels
before removing only this invocation's containers. Never globally prune Docker.

To verify the scenario runner join on another fresh fixture prepared exactly
above, replace the three gate commands with:

```bash
node node_modules/tsx/dist/cli.mjs scripts/release/local-target-runner.ts run \
  --scenario export --run-id "$ZENITH_LOCAL_RUN_ID" \
  --receipt "$ZENITH_LOCAL_ROOT/scenario-receipt.json"
```

Expected exit0, the same 17/0/0 operated checks and three witnesses. Missing explicit
gates decline rather than pass. The full release orchestrator is separately
documented in [DRV-4](DRV-4.md); skipped component lanes leave its report incomplete.

A second real cloud provider remains **live-deferred**. Local PostgreSQL/MySQL/
MinIO equality and independent LocalStack apply do not establish a live multi-cloud
roundtrip. Object metadata beyond content type, versions/ACLs, users/grants and
production managed-service networking/IAM are outside these local assertions.
The older LIFE-11 build notes below are historical, not current execution proof.

Branch `prod/life-11-w2`, base 8031ce0d. Build only: nothing below was executed on the build machine except `npx tsc --noEmit -p .` (clean) and `npx eslint` on every changed and new TypeScript file (clean). Platform migration version 25.

Operator documentation: `docs/platform/PORTABILITY.md`.

## 1. What was built

### Audit of what existed
- `database.snapshot` exists as an in-provider backup (RDS, Cloud SQL, Azure, OCI); it is not an export to tenant storage, and its restore and delete siblings are refusal-only by design.
- `hosted/backup` (ZBK1 bundles, filesystem and S3 targets) is the self-hosted authority backup, not a per-data-service export; its container and target contracts were studied, not reused as a data-service path.
- `providers/zenith/export.ts` states that the managed database has no data export; `data.export` now closes that gap for managed Postgres.
- The destroy guards were `assertDeletionAllowed` (managed node, explicit `deletionPolicy`), `assertDeployDeletionApproval` and `checkDestroyApproval` (digest-bound human approval) and the provider teardown ownership annotations. None of them could tell an adopted object from a created one; nothing in production code adopted anything (`changeOwnership` was only called by tests).

### New module `src/lib/portability/` (pure plus ports, one door per concern)
- `types.ts`, `matrix.ts`: kinds, `portabilitySupport(operation, provider, kind)` with the exact refusal sentence for every unsupported pair, `supportTable()`.
- `engines/postgres.ts`: `postgres-logical-v1` over one SQL session: tables, enums, sequences (definition and value, identity), defaults, generated columns, constraints, indexes, every row as text through the column's own type; refuses views, functions, triggers, extensions, RLS, partitions, inheritance and non-enum custom types; allowlisted, single-statement DDL on import; order-independent logical digest; `readbackPostgres`.
- `engines/mysql.ts`: `mysql-cli-v1` through stock `mysqldump` and `mysql` (password in child env only), refuses routines and events, refuses a source that changed during the dump, logical digest via plain queries.
- `engines/objectstore.ts`, `engines/s3.ts`: object-for-object copy through an `ObjectStorePort`, S3 adapter (explicit credentials from one vault secret, lazy SDK), tenant artifact store scoped under one prefix.
- `artifact.ts`, `service.ts`: manifest written last, every file re-read from tenant storage and re-hashed before an export exists; `runExport`, `runImport` (verifies the artifact against the platform's recorded manifest digest, refuses a populated target, refuses cross-kind and older-major restores, readback through a fresh connection, verdict `verified` or `mismatch`).
- `adoption.ts`: strict claim schema, `claimDigest` (what the approver reviewed), field owners from the LIFE-12 registry (a contradicting claim is refused), drift baseline over IaC-owned fields, `compareToBaseline`, live-identity assertion.
- `decommission.ts`: pure ownership-safe decommission verdicts.
- `inputs.ts`: strict inputs and approver-visible details for the four capabilities.
- `connect.ts`, `net.ts`: opening Postgres, MySQL and S3 bindings, with loopback, link-local, metadata and (by default) private hosts refused, name resolution checked, TLS required unless the operator opts in.
- `start.ts`: human start path (claim plus durable start intent plus the generic day-two workflow).

### Store
- Migration 25 `src/lib/controlplane/db/migrations/0025_portability.ts` (registered in `migrations/index.ts`): `platform.portability_exports`, `platform.portability_restores` (append-only, status derived and constrained from the two digests), `platform.resource_adoptions` (one-way release, partial unique indexes: one active claim per provider object and per address; FK to the human approval). RLS on, no policies, service_role select/insert (+ update of the four release columns on adoptions). Checksum `9ae6f39475d3abb1317d44544ec0c8d6920e74f19c0b5af813339a5b41b11f20` (recompute if the SQL is edited).
- `src/lib/controlplane/db/repos/portability.ts` (namespace `portability`, in repos index and `bindRepos`).

### Wiring (every piece is called by a real caller)
- Catalog: `data.export` (high, autonomy 5), `data.import` (high, 5), `resource.adopt` (high, 6), `resource.release` (high, 6); all mutating, resource scoped. `docs/platform/CAPABILITY-MATRIX.md` and `docs/platform/operations/POLICY.md` edited by hand to match the generator (ordering: autonomy then name).
- Broker (`capabilities/broker.ts`): strict input validation and normalization in `parseRequest`; approver-visible detail lines; `reviewPortability` (matrix and ownership) after policy in `propose` and `check`.
- Worker: `execution/capability.ts` routes the four capabilities to `execution/portability.ts` before the generic managed-only check; `ExecutionDeps.portability` (`PortabilityPort`, implemented by `createPortabilityPort`, supplied in `platform/execution.ts`).
- Decommission gate `execution/decommission.ts`, called from `execution/plan.ts` (`inspectDeployDeletions`, after `assertDeletionAllowed`) and `execution/destroy.ts` (`context()`, so review, replan and apply all hit it).
- Start paths: MCP `zenith_execute_approved_operation` (`EXECUTABLE` extended) for integration proposals; `POST /api/platform/v1/operations/:id/start-portability` (browser only) for human proposals.
- Read: `GET /api/platform/v1/environments/:id/portability` via `readPortability` in `read-models.ts` (exports, restores with verdicts, adoptions with live baseline drift).

## 2. Acceptance mapping

"Supported backup/export/import/adoption and ownership-safe decommissioning pass with independently readable restored data."

- Supported matrix per provider and kind with explicit refusals: `matrix.ts`; `tests/portability/adoption-decommission.test.ts` (support matrix block), broker refusal in `tests/capabilities/portability-broker.test.ts`.
- Backup and export to tenant-owned storage: Postgres `tests/portability/postgres-engine.test.ts` (PGlite engines, real directory storage); objects `tests/portability/objectstore-engine.test.ts` (real directories behind the S3 port; S3 adapter contract test; LocalStack lane); MySQL `tests/portability/mysql-engine.test.ts` (contract); tenant-owned destination rules (object_store resource of the environment, not external, bucket identity, prefix confinement): `tests/execution/portability.test.ts`, `s3ArtifactStore` in the object-store test.
- Restore and import into a new target with independent readback: `postgres-engine.test.ts` "restores the artifact alone ... a re-opened engine reads back the same logical content" (the readback runs on a SECOND PGlite instance opened from the restored bytes), mismatch reported not papered over, never merges into a populated target, rewritten artifact and unallowlisted DDL refused; same journeys for objects and MySQL (contract).
- Independent readability of the artifact itself: manifest-last plus read-back verification (`verifyArtifact`), plain SQL, rows and object bodies with `RESTORE.md` (asserted in `postgres-engine.test.ts` and `objectstore-engine.test.ts`).
- Verified records in the platform: `tests/portability/store.test.ts` (idempotent per operation, derived status, tenant scoping, append-only, exports and restores).
- Adoption with explicit ownership claim, LIFE-12 registry and drift baseline: `adoption-decommission.test.ts` (claim digest, registry contradiction, baseline, drift, live identity), `tests/execution/portability.test.ts` (resource.adopt success and refusals: no approval, wrong identity, missing or simulated read, managed resource, no store), `store.test.ts` (human approval bound to the exact operation, atomic referenced to managed, one active claim per object), `readPortability` for live drift.
- Ownership-safe decommissioning requiring human destructive approval: `adoption-decommission.test.ts` (gate verdicts), `tests/execution/portability.test.ts` (teardown and plan deletions refuse an adopted object whose claim did not allow destruction, a released claim, an alias), `resource.release` (store and worker). Human destructive approval itself is the existing digest-bound approval (`checkDestroyApproval`, `assertDeployDeletionApproval`), unchanged and still required.

## 3. Verification commands (other machine)

Node 22. Platform database lanes use PGlite by default.

- `npx vitest run tests/portability tests/execution/portability.test.ts tests/capabilities/portability-broker.test.ts` expect all pass (the env-gated lanes below skip).
- `npx vitest run tests/controlplane/tenancy.test.ts tests/security/controlplane-sql-scoping.test.ts tests/capabilities tests/execution tests/policy tests/security/policy-invariants.test.ts tests/docs tests/ownership` expect unchanged results plus the new classifications.
- Real engine lanes (not run here):
  - `ZENITH_TEST_PLATFORM_PG_URL=postgres://... npx vitest run tests/portability/store.test.ts tests/capabilities/portability-broker.test.ts tests/controlplane/tenancy.test.ts`
  - `ZENITH_TEST_POSTGRES_URL=postgres://... npx vitest run tests/portability/postgres-engine.test.ts` (an empty scratch server where the role may `create database`; uses the production connector `openPostgres` over the network)
  - `ZENITH_TEST_S3_ENDPOINT=http://127.0.0.1:4566 ZENITH_PORTABILITY_ALLOW_PRIVATE_HOSTS=1 npx vitest run tests/portability/objectstore-engine.test.ts` (LocalStack or any S3-compatible endpoint; credentials from `AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY`)
  - `ZENITH_TEST_MYSQL_URL=mysql://... npx vitest run tests/portability/mysql-engine.test.ts` (needs `mysql` and `mysqldump` on PATH and an empty scratch database)
- `npx tsx scripts/docs/capability-matrix.ts --check` expect up to date (the matrix was edited by hand; regenerate if it differs).
- `npx tsc --noEmit -p .` expect clean.

## 4. Known gaps, things that may break first, shared-file updates

Honest limits:
- No test was run on the build machine. Highest risk if something fails: the PGlite journeys in `postgres-engine.test.ts` (catalog SQL, `dumpDataDir`/`loadDataDir` re-open), then the policy-driven approvals in `store.test.ts` and `portability-broker.test.ts` (they assume a high-risk proposal in the production environment awaits one human approval by an admin).
- MySQL is contract-level only: the CLI integration is tested against a scripted client, never a server.
- Live providers are unverified: connecting to RDS, Cloud SQL, Azure, OCI, Neon and S3-compatible endpoints is exercised only through the generic Postgres, MySQL and S3 clients; managed-service specifics (TLS CA chains, IAM database auth, VPC reachability) are the operator's to provide. TLS defaults to `require` (encrypted, unverified) unless the connection URI asks for `verify-full`.
- Kubernetes PVC and other volumes: no data mover exists, so export and import are refused with an explicit reason; adoption, release and decommission rules apply.
- The artifact is not encrypted by Zenith (readable without Zenith by design); confidentiality is the destination bucket's.
- Exports are held in memory (128 MiB and 2,000,000 rows for a database, 5,000 objects, 64 MiB each); larger sources are refused, not truncated.
- The "ownership proof" for a resource Zenith created is the existing rule (a managed node in the graph and the tofu state). Provider-side tag proof was NOT added to the destroy path because several providers sanitize or hash labels and it would refuse legitimate teardowns; the new gate refuses on adoption facts (positive evidence an object was NOT created by Zenith). Adoption does not write tags to the provider.
- No UI page; REST, MCP and the read route are the surfaces. `resource.release` flips the stored ownership only: a manifest that still declares the node `managed` will conflict on the next apply until it is edited.
- DNS rebinding between the host check and the connection is not closed (the Postgres and S3 clients do not expose connecting to a vetted address).
- Saved-plan settlement, plan-artifact and cleanup-writer-barrier code were not modified; the only calls into the deploy and destroy paths are the one-line gate calls in `execution/plan.ts` and `execution/destroy.ts`.

New tables and store functions (tenancy classification, already added to `tests/controlplane/tenancy.test.ts`):
- Tables: `platform.portability_exports`, `platform.portability_restores`, `platform.resource_adoptions`.
- SWEPT reads (foreign-workspace attempts added): `portability.getExport`, `.listExports`, `.listRestores`, `.getAdoption`, `.listAdoptions`, `.adoptionFacts`.
- WRITES (workspace-bound; foreign refusals tested in `tests/portability/store.test.ts`): `portability.recordExport`, `.recordRestore`, `.adopt`, `.release`.
- `tests/security/controlplane-sql-scoping.test.ts` is static discovery: every query in `repos/portability.ts` filters `workspace_id`.

Shared files the orchestrator must update (not touched here):
- `supabase/migrations/*`, `emit.ts` hardening block, `scripts/ci/apply-supabase-migrations.sh`, `docs/platform/operations/DEPLOYING.md` (count, highest version, row 25, aggregate), `tests/controlplane/migrations.test.ts` (version 25, name `portability`, checksum above). Migration numbers 21 to 24 belong to other workers: `PLATFORM_MIGRATIONS` here jumps from 20 to 25 until they merge.
- `scripts/ci/gate-manifest.mjs` and `.github/workflows/*`: new suites `tests/portability/store.test.ts` and `tests/capabilities/portability-broker.test.ts` (platform-postgres lane when `ZENITH_TEST_PLATFORM_PG_URL` is set), and the env-gated real-engine suites listed above.
- `docs/LIMITATIONS.md`, `PROGRESS.md`, `ledger.json`: backup, export, import and adoption now exist for managed Postgres, MySQL and S3-compatible object storage; PVC data export remains unsupported; MySQL and all live providers remain unverified.

## 5. Suggested ledger implementationStatus

`export_import_readback_postgres_objects_verified_local_engine_mysql_contract_only_adoption_claim_baseline_and_adopted_destroy_gate_built_unverified_pvc_data_movement_unsupported_live_providers_unverified`
