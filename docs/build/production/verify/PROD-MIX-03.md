# PROD-MIX-03: Typed scoped dependency outputs

## L1-LIVE-AWS provider slice (8 October 2026)

Acceptance: Typed outputs/secret references preserve provenance and scope; newly materialized effects require review unless precisely preauthorized.

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

## PROD-MIX-03: L2 live acceptance successor

This is an additive harness packet; existing implementation/contract evidence remains in the combined requirement docs. No live acceptance was run, no requirement was verified, and no test expectation was weakened.

Files: `scripts/acceptance/live/{azure,gcp,oci,dns}/**`, `deploy/live-sandbox/{azure,gcp,oci}/**`, [cloud campaign](../LIVE-ACCEPTANCE-CLOUDS.md). Acceptance maps to **mixed-output-scope**; the campaign table lists every subclause and required independent readback. Contract tests are `scripts/acceptance/live/dns/offline.test.ts`; the real gated successor is `clouds.live.test.ts`.

Mac offline command (Node 22, no services/cloud):
```bash
npx vitest run --config scripts/acceptance/live/dns/vitest.config.ts scripts/acceptance/live/dns/offline.test.ts --no-file-parallelism --maxWorkers=2
npx eslint scripts/acceptance/live
npx tsx scripts/acceptance/live/gcp/run.ts --plan --packet scripts/acceptance/live/gcp/packet.json.example
```
Expected: zero failed/skipped offline cases and zero credential reads/network calls in plan.

Mac real command, **only after owner approval**: start the canonical operated Wave 5 API/worker/runner fixture through its release harness. Its exact startup/packet-emitter join is absent on this base and must be supplied by that owner before running; do not invent a replacement startup. Provision only owned disposable targets and apply the existing real browser approvals. Put its non-secret packet, owner-approved permissions, short-lived provider credential FILE references and API token FILE outside the clean frozen checkout, as specified in the campaign.

```bash
export ZENITH_LIVE_GCP=1
export ZENITH_LIVE_GCP_CREDENTIAL_FILE="$HOME/.zenith-live/gcp-credential-ref.json"
export ZENITH_LIVE_API_TOKEN_FILE="$HOME/.zenith-live/api-token"
npx tsx scripts/acceptance/live/gcp/run.ts --packet "$HOME/.zenith-live/PROD-MIX-03-packet.json" --permissions "$HOME/.zenith-live/PROD-MIX-03-permissions.json" --out "$HOME/.zenith-live/PROD-MIX-03-evidence.json"
# Recovery reuses the same immutable packet and needs fresh reviewed authority if it expired:
npx tsx scripts/acceptance/live/gcp/run.ts --cleanup --packet "$HOME/.zenith-live/PROD-MIX-03-packet.json" --permissions "$HOME/.zenith-live/PROD-MIX-03-permissions.json" --out "$HOME/.zenith-live/PROD-MIX-03-cleanup-evidence.json"
```
Expected: each clause's selected checks passed_live, consumed human destructive approvals for exact scoped environments, independently empty complete paginated inventories. Run the other provider entry points for clauses spanning clouds. Sovereign, faults, ACME renewal, traffic/data and private connectivity must each be actually operated; no status-only or mocked substitutes.

Lean Mac profile: one fixture/provider at a time; one worker; two small replicas at most; 8 GiB host/4 GiB Docker; stop only owned resources and keep private packets for recovery.

Remaining: Wave 5 fixture emission/startup and `zenith_live_run` tagging joins, AWS partition receipt for mixed scenarios, provider initialization/IAM admission, owner-created live accounts and live verification. No new migrations/tables/store functions. Assembler registers the custom vitest config in the gate manifest and attaches sanitized artifacts to the ledger at one coherent commit. Suggested status: `implementation_complete_verification_pending` for this harness slice; overall acceptance stays pending.

## L3 live and operational verification (2026-10-08)

Acceptance contract: Typed outputs/secret references preserve provenance and scope; newly materialized effects require review unless precisely preauthorized.

Profile: **mixed**. The owner observation matrix in [LIVE-ACCEPTANCE-MANAGED.md](../LIVE-ACCEPTANCE-MANAGED.md) maps every clause above to real product receipts, provider reads and traffic or operational observations. Fill distinct checks for every clause; a generic operation-status assertion is insufficient.

Implementation: `scripts/acceptance/live/managed/{plan,runner,transport,cli}.ts`, `scripts/acceptance/live/mixed/probes.ts`, the profile shell entry point. Offline checks: `tests/acceptance/live-managed.test.ts`, `tests/acceptance/live-managed-transports.test.ts`; actual Mac owner-gated checks: `tests/acceptance/live-l3.gated.test.ts`. No library injection replaces the CLI transport.

Mac prerequisites: Node 22; clean committed integrated RC; running owner-operated disposable Zenith/PostgreSQL/Temporal stack; managed cloud/CNI/runtime and two tenants for managed isolation; exact sandbox accounts/regions/real DNS/ACME/registry/Stripe test mode/private source fixtures as applicable. The shared runbook lists exact accounts, credentials as FILE references, and separate DEC-CLOUD, DEC-BUSINESS, DEC-RETENTION and signing/signoff approvals. For the lean 8 GB Mac/4 GiB Docker profile, observe an already operated remote sandbox; local cluster/engine rehearsals run one heavy process at a time after J1/J11/J14 integration.

Exact Mac commands, after owner has prepared the private recipe, permissions and approval FILEs described in the shared runbook:

```bash
bash scripts/acceptance/live/mixed/acceptance.sh --plan --fixture "$L3_PRIVATE/mixed.recipe.json"
export ZENITH_LIVE_SCOPE_FILE="$L3_PRIVATE/permissions.json"
npx tsx scripts/release/permissions-cli.ts check
export ZENITH_L3_APPROVAL_FILE="$L3_PRIVATE/mixed.approval.json"
export ZENITH_L3_BUDGET_FILE="$L3_PRIVATE/budget.json"
export ZENITH_L3_OUT="$PWD/.data-live/l3"
ZENITH_LIVE_MIXED=1 bash scripts/acceptance/live/mixed/acceptance.sh --run --fixture "$L3_PRIVATE/mixed.recipe.json"
# On interruption: audit the original journal/lock, then cleanup only with the same RC and approvals.
ZENITH_LIVE_MIXED=1 bash scripts/acceptance/live/mixed/acceptance.sh --cleanup-only --fixture "$L3_PRIVATE/mixed.recipe.json"
```

Expected: --plan opens no credential and makes zero calls; --run exits 0 only when every required profile scenario, actual assertion, approved cleanup and independent inventory passed. Exit 1 is a failed check, 2 refusal, 3 incomplete/cleanup-only. Live vitest alternative is in the shared runbook; all three live tests explicitly skip when their gates are disabled. Never count those skips as acceptance passes.

Not run here: cloud, real PostgreSQL, Temporal, Docker/kind, browser and operated-stack rehearsals. This row remains pending live/operational evidence and applicable owner decisions. Do not interpret generic tag-index scans as proof of all global/untaggable/unsupported resources being gone. Add direct provider-specific inventories from L1/L2 and review the actual observation matrix before accepting the ledger clause.

Integration joins: exact managed/release grants are absent from the shipped unapproved permissions.json; owner/integrator approval required before any live call. Use the original normal browser approval paths for all execution/teardown. Share the conservative budget book with L1/L2; connect J1/J2/J4/J5/J6/J11/J14/J15 receipt producers and J12 dossier/signoff. No platform migrations, aggregate SQL, package or published migration edits in this job.

Suggested ledger status: `implementation_complete_verification_pending` (L3 harness built; requirement verification and unresolved owner decisions remain pending).


## Wave 6 final integration

Status remains `implementation_complete_verification_pending`. Node 22 only. Execute sequentially with Docker Desktop 4 GiB and one kind node; stop each heavy profile before starting another. Live acceptance stays deferred until separate owner approval.

```bash
node scripts/ci/wave6-gates.mjs --requirement PROD-MIX-03 --print > /tmp/zenith-wave6-PROD-MIX-03.commands.json
```

This prints the exact argv for each contract batch and required engine case, its gate names, private prerequisites, and its strict report-validation command. Set only the gates for the selected lane after preparing its owned fixture; a skip cannot satisfy that lane. Run each `argv` sequentially and then its `verify` argv. [Final integration setup and results](FINAL-INTEGRATION.md), [canonical inventory](../../../../scripts/ci/wave6-gates.json), [owner live runbook](../LIVE-ACCEPTANCE.md).

## Owner decision (2026-10-26): reference contracts in readback

Delegated owner decision. A client must be able to issue a precise one-reference preauthorization without guessing any digest. The readbacks now expose, per dependency reference:

- `GET /api/platform/v1/mixed/plans/:id`: `desiredDigest` (top level) and `references[]`.
- `GET /api/platform/v1/operations/:id/mixed-run`: `references[]`, joined from the stored plan by parent operation (empty when the operation has no stored plan).

Each entry carries the reference id, producer and consumer partition ids, producer and consumer addresses, output and input names, value type, the `contractDigest` the consumer approval binds, the producer and consumer subplan digests, and the state. With the parent operation and environment from the plan, these are exactly the fields `POST /api/platform/v1/mixed-output-preauthorizations` checks (`referenceId`, `contractDigest`, `consumerSubplanDigest`, `producerSubplanDigest`, `desiredDigest`, `valueType`). Nothing is a value: no secret, no vault reference, no credential. A legacy reference without a stored contract reads as nulls.

Serializer: `src/lib/execution/mixed/readback.ts` (pure; used by both routes). Tests: `tests/execution/mixed/reference-readback.test.ts` (shape, digest equal to the recomputed contract digest, digests and types only, legacy nulls, empty inventory). No preauthorization or review behaviour changed.

Verification scope: offline contract tests only. Status is unchanged: `implementation_complete_verification_pending`.

## MIX-03 on the live AWS sandbox (2026-10-28)

Run [40635277474](https://github.com/saivedant169/zenith/actions/runs/40635277474), run id `zlive-202610280458-5e03`, source `619071fe5a3bc0aa0dc9f66147ca8695e05c73c5`. Sandbox account 361646636162 in ap-south-1. Plan `c249d8f5…bd9161ef9d5bf`, cap USD 0.90 (provisional, billing not measured), 20 minutes. Verdict incomplete (1 pending), cleanup complete. Files: `evidence/PROD-MIX-03/2026-10-28-live-aws-40635277474/`.

What it proved:

- The trust change touched only the ExternalId of both sandbox roles, and it was restored. `connection.verifyAws` passed.
- The producer (S3 bucket) finished before the consumer (Lambda function) started.
- Both mixed-run receipts link their child operations.
- The consumer's deployed `PRODUCER_BUCKET_ARN` equals the producer bucket ARN, by independent readback.
- Approvals were made by an automated test approver through the browser path.

How we got here (runs on 2026-10-27 and 2026-10-28):

- Teardown matches the Lambda driver's `logs` inline policy and orphan log groups (#74).
- The driver reads the detail of every unsuccessful child and reports a fixed halt category (#75, #76, #77).
- Dispatch-wrapped OpenTofu failures carry a fixed cause code (`src/lib/tofu/failure-code.ts`, #78).
- The deploy role gained `lambda:GetFunctionCodeSigningConfig`, which the AWS provider reads after every create and refresh of a Zip function (#79). The `zenith-connection-live` stack was updated from CloudShell.
- The Lambda driver's observe, runtime and discover reads use `GetFunctionConfiguration` and `ListTags`, which the observe role allows, instead of `GetFunction`, which it does not (#80).

Limits: still pending are the producer-change review and the one-use preauthorization refusal, which no product route can trigger yet. Secret references, operational rehearsal and the owner decisions above are also still pending. Status stays `implementation_complete_verification_pending`. Not a promotion.

## Review path and one-use preauthorization proven on the live AWS sandbox (2026-10-31)

Run [41241063623](https://github.com/saivedant169/zenith/actions/runs/41241063623), run id `zlive-202610312054-5dfc`, workflow `live-acceptance.yml`, scenario `mix-03`, lane `live2`. Source `8fa3842af56cead08191e922075f421f21368440`. Sandbox account `361646636162` in ap-south-1. Plan digest `bb51c440e9316fc51d57d8ab7c88be5c50da67c564d62c0153c26ee91a7d781a`; permission digest `8f0c9a4434a7f585fcdcfae9095bc501543f2fb30e6535ba524df2242dae08c4`.

Verdict `passed`: 2 passed (PROD-MIX-03, PROD-MIX-02), 0 failed, 0 pending. Cleanup complete. Estimated cap USD 1.3 (provisional, billing not measured), 40 minute window; the scenario took about 16 minutes. Files: `evidence/PROD-MIX-03/2026-10-31-live-aws-41241063623/`, including the `zenith.release-evidence.v1` receipt `release-evidence-PROD-MIX-03.json`.

What the run checked (`scripts/acceptance/live/product/mix-03.ts`, `mix-03-driver.ts`):

- The trust change touched only the ExternalId of both sandbox roles and was restored. `connection.verifyAws` passed.
- Review path: the producer (S3 bucket) finished before the consumer (Lambda function) started. The producer's newly materialized output changed the consumer's effect, so the parent workflow opened a review binding the new parent digest (previous `7398cfda2f66`, required `97d8dc91122e`). The consumer waited until the review was approved.
- The consumer's deployed `PRODUCER_BUCKET_ARN` equals the producer bucket ARN by independent AWS readback. Both receipts link their child operations.
- Preauthorized path: a second parent had its one reference precisely preauthorized before it started (parent operation, reference, contract, both subplan digests, desired digest, value type; one use, 15 minutes).
- Its consumer started with no review. The one use was spent (1 of 1) and the product no longer lists the grant as active. The second consumer's `PRODUCER_BUCKET_ARN` equals its own producer bucket ARN.
- Approvals were made by an automated test approver through the browser path.

Fixes found on the way: the run window grew to 40 minutes for two parents (PRs #143, #144); the driver issued the grant for the consumer child environment, while the join matches grants on the parent plan's environment (PR #145).

Limits: a second materialization against the spent grant is not attempted; its refusal rests on the reservation rule (`uses < max_uses`) and the active listing. Secret references, operational rehearsal and the owner decisions above are still pending. Status stays `implementation_complete_verification_pending`. Not a promotion.

## Contract and local engine receipts at the live run's commit (2026-11-01)

Source `8fa3842a`, the commit of this requirement's `live_sandbox` receipt, so the levels share one commit. Each lane ran on a clean detached checkout of that commit through `scripts/release/lane-source.mjs`, on a Mac mini (Darwin arm64) with Node 22.23.3. `scripts/release/evidence-cli.mjs` bound a `zenith.release-evidence.v1` receipt to each source.

- `contract`: 320 passed, 0 failed, 0 skipped over 11 test files, offline, no engine or network. Files: `docs/build/production/evidence/PROD-MIX-03/2026-11-01-contract-8fa3842a/`.
- `local_engine`: 86 passed, 0 failed, 0 skipped over 2 test files, against a disposable PostgreSQL 16.15 (pinned digest) migrated by the checkout's own migrator. Files: `docs/build/production/evidence/PROD-MIX-03/2026-11-01-local-engine-8fa3842a/`.


`operational_rehearsal` is still not done. Not a promotion.
