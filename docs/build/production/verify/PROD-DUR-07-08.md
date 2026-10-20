# PROD-DUR-07 Uncertain external mutation resolution and PROD-DUR-08 Build and cleanup deduplication

Branch `prod/dur-d-w3`, platform migration **33** (`0033_external_effects`). Build only: nothing below was executed except `tsc --noEmit -p .` and `eslint` on every changed file (both clean). No test was run.

## 1. Summary of what was built

### Audit first

Already held (kept, not replaced):

- `platform.build_launches` (migration 8): permanent AWS CodeBuild claim committed before `StartBuild`, approval/policy/source/fence authority at claim, immutable accepted/terminal receipts, exact `BatchGetBuilds` readback (`readExactBuild`). A claim without a receipt refused every later launch.
- `platform.agent_effect_receipts` (migration 11): immutable late runner/machine receipts (the `late-effect-receipts.test.ts` contract). Cancelled/timed-out jobs stay terminal, operations stay uncertain. Unchanged.
- `platform.workflow_start_intents` (12), `plan_artifact_uses` (7, `uncertain` phase), cleanup writer barriers (15/16, DUR-C): counts and tombstones only. Unchanged and not edited.
- Destroy activities: plan custody, digest-bound approval, `markUncertain` on an unconfirmed teardown, observation-based absence verification.
- The UX-01 projection already showed an operation whose status was `uncertain`.

Missing, now built:

| Gap | Built |
| --- | --- |
| No typed, shared record of a provider mutation with its idempotency token, fence epoch and state | `platform.external_effects` ledger with states pending / accepted / uncertain / conflict / confirmed / tombstoned, permanent, trigger-enforced |
| An AWS launch whose response was lost was stuck for ever: no evidence path, no authorized exit | Independent readback (project build list matched on source, digest, executed configuration, minus builds other effects own), operator resolution bound to the exact evidence, adoption of the confirmed build without a second launch |
| A crash between "CodeBuild accepted" and "launch row acknowledged" lost the receipt | The ledger holds the provider receipt first; the retry adopts it (`resolveUnreceiptedLaunch`) |
| GCP, Azure, Kubernetes and OCI build launches had no durable claim (Azure had its own journal): an activity retry could call the provider again | `startBuildOnce`: record before the call, store the handle as the receipt, answer every retry from it, uncertain on an unknown outcome |
| Destroy apply had no receipt or dedup of its own (only the single-use plan artifact) | `cleanup_apply` effect around the destructive call, keyed by (operation, reviewed plan digest); a retry returns the saved result or refuses |
| Late replies had no defined meaning | Late receipt is write-once evidence: never reopens `uncertain`/`conflict`/`tombstoned`; a tombstone that later receives a receipt is shown as a conflict |
| Nothing declared a vanished dispatcher uncertain | Sweep of stale `pending` effects inside the leased housekeeping pass |
| Operators had no way to see, read back or resolve | API routes, effects panel on the operation page, UX-01 projection that makes the operation `uncertain` while an effect needs review |

### Files

New:

- `src/lib/controlplane/db/migrations/0033_external_effects.ts`: tables `external_effects`, `external_effect_events`, `external_effect_resolutions`, triggers (append-only events/resolutions; identity immutable; receipts write-once; legal transitions; `confirmed`/`tombstoned` terminal; `uncertain`/`conflict` exit only with a resolution row for the exact version and readback digest; absence refused while the dispatching fence is live, inside 15 minutes of settle time, or after a late receipt), RLS on, anon/authenticated revoked, service_role SELECT/INSERT (+UPDATE on effects only; no DELETE/TRUNCATE).
- `src/lib/controlplane/db/repos/external-effects.ts`: the store (below).
- `src/lib/effects/types.ts` (vocabulary, transition tables), `binding.ts` (readback and resolution digests, resolution options, projected state), `ledger.ts` (`createEffectLedger`, `dispatchOnce`, `EffectUnresolvedError`, `EffectTombstonedError`), `readback.ts` (`ResolverRegistry`, `runReadback`, cleanup observation resolver), `resolvers/aws-codebuild.ts`, `build-launch.ts` (AWS claim glue, `startBuildOnce`), `cleanup.ts` (destroy glue), `view.ts` (client-safe projection).
- `src/lib/platform/effects.ts` (composition: roles from the capability broker, AWS readback through the existing reconcile observe session, cleanup readback from `resource_observations`), `effects-service.ts` (service over explicit parts).
- `src/app/api/platform/v1/effects/route.ts`, `[id]/route.ts`, `[id]/readback/route.ts`, `[id]/resolve/route.ts`.
- `src/components/platform/effects-panel.tsx`, `src/app/(product)/platform/operations/[id]/effects-actions.tsx`.
- Tests: `tests/effects/{_support.ts,model.test.ts,ledger.test.ts,resolvers.test.ts,build-launch.test.ts,cleanup.test.ts,routes.test.ts,effects-panel.test.tsx}`.

Modified (small insertions; see section 4 for merge risk):

- `src/lib/controlplane/db/migrations/index.ts` (register 33), `repos/index.ts` (`externalEffects`).
- `src/lib/providers/aws/drivers/compute/codebuild-builds.ts` (ledger around the existing claim; `executedSettingsDigest` exported; exact read confirms the effect).
- `src/lib/platform/release.ts` (non-AWS `startBuild` through `startBuildOnce`).
- `src/lib/execution/destroy.ts`, `src/lib/execution/ports.ts` (`ExecutionDeps.effects?`), `src/lib/platform/execution.ts` (`effects: createEffectLedger(db)` in the production composition).
- `src/lib/workflows/activities/failures.ts` (an unresolved or retired effect is a non-retryable step failure: the ledger refuses every replay, so Temporal retries are pointless).
- `src/lib/platform/housekeeping.ts` (stale-pending sweep inside the existing leased pass; `HousekeepingResult` shape unchanged on purpose).
- `src/lib/platform/operator-journey.ts`, `src/app/(product)/platform/_components/journey-live.tsx`, `_lib/loaders.ts`, `operations/[id]/page.tsx` (UX-01 feed).
- `src/app/api/platform/v1/_lib/bearer-paths.ts` (classify the four new routes).
- `tests/controlplane/tenancy.test.ts`, `tests/security/controlplane-sql-scoping.test.ts`, `tests/middleware/platform-bearer.test.ts` (classification only).

### The ledger model

```
pending ──accepted──▶ accepted ──exact readback──▶ confirmed (terminal)
   │                     │  ╲ second/different receipt or mismatching read
   │ provider refused    │   ╲──▶ conflict
   ▼                     ▼
tombstoned (terminal)  uncertain ◀── lost reply, abort, reset, lost lease, vanished dispatcher
                          │   ╲ mismatch
                          │    ╲──▶ conflict
                          └ authorized resolution (evidence + admin, browser) ─▶ confirmed | tombstoned
```

Rules enforced by the database trigger (not only by code): terminal states never change; a resolution row must name the current effect version and the current readback digest; `confirm_applied` needs a `present` readback; `confirm_not_applied` needs an `absent` readback, no live lease with the effect's fence (a renewed lease keeps its fence, so it blocks), at least 15 minutes after the call could last have been in flight, and no late receipt.

### Store functions (`repos.externalEffects`)

`begin`, `get`, `getByDedup`, `list`, `listEvents`, `listResolutions`, `isFenceLive`, `recordAccepted`, `recordRejected`, `markUncertain`, `recordReadback`, `resolve` (all take `workspace_id` and filter on it in SQL; a foreign id equals a missing one), and `sweepStalePending` (system maintenance). Idempotency token: stored in `idempotency_token` for AWS (the same `zn-...` token sent as `StartBuild.idempotencyToken`), `idempotency_supported=false` for providers that take none. Provider idempotency is defence in depth only; the ledger supplies the no-replay rule.

### Resolution flow (UX-01 / existing approval path)

1. Operation page shows "Outcome uncertain" (journey stage `uncertain`, `outcomeKnown=false`) when any effect is `uncertain` or `conflict`, whatever the operation status says, with effect-specific next steps ("Do not retry", readback, authorized resolution, new operation).
2. Editor/admin: `POST /api/platform/v1/effects/:id/readback` (read-only; AWS through the existing `infrastructure.observe` reconcile session, cleanup from reconcile observations; other providers record "no independent readback").
3. Admin in the browser: `POST /api/platform/v1/effects/:id/resolve` with `{ decision, bindingDigest, reason }`. This is the existing approval pattern used by runbooks and operations: `assertBrowserSession` (no Authorization header, exact same origin, live identity), admin role from the capability broker, digest-bound to what the person reviewed.
4. Resolution never calls the provider. A confirmed build is then adopted (`resolveUnreceiptedLaunch` → `launches.acknowledge`) without a second launch; a retired effect keeps its identity closed, so "new authorization" is a new operation through the normal plan/approval path.

## 2. Acceptance mapping

PROD-DUR-07: "Partitions/stale fences/delayed calls/revocation/renewal preserve uncertain/conflict/tombstones; provider idempotency or receipts/readback enable evidence-based operator resolution and new authorization."

| Clause | Implementation | Tests |
| --- | --- | --- |
| Partition (lost reply, reset, abort) preserves uncertain, never retried | `dispatchOnce` unknown-failure path; `markUncertain`; `EffectUnresolvedError` refuses every later caller | `ledger.test.ts` "an unknown failure ... uncertain", "two concurrent callers"; `build-launch.test.ts` "a lost or unconfirmed launch is uncertain"; `cleanup.test.ts` "an apply that ends without a known outcome" |
| Vanished dispatcher | `sweepStalePending` (housekeeping), live fence excluded | `ledger.test.ts` "stale pending sweep" |
| Stale fences | `begin` asserts the fence for a NEW effect, returns an existing one regardless; fence epoch stored | `ledger.test.ts` "records the fence epoch, and a stale fence cannot create a NEW effect"; `cleanup.test.ts` "a stale fence cannot start a new apply" |
| Delayed calls / late replies | `recordAccepted` late path: write-once `late_receipt`, state unchanged, `staleFence` flag; tombstone + late receipt shown as conflict | `ledger.test.ts` "delayed responses ..." (4 cases), `model.test.ts` projection cases |
| Revocation | A reply after revocation of the connection/approval/lease is stored (no authority needed to record evidence); readback after revocation is "could not read" (no privileged fallback) | `ledger.test.ts` "a reply after revocation ... is still stored"; `resolvers.test.ts` failing-read case |
| Renewal | Renewal keeps the fence: `isFenceLive` stays true and absence is refused until the holder is gone or superseded | `ledger.test.ts` "refuses absence while the dispatching lease still holds its fence, including after a renewal", "a takeover" |
| Conflict | Second different receipt, mismatching read, late receipt after tombstone | `ledger.test.ts` conflict cases, `build-launch.test.ts` confirm/conflict |
| Tombstones | Provider refusal and operator-confirmed absence; terminal in the trigger | `ledger.test.ts` rejection, terminal and bypass cases |
| Provider idempotency or receipts/readback enable evidence-based resolution | Receipts: `provider_receipt`; readback: AWS CodeBuild list resolver, cleanup observation resolver; token recorded | `resolvers.test.ts` (AWS 8 cases, cleanup 6, runReadback 5) |
| Uncertain accepted effects need independent receipts/readback and new authorization | `resolve` needs readback + binding digest + admin browser session; database refuses otherwise; new work needs a new operation | `ledger.test.ts` resolution block (10 cases) and trigger bypass block (4); `routes.test.ts` resolve block (7); `build-launch.test.ts` "a lost response is resolved from readback evidence plus an authorization, then adopted without a second build" |

PROD-DUR-08: "Build launches and external cleanup effects use durable receipts, independent readback and deduplicated retry rather than blind replay."

| Clause | Implementation | Tests |
| --- | --- | --- |
| Build launches: durable receipts | Ledger receipt before the launch row is acknowledged; non-AWS handle stored as the receipt | `build-launch.test.ts` "the provider's own saved receipt is adopted ...", `startBuildOnce` "launches once and returns the saved long handle" |
| Build launches: independent readback | Exact `BatchGetBuilds` read confirms the accepted effect; list-based readback for lost responses | `build-launch.test.ts` confirm case; `resolvers.test.ts` AWS cases |
| Build launches: deduplicated retry | `dispatchOnce` / `startBuildOnce` / durable claim; legacy pre-ledger launches registered | `build-launch.test.ts` (dedup, refusal, identity-reuse conflict, direct-call fallback, legacy registration) |
| Cleanup effects: durable receipt, dedup, no blind replay | `cleanup_apply` effect in `applyDestroyInfrastructure` (direct and tofu paths), `priorCleanupResult` | `cleanup.test.ts` (7 helper cases, 4 real destroy-activity cases) |
| Cleanup effects: independent readback | `cleanupObservationResolver`: Zenith's own reconcile observations after dispatch, settle window, address digest check | `resolvers.test.ts` cleanup block |

UX-01 feed: `model.test.ts` "operation journey" (failed/succeeded/running with an uncertain effect becomes `uncertain`; cancelled/rejected/denied never revived; legacy view carries it), `effects-panel.test.tsx` (panel, browser actions, live journey keeps effects).

## 3. Verification commands (other machine)

```sh
# optional real PostgreSQL lane (the suites below run on PGlite regardless)
export ZENITH_TEST_PLATFORM_PG_URL=postgres://...

npx vitest run tests/effects                                   # new suites: expected all pass
npx vitest run tests/controlplane/tenancy.test.ts tests/security/controlplane-sql-scoping.test.ts \
  tests/controlplane/migrations.test.ts tests/middleware/platform-bearer.test.ts   # classification guards
npx vitest run tests/platform-ui tests/platform/housekeeping.test.ts tests/server/cron-housekeeping.test.ts \
  tests/execution/destroy.test.ts tests/execution/destroy-providers.test.ts tests/execution/release.test.ts \
  tests/workflows/failures.test.ts                              # neighbours: must be unchanged
npx vitest run tests/controlplane/build-launches.test.ts tests/controlplane/build-launch-broker-binding.test.ts \
  tests/platform/codebuild-launch-authority.test.ts             # real PostgreSQL only; verified contracts must still hold
npx tsc --noEmit -p . && npx eslint src/lib/effects src/lib/platform/effects.ts src/lib/platform/effects-service.ts \
  src/lib/controlplane/db/repos/external-effects.ts src/app/api/platform/v1/effects tests/effects
```

Expected: all pass. Notes for the first run:

- `migrations.test.ts`, the emitted `supabase/migrations/*` parity and the gate manifest will fail until the assembler regenerates them (section 4).
- `tests/effects/*` seed operations through `tests/controlplane/_support/harness.ts`; the Postgres lane is shared and never dropped, tests use random ids. `ledger.test.ts` "stale pending sweep" declares ANY old pending effect on the shared database uncertain, which is the sweep's intended behaviour.
- `cleanup.test.ts` part two relies on the fake world's first lease having fence 1 and the test's first real `platform.leases` acquire also being fence 1 (fresh PGlite per test).
- Aged evidence is created with a raw INSERT in `_support.ts#insertAged` because the trigger makes `created_at` immutable.

## 4. Known gaps, risks and shared-file updates

Shared-file updates the orchestrator/assembler must make:

- **Migration 33** (`0033_external_effects`): add to the migrations inventory/`0022_platform_core.sql` assembly, regenerate with emit-sql into `supabase/migrations/*`, update `emit.ts` aggregate, `scripts/ci/apply-supabase-migrations.sh`, `docs/platform/operations/DEPLOYING.md` inventories (table/role/owner lists: three new tenant tables), and `tests/controlplane/migrations.test.ts` (version list, checksum pin, RLS/privilege inventory: service_role has SELECT/INSERT/UPDATE on `external_effects`, SELECT/INSERT on the other two, no DELETE/TRUNCATE). The migration is registered as version 33 while 30-32 belong to siblings; the migrator accepts the gap, contiguity holds after assembly.
- **Tenancy classification** (already added to `tests/controlplane/tenancy.test.ts` and `controlplane-sql-scoping.test.ts`; re-apply if the assembler regenerates them): WRITES (workspace-bound in SQL, foreign refusals in `tests/effects/ledger.test.ts`): `externalEffects.begin/get/getByDedup/list/listEvents/listResolutions/isFenceLive/recordAccepted/recordRejected/markUncertain/recordReadback/resolve`. UNSCOPED/EXEMPT: `externalEffects.sweepStalePending` (system maintenance under the housekeeping lease). Tenant tables discovered by the static audit: `external_effects`, `external_effect_events`, `external_effect_resolutions`.
- **Gate manifest** (`scripts/ci/gate-manifest.mjs`): register `tests/effects/ledger.test.ts`, `resolvers.test.ts`, `build-launch.test.ts`, `cleanup.test.ts` (PGlite + `[postgres]` lane), `routes.test.ts`, `model.test.ts` (unit) and `effects-panel.test.tsx` (jsdom) in the appropriate cohorts; the `[postgres]` lane runs the same files with `ZENITH_TEST_PLATFORM_PG_URL`.
- **LIMITATIONS**: see below; suggested wording for each item.
- **Operator guide**: no `docs/platform/operations/*` guide was added (that folder is pinned by `operator-docs.test.ts`: README link, source-snapshot pin, header). The orchestrator may add `EXTERNAL-EFFECTS.md` with the README link and pin; the section 1 flow and the limits below are its content.
- No workflow definition changed (replay safe), no new schedule: the sweep rides the existing leased housekeeping pass of the critical maintenance schedule.

Merge risk (concurrent DUR-A/B/C): small insertions in `destroy.ts` (`applyDestroyInfrastructure`), `ports.ts`, `platform/execution.ts`, `failures.ts`, `housekeeping.ts`. `cleanup-writer-barriers.ts` and plan-artifact custody were NOT edited; the destroy glue sits around the existing `consume`/`dispatch` calls and does not alter them. If DUR-C changes the `beforeDispatch` block in `destroy.ts`, keep `beginCleanupEffect` immediately before `started=true; await dispatch()`.

Verified behaviour changed (explicitly): none intended. Existing contracts kept: `BuildLaunchError` is still what AWS callers see for an unconfirmed launch; `HousekeepingResult` is unchanged; `toTemporalFailure` unchanged for existing error types; destroy keeps every existing refusal and adds only the ledger record and the retry dedup. New behaviour on retry: a repeated `applyDestroyInfrastructure` for an already-applied plan returns its saved result without re-running the pre-apply dry-run, and a retried non-AWS `startBuild` returns the saved handle.

Known gaps (honest limits):

1. **Readback coverage.** See section 6: AWS, GCP and Azure builds have independent readback. Kubernetes and OCI have no build path at all (their ports refuse), so there is nothing to read back. Mutating proxied requests (section 6) have a readback hint only, so a lost one stays uncertain.
2. **Absence is not quiescence.** A settled absent readback plus a gone fence is strong evidence, not proof that no request is still in flight inside the provider; DUR-C's quiescence barrier remains the authority for destructive cleanup. The 15 minute settle window is a constant (`ABSENCE_SETTLE_MS`, mirrored in the trigger).
3. **CodeBuild list readback is bounded** (5 pages of 100 builds, then "too long to read back"), and a build listed by the project but owned by a different launch is excluded only if the ledger or `build_launches` knows its id.
4. **Cleanup readback needs reconcile observations newer than the dispatch.** If no reconcile pass has observed the reviewed addresses since, the readback is unavailable; trigger a reconcile pass.
5. **Operation status is not rewritten.** The journey projects an unresolved effect as `uncertain` (UI, `readJourney`), but `platform.operations.status` stays what the workflow wrote (for a build that is usually `failed`). Consumers that read only the status column (MCP `get_operation`, CLI) do not yet see the effect state; they can list `/api/platform/v1/effects?operationId=`.
6. **Late agent receipts** keep their own table; they are not mirrored into the effects ledger and the `machine_delivery`/`workflow_start` families were deliberately not added (each needs its own resolver and caller wiring). Families are now `build_launch`, `cleanup_apply`, `proxy_request`.
7. **No real-engine proof here.** The AWS resolver is tested against an in-memory CodeBuild double using the exact read commands; real CodeBuild, real `observe` session wiring (`platformEffects()` composition) and the Temporal retry path are unexercised. The route tests use explicit identity/credential adapters like `runbook-routes.test.ts`.
8. **Resolver provenance.** `otherBuildIds` consults ledger receipts and `build_launches` of the same workspace only.

## 5. Suggested ledger strings

- PROD-DUR-07 `implementationStatus`: `implementation_complete_verification_pending` (external-effect ledger, readback resolvers for AWS builds and cleanup observations, evidence-bound browser resolution and UX-01 projection built; real PostgreSQL, real CodeBuild readback and operator journey runtime evidence pending; non-AWS build readback not built).
- PROD-DUR-08 `implementationStatus`: `implementation_complete_verification_pending` (ledger receipts and deduplicated retry for build launches on all providers and for destroy apply; independent readback for AWS builds and cleanup; runtime acceptance pending).
- Suggested `testPaths`: `tests/effects/ledger.test.ts`, `tests/effects/resolvers.test.ts`, `tests/effects/build-launch.test.ts`, `tests/effects/cleanup.test.ts`, `tests/effects/routes.test.ts`, `tests/effects/model.test.ts`, `tests/effects/effects-panel.test.tsx`.

## 6. Follow-up: non-AWS build readback and runner HTTP proxy requests

### 6.1 GCP Cloud Build and Azure ACR Tasks readback

- `src/lib/effects/resolvers/gcp-cloudbuild.ts`: lists the project's builds with a `tags="zenith-op-..."` filter through the brokered GCP session. One tagged build is `present` (id as the resource), none `absent`, several `mismatch`; any error, foreign project or missing identity is `unavailable`.
- `src/lib/effects/resolvers/azure-acr.ts`: finds the build registry by its `zenith:resource` tag, lists QuickBuild runs since the dispatch and matches a SUCCEEDED run by repository and `zn-<64 hex>` output tag. Running or failed runs expose no tag, so if any exist since the dispatch the answer is `unavailable`, never `absent`.
- Both use the existing reconcile `withObserveSession` (the reconciler's `infrastructure.observe` read grant, the verified connection of the effect's environment); `createEffectResolvers` in `src/lib/platform/effects.ts` now opens one such session per provider.
- The ledger target now carries the launch identity: `BuildPort.launchIdentity?` (GCP: tag, project, region; Azure: tag, repository, registry address, subscription) and the receipt's resource id is the provider's own id (GCP build id, ACR run id).
- Adoption: `BuildPort.adoptBuild?` rebuilds the handle of a launch an operator confirmed (GCP and Azure implement it; GCP's `startBuild` was split into a read-only `prepare` plus the launch, behaviour unchanged). `startBuildOnce` calls it for a `confirmed` effect with no saved handle, so a confirmed build is waited on, never started twice.
- OCI and Kubernetes: no build path exists (their ports refuse), so there is no launch to resolve.

### 6.2 Runner HTTP proxies (`aws.http`, `oci.http`, `k8s.http`)

- `src/lib/effects/proxy.ts`: classification by an explicit per-provider READ allowlist, never HTTP method alone; everything not listed mutates.
  - AWS: RPC/query actions are read only if the action name starts with `Describe`, `List`, `Get`, `BatchGet`, `Head`, `Lookup` or `Search` (`x-amz-target` or the form `Action`); REST GET/HEAD is read only for the listed services (`s3`, `route53`, `lambda`, `apigateway`, `cloudfront`, `eks`, `elasticfilesystem`). An opaque POST is mutating.
  - OCI: read means the request is in the existing OCI observe allowlist (service, method, path rules); anything else mutates. A POST's `opc-retry-token` (already mandatory) is recorded as the idempotency key.
  - Kubernetes: GET and three self-review POSTs are reads; everything else mutates. The API has no client token; the effect says so and names the object to GET.
- Wiring (production): `aws-runner-transport.ts` (`RunnerAwsTransportOptions.effects`, set by `platform/credentials.ts` for every runner-mode AWS session) and the OCI runner session in `platform/credentials.ts`. Only sessions whose capability mutates are guarded; read sessions (no operation row) are untouched. `k8s.http` has no TypeScript sender today; the classifier and `runProxyJob` are what any sender must use.
- Every mutating request is recorded BEFORE it is queued (family `proxy_request`: operation, provider, action, resource, token location, readback hint). AWS APIs that take a client token and were sent without one get a deterministic token (CodeBuild `idempotencyToken`, ECS `clientToken` on RunTask/CreateService/CreateTaskSet, EC2 `ClientToken` on RunInstances/CreateNatGateway/CreateFleet), derived from the operation and the exact request. A caller's own token is never replaced.
- Outcomes: 2xx accepted (the compact reply is kept up to 6 KB, so an identical repeat is answered from it without reaching the runner; a larger reply is not kept and a repeat is refused); 4xx (not 408), 429 and 503 are definite non-application, so the attempt is retired and a new attempt (`:a1`) is allowed; other 3xx/5xx, a failed or timed-out job, or a lost wait are `uncertain` with the readback hint in the reason, and an identical repeat is refused. A runner rejection or a job cancelled before delivery retires the attempt, as does a refusal before queueing.
- `proxyRequestHintResolver` (family `proxy_request`): there is no generic independent read, so a readback records `unavailable` with the hint; these effects stay uncertain until a family specific resolver exists.

### 6.3 Shared-file edits in this follow-up (all additive)

`src/lib/execution/ports.ts` (two optional `BuildPort` methods), `src/lib/runners/aws-runner-transport.ts`, `src/lib/platform/credentials.ts`, `src/lib/platform/release.ts`, `src/lib/providers/gcp/release/build.ts`, `azure/release/build.ts`, migration 33 (family check now includes `proxy_request`). `destroy.ts`, `execution.ts`, `failures.ts`, `housekeeping.ts` were not touched again.

### 6.4 Tests added

`tests/effects/proxy.test.ts` (classification, token injection, `runProxyJob` on the real store) and `tests/effects/provider-resolvers.test.ts` (GCP and Azure resolvers against session doubles; lost launch to readback, authorization and adoption without a second launch). Register both in the gate manifest. Not covered: the real `RunnerHttpHandler` and OCI session end to end with a live runner, and real GCP/Azure APIs; the Azure `$filter` on runs (`RunType eq 'QuickBuild'`) is unverified against live ACR.

### 6.5 Added limits

Identical mutating proxied requests inside one operation are deduplicated by exact request digest, so a deliberate second identical mutation is answered from the first reply; right for idempotent provider calls, wrong for any API where repeating is the point (it would need a per-call nonce).

Decision (2026-10-21): keep exact-digest exactly-once per operation. A per-call nonce (for example the AWS SDK invocation id) changes when an interrupted apply is resumed, so it would let the resumed apply re-send an already-accepted mutation, which is the blind replay this requirement forbids. Repeat-meaningful provider APIs differ in request content (client tokens, names), so they are separate effects. A repeat answered from the receipt is no longer silent: the result carries `replayedFromReceipt: true` (asserted in tests/effects/proxy.test.ts). The AWS read-verb allowlist is by action prefix (an action named `GetOrDeleteX` would count as read): add exceptions if one appears.
