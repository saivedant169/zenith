# PROD-OPS-06: Sensitive persistence minimization

## L1-LIVE-AWS provider slice (8 October 2026)

Acceptance: Protect unavoidable raw plans/state, minimize persistence and test leaks; no claim redaction catches every unknown secret.

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

Acceptance contract: Protect unavoidable raw plans/state, minimize persistence and test leaks; no claim redaction catches every unknown secret.

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
node scripts/ci/wave6-gates.mjs --requirement PROD-OPS-06 --print > /tmp/zenith-wave6-PROD-OPS-06.commands.json
```

This prints the exact argv for each contract batch and required engine case, its gate names, private prerequisites, and its strict report-validation command. Set only the gates for the selected lane after preparing its owned fixture; a skip cannot satisfy that lane. Run each `argv` sequentially and then its `verify` argv. [Final integration setup and results](FINAL-INTEGRATION.md), [canonical inventory](../../../../scripts/ci/wave6-gates.json), [owner live runbook](../LIVE-ACCEPTANCE.md).

## OPS-06 on the live AWS sandbox (2026-10-29)

Run [40878106025](https://github.com/saivedant169/zenith/actions/runs/40878106025), run id `zlive-202610291300-ec69`, workflow `live-acceptance.yml`, scenario `ops-06`, lane `live2`. Source `ffdcfef1b30328ed1022c3452986a6cb62f7239a`. Sandbox account `361646636162` in ap-south-1. Plan digest `0498a4d976e60dac19c1412eac40eac2051c97b055b6bcc87f01f58104b55531`; permission digest `10bf994cb6ad63ff1f5133bb795785460edd756a9515a04f01a260fd9f46296e`.

Verdict `passed`: 1 passed, 0 failed, 0 pending. Cleanup complete. Estimated cap USD 2.5 (provisional, billing not measured), 50 minute window. Files: `evidence/PROD-OPS-06/2026-10-29-live-aws-40878106025/`.

What it proved:

- `ZENITH_OPS06_CANARY` was set through `system.setSecret`, and deployed to ECS Fargate behind an ALB with two-person approval. The service served HTTP 200.
- The recorded OpenTofu state holds only the Secrets Manager reference, not the value.
- A raw-byte scan of Docker's data root (container logs, volumes, written files), the runner temp and the checkout found the value only in its own control file.

Onboarding note: the AWS provider reads `secretsmanager:GetResourcePolicy` for every managed secret on create, refresh and destroy. PR #95 (merged 2026-10-29) added that permission to the bootstrap templates. Existing customer connection stacks must be re-applied to get it.

Limits: `operational_rehearsal` is not done, and the requirement lists it as required. This is a canary secret through the ECS path only, not every secret path. `evidence.json` is not a `zenith.release-evidence.v1` receipt, and its `releaseStatus` flags are all false. Status stays `in_progress` and `implementationStatus` is unchanged. Not a promotion.

## Contract and local engine receipts at the live run's commit (2026-11-01)

Source `ffdcfef1`, the commit of this requirement's `live_sandbox` receipt, so the levels share one commit. Each lane ran on a clean detached checkout of that commit through `scripts/release/lane-source.mjs`, on a Mac mini (Darwin arm64) with Node 22.23.3. `scripts/release/evidence-cli.mjs` bound a `zenith.release-evidence.v1` receipt to each source.

- `contract`: 124 passed, 0 failed, 0 skipped over 10 test files, offline, no engine or network. Files: `docs/build/production/evidence/PROD-OPS-06/2026-11-01-contract-ffdcfef1/`.
- `local_engine`: 1 passed, 0 failed, 0 skipped over 1 test files, against a disposable PostgreSQL 16.15 (pinned digest) migrated by the checkout's own migrator, with OpenTofu 1.12.5. Files: `docs/build/production/evidence/PROD-OPS-06/2026-11-01-local-engine-ffdcfef1/`.

Limits: `tests/acceptance/aws-ops06-port.test.ts` is left out of the contract lane; one of its cases runs only on Linux. The engine lane is one PostgreSQL case.

`operational_rehearsal` is still not done. Not a promotion.
