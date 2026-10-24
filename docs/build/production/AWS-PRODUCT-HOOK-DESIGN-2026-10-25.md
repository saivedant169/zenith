# AWS product hook: design for owner review

Status: proposal, 25 October 2026. Nothing here is built yet. Owner decisions are listed at the end.

## Problem

The live AWS harness (`scripts/acceptance/live/`) proves the sandbox works: run 40121066746 on `afde8751` created, read
back and deleted six AWS fixtures with cleanup verified. It reports 27 requirements as pending because no
`ProductScenarioPort` (`scripts/acceptance/live/contracts.ts:79-87`) is passed to `runProductionCli`
(`scripts/acceptance/live/cli.ts:40`). A requirement may only pass when Zenith itself performs the work through its
normal paths and the harness then reads the result back from AWS independently.

## Goal of the first phase

Turn the AWS-only requirements green one at a time, cheapest first, with the lowest AWS spend:
PROD-OPS-07, PROD-REL-04, PROD-MIX-03, PROD-MIX-02, PROD-OPS-06, PROD-OPS-01, PROD-OPS-04.

## Design

### 1. Run Zenith on the GitHub runner

- Start the stack with the existing lean profile before any AWS credential exists:
  `node scripts/acceptance/default-stack/up.mjs --profile lean --directory <dir>`
  (already used on hosted runners in `.github/workflows/operated-gate-linux.yml:203-209`; 1 API, 1 worker, about
  3.9 GiB of memory caps, needs 22 GiB free disk). The default profile took 682 s on a hosted runner; lean is not yet
  measured.
- Export the host client settings the same way `operated-gate-linux.yml:323-334` does.
- Only then request the OIDC session (`live-acceptance.yml`, existing step), so stack startup does not consume the
  one-hour AWS session.
- Raise the job timeout from 60 to 90 minutes. The AWS session stays at one hour.

### 2. Drive the product honestly

- Reuse the operated driver patterns (`scripts/release/drivers/operated.ts`): `createTenant` (`:1044`) creates owner
  and approver users with real logins and TOTP step-up, and `approveOperation` (`:1107`) approves through the
  product's normal browser path: same-origin request, no bearer token, separation of duties, digest equality
  (`src/app/api/_lib/browser.ts:67-77`, `src/lib/capabilities/approvals.ts`).
- The approver is a disposable test user created by CI, not a person. Evidence must say so explicitly
  ("automated test approver"). The real human gates stay outside the product: the owner's approval of the GitHub
  `live-sandbox` deployment and the owner-signed per-run envelope. See decision D1.

### 3. Scenario-specific plans (cost)

- Today `buildPlan` always creates RDS, ECS, DNS, IAM and Lambda fixtures (`scripts/acceptance/live/plan.ts:64-99`).
  RDS is the slowest (up to 15 minutes of waiting) and most expensive part.
- Add a scenario selector so each run's plan contains only the fixtures and calls its requirements need. A plan is
  still deterministic, digest-bound and signed per run by the owner. Cleanup and leak checks stay for every family the
  plan contains.

### 4. Product AWS calls under the guard

- The guard only admits planned calls (`guard.ts:59-66`). Product calls that go through the harness `call` are
  planned like fixture calls.
- Product calls made by Zenith's own SDK clients are bounded by IAM: the sandbox role policy plus
  `ZenithLiveRunnerBoundary`, or for brokered connections the customer role, the broker's session policy and the
  family boundaries (`src/lib/credentials/aws/broker.ts`). Every scenario's IAM additions are listed in its section,
  reviewed, and applied by the owner through `deploy/live-sandbox/aws/main.tf`.
- After each run the harness scans for anything tagged with the run and for leftover objects under owned prefixes.

### 5. First scenario: PROD-OPS-07 (S3 archive, holds, dry-run pruning)

Retention acts on Zenith's own database rows and archives them to S3 (`src/lib/retention/archive.ts`,
`src/lib/hosted/backup/targets.ts:175-273`). It has no proposal/approval operation; its gates are the approved
DEC-RETENTION baseline (`src/lib/retention/policy.ts:72-87`), the operator apply switch, and operator step-up for holds.

Run steps:
1. Plan creates one owned S3 bucket `zenith-<runId>-<account>` (no RDS, ECS, DNS, IAM or Lambda).
2. Seed `runner_job_logs` and `machine_request_logs` rows older than the window, plus one row under a legal hold.
3. Run one archive pass (`scripts/data-retention.ts`) with `ZENITH_RETENTION_ARCHIVE_TARGET=s3` and the run bucket,
   as a host process so AWS credentials never enter containers.
4. Read back from S3: sealed objects under `retention/<workspace>/<class>/`, server-side encryption, and
   `verifyArchive` passes with the right key and refuses a wrong one.
5. Restore into staging and compare ids and counts.
6. Prune with the apply switch off: refused. With the apply switch on: only archived, out-of-window, unheld rows are
   removed; held rows, in-window rows, audit and receipt tables are untouched.
7. Cleanup deletes every object under `retention/`, then the bucket, and confirms absence.

Fixes needed before the first live run (each lands through a PR with green CI):
- Region bug: `archiveTargetFromEnv` passes no region (`archive.ts:60`) and `S3Target` falls back to `us-east-1`
  (`targets.ts:189`), so an `ap-south-1` bucket fails. Pass the region through.
- `tests/retention/archive-s3.engine.test.ts:23` skips silently without a custom endpoint; make the endpoint optional
  so it can run against real S3.
- Harness teardown deletes only the `probe` object (`plan.ts:73`); add planned list/delete calls for `retention/*`.
- The platform operator id (`ZENITH_OPS_ADMIN_IDS`, `src/lib/ops/config.ts:113-115`) is read when the API container
  starts, before the test user exists. Create the operator user before `compose up`, or restart the API once.

IAM additions to `ZenithLiveAcceptance` (`deploy/live-sandbox/aws/main.tf` `locals.statements`), scoped to run
buckets only: `s3:PutObject`, `s3:GetObject`, `s3:DeleteObject` on
`arn:aws:s3:::zenith-zlive-*-<account>/retention/*`. `s3:ListBucket` is already granted.

Expected cost per live run: cents (one bucket, a few objects, minutes). Expected time: 20-35 minutes.

### 6. Next scenarios

- PROD-REL-04: mostly the harness's own guarantees (refusals, journal resume, cleanup-only); cheap, no new IAM.
- PROD-MIX-03: the first full proposal → approval → execution scenario. Needs the customer bootstrap stack
  (`deploy/aws/zenith-connection.cfn.yaml`) in the sandbox, which creates `ZenithObserveRole`/`ZenithDeployRole` and a
  state bucket kept on delete, and `sts:AssumeRole` plus `sts:TagSession` for `ZenithLiveAcceptance` on those roles.
  Cheapest shape: one `aws:s3_bucket` producer and one `aws:lambda_function` consumer (Lambda is marked experimental,
  `src/lib/providers/aws/drivers/compute/lambda-function.ts:2`).
- PROD-MIX-02, PROD-OPS-06, PROD-OPS-01, PROD-OPS-04 build on the MIX-03 setup; OPS-04 also needs a restore path to
  AWS that does not exist yet.

### 7. Workflow outcome

The final gate stays strict. The run is green only when every requirement in the run's scope passes; requirements
outside the run's scope are reported as pending, not failed, so a scoped run can turn green honestly once its
requirements pass.

## Risks

1. Approval honesty: an automated test approver is not a person (decision D1).
2. Plan immutability: every plan or code change needs a new owner-signed envelope, and CI must be green on the exact
   commit first.
3. Cleanup: product-created resources must carry the run tag, or cleanup cannot prove ownership and billing resources
   may remain. Every scenario's leak scan must cover them.

## Owner decisions

- D1. Accept a CI-created test approver for in-product approvals in the sandbox, with the GitHub reviewer gate and the
  signed per-run envelope as the human approvals, and evidence labelling the approver as automated?
- D2. Accept OPS-07 first, knowing it exercises retention's operator gates rather than the proposal/approval flow?
- D3. Accept scenario-specific plans (runs without RDS when not needed) and the scoped workflow outcome in section 7?
- D4. Accept the OPS-07 IAM additions above?
