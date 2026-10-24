# PROD-MAN-07: Operator commercial decisions

## L1-LIVE-AWS provider slice (8 October 2026)

Acceptance: Pricing/terms/payment accounts and destructive retention await accountable decisions; nonpayment never silently destroys data.

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

Acceptance contract: Pricing/terms/payment accounts and destructive retention await accountable decisions; nonpayment never silently destroys data.

Profile: **managed**. The owner observation matrix in [LIVE-ACCEPTANCE-MANAGED.md](../LIVE-ACCEPTANCE-MANAGED.md) maps every clause above to real product receipts, provider reads and traffic or operational observations. Fill distinct checks for every clause; a generic operation-status assertion is insufficient.

Implementation: `scripts/acceptance/live/managed/{plan,runner,transport,cli}.ts`, `scripts/acceptance/live/mixed/probes.ts`, the profile shell entry point. Offline checks: `tests/acceptance/live-managed.test.ts`, `tests/acceptance/live-managed-transports.test.ts`; actual Mac owner-gated checks: `tests/acceptance/live-l3.gated.test.ts`. No library injection replaces the CLI transport.

Mac prerequisites: Node 22; clean committed integrated RC; running owner-operated disposable Zenith/PostgreSQL/Temporal stack; managed cloud/CNI/runtime and two tenants for managed isolation; exact sandbox accounts/regions/real DNS/ACME/registry/Stripe test mode/private source fixtures as applicable. The shared runbook lists exact accounts, credentials as FILE references, and separate DEC-CLOUD, DEC-BUSINESS, DEC-RETENTION and signing/signoff approvals. For the lean 8 GB Mac/4 GiB Docker profile, observe an already operated remote sandbox; local cluster/engine rehearsals run one heavy process at a time after J1/J11/J14 integration.

Exact Mac commands, after owner has prepared the private recipe, permissions and approval FILEs described in the shared runbook:

```bash
bash scripts/acceptance/managed-acceptance.sh --plan --fixture "$L3_PRIVATE/managed.recipe.json"
export ZENITH_LIVE_SCOPE_FILE="$L3_PRIVATE/permissions.json"
npx tsx scripts/release/permissions-cli.ts check
export ZENITH_L3_APPROVAL_FILE="$L3_PRIVATE/managed.approval.json"
export ZENITH_L3_BUDGET_FILE="$L3_PRIVATE/budget.json"
export ZENITH_L3_OUT="$PWD/.data-live/l3"
ZENITH_LIVE_MANAGED=1 bash scripts/acceptance/managed-acceptance.sh --run --fixture "$L3_PRIVATE/managed.recipe.json"
# On interruption: audit the original journal/lock, then cleanup only with the same RC and approvals.
ZENITH_LIVE_MANAGED=1 bash scripts/acceptance/managed-acceptance.sh --cleanup-only --fixture "$L3_PRIVATE/managed.recipe.json"
```

Expected: --plan opens no credential and makes zero calls; --run exits 0 only when every required profile scenario, actual assertion, approved cleanup and independent inventory passed. Exit 1 is a failed check, 2 refusal, 3 incomplete/cleanup-only. Live vitest alternative is in the shared runbook; all three live tests explicitly skip when their gates are disabled. Never count those skips as acceptance passes.

Not run here: cloud, real PostgreSQL, Temporal, Docker/kind, browser and operated-stack rehearsals. This row remains pending live/operational evidence and applicable owner decisions. Do not interpret generic tag-index scans as proof of all global/untaggable/unsupported resources being gone. Add direct provider-specific inventories from L1/L2 and review the actual observation matrix before accepting the ledger clause.

Integration joins: exact managed/release grants are absent from the shipped unapproved permissions.json; owner/integrator approval required before any live call. Use the original normal browser approval paths for all execution/teardown. Share the conservative budget book with L1/L2; connect J1/J2/J4/J5/J6/J11/J14/J15 receipt producers and J12 dossier/signoff. No platform migrations, aggregate SQL, package or published migration edits in this job.

Suggested ledger status: `implementation_complete_verification_pending` (L3 harness built; requirement verification and unresolved owner decisions remain pending).


## Wave 6 final integration

Status remains `implementation_complete_verification_pending`. Node 22 only. Execute sequentially with Docker Desktop 4 GiB and one kind node; stop each heavy profile before starting another. Live acceptance stays deferred until separate owner approval.

```bash
node scripts/ci/wave6-gates.mjs --requirement PROD-MAN-07 --print > /tmp/zenith-wave6-PROD-MAN-07.commands.json
```

This prints the exact argv for each contract batch and required engine case, its gate names, private prerequisites, and its strict report-validation command. Set only the gates for the selected lane after preparing its owned fixture; a skip cannot satisfy that lane. Run each `argv` sequentially and then its `verify` argv. [Final integration setup and results](FINAL-INTEGRATION.md), [canonical inventory](../../../../scripts/ci/wave6-gates.json), [owner live runbook](../LIVE-ACCEPTANCE.md).

## Pricing decision recorded (2026-10-13)

Owner Arnav Bule decided launch pricing under DEC-BUSINESS on 2026-10-13. What is decided and what remains open:

| Item | Status |
|---|---|
| Launch packages and prices: Explore (free), Builder ($29/month minimum), Team ($199/month minimum), Enterprise (custom, by contract); $0.015 per ZCU-hour above the included usage | DECIDED, implemented in `src/lib/billing/plans.ts` and `invoice.ts` |
| ZCU definition: one resource managed by Zenith for one hour (the `managed_resource_hours` meter); build minutes and storage included, bounded by fair-use caps | DECIDED |
| Payment account, live Stripe keys, terms of service, tax handling | NOT decided. Live charging stays off; the adapter refuses live keys |
| Fair-use limits (active operations 3 / 15 / 60, build and storage caps) | carried forward from the earlier catalog, adjustable |
| Destructive retention (DEC-RETENTION) | approved 2026-10-13 (windows, holds); deletion stays off until operators set the apply switches |

Nonpayment still never silently destroys data: suspension stops NEW provisioning work only, and export and destroy stay available.

The formula with worked examples, the entitlements and where each is enforced, and the Mac verifier commands (including Stripe TEST mode) are in
[PROD-MAN-06](PROD-MAN-06.md#pricing-decision-update-2026-10-13). Verifier summary: run `npx vitest run tests/billing tests/platform/billing-schedule.test.ts --no-file-parallelism --maxWorkers=2`
and the Stripe test-mode steps there; confirm no live key is accepted and that an Enterprise account yields `contract_billed` rather than an invoice.
This requirement stays pending until the payment account and terms review exist.
