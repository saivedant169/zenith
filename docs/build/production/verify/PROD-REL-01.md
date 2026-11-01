# PROD-REL-01: Required end-to-end release evidence

DRV-2 now builds dedicated operated drift-repair and crash-partition drivers. Exact separate lean-profile Mac setup, gated commands, strict receipt validation and owned cleanup are in [DRV-2](DRV-2.md). Offline build proof does not promote either scenario to operated or live acceptance.

DRV-3 implements the local operated upgrade and restore slices through dedicated
drivers, scenario-runner registration and canonical gated lanes. See
[DRV-3](DRV-3.md) for exact sequential lean Mac commands, per-clause evidence and
limits. Expected operated test count per lane is 1 passed / 0 failed / 0 skipped;
this PC has not run either. Other J15 scenarios and live acceptance remain
separate; no production readiness or release signoff is asserted.

## D2/D3 merge verification (8 October 2026)

The merged registry contains 19 scenarios and 80 mapped files. All four operated
driver lanes and their exact required cases remain registered. Offline release
tests passed 77 / 0 / 4; the four skips need native Mac ARM64, owned J1/J2 fixtures,
Docker, kind, Chromium and Temporal. Gate-manifest passed 305 / 0 / 0. The initial
platform-coverage run timed out in its repository-wide network-gate scan; that
unchanged case passed alone, then the full file passed 67 / 0 / 0. Ownership and
LIFE-12 passed 80 / 0 / 38; the 38 native PostgreSQL cases remain unrun. Final
14-file lint, production-ledger check, source/assertion preservation and conflict
marker checks passed. No typecheck was requested for this merge round.

GitHub workflow integration remains open: the focused canonical execution and
sanitized-upload checks in `tests/ci/release-gates.test.ts` produced 22 passed,
8 failed and 97 filtered tests. `ci.yml` lacks jobs for `drv2-drift-repair`,
`drv2-crash-partition`, `j15-operated-upgrade` and `j15-operated-restore`. Each
missing job fails both checks. The lanes and assertions are retained; an owned
native Mac fixture workflow still needs integration. No operated or live pass,
complete CI pass, or release approval follows from the offline results.

## DRV-4 local operated two-tenants and export (8 October 2026)

Dedicated browser/API/MCP tenant-isolation, customer-data and infrastructure-export drivers are
implemented. Exact sequential **lean** fixture preparation, cleanup, receipt
counts, offline commands and boundaries: [DRV-4](DRV-4.md). Each scenario requires
its own fresh owned J1/J2 fixture; the driver destroys it. No local or live
operated execution is claimed on the Windows builder.

After the corresponding private configuration and native Mac fixtures described
there are ready, the exact gated commands are:

```bash
export PATH="$HOME/.local/sdk/node22:$PATH"
ZENITH_LOCAL_DRIVER_D4=1 node scripts/ci/run-gate.mjs drivers-d4-two-tenants --run --report "$PRIVATE_RECEIPT_ROOT/two-tenants-vitest.json" --evidence "$PRIVATE_RECEIPT_ROOT/two-tenants-gate.json"
# Prepare a new J1/J2 lean fixture before the next command.
ZENITH_LOCAL_DRIVER_D4=1 node scripts/ci/run-gate.mjs drivers-d4-export --run --report "$PRIVATE_RECEIPT_ROOT/export-vitest.json" --evidence "$PRIVATE_RECEIPT_ROOT/export-gate.json"
```

Required config FILE variables are `ZENITH_LOCAL_TWO_TENANTS_CONFIG_FILE` and
`ZENITH_LOCAL_EXPORT_CONFIG_FILE`. Expected required operated case: passed, never
skipped; receipts: 11/0/0 tenant checks and 17/0/0 export checks, labelled
`local_operated_rehearsal`. Infrastructure export is independent OpenTofu into
LocalStack. The follow-up also exercises customer-data portability through
LIFE-11 PostgreSQL/MySQL/MinIO engines; a second real cloud provider remains
live-deferred. See [exact data fixture commands and boundaries](PROD-LIFE-11.md).
The full PROD-REL-01 status remains verification pending.

## L1-LIVE-AWS provider slice (8 October 2026)

Acceptance: Clean install/private source/plan approval/DNS-TLS/stateful traffic/update-rollback/machine schedules/drift-repair/revocation/crash-partition-writers/key rotation/upgrade/restore/mixed traffic/two tenants/export/teardown independently verified.

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

Acceptance contract: Clean install/private source/plan approval/DNS-TLS/stateful traffic/update-rollback/machine schedules/drift-repair/revocation/crash-partition-writers/key rotation/upgrade/restore/mixed traffic/two tenants/export/teardown independently verified.

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
node scripts/ci/wave6-gates.mjs --requirement PROD-REL-01 --print > /tmp/zenith-wave6-PROD-REL-01.commands.json
```

This prints the exact argv for each contract batch and required engine case, its gate names, private prerequisites, and its strict report-validation command. Set only the gates for the selected lane after preparing its owned fixture; a skip cannot satisfy that lane. Run each `argv` sequentially and then its `verify` argv. [Final integration setup and results](FINAL-INTEGRATION.md), [canonical inventory](../../../../scripts/ci/wave6-gates.json), [owner live runbook](../LIVE-ACCEPTANCE.md).

## DRV-1 dedicated operated scenario successors (2026-10-08)

`private-source` and `update-rollback` now have dedicated J15 runner registrations
and strict gated manifest lanes, `drv1-private-source` and `drv1-update-rollback`.
Follow [DRV-1](DRV-1.md) for the exact sequential lean-profile Mac setup, commands,
owned teardown and expected **1 passed / 0 failed / 0 skipped per gate**. Both
receipts are labelled `local_operated_rehearsal`. The source lane establishes
private admission, browser approval, a successful J6 isolated build, independently
verified provenance and running digest, then revoked execution refusal with an
authenticated local GitHub emulator. The lane requires the dedicated worker and
real enforcing runtime/CNI described in DRV-1. The update lane performs real deployments,
failed rollout, independent serving/release readbacks and exact browser-approved
rollback. Neither closes live-cloud or complete PROD-REL-01 acceptance.

```bash
export PATH="$ZENITH_NODE22_BIN:$PATH"
node scripts/ci/gate-manifest.mjs drv1-private-source
node scripts/ci/gate-manifest.mjs drv1-update-rollback
# After the actual Mac runs in DRV-1.md, validate their fresh private reports:
node tests/ci/assert-lane-report.mjs drv1-private-source "$DRV1_PRIVATE/evidence/private-source.json"
node tests/ci/assert-lane-report.mjs drv1-update-rollback "$DRV1_PRIVATE/evidence/update-rollback.json"
```

Windows: offline contracts built and checked; two operated cases not run (needs
Mac Docker, native PostgreSQL, Temporal, kind and browser). Requirement status
remains `implementation_complete_verification_pending`; no acceptance receipt was
manufactured and no live API was called.

## DEPLOY-01 on the live AWS sandbox (2026-10-27)

Run [40460096635](https://github.com/saivedant169/zenith/actions/runs/40460096635), run id `zlive-202610270616-201f`, source `f436e3dbeda2f40007301bd05d23048b10ec70b0`. Sandbox account 361646636162 in ap-south-1. Plan `8fb3cbd1…9eca48`, cap USD 2.20 (provisional, billing not measured), 40 minutes. Verdict passed, cleanup complete. Files: `evidence/PROD-REL-01/2026-10-27-live-aws-40460096635/`.

What it proved:

- Zenith connected to the sandbox through the `zenith-connection-live` roles.
- It deployed nginx `@sha256:df80ece7…` to ECS Fargate behind an ALB with two-person approval, and the service answered HTTP 200.
- It updated to `@sha256:4aad0a9f…`, then rolled back to `@sha256:df80ece7…`. Each step was read back from the recorded OpenTofu state and over HTTP.
- The harness destroyed the environment's recorded state and found no tagged resources left.

How we got here (runs 7 to 14): deploy-role permission gaps (fixed in PRs #55 and #56), pinned image digests (#57), failed-check diagnostics (#58), IAM role lookup through the lagging tag index (#59), the leak check's handling of the lagging tag index (#60 and #62), and a transient 409 on approval (#61). The leak check excuses only ARNs or ids the destroy removed, task definitions and stopped tasks of destroyed families and clusters, and subnets once their VPC was destroyed. AWS refuses DeleteVpc while a subnet remains.

Limits: this covers one ECS service through clean install, plan approval, update, rollback and teardown. DNS-TLS, stateful traffic, schedules, drift repair, revocation, key rotation, upgrade, restore, two tenants and export are still pending. No operational rehearsal. Not a promotion.

## Contract and local engine receipts at the live run's commit (2026-11-01)

Source `f436e3db`, the commit of this requirement's `live_sandbox` receipt, so the levels share one commit. Each lane ran on a clean detached checkout of that commit through `scripts/release/lane-source.mjs`, on a Mac mini (Darwin arm64) with Node 22.23.3. `scripts/release/evidence-cli.mjs` bound a `zenith.release-evidence.v1` receipt to each source.

- `contract`: 311 passed, 0 failed, 0 skipped over 10 test files, offline, no engine or network. Files: `docs/build/production/evidence/PROD-REL-01/2026-11-01-contract-f436e3db/`.
- `local_engine`: 1016 passed, 0 failed, 0 skipped over 60 test files, against a disposable PostgreSQL 16.15 (pinned digest) migrated by the checkout's own migrator, with Temporal CLI 1.9.1. Files: `docs/build/production/evidence/PROD-REL-01/2026-11-01-local-engine-f436e3db/`.

Limits: the engine lane runs the release orchestrator's `local_engine` lane files except `tests/runners/late-effect-receipts.test.ts` (per-lane structural skips) and `tests/portability/postgres-engine.test.ts`. Its opt-in `ZENITH_TEST_POSTGRES_URL` lane is not run by CI, and two of its cases failed here with a statement error; that is still open.

`operational_rehearsal` is still not done. Not a promotion.
