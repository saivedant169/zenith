# PROD-OPS-07 Configurable non-destructive retention

Status: built and typechecked. Local engine evidence exists (commit 69be83f8, disposable MinIO/PostgreSQL); live AWS S3 sandbox evidence passed on 2026-10-26 (see the dated section at the end); the requirement stays in progress. Branch `prod/ops-07-w5`, migration 45.
Approved baseline (DEC-RETENTION, Arnav Bule, 2026-10-13): production logs are kept 30 days; sensitive execution payloads are deleted within 72 hours after an operation finishes; essential audit records (approvals, infrastructure changes, outcomes) are kept at least one year and are not auto-deleted. These periods ship as the default policy. Approved does not mean running: nothing is deleted on an installation until its operator switches deletion on (`ZENITH_RETENTION_APPLY=1` for logs, `ZENITH_DATA_MINIMIZE_APPLY=1` for payloads).

**Update 2026-10-13 (DEC-RETENTION decision implemented).** The built-in default policy is now: `runner_job_logs` and `machine_request_logs` archive and prune at 30 days; `resource_observations` and `drift_reports` retain (they record infrastructure changes and outcomes); the built-in approval covers only the built-in default, so an operator policy file without its own `approval` is still dry-run/copy-only. The policy loader refuses a `pruneAfterDays` below 365 on `resource_observations` and `drift_reports` (class or workspace override). Legal holds now also stop archive copies: `archiveBatch` reads its candidates and their hold flags under the holds lock and stops before the first held row, so the watermark never passes a held row and the row is archived normally after release (outcome `{ status: "blocked", reason: "legal_hold" }` when the first candidate is held). A hold placed while a copy is already in flight applies from the next batch. Pruning waits behind holds as before and only deletes archived rows. The payload minimizer (OPS-06) now sits behind the same approval gate and honours holds (see [PROD-OPS-05-06](PROD-OPS-05-06.md)). The admin page and `GET /api/admin/ops/retention` show the approved baseline, per-class eligible, held, archived and pruned counts, the minimizer gate with its eligible and held counts, and two fixed notices. Honest gaps: Zenith does not expire archive objects (the destination bucket lifecycle governs them), and backups taken before a deletion still contain the rows until the backup expires; backup expiry is not tracked. Count-based trims of observations and drift reports in the repositories are unchanged. Sections below describe the original build; where they say default retain forever or deletion pending, this update supersedes them.

## 1. What was built

Library `src/lib/retention/`:
- `classes.ts` data classes and hard invariants. Four archivable/prunable classes only (`runner_job_logs`, `machine_request_logs`, `resource_observations`, `drift_reports`); `NEVER_PRUNABLE` lists the protected tables (operations, approvals, events/audit, evidence, receipts, effect ledger, idempotency and nonce replay records, authority, custody, job and request rows, mixed run ledgers, holds, archive manifests). `assertPrunableClass` runs before any statement is built.
- `policy.ts` policy schema + loader (`ZENITH_RETENTION_POLICY_FILE` or inline `ZENITH_RETENTION_POLICY`, both set is refused; invalid policy means retain everything). Per class `archiveAfterDays` / `pruneAfterDays`, per-workspace overrides, optional `approval` (DEC-RETENTION) record. Protected names and unknown classes are refused with the reason; `pruneAfterDays` requires an earlier-or-equal `archiveAfterDays`. `retentionApplyGate(env, load)` copies the OPS-06 gating shape: `ZENITH_RETENTION_APPLY=1` AND an approval record in a valid policy.
- `store.ts` eligibility SQL (settled parent, keep-latest, hold predicate), legal holds (create/release/list under an advisory lock), archive records, `previewRetention` dry run.
- `archive.ts` archive target from env (`ZENITH_RETENTION_ARCHIVE_TARGET=filesystem|s3` with `_DIR` / `_S3_BUCKET` / `_S3_REGION` (falls back to `AWS_REGION` / `AWS_DEFAULT_REGION`; required unless `_S3_ENDPOINT` is set) / `_S3_ENDPOINT`, reusing `FilesystemTarget`/`S3Target`), `archiveBatch` (copy only, sealed with the backup AES-GCM crypto under `ZENITH_BACKUP_KEY`, workspace-prefixed content-derived key, readback + unseal + digest compare before recording) and `pruneArchive` (re-verifies the object, deletes only manifest ids, re-checks age, settled parent, keep-latest and holds inside the DELETE under the holds lock).
- `job.ts` `retentionPass`: per-workspace window candidate query, bounded batches, archive then (only with gate open) prune.
- `overview.ts` read model shared by the API and page.

Wiring (reachable):
- `src/lib/platform/critical-jobs.ts`: new durable critical job `data-retention` (registry + `MAINTENANCE_JOBS`), so the Temporal critical-maintenance schedule runs it; `scripts/data-retention.ts` is the cron-less operator trigger under the same lease.
- `GET /api/admin/ops/retention` overview + dry-run preview; `POST /api/admin/ops/retention/preview` preview of a candidate policy (never stored); `GET|POST|DELETE /api/admin/ops/retention/holds`. All platform-operator only (`ZENITH_OPS_ADMIN_IDS`), same-origin for writes.
- Page `/admin/retention` (operator only): status cards, per-class dry-run table, sample rows that would be pruned, hold list with place/release, recent archives, never-removed list. No nav link was added to the waitlist-owner shell (different audience); open it by URL.
- Migration `0045_retention.ts` registered in `migrations/index.ts`.

No change to OPS-06 `minimize.ts`; the retention gate mirrors its pattern and is independent of `ZENITH_DATA_MINIMIZE_APPLY`.

## 2. Acceptance mapping

| Clause | Implementation | Tests |
|---|---|---|
| Policy schema per OPS-06 class, windows, defaults retain forever, loaded from config | `policy.ts`, `classes.ts` | `tests/retention/retention.test.ts` "policy schema and gate" |
| Durable archive job, copy to tenant object storage with integrity manifest and readback, source untouched unless apply gate | `archive.ts`, `job.ts`, critical job `data-retention` | "archive: copy only, sealed, read back" (sealed object, manifest digest, corrupt/lost/failed target records nothing, idempotent) |
| Legal holds tenant/resource/time scoped block archive-delete and prune | `store.ts` (`classSql().held`, `pruneSql`, holds lock), migration 45 | "legal holds" (tenant, job, operation, time range, other class, release, immutability, other tenant) |
| Dry-run preview API/page with counts per class and what would be pruned | `previewRetention`, routes, `/admin/retention` | "dry-run preview", `tests/retention/admin-routes.test.ts` "overview and preview" |
| Hard invariants: active operations, audit, approvals, receipts, effect ledger, replay records never prunable | `NEVER_PRUNABLE`, `assertPrunableClass`, settled-parent and keep-latest SQL, policy refusal | "hard invariants" (statement tables, refusal of every protected name, gate-open run leaves protected tables and unsettled job logs untouched) |
| Deletion gated (DEC-RETENTION approved 2026-10-13; operator apply switch off by default) | `retentionApplyGate`, `pruneArchive` throws without gate | "opens the delete gate only with...", "deletes nothing without the gate...", "pruneArchive cannot be called without the apply gate" |
| Prune only archived data | prune by verified-manifest ids, re-verified at prune time | "refuses to prune when the archive object can no longer be verified", late-row survival |

## 3. Verification commands (other machine)

```
export PATH="/c/Users/user/.local/sdk/node22:$PATH"
npx vitest run tests/retention
npx vitest run tests/platform/critical-jobs.test.ts tests/sensitivedata tests/security tests/controlplane/migrations.test.ts
npx tsc --noEmit -p . && npx eslint src/lib/retention src/app/api/admin/ops/retention src/app/admin/retention scripts/data-retention.ts tests/retention
```
Expected: all pass on PGlite; no env vars needed (keys are generated at runtime, archive target is a temp directory). Not run by the worker. Things most likely to need a fix on first run: SQL typing of the tuple comparisons `(timestamptz, bigint|text) >= (...)` and `make_interval(days => case ...)` in `job.ts`/`store.ts` on PGlite; `jsonb_exists($n::jsonb, text)`; the `delete ... using` alias form in `pruneSql`; `pg_advisory_xact_lock` on PGlite; the Postgres-lane run of the same tests (`ZENITH_TEST_PLATFORM_PG_URL`) was not added (these tests use PGlite only).

Live check (manual, not counted): `ZENITH_RETENTION_ARCHIVE_TARGET=s3` against LocalStack with a policy file, run `npx tsx --env-file-if-exists=.env.local scripts/data-retention.ts`, confirm sealed objects under `retention/<workspace>/<class>/`.

## 4. Gaps, assumptions, shared-file updates for the assembler

Known gaps:
- "Tenant-owned object storage" is one operator-configured bucket/directory per install with workspace-prefixed keys, sealed with the install backup key. Per-tenant buckets and per-tenant keys are not implemented.
- Archive restore tooling is built (section 6: `verifyArchive`, `restoreArchive`, `scripts/retention-archive.ts`). Archiving is not a backup of the protected tables.
- The dry-run preview counts with full-table scans per workspace (bounded to 100 workspaces) and recorded-time columns are not all indexed; acceptable for operator use, would need indexes at large scale.
- Archive coverage is a per-(workspace, class) watermark; a row committed late with an older recorded time than the watermark is never archived and therefore never pruned (safe failure).
- Archive key rotation: pruning refuses an archive sealed under a different key id than the current `ZENITH_BACKUP_KEY` (it stays unpruned).
- The page is operator-gated but not linked from the existing admin nav.
- Other classes from the OPS-06 inventory (events, evidence, runbook audit, etc.) are deliberately outside retention; they stay retain-forever until a future decision.

Shared-file updates the orchestrator must make:
- Migrations inventory / emit-sql / supabase migration for version 45 (`platform.legal_holds`, `platform.retention_archives`); versions 42-44 belong to siblings.
- `src/lib/sensitivedata/inventory.ts`: classify `platform.legal_holds` (classification `personal-data`: created_by/released_by actor ids, free-text reason; retention `ledger`) and `platform.retention_archives` (`operational`; object key, digests, row id range; retention `ledger`). Update the `Retention` note of `runner_job_logs`, `machine_request_logs`, `resource_observations`, `drift_reports` to "archive then prune per PROD-OPS-07 policy; default retain forever". Updating `agent_effect_receipts` and ledger tables is unnecessary (still never pruned).
- Tenancy classification for `tenancy.test.ts` / SQL scoping (functions live in `src/lib/retention/store.ts`, not exported through `controlplane/db/repos`): `createHold`, `releaseHold` (when workspaceId given), `archiveWatermark`, `recordArchive`, `markPruned`, `deferArchive` WORKSPACE-BOUND; `listHolds`/`listArchives`/`archivesToPrune`/`previewRetention`/`pruneSql`/`classSql` SYSTEM operator reads or statement builders (counts and ids only). `releaseHold` without workspaceId is an operator-wide release by id.
- Gate manifest: add `tests/retention/**` to the relevant lane; ledger/LIMITATIONS: DEC-RETENTION approved 2026-10-13; deletion not enabled on any installation.
- `docs/platform/operations/DEPLOYING.md` and `docs/platform/operations/SENSITIVE-DATA.md`: document the new env vars (`ZENITH_RETENTION_POLICY_FILE`, `ZENITH_RETENTION_POLICY`, `ZENITH_RETENTION_APPLY`, `ZENITH_RETENTION_ARCHIVE_TARGET`, `ZENITH_RETENTION_ARCHIVE_DIR`, `ZENITH_RETENTION_ARCHIVE_S3_BUCKET`, `ZENITH_RETENTION_ARCHIVE_S3_ENDPOINT`) and the `data-retention` job/CLI. Any tick-status test that enumerates `CRITICAL_JOB_NAMES` should expect the new durable-only job.

Example policy file (provisional windows, for evaluation only; a real policy needs the DEC-RETENTION decision):
```json
{ "version": 1,
  "classes": { "runner_job_logs": { "archiveAfterDays": 30, "pruneAfterDays": 90 } },
  "approval": { "decision": "DEC-RETENTION", "approvedBy": "<decider>", "approvedAt": "<ISO time>" } }
```
Omit `approval` (or leave `ZENITH_RETENTION_APPLY` unset) to archive without ever deleting. With no policy configured the approved baseline above applies.

## 5. Suggested ledger implementationStatus

"Built (mechanism): retention policy schema, sealed verified archive job, legal holds, dry-run preview API/page and never-prunable invariants; deletion gated on DEC-RETENTION approval plus ZENITH_RETENTION_APPLY=1, default retain forever; tests written, awaiting verification; per-tenant storage and restore tooling not built."

## 6. Follow-up: tenant destinations, restore tooling, nav (same migration 45, edited in place)

Built:
- Tenant-owned destinations (`src/lib/retention/destination.ts`, migration tables `platform.retention_destinations`, `archives.destination_id/label`). A workspace admin sets `PUT /api/workspace/retention-destination { environmentId, resourceAddress, credentialsRef }` (GET/DELETE too; admin role, same-origin). It reuses the LIFE-11 shape: an `object_store` resource of the workspace's environment (not `external`), credentials read through the brokered `createSecretResolver` path, the secret's bucket must equal the resource's bucket, and a marker is written and read back before acceptance. New archives of that workspace go to `s3://<bucket>/zenith-retention/`; with none configured they go to the operator bucket (fallback). A configured destination that stops resolving PAUSES archiving for that workspace (`destinationUnavailable` count) and never falls back to the operator bucket (that would move tenant data somewhere the tenant did not choose). Verify, restore and prune open the destination an archive was recorded in. Archives are still sealed with the install `ZENITH_BACKUP_KEY` (per-tenant keys not built).
- Restore tooling (`src/lib/retention/restore.ts`): `verifyArchive` (unseal, digest, count, id range, workspace) and `restoreArchive` (modes `staging` into schema `retention_stage_<suffix>`, or `source`; optional `rowIds`). Verification must pass first. Source restore is `INSERT ... ON CONFLICT DO NOTHING` (never overwrites an existing or newer row, idempotent), skips rows whose parent is gone (counted), inserts only the archive's workspace rows. Rows are read back and compared; every attempt incl. refusals is written to append-only `platform.retention_restores`. Surfaces: `scripts/retention-archive.ts list|verify|restore`, `GET /api/admin/ops/retention/archives`, `POST .../archives/:id/verify`, `POST .../archives/:id/restore` (operator only).
- Nav: `Data retention` link in the admin shell nav (`admin-shell.tsx`), shown only to platform operators (`ZENITH_OPS_ADMIN_IDS`) via `showRetention` from `admin/page.tsx`.

Tests: `tests/retention/restore-destination.test.ts` (verify/tamper/wrong key, staging and source restore, idempotence, never-overwrite, selective ids, parent-missing skip, refusals and audit, append-only audit, tenant destination validation, routing to tenant vs operator, no silent fallback, revoke, immutability), route cases appended to `tests/retention/admin-routes.test.ts`. Tenant bucket is an in-memory S3 client double under the real `S3ObjectStore`; not run by the worker.

PGlite/portable-SQL risks to check first (highest first):
1. `restore.ts`: `insert into t overriding system value select r.* from jsonb_populate_recordset(null::platform.t, $1::jsonb) r ... on conflict do nothing returning id::text` (identity override, record-set expansion, column order = table order) and staging `create table ... (like platform.t including defaults, primary key (id))`.
2. `job.ts`/`store.ts`: tuple comparison `(timestamptz, bigint|text) >= (...)`, `make_interval(days => case when jsonb_exists($3::jsonb, l.workspace_id) then ($3::jsonb ->> l.workspace_id)::int else $2::int end)`.
3. `store.ts` `pruneSql`: `delete from t l using parent p`; `pg_advisory_xact_lock(hashtext(...))`.
4. Migration trigger tuple comparisons (`is distinct from` on row constructors) in the guard functions.
Where it was easy the SQL avoids driver-specific array parameters (ids go as one JSON parameter through `jsonb_array_elements_text`).

Additional shared-file items: inventory classification for `platform.retention_destinations` (operational; vault reference, no secret; ledger) and `platform.retention_restores` (personal-data: actor id; immutable). Tenancy: destination functions are WORKSPACE-BOUND (`getActiveDestination`, `getDestination`, `createDestination`, `revokeDestination`); `listDestinations()` without workspace and `listArchives` are SYSTEM operator reads; restore statements are bound by the archive's workspace_id. New env: none beyond section 4; `scripts/retention-archive.ts` documented in its header.

Limits: no workspace-admin UI for the destination (API only); restore of a tenant archive after its destination is revoked works only while the credentials still resolve; the 500-row archive batches mean large restores are many objects; restore to `source` does not re-create deleted parents.

## L1-LIVE-AWS provider slice (8 October 2026)

Acceptance: Archive/holds/bounded pruning preserve active/audit/receipts/replay prevention; implementation and dry-run allowed, deletion awaits approved policy.

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

Acceptance contract: Archive/holds/bounded pruning preserve active/audit/receipts/replay prevention; implementation and dry-run allowed, deletion awaits approved policy.

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
node scripts/ci/wave6-gates.mjs --requirement PROD-OPS-07 --print > /tmp/zenith-wave6-PROD-OPS-07.commands.json
```

This prints the exact argv for each contract batch and required engine case, its gate names, private prerequisites, and its strict report-validation command. Set only the gates for the selected lane after preparing its owned fixture; a skip cannot satisfy that lane. Run each `argv` sequentially and then its `verify` argv. [Final integration setup and results](FINAL-INTEGRATION.md), [canonical inventory](../../../../scripts/ci/wave6-gates.json), [owner live runbook](../LIVE-ACCEPTANCE.md).

## Live AWS sandbox evidence (2026-10-26)

Run: [GitHub Actions run 40234506190](https://github.com/saivedant169/zenith/actions/runs/40234506190) on `saivedant169/zenith`, workflow `live-acceptance.yml`, scenario `retention-s3`, run id `zlive-202610252113-f271`. Verdict `passed`: 3 passed, 0 failed, 0 pending. Cleanup complete.

- Source commit: `722879ed81ae148c8e697e64bbdde53bf164df77` (the head of `codex/production-2026-10-02` after PR #23).
- Plan digest `6e17ec204ae888d38e159dde1e4d68a6145b6677c0a88259851a873abc0cdb47`; permission digest `416a36df4915c9d9a1baa13101fa8582559112b527001ab48f4bd103e6bb28bc`.
- AWS sandbox account `361646636162`, region `ap-south-1`. Budget cap USD 0.40 (a provisional estimate; billing was not measured). Duration 15 minutes (the harness default; see the gotcha in [LIVE-ACCEPTANCE.md](../LIVE-ACCEPTANCE.md)).
- Approval: automated envelope, `approvedBy` "automation (delegated by Saivedant Hava on 2026-10-26)", under the owner decision recorded in LIVE-ACCEPTANCE.md.
- Evidence kept in the repo: [`evidence/PROD-OPS-07/2026-10-26-live-aws-40234506190/`](../evidence/PROD-OPS-07/2026-10-26-live-aws-40234506190/) (`evidence.json` sha256 `360b129cb464d03632b616695e47e05c845f91e7ef6b76fc79e784e607ae002e`, `journal.json` sha256 `e9291ef79dd1824587f91bb6ddba2feb7e30330ae3083bbb92365bf35c91616b`). The GitHub artifact `aws-live-40234506190` expires 2026-11-01; the repo copy is the durable record.

What the run proved (verbatim reason from `evidence.json`):

> PROD-OPS-07 proven by independent readback: sealed objects are listed under retention/zlive-202610252113-f271/ for both classes and match their archive records; verify passes with the archive key and refuses a wrong key; the staging restore returns the unheld out-of-window ids; with ZENITH_RETENTION_APPLY unset nothing is removed; with it set, 6 archived unheld rows removed; 1 legal-hold row and 4 in-window rows kept; audit and receipt row counts are unchanged. Gates: built-in DEC-RETENTION baseline (approval recorded for Arnav Bule), the apply switch, and one legal hold. No in-product proposal or approval was used in this flow.

Fixes that the earlier live attempts found before this run passed: #14 (S3 archive region), #20 (inactive ECS cluster leak scan), #21 (failure type/code reporting), #22 (stack CA passed to retention child processes), #23 (operator `--force` run-now and refusal to count a skipped pass).

Ledger effect: a `live_sandbox` evidence entry was added to PROD-OPS-07. State stays `in_progress` and `implementationStatus` is unchanged. Live evidence is one of four required levels, and `operational_rehearsal` is still missing. `releaseStatus` flags are unchanged.

Still missing for PROD-OPS-07:

- `operational_rehearsal`: no operated-stack rehearsal has been recorded.
- Real bucket lifecycle: Zenith does not expire archive objects; the destination bucket's lifecycle governs them, and it was not exercised.
- Temporal critical-job scheduling of `data-retention` on a live stack: not covered by this run.
- Deletion apply on any real installation: the deletion ran only in the disposable sandbox stack.
- Backup expiry is not tracked: rows in backups taken before a deletion persist until those backups expire (existing gap above).
- `production_signoff`: not requested, not recorded.
- The harness `evidence.json` is not a `zenith.release-evidence.v1` receipt. The release validator reads receipts only when `sandboxVerified` is set, so this run does not satisfy that gate.
