# PROD-OPS-01 Measured service and recovery objectives

Branch `prod/ops-01-w5`, base `c02c097e`. Platform migration `43` (`0043_slo_measurements`). Build only: the builder ran `tsc --noEmit` and `eslint` on the changed files (both clean) and ran `node scripts/slo/capacity-test.mjs --self-test` once (passed). No vitest suite was run. Operator guide: `docs/platform/operations/SLO.md`.

**All targets are provisional and unapproved (DEC-BUSINESS pending).** No field anywhere can record an approver.

## 1. Summary of what was built

| Area | Files |
|---|---|
| Definition file (versioned, all `provisional`, no approver) | `deploy/slo/slo-definitions.json`; strict validator `src/lib/slo/definitions.ts` (refuses `approved`, any approval-looking field, non-provisional status, unknown fields) |
| SLI computation | `src/lib/slo/sli.ts` (API availability and latency from the OPS-02 catalog metrics via the registry snapshot), `src/lib/slo/store.ts` (dispatch latency and workflow completion from `platform.operations`; scheduler health sampled from OBS-04 `platform.scheduled_job_runs` through `criticalJobHealth`) |
| Durable samples and budgets | `src/lib/slo/recorder.ts` (`flushSloSamples`, delta accounting, wired into `src/lib/ops/sampler.ts` `sampleControlPlane`, so every `/api/internal/metrics` scrape and every worker sampler tick persists deltas), `src/lib/slo/budget.ts` (budget, burn rate, multiwindow alerts, min 20 events) |
| Burn-rate alerts | `deploy/observability/alerts/zenith-slo.rules.json` (recording rules + 6 alerts: availability and latency x fast/slow/ticket), runbook headings in `docs/platform/operations/SLO.md`, row in `deploy/observability/README.md` |
| RPO/RTO hooks for OPS-04 | `src/lib/slo/recovery.ts` (`reportRecoveryRehearsal`: three instants in, RPO and RTO derived), `POST /api/internal/slo/measurements` (bearer, `kind: recovery`), `scripts/slo/report-recovery.mjs` |
| Capacity test | `scripts/slo/capacity-test.mjs` (Node built-ins only, closed-loop GET load, loopback-only unless `--allow-remote`, bearer from a file, `--self-test`, `--report`), `reportCapacityTest`, route `kind: capacity` |
| Operator report | `src/lib/slo/report.ts`, `GET /api/admin/ops/slo` (platform operators), page `/admin/slo` (`src/app/admin/slo/page.tsx`, `slo.module.css`); every objective shows "Provisional, not approved" |
| Migration | `src/lib/controlplane/db/migrations/0043_slo_measurements.ts`, registered in `migrations/index.ts` |
| Docs | `docs/platform/operations/SLO.md`, README row, `SOURCE_SNAPSHOTS` pin in `tests/docs/operator-docs.test.ts` |
| Tests | `tests/slo/definitions.test.ts`, `sli-budget.test.ts`, `slo-artifacts.test.ts`, `slo.engine.test.ts` |

Design choices: error budget history is kept in `platform.slo_samples` (5-minute buckets, additive per-process deltas, 35-day prune) so it works without a metrics backend and across instances. Dispatch latency excludes operations that required approval. Workflow completion cannot yet separate tenant-caused failures (stated in the definition). States are honest: `no_data`, `not_measured` and `unavailable` exist, and RPO, RTO and capacity are never "met" without a recorded measurement.

## 2. Acceptance mapping

| Clause | Implementation | Tests |
|---|---|---|
| Measurable availability / latency / capacity / RPO / RTO objectives defined | `slo-definitions.json` with the defaults 99.5%, p95 < 500 ms, RPO 900 s, RTO 14400 s, plus dispatch, workflow, scheduler and capacity objectives | `definitions.test.ts` |
| ...and tested | SLI math, budgets, burn alerts, durable windows, hooks, report | `sli-budget.test.ts`, `slo.engine.test.ts` |
| Provisional targets separated from accountable approval | `approval: not_approved / DEC-BUSINESS`; validator refuses approver fields; report, API body, page, alerts and guide all say "Provisional, not approved" | `definitions.test.ts` (refusals), `slo.engine.test.ts` (report labels), `slo-artifacts.test.ts` (alert labels and annotations, guide wording) |
| SLIs from OTel metrics and durable records | `sli.ts`, `recorder.ts`, `store.ts` | `sli-budget.test.ts`, `slo.engine.test.ts` ("samples", "durable operation indicators") |
| Error budgets and burn-rate alerts (deploy/observability) | `budget.ts`, `zenith-slo.rules.json` | `sli-budget.test.ts` (burn rules), `slo-artifacts.test.ts` (thresholds equal factor x budget, metrics exist in the catalog, runbook anchors exist) |
| RPO/RTO measurement hooks restore rehearsals report into | `recovery.ts`, internal route, `report-recovery.mjs`, append-only `slo_measurements` | `slo.engine.test.ts` ("RPO, RTO and capacity hooks", routes), `slo-artifacts.test.ts` (script and server arithmetic agree) |
| Capacity test script runnable on the verifier's machine, no new deps | `scripts/slo/capacity-test.mjs` | `slo-artifacts.test.ts` (summarise, never-pass-empty, `--self-test` end to end) |
| Operator report page/API with SLI vs provisional target | `report.ts`, `/api/admin/ops/slo`, `/admin/slo` | `slo.engine.test.ts` ("operator report", "routes") |

## 3. Verification commands (other machine, Node 22)

```
npx tsc --noEmit -p .
npx eslint src/lib/slo src/app/admin/slo src/app/api/admin/ops/slo src/app/api/internal/slo src/lib/ops/sampler.ts tests/slo

# pure, no database: expected all pass
npx vitest run tests/slo/definitions.test.ts tests/slo/sli-budget.test.ts tests/slo/slo-artifacts.test.ts

# real engine: PGlite always, plus PostgreSQL when set (expected all pass on both lanes)
npx vitest run tests/slo/slo.engine.test.ts
ZENITH_TEST_PLATFORM_PG_URL=postgres://... npx vitest run tests/slo/slo.engine.test.ts

# docs pin and sibling suites that touch the edited sampler
npx vitest run tests/docs/operator-docs.test.ts tests/ops

# the generator itself, no vitest
node scripts/slo/capacity-test.mjs --self-test            # expect {"selfTest":"passed"}, exit 0
node scripts/slo/report-recovery.mjs --dry-run --failure-at 2026-10-07T10:00:00Z --data-through 2026-10-07T09:56:30Z --restored-at 2026-10-07T10:42:10Z   # rpoSeconds 210, rtoSeconds 2530

# manual capacity run against a local `next start` (GET only, loopback only)
node scripts/slo/capacity-test.mjs --url http://127.0.0.1:3000 --path / --concurrency 16 --duration 20
```

Optional rule syntax check where Prometheus tooling exists: `promtool check rules deploy/observability/alerts/zenith-slo.rules.json`.

## 4. Known gaps, risks and shared-file updates for the assembler

Known gaps:
- Migration 42 is absent in this branch (sibling wave-5 worker); the registry has a hole until the assembler fills it. If the migration loader asserts contiguity, opening a store on this branch alone will fail until assembly.
- Availability is what the API itself observed. An outage that stops requests arriving leaves no samples; an external uptime probe (`/api/internal/tick/status?strict=1`) is the guide's answer, not something built here.
- No restore rehearsal exists yet (PROD-OPS-04 is not in this base). The hook is built and tested with synthetic instants only; RPO, RTO and capacity show "Not measured yet" until something reports.
- The capacity figure is machine-local. No production topology number exists and none is claimed.
- Workflow completion counts tenant-caused failures as failures (documented in the definition).
- The `/admin/slo` page has no link from the existing waitlist-oriented admin shell (different operator set: `ZENITH_OPS_ADMIN_IDS`); reach it by URL.
- Things that may break first: engine test deltas on a shared PostgreSQL (assertions are `>=` there, exact on PGlite); the `update platform.operations` seeding in `slo.engine.test.ts` assumes no check constraint ties `started_at` to status; `tests/ops/store.engine.test.ts` now also runs `flushSloSamples` through `sampleControlPlane` (best effort, swallowed on failure) and needs migration 43 only for the samples to land.

Shared-file updates for the assembler:
- Migrations inventory: version 43 `slo_measurements`, tables `platform.slo_samples`, `platform.slo_measurements` (append-only trigger `slo_measurements_immutable`), regenerate emit-sql / `supabase/migrations`, `scripts/ci/apply-supabase-migrations.sh`, `DEPLOYING.md`, `tests/controlplane/migrations.test.ts`.
- Tenancy classification (`tests/controlplane/tenancy.test.ts` / controlplane-sql-scoping): the store functions are not in `repos` (like `ops/store.ts`). All are SYSTEM, no workspace id: `addSamples`, `sampleWindows`, `pruneSamples` (counts per SLI name), `recordMeasurement`, `listMeasurements` (platform evidence), `workflowCompletionWindows`, `dispatchLatencyWindows` (aggregate counts over `platform.operations` across all workspaces; no id, payload or principal returned).
- `src/lib/sensitivedata/inventory.ts` (OPS-06 guard): add `platform.slo_samples` (owner `ops/slo (OPS-01)`, classification operational, retention operational "35 days, pruned by flushSloSamples", columns: counts only) and `platform.slo_measurements` (operational, immutable append-only, `recorded_by` is an operator or runner label; `details` holds fixed numeric/ISO/short-token fields).
- Gate manifest: add `tests/slo/*.test.ts` to the unit lane and `tests/slo/slo.engine.test.ts` to the engine lane (it follows the `LANES` pattern, no extra env).
- Route inventory/count test: two API routes (`/api/admin/ops/slo`, `/api/internal/slo/measurements`) and one page (`/admin/slo`) added; the two API routes are not in any middleware allow-list change (the admin route is operator-session gated, the internal route is CRON_SECRET gated like the other tick routes).
- `docs/LIMITATIONS.md`: add the gaps above (provisional and unapproved targets; machine-local capacity; no live restore rehearsal measurement; availability excludes requests that never arrive).
- Optional: add `alerts/zenith-slo.rules.json` to whatever deploy step imports the other rule file.

No verified behaviour was changed. The only edit to an existing runtime file is the one `await flushSloSamples(sql)` line (plus its import) in `src/lib/ops/sampler.ts`, after the store-up gauge is set; it never throws.

## 5. Suggested ledger implementationStatus

`built_unverified: provisional (unapproved, DEC-BUSINESS pending) SLO definitions, SLIs from OPS-02 metrics and durable rows, durable error budgets and burn-rate alerts, RPO/RTO/capacity measurement hooks (migration 43), capacity test script and operator report page/API. No restore rehearsal or production-topology capacity measurement exists yet.`

## L1-LIVE-AWS provider slice (8 October 2026)

Acceptance: Measurable availability/latency/capacity/RPO/RTO objectives defined and tested, with provisional targets clearly separated from accountable approval.

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

Acceptance contract: Measurable availability/latency/capacity/RPO/RTO objectives defined and tested, with provisional targets clearly separated from accountable approval.

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
node scripts/ci/wave6-gates.mjs --requirement PROD-OPS-01 --print > /tmp/zenith-wave6-PROD-OPS-01.commands.json
```

This prints the exact argv for each contract batch and required engine case, its gate names, private prerequisites, and its strict report-validation command. Set only the gates for the selected lane after preparing its owned fixture; a skip cannot satisfy that lane. Run each `argv` sequentially and then its `verify` argv. [Final integration setup and results](FINAL-INTEGRATION.md), [canonical inventory](../../../../scripts/ci/wave6-gates.json), [owner live runbook](../LIVE-ACCEPTANCE.md).


## Service-level decision (DEC-BUSINESS, 2026-10-13)

Branch `prod/dec-slo`. Build only; no live deployment was touched. Owner decision: launch service-level TARGETS, engineering targets and not a contractual SLA (no service credits; a contractual Enterprise SLA is later, after production verification).

What changed:

- Approval model: `deploy/slo/slo-definitions.json` is `definitionVersion 2026-10-13.1`, `approval.status: approved_targets` (approvedBy Arnav Bule, approvedAt 2026-10-13, `commitment: engineering_target`), every objective `status: target`. `src/lib/slo/definitions.ts` still accepts the old `not_approved` plus `provisional` shape, refuses mixed files, per-objective approval fields and objective text that claims a service credit, contract or guarantee, and accepts an optional `nextMilestone` (99.99%, aspiration, never evaluated).
- Targets: control-plane availability 0.999 (request-based AND external probe, lower of the two); new `managed_runtime_availability` 0.999; dispatch latency measured from the last required approval; RPO and RTO "for explicitly covered data", RTO not an allowance under availability. Burn alert thresholds are now 0.0144 / 0.006 / 0.001.
- External probe: `POST /api/internal/slo/measurements` accepts `kind: external_probe` (five-minute aligned window, good, total; bucket replaced so it is idempotent) stored as SLI `external_probe_availability`. No platform migration. The report names both ratios and says "External probe not reporting; request-based measurement cannot see outages that stop requests arriving." while no probe sample exists.
- Managed runtime: `onRuntimeObserved` reconcile port (`src/lib/reconcile/core.ts`, called after the pass commits) is wired in `src/lib/reconcile/platform/index.ts` to `recordManagedRuntimeHealth` (`src/lib/slo/recorder.ts`): one sample per zenith `k8s:Deployment` in a production environment; unknown health is counted under `managed_runtime_unknown`, not in the ratio.
- Dispatch latency: `dispatchLatencyWindows` joins the last approve decision in `platform.approvals` (same workspace and operation); approved or queued operations already late by more than 30 s count as misses.
- Restore tooling: `targetsFromEnv` defaults to the approved RPO/RTO (900 / 14400); env values override and are labelled provisional.

The Mac verifier should run, sequentially on Node 22: `npx tsc --noEmit -p .`; `npx vitest run tests/slo tests/ops/recovery-manifest.test.ts tests/ops/data-plane-independence.test.ts tests/docs/operator-docs.test.ts tests/ci/packaged-workers.test.ts --no-file-parallelism --maxWorkers=2`; `ZENITH_TEST_PLATFORM_PG_URL=postgres://... npx vitest run tests/slo/slo.engine.test.ts` (real PostgreSQL lane for the dispatch join); the reconcile suites that build ports (`npx vitest run tests/reconcile`). Then, on a deployment: wire an external probe per SLO.md, confirm `/admin/slo` shows both availability sources, and confirm a managed production environment accumulates `managed_runtime_availability` samples after a reconcile pass. Status stays `implementation_complete_verification_pending`.

## OPS-01 objectives measured on the live AWS sandbox (2026-10-30)

Run [41065148794](https://github.com/saivedant169/zenith/actions/runs/41065148794), run id `zlive-202610301340-1940`, workflow `live-acceptance.yml`, scenario `ops-04` (which measures PROD-OPS-01 and proves PROD-OPS-04), lane `live2`. Source `2cdb66db6343469eebde92fb48e8ee0f808064d3`. Sandbox account `361646636162` in ap-south-1. Plan digest `702f7014ef5b3c16e6e21fc02e68153295615dd2e6c27fcbb711fe7d3c9e14d9`; permission digest `b40c86f0c03e6deabfd8c57174d615224f7110b0394f28f34b0767502a1fa3fa`.

Verdict `passed`: 2 passed, 0 failed, 0 pending. Cleanup complete. Estimated cap USD 0.75 (provisional, billing not measured), 50 minute window. Files: `evidence/PROD-OPS-01/2026-10-30-live-aws-41065148794/`.

Measured against `deploy/slo/slo-definitions.json` (`approved_targets`, 2026-10-13):

- Control-plane availability: 6414 of 6414 runner-local probes of the API readiness route, every 100 ms, were non-5xx. The 95% lower bound is 99.95% against the 99.90% target: demonstrated. Probes paused only for the deliberate database loss (13 s), which is measured as RTO.
- API latency: p50 13 ms, p95 27 ms, p99 104 ms. 100% within 500 ms; the lower bound is 99.95% against 95%: demonstrated.
- Capacity: 29.9 req/s served of 30 offered for 60 s, p95 252 ms, 0.00% errors. Targets: at least 25 req/s, p95 at most 500 ms, errors at most 0.5%. Within target.
- RPO 204.052 s of 900 and RTO 20.733 s of 14400, one restore observation each. Within target.
- Not evaluated by this run: `managed_runtime_availability`, `dispatch_latency`, `workflow_completion`, `scheduler_health`.

Fixes that led here: PR #119 added the measurement to the ops-04 scenario. Its first run (41042309255) failed capacity: 9.2 req/s served, p95 5002 ms, 66.50% errors, and availability 99.82%. Every request without a session loaded every tenant's rows. PR #120 makes such a request load no tenant rows when auth is configured. A second run (41060350720) stopped OPS-04 at the fresh approval with an unconfirmed plan dispatch (`plan_artifact_unavailable`); the unchanged rerun above passed. PR #121 adds a values-free trace for that refusal.

Limits: `operational_rehearsal` is not done. The probes run on the same CI runner as the stack, so they measure the stack, not a network path. The latency and capacity numbers come from one 60 s burst on one small runner. `evidence.json` is not a `zenith.release-evidence.v1` receipt. Status stays `in_progress`. Not a promotion.
