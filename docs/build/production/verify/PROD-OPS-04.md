# PROD-OPS-04 verification handoff: clean-host restore and recovery epochs

DRV-3 adds a dedicated operated J1/J2 restore with post-snapshot browser approval
consumption, three prewrite failure injections, fresh database, real recovery
epoch, browser continuation and independent provider/ledger readback. Run
`node scripts/ci/run-gate.mjs j15-operated-restore --run` after the exact lean Mac
preparation in [DRV-3](DRV-3.md); that document also has strict validation argv.
Not run here (needs actual PostgreSQL/Temporal, Docker, kind and Chromium).

Branch `prod/ops-04-w5`, base c02c097e. Platform migration **44**. Built without running any test (build-only rule): only
`tsc --noEmit` and `eslint` on the changed files were run, both clean. Nothing here calls a cloud API; the rehearsal uses
real PostgreSQL (pg_dump/pg_restore) and, when its CLI exists, a Temporal dev server, both owned by the test.

Requirement: restore product/platform/agent/hosted/source stores, Temporal/artifacts/customer state and keys; consumed
approvals and mutations cannot resurrect; control-plane recovery is epoch-fenced (controlled epoch reconciliation and reopen
required). DUR-A left "operator continuation and recovery epochs" to this requirement.

## 1. What was built

### Recovery epoch (the fence)

`platform.recovery_epochs` (append-only, monotonic, durable) holds the epoch. `platform.current_recovery_epoch()` is the
DEFAULT of a new `recovery_epoch` column on `operations`, `approvals`, `durable_intents` and `external_effects`, so the
database stamps every row at insert. `platform.recovery_fence_floor()` (= epoch x 1e9 + 1) is the lowest fence token a lease
can receive, so a fence token carries its epoch. `bumpRecoveryEpoch` (one transaction, idempotent per restore run id, run by
the restore runbook and never from a request path) appends the next epoch and:

- expires every lease and lifts every fence counter to the new floor;
- turns every restored `running` operation `uncertain` (grants revoked, `operation.uncertain` event appended);
- turns every restored `pending` external effect `uncertain` (event `recovery_epoch`), leaves `accepted/uncertain/conflict`;
- turns claimed/dispatched saved-plan uses `uncertain`; revokes every unconsumed grant; cancels queued and times out
  claimed/running runner jobs and zenithd requests (outcome unknown, never re-queued);
- opens one `recovery_items` row per in-flight operation, intent and effect (with its prior state and the decisions allowed).

Every authority check now includes the epoch:

| Check | Change |
| --- | --- |
| `leases.acquire`, `acquireExecutionLease` insert | new lease starts at the floor; re-acquire is `greatest(fence + 1, floor)` |
| `approval-core.consumeApprovals`, `countUnconsumedApprovals`, `approvals.record` count | only current-epoch approvals count |
| `approvals.record` | refuses an operation stamped below the current epoch (`recovery_epoch_stale`) |
| `operations.claimForExecution` | refuses a stale operation before consuming anything (`recovery_epoch_stale`) |
| `outbox.claimDue`, `settleIntent` | only current-epoch intents; a pre-restore claim cannot settle |
| `outbox.adoptStartIntents`, `deriveApprovalSignals` | only for operations stamped with the current epoch |
| external effects | pending to uncertain at bump; `begin` already returns the existing effect, so nothing is re-created |

### Operator continuation

`src/lib/controlplane/recovery/index.ts`: `listRecoveryItems`, `getRecoveryItem`, `recoveryStatus`, `decideItem`.
A decision is bound to the exact subject state (`bindingDigest`), single-use, tenant-scoped and recorded with the human:

- operation `running` (now uncertain): `keep_uncertain` only;
- operation proposed/awaiting/approved/queued: `resume` = reopen with a FRESH approval round in the current epoch
  (approval_round + 1, `approval_required`, lease cleared; refused when a workflow start was already attempted or
  acknowledged, when effects of the operation are unresolved, or when it expired), `abandon` = `cancelOperation`;
- pending intent: `resume` re-stamps (delivery stays idempotent by intent id), `abandon` settles it `dead/superseded`;
- effect: `keep_uncertain` only (resolution stays the evidence-bound PROD-DUR-07 flow).

Reachability: `GET /api/platform/v1/recovery` (viewer, human-bound credentials allowed) and
`POST /api/platform/v1/recovery/items/:id/decide` (browser session, admin, human only; `bearer-paths.ts` classifies both),
through `src/lib/platform/recovery.ts` (composition with the broker's role resolver) and `recovery-service.ts`. CLI break-glass:
`npm run ops:recovery -- continue list|resume|abandon|keep`.

### Backup manifest and restore runbook

`src/lib/ops/recovery/`: `manifest.ts` (manifest, SHA-256 per file, self digest, `verifyBackupDirectory`), `backup.ts`
(`captureBackup`: one pg_dump under an exported snapshot together with row counts, schema version and epoch; file store
allowlist; hosted bundle; artifact index; Temporal inventory), `restore.ts` (`runRestore`: verify, gates, keys, empty target,
atomic pg_restore, forward migrate, count check, epoch bump, product/hosted/artifact placement, Temporal termination,
report), `process.ts` (no password on a command line, scrubbed output, injectable runner), `report.ts` (RPO/RTO from recorded
instants, provisional targets, `registerRecoveryMeasurementSink` extension point, JSON report). CLI `scripts/ops/recovery.ts`
(`npm run ops:recovery`): `backup`, `verify`, `restore`, `status`, `continue`. Runbook: `docs/platform/operations/RESTORE-RUNBOOK.md`.

Store coverage in the manifest: platform (captured, one dump with agent / product public / hosted schemas when they live in
the same database), source and plan artifacts (covered by the platform dump, tables listed), product file store (allowlisted
files), hosted (sealed ZBK1 bundle handed to `hosted:restore`, or the hosted schema), artifacts (index, bytes on request),
Temporal (open-workflow and namespace inventory, optional dev-server db file; open op workflows terminated at restore),
customer state (referenced: requires `--confirm-customer-state`), keys (OPS-05 key ids and roles, checked on the target host
before anything is restored).

### Files

New: `src/lib/controlplane/db/migrations/0044_recovery_epochs.ts`, `src/lib/controlplane/recovery/index.ts`,
`src/lib/platform/recovery.ts`, `src/lib/platform/recovery-service.ts`, `src/app/api/platform/v1/recovery/route.ts`,
`src/app/api/platform/v1/recovery/items/[id]/decide/route.ts`, `src/lib/ops/recovery/{manifest,process,backup,restore,report}.ts`,
`scripts/ops/recovery.ts`, `docs/platform/operations/RESTORE-RUNBOOK.md`, tests (section 3).
Changed: `migrations/index.ts` (register 44), `repos/leases.ts`, `repos/operations.ts`, `repos/approval-core.ts`,
`repos/approvals.ts`, `outbox/index.ts`, `_lib/bearer-paths.ts`, `package.json` (`ops:recovery`).

### Behaviour changes to verified code (explicit)

In epoch 0 (any database that was never restored) behaviour is identical: floors are 1, every stamp equals the epoch, every
`recovery_epoch = platform.current_recovery_epoch()` predicate is true. What does change: the SQL of `acquire`,
`acquireExecutionLease`, `consumeApprovals`, `countUnconsumedApprovals`, `approvals.record`, `claimForExecution`, `claimDue`,
`settleIntent`, `adoptStartIntents` and `deriveApprovalSignals` now calls `platform.current_recovery_epoch()` /
`recovery_fence_floor()`, so these functions require schema 44 (an N build on schema 43 already fails closed with
`schema_behind`; N-1 on 44 works because the columns default). Guard order is unchanged: the epoch checks sit inside the
existing authority/claim steps (quota, DUR-A, DUR-B, DUR-C, DUR-D, provider call).

## 2. Acceptance mapping

| Clause | Implementation | Tests |
| --- | --- | --- |
| Restore product/platform/agent/hosted/source stores | `captureBackup` + `runRestore` (one dump, per-component manifest status, file store allowlist, hosted bundle hand-off, atomic pg_restore, count verification) | recovery-manifest (integrity, gates), recovery-rehearsal (real pg_dump/pg_restore, count facts) |
| Temporal | inventory in the backup; `--terminate-temporal` kills the lost timeline's `op-*`/`reconcile-*` workflows | recovery-rehearsal "temporal" (real dev server) |
| Artifacts / customer state | artifact index (+ optional bytes) verified at restore; customer state `referenced` with explicit confirmation | recovery-manifest gates; rehearsal (artifact component `not_applicable`; index path is untested, see gaps) |
| Keys | manifest key ids; the target host must hold each before restore | recovery-manifest "lacks a key id", rehearsal keys refusal |
| Consumed approvals/mutations cannot resurrect | approval epoch stamp + claim/record refusal; effect pending to uncertain; intents held; leases fenced; grants and jobs closed | recovery-epoch (approvals, effects, intents, leases, grants), recovery-rehearsal (consumed-after-snapshot approval) |
| Epoch reconciliation/reopen required | `recovery_items` + `decideItem` (resume reopens with a fresh round, abandon, keep uncertain), CLI + API | recovery-epoch (continuation), recovery-service |
| RPO/RTO measurement | `report.ts`, restore report JSON, `status` continuation measurement | recovery-manifest "RPO / RTO measurement", rehearsal (measured values) |
| No privileged fallback / secrets | no password in argv or any artifact; browser-only human decisions; no destructive default (empty target only) | recovery-manifest "tool hygiene", rehearsal "writes no connection string" |

## 3. Verification commands (verifier machine)

Node 22. PGlite lane (no external services):

```
npx vitest run tests/ops/recovery-manifest.test.ts tests/platform/recovery-service.test.ts tests/controlplane/recovery-epoch.test.ts
```

Real PostgreSQL (needs a role with CREATEDB; the suites use scratch databases and never bump the shared platform schema):

```
ZENITH_TEST_PLATFORM_PG_URL=postgres://...:PORT/db npx vitest run tests/controlplane/recovery-epoch.test.ts
```

Rehearsal (real pg_dump/pg_restore of the server's major version; optional absolute `ZENITH_TEST_PG_DUMP_BIN` /
`ZENITH_TEST_PG_RESTORE_BIN`; Temporal part needs the CLI via `ZENITH_TEST_TEMPORAL_CLI` or PATH):

```
ZENITH_TEST_RECOVERY_REQUIRED=1 ZENITH_TEST_PLATFORM_PG_URL=postgres://...:PORT/db npx vitest run tests/ops/recovery-rehearsal.test.ts
```

Without the switch a missing prerequisite skips with the reason (never counted as a pass).

Regression of areas touched (must still pass unchanged):

```
npx vitest run tests/controlplane tests/capabilities tests/runners tests/platform tests/effects tests/ops tests/docs
```

Expected: all pass; the recovery rehearsal skips only when its prerequisites are absent and not required. Expected first
checks: the rehearsal's report shows epoch 3 (observed 2 + 1), counts `operationsMadeUncertain 1, operationsHeld 2,
effectsMadeUncertain 1, intentsHeld 1`, `continuation.opened 5`.

## 4. Known gaps, things that may break first, shared-file updates

Honest limits:

1. **Not run.** Likeliest first failures: PGlite accepting `lock table ... in exclusive mode` and data-modifying CTEs that
   feed a later CTE (`bumpRecoveryEpoch` effects step); `set transaction isolation level repeatable read` as the first
   statement of the backup transaction under the pooled executor; `pg_restore --single-transaction` ACL statements when the
   target server lacks a role present at the source (use `--no-privileges`); the Temporal CLI `workflow list --output json`
   shape (the parser accepts a JSON array; anything else records `openWorkflows: null`); the SQL id expression for
   `recovery_items` (`sha256(convert_to(...))`, same technique as the outbox).
2. **Post-snapshot work is invisible.** Operations, approvals and effects created after the backup are not in the restored
   database; the epoch cannot replay or see them. Providers may hold changes the ledger does not know. The runbook says to
   reconcile providers for the RPO window; no automation does it.
3. **Epoch collision across a lost live system** is avoided only when the operator supplies `--observed-epoch` or the backup
   manifest recorded it; with neither, the new epoch is one past the restored database's own. A stale worker of the lost
   system still cannot act on the restored database (it holds a token from a different timeline and the restored leases are
   all expired), but two restores from the same backup with no observed epoch reuse the same epoch number.
4. Item coverage: workflow-start intents are permanent tombstones and are covered through their operation (a `resume` is
   refused when a start was attempted); plan artifact uses, grants, runner jobs and zenithd requests are closed in bulk without
   per-item decisions; the signed-request nonce window (10 minutes) is not restored, so a request replayed inside it after
   a restore is not recognised (unchanged from RECOVERY.md section 4.6).
5. The hosted SQLite store restore is a hand-off to the existing `hosted:restore`/`hosted:reopen` (it needs its own data
   directory and `ZENITH_BACKUP_KEY`); the artifact-index placement and the product file store placement have no real-engine
   test in the rehearsal (the rehearsal declares both `not_applicable`).
6. Customer OpenTofu state is never copied; the restore needs an explicit human confirmation and verifies nothing about the
   customer bucket.
7. No UI page: the work list is an API and CLI surface. The browser decision endpoint exists and is classified browser-only.
8. RPO/RTO targets are provisional (OPS-01 is not in this base); verdicts compare only configured provisional targets.
9. Live cloud acceptance and any hosted-cluster restore rehearsal are not approved or performed.

Shared-file updates for the assembler:

- **Migrations inventory:** migration 44 `recovery_epochs` (expand-only: 2 tables, 2 functions, 4 defaulted columns, triggers);
  regenerate emitted SQL and the Supabase migration; `PLATFORM_SCHEMA_VERSION` expectations in
  `tests/controlplane/migrations.test.ts`; `scripts/ci/apply-supabase-migrations.sh`.
- **Sensitive-data inventory (`src/lib/sensitivedata/inventory.ts`):** `platform.recovery_epochs` (system-level, operational,
  append-only ledger; actor and reason are operator-supplied text of at most 200/500 characters, no secrets) and
  `platform.recovery_items` (workspace-owned, operational, ledger retention; `ref` is an operation/intent/effect id,
  `decided_by` a user id, `decision_reason` operator text). Existing tables gain a plain integer column `recovery_epoch`.
- **Tenancy classification:** no function was added to `db/repos`, so `tests/controlplane/tenancy.test.ts` is unaffected.
  Store functions in `src/lib/controlplane/recovery/index.ts`: workspace-scoped (every statement names `workspace_id`):
  `recoveryStatus`, `listRecoveryItems`, `getRecoveryItem`, `decideItem` (its cascades use `cancelOperation` and statements
  that name the workspace). System-level by design, listed for `controlplane-sql-scoping`: `bumpRecoveryEpoch` (a restore is
  one event for the whole database: leases, running operations, effects, plan uses, grants, runner jobs, zenithd requests,
  item inserts), `currentRecoveryEpoch`, `listRecoveryEpochs`, and `measureContinuation` in `src/lib/ops/recovery/report.ts`
  (operator view). The outbox sweeps remain cross-tenant exactly as before.
- **Gate manifest (`scripts/ci/gate-manifest.mjs`):** add `tests/controlplane/recovery-epoch.test.ts` (platform-postgres, needs
  CREATEDB), `tests/platform/recovery-service.test.ts` and `tests/ops/recovery-manifest.test.ts` (PGlite/unit lanes), and
  `tests/ops/recovery-rehearsal.test.ts` in a lane with PostgreSQL 16, matching pg_dump/pg_restore and the Temporal CLI, with
  `ZENITH_TEST_RECOVERY_REQUIRED=1`.
- **Route count:** two new platform routes (`GET /recovery`, `POST /recovery/items/[id]/decide`); `bearer-paths.ts` is already
  updated by this branch.
- **Docs:** `docs/platform/operations/RESTORE-RUNBOOK.md` is new. `RECOVERY.md` sections 3 and 4.6 are superseded in part
  (fence tokens are now monotonic across a restore, approvals no longer resurrect) and should link to it; that file has a
  committed guide-input pin checked by `tests/docs/operator-docs.test.ts`, so the assembler must update text and pin together.
  `docs/LIMITATIONS.md`: replace "operator continuation and recovery epochs remain open" and `PROD-DUR-01/02` note 4b with the
  status below; keep the post-snapshot-invisibility limit.
- `package.json` gained `ops:recovery`; the env names `ZENITH_RPO_TARGET_SECONDS`, `ZENITH_RTO_TARGET_SECONDS`,
  `ZENITH_PG_DUMP_BIN`, `ZENITH_PG_RESTORE_BIN`, `ZENITH_TEMPORAL_BIN` are read only by the recovery tooling.

## 5. Suggested ledger implementationStatus

`implementation_complete_verification_pending: recovery epoch (append-only, monotonic, stamped by the database, carried by
fence tokens) fences leases, approvals, execution claim, intents and effects; restore bump makes running work and pending
effects uncertain and opens operator-decided continuation items (API, browser-only decision, CLI); backup manifest with
per-file digests, atomic clean-host restore runbook with key, count and empty-target gates, RPO/RTO report; PGlite and real
PostgreSQL/Temporal rehearsal tests written, not run; live hosted/cloud restore and OPS-01 targets not performed.`

## L1-LIVE-AWS provider slice (8 October 2026)

Acceptance: Restore product/platform/agent/hosted/source stores, Temporal/artifacts/customer state and keys; consumed approvals/mutations cannot resurrect, controlled epoch reconciliation/reopen required.

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

Acceptance contract: Restore product/platform/agent/hosted/source stores, Temporal/artifacts/customer state and keys; consumed approvals/mutations cannot resurrect, controlled epoch reconciliation/reopen required.

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
node scripts/ci/wave6-gates.mjs --requirement PROD-OPS-04 --print > /tmp/zenith-wave6-PROD-OPS-04.commands.json
```

This prints the exact argv for each contract batch and required engine case, its gate names, private prerequisites, and its strict report-validation command. Set only the gates for the selected lane after preparing its owned fixture; a skip cannot satisfy that lane. Run each `argv` sequentially and then its `verify` argv. [Final integration setup and results](FINAL-INTEGRATION.md), [canonical inventory](../../../../scripts/ci/wave6-gates.json), [owner live runbook](../LIVE-ACCEPTANCE.md).

## OPS-04 restore on the live AWS sandbox (2026-10-30)

Run [41012192964](https://github.com/saivedant169/zenith/actions/runs/41012192964), run id `zlive-202610300606-05a2`, workflow `live-acceptance.yml`, scenario `ops-04`, lane `live2`. Source `546b63450cce6da1dca008b413eabe6ae1fac21d`. Sandbox account `361646636162` in ap-south-1. Plan digest `3e598da48d890700236146f81425a6de258897c987fdf99e06d87c6c6ef18316`; permission digest `74fe5188ed89f77ef00cdc2f6ed6a37db0739e801c37b0b04ebd7e90211c9a83`.

Verdict `passed`: 1 passed, 0 failed, 0 pending. Cleanup complete. Estimated cap USD 0.75 (provisional, billing not measured), 50 minute window. Files: `evidence/PROD-OPS-04/2026-10-30-live-aws-41012192964/`.

What it proved:

- A deploy waiting for its approval was captured in the control-plane backup. It was then approved and applied after the backup, so a second managed S3 bucket existed in AWS and in the recorded state.
- The stores were lost from the control-plane database and restored into it at recovery epoch 1.
- The restored proposal was fenced. An approval was refused (`journey:browser-human-approval`), and the proposal did not execute on its own for 120 s.
- It came back only through a recovery resume, where a stale binding was refused, and a fresh approval.
- Applying it again left AWS unchanged: 2 buckets, 16 recorded resources.
- Measured RPO 190 s (target 900) and RTO 19 s (target 14400).

Fixes that led here: PR #112 (values-free custody refusal trace) located the refusal at the write-once plan digest. PR #114 lets a proposal round reopened by a recovery resume, and decided before its workflow start, record its first plan; a plan-round approval made before plan stamping still cannot authorize a later plan.

Limits: `operational_rehearsal` is not done, and the requirement lists it as required. This is one environment with S3 buckets on one provider. `evidence.json` is not a `zenith.release-evidence.v1` receipt. Status stays `in_progress`. Not a promotion.

## Second OPS-04 run on the live AWS sandbox (2026-10-30)

Run [41065148794](https://github.com/saivedant169/zenith/actions/runs/41065148794), run id `zlive-202610301340-1940`, scenario `ops-04`, lane `live2`, source `2cdb66db6343469eebde92fb48e8ee0f808064d3`. Verdict `passed` with cleanup complete, on the same flow as run 41012192964. Measured RPO 204.1 s (target 900) and RTO 20.7 s (target 14400). The same run measured PROD-OPS-01; files are in `evidence/PROD-OPS-01/2026-10-30-live-aws-41065148794/`.

Run 41060350720, on the same source, stopped at the fresh approval: the resumed apply ended with an unconfirmed plan dispatch (`plan_artifact_unavailable`). Its cause is not yet known; PR #121 traces it if it recurs. Not a promotion.

## Contract and local engine receipts at the live run's commit (2026-11-01)

Source `2cdb66db`, the commit of this requirement's `live_sandbox` receipt, so the levels share one commit. Each lane ran on a clean detached checkout of that commit through `scripts/release/lane-source.mjs`, on a Mac mini (Darwin arm64) with Node 22.23.3. `scripts/release/evidence-cli.mjs` bound a `zenith.release-evidence.v1` receipt to each source.

- `contract`: 126 passed, 0 failed, 0 skipped over 12 test files, offline, no engine or network. Files: `docs/build/production/evidence/PROD-OPS-04/2026-11-01-contract-2cdb66db/`.
- `local_engine`: 56 passed, 0 failed, 0 skipped over 2 test files, against a disposable PostgreSQL 16.15 (pinned digest) migrated by the checkout's own migrator. Files: `docs/build/production/evidence/PROD-OPS-04/2026-11-01-local-engine-2cdb66db/`.


`operational_rehearsal` is still not done. Not a promotion.
