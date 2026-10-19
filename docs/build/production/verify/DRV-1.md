# DRV-1: operated private-source and update-rollback drivers

Extended from orchestrator commit `5a53b2ed` in `prod7-drivers-d1`, 2026-10-08. Verification status is
`implementation_complete_verification_pending`. These two dedicated drivers serve
the corresponding J15 scenarios in **PROD-REL-01**. Their receipts are
`local_operated_rehearsal`, never live or production acceptance. The Windows builder
has not run Docker, PostgreSQL, Temporal, kind or Chromium.

## Operations and boundaries

Both drivers reuse the actual J1 lean installation and J2 identity, MFA, browser,
agent-link, native kind connection and observer helpers. They create fresh local
users, workspace, project and production environment. Deploy/rollback proposals go
through the real action API. Both approval rounds use the operation review browser
page and a distinct MFA-enrolled administrator; self approval must return 403.
The real Temporal worker executes the approved operation. Independent PostgreSQL
queries use J1's verified-TLS pooler, and a separate kubectl process reads the J2
observer target. The browser-linked scoped agent also reads each actual operation's
events through the production MCP endpoint, requiring a nonsimulated envelope and
nonempty events. No SQL creates an approval or changes an operation's status.
Before any observer request, the driver checks J2's private target journal,
exact container ID, published loopback socket and matching cluster CA. Only inline
static client certificates/keys in the one expected context are admitted; remote
servers, different ports/CAs, TLS bypass, proxies and exec-auth plugins refuse.

| Scenario | Real operations and independent checks | Deliberate boundary |
| --- | --- | --- |
| private-source | Browser installation/OAuth and PKCE, admitted snapshot, branch movement, human approval, actual J6 rootless build, OCI and signed provenance verification, deployed running digest and HTTP readback; second approved operation paused during browser revocation, then refused; fresh post-revocation proposal refused; unchanged successful workload and zero subsequent effects | GitHub is an authenticated local emulator with runtime RSA signatures and contents:read scope. J6 requires a real dedicated worker, runtime profiles and enforcing CNI. No live GitHub or live cloud acceptance. |
| update-rollback | Baseline deploy, distinct compatible image deploy, independent digest/pod/application marker and stable workload UID, genuine empty-nonce process crash and failed rollout, old ready application still serving, browser-approved exact original revision rollback, independent release rows/API agreement and preserved product record | The compatible image changes its OCI configuration while retaining J2's inert witness binary. This proves the code-release path, not a database migration or restore. |

The private-source lane now requires all twelve closed receipt checks, including
successful isolated build and provenance-verified deployment. An admission-only
receipt remains incomplete. The fixture applies the exact J6 baseline, proxy and
custody RBAC in fresh tenant namespaces, allocates the protected worker labels and
both tenant taints, and issues distinct writer/verifier TokenRequest credentials
through the real workspace vault API. The actual production worker performs its
fourteen physical isolation probes before source execution. A private small native
ELF is admitted in the immutable snapshot, built from scratch without dependency
downloads and pushed to an owned ephemeral registry on J1's private network.
Independent readback verifies OCI byte hashes and BuildKit provenance links using
J6's production verifier, and the control-plane JWS against J1's pinned public key,
exact snapshot, operation and strict no-exception isolation policy. It checks the
completed build/probe pods on the dedicated worker, the exact approved image index
in the deployment and pod, the verified ARM64 platform digest in CRI imageID, and
the actual HTTP application response. The later revocation assertions remain;
zero new workload effects now means exactly the original deployment UID and image
survive, with zero dispatch/provenance for the refused operations.

The pause injection inspects the exact J1 worker installation label, records an
unpause recovery before injecting, then approves/revokes through the browser. This
prevents a race with execution. Update failure waits for the real Kubernetes
progress deadline, then independently observes CrashLoopBackOff/restarts and the
previous ready application. It does not set a deployment/operation result itself.

Cleanup always attempts recoveries, operation settlement/lease absence, exact
environment-owned Kubernetes UID deletes, credential revocation, auth-user absence,
browser shutdown and fixture removal, even after another cleanup task fails. It
refuses workload deletion beneath an unsettled writer. Source setup registers
cleanup before OpenSSL/engine mutations, restores the original hash-checked J1
composition, and checks absence of its private container/volume and overlay mounts.
Update cleanup removes only its generated host/kind image references. Both fixtures
also carry the owning J1 installation label for outer cleanup after interruption.
Registry/cache content blobs and platform audit records remain in borrowed targets
until their owner's J1/J2 teardown; the outer cleanup below is mandatory. No global
prune or shared-namespace deletion occurs in either driver.

## Exact lean-profile Mac commands

Run sequentially on native ARM64 macOS, Node 22, Docker Desktop with the lean J1 profile,
Supabase CLI 2.75.0, OpenSSL, kind, kubectl and the existing installed Playwright
Chromium. Use a disposable verifier user/VM where Chromium genuinely trusts the
fresh J1 CA. Prepare that trust using the existing J2 verifier procedure after J1
startup; neither driver bypasses TLS or changes a personal trust store. Node must
start with `NODE_EXTRA_CA_CERTS` pointing at this same actual CA. A certificate
error fails the lane.

Preserve at least J1's 22 GiB disk floor. Lean J1 has a planned 2912 MiB running
ceiling, J2 adds a 1280 MiB capped kind control plane and an optional 640 MiB worker; the source emulator adds 64 MiB
and its temporary seed adds 64 MiB; the ephemeral registry adds 128 MiB. J6's
production build limits remain 2 CPU / 4 GiB, requests 250m / 256 MiB, and its
proxy remains bounded at 128 MiB. This configuration is not measured 4 GiB fit
proof. A verifier lacking capacity must report failure/pending rather than lower
J6 limits, bypass probes or claim success. Stop LocalStack, Pebble, stripe-mock and
unrelated profiles; no such target is needed here. Compile and test serially.
See [PKG-04](PKG-04.md) and [J6](J6-ISOLATED-BUILDER.md).

Owner-provided inputs, already resolved and inspected locally:

- `ZENITH_NODE22_BIN`: absolute directory containing native Node 22.
- `ZENITH_DEFAULT_STACK_REGISTRY_IMAGE`: real digest-pinned ARM64 registry image.
- `DRV1_KIND_IMAGE`: reviewed digest-pinned ARM64 kind node image with actual J6
  user-namespace runtime, seccomp and AppArmor profiles preinstalled. Stock kind
  without these physical controls will refuse source execution.
- `DRV1_CNI_MANIFEST` and `DRV1_RUNTIME_MANIFEST`: absolute private owner-reviewed
  manifests for a native enforcing CNI (pod CIDR 10.244.0.0/16, no competing
  kindnet) and the RuntimeClass matching the installed handler. Preload all
  digest-pinned native CNI/runtime images locally; no cloud or registry fallback.
  Approved kube-system DaemonSets must tolerate both tenant taints and match the
  exact `systemDaemonSets` declaration. A RuntimeClass object alone proves nothing.
- `ZENITH_LOCAL_SOURCE_REGISTRY_IMAGE`: actual digest-pinned native registry image,
  already local, supporting uid 1000, readonly root and tmpfs /var/lib/registry.
- `ZENITH_LOCAL_SOURCE_BINARY_FILE`: absolute regular private 0600 file holding
  the real static ARM64 `fixture-app.c` executable (64 bytes to 600 KiB). Compile
  using the exact local commands below; no placeholder ELF is accepted as evidence.
- `DRV1_WITNESS_IMAGE`: actual local `localhost:5000/zenith-j2-witness@sha256:...`
  image with its original local tag, built by J2's `zenithd.Dockerfile` using its
  reviewed digest-pinned builder/runtime inputs. Both Docker image and local
  registry digest must exist before J2 prepare. Do not substitute a dummy pin.
- `DRV1_WITNESS_TAG`: the original `localhost:5000/zenith-j2-witness:<tag>` for that
  inspected image. J1 creates a fresh empty registry, so republish this exact local
  image into it after startup and independently check its original digest below.
- `ZENITH_LOCAL_SOURCE_BUILD_DECLARATION_FILE`: absolute regular 0600 JSON file
  outside the checkout, with `{ "config": <reviewed J6 ConfigSchema>,
  "registryRepositoryRoot": "localhost:5000/zenith-drv1-build" }`. The schema
  requires real pinned builder/proxy image references, runtimeClass, seccomp and
  AppArmor names, node isolation profile digest/systemDaemonSets, and a distinct
  proxy namespace/IP/port/destinations. Review this declaration as intended
  runtime semantics, with no `pushSecret`. The driver derives fresh tenant
  namespaces, distinct vault references and key, and replaces the registry root
  and destination with its exact owned private IP:5000. Supply an unused valid
  kind Service IP for the proxy, and locally loaded real builder/proxy pins.

Use canonical `/private/tmp` paths: `/var` and `/tmp` aliases fail private-path
symlink guards. The setup chooses directories that do not exist. Keep all private
config, host env and raw test reports out of source and uploaded artifacts.

```bash
export PATH="$ZENITH_NODE22_BIN:$PATH"
set -euo pipefail
node --version
umask 077
export DRV1_PRIVATE="$(mktemp -d /private/tmp/zenith-drv1.XXXXXX)"
export ZENITH_ACCEPTANCE_DEFAULT_STACK=1
export ZENITH_ACCEPTANCE_DEFAULT_STACK_DIR="$DRV1_PRIVATE/j1"
export DRV1_TARGETS_DIR="$DRV1_PRIVATE/j2"
mkdir -m 700 "$DRV1_PRIVATE/evidence"

# Register outer cleanup before starting either target. Never delete a reused kind name.
drv1_finish() {
  local original=$?
  local cleanup=0
  trap - EXIT INT TERM
  node --input-type=module <<'NODE' || cleanup=$?
import fs from 'node:fs';
import { command, docker, ensure } from './tests/e2e/default/support.mjs';
import { down } from './scripts/acceptance/default-stack/down.mjs';
let failed = false;
try {
  const file = process.env.DRV1_TARGETS_DIR + '/targets.json';
  if (fs.existsSync(file)) {
    const owned = JSON.parse(fs.readFileSync(file, 'utf8'));
    ensure(owned.createdBy === 'J2-DEFAULT-JOURNEY' && owned.kind === 'zenith-j2', 'cleanup-target-journal');
    const present = await docker(['container','ls','-aq','--filter','name=^/zenith-j2-control-plane$']);
    if (present) {
      ensure(owned.status === 'created' && typeof owned.containerId === 'string', 'cleanup-needs-recorded-target-identity');
      const [current] = JSON.parse(await docker(['inspect',present]));
      ensure(current.Id === owned.containerId && current.Config.Labels?.['io.x-k8s.kind.cluster'] === owned.kind, 'cleanup-kind-exact-owner');
      const actual = (await docker(['container','ls','-aq','--filter','label=io.x-k8s.kind.cluster='+owned.kind])).split(/\s+/).filter(Boolean);
      const recorded = [owned.containerId,owned.buildContainerId].filter(Boolean);
      ensure(actual.length === recorded.length,'cleanup-all-node-count');
      for (const id of actual) {
        const [n] = JSON.parse(await docker(['inspect',id]));
        ensure(recorded.includes(n.Id) && n.Config.Labels?.['io.x-k8s.kind.cluster'] === owned.kind,'cleanup-all-node-identities');
      }
      await command('kind',['delete','cluster','--name',owned.kind], { timeout: 240000 });
    }
    ensure(!(await command('kind',['get','clusters'])).split(/\s+/).includes(owned.kind), 'cleanup-kind-absence');
  }
} catch { failed = true; process.stderr.write('DRV-1 owned J2 cleanup refused or failed; retain its private journal.\n'); }
try {
  const dir = process.env.ZENITH_ACCEPTANCE_DEFAULT_STACK_DIR;
  if (fs.existsSync(dir + '/state.json')) await down(dir);
} catch { failed = true; process.stderr.write('DRV-1 owned J1 cleanup pending; retain its private state.\n'); }
process.exitCode = failed ? 1 : 0;
NODE
  if [ "$original" -ne 0 ]; then return "$original"; fi
  return "$cleanup"
}
trap drv1_finish EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

node scripts/acceptance/default-stack/up.mjs --profile lean --directory "$ZENITH_ACCEPTANCE_DEFAULT_STACK_DIR"
node scripts/acceptance/default-stack/env.mjs "$ZENITH_ACCEPTANCE_DEFAULT_STACK_DIR" "$DRV1_PRIVATE/host.env"
export NODE_EXTRA_CA_CERTS="$ZENITH_ACCEPTANCE_DEFAULT_STACK_DIR/tls/ca.crt"
# Complete genuine isolated Chromium CA trust here, before browser tests.
node --input-type=module <<'NODE'
import { docker, ensure } from './tests/e2e/default/support.mjs';
const ref = process.env.DRV1_WITNESS_IMAGE, tag = process.env.DRV1_WITNESS_TAG;
ensure(/^localhost:5000\/zenith-j2-witness@sha256:[a-f0-9]{64}$/.test(ref ?? '') &&
  /^localhost:5000\/zenith-j2-witness:[a-z0-9._-]+$/.test(tag ?? ''), 'witness-owned-local-reference');
const [image] = JSON.parse(await docker(['image','inspect',ref]));
ensure(image.Architecture === 'arm64' && image.RepoTags?.includes(tag), 'witness-original-native-tag');
await docker(['push',tag]);
const expected = ref.split('@')[1];
const read = await fetch('http://127.0.0.1:5000/v2/zenith-j2-witness/manifests/' + expected, {
  method: 'HEAD', redirect: 'error', signal: AbortSignal.timeout(10000),
  headers: { accept: 'application/vnd.oci.image.manifest.v1+json, application/vnd.oci.image.index.v1+json, application/vnd.docker.distribution.manifest.v2+json, application/vnd.docker.distribution.manifest.list.v2+json' },
});
ensure(read.ok && read.headers.get('docker-content-digest') === expected, 'witness-independent-registry-digest');
NODE
export ZENITH_DEFAULT_JOURNEY=1
cat > "$DRV1_PRIVATE/isolated-kind.yaml" <<'YAML'
kind: Cluster
apiVersion: kind.x-k8s.io/v1alpha4
networking:
  apiServerAddress: 127.0.0.1
  disableDefaultCNI: true
  podSubnet: 10.244.0.0/16
nodes:
- role: control-plane
- role: worker
YAML
node tests/e2e/default/prepare.mjs --directory "$DRV1_TARGETS_DIR" \
  --stack "$ZENITH_ACCEPTANCE_DEFAULT_STACK_DIR" --node-image "$DRV1_KIND_IMAGE" \
  --witness-image "$DRV1_WITNESS_IMAGE" --mailpit-url http://127.0.0.1:8025 \
  --isolated-kind-config "$DRV1_PRIVATE/isolated-kind.yaml"
kubectl --kubeconfig "$DRV1_TARGETS_DIR/observer.json" --context kind-zenith-j2 apply -f "$DRV1_CNI_MANIFEST"
kubectl --kubeconfig "$DRV1_TARGETS_DIR/observer.json" --context kind-zenith-j2 apply -f "$DRV1_RUNTIME_MANIFEST"
kubectl --kubeconfig "$DRV1_TARGETS_DIR/observer.json" --context kind-zenith-j2 wait --for=condition=Ready nodes --all --timeout=180s
# Actual local native compiler image containing static musl libc and cc, already digest-pinned.
: "${DRV1_COMPILER_IMAGE:?owner-reviewed local ARM64 digest pin required}"
export ZENITH_LOCAL_SOURCE_BINARY_FILE="$DRV1_PRIVATE/app"
node --input-type=module <<'NODE'
import path from 'node:path';
import fs from 'node:fs';
import { docker, ensure } from './tests/e2e/default/support.mjs';
const ref = process.env.DRV1_COMPILER_IMAGE, id = path.basename(process.env.DRV1_PRIVATE).toLowerCase();
ensure(/^[a-z0-9][a-z0-9.:/_-]*@sha256:[a-f0-9]{64}$/.test(ref ?? ''),'compiler-pin');
const [base] = JSON.parse(await docker(['image','inspect',ref]));
ensure(base.Architecture === 'arm64','native-compiler');
const tag = 'zenith-drv1-compiler:'+id, label = 'io.zenith.drv1.compiler='+id, name = 'zenith-drv1-extract-'+id;
ensure(!(await docker(['image','ls','-q','--filter','reference='+tag])) && !(await docker(['container','ls','-aq','--filter','name=^/'+name+'$'])),'fresh-compiler-name');
try {
  await docker(['build','--network=none','--pull=false','--platform','linux/arm64','--label',label,
    '--build-arg','COMPILER_IMAGE='+ref,'--target','compile','-f','deploy/zenith-managed/build/Dockerfile.fixture','-t',tag,'.'],{timeout:240000});
  await docker(['create','--name',name,'--label',label,'--network','none',tag]);
  await docker(['cp',name+':/app',process.env.ZENITH_LOCAL_SOURCE_BINARY_FILE]);
  fs.chmodSync(process.env.ZENITH_LOCAL_SOURCE_BINARY_FILE,0o600);
} finally {
  const containers = (await docker(['container','ls','-aq','--filter','label='+label])).split(/\s+/).filter(Boolean);
  for (const c of containers) {
    const [live] = JSON.parse(await docker(['inspect',c]));
    ensure(live.Name === '/'+name && live.Config.Labels?.['io.zenith.drv1.compiler'] === id,'compiler-container-owner');
    await docker(['rm',live.Id]);
  }
  if (await docker(['image','ls','-q','--filter','reference='+tag])) {
    const [live] = JSON.parse(await docker(['image','inspect',tag]));
    ensure(live.Config.Labels?.['io.zenith.drv1.compiler'] === id && live.RepoTags?.every(t=>t===tag),'compiler-image-owner');
    await docker(['image','rm',tag]);
  }
}
NODE
export ZENITH_LOCAL_JOURNEY_CONFIG_FILE="$DRV1_TARGETS_DIR/journey.json"
export ZENITH_LOCAL_TARGETS=1
export ZENITH_LOCAL_DRV1=1

export ZENITH_LOCAL_RUN_ID=drv1-private
export ZENITH_LOCAL_ROOT="$(mktemp -d "$DRV1_PRIVATE/zenith-j15-$ZENITH_LOCAL_RUN_ID-XXXXXX")"
node scripts/ci/gate-manifest.mjs drv1-private-source > "$DRV1_PRIVATE/evidence/private-source.command.json"
npx vitest run tests/acceptance/drv1-private-source.operated.test.ts --no-file-parallelism --maxWorkers=1 \
  --reporter=default --reporter=json --outputFile.json="$DRV1_PRIVATE/evidence/private-source.json"
node tests/ci/assert-lane-report.mjs drv1-private-source "$DRV1_PRIVATE/evidence/private-source.json"

# Wait for the first lane and its cleanup; do not parallelize this second workload.
export ZENITH_LOCAL_RUN_ID=drv1-update
export ZENITH_LOCAL_ROOT="$(mktemp -d "$DRV1_PRIVATE/zenith-j15-$ZENITH_LOCAL_RUN_ID-XXXXXX")"
node scripts/ci/gate-manifest.mjs drv1-update-rollback > "$DRV1_PRIVATE/evidence/update-rollback.command.json"
npx vitest run tests/acceptance/drv1-update-rollback.operated.test.ts --no-file-parallelism --maxWorkers=1 \
  --reporter=default --reporter=json --outputFile.json="$DRV1_PRIVATE/evidence/update-rollback.json"
node tests/ci/assert-lane-report.mjs drv1-update-rollback "$DRV1_PRIVATE/evidence/update-rollback.json"
# Exit this verifier shell to invoke the ownership-checked outer teardown.
```

Each gate requires **1 passed / 0 failed / 0 skipped**, plus its fresh receipt with
all twelve private-source checks or all eight update-rollback checks passed. Update can take more than ten minutes because the failed
rollout uses the unchanged Kubernetes progress deadline. Fresh roots are mandatory
for every rerun. If J2 preparation stopped before recording a container identity,
the outer cleanup refuses name-only deletion; its owner must establish ownership
from the private preparation journal. J1 cleanup can run even when J2 cleanup
fails. Missing prerequisites, skipped cases, pending cleanup or a missing receipt
are not acceptance. No credential, source archive, private journal, trace or raw
HTTP response belongs in a public packet. Publish only the sanitized fixed-schema
receipts after inspecting their check statuses and explicit limits.

Alternative **scenario-runner** entry points, on the same prepared targets and a
new root per command (choose these instead of reusing the gate test roots):

```bash
export ZENITH_LOCAL_RUN_ID=drv1-srccli
export ZENITH_LOCAL_ROOT="$(mktemp -d "$DRV1_PRIVATE/zenith-j15-$ZENITH_LOCAL_RUN_ID-XXXXXX")"
node node_modules/tsx/dist/cli.mjs scripts/release/local-target-runner.ts run \
  --scenario private-source --receipt "$ZENITH_LOCAL_ROOT/private-source.json"
export ZENITH_LOCAL_RUN_ID=drv1-updcli
export ZENITH_LOCAL_ROOT="$(mktemp -d "$DRV1_PRIVATE/zenith-j15-$ZENITH_LOCAL_RUN_ID-XXXXXX")"
node node_modules/tsx/dist/cli.mjs scripts/release/local-target-runner.ts run \
  --scenario update-rollback --receipt "$ZENITH_LOCAL_ROOT/update-rollback.json"
```

Exit 0 means the driver checks and cleanup passed. Exit 1 is failure, 2 gated
refusal, 3 incomplete checks. The J15 acceptance orchestrator's `--local-targets`
selection reaches these same registered drivers and preserves their operated label.
The existing component-only lanes and all other target registrations remain intact.

## Files and integration joins

New drivers: `operated.ts`, `github-emulator.mjs`, `github-fixture.ts`,
`private-source.ts`, `update-rollback.ts` under `scripts/release/drivers/`.
Offline tests: `tests/release/drivers/drv1.test.ts`. Gated successors:
`tests/acceptance/drv1-{private-source,update-rollback}.operated.test.ts`.

Minimal additive joins: `scripts/release/scenarios.ts` (component test mapping and
truthful limits), `local-targets.ts` (only two owned overrides, strict operated
receipt inventories/label and J1 CA propagation), `local-target-runner.ts`
(dispatch), `acceptance-orchestrator.ts` (operated label and canonical Mac temp
parent), `scripts/ci/gate-manifest.mjs` (two gated lanes, exact required cases and
offline contract inventory), and `tests/ci/assert-lane-report.mjs` (strict CLI
lane registration). No migration, SQL snapshot, package, lockfile, workflow, commit
or live-cloud change.

Exactly one existing test expectation changed: `tests/release/local-targets.test.ts`
previously required all catalog entries to have only generic J15 gates and the
`local_rehearsal` label. These two dedicated operated scenarios now additionally
require DRV-1/J1/J2 gates and `local_operated_rehearsal`; the assertion checks those
stronger exact expectations while retaining every other scenario's old checks.
No assertion or gate was removed or weakened.

## Historical Windows validation record for 5a53b2ed

Every shell prepended `C:\Users\user\.local\sdk\node22` to PATH. Read-only program,
git status/log, source inspection and patch commands did not execute an engine.
Pass/fail/skip counts below refer to checks, tests or diagnostics as indicated;
successive test counts overlap and must not be summed.

1. Initial changed-file lint, **1 check passed / 0 failed / 0 skipped**, no warnings:

   ```text
   npx eslint scripts/release/drivers/operated.ts scripts/release/drivers/github-emulator.mjs scripts/release/drivers/github-fixture.ts scripts/release/drivers/private-source.ts scripts/release/drivers/update-rollback.ts scripts/release/local-targets.ts scripts/release/local-target-runner.ts scripts/release/scenarios.ts scripts/release/acceptance-orchestrator.ts scripts/ci/gate-manifest.mjs tests/release/drivers/drv1.test.ts tests/release/local-targets.test.ts tests/acceptance/drv1-private-source.operated.test.ts tests/acceptance/drv1-update-rollback.operated.test.ts
   ```

2. Initial scoped run, **50 tests passed / 0 assertion failures / 0 skipped**, but
   **3 collection failures / 3 passed files**, exit 1. The new helper imported
   unavailable `pg`; corrected to the repository's installed `postgres` client.
   No dependency installation or test relaxation:

   ```text
   npx vitest run tests/release/drivers/drv1.test.ts tests/release/local-targets.test.ts tests/release/orchestrator.test.ts tests/release/acceptance-scenarios.test.ts tests/acceptance/drv1-private-source.operated.test.ts tests/acceptance/drv1-update-rollback.operated.test.ts --no-file-parallelism --maxWorkers=2
   ```

3. Corrected targeted run, **15 passed / 0 failed / 2 skipped**, 1 passed file and
   2 skipped operated files, exit 0:

   ```text
   npx vitest run tests/release/drivers/drv1.test.ts tests/acceptance/drv1-private-source.operated.test.ts tests/acceptance/drv1-update-rollback.operated.test.ts --no-file-parallelism --maxWorkers=2
   ```

4. First serialized typecheck, **0 checks passed / 1 failed / 0 skipped**, exit 1,
   3 TypeScript diagnostics (host env inference and two untyped JS-helper callback
   parameters). Fixed the actual type annotations:

   ```text
   bash Z:/Projects/Spawned.ai/zenith-wt/.resume/codex/tsc-serial.sh
   ```

5. Expanded final scoped run (same exact command as item 2), **66 passed / 0 failed
   / 2 skipped**, 4 passed files and 2 skipped operated files, exit 0. Includes
   real RSA/PKCE transport controls, immutable archive agreement with production,
   source/release readback rejection, receipt closure and failed-cleanup ordering.

6. Expanded 15-file lint, **1 check passed / 0 failed / 0 skipped**, exit 0, no
   errors/warnings. This exact command also passed three more times: after the two
   additional type fixes, after adding the required MCP event-readback join and
   after adding exact local observer admission.

   ```text
   npx eslint scripts/release/drivers/operated.ts scripts/release/drivers/github-emulator.mjs scripts/release/drivers/github-fixture.ts scripts/release/drivers/private-source.ts scripts/release/drivers/update-rollback.ts scripts/release/local-targets.ts scripts/release/local-target-runner.ts scripts/release/scenarios.ts scripts/release/acceptance-orchestrator.ts scripts/ci/gate-manifest.mjs tests/ci/assert-lane-report.mjs tests/release/drivers/drv1.test.ts tests/release/local-targets.test.ts tests/acceptance/drv1-private-source.operated.test.ts tests/acceptance/drv1-update-rollback.operated.test.ts
   ```

7. Second serialized typecheck (same command as item 4), **0 checks passed / 1
   failed / 0 skipped**, exit 1, 2 diagnostics introduced by the cleanup/PKCE
   additions: inferred JS command output and dynamic redirect headers. Fixed
   explicit return/header types; no runtime or assertion behavior changed.

8. Third serialized typecheck (same exact command as item 4), **1 check passed /
   0 failed / 0 skipped**, exit 0, zero diagnostics. Fourth serialized typecheck
   after the required MCP operation-events join also **1 passed / 0 failed / 0
   skipped**, exit 0. No direct `npx tsc` command was used.

9. Real skipped-report control, **16 passed / 0 failed / 2 skipped**, 1 passed
   file and 2 skipped files, exit 0:

   ```text
   npx vitest run tests/release/drivers/drv1.test.ts tests/acceptance/drv1-private-source.operated.test.ts tests/acceptance/drv1-update-rollback.operated.test.ts --no-file-parallelism --maxWorkers=2 --reporter=default --reporter=json --outputFile.json=C:/Users/user/AppData/Local/Temp/zenith-drv1-builder-gates.json
   ```

   The following strict validators each exited **1**, with **0 accepted required
   cases / 1 rejected skipped required case / 0 validator omissions**. Both are
   expected rejection controls, not operated test passes or unexplained failures:

   ```text
   node tests/ci/assert-lane-report.mjs drv1-private-source C:/Users/user/AppData/Local/Temp/zenith-drv1-builder-gates.json
   node tests/ci/assert-lane-report.mjs drv1-update-rollback C:/Users/user/AppData/Local/Temp/zenith-drv1-builder-gates.json
   ```

10. Post-MCP-join scoped tests (same exact command as item 3), **16 passed / 0
    failed / 2 skipped**, 1 passed file and 2 skipped files, exit 0.

11. Registry CLIs, each **1 check passed / 0 failed / 0 skipped**, exit 0. Manifest
    output names each exact operated case and required gates. Scenario inventory
    reports **19 scenarios / 80 mapped files, all present** (run twice, both pass):

    ```text
    node scripts/ci/gate-manifest.mjs drv1-private-source
    node scripts/ci/gate-manifest.mjs drv1-update-rollback
    node node_modules/tsx/dist/cli.mjs scripts/release/acceptance-orchestrator.ts check
    ```

12. `git diff --check`: each invocation **1 check passed / 0 failed / 0 skipped**,
    exit 0. Read-only `git status --short`, `git log --oneline -10`, `git diff
    --stat` and source diffs/reads/searches have no test pass/fail/skip counts.
    Missing guessed inspection paths produced read errors and were corrected by
    locating the real paths; they were not test executions. No git mutation ran.

13. Final local-observer contracts (same exact six-file command as item 2), **67
    passed / 0 failed / 2 skipped**, 4 passed files and 2 skipped operated files,
    exit 0. The added test refuses wrong container identity, remote/wrong-port
    targets, wrong CA, TLS bypass, proxy redirection and executable credentials.

14. Fifth serialized typecheck (item 4 command), **0 checks passed / 1 failed / 0
    skipped**, exit 1, one diagnostic: the existing JS assertion cannot narrow an
    optional config filename for the new typed path call. Added its explicit
    nonnull type annotation after the unchanged runtime guard. No assertion or
    runtime behavior changed.

15. Final sixth serialized typecheck (same exact item 4 command), **1 check passed
    / 0 failed / 0 skipped**, exit 0, zero diagnostics. Earlier failed attempts
    remain recorded above; the final source passes.

16. Final annotation-only file lint, **1 check passed / 0 failed / 0 skipped**,
    exit 0, no errors/warnings. The other 14 files passed the full changed-file
    command before this final type-only edit:

    ```text
    npx eslint scripts/release/drivers/operated.ts
    ```

17. Extracted all fenced Mac bash commands into the following builder temp file
    using PowerShell (UTF-8 without BOM), then parsed without executing them,
    **1 syntax check passed / 0 failed / 0 skipped**, exit 0:

    ```text
    bash -n C:/Users/user/AppData/Local/Temp/zenith-drv1-mac-commands.sh
    ```

    This proves shell syntax only. It does not change any operated verdict.
    The same syntax command passed a second time after adding exact local witness
    republication and independent registry-digest readback to the Mac setup.

The two actual operated cases are **not run
(needs native Mac Docker/PostgreSQL/Temporal/kind/Chromium)**. Live cloud acceptance
is deferred by the owner and was not attempted. J4 schedules, ACME, billing,
LocalStack are outside these scenario slices. This historical result predates the private-build extension below.

Historical handoff deviation (superseded by this extension): the first implementation covered snapshot admission and revocation only. The current lane requires a successful J6 private build and deployment before revocation. All additional shared-file edits above are necessary
additive runner, TLS, receipt and gate joins, as authorized by the handoff.

Suggested commit: `feat(release): add operated source and rollback drivers`.


## Private-build extension validation (2026-10-08)

This supersedes the historical admission-only limitation. New files:
`source-build-fixture.ts` and `source-build-readback.ts`; modified source fixture,
archive emulator, private driver and offline contracts. Minimal joins change only
the private-source receipt inventory, scenario description and gated prerequisites,
and add opt-in two-node J2 preparation. No production J6 assertion, migration,
package or execution path was weakened. PROD-REL-01 links this actual lane.

One former assertion had to account for the required successful baseline:
`no-source-effect-after-revocation` previously required zero owned deployments.
It now requires exactly the original deployment UID, verified built image,
verified running platform digest and HTTP response. Zero effects/provenance for
both refused operations remain required. Every original receipt check remains.

All shell commands on this builder prepend
`$env:PATH = 'C:\Users\user\.local\sdk\node22;' + $env:PATH;`.
Read-only inspection (`Get-Content`, `rg`, `git status`, `git log`, `git diff`)
and edits are not operated verification. Targeted verification commands and their
counts for this extension:

```text
npx vitest run tests/release/drivers/drv1.test.ts tests/release/local-targets.test.ts tests/release/acceptance-scenarios.test.ts tests/acceptance/drv1-private-source.operated.test.ts --no-file-parallelism --maxWorkers=2
61 passed / 0 failed / 1 skipped; 3 files passed / 1 skipped.

npx vitest run tests/release/drivers/drv1.test.ts tests/release/local-targets.test.ts tests/release/acceptance-scenarios.test.ts tests/acceptance/drv1-private-source.operated.test.ts tests/execution/build-provenance.test.ts tests/providers/kubernetes/build/contracts.test.ts --no-file-parallelism --maxWorkers=2
123 passed / 0 failed / 1 skipped; 5 files passed / 1 skipped.

npx vitest run tests/release/drivers/drv1.test.ts tests/acceptance/drv1-private-source.operated.test.ts --no-file-parallelism --maxWorkers=2
Two invocations, each 21 passed / 0 failed / 1 skipped; 1 file passed / 1 skipped.
The second followed the distinct-revision fix.

npx eslint scripts/release/drivers/source-build-fixture.ts scripts/release/drivers/source-build-readback.ts scripts/release/drivers/github-fixture.ts scripts/release/drivers/github-emulator.mjs scripts/release/drivers/private-source.ts scripts/release/local-targets.ts scripts/release/scenarios.ts scripts/ci/gate-manifest.mjs tests/e2e/default/prepare.mjs tests/release/drivers/drv1.test.ts
First invocation: 8 errors / 0 warnings (untyped observer fields), fixed.
Second invocation: passed, 0 errors / 0 warnings.
Third, fourth and fifth invocations: passed, 0 errors / 0 warnings.

bash Z:/Projects/Spawned.ai/zenith-wt/.resume/codex/tsc-serial.sh
First invocation: failed with 6 diagnostics (observer nullability and stale test parameter types), fixed.
Second and third invocations: passed, 0 diagnostics. The third followed the distinct-revision fix to prevent a no-op later attempt.

git diff --check
All three invocations passed, 0 whitespace errors; line-ending notices only.

bash -n C:/Users/user/AppData/Local/Temp/zenith-drv1-private-build-mac.sh
Passed, 0 syntax errors. This does not execute any Mac operation.

node scripts/ci/gate-manifest.mjs drv1-private-source
Passed, 1 lane emitted with all 4 gates and exact required operated case.

git status --short
git diff --stat
git diff --numstat
Read-only inventory, passed; 12 changed/added files. No git mutation.
```

Actual Mac operated build/deploy/revocation lane: **not run (needs native Mac,
Docker, PostgreSQL, Temporal, kind with enforcing J6 runtime/CNI, and Chromium)**.
The exact lean-profile commands above execute it and require one pass with no
skips. Live cloud acceptance remains deferred. No successful operated result is
claimed from offline contracts. Suggested commit:
`feat(release): require isolated private build deployment before revocation`.
