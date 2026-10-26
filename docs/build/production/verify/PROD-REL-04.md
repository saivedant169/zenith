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

## Live AWS sandbox evidence (2026-10-26)

Run: [GitHub Actions run 40255637945](https://github.com/saivedant169/zenith/actions/runs/40255637945) on `saivedant169/zenith`, workflow `live-acceptance.yml` (event `workflow_dispatch`, job `aws-live` success), scenario `rel-04`, run id `zlive-202610260143-3816`. Workflow conclusion `success`. The drill receipt verdict is `passed`, and the offline verifier `verify-rel-04.ts` passed.

- Source commit `d387c6aa921fd4f5f51575415bf88c3f870d74a0` (head of `codex/production-2026-10-02` after PR #28).
- Plan digest `ab223fa3e02a8a81cd2e2a7f2c95249d963257ca2343f1a7971af375e23ed633`; permission digest `7acbcf9d270bd4ec3fe42931d1363798a07dde217ece2ca4fc57816e40b19baf`.
- AWS sandbox account `361646636162`, region `ap-south-1`. Budget cap USD 0.40, a provisional estimate; billing was not measured. Duration 15 minutes, the harness default.
- Approval: automated envelope, `approvedBy` "automation (delegated by Saivedant Hava on 2026-10-26)", under the owner decision recorded in [LIVE-ACCEPTANCE.md](../LIVE-ACCEPTANCE.md).
- Evidence in the repo: [`evidence/PROD-REL-04/2026-10-26-live-aws-40255637945/`](../evidence/PROD-REL-04/2026-10-26-live-aws-40255637945/). It holds `rel-04-receipt.json`, `rel-04-drill-log.json`, `kill-journal.json` and `kill-checkpoint.json` (the state at the kill), `journal.json`, `checkpoint.json` and `evidence.json` (the resumed run), and `replay/` (`journal.json`, `checkpoint.json`, `evidence.json` of the replay). The JSON files were scanned for credential patterns (access key ids, session tokens, bearer and token strings, long base64 values) and none were found. The account id and role or boundary ARNs are present, as in the PROD-OPS-07 evidence. The GitHub artifact is `aws-live-rel04-40255637945`. The repo copy is the durable record.

sha256 of the committed files: `rel-04-receipt.json` `dc01f9791bc5f399332ec3972ca587037f12880f385dbae056ff93e75999d233`; `rel-04-drill-log.json` `f28c6259a3268e4b0dd2d601d01846d203604e7c11b5236373fe46ec600612af`; `kill-journal.json` `0f94f05d4e8c75483e52ea665cef9756bb6473bda78988fe616a911c8bbd1879`; `kill-checkpoint.json` `406b7d9f6a55d22ac6209dc74f06c300ba0519a9947300899756e2653aa4f73f`; `journal.json` `4a0bcc27da4ef8f3930fd38ae6886fe1e708b47165679d750d503e2781a9b5a2`; `checkpoint.json` `52aadc62aea3bcde49b557ca7493eee0fe241bc7bc1115078f113f3500d9ed42`; `evidence.json` `a929b42c22b5699ef21c7ce195cec04ae48d62884e26fccdf6f7a58050b1fbbd`; `replay/journal.json` `a2e663a28108e09b8b81545f6878ed6470710d8f1cf1794972231910dc509fb6`; `replay/checkpoint.json` `1f940f89626e06190039c315002f2995e10e8b898243ae0d2c65dcd8b49ca213`; `replay/evidence.json` `48eb7c9681ee3e5a1526e7c6961d66278296360e30382ace726a0b0e2915c572`.

What each step proved:

- **A, real crash.** The harness ran in its own process group. The drill sent SIGKILL to that group when the journal recorded the `s3-create` intent. The snapshot shows the journal open, one create intent, and a runnable `--cleanup` command in `kill-checkpoint.json` (`nextCommands`) with `unattendedClaims: false`. The published artifact has the JSON only; the `next-command.txt` file the drill also writes is not in the repo, and its command is the same string as `nextCommands`.
- **B, journal-only resume.** `aws-live.ts --cleanup` on the recorded journal, with the same environment, closed the journal and deleted the bucket. It exited 3, which is the expected incomplete code because no product port is joined. No `*-create` counter grew. The checkpoint run step is `done` with `attempts: 2`, and `evidence.json` reports `cleanupComplete: true`.
- **C, replay refusal.** The replay used a fresh budget book (`ZENITH_LIVE_BUDGET_FILE` set to a replay ledger) so that it reached the account-side SSM run claim (`PutParameter`, `Overwrite: false`). The claim was refused and the replay exited 1, with zero S3 create calls. `replay/evidence.json` therefore has verdict `failed` with one `execution` check ("refused or failed; no complete acceptance claim"). That is the expected refusal, not a product failure. The receipt's step C assertion covers the second replay with the spent book, which the drill expects to be refused locally before any journal is written. The artifact has no separate record of that attempt.
- **D, readback.** Read-only `HeadBucket` on the run bucket returned NotFound. The SSM parameter `/zenith/live-runs/zlive-202610260143-3816` still equals the run id.
- **Offline verifier.** `verify-rel-04.ts` re-derived each step from the journals, kill snapshot, checkpoints, `evidence.json`, the replay journal and the permission file, and it matched the receipt's recorded booleans.

Honest limits:

- **Kill timing races `s3-tag`.** The kill can land before or after the provider accepted `CreateBucket`, and before or after `PutBucketTagging`. Resume covers each side through the untagged-create repair. The artifact does not show which side this run hit, and the drill does not claim an ordering.
- **Fresh budget book in C is deliberate.** It bypasses the local book so that the request reaches the account-side claim. The account-side claim is the control under test.
- **Not covered live.** Budget exhaustion and forbidden-action refusals stay contract-level, in `tests/acceptance/aws-production.test.ts`. Only one S3 fixture was exercised. No product scenario was joined, so the PROD-REL-04 product checks remain pending, and the packet verdict is `incomplete` by design.
- **Cost.** The 0.40 figure is an estimate. Billing was not measured.
- **`operational_rehearsal` is not done.** The ledger state stays `planned` and `implementationStatus` is unchanged. No ledger rule in `scripts/build/production-ledger.mjs` or `scripts/release/status.mjs` requires a move to `in_progress` on live evidence alone.
- **Not a promotion.** `releaseStatus` flags are unchanged. This run does not satisfy the `zenith.release-evidence.v1` gate.
- **Unresolved `local_engine` commit.** The ledger `local_engine` entry for this requirement has no `commit`, so `scripts/build/production-ledger.mjs` reports `Unbound evidence: PROD-REL-04`. Its four passing REL-04 cases in `evidence/engine-acceptance/2026-10-20-wave6-local-lanes.json` cite three different source commits (`9fb9e6356bed88fda0b20463dee7565412f3b5af` for two kind cases, `283a68685bc3d8f68042afdebb469df23b2eaa71`, and `fd5aa0af62e8bf0873ebc825a270a30678826ebd`). No single commit is exact, so the field is left unset. The git history of the file does not identify the producing commit either.

Bug the drill found, and its fix. The earlier attempt, run 40249038248, found that journal recovery never worked. The redaction step turned repeated plan objects into `"[Circular]"`, so resume failed with "Plan integrity failed". PR #27 fixes this by rebuilding the plan from the recorded settings and checking the exact plan digest. Related recovery work: PR #25 (recovery gaps G1-G4) and PR #26 (the rel-04 drill).

Still open for PROD-REL-04: `operational_rehearsal`, the product scenario and its checks, the `local_engine` commit binding, and the remaining wave6 cases that did not run (3 of 7 non-live cases).
