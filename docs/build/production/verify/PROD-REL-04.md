# PROD-REL-04: Scope permission and resumable execution

## L1-LIVE-AWS provider slice (8 October 2026)

Acceptance: Approved budgets/disposable resources only; no unrelated services/purchases/terms/production/secret bypass/protected branches/history rewrites; consolidate decisions and checkpoint exact next commands without unattended-work claims.

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

## Live drill (scenario rel-04)

**How to run.** Dispatch `live-acceptance.yml` with `scenario=rel-04` and a new run id, as in [LIVE-ACCEPTANCE.md](../LIVE-ACCEPTANCE.md). The job runs `scripts/acceptance/live/drill/rel-04.ts` after OIDC, then `scripts/acceptance/live/drill/verify-rel-04.ts`, then an always-run recovery of any rel-04 journal that is still open in either run directory (D1 and its replay D2), then publishes `aws-live-rel04-<run>` (journals, evidence, checkpoints, the receipt and the drill log, all JSON). The plain harness does not run for this scenario. The recovery never changes the drill verdict; its failure fails the final gate. Scenario `rel-04` plans one S3 fixture, scoped to PROD-REL-04, and has no product port, so the packet verdict stays `incomplete` by design.

**What it proves, live, against the sandbox account.**

- **A, real crash.** The harness is started in its own process group. The drill SIGKILLs that group as soon as the journal records the `s3-create` intent. It then snapshots the journal, `next-command.txt` and `checkpoint.json`. The snapshot must show an open journal, one create intent and a runnable `--cleanup` command that names every required env variable and the journal path. The checkpoint must carry the same command with `unattendedClaims: false`.
- **B, journal-only resume.** The drill runs that recorded command semantics, `aws-live.ts --cleanup <journal>`, with the same environment. The journal must close, no `*-create` counter may grow, `evidence.json` must report `cleanupComplete`, and the checkpoint run step must be `done`.
- **C, replay refusal.** A fresh budget book, `ZENITH_LIVE_BUDGET_FILE=<ledger>.replay.json`, lets the same run id reach the account-side SSM run claim (`PutParameter`, `Overwrite: false`). The claim must be refused exactly once. No S3 create may be attempted, and no fixture may pass. A second attempt with the original book must exit 2 before any journal is written.
- **D, readback.** Read-only: `HeadBucket` on the run bucket must return NotFound, and `/zenith/live-runs/<runId>` must still equal the run id. These use the planned leak and run-claim-read call shapes through the native SDK transport, and the sandbox role already allows them (`s3:ListBucket` on `zenith-zlive-*`, `ssm:GetParameter` on `/zenith/live-runs/zlive-*`). No IAM change is needed.

**Receipt.** `rel-04-receipt.json` records `schema`, `scenario`, `runId`, the source `commit`, `planSha256`, `permissionSha256`, one `passed` boolean with a short fixed reason per step, `verdict` and `notes`. It contains no credential, environment value or raw provider response. The receipt is written even when a step fails, and `verdict` is `passed` only when all four steps pass.

**Offline verifier.** `verify-rel-04.ts` makes no AWS call. It re-derives each step from the journals, the kill snapshot, the checkpoints, `evidence.json`, the replay journal and the permission file, binds the receipt's plan, permission and commit to the permission file and the journal, and then compares each re-derived result with the recorded booleans. It exits 0 only when every step holds and the receipt says `passed`.

**Honest limits.**

- **Kill timing races `s3-tag`.** The kill can land before or after the provider accepted `CreateBucket`, and before or after `PutBucketTagging`. Resume handles all of these through the existing untagged-create repair, but the drill cannot choose which side it hits. Each run records what the snapshot showed, and it does not claim a particular ordering.
- **The fresh budget book in C is deliberate.** It bypasses the local book so that the request reaches the account-side claim. The receipt records this in its notes. The account-side claim is the control under test; the local book is not.
- **Not covered live.** Budget exhaustion and forbidden actions stay contract-level, as tested in `tests/acceptance/aws-production.test.ts`. The drill does not prove product behaviour, traffic, or the other 26 requirements.
- **The 500-character next-command cap.** The shared checkpoint schema (`scripts/release/checkpoint.ts`) caps each next command at 500 characters, and a resume whose command exceeds that is refused as malformed. A CI-shaped command measures about 420 characters. A much longer checkout or temp path can reach the cap, and the resume then fails closed. Raising the cap is a shared-checkpoint change and is not part of this drill.
- **One run id, one drill.** The run claim persists in the account. Reusing a run id for a second drill is refused by design, so the owner must start a new run id.
- **No unattended claims.** The drill is a single automated sequence that the owner starts by hand. It does not claim that any step ran unattended, and the checkpoint records `unattendedClaims: false`.

**Not run here.** No live drill, no AWS call and no workflow dispatch were run for this change. The offline tests are `tests/acceptance/aws-rel04-drill.test.ts`, and the workflow shape is pinned in `tests/ci/release-gates.test.ts`.

## L3 live and operational verification (2026-10-08)

Acceptance contract: Approved budgets/disposable resources only; no unrelated services/purchases/terms/production/secret bypass/protected branches/history rewrites; consolidate decisions and checkpoint exact next commands without unattended-work claims.

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
node scripts/ci/wave6-gates.mjs --requirement PROD-REL-04 --print > /tmp/zenith-wave6-PROD-REL-04.commands.json
```

This prints the exact argv for each contract batch and required engine case, its gate names, private prerequisites, and its strict report-validation command. Set only the gates for the selected lane after preparing its owned fixture; a skip cannot satisfy that lane. Run each `argv` sequentially and then its `verify` argv. [Final integration setup and results](FINAL-INTEGRATION.md), [canonical inventory](../../../../scripts/ci/wave6-gates.json), [owner live runbook](../LIVE-ACCEPTANCE.md).
