# DRV-4: operated two-tenants, customer data and infrastructure export

The a7371b55 base drivers are build complete; Mac operated verification pending. These are two dedicated J15
drivers, not adapters that promote J2 component evidence. Every successful receipt
is labelled `local_operated_rehearsal`; it never establishes live or production
acceptance. No migrations, dependency metadata, credentials, commits or cloud API
calls were added or performed.

Customer-data wiring round after the helper merge at `399bd27b`: all three real
legs are imported, and `export-data-helper-stubs.d.ts` is deleted. MySQL seeds
`tenant_a` and `tenant_b` in separate databases; each tenant's object keys occupy
its own `drv4-<runId>-data-a/b` bucket. Orchestration creates the MySQL databases
in both owned containers and tags both empty object targets with
`zenith-owner=DRV4-DATA:<runId>` before seeding. Verified MySQL TLS, table ownership
comments and bucket tags are preserved. Whole-unit independent readbacks and
foreign-target emptiness refuse leakage; all four MySQL table/object bucket
cleanup responsibilities are attempted even after an ownership refusal.
Socket-only image initialization is not treated as TCP readiness: both published
database endpoints are probed before seeding, with verified TLS for MySQL and
bounded retries while the final listener starts.

The three offline leg tests are registered additively in the export component
lane. They exercise protocol fakes and cannot certify real engine acceptance;
the exact gated Mac lane below remains required.

## Files and acceptance mapping

| Scenario / acceptance | Implementation and evidence |
|---|---|
| J1 preconditions | `drivers/operated.ts` checks explicit gates, fresh private output, unprivileged native arm64 Mac/Node22, local Docker, J1 lean ownership, exact commit/content/dirty binding, actual readiness, and J2's owned kind container id. Real Auth/PG/Temporal/API are used. |
| Two separate tenants | `drivers/two-tenants.ts` creates four real Auth users, verifies recovery mail in Mailpit, signs in through the browser, enrolls actual MFA, creates two workspaces, and invites one independent admin into each. Positive bootstrap checks require each owner to see its own tenant and exclude the other. |
| Actual execution and human approval | Both tenants create/verify scoped kind connections through product paths, consent to bounded linked agents through the browser, propose genuine workflow deployments, and have the other local admin approve through the actual UI at both proposal and immutable plan/semantics rounds. No approval rows, forged browser credentials or policy overrides are seeded. |
| Independent tenant readback | The separate observer kubeconfig queries each owned Deployment's environment annotation, UID, spec, generation, ready replicas and image, then probes the actual served witness. |
| Isolation failure injection | Both directions: foreign project/environment/operation/connection reads, manifest overwrite, deployment cancellation, MCP reads/scale proposals, REST bearer proposals and browser approval of a genuinely pending foreign operation. HTTP401/400/500 and protocol failures cannot satisfy refusals. Own sessions/MCP operations are positive controls. Operation approval state, project manifests and provider object/application digests are independently checked after the attacks. |
| Export source | `drivers/export.ts` starts a digest-pinned native J15 LocalStack image with S3/STS/EC2, on the owned J1 API's network namespace so its existing adapter uses only `localhost:4566`. No Docker socket, cloud credentials or persistent volume is mounted. The fresh account must be empty. |
| Export operations | Create a real local S3 project/production environment through Zenith actions, obtain the second admin's actual browser approval and observe the created bucket independently with `awslocal`. Export through `/api/environments/:id/export`. Require the deployed revision id; edit the working copy and require byte-identical export of the deployed revision. |
| Portable artifact | Write the exact exported files privately, reopen and compare every byte, scan actual Auth admin/kubeconfig/cookie canaries, and refuse path traversal, duplicates, unexpected files, provisioners/modules/backends, nonlocal endpoints and effects outside S3/default-VPC/security-group scaffolding. |
| Export without Zenith | Remove the owned source bucket through an independently browser-approved Zenith deployment. `deploy.apply` refuses an empty system and LocalStack has no workflow teardown route, so that revision keeps one labeled simulated email resource, which makes no LocalStack call. Require independent source-bucket absence. Run native OpenTofu1.12.5 from J1's pinned worker image as the host uid, with a private mount, fresh local state and no product environment/credential forwarding. Inspect the actual saved plan before applying its unchanged bytes. Read S3 versioning, encryption, public-access blocks and EC2 security-group identity independently from LocalStack. |
| Customer DATA roundtrip follow-up | `export-data.ts` composes PostgreSQL/MySQL/MinIO legs. Separate local tenant databases/buckets, fresh owned target containers, actual `data.export`/`data.import` proposals, UI human approvals and browser-only workflow starts. Independent per-row/object digests, exact counts, unchanged source/other tenant, wrong MySQL TLS identity, nonempty-target and cross-workspace export-ID refusals. See [PROD-LIFE-11](PROD-LIFE-11.md) for fixture setup boundaries and commands. |
| Owned cleanup | `OwnedCleanup` registers responsibilities before mutations and settles all in reverse order even after failure. Revoke issued agents, delete owned Auth identities, close browsers, destroy independent Terraform resources and require absence, remove only exact labelled runner/emulator containers, remove private artifact scratch, delete only the J2-owned kind cluster with independent absence, and run J1's canonical ownership-aware cleanup with independent inventory. Any cleanup failure prevents a pass. |
| Receipt | `drivers/protocol.ts` admits only closed scenario/check/readback inventories, exact run/commit/digest binding and the operated label. Diagnostics, bodies, cookie values, kubeconfigs and tokens never enter receipts. Partial/failed/cleanup-failed evidence stays nonpassing. |
| Registration | The two catalog entries dispatch their dedicated CLI through `local-target-runner.ts`. J1 derives the child environment/CA before Node starts. `local-targets.ts`, `scenarios.ts` and `acceptance-orchestrator.ts` preserve labels and strict receipts. `gate-manifest.mjs` has one exact named required case per gated lane; missing or skipped cases cannot pass report validation. |

Offline assertions live in `tests/release/drivers/d4.test.ts`; the actual Mac cases
are in `tests/release/drivers/d4.operated.test.ts`. No assertion or gate was removed.
The existing registry assertion in `tests/release/local-targets.test.ts` now expects
the required operated label and **additional** explicit gates for these two
scenarios; its previous universal label/three-gate expectation was stale against
this handoff. All other scenarios retain their existing expectations.

## Exact lean-profile Mac commands

Run sequentially, from this unchanged checkout under a disposable verifier user.
One kind node; no mixed/acme/billing profile in parallel. The data follow-up adds
up to 1 GiB of bounded container memory to J1/J2 during its sequential database
pairs; confirm headroom on the Mac (6 GiB Docker allocation recommended). This is
still the J1 `lean` profile; no measured fit in a 4 GiB allocation is claimed.
J1 builds current native images; its Node/Go/OpenTofu build pins, Supabase CLI and
canonical platform migrations remain prerequisites from `PKG-04.md`/`PKG-05.md`.
Provide actual digest references in the four image variables below. Install
Chromium beforehand. Add `supabase.localhost` and `issuer.zenith.localhost` as local
loopback names, and trust **this invocation's generated public CA** in the
disposable verifier browser/keychain, using the J1/J2 trust procedure. Never
disable TLS verification. No real cloud credential variable or live gate may be
set. The D4 gate explicitly transfers cleanup of this fresh J1/J2 fixture to the
driver; do not point it at an installation another job needs.

```bash
export PATH="$HOME/.local/sdk/node22:$PATH"
set -euo pipefail
test "$(node -p 'process.versions.node.split(".")[0]')" = 22
test "$(uname -m)" = arm64
: "${GO_BUILDER_IMAGE:?native approved digest required}"
: "${DISTROLESS_IMAGE:?native approved digest required}"
: "${KIND_NODE_IMAGE:?native approved digest required}"
: "${ZENITH_DEFAULT_STACK_REGISTRY_IMAGE:?native approved registry digest required}"
export ZENITH_ACCEPTANCE_DEFAULT_STACK=1 ZENITH_DEFAULT_JOURNEY=1
export ZENITH_LOCAL_TARGETS=1 ZENITH_LOCAL_JOINED_DRIVERS=1 ZENITH_LOCAL_DRIVER_D4=1

# Compile before starting the heavy engines. Only the local J1 registry is used.
docker build -f tests/e2e/default/zenithd.Dockerfile \
  --build-arg GO_BUILDER_IMAGE="$GO_BUILDER_IMAGE" \
  --build-arg DISTROLESS_IMAGE="$DISTROLESS_IMAGE" \
  -t localhost:5000/zenith-j2-witness:drv4 .
npx --no-install playwright install chromium

# Pick ONE scenario. Complete it and its cleanup, then repeat this block for export.
SCENARIO=two-tenants
# SCENARIO=export
export ZENITH_LOCAL_RUN_ID="drv4-$SCENARIO"
PRIVATE_PARENT="$(node -e 'process.stdout.write(require("node:fs").realpathSync(require("node:os").tmpdir()))')"
export ZENITH_LOCAL_ROOT="$(mktemp -d "$PRIVATE_PARENT/zenith-j15-$ZENITH_LOCAL_RUN_ID-XXXXXX")"
chmod 700 "$ZENITH_LOCAL_ROOT"
STACK="$ZENITH_LOCAL_ROOT/stack"
TARGETS="$ZENITH_LOCAL_ROOT/targets"
export ZENITH_ACCEPTANCE_DEFAULT_STACK_DIR="$STACK"
export ZENITH_LOCAL_JOURNEY_CONFIG_FILE="$TARGETS/journey.json"

# J1 refuses collisions and owns rollback of failed preparation. The outer trap
# also covers a failure before the driver can accept cleanup ownership.
trap 'if test -f "$STACK/state.json" && test -f "$STACK/input.json"; then node scripts/acceptance/default-stack/down.mjs "$STACK"; fi' EXIT
node scripts/acceptance/default-stack/up.mjs --profile lean --directory "$STACK"
node scripts/acceptance/default-stack/env.mjs "$STACK" "$ZENITH_LOCAL_ROOT/host.env"
# Export literal key/value pairs, without eval, shell sourcing or logging secrets.
while IFS='=' read -r key value; do export "$key=$value"; done < "$ZENITH_LOCAL_ROOT/host.env"

# Trust STACK/tls/ca.crt in the disposable verifier's browser now, before Auth.
docker push localhost:5000/zenith-j2-witness:drv4
WITNESS_IMAGE="$(docker image inspect localhost:5000/zenith-j2-witness:drv4 --format '{{index .RepoDigests 0}}')"
node tests/e2e/default/prepare.mjs --directory "$TARGETS" --stack "$STACK" \
  --node-image "$KIND_NODE_IMAGE" --witness-image "$WITNESS_IMAGE" \
  --mailpit-url http://127.0.0.1:8025

# Export ONLY: cache the exact native J15 emulator image, no mixed-profile startup.
if test "$SCENARIO" = export; then
  export ZENITH_LOCAL_EXPORT_DATA=1
  : "${ZENITH_LOCAL_EXPORT_POSTGRES_IMAGE:?native PostgreSQL17 digest required}"
  : "${ZENITH_LOCAL_EXPORT_MYSQL_IMAGE:?native MySQL8.4 digest required}"
  : "${ZENITH_LOCAL_EXPORT_MINIO_IMAGE:?native MinIO digest required}"
  for image in "$ZENITH_LOCAL_EXPORT_POSTGRES_IMAGE" "$ZENITH_LOCAL_EXPORT_MYSQL_IMAGE" "$ZENITH_LOCAL_EXPORT_MINIO_IMAGE"; do docker pull "$image"; done
  LOCALSTACK_IMAGE="$(node -e 'const fs=require("node:fs"); const s=fs.readFileSync("deploy/acceptance/local-targets/compose.yml","utf8"); process.stdout.write(s.match(/image: (localstack\/localstack:[^\s]+)/)[1])')"
  docker pull "$LOCALSTACK_IMAGE"
fi

if test "$SCENARIO" = two-tenants; then
  export ZENITH_LOCAL_TWO_TENANTS_CONFIG_FILE="$ZENITH_LOCAL_JOURNEY_CONFIG_FILE"
else
  export ZENITH_LOCAL_EXPORT_CONFIG_FILE="$ZENITH_LOCAL_JOURNEY_CONFIG_FILE"
fi
node scripts/ci/gate-manifest.mjs "drivers-d4-$SCENARIO"
node scripts/ci/run-gate.mjs "drivers-d4-$SCENARIO" --run \
  --report "$ZENITH_LOCAL_ROOT/vitest.json" --evidence "$ZENITH_LOCAL_ROOT/gate-evidence.json"
node scripts/ci/run-gate.mjs "drivers-d4-$SCENARIO" --validate "$ZENITH_LOCAL_ROOT/vitest.json" \
  --require-execution --evidence "$ZENITH_LOCAL_ROOT/gate-evidence.json"
trap - EXIT
```

Each gate's selected actual case must pass, with zero failed or skipped **required**
cases. The other scenario in the file is filtered and establishes no evidence.
Two-tenants receipt: 11 passed / 0 failed / 0 skipped checks. Export receipt:
17 passed / 0 failed / 0 skipped checks. The gate case independently validates
the source digest and receipt, including owned cleanup. Its scratch directory is
`ZENITH_LOCAL_ROOT`; the receipt is `<scenario>.operated-receipt.json` there. No
secret, diagnostic body or raw Playwright output is published.
Prepare a new lean stack/targets and browser CA before the other scenario, because
each invocation destroys the fixture. Do not run the two gated cases together.

To exercise the **scenario runner join** on another fresh fixture prepared by the
same block, replace the gate commands with:

```bash
node node_modules/tsx/dist/cli.mjs scripts/release/local-target-runner.ts run \
  --scenario "$SCENARIO" --run-id "$ZENITH_LOCAL_RUN_ID" \
  --receipt "$ZENITH_LOCAL_ROOT/scenario-receipt.json"
```

Expected exit0 and the same strict operated counts above. Without explicit gates,
the CLI declines (exit2), never reports a pass. For the full release orchestrator,
use the same fresh fixture and
`node node_modules/tsx/dist/cli.mjs scripts/release/acceptance-orchestrator.ts run --only "$SCENARIO" --local-targets --run-id "$ZENITH_LOCAL_RUN_ID" --out "$ZENITH_LOCAL_ROOT/release"`.
Component PG gates must also be supplied when that broader command is used;
skipped components keep that broader report incomplete.

## Boundaries and review

Not run here: both operated cases (needs Mac Docker, actual PostgreSQL/Temporal,
kind, browser and private POSIX fixtures). No live acceptance was run. Export
covers local customer data through LIFE-11 and portable infrastructure, including
the existing exporter's default VPC/security-group scaffold. The aws resource
descriptors in the data fixture select SQL/S3 compatibility engines and do not
certify AWS provisioning or observation. A second real cloud provider remains
live-deferred; public DNS, payments, production HA, object metadata/ACL/version
portability and access/session import are outside these local data assertions.
Two-tenants covers application tenant authority and owned kind objects; it does
not certify isolation from a hostile shared cluster or CNI network enforcement.
No J4 timer evidence is fabricated: schedules are unrelated to these drivers and
remain in the existing maintenance lane. No pebble/stripe-mock profile is started
without a scenario needing it.

The first Mac-sensitive seams are real browser CA trust, Auth enrollment, tenant
policy/immutable-plan approval rounds, native image pins and LocalStack's AWS~5
provider compatibility. The exporter constraints and files are preserved, not
rewritten to pass. Engine errors and cleanup failures remain failures. `finally`
settles all owned cleanup on normal execution failures; an externally killed
process/machine failure still needs the J1/J2 ownership-aware recovery runbook.

Supporting joins beyond new drivers/tests: `local-target-runner.ts` derives the
J1 private environment and dispatches the two files; `acceptance-orchestrator.ts`
preserves their evidence label and permits time for canonical worker drain;
catalog/scenarios/local-target/gate registries add only these two scenarios.
No SQL-scoping, scheduler, policy, migration or CLI product-dispatch seam remains.
The customer-data join also changes `src/lib/capabilities/{ports,product-adapters,broker}.ts`:
canonical `res_` IDs are resolved from current scoped platform rows; portability
uses that row's provider instead of the environment default. Missing/deleted/
foreign/unbound rows refuse, and existing ownership/policy denials stay enforced.
No new tables, store functions, migrations or SQL-scoping classifications were added.
Suggested ledger status: `implementation_complete_verification_pending` for the
DRV-4 slice of PROD-REL-01; the whole requirement is not promoted.

## Builder commands and observed counts

### Wiring round on 399bd27b

Current working-tree inventory: nine modified files, one added and one deleted.
Modified: `scripts/release/drivers/{export-data,export-data-leg,export-data-mysql,export-data-objects}.ts`,
`scripts/release/scenarios.ts`, `tests/release/drivers/{export-data-mysql,export-data-objects}.test.ts`,
this runbook and `PROD-LIFE-11.md`. Added:
`tests/release/drivers/export-data-postgres.test.ts`. Deleted:
`scripts/release/drivers/export-data-helper-stubs.d.ts`. All changes remain
uncommitted. No migration, dependency metadata or cloud API changes.

All shell commands prepend
`$env:PATH = 'C:\Users\user\.local\sdk\node22;' + $env:PATH`.
Exact verification commands for this wiring round:

```powershell
npx vitest run tests/release/drivers/export-data-postgres.test.ts --no-file-parallelism --maxWorkers=2
npx vitest run tests/release/drivers/export-data-mysql.test.ts --no-file-parallelism --maxWorkers=2
npx vitest run tests/release/drivers/export-data-objects.test.ts --no-file-parallelism --maxWorkers=2
npx vitest run tests/release/drivers/export-data-postgres.test.ts tests/release/drivers/export-data-mysql.test.ts tests/release/drivers/export-data-objects.test.ts tests/release/drivers/export-data.test.ts tests/release/drivers/d4.test.ts --no-file-parallelism --maxWorkers=2
npx vitest run tests/release/acceptance-scenarios.test.ts --no-file-parallelism --maxWorkers=2
npx eslint tests/release/drivers/export-data-postgres.test.ts
npx eslint scripts/release/drivers/export-data-objects.ts tests/release/drivers/export-data-objects.test.ts
npx eslint scripts/release/drivers/export-data.ts scripts/release/drivers/export-data-mysql.ts tests/release/drivers/export-data-mysql.test.ts
npx eslint scripts/release/drivers/export-data.ts scripts/release/drivers/export-data-mysql.ts scripts/release/drivers/export-data-objects.ts scripts/release/scenarios.ts tests/release/drivers/export-data-postgres.test.ts tests/release/drivers/export-data-mysql.test.ts tests/release/drivers/export-data-objects.test.ts
npx eslint scripts/release/drivers/export-data-leg.ts
npx eslint scripts/release/drivers/export-data.ts
bash Z:/Projects/Spawned.ai/zenith-wt/.resume/codex/tsc-serial.sh
node node_modules/tsx/dist/cli.mjs scripts/release/acceptance-orchestrator.ts check
git diff --check -- scripts/release/drivers/export-data-objects.ts tests/release/drivers/export-data-objects.test.ts
git diff --check
```

- PostgreSQL focused command ran twice: initially 11 passed / 1 failed / 0 skipped;
  final 12 / 0 / 0. A new corruption test expected the wrong substring of the
  existing `Independent content readback mismatch` error; corrected, no assertion
  removed.
- MySQL focused command ran twice: first 12 / 0 / 0; after adding preflight and
  corruption coverage, 10 passed / 3 failed / 0 skipped. The insecure-source tests
  correctly caught target connections occurring before source validation. The code
  now validates both endpoints before any connection; the assertion is unchanged.
- Objects focused command: 18 / 0 / 0.
- Combined five-file command: **81 passed / 0 failed / 0 skipped**, five files.
  Repeated after the review caught socket-only initialization readiness; the final
  repeat also passed **81 / 0 / 0**. Independent review confirmed both published
  endpoints are probed and transient refusals retry before the pair is returned.
- Registry unit command: 7 / 0 / 0. CLI check: exit0, 19 scenarios, 84 mapped files
  present, including the three dedicated leg test files.
- Each completed lint command above: exit0, 0 errors / 0 warnings.
- Both serialized typechecks passed (exit0, 0 errors); the second follows the
  actual TCP/TLS readiness fix. This round has no helper stubs; the compiler reads
  the actual leg implementations.
- Whitespace checks passed: five root invocations and one helper scoped invocation,
  0 failed. Read-only `git status --short`,
  `git log --oneline -10`, `git diff --stat`, `rg --files`, `Get-Content` and
  `Select-Object` have no test counts. One combined delete/add patch on the same
  test path was rejected atomically by the patch tool; the full updated test file
  was written once afterward, retaining the security/ownership assertions.

Provably stale helper expectations changed to match whole-unit export isolation:
MySQL still binds all six rows, now three per separate database with two source
transactions and independently reopened reads. Cleanup covers both source
databases and both target databases (three populated tables in the modeled
roundtrip), while preserving unowned data and continuing other cleanup.
Objects now have two source buckets of three original keys instead of one bucket
of six tenant-prefixed keys; prefix rejection becomes exact selected-content
validation plus independently tagged foreign-target emptiness. The mock separates
source/target engines by endpoint because their tenant bucket names match.
Ownership tests retain nine object removals across the modeled source/restore
and require four bucket removals. Plaintext, unverified-chain and wrong-identity
TLS refusals remain asserted.

Not run: real operated data roundtrips (needs Mac Docker, PostgreSQL/MySQL/MinIO,
Temporal, kind, browser and trusted private CA). No observed skip count is claimed
for them. A second real cloud provider stays live-deferred. Exact lean-profile
Mac commands and the 17/0/0 operated receipt requirement above remain unchanged.
No deviation from the wiring handoff. Suggested commit:
`fix(release): isolate tenant export data units`.

### Customer-data follow-up builder verification

Follow-up inventory: **22 files, 16 modified and 6 added**, all left in the working
tree. Added modules: `scripts/release/drivers/export-data.ts`,
`export-data-plan.ts`, `export-data-postgres.ts`, the orchestrator-provided
`export-data-leg.ts` contract (comments clarified), and temporary type-only
`export-data-helper-stubs.d.ts`; added test:
`tests/release/drivers/export-data.test.ts`. Modified driver modules:
`scripts/release/drivers/{export,operated,protocol}.ts`; registries:
`scripts/release/{local-targets,scenarios}.ts`, `scripts/ci/gate-manifest.mjs`;
canonical resource join: `src/lib/capabilities/{broker,ports,product-adapters}.ts`;
tests: `tests/capabilities/{product-adapters,portability-broker}.test.ts`,
`tests/release/drivers/d4.test.ts`, `tests/release/local-targets.test.ts`; runbooks:
`docs/build/production/verify/{DRV-4,PROD-LIFE-11,PROD-REL-01}.md`.
`export-data-mysql.ts` and `export-data-objects.ts` were not written or copied by
this worker. Their drafts in the helper worktrees still shared tenant export units
when inspected; the required separate-unit correction was relayed to the
orchestrator. Remove the type-only stub after compatible helpers are integrated.
No deviation from the split handoff, dependency metadata/migration changes or git
mutations. Suggested commit: `feat(release): rehearse tenant data export and restore`.

All shell invocations prepend
`$env:PATH = 'C:\Users\user\.local\sdk\node22;' + $env:PATH`.
The following are actual offline results, separate from the Mac commands above.

```powershell
npx vitest run tests/capabilities/product-adapters.test.ts tests/capabilities/portability-broker.test.ts --no-file-parallelism --maxWorkers=2
npx vitest run tests/release/drivers/export-data.test.ts tests/release/drivers/d4.test.ts tests/release/local-targets.test.ts tests/release/scenarios.test.ts --no-file-parallelism --maxWorkers=2
npx vitest run tests/release/drivers/export-data.test.ts tests/release/drivers/d4.test.ts tests/release/local-targets.test.ts tests/release/acceptance-scenarios.test.ts --no-file-parallelism --maxWorkers=2
npx vitest run tests/release/drivers/export-data.test.ts tests/release/drivers/d4.test.ts tests/release/local-targets.test.ts tests/release/acceptance-scenarios.test.ts tests/release/orchestrator.test.ts --no-file-parallelism --maxWorkers=2
npx vitest run tests/release/drivers/export-data.test.ts tests/release/drivers/d4.test.ts --no-file-parallelism --maxWorkers=2
```

Counts in command order:

- Canonical join command: three invocations, 41 passed / 3 failed / 0 skipped,
  then 44 / 0 / 0 twice. Initial failures were new test fixture resets and a new
  test that incorrectly expected referenced-resource export approval; full fixture
  resets and the retained policy-denial expectation fixed them. No existing policy
  assertion was weakened.
- First release command: 68 passed / 1 failed / 0 skipped, three discovered files.
  The nonexistent `scenarios.test.ts` filter discovered nothing; corrected in the
  next command. The one failure was the existing exact gate inventory expectation.
  Its additive four required customer-data/image gates make that expectation stale.
- Corrected four-file release command: 76 / 0 / 0.
- Five-file release command after DNS/cleanup planner tests: 88 / 0 / 0.
- Focused command after compiler fixes: 38 / 0 / 0, two files.

```powershell
npx eslint scripts/release/drivers/export-data.ts scripts/release/drivers/export-data-plan.ts scripts/release/drivers/export-data-postgres.ts scripts/release/drivers/export.ts scripts/release/drivers/operated.ts scripts/release/drivers/protocol.ts scripts/release/local-targets.ts scripts/release/scenarios.ts scripts/ci/gate-manifest.mjs src/lib/capabilities/broker.ts src/lib/capabilities/ports.ts src/lib/capabilities/product-adapters.ts tests/release/drivers/export-data.test.ts tests/release/drivers/d4.test.ts
npx eslint scripts/release/drivers/export-data.ts scripts/release/drivers/export-data-plan.ts scripts/release/drivers/export-data-postgres.ts scripts/release/drivers/export.ts scripts/release/drivers/operated.ts scripts/release/drivers/protocol.ts scripts/release/local-targets.ts scripts/release/scenarios.ts scripts/ci/gate-manifest.mjs src/lib/capabilities/broker.ts src/lib/capabilities/ports.ts src/lib/capabilities/product-adapters.ts tests/release/drivers/export-data.test.ts tests/release/drivers/d4.test.ts tests/release/local-targets.test.ts
npx eslint scripts/release/drivers/export-data.ts scripts/release/drivers/export-data-plan.ts scripts/release/drivers/export-data-leg.ts scripts/release/drivers/export-data-postgres.ts scripts/release/drivers/export-data-helper-stubs.d.ts scripts/release/drivers/export.ts scripts/release/drivers/operated.ts scripts/release/drivers/protocol.ts scripts/release/local-targets.ts scripts/release/scenarios.ts scripts/ci/gate-manifest.mjs src/lib/capabilities/broker.ts src/lib/capabilities/ports.ts src/lib/capabilities/product-adapters.ts tests/release/drivers/export-data.test.ts tests/release/drivers/d4.test.ts tests/release/local-targets.test.ts tests/capabilities/product-adapters.test.ts tests/capabilities/portability-broker.test.ts
npx eslint tests/capabilities/product-adapters.test.ts tests/capabilities/portability-broker.test.ts
npx eslint scripts/release/drivers/export-data.ts
bash Z:/Projects/Spawned.ai/zenith-wt/.resume/codex/tsc-serial.sh
node scripts/ci/gate-manifest.mjs drivers-d4-export
node scripts/ci/gate-manifest.mjs drivers-d4-two-tenants
node node_modules/tsx/dist/cli.mjs scripts/release/acceptance-orchestrator.ts check
git diff --check
```

Lint command order: initial 14-file run failed with 1 `prefer-const` error and
0 warnings; fixed through a const-owned mutable container identity. The 15-file
and 19-file runs passed, 0 errors / 0 warnings. The two-file command ran twice,
both 0 / 0. The final one-file command passed, 0 errors / 0 warnings.
First serialized typecheck failed with 3 errors in the new orchestrator: inferred
JavaScript command option excess properties and a union needing explicit narrowing.
Second serialized typecheck passed (exit0, 0 errors). It uses only the
clearly marked temporary type signatures for the absent helper implementations;
it cannot validate those files. Each manifest print passed once (exit0), with one
required operated case, no engine/test execution. Registry check passed once
(exit0): 19 scenarios, 81 mapped files present. All completed `git diff --check`
invocations passed. Read-only `git status --short`, `git log --oneline -10`, `git
diff`, `rg`, `rg --files`, `Get-Content`, `Select-Object`, `Select-String`,
`Test-Path` and directory listings have no test counts. Missing exploratory paths
(including `deploy/docker/Dockerfile.worker` and a `J2.md` runbook) were corrected
without changing assertions, gates or other jobs' files.

Not run: the two operated cases, including all real data roundtrips (needs Mac
Docker, PostgreSQL/MySQL/MinIO/Temporal, kind, browser and trusted private CA).
This is not an observed Vitest skip count. A second real cloud provider remains
live-deferred. The helper files are not written by this worker; their separate
database/bucket contract is a required integration dependency, not a waived seam.

### Historical a7371b55 base driver verification

All PowerShell invocations prepended
`$env:PATH = 'C:\Users\user\.local\sdk\node22;' + $env:PATH`.

```powershell
npx vitest run tests/release/drivers/d4.test.ts tests/release/local-targets.test.ts tests/release/acceptance-scenarios.test.ts tests/release/orchestrator.test.ts --no-file-parallelism --maxWorkers=2
```

Three attempts: 74 passed / 3 failed / 0 skipped; 76 passed / 1 failed / 0
skipped; final 77 passed / 0 failed / 0 skipped, four files passed. Failures were
the stale existing registry expectation and two defects in the new export guard
(missing network scaffold and overly broad HTTP syntax detection). Tests and
refusal assertions were retained; the guard was fixed.

```powershell
npx eslint scripts/release/drivers/protocol.ts scripts/release/drivers/operated.ts scripts/release/drivers/two-tenants.ts scripts/release/drivers/export.ts scripts/release/local-targets.ts scripts/release/local-target-runner.ts scripts/release/scenarios.ts scripts/release/acceptance-orchestrator.ts scripts/ci/gate-manifest.mjs tests/release/drivers/d4.test.ts tests/release/drivers/d4.operated.test.ts
npx eslint scripts/release/drivers/protocol.ts scripts/release/drivers/operated.ts scripts/release/drivers/two-tenants.ts scripts/release/drivers/export.ts scripts/release/local-targets.ts scripts/release/local-target-runner.ts scripts/release/scenarios.ts scripts/release/acceptance-orchestrator.ts scripts/ci/gate-manifest.mjs tests/release/drivers/d4.test.ts tests/release/drivers/d4.operated.test.ts tests/release/local-targets.test.ts
bash Z:/Projects/Spawned.ai/zenith-wt/.resume/codex/tsc-serial.sh
git diff --check
```

Initial 11-file lint: 3 unused-import errors / 0 warnings; fixed. Subsequent
12-file lint: four invocations passed, each 0 errors / 0 warnings. The additional
focused command below ran twice after credential/endpoint guard fixes; both
attempts passed 27 / 0 / 0, one file passed. Read-only exploration (`git status --short`,
`git log --oneline -10`, `git diff --stat`, `rg`, `rg --files`, `Get-Content`,
`Select-Object`, `Select-String`) has no test counts. Missing exploratory paths
and corrected PowerShell/rg argument forms changed no files or test gates.

```powershell
npx vitest run tests/release/drivers/d4.test.ts --no-file-parallelism --maxWorkers=2
node scripts/ci/gate-manifest.mjs drivers-d4-two-tenants
node scripts/ci/gate-manifest.mjs drivers-d4-export
node node_modules/tsx/dist/cli.mjs scripts/release/acceptance-orchestrator.ts check
```

Each manifest print passed once (exit0), no test/engine execution. Scenario
inventory check passed once (exit0): 19 scenarios, 80 mapped files, all present.
`git diff --check` passed in each completed invocation (no whitespace errors).

Serialized typecheck attempts: first failed with six errors in the new drivers
(five callback parameters needed explicit types around the existing JavaScript
helpers, and the inferred JavaScript request options needed a typed local
variable). Second and third passed. A compiler-snapshot inspection detected two
later-edited files and triggered the final serialized invocation, recorded below.
The first snapshot helper needed correction for TypeScript's string-or-object
file-info representation; no compiler or test assertion was changed. Fourth
serialized invocation passed (exit0). Overall: three compiler passes / one
interim failure / zero skipped invocations. Final SHA-256 comparison against
`tsconfig.tsbuildinfo`: all 11 changed TypeScript files match the compiler
snapshot, exit0. Final `git diff --check`: six successful invocations total,
zero whitespace errors.

Not run: the two actual operated cases (needs the Mac engines/browser); this is
not an observed Vitest skip count and is never included in the offline passes.

Final inventory: 15 files (8 modified, 7 added). New files: four modules under
`scripts/release/drivers/` (`protocol.ts`, `operated.ts`, `two-tenants.ts`,
`export.ts`), two tests under `tests/release/drivers/` (`d4.test.ts`,
`d4.operated.test.ts`), and this runbook. Modified files:
`deploy/acceptance/local-targets/scenarios.json`, `scripts/release/scenarios.ts`,
`scripts/release/local-targets.ts`, `scripts/release/local-target-runner.ts`,
`scripts/release/acceptance-orchestrator.ts`, `scripts/ci/gate-manifest.mjs`,
`tests/release/local-targets.test.ts`, and `verify/PROD-REL-01.md`.
All changes remain uncommitted in `prod7-drivers-d4`; no unrelated edits were
present initially or included. The supporting runner/receipt joins are the
minimal necessary edits beyond the new drivers and additive registrations.

Suggested commit: `feat(release): add operated tenant isolation and export drivers`

## CI admission for operated driver lanes

The eight jobs in `.github/workflows/ci.yml` are J15 native local rehearsals:
DRV1 private-source/update-rollback, DRV2 drift-repair/crash-partition, DRV3
upgrade/restore, and DRV4 two-tenants/export. They are separate from the Wave-6
lane registry. The binding test requires each job's exact canonical run,
execution-required validation and sanitized artifact upload.

Jobs default to disabled. Only trusted `push` events with the corresponding
repository variable equal to `1` can run; pull requests never admit these jobs.
An enabled job targets `[self-hosted, macOS, ARM64, zenith-operated]` in the
`operated-rehearsal` environment. Configure that environment for the trusted
verifier. All jobs share a non-cancelling concurrency group because J1 ports
and the J2 cluster name are exclusive. Workflow-level cancellation is also
disabled for opted-in native pushes so owned cleanup can drain.

| CI job | Gate repository variable | Fixture variable prefix |
| --- | --- | --- |
| `drv1-private-source` | `ZENITH_LOCAL_DRV1=1` | `ZENITH_OPERATED_DRV1_PRIVATE_SOURCE` |
| `drv1-update-rollback` | `ZENITH_LOCAL_DRV1=1` | `ZENITH_OPERATED_DRV1_UPDATE_ROLLBACK` |
| `drv2-drift-repair` | `ZENITH_TEST_DRV2_OPERATED=1` | `ZENITH_OPERATED_DRV2_DRIFT_REPAIR` |
| `drv2-crash-partition` | `ZENITH_TEST_DRV2_OPERATED=1` | `ZENITH_OPERATED_DRV2_CRASH_PARTITION` |
| `j15-operated-upgrade` | `ZENITH_LOCAL_OPERATED=1` | `ZENITH_OPERATED_DRV3_UPGRADE` |
| `j15-operated-restore` | `ZENITH_LOCAL_OPERATED=1` | `ZENITH_OPERATED_DRV3_RESTORE` |
| `drivers-d4-two-tenants` | `ZENITH_LOCAL_DRIVER_D4=1` | `ZENITH_OPERATED_DRV4_TWO_TENANTS` |
| `drivers-d4-export` | `ZENITH_LOCAL_DRIVER_D4=1` and `ZENITH_LOCAL_EXPORT_DATA=1` | `ZENITH_OPERATED_DRV4_EXPORT` |

For each prefix configure `_ROOT`, `_STACK_DIR` and `_CONFIG_FILE` as private
local path pointers, not credential values. A trusted verifier must provision
one fresh current-commit lean J1 installation and the scenario's J2 fixture
immediately before that job runs, and reclaim owned fixtures on every job exit,
including setup/cancellation failures. The job's run ID is
`<github.run_id>-<github.run_attempt>-<lane>`. Do not share a consumed fixture
between jobs. Use this runbook and the DRV1/DRV2/DRV3 runbooks for preparation;
the CI jobs consume prepared fixtures and do not claim to provision them.

The private-source job additionally needs file-pointer variables
`ZENITH_LOCAL_SOURCE_BUILD_DECLARATION_FILE` and
`ZENITH_LOCAL_SOURCE_BINARY_FILE`, plus the native digest-pinned
`ZENITH_LOCAL_SOURCE_REGISTRY_IMAGE`. Upgrade needs
`ZENITH_LOCAL_UPGRADE_IMAGES_FILE`; restore needs matching pg_dump/pg_restore
clients and the pinned Temporal CLI on the native runner. Export needs the
three digest-pinned `ZENITH_LOCAL_EXPORT_*_IMAGE` variables described above
and the cached pinned LocalStack image. Chromium must trust the fresh J1 CA.

Each job loads the actual owned J1 host environment through the existing
`default-stack/env.mjs` exporter without eval, shell sourcing or printing
credentials. Only validated scalar evidence is uploaded, even on failure.
Enabled jobs with missing/stale fixtures, missing prerequisites, skipped
required cases or invalid execution receipts fail. A disabled job establishes
no native acceptance proof. Live cloud acceptance remains deferred.
