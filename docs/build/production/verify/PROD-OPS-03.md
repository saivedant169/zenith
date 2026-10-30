# PROD-OPS-03 Rolling upgrades and replay: verification notes

DRV-3 adds the dedicated operated J1/J2 upgrade driver and gated
`j15-operated-upgrade` lane. Exact lean Mac preparation, candidate images,
commands, acceptance mapping, independent readback and cleanup are in
[DRV-3](DRV-3.md). Not run here (needs Docker, Temporal, kind and Chromium).
This addendum does not promote the historical checks below to operated evidence.

Built only. Nothing below was executed except typecheck (`npx tsc --noEmit -p .`, exit 0), eslint on every changed file (clean), and `go build` / `go vet` / `gofmt` for `go/internal/agent` (clean). Another machine runs every test. Branch `prod/ops-03-w4b`, base ad78c593. No platform migration was needed (version 45 is unused); the compat baseline is 45 on purpose (see section 4).

## 1. What was built

Audit first (results in `docs/platform/operations/ROLLING-UPGRADES.md`):

- Workflow versioning: three `patched()` ids in use (`ecs-replica-repair-v1`, `durable-build-launch-v1`, `reconcile-canonical-proposals-v1`), no `deprecatePatch`. Nothing registered them or checked them; `infrastructureDestroyWorkflow` was exported by `definitions/index.ts` but missing from `WORKFLOW_TYPES`. The existing `tests/workflows/replay.test.ts` replays histories recorded per run from the current code (not frozen), so it cannot catch a regression against a released history.
- Worker build ids: none configured. The SDK in use is 1.24.0, which exposes `workerDeploymentOptions` (Worker Deployments); the old `buildId/useVersioning` is deprecated, so that is what is wired.
- Schema: `assertPlatformSchemaCurrent` already allows a database AHEAD of the build (N-1 on schema N) and fails closed when behind (N on N-1); nothing stopped a contract migration.
- Runner protocol: protocol ids were in every signature and `426 upgrade_required` existed, but only one protocol could ever be served, `minimumProtocol` named the current protocol, and registration did not negotiate.
- MCP: `src/lib/agent-access/v3/protocol.ts` (UX-02) already has supported/refused version lists and refusals; not changed.

New:

| Area | Files |
| --- | --- |
| Versioning contract and worker routing | `src/lib/workflows/versioning.ts` (patch registry, registered workflow types, `workerVersioningFromEnv`, `workerDeploymentOptionsFor`); `workers/execution/config.ts` (`versioning` field, env parsed at startup, refuses malformed config), `run.ts` (`workerDeploymentOptions` only when configured), `worker.ts` (logs mode/deployment/buildId) |
| Replay harness | `tests/workflows/history-scenarios.ts` (19 scenarios over all 9 registered workflows, incl. wave-3 coding agent, teardown review, sweep, maintenance, patched branches, start-through-client), `history-fixtures.ts` (format, MANIFEST sha256, no-overwrite), `history-record.test.ts` (opt-in recorder), `history-replay.test.ts` (the gate), fixtures dir `tests/fixtures/workflow-histories` (to be recorded, see section 3) |
| Static audit | `tests/workflows/versioning-audit.test.ts` |
| `WORKFLOW_TYPES.destroy` | `src/lib/workflows/types.ts` (additive) |
| Schema N-1/N contract | `src/lib/controlplane/db/compat.ts`; `migratePlatformDb` calls `assertPendingMigrationsCompatible` before applying anything; `scripts/platform/migrate.ts --dry-run` prints each pending migration's class and exits 1 on an unapproved contract migration; `classifyStatement` exported from `src/lib/release-safety/classify.ts` (additive) |
| Runner protocol window | `src/lib/runners/protocol-window.ts`; `types.ts` (`ProtocolWindow`, `RUNNER_PROTOCOL_WINDOW`, `MACHINE_PROTOCOL_WINDOW`, `AGENT_KINDS[...].window`); `request-auth.ts` (426 now names the oldest served protocol and carries the window); `service.ts` (registration accepts `protocols`, negotiates BEFORE the token is consumed, response adds `supportedProtocols` and `protocolDeprecated`); Go `go/internal/agent/register.go` (offers its protocol, rejects a different selection) |
| Runbook | `scripts/ops/rolling-upgrade.mjs` (plan/upgrade/rollback, compose and k8s, dry run by default), npm scripts `ops:upgrade` and `workflow-histories:check` |
| Rehearsal | `tests/workflows/upgrade-rehearsal.test.ts` (old worker build -> new worker build with in-flight workflows), `tests/controlplane/migration-compat.test.ts` (N-1/N schema on PGlite), `tests/runners/protocol-window.test.ts` |
| Docs | `docs/platform/operations/ROLLING-UPGRADES.md` |

## 2. Acceptance mapping

Acceptance: "API/worker/runner upgrades with in-flight histories and schema/protocol compatibility/rollback pass."

| Clause | Implementation | Tests |
| --- | --- | --- |
| Replay recorded histories against the current bundle, fail on nondeterminism, every registered workflow incl. wave-3 | scenarios + fixtures + gate | `history-replay.test.ts` (inventory, manifest integrity, coverage of every `REGISTERED_WORKFLOW_TYPES` entry, patch markers present, each fixture replays, teeth: reordered workflow and truncated history rejected) |
| Audit patched/getVersion usage | `WORKFLOW_PATCHES`, `REGISTERED_WORKFLOW_TYPES` | `versioning-audit.test.ts` (unregistered, stale or non-literal patch ids fail; index.ts exports equal the registry; WORKFLOW_TYPES equal the registry) |
| Worker build-id / versioning routing config | `versioning.ts`, worker config/run/log | `tests/workers/versioning-config.test.ts` |
| API N-1/N DB contract, expand-only, contract gated by LIFE-10 approval | `compat.ts` + migrator + migrate script | `migration-compat.test.ts` (classification, grandfathering, approval needs registry + SQL hash + operator confirmation, N-1 build on N schema works and its writes stay valid, N build on N-1 schema fails closed, contract refused before anything is applied) |
| Runner protocol negotiation, explicit N-1 window, refusal outside | `protocol-window.ts`, types, auth, service, Go register | `protocol-window.test.ts` (window logic with synthetic windows; real register routes: negotiation, 426 with minimum, token not consumed, malformed list rejected); existing `request-auth.test.ts` 426 cases |
| Rolling-upgrade + rollback runbook for compose and k8s, runnable on the verifier machine | `rolling-upgrade.mjs` | `tests/ops/rolling-upgrade.test.ts` (plan order, gates first, digests only, versioning promotion order, contract confirmation, compose and kubectl argv, rollback refusals, dry-run end to end); real execution is the operational rehearsal (section 3, step 5) |
| Upgrade rehearsal old workers vs new schema and vice versa where feasible locally | schema both ways on PGlite; old-build worker to new-build worker with in-flight workflows on a real local Temporal server | `migration-compat.test.ts`, `upgrade-rehearsal.test.ts` |
| MCP protocol versions | audited, already enforced (UX-02) | existing `tests/agent-access` protocol suites (not re-run here) |

## 3. Verification commands (other machine)

Step 1, record the fixtures (needs a Temporal test server; `temporal` CLI on PATH or `ZENITH_TEST_TEMPORAL_CLI`; `ZENITH_TEST_TEMPORAL=1` makes an unavailable server a failure):

```
ZENITH_TEST_TEMPORAL=1 ZENITH_RECORD_WORKFLOW_HISTORIES=1 npx vitest run tests/workflows/history-record.test.ts
git add tests/fixtures/workflow-histories     # 19 scenario files + MANIFEST.json; commit them
```

Expected: 19 passing recorder tests and 19 new files plus `MANIFEST.json`. If a scenario fails to record, fix the scenario (activity scripting), not the gate. I could not run the recorder, so the scenario scripting (especially `destroy-*`, `teardown-review`, `reconcile-sweep`, `coding-agent-*`) is untested and the most likely first failure.

Step 2, the gates (no server needed for replay):

```
npx vitest run tests/workflows/history-replay.test.ts tests/workflows/versioning-audit.test.ts
npx vitest run tests/workers/versioning-config.test.ts tests/runners/protocol-window.test.ts tests/ops/rolling-upgrade.test.ts
npx vitest run tests/controlplane/migration-compat.test.ts tests/controlplane/migrations.test.ts      # PGlite lane
ZENITH_TEST_PLATFORM_PG_URL=<postgres url> npx vitest run tests/controlplane/migration-compat.test.ts tests/controlplane/migrations.test.ts
ZENITH_TEST_TEMPORAL=1 npx vitest run tests/workflows/upgrade-rehearsal.test.ts tests/workflows/replay.test.ts tests/workflows/deploy.test.ts
npx vitest run tests/runners tests/workflows/sandbox.test.ts tests/workers
cd go && GOTOOLCHAIN=local go test ./internal/agent/...
```

Expected: all pass, zero skipped except the three Temporal-gated files when `ZENITH_TEST_TEMPORAL` is unset. Before step 1 is done `history-replay.test.ts` FAILS by design (missing fixtures print the record command); that is a gate, not a bug.

Step 3, runbook dry run (reads nothing from the cluster when previous images are given):

```
node scripts/ops/rolling-upgrade.mjs plan --topology compose --env-file <install.env> \
  --api-image r/api@sha256:<64hex> --worker-image r/w@sha256:<64hex> --migration-image r/m@sha256:<64hex> \
  --previous-api-image <digest ref> --previous-worker-image <digest ref>
```

Step 4, schema dry-run classification: `npx tsx scripts/platform/migrate.ts --dry-run` (prints class per pending migration).

Step 5, operational rehearsal (needs Docker; not claimed passed): follow the checklist at the end of `docs/platform/operations/ROLLING-UPGRADES.md` on the default compose topology, then the k8s variant with a supplied migration Job manifest.

## 4. Known gaps and what may break first

- Fixtures are not committed: recording needs a Temporal server, which the build rules forbid running here. The gate fails until step 1 is committed. Without a pre-patch history the legacy branches are covered only by the existing legacy-fixture tests (`deploy`, `ecs-replica-repair`, `reconcile`) and by `upgrade-rehearsal.test.ts`, not by committed old histories. Once a release ships, the committed fixtures ARE the released histories; do not re-record them.
- `history-scenarios.ts` and `upgrade-rehearsal.test.ts` were written against the existing harness conventions but never executed; expect small scripting fixes. In particular the second teeth test (truncated history) only asserts that replay throws, not which error.
- Worker Deployment routing (`set-current-version`, pinned drain, AUTO_UPGRADE moving a running workflow) is not exercised by any test: it needs a server with worker deployments enabled. Config, options mapping and runbook commands are covered; server behaviour is not. It is off by default for that reason.
- Rolling a worker BACK across a new patch is documented as unsafe without `pinned`; the rehearsal asserts old to new only.
- The k8s runbook has no checked-in API/worker Deployment manifests to target; names, containers and the migration Job are options. `kubectl wait` for the migration Job selects `app.kubernetes.io/component=platform-migrate`, which the supplied Job must carry.
- `COMPAT_BASELINE_VERSION = 45` grandfathers every migration up to 45, so the expand-only rule is vacuous until migrations above 45 exist (the test says so). The release manager must raise it at each release cut. The classifier is text analysis: `create or replace function` counts as expand, and an unrecognised statement is refused. A wave-4b migration numbered above 45 that adds a NOT NULL column without a default or enables RLS on an existing table will now be refused by `migratePlatformDb`; that is intended.
- MCP protocol was audited, not changed. The runner/machine windows are both v1-only today, so the N-1 list is empty and N-1 behaviour is proven with synthetic windows plus the routes' real negotiation, not with a second real protocol.
- Edited verified files: `src/lib/runners/request-auth.ts` (426 now carries `supportedProtocols`/`currentProtocol`; the status, code and `minimumProtocol` are unchanged for a v1-only plane), `src/lib/runners/service.ts` (registration response gains fields; `toMatchObject` tests unaffected), `src/lib/controlplane/db/migrator.ts` (one added call; refuses only versions above 45), `go/internal/agent/register.go`. No verified contract was knowingly changed.

## 5. Shared-file updates the orchestrator must make

- Migrations: none (no new SQL, no new tables, no store functions, no tenancy.test.ts or SQL-scoping impact).
- Gate manifest: add a lane running `tests/workflows/history-replay.test.ts tests/workflows/versioning-audit.test.ts tests/controlplane/migration-compat.test.ts tests/runners/protocol-window.test.ts tests/workers/versioning-config.test.ts tests/ops/rolling-upgrade.test.ts`, and put `tests/workflows/history-record.test.ts` and `upgrade-rehearsal.test.ts` (Temporal-gated) in the Temporal lane. `npm run workflow-histories:check` is a convenience.
- Commit `tests/fixtures/workflow-histories` after step 1; add the directory to any fixture-integrity or sanitize-evidence scan if one exists.
- `docs/platform/operations/README.md` index entry for `ROLLING-UPGRADES.md`; `docs/platform/EXECUTION-WORKER.md` could link it (not edited here).
- LIMITATIONS: Worker Deployment routing is untested against a real server; rollback across a patch needs `pinned`; compat baseline must be bumped per release; k8s manifests for API/worker are not shipped.

## 6. Suggested ledger implementationStatus

`built_unverified: replay harness (19 scenarios over all 9 workflow types, frozen fixtures pending recording), patch registry audit, Worker Deployment version routing config, expand-only schema gate with LIFE-10-style approval registry, runner/machine N-1 protocol negotiation, compose/k8s rolling-upgrade and rollback runbook, local upgrade rehearsals; fixtures unrecorded, no test run, no Docker/cluster/real-server versioning evidence`

## 7. Follow-up changes (supersede earlier text above)

- Replay gate is an opt-in lane, not a default or CI test. `history-replay.test.ts` is skipped (with a stated reason) unless `ZENITH_REPLAY_LANE=1`; inside the lane missing fixtures FAIL. Verifier runs FIRST: `npm run replay:record` (sets `ZENITH_RECORD_WORKFLOW_HISTORIES=1`, `ZENITH_TEST_TEMPORAL=1`), commits `tests/fixtures/workflow-histories`, runs `npm run replay:check`, and only then adds the lane to the gate manifest. The runbook gates step sets the lane variable itself. (Ignore the earlier `ZENITH_RECORD...` command and `workflow-histories:check` in sections 3 and 5.)
- k8s manifests added: `deploy/k8s/zenith-api.yaml`, `zenith-execution-worker.yaml` (rolling maxUnavailable 0, probes, PodDisruptionBudget, 660 s grace), `platform-migrate-job.yaml`. Images are placeholder zero digests; the runbook substitutes the migration image into the Job over stdin and sets Deployment images by `kubectl set image`. Apply the Deployments once with real digests first. Secrets (`zenith-api-env`, `zenith-worker-env`, `zenith-migration-env`) are yours to create. Never applied to a cluster here.
- Compat baseline is no longer a constant. `migratePlatformDb` on Postgres (or `ZENITH_ENFORCE_EXPAND_ONLY=1`) enforces expand-only for every pending migration above the highest version already applied (a fresh database is exempt). Static/CI checks use `ZENITH_COMPAT_BASELINE_VERSION` (previous release highest) else the registry highest. PGlite does not enforce by default.


## L1-LIVE-AWS provider slice (8 October 2026)

Acceptance: API/worker/runner upgrades with in-flight histories and schema/protocol compatibility/rollback pass.

The AWS planner includes this exact requirement; native provider fixture checks alone leave its full product acceptance pending. See [L1-LIVE-AWS](L1-LIVE-AWS.md) and [owner runbook](../LIVE-ACCEPTANCE.md) for the immutable plan, Wave 5 ProductScenarioPort join, approved permission/session FILE references, owner-only bootstrap, one-command execution and recovery. Commercial, retention, multi-cloud, managed cluster and final signoff decisions remain separate where this row requires them.

Exact Mac commands (Node 22, one workload, Docker 4GiB only for the separate Wave 5 stack):

```bash
export PATH="$ZENITH_NODE22_BIN:$PATH"
node --version
actionlint .github/workflows/live-acceptance.yml
tofu -chdir=deploy/live-sandbox/aws init -backend=false
tofu -chdir=deploy/live-sandbox/aws validate
npx vitest run tests/acceptance/aws-production.test.ts tests/acceptance/aws-production.live.test.ts --no-file-parallelism --maxWorkers=1
# Only AFTER DEC-CLOUD and all variables in LIVE-ACCEPTANCE.md are exported, for a NEW approved run:
ZENITH_LIVE_AWS=1 npx vitest run tests/acceptance/aws-production.live.test.ts --no-file-parallelism --maxWorkers=1
```

Expected offline: provider contracts pass; actual AWS test is skipped, never accepted as live evidence. Expected live for this source: six actual provider fixtures and native cleanup, zero failed checks, packet incomplete / exit 3 and this requirement pending until its full product journey is joined and independently verified. No actual AWS, real PostgreSQL, Temporal, kind or browser verification was run on the Windows builder. Status for the AWS harness slice: implementation_complete_verification_pending.

## L3 live and operational verification (2026-10-08)

Acceptance contract: API/worker/runner upgrades with in-flight histories and schema/protocol compatibility/rollback pass.

Profile: **release**. The owner observation matrix in [LIVE-ACCEPTANCE-MANAGED.md](../LIVE-ACCEPTANCE-MANAGED.md) maps every clause above to real product receipts, provider reads and traffic or operational observations. Fill distinct checks for every clause; a generic operation-status assertion is insufficient.

Implementation: `scripts/acceptance/live/managed/{plan,runner,transport,cli}.ts`, `scripts/acceptance/live/mixed/probes.ts`, the profile shell entry point. Offline checks: `tests/acceptance/live-managed.test.ts`, `tests/acceptance/live-managed-transports.test.ts`; actual Mac owner-gated checks: `tests/acceptance/live-l3.gated.test.ts`. No library injection replaces the CLI transport.

Mac prerequisites: Node 22; clean committed integrated RC; running owner-operated disposable Zenith/PostgreSQL/Temporal stack; managed cloud/CNI/runtime and two tenants for managed isolation; exact sandbox accounts/regions/real DNS/ACME/registry/Stripe test mode/private source fixtures as applicable. The shared runbook lists exact accounts, credentials as FILE references, and separate DEC-CLOUD, DEC-BUSINESS, DEC-RETENTION and signing/signoff approvals. For the lean 8 GB Mac/4 GiB Docker profile, observe an already operated remote sandbox; local cluster/engine rehearsals run one heavy process at a time after J1/J11/J14 integration.

Exact Mac commands, after owner has prepared the private recipe, permissions and approval FILEs described in the shared runbook:

```bash
bash scripts/acceptance/live/release/acceptance.sh --plan --fixture "$L3_PRIVATE/release.recipe.json"
export ZENITH_LIVE_SCOPE_FILE="$L3_PRIVATE/permissions.json"
npx tsx scripts/release/permissions-cli.ts check
export ZENITH_L3_APPROVAL_FILE="$L3_PRIVATE/release.approval.json"
export ZENITH_L3_BUDGET_FILE="$L3_PRIVATE/budget.json"
export ZENITH_L3_OUT="$PWD/.data-live/l3"
ZENITH_LIVE_RELEASE=1 bash scripts/acceptance/live/release/acceptance.sh --run --fixture "$L3_PRIVATE/release.recipe.json"
# On interruption: audit the original journal/lock, then cleanup only with the same RC and approvals.
ZENITH_LIVE_RELEASE=1 bash scripts/acceptance/live/release/acceptance.sh --cleanup-only --fixture "$L3_PRIVATE/release.recipe.json"
```

Expected: --plan opens no credential and makes zero calls; --run exits 0 only when every required profile scenario, actual assertion, approved cleanup and independent inventory passed. Exit 1 is a failed check, 2 refusal, 3 incomplete/cleanup-only. Live vitest alternative is in the shared runbook; all three live tests explicitly skip when their gates are disabled. Never count those skips as acceptance passes.

Not run here: cloud, real PostgreSQL, Temporal, Docker/kind, browser and operated-stack rehearsals. This row remains pending live/operational evidence and applicable owner decisions. Do not interpret generic tag-index scans as proof of all global/untaggable/unsupported resources being gone. Add direct provider-specific inventories from L1/L2 and review the actual observation matrix before accepting the ledger clause.

Integration joins: exact managed/release grants are absent from the shipped unapproved permissions.json; owner/integrator approval required before any live call. Use the original normal browser approval paths for all execution/teardown. Share the conservative budget book with L1/L2; connect J1/J2/J4/J5/J6/J11/J14/J15 receipt producers and J12 dossier/signoff. No platform migrations, aggregate SQL, package or published migration edits in this job.

Suggested ledger status: `implementation_complete_verification_pending` (L3 harness built; requirement verification and unresolved owner decisions remain pending).


## Wave 6 final integration

Status remains `implementation_complete_verification_pending`. Node 22 only. Execute sequentially with Docker Desktop 4 GiB and one kind node; stop each heavy profile before starting another. Live acceptance stays deferred until separate owner approval.

```bash
node scripts/ci/wave6-gates.mjs --requirement PROD-OPS-03 --print > /tmp/zenith-wave6-PROD-OPS-03.commands.json
```

This prints the exact argv for each contract batch and required engine case, its gate names, private prerequisites, and its strict report-validation command. Set only the gates for the selected lane after preparing its owned fixture; a skip cannot satisfy that lane. Run each `argv` sequentially and then its `verify` argv. [Final integration setup and results](FINAL-INTEGRATION.md), [canonical inventory](../../../../scripts/ci/wave6-gates.json), [owner live runbook](../LIVE-ACCEPTANCE.md).

## Rolling upgrade and rollback proven on the live AWS sandbox (2026-10-30)

Run [41137046750](https://github.com/saivedant169/zenith/actions/runs/41137046750), run id `zlive-202610302216-99b4`, workflow `live-acceptance.yml`, scenario `ops-03`, lane `live2`. Source `d788ff92f67d0f57bae84d91adcc61971f264def`. Sandbox account `361646636162` in ap-south-1. Plan digest `b3d1139f7cf6fc6776436ac03a613e698a0a96ab2dfe6c8eac09ebc8cac168a3`; permission digest `663ce1445ae9a479a4c14a52fcbcd87392df8a139fb1e62f1da8ba120f8fe98c`.

Verdict `passed`: 1 passed, 0 failed, 0 pending. Cleanup complete. Estimated cap USD 0.8 (provisional, billing not measured), 60 minute window; the scenario itself took about 8 minutes. Files: `evidence/PROD-OPS-03/2026-10-30-live-aws-41137046750/`, including the `zenith.release-evidence.v1` receipt `release-evidence-PROD-OPS-03.json`.

What the run checked (PR #131, `scripts/acceptance/live/product/ops-03.ts`):

- Candidate API, worker and migration images were rebuilt from this source and pushed to the stack's own registry.
- A one-bucket deploy was approved and planned; its Temporal workflow waited in flight for the apply approval, with nothing in AWS.
- The stack was upgraded in `rolling-upgrade.mjs` order: migrate dry-run, expand migration, worker, then API, each healthy on its new image digest. The review (status and round) and the Temporal run were unchanged and AWS was still empty.
- The apply was approved on the candidate release. The same run completed and AWS held one tagged bucket.
- The stack was rolled back, API then worker, onto the recorded images; the schema was not downgraded. A second deploy on the rolled-back release added the second bucket (2 tagged buckets).

Limits: the candidates are rebuilt from the same source because no released N-1 exists yet, so this proves in-flight replacement and rollback against AWS, not a previous-release compatibility matrix. Runner (machine) upgrades are separate. `operational_rehearsal` is not done. Status stays `in_progress`. Not a promotion.
