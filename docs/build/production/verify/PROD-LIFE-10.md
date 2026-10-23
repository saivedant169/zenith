# PROD-LIFE-10 Release and data migration safety: verification notes

Built only; nothing here was executed (typecheck and eslint on the changed files only). Another machine runs every test below.

## 1. What was built

Audit first. Existing release code: `src/lib/execution/release.ts` (buildArtifacts, deployWorkloads, runMigrations over `BuildPort` / `WorkloadsPort` / `MigrationsPort`), the provider adapters (`src/lib/platform/release*.ts`, `src/lib/providers/*/release/*`), the deploy workflow (`workflows/definitions/deploy.ts`: build, deploy, migrate, verify), `deploy.rollback` / `deploy.promote` (a rollback is a normal `deployment.rollback` deployment of an older saved revision), and the separate hosted-app release code (`src/lib/hosted/release`, which already refuses a rollback across a schema change). Gaps found: nothing bound a release to its digest; a rollback re-built from source and RE-RAN the older manifest's `release.migrate`; a migration's class was never considered (any argv ran after the single deploy approval); there was no canary; nothing read back what the provider serves after cutover.

New, additive:

- `src/lib/release-safety/` (pure library plus service): `types.ts`, `state.ts` (release state machine), `classify.ts` (expand / data / contract / unclassified classifier for declared class and SQL, binding digest), `rollout.ts` (progressive plan validation, explicit provider refusal reasons), `provenance.ts` (the interface LIFE-09 plugs into, `registerProvenanceVerifier`), `service.ts` (`ReleaseSafetyService`: begin / approveMigration / beginMigration / markDeployed / markMigrated / markReady / markCutOver / recordReadback / rollbackSafety / lastServedForRevision), `store.ts`, `memory-store.ts`, `index.ts`.
- `src/lib/controlplane/db/migrations/0023_release_pipelines.ts` (version 23, registered in `migrations/index.ts`) and `src/lib/controlplane/db/repos/release-pipelines.ts` (`createPlatformReleaseStore`, not added to `repos/index.ts`, like the runbook store).
- `src/lib/platform/release-safety.ts`: composition (`createPlatformReleaseSafety`, Zenith build-record verifier, `ZENITH_RELEASE_MIN_PROVENANCE`), wired into `composeExecutionActivities` as `deps.releaseSafety`.
- `src/lib/execution/release-safety.ts` and edits to `src/lib/execution/release.ts`: the pipeline in the real deploy activities (see below). `ports.ts` gains optional `WorkloadsPort.readServing` and `WorkloadsPort.progressive` (`ProgressiveWorkloadsPort`) and `ExecutionDeps.releaseSafety`.
- Provider adapters: `src/lib/providers/gcp/release/traffic.ts` (Cloud Run weighted traffic, abort, serving-digest read), `src/lib/providers/kubernetes/release/workloads.ts` (`readServing`), `src/lib/platform/release.ts` + `release-gcp.ts` (dispatch; adapters without a capability report it plainly).
- Manifest (additive, optional): `release.migrate.class` (`expand|data|contract`) and `release.rollout` (`strategy`, `steps`, `bakeSec`) in `src/lib/resources/manifest-v2.ts`.
- REST: `GET /api/platform/v1/releases`, `GET /api/platform/v1/releases/:id` (viewer, bearer-capable) and `POST /api/platform/v1/releases/:id/approve-migration` (admin, browser-only), classified in `_lib/bearer-paths.ts`; `tests/middleware/platform-bearer.test.ts` inventory count changed 48 to 51.

### How the pipeline runs (workflow route)

`deployWorkloads` (before ANY rollout effect, for every service): bind each image digest to a release run, verify provenance, refuse an unsupported progressive rollout, refuse an unsafe code rollback, and stop at a migration that has no independent human approval. Then roll out: rolling replace (`deployImage` + `waitSteady`) or, for `progressive`, stage the candidate with traffic held and shift canary percentages with a bake. `runMigrations` (same activity position as before): consume the approval and run the one-off task (never for a rollback), then readiness, cutover (progressive services go to 100% here, after the migration), and readback of the serving digest. A readback that names another digest fails the step; an adapter that cannot read it ends the release `cut_over_unverified`, never `readback_verified`. A failed migration returns canary traffic to the previous revision (code only) and reverts nothing in the database.

### Safety properties

- Digest immutability: `release_runs.image_digest` and identity columns are immutable (DB trigger); one run per (operation, service, kind); a different digest on the same operation is `digest_immutable`. Unpinned images are refused ("no pinned image digest").
- Provenance: the run cannot reach `deployed` without a verified verdict at the required level (service and DB trigger). Consumed through `ProvenanceVerifier`; a verifier that throws or no verifier is "not verified". Built images are `build_record` only with a real, non-simulated build evidence row for that service, digest and approved source.
- Migration classification: declared class (manifest) raised, never lowered, by SQL classification; absent class is `unclassified` and treated like `contract`. `expand` runs after the normal deployment approval. `data`, `contract`, `unclassified` need a SEPARATE approval bound to (workspace, environment, service, image digest, command digest, SQL digest, class), by a user other than the requester (agents act as their principal), single use, expiring (default 24 h, max 7 d). Approval route is browser-only.
- Code rollback: restores the digest the revision last served (no rebuild), skips the manifest's migration, never reverts data, refused when a `contract`/`unclassified` migration ran since that digest served (names the release), warns when a `data` migration did. A completed rollback marks the replaced release `rolled_back` and says data was not changed. Data restore stays a separate reviewed action (LIFE-11 / hosted restore), not triggered here.
- Progressive rollout: Cloud Run services only. AWS, Azure, Kubernetes, OCI and Cloud Run jobs refuse before anything is deployed with a provider-specific reason; nothing falls back to a rolling replace while calling it a canary.

## 2. Acceptance mapping

Acceptance: "Source to build/digest/migration/readiness/cutover/readback works; progressive rollout/code rollback/compatible migrations separate from reviewed data restore."

| Clause | Implementation | Tests |
| --- | --- | --- |
| Source -> build/digest | existing build + approved source snapshot; digest bound on `begin` (`release_runs`) | `tests/release-safety/pipeline.test.ts` (digest immutable, pinned URI); `tests/execution/release-safety.test.ts`; `tests/controlplane/release-pipelines.test.ts` (trigger) |
| Provenance interface, refuse unverified | `provenance.ts`, `ReleaseSafetyService.begin`, `platform/release-safety.ts` | pipeline.test.ts (refusal, throwing verifier, strongest verdict, registry hook, rollback reuse); execution test "no verified provenance" |
| Migration (classification, separate approval) | `classify.ts`, `approveMigration`, `beginMigration`, route `approve-migration` | `tests/release-safety/classify.test.ts`; pipeline.test.ts (gates, separation of duties, binding, single use, expiry, retry); execution test (blocked, approve, runs once); SQL test (approval single use, immutable, requester check) |
| Readiness | `finishRun` (steady wait, migration done, canary baked) then `ready` | execution test (state sequence) |
| Cutover | rolling: after steady; progressive: `setTrafficPercent(100)` after migration; `markCutOver` | execution test "progressive"; `release-progressive.test.ts` |
| Readback | `recordReadback`, `WorkloadsPort.readServing` (GCP, Kubernetes) | pipeline.test.ts (mismatch, unsupported, unreadable); execution test (verified, mismatch, unverified); gcp test (serving digest) |
| Progressive rollout where supported, refusal where not | `rollout.ts`, `traffic.ts`, wrapper in `platform/release.ts` | pipeline.test.ts (declaration); execution test (refusal; staged canary; failed-migration abort); gcp test (hold traffic, split, abort, refusal on aws/azure/k8s/oci) |
| Code rollback, never auto-reverts data | `rollbackSafety`, `lastServedForRevision`, rollback kind in `beginRuns`/`runMigrations` | pipeline.test.ts (refused after contract, allowed with data warning, never runs a migration); execution test (rollback restores digest, skips migration, refused after contract, marks replaced); SQL test (rollback refusal on stored history) |
| Compatible migrations separate from reviewed data restore | `expand` vs `data`/`contract`; rollback never calls a restore | classify.test.ts; pipeline.test.ts |
| State machine | `state.ts` + `release_run_guard` trigger | pipeline.test.ts; SQL test (skip state, version, delete, append-only events) |
| Tenant isolation | every statement filters `workspace_id` | pipeline.test.ts, SQL test (foreign workspace) |

## 3. Verification commands (other machine)

```
npx vitest run tests/release-safety tests/execution/release-safety.test.ts tests/execution/release.test.ts tests/execution/manifest-release.test.ts
npx vitest run tests/providers/gcp/release-progressive.test.ts tests/providers/gcp/release.test.ts tests/providers/kubernetes
npx vitest run tests/controlplane/release-pipelines.test.ts tests/controlplane/migrations.test.ts        # PGlite lane
ZENITH_TEST_PLATFORM_PG_URL=<postgres url> npx vitest run tests/controlplane/release-pipelines.test.ts tests/controlplane/migrations.test.ts
npx vitest run tests/middleware/platform-bearer.test.ts tests/platform/deploy-e2e.test.ts tests/platform/composition.test.ts tests/docs
npx tsc --noEmit -p . && npx eslint <changed files>
```

Expected: all pass, zero skipped (the PostgreSQL lane only with the env var). `deploy-e2e` and `composition` now run the real pipeline over PostgreSQL (the composition always supplies `releaseSafety`); they need migration 23 applied.

## 4. Known gaps and shared-file updates for the assembler

Shared files not touched (assembler): `emit.ts` / `emit-sql` regeneration and `supabase/migrations/*` (migration 24 is registered in the source registry only; versions 21 to 23 belong to sibling requirements, so the contiguity check fails until they are merged), `DEPLOYING.md` row 24 with checksum, `scripts/ci/apply-supabase-migrations.sh` table list, `tests/controlplane/migrations.test.ts` EXPECTED_TABLES, gate manifest (new test files above), LIMITATIONS, ledger, PROGRESS. `tests/middleware/platform-bearer.test.ts` count (51) must be re-added after merging other route additions.

New tables: `platform.release_runs`, `platform.release_events`, `platform.release_migration_approvals` (RLS on, anon/authenticated revoked, service_role insert/update only as granted). Store functions live in `repos/release-pipelines.ts` and are NOT in `repos/index.ts`, so `tenancy.test.ts` and the sql-scoping classification do not enumerate them. Every statement is workspace scoped; there are no system reads. Classify as tenant-scoped if the orchestrator registers them.

Decisions and honest limits:

- Default minimum provenance is `pinned_digest` (`ZENITH_RELEASE_MIN_PROVENANCE`; `build_record` and `attested` available). A digest the manifest pins is accepted at that level; a tag, an unknown digest, or a Zenith-built digest with no build record is refused. LIFE-09 should register its attestation verifier through `registerProvenanceVerifier` and raise the default to `attested`. Nothing here produces or verifies attestations.
- Pre-effect refusals are `StepFailedError` (the operation ends `failed`, nothing deployed). A migration awaiting approval does NOT pause the workflow (that needs a Temporal workflow patch and a new step); the person approves release `rel_...` through the browser route, then deploys again. The old blocked run is superseded.
- Behaviour change when the composition supplies `releaseSafety` (always): every managed workload needs a pinned digest (an `image` artifact with a mutable tag is refused; before, it was only waited on), and `image` artifacts now go through `deployImage` with their own pinned ref (idempotent; on AWS the port returns "applied by OpenTofu").
- Progressive rollout is implemented for Cloud Run services only. Azure Container Apps can weight revisions but the adapter does not implement it; AWS, Kubernetes, OCI refuse.
- Readback is implemented for Cloud Run and Kubernetes. AWS, Azure, OCI end `cut_over_unverified` (recorded, not hidden).
- Migrations still run after the deploy step (their task inherits the service's image); for progressive services the 100% cutover happens after the migration. Expand migrations are therefore compatible with the old code by classification, not by ordering.
- The legacy in-process engine rollback (`engine.rollback`) is not covered; the workflow route is. The `deploy.rollback` plan screen does not show rollback safety (it reads the product store); execution refuses, and `GET /releases/:id` shows the verdict.
- UI: `/platform/releases` (list) and `/platform/releases/[id]` (stages, bound digest and provenance, migration findings and digests, approve-migration for a non-requester admin, rollout, readback, rollback refusal reasons, and the approve-then-deploy-again explanation) under `src/app/(product)/platform/releases/`, linked from the platform nav. Zenith stores digests of the command and SQL, never their text, so the page shows the classifier findings and digests rather than SQL text. No MCP tool.
- LIFE-09 hand-off: the assembler must register LIFE-09's provenance verifier (the one used in deployWorkloads on prod/life-09-w2) as a `ProvenanceVerifier` via `registerProvenanceVerifier`, so there is one verification path; then raise `ZENITH_RELEASE_MIN_PROVENANCE` to `attested`.
- (earlier note) REST is complete too. Hosted-app releases (`src/lib/hosted/release`) keep their own pipeline.
- Provider code is contract-tested against synthetic REST, not live-verified.
- `tests/execution/fakes/{release,world}.ts` gained `FakeProgressive`, `serving`/`readServing` and a `releaseSafety` world option (test support only).

## 5. Suggested ledger implementationStatus

`release_pipeline_digest_provenance_migration_approval_progressive_gcp_rollback_readback_wired_verification_pending_live_provider_and_attestation_open`

## J6 source build join (2026-10-08)

The isolated BuildKit controller and gated default-port source/build/migration/
readiness/readback harness are in tests/providers/kubernetes/build/kind.test.ts.
Use the exact Mac setup and commands in PROD-LIFE-09.md, J6 addendum.
Built artifacts already require attested provenance, and the built-admission
verifier is registered by createPlatformReleaseSafety. Set
ZENITH_RELEASE_MIN_PROVENANCE=attested for this rehearsal.

The harness builds a small static non-root server, verifies its registry OCI
provenance, runs a one-off fixture command Job, checks readiness and the serving
digest, then reads the running HTTP body through the real API server.
The fixture command does not perform a SQL migration; SQL expand/contract and migration-pause verification remain in the LIFE-10/J2 lane.
It does not replace the full Temporal/human-approval/progressive/code-rollback/
reviewed-data-restore lanes or erase their remaining gaps. Assembly must select
the isolated default build port and provision its runtime/proxy prerequisites.
No kind, PostgreSQL, Temporal or browser test ran on this Windows machine.
Status: implementation_complete_verification_pending.

## J6 Step 2 (authoritative, 2026-10-08)

Default native Kubernetes and managed builders, per-tenant vault/RBAC custody,
protected dedicated node admission, native source/provenance schema migration 58
and DUR-B reviewed build profile semantics are joined. Missing or changed custody,
permissions, runtime/profile, node UID/allocation or denial probe refuses source
execution/release with a user-visible reason. Published migrations/aggregate SQL
remain unchanged. The migration-42 collision is repaired in assembly; release-join
checks pass locally.

Use the complete exact two-node/4-GiB Docker preparation, runtime-file hashing/install,
token/vault seeding, digest resolution, source fixture and host API/Temporal/worker
commands in [LIFE-09 J6 Step 2](PROD-LIFE-09.md#j6-step-2-authoritative-2026-10-08).
Prepare the real disposable product and owning Postgres as specified there. Set
ZENITH_ISOLATED_BUILD_PROFILES, ZENITH_J6_WORKSPACE_ID, ZENITH_J6_ENVIRONMENT_ID,
ZENITH_TEST_PLATFORM_PG_URL, ZENITH_J6_APPLICATION_PG_URL, ZENITH_J6_HTTP_URL and
ZENITH_J6_OPERATION_ID to the recorded real fixture, local endpoints and reviewed
operation; use local signing keys, no KMS/cloud credentials.

```bash
export ZENITH_ALLOW_CONTRACT_MIGRATIONS=42,49,59
npx tsx --env-file-if-exists=.env.local scripts/platform/migrate.ts
npx tsx --env-file-if-exists=.env.local scripts/platform/migrate.ts --status
ZENITH_TEST_J6_SOURCE_PG=1 npx vitest run tests/providers/kubernetes/build/schema.test.ts --no-file-parallelism --maxWorkers=2
ZENITH_TEST_ISOLATED_BUILD_KIND=1 npx vitest run tests/providers/kubernetes/build/kind.test.ts --no-file-parallelism --maxWorkers=2
ZENITH_TEST_J6_OPERATED_RELEASE=1 npx vitest run tests/providers/kubernetes/build/operated-release.test.ts --no-file-parallelism --maxWorkers=2
```

Expected: 15 schema tests, one real isolation/component journey and one real reviewed
source release pass with zero skips. The operated harness independently reads the
application's migration marker from SQL and HTTP, re-verifies signed source provenance
and requires migration before cutover plus readiness/digest readback. It neither
creates nor bypasses approval and uses no provider doubles. Requires a root-context
one-service fixture; broader rollback/progressive/data-restore acceptance keeps its
existing LIFE-10 lanes. Assembly must join assigned 53-58 before the contiguous
migration gate. Not run here (needs real PG, kind/Docker, Temporal and product/browser).
Status: implementation_complete_verification_pending.


## Wave 6 final integration

Status remains `implementation_complete_verification_pending`. Node 22 only. Execute sequentially with Docker Desktop 4 GiB and one kind node; stop each heavy profile before starting another. Live acceptance stays deferred until separate owner approval.

```bash
node scripts/ci/wave6-gates.mjs --requirement PROD-LIFE-10 --print > /tmp/zenith-wave6-PROD-LIFE-10.commands.json
```

This prints the exact argv for each contract batch and required engine case, its gate names, private prerequisites, and its strict report-validation command. Set only the gates for the selected lane after preparing its owned fixture; a skip cannot satisfy that lane. Run each `argv` sequentially and then its `verify` argv. [Final integration setup and results](FINAL-INTEGRATION.md), [canonical inventory](../../../../scripts/ci/wave6-gates.json), [owner live runbook](../LIVE-ACCEPTANCE.md).
