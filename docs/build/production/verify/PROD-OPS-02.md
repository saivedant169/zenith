> Assembly note (wave 4): this migration was authored as version 41 and is registered as version 38 in `prod/compose` (aggregate `0023_platform_core.sql`). Read "41" below as 38; the file is now `0038_fair_bounded_control_plane.ts`.

# PROD-OPS-02 Fair bounded control plane

Branch `prod/ops-02-w4`, base `c9a942d6`. Platform migration `41` (`0038_fair_bounded_control_plane`). Build only: nothing here has been
run by the builder except `tsc --noEmit` and `eslint` (both clean on the changed files). Operator guide and runbooks:
`docs/platform/operations/CONTROL-PLANE-FAIRNESS.md`. Dashboards and alerts: `deploy/observability/`.

## 1. Summary of what was built

New module `src/lib/ops/` (all of it reachable from real callers, none opt-in):

| File | Role |
|---|---|
| `errors.ts` | `BackpressureError` (code, layer, tenant, `retryAfterSec`), 429 for the caller's own quota, 503 for platform or operator shedding, `backpressureResponse` with `Retry-After` |
| `token-bucket.ts` | per-key token buckets, bounded key table (evict only refilled buckets, else shared overflow bucket) |
| `concurrency.ts` | global and per-tenant in-flight gates; refuse, never wait; abandoned leases reclaimed |
| `fair-queue.ts` | `WeightedFairQueue` (stride scheduling, bounded per tenant and total) and `FairSemaphore` (bounded wait, bypass instead of fail) |
| `config.ts` | every limit as a bounded env var, malformed values fall back and are reported |
| `maintenance.ts` | `off / dispatch_paused / read_only` policy, control lanes, read-only exemptions, `MaintenanceCache` (single flight, timeout, last-known on failure) |
| `store.ts` | SQL over the three new tables, counts and drain status (not part of `repos`, see section 4) |
| `runtime.ts` | process-wide runtime, quota cache, effective maintenance state |
| `admission.ts` | `beginRequest` (used by `route()`), `bindRequestWorkspace` (platform API), `assertDispatchAdmitted` (before the claim) |
| `edge.ts` | coarse edge shield for `middleware.ts` (edge-runtime safe) |
| `queue-bound.ts` | bounded runner job queue, enforced inside `jobs.enqueue` |
| `worker-gate.ts` | Temporal activity interceptor: weighted-fair permits for heavy activities |
| `sampler.ts` | sampled gauges (queue depth, active operations, maintenance, store up) and worker weight refresh |
| `operator.ts` | platform-operator authorization (`ZENITH_OPS_ADMIN_IDS`), store access, error mapping |
| `telemetry/metrics.ts`, `catalog.ts`, `tracing.ts`, `otlp.ts` | dependency-free OpenTelemetry-compatible metrics, W3C tracer, OTLP/HTTP JSON exporter, metric catalog |

Wiring into existing files (all additive, one to a few lines each):

- `src/middleware.ts`: `edgeAdmit` after the hosted rewrite and static-path return, before any gate.
- `src/lib/server/request.ts` `route()`: `beginRequest`, workspace quota, `traceparent` response header, `finish`.
- `src/lib/server/errors.ts` and `src/app/api/platform/v1/_lib/http.ts`: `BackpressureError` answers 429/503 + `Retry-After`.
- `src/app/api/platform/v1/_lib/principal.ts` `callerOf`: applies the bearer/named workspace quota via `bindRequestWorkspace`.
- Dispatch, BEFORE the claim: `src/lib/bridge/lifecycle.ts` (deploy), `src/lib/bridge/destroy.ts`, `src/lib/portability/start.ts`,
  `src/lib/agent-access/v3/tools/execute.ts` (MCP execute, returns a retryable `dispatch_backpressure`).
- `src/lib/controlplane/db/repos/jobs.ts` `enqueue`: `assertRunnerQueueRoom`.
- `src/lib/controlplane/db/migrations/0038_fair_bounded_control_plane.ts` and its registration in `migrations/index.ts`.
- `workers/execution/run.ts` (activity interceptor), `worker.ts` (telemetry export, sampler, weights), `health.ts` (`/metrics` on the loopback listener).
- `src/lib/log.ts`: `traceId` on every log line inside a span.
- Routes: `src/app/api/admin/ops/maintenance/route.ts`, `src/app/api/admin/ops/quotas/route.ts`, `src/app/api/internal/metrics/route.ts`.
- Docs and exports: `docs/platform/operations/CONTROL-PLANE-FAIRNESS.md` (linked from the operations README),
  `deploy/observability/{README.md, grafana/*.dashboard.json, alerts/*.rules.json, otel/collector.json}`.
- `tests/docs/operator-docs.test.ts`: one new `SOURCE_SNAPSHOTS` pin for the new guide.

Execution core untouched: `execution.ts`, `destroy.ts`, broker, dispatch core, `ports.ts`, `failures.ts`, `housekeeping.ts`, `start-intent.ts` and all
workflow definitions are unmodified. The one place an admission hook sits near them is the four dispatch entry points above, deliberately
BEFORE `beginExecution`, so a refusal can never leave a claimed operation and cannot turn into `uncertain`.

Database objects (migration 38): `platform.ops_maintenance` (single `global` row), `platform.ops_maintenance_history` (append-only trigger),
`platform.tenant_quotas`, index `runner_jobs_ws_queued`. RLS enabled, no anon/authenticated grants, service role only.

## 2. Acceptance mapping

Acceptance (ledger): "Backpressure/fair tenant scheduling/bounded queues/maintenance controls and correlated OpenTelemetry dashboards/alerts;
workloads keep serving during control-plane outage."

| Clause | Implementation | Tests |
|---|---|---|
| Backpressure: explicit 429/503 + Retry-After at API | `ops/errors.ts`, `ops/admission.ts beginRequest/bindWorkspace`, `ops/edge.ts`, `server/errors.ts`, `platform/_lib/http.ts` | `tests/ops/admission.test.ts`, `tests/ops/route-wiring.test.ts`, `tests/ops/token-bucket.test.ts` (error mapping), `tests/ops/maintenance.test.ts` (edge) |
| Per-tenant token buckets and concurrency quotas at API | `ops/token-bucket.ts`, `ops/concurrency.ts`, `ops/runtime.ts apiSpecFor`, `tenant_quotas` | `tests/ops/token-bucket.test.ts`, `admission.test.ts` ("rate limits ONE workspace", "caps one workspace's concurrent requests", "applies a tenant's quota override"), `route-wiring.test.ts` |
| Per-tenant limits at dispatch | `ops/admission.ts assertDispatchAdmitted` (bucket + active-operation quota), hooks before the claim in 4 entry points | `admission.test.ts` (dispatch block), `store.engine.test.ts` ("refuses the START of new work ... at its active-operation quota") |
| Weighted-fair scheduling across tenants for runner and Temporal work | `ops/fair-queue.ts` stride queue, `ops/worker-gate.ts` interceptor wired in `workers/execution/run.ts`; runner queues are per-workspace by construction (documented) | `tests/ops/fair-queue.test.ts` (proportional service, no banked credit, bounded, semaphore order, bypass, abort, gate lanes) |
| Bounded queues, no unbounded in-memory buffers | in-flight gates refuse; fair queue bounded; token-bucket table bounded; span ring drops oldest; metric series capped; runner queue bounded in `jobs.enqueue` | `token-bucket.test.ts` (bounded table, lease reclaim), `fair-queue.test.ts` (hard bounds), `telemetry.test.ts` (series cap, ring), `store.engine.test.ts` ("bounded runner queue") |
| Maintenance mode: admin-controlled, read-only API, pauses new dispatch, drains safely | `ops/maintenance.ts`, `ops/store.ts`, routes `admin/ops/maintenance`, enforcement in `route()` and `assertDispatchAdmitted`, drain status | `maintenance.test.ts` (policy, exemptions, cache), `admin-routes.test.ts` (operator-only, same-origin, versioning, live effect), `store.engine.test.ts` ("pauses new dispatch", "lets in-flight work finish during maintenance", drain status) |
| Correlated OTel traces and metrics with tenant + operation | `ops/telemetry/*`; span attrs `zenith.tenant.id`, `zenith.operation.id`, `zenith.operation.class`; metrics `tenant` label; `traceparent` in and out; `traceId` in logs | `telemetry.test.ts`, `admission.test.ts` (span attributes, operation id from path, traceparent) |
| Exported dashboard and alert definitions (JSON under deploy/observability) | `deploy/observability/**` | `tests/ops/observability-artifacts.test.ts` (valid JSON, metrics and labels exist in the catalog, runbook anchors exist) |
| Documented guarantee: data plane does not depend on control-plane availability | `docs/platform/operations/CONTROL-PLANE-FAIRNESS.md` "Data-plane guarantee" with what is and is not claimed | `tests/ops/data-plane-independence.test.ts` (hosted rewrite is upstream of admission, no import path from data-plane trees, control lanes survive overload and maintenance, importer inventory) |

## 3. Verification commands (other machine)

Node 22. No new dependencies. Run `npm ci` only if the lockfile moved.

```
npx tsc --noEmit -p .
npx eslint src/lib/ops src/app/api/admin/ops src/app/api/internal/metrics tests/ops workers/execution src/lib/server src/middleware.ts

# Pure and in-process (no database): expected all pass
npx vitest run tests/ops/token-bucket.test.ts tests/ops/fair-queue.test.ts tests/ops/maintenance.test.ts tests/ops/telemetry.test.ts \
  tests/ops/admission.test.ts tests/ops/route-wiring.test.ts tests/ops/data-plane-independence.test.ts tests/ops/observability-artifacts.test.ts \
  tests/ops/admin-routes.test.ts

# Real engine: PGlite always; add PostgreSQL with the usual env
npx vitest run tests/ops/store.engine.test.ts
ZENITH_TEST_PLATFORM_PG_URL=postgres://... npx vitest run tests/ops/store.engine.test.ts
# the maintenance-row cases flip a process-global row, so on PostgreSQL they run only against an exclusively owned database:
ZENITH_TEST_PLATFORM_PG_URL=postgres://... ZENITH_TEST_OPS_EXCLUSIVE_PG=1 npx vitest run tests/ops/store.engine.test.ts

# Suites that touch what was modified (regression)
npx vitest run tests/middleware tests/api tests/runners tests/controlplane tests/workers tests/workflows/config.test.ts tests/docs tests/bridge tests/agent-v3 tests/portability tests/server
```

Expected: all pass, with these deliberate exceptions until the assembler runs:

- `tests/controlplane/migrations.test.ts` "has contiguous versions from 1" fails while versions 30 to 40 are absent from the registry (migration 38 is
  registered alone, as assigned). The assembler's `0022_platform_core.sql` composition fills the range.
- `PLATFORM_SCHEMA_VERSION` is 41 after this branch alone; checksum, ledger and emitted SQL files are the assembler's.

Cases that skip with an explicit reason: PostgreSQL lane when `ZENITH_TEST_PLATFORM_PG_URL` is unset; the maintenance-row cases on shared PostgreSQL unless
`ZENITH_TEST_OPS_EXCLUSIVE_PG=1`. Skips are not passes.

Operational rehearsal (staging, not run, never counted as passed): the four-step script at the end of "Data-plane guarantee" in the guide.

## 4. Known gaps, risks, and shared-file updates the orchestrator must make

Things that may break first:

1. `route()` now runs admission for every API route. Defaults (per workspace 50 req/s burst 200, 16 concurrent, process 256 in flight) are generous but any test
   or client that hammers one workspace harder than that will see 429. All are env knobs. A test that sets `ZENITH_PLATFORM_DB*` at a real Postgres makes
   `route()` read `platform.ops_maintenance` (cached 2 s); on a database that has not applied migration 38 that read fails and is treated as "no maintenance".
2. `tests/docs/operator-docs.test.ts` guide-set checks walk `docs/platform/operations/`: the new guide has the required branch/commit header, a README link and a
   `SOURCE_SNAPSHOTS` pin (`prod/ops-02-w4`, `c9a942d`). If the assembler renames the branch, update both.
3. Real Temporal behaviour of the activity interceptor was not run (no Temporal on the building machine). It uses the documented `interceptors.activity` factory
   and `ctx.info.activityType`; the unit tests drive the gate directly. Run one worker integration test (for example `tests/workflows/codec-replay.test.ts`, which
   builds a worker through `workerOptions`) to see it load.
4. The tenant label on API metrics is the resolved workspace id. For a bearer integration it is bound in `callerOf` (inside the handler), so a refused bearer call
   is refused after authentication but before any broker work.
5. Per-process state: buckets and gates are per process (edge: per isolate). The active-operation quota and runner queue caps are database-backed and global.

Shared-file updates for the assembler (I did not touch these):

- Migrations inventory: version 38 `fair_bounded_control_plane`, tables `ops_maintenance`, `ops_maintenance_history`, `tenant_quotas`, index `runner_jobs_ws_queued`;
  re-emit supabase SQL, `scripts/ci/apply-supabase-migrations.sh` expected versions, `docs/platform/operations/DEPLOYING.md` migration list,
  `tests/controlplane/migrations.test.ts` checksums.
- `docs/platform/operations/DEPLOYING.md`: document the new `ZENITH_OPS_*`, `ZENITH_MAINTENANCE_*`, `ZENITH_WORKER_FAIR_*`, `ZENITH_OTEL_*` variables
  (full table is in the new guide). The env-documentation test only scans the platform module roots, and none of the new names appear in them (they live in
  `src/lib/ops`), so the test passes without it; add them for operators anyway.
- Store functions and tenancy classification for `tests/controlplane/tenancy.test.ts` / SQL scoping. They are NOT exported from `repos/index.ts` (so the
  bound-repo completeness guard is unchanged); each takes `Sql` first:
  - SYSTEM (single global row, no tenant data): `getMaintenance`, `setMaintenance`, `maintenanceHistory`.
  - WORKSPACE-BOUND (every statement filters `workspace_id`): `getTenantQuota`, `putTenantQuota`, `deleteTenantQuota`, `activeOperationCount`, `queuedJobCount`
    (its second figure is a global count by design, used only for the global cap).
  - SYSTEM operator reads (rows carry their workspace id, counts only): `listTenantQuotas`, `drainStatus`, `queueDepths`.
  If you prefer them in `repos`, add them to `bindRepos` and to the `WRITES`/`SWEPT`/`EXEMPT` sets with these classifications.
- `jobs.enqueue` gained a call to `assertRunnerQueueRoom` (reads `tenant_quotas` and counts queued jobs, per enqueue); the existing tenancy sweep classification of
  `jobs.enqueue` as a workspace-bound write is unchanged.
- Gate manifest / workflows: add `tests/ops/**` to the node lane (no special env), and `tests/ops/store.engine.test.ts` to the PostgreSQL lane
  (`ZENITH_TEST_PLATFORM_PG_URL`, optionally `ZENITH_TEST_OPS_EXCLUSIVE_PG=1` on an exclusively owned database).
- `docs/LIMITATIONS.md`: see the limits listed at the end of the guide ("Known limits") and below.

Limitations to record:

- No live acceptance: nothing was imported into Grafana, Prometheus or an OTel collector; no Temporal-backed fairness run; no staging rehearsal of read-only
  maintenance or a control-store outage. `requiredEvidence` live_sandbox and operational_rehearsal remain open.
- Fairness inside Temporal is bounded delay at the worker plus the dispatch quota; it does not reorder tasks already in the Temporal server queue. Per-tenant
  task-queue partitioning was designed out for rollout safety (mixed-version workers would strand workflows) and is not built.
- Operation-bound runner jobs are intentionally not refused at the tenant queue cap (refusal mid-operation would end a mutating step `uncertain`); they are
  bounded by the active-operation quota and a 4x-global hard ceiling.
- Reconcile auto-repair, scheduled runbooks and cron ticks are not paused by dispatch pause (they are the drain's recovery path).
- The edge shield cannot read the database; DB-stored read-only maintenance is enforced in `route()` and at dispatch, the edge enforces only the host override.
  MCP, waitlist and signed agent endpoints are not under `route()`: they get the edge shield and, for what they start, dispatch admission.
- `route_class` and tenant labels are bounded (series cap, 200 tenant labels) but a path scanner can still fill a metric's series budget; overflow folds into
  `_overflow` and is counted in `zenith_telemetry_dropped_total`.

## 5. Suggested ledger implementationStatus

`implemented_contract_tested: per-tenant token-bucket and concurrency limits at the API edge, route() and dispatch (before claim), active-operation quota, bounded runner job queue, weighted-fair worker activity scheduling, operator maintenance mode (dispatch_paused/read_only, drain status, host override), dependency-free OTel-compatible metrics/traces/OTLP export with tenant and operation correlation, exported Grafana/Prometheus/collector JSON, documented data-plane guarantee; unit, PGlite and optional PostgreSQL tests only, no live sandbox or operational rehearsal`


## L1-LIVE-AWS provider slice (8 October 2026)

Acceptance: Backpressure/fair tenant scheduling/bounded queues/maintenance controls and correlated OpenTelemetry dashboards/alerts; workloads keep serving during control-plane outage.

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

Acceptance contract: Backpressure/fair tenant scheduling/bounded queues/maintenance controls and correlated OpenTelemetry dashboards/alerts; workloads keep serving during control-plane outage.

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
node scripts/ci/wave6-gates.mjs --requirement PROD-OPS-02 --print > /tmp/zenith-wave6-PROD-OPS-02.commands.json
```

This prints the exact argv for each contract batch and required engine case, its gate names, private prerequisites, and its strict report-validation command. Set only the gates for the selected lane after preparing its owned fixture; a skip cannot satisfy that lane. Run each `argv` sequentially and then its `verify` argv. [Final integration setup and results](FINAL-INTEGRATION.md), [canonical inventory](../../../../scripts/ci/wave6-gates.json), [owner live runbook](../LIVE-ACCEPTANCE.md).

## Tenant fairness, alerting and control-plane outage proven on the live AWS sandbox (2026-10-31)

Run [41183967350](https://github.com/saivedant169/zenith/actions/runs/41183967350), run id `zlive-202610310816-33a9`, workflow `live-acceptance.yml`, scenario `ops-02`, lane `live2`. Source `ce8317ae9585384337706333c2d85f6fc4a95086`. Sandbox account `361646636162` in ap-south-1. Plan digest `a009b6ec647537d8b64ffb4f119e7b84be974294971e1dae4804bc15099a245f`; permission digest `278fddf52134ed18d527d05624af49693f11331bda6bb363b5d40733951bd651`.

Verdict `passed`: 1 passed, 0 failed, 0 pending. Cleanup complete. Estimated cap USD 2.8 (provisional, billing not measured), 60 minute window; the scenario took about 15 minutes. Files: `evidence/PROD-OPS-02/2026-10-31-live-aws-41183967350/`, including the `zenith.release-evidence.v1` receipt `release-evidence-PROD-OPS-02.json`.

What the run checked (`scripts/acceptance/live/product/deploy-01.ts` ops-02 flow, `ops-02-stack.ts`):

- The repository's alert rules (`deploy/observability/alerts/`) were loaded into the pinned Prometheus image, scraping the API's `/api/internal/metrics` with a run-scoped bearer secret.
- One tenant sent 600 requests 40 at a time and was refused 162 times (HTTP 429). A second tenant's 20 concurrent requests were all served (p95 3635 ms).
- The dashboard's tenant-filtered refusal panel query showed 156 refusals for the flooding tenant and none for the quiet one.
- A pinned nginx image on ECS Fargate behind an ALB served all 213 HTTP probes (one a second) through a 260 s control-plane outage. The control store stopped first (`ZenithControlStoreDown` fired after 150 s), then the API and worker stopped for 61 s.
- After the restart the store reported up and the tenant was served again.

Fixes found on the way: the browser's six-connection cap hid the flood (burst now sent from Node, PR #139); a stopped store hung the metrics sample past the scrape timeout (sample bounded at 2 s, PR #140).

Limits: traces in a trace backend, worker-side metrics, Grafana UI import (proven locally by the import harness) and Temporal-backed fairness are not covered. `operational_rehearsal` is not done. Status stays `in_progress`. Not a promotion.

## Contract and local engine receipts at the live run's commit (2026-11-01)

Source `ce8317ae`, the commit of this requirement's `live_sandbox` receipt, so the levels share one commit. Each lane ran on a clean detached checkout of that commit through `scripts/release/lane-source.mjs`, on a Mac mini (Darwin arm64) with Node 22.23.3. `scripts/release/evidence-cli.mjs` bound a `zenith.release-evidence.v1` receipt to each source.

- `contract`: 136 passed, 0 failed, 0 skipped over 11 test files, offline, no engine or network. Files: `docs/build/production/evidence/PROD-OPS-02/2026-11-01-contract-ce8317ae/`.
- `local_engine`: 34 passed, 0 failed, 0 skipped over 1 test files, against a disposable PostgreSQL 16.15 (pinned digest) migrated by the checkout's own migrator. Files: `docs/build/production/evidence/PROD-OPS-02/2026-11-01-local-engine-ce8317ae/`.


`operational_rehearsal` is still not done. Not a promotion.
