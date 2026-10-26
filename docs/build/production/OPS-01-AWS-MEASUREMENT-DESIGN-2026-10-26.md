# PROD-OPS-01 on the live AWS sandbox: measurement design

Status: design only, 26 October 2026. Nothing here runs against AWS. The offline calculator is
`scripts/acceptance/live/product/ops01-measure.ts` with tests in `tests/acceptance/ops01-measure.test.ts`.
No target is approved or changed by this document, and no run result is an approval.

Ledger acceptance (`docs/build/production/ledger.json`, PROD-OPS-01): "Measurable availability/latency/capacity/RPO/RTO
objectives defined and tested, with provisional targets clearly separated from accountable approval."

## 1. Facts this design rests on

- **The target file is already in the approved state on this base.** `deploy/slo/slo-definitions.json:4-11` records
  `approval.status: approved_targets`, `decision: DEC-BUSINESS`, `approvedAt: 2026-10-13`, `commitment:
  engineering_target`. The note says these are launch engineering targets, not a contractual SLA, with no service
  credits. `src/lib/slo/definitions.ts:85` (`parseApproval`) enforces that shape. The older verify note
  (`docs/build/production/verify/PROD-OPS-01.md`, section 1) describes a `not_approved` file, which no longer matches
  this base. This design does not change the approval record. Every result it produces is labelled `provisional`
  and carries the file's approval state as a copy, not as evidence of this run. Whether the label on the file should
  change is an owner question (section 9).
- **Targets are read, not restated.** The calculator takes objectives, targets and thresholds from
  `sloDefinitions()` (`src/lib/slo/definitions.ts:168`). Current values in the file: availability 0.999 (`:43`),
  managed runtime availability 0.999 (`:52`), API latency 0.95 within 0.5 s (`:61`), dispatch 0.95 within 30 s (`:71`),
  workflow completion 0.95 (`:81`), scheduler health 0.99 (`:90`), capacity 25 req/s with p95 under 500 ms and at most
  0.5% errors (`:99`), RPO 900 s (`:110`), RTO 14400 s (`:119`).
- **The live PITR path is blocked by one fixture value.** The RDS fixture sets `BackupRetentionPeriod: 0`
  (`scripts/acceptance/live/plan.ts:122`). Point-in-time restore needs automated backups enabled on the source, so the
  fixture has to change before any restore can be measured.
- **The one-hour AWS session is a hard limit.** `.github/workflows/live-acceptance.yml:296` requests
  `role-duration-seconds: 3600`, and the plan caps duration at 5 to 20 minutes (`plan.ts:64`).
- **The database is private.** The RDS fixture is `PubliclyAccessible: false` (`plan.ts:122`), so the runner cannot
  open a SQL connection to it. Row-level data checks are therefore not available in this design.
- **Only AWS fixture families can be exercised live.** The per-scenario map is `plan.ts:8-12`; PROD-OPS-01 is scoped to
  `["lambda", "rds"]` (`plan.ts:51`), and the ledger requirement still needs the product join (`plan.ts:163`), which
  this design does not provide.

## 2. Which objectives one short live run can measure honestly

The run has two halves with different vantage points. Only the AWS half runs on the sandbox. The control-plane
half runs on the runner-hosted stack and touches no cloud API.

| Objective (file target) | Measurable in this run? | Source and vantage | Caveat |
|---|---|---|---|
| `control_plane_availability` (0.999) | Yes, on the runner-hosted stack | Zenith API requests from the runner, vantage `runner-local-stack` | Not an AWS measurement. It says nothing about production. Needs 2,995 zero-failure requests to demonstrate 0.999 at 95% confidence. |
| `api_latency` (0.95 within 0.5 s) | Yes, same stack | Same requests, duration per request | Needs 59 zero-failure fast requests to demonstrate. Local latency is not WAN latency. |
| `rpo` (900 s) | Yes, once | PITR restore of the sandbox RDS micro | Backup-chain lag only (section 3B). Not a row-content proof. |
| `rto` (14400 s) | Database scope only | Same restore, time until the restored instance is `available` | This is not service recovery. `src/lib/slo/recovery.ts:101` already refuses RTO at database completion. The calculator reports RTO as not evaluated for database scope. |
| `capacity` (25 req/s) | No | Would need a load generator and the machine-local `scripts/slo/capacity-test.mjs` | Machine-local only, not a production number. Out of scope for the AWS sandbox run. |
| `managed_runtime_availability` | No | Needs a Zenith-hosted managed deployment | Not in the sandbox plan. |
| `dispatch_latency`, `workflow_completion`, `scheduler_health` | No | Need real operations, approvals and tenant load | Calculator reports them as not evaluated. |
| Lambda invoke latency and availability | Yes, as a provider baseline | Client-side invoke timings from the runner plus server-side REPORT duration | No objective covers Lambda. `control_plane_availability` is Zenith's own API. The calculator summarises this baseline and compares it to nothing. |

Lambda is worth running only as a baseline, to show the sandbox path works and to see cold-start and invoke
variance. It cannot be presented as evidence for any objective.

## 3. Run design

### A. Control-plane samples on the runner-hosted stack (no AWS calls)

- Start the lean stack on the runner before any AWS session exists, as `docs/build/production/AWS-PRODUCT-HOOK-DESIGN-2026-10-25.md`
  section 1 already plans. Send N sequential GET requests to a read-only control-plane route, one request at a time.
- N = 3,000. That is enough to demonstrate 0.999 with zero failures (2,995 minimum) and leaves margin. At an assumed
  20 to 50 ms per request on the runner, the run takes about 1 to 3 minutes. This is an estimate and must be measured.
- Each record is `{ durationMs, ok }`, where `ok` means no 5xx status.
- Timing resolution is the runner clock. Client-side timing includes loopback and runner overhead; say so in evidence.

### B. Lambda invoke baseline (AWS, informational)

- Reuse the nonce fixture: `plan.ts:114` creates the function from `nonce-lambda.zip`, and `sdk.ts:28-30` defines the
  echo handler. `execute.ts:27` already checks that the response has `StatusCode 200`, no `FunctionError`, and the
  nonce.
- Send N = 300 invocations, one at a time. That gives 100 samples or more for a reliable p99 (`ops01-measure.ts`
  flags p99 unreliable below 100). A zero-failure run of 300 demonstrates only about 0.990 at 95% confidence, which is
  why this is a baseline and not an objective.
- Request `LogType: "Tail"` on each invoke. The `REPORT` line in the returned log tail gives server-side `Duration`
  and, on a cold start, `Init Duration`, without any CloudWatch Logs permission. `sdk.ts:62` and `:72` only
  transform `Payload`, so the extra input key should pass through. This needs a check in the harness.
- Cost is effectively zero. Time is a few minutes of sequential invocations.

### C. RDS point-in-time restore (AWS, the only AWS objectives)

1. Create the source instance as the existing micro (`plan.ts:122`: PostgreSQL, `db.t4g.micro`, 20 GiB gp3, encrypted,
   private, single-AZ) with `BackupRetentionPeriod: 1` (changed from 0). Automated backups are needed for PITR.
2. Wait for `available` (existing poll, `plan.ts:123` and `execute.ts:185-189`: up to 180 readings, 5 s apart, so up to 15 minutes).
3. Wait until `LatestRestorableTime` from `DescribeDBInstances` is no more than about 10 minutes behind the clock.
   Automated backups lag the live instance by several minutes, and the restore cannot use a point that does not
   exist yet. Use the wait for the Lambda phase.
4. Record `T0`, the instant the restore is requested. This is the simulated failure instant. The source is not
   actually failed.
5. Call `RestoreDBInstanceToPointInTime` with `UseLatestRestorableTime: true` into a new identifier that ends in
   `-db`, for example `${prefix}-pitr-db`. Ending in `-db` lets it reuse the existing `DBRead` and `DBDelete` grants
   (`deploy/live-sandbox/aws/main.tf:137-138`, pattern `zenith-zlive-*-db`). Pass the same tags, the same private subnet
   group and the same security group.
6. Poll the restored instance every 5 s until `available`. Record that instant as the service-level database
   completion. The timing resolution is therefore plus or minus 5 s.
7. Teardown: delete the restored instance and the source with `SkipFinalSnapshot` and `DeleteAutomatedBackups`, as
   the existing teardown does (`plan.ts:125`). Both must pass the owned-tag condition (`main.tf:138`).

Derived figures, computed by `measure()` from three instants:
- `dataRecoveredThrough` = `LatestRestorableTime` as AWS reports it. `rpo = T0 - dataRecoveredThrough`. This measures how
  far the backup chain lagged behind the simulated failure. It does not check that any particular row exists.
- `restoreElapsedSeconds` = completion time minus `T0`. Scope is `database`, so `rto` is not evaluated. The number is
  still reported as a component.

Caveat: AWS documents that the latest restorable time trails the live instance by a few minutes. Expect RPO of
roughly 5 minutes or more, which is within the 900 s target. That expectation is an assumption and must be measured.

## 4. Sample sizes and statistics

Ratio objectives use the exact one-sided 95% Clopper-Pearson lower bound on the observed proportion. A target is
"demonstrated" only when that bound reaches it. A run that only shows a good point estimate is reported as
"not demonstrated". The calculator also reports the zero-failure sample count needed to demonstrate the target.

| Target | Zero-failure samples needed | Used in this run |
|---|---|---|
| 0.999 (availability) | 2,995 | 3,000 control-plane requests |
| 0.995 | 598 | none |
| 0.99 | 299 | Lambda baseline 300 (baseline only, not an objective) |
| 0.95 (latency within 0.5 s) | 59 | 3,000 control-plane requests |

- Percentiles are nearest-rank and descriptive: p50, p95, p99. p99 is flagged unreliable below 100 samples.
- Recovery figures are one observation each. They are never called a distribution. A distribution needs repeated
  restores, which this design does not budget.
- Sample sizes are fixed in advance by the plan's `maximumCalls` and the guard, so a run cannot quietly add samples.

## 5. Provisional targets and how results compare

- The calculator reads each target from `sloDefinitions()` and copies the target status (`target`) and the file's
  approval state (`targetApproval`) into the result. The result never records an approver and never adds one. The
  approval record remains only in `deploy/slo/slo-definitions.json`.
- Every result has `label: "provisional"`. Verdicts are `demonstrated`, `not_demonstrated`, `not_met` or `no_data` for
  ratios, and `within_target` or `over_target` for recovery figures. A recovery verdict always carries
  `observations: 1`.
- Objectives with no evidence source are listed under `notEvaluated` with a reason, never as passed. This is how the
  run stays honest about the eight objectives it cannot touch.
- The result carries no timestamps, sample arrays, ARNs, account numbers or approver names. A test asserts this.
- A run that fails to demonstrate a target is reported as such. A green run means the measurement was taken and
  compared, not that the objective is approved or accountable.

## 6. Cost and time per run

Prices are from memory and unverified. The owner must check the ap-south-1 rates on the AWS price list before a run.
The plan's own estimate (`plan.ts:159`) uses a generic ceiling and must be replaced for ops-01.

Run 1, baseline (no RDS): Lambda 300 invocations, one function and role created and deleted, plus the runner-stack
samples.
- Cost: effectively zero. Expected under USD 0.05 including the function and role lifecycle.
- Time: roughly 10 to 20 minutes of wall-clock time. Fits the 5 to 20 minute duration rule.

Run 2, PITR restore (RDS micro): two instances, both billed per second with a 10-minute minimum.
- Source instance: create 8 to 15 min (estimate), wait for backups 5 to 10 min (overlaps Run 1 style work), restore
  request, delete 5 to 10 min. Billed roughly 35 to 50 min.
- Restored instance: restore 15 to 30 min (estimate), delete 5 to 10 min. Billed roughly 20 to 40 min.
- Hourly rate for `db.t4g.micro` single-AZ PostgreSQL in ap-south-1: order of USD 0.02 per hour (unverified).
  Storage: 20 GiB gp3 at roughly USD 0.12 per GB-month (unverified), about USD 0.003 per instance-hour. Backup
  storage is free up to the size of the database.
- Expected spend: USD 0.05 to 0.15. Proposed ceiling: USD 1.00, including a USD 0.50 cleanup reserve.
- Time: 40 to 70 minutes wall clock, which does not fit the one-hour session (`live-acceptance.yml:296`) with stack
  startup, preflight and cleanup. Run 2 needs either a longer session or its own run window (section 9).

## 7. Harness changes needed (none made in this PR)

This PR does not touch `.github/workflows/*`, `scripts/acceptance/live/{plan,contracts,execute,cli}.ts`, `deploy/*`
or `permissions.json`. Those files belong to other streams. The changes below are for a later owner-approved PR.

Scenario and plan (`scripts/acceptance/live/contracts.ts:5`, `plan.ts:8-12`):
- Add `"ops-01"` to `SCENARIOS`. Run 1: `{ families: ["lambda"], scope: ["PROD-OPS-01"] }`. Run 2 would add `"rds"`.
  Settings stay as they are.
- `plan.ts:64`: a separate duration rule for ops-01 run 2, for example 5 to 60 minutes, because a restore cannot
  fit in 20.
- `plan.ts:115`: change `lambda-invoke` from `maximumCalls: 1` to N plus a small retry margin (for example 310), and
  add `LogType: "Tail"` to its input.
- `plan.ts:122`: `BackupRetentionPeriod: 0` becomes 1 for run 2. Add a `rds-pitr-restore` setup call
  (`rds:RestoreDBInstanceToPointInTime`, `maximumCalls: 1`), its readiness observation, and its teardown with
  `SkipFinalSnapshot` and `DeleteAutomatedBackups`.
- `plan.ts:159`: an `ops-01` estimate branch with the ceiling from section 6.
- `execute.ts:27` and `checkReadback`: readbacks for the restored instance (status `available`, identifier, owned tags)
  and for each Lambda invoke.
- The calculator's inputs come from the runner's own timers. They are not AWS evidence in themselves, so the evidence
  must name the vantage and the source for each sample set.

IAM (owner applies through `deploy/live-sandbox/aws/main.tf`, reviewed first):
- Run 1: nothing new. `lambda:InvokeFunction` is already granted (`main.tf:131`).
- Run 2: add `rds:RestoreDBInstanceToPointInTime` on the source ARN and on the restored ARN, both matching the existing
  `db:zenith-zlive-*-db` pattern, and add it to the dependency statement (`main.tf:136`) for the private subnet group
  and security group. Confirm the exact resource list against the RDS authorization reference before applying.
- Run 2: the one-hour session must be raised in both places, the workflow request (`live-acceptance.yml:296`) and the
  sandbox role's maximum session (`deploy/live-sandbox/aws/main.tf:92`), or Run 2 runs outside the one-hour session.
  Owner decision.
- Each run needs its own owner-signed permission envelope. Grants are summed from planned calls (`guard.ts:21-26`).

## 8. What stays unprovable live

- Multi-day availability and the 30-day error budget. Burn-rate alerts (`deploy/observability/alerts/zenith-slo.rules.json`)
  are not exercised by a single run.
- Real customer load, production topology capacity, and the capacity objective in general.
- Managed runtime availability, dispatch latency under real approvals, workflow completion and scheduler health at
  production volume.
- Service-level RTO (the application answering). It needs a health endpoint the sandbox can reach. The private
  database has no reachable path from the runner.
- Row-level RPO (that specific committed data exists after restore). It needs a database connection from a reachable
  network path, which the private fixture does not have. Adding one would mean VPC plumbing and more cost than this
  run justifies.
- Multi-AZ or cross-region failover. The fixture is single-AZ by design.
- Any statistic about restore time from one restore. One observation is not a distribution.
- Lambda figures as Zenith evidence. They describe the sandbox's Lambda path only.

## 9. Owner decisions before any live run

1. Confirm the label for the target file. It is `approved_targets` on this base, while the older verify note says
   `not_approved`. This design does not change it.
2. Choose the run split: Run 1 alone (fits the duration model), or Run 1 and Run 2 in separate windows with a longer
   session for Run 2.
3. Accept `BackupRetentionPeriod: 1` on the sandbox fixture for Run 2 (backup storage is free up to database size).
4. Validate the ap-south-1 hourly, storage and minimum-billing rates, and accept the USD 1.00 ceiling.
5. Accept the IAM additions in section 7 for Run 2.

Nothing in this design counts toward the ledger row. The requirement still needs the Wave 5 product join described in
`docs/build/production/AWS-PRODUCT-HOOK-DESIGN-2026-10-25.md`.
