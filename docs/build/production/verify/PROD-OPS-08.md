# PROD-OPS-08: Independent adversarial security acceptance

Branch `prod/ops-08-w5`, base c02c097e. Build only: nothing here was executed. `tsc --noEmit` and `eslint` on the
changed files are clean; the vitest files below must be run on the verifying machine.

## 1. Summary

New suite under `tests/adversarial/`, one file per threat class, plus the threat model
`docs/platform/ADVERSARIAL-ACCEPTANCE.md`. Thirteen narrow fixes (F1-F8, then F9-F13 for the five residual risks the coordinator asked to close) for vulnerabilities the suite's cases exposed by reading
the code (the tests assert the fixed behaviour, so each fix is also its regression test).

Files added:

- `tests/adversarial/cross-tenant.test.ts`
- `tests/adversarial/role-escalation.test.ts`
- `tests/adversarial/approvals-forgery.test.ts`
- `tests/adversarial/ssrf-rebinding.test.ts`
- `tests/adversarial/prompt-injection.test.ts`
- `tests/adversarial/malicious-archives.test.ts`
- `tests/adversarial/token-forgery.test.ts`
- `tests/adversarial/build-exfiltration.test.ts`
- `tests/adversarial/integration-compromise.test.ts`
- `tests/adversarial/residual-hardening.test.ts` (F9-F13 regression tests)
- `docs/platform/ADVERSARIAL-ACCEPTANCE.md`

Source changed (all narrow): `src/lib/portability/net.ts`, `src/lib/alerts/webhook-policy.ts`,
`src/lib/alerts/deliver.ts`, `src/lib/execution/prober.ts`, `src/lib/hosted/source/validate.ts`,
`src/lib/hosted/backup/bundle.ts`, `src/lib/portability/artifact.ts`, `src/lib/execution/build-isolation.ts`.

No migration, no new table, no new dependency, no workflow or gate-manifest change made. No shared-file edits.

## 2. Findings

| # | Where | Severity | Finding | Fix |
| --- | --- | --- | --- | --- |
| F1 | `src/lib/portability/net.ts:47` `classifyAddress` | High | The connection guard for tenant-supplied hosts (MySQL, Postgres, S3 endpoint, DNS engines) classified NAT64 (`64:ff9b::/96`, `64:ff9b:1::/48`), 6to4 `2002::/16`, IPv4-compatible `::a.b.c.d`, IPv4-translated, Teredo/`2001::/23`, `2001:db8::/32`, `100::/64`, `3fff::/20` and `fec0::/10` literals as public, so `64:ff9b::a9fe:a9fe` (metadata) and `64:ff9b::7f00:1` (loopback) passed. Under the private-range opt-in, AWS IMDSv6 `fd00:ec2::254` and Alibaba metadata `100.100.100.200` were allowed. IPv4 documentation, protocol-assignment and 6to4-relay ranges were public; benchmarking space was public. | These ranges now classify as `never` (benchmarking `198.18/15` as `private`); both metadata addresses are `never`. The webhook and probe guards already refused them; the three guards now agree and are tested against one independent oracle. |
| F2 | `src/lib/alerts/webhook-policy.ts:~425-445` `blockedCategory` | Low | `fec0::/10`, `2001::/23`, `100::/64`, `3fff::/20` and IPv4-translated `::ffff:0:a.b.c.d` were not blocked for alert webhook targets. | Added as non-relaxable categories. |
| F3 | `src/lib/execution/prober.ts:78` `BLOCKED` | Low | IPv4-translated `::ffff:0:0:0/96` was a public address for probes. | Added to the block list. |
| F4 | `src/lib/hosted/source/validate.ts:~279-293` `validateSource` | Medium | Tenant source tarballs accepted names colliding under case-folding or Unicode normalisation (`src/A.ts` and `src/a.ts`, NFC and NFD) and a path that is both file and directory. On a case-insensitive filesystem the second write wins, so disk differs from the pinned digest; the file-under-file case surfaced as an unclassified raw filesystem error during materialisation. | Both are refused with `unsupported_source` and the offending paths. |
| F5 | `src/lib/hosted/backup/bundle.ts:49,136-141` `unpackBundle`, `NAME_RE` | Low | A restore container with a duplicated file name and a matching count passed validation (one file written twice, another missing); a manifest without a file table threw a raw `TypeError`; names with `.` segments aliased other names. | Duplicate names and a missing file table are refused with the container's error; `.` and `..` segments are refused. |
| F6 | `src/lib/portability/artifact.ts:14` `ARTIFACT_NAME` | Low | `a/./b` aliases `a/b`: two distinct manifest names for one location. | `.` segments refused like `..`. |
| F7 | `src/lib/execution/build-isolation.ts:112` `profileFor` | Low | `__proto__` and `constructor` resolved to inherited objects, failing later with a `TypeError` instead of the typed refusal. Fail-closed but off-contract. | Own-property lookup only. |
| F8 | `src/lib/alerts/deliver.ts:~222` `slackBody` | Low | Alert titles, details and close reasons went into Slack mrkdwn unescaped, so attacker-influenced text could page a channel (`<!channel>`), mention users or render a link. | `slackEscape` (`&`, `<`, `>`) applied to every interpolated field. |
| F9 | `src/lib/hosted/gateway/reserved.ts` (`signIn`, `authCallback`) | Medium | Launch `state` travelled in the same URL as the single-use code and was compared only with the value stored beside it, so a code minted for an attacker's own launch signed any browser that opened the callback in as the attacker (login CSRF, session fixation). | The app-host sign-in page mints a random nonce in a host-only `__Host-zenith_login` cookie (Secure, HttpOnly, SameSite=Lax, 10 minutes) and links the launch with it as `state`; the callback refuses, before consuming the code, any `state` that is not exactly that cookie, and clears it on success. |
| F10 | `src/app/api/platform/v1/_lib/principal.ts` `callerOf` | Medium | The platform REST bearer path verified any `Authorization` header with no host check and no authority-kind rule, unlike the MCP endpoints (a file-authority development credential was accepted over a remote origin; forwarded Host not checked). | `assertBearerSurface`: only `Bearer za_...` accepted (plugin, OAuth, other schemes refused), Host must equal the configured origin, and a `file` authority is accepted only on a loopback http origin. Two test mocks that used `kind: "file"` over https now say `postgres`. |
| F11 | `src/lib/runners/dispatch.ts` `checkGrant`, `read-jobs.ts`, `runtime.ts` | Medium | Runner dispatch verified the grant signature, audience and operation but never consulted revocation, so a grant revoked after issue still started a job. | `RunnerRuntime.grantRevoked` (default reads `platform.capability_grants`; an unknown jti is not revoked) is passed to `verifyCapabilityGrant` as `isRevoked` in both enqueue paths. A runtime built with its own store and no hook has no revocation source and behaves as before. Poll/claim also re-checks: `pollAgent` reads the grant from the signed envelope and, if revoked since enqueue, settles the claimed job as `rejected` ("withdrawn") and never delivers it. Not covered: revocation after the agent has received the job. |
| F12 | `src/lib/hosted/source/tar.ts` `scanTar` | Medium | The reader accepted an archive with no end-of-archive marker, a single trailing zero block and arbitrary bytes after the marker (stored raw by upload), and treated cut-short archives as complete. | Requires two zero blocks followed only by zero padding; refuses a missing or partial marker and any non-zero trailing data. Truncated entries, size mismatches and bad checksums were already refused and are now regression-tested. |
| F13 | `src/lib/sources/github/app.ts` `secretFile` | Medium | The GitHub App private key and OAuth client secret were read with no ownership, mode, symlink or hard-link check, unlike the webhook secret. | Reads only a regular file owned by the process uid, with no group or world bits, one link, opened with O_NOFOLLOW and matched to the lstat inode. On Windows it reuses the CLI's native-security-API check (`verifyWindowsOwnerOnlyAcl`, exported from `src/cli/config.ts`, added by PROD-CI-08): owner-only NTFS ACL, refusing when the check fails. Parent-directory checks are not applied. The Windows path has no automated test here (the F13 test is POSIX-only). |

Residual items F9-F13 were first recorded as observations and are now fixed. Still observed and not fixed (not narrow, or a documented decision): see "Residual risk and non-goals" in
`docs/platform/ADVERSARIAL-ACCEPTANCE.md`. The ones most worth a follow-up requirement are the hosted launch `state`
not being browser-bound, the platform REST bearer path lacking the MCP origin/authority-kind check, and the
hosted source tar reader's missing terminator and trailing-data checks.

The tests assert the expected-safe behaviour for fixed items. They do not use expected-failure markers.

## 3. Acceptance mapping

| Clause | Implementation | Tests |
| --- | --- | --- |
| Tenant | route and repository inventories, reflective sweep, edge access classification | `cross-tenant.test.ts` |
| Role, escalation | catalog-generated sweep, admin-only operation matrix | `role-escalation.test.ts` |
| Stale approval, forgery, replay, semantics | broker matrices, grant verifier forgery, digest component mutation | `approvals-forgery.test.ts` |
| SSRF, rebinding | corpus times wrappers over three guards, URL obfuscation, pinned literals, outbound inventory | `ssrf-rebinding.test.ts` |
| Prompt injection | corpus over agent, analysis, broker free text | `prompt-injection.test.ts` |
| Archive | six readers, generated hostile constructions | `malicious-archives.test.ts` |
| Build, exfiltration | child environment, isolation admission, recipe container argv | `build-exfiltration.test.ts` |
| Forgery, audience confusion | mutation operators over every token kind | `token-forgery.test.ts` |
| Integration compromise | webhook, GitHub download, plugin manifest, alert text | `integration-compromise.test.ts` |
| Threat model doc | `docs/platform/ADVERSARIAL-ACCEPTANCE.md` | n/a |

## 4. Verification commands (other machine)

Node 22. PGlite is used everywhere; no external service is needed. POSIX host needed for the webhook block only (it is
skipped with a reason on Windows).

```
npx vitest run tests/adversarial
npx vitest run tests/portability tests/alerts tests/execution/prober.test.ts tests/hosted/source tests/hosted/backup tests/platform/source-bundle.test.ts tests/execution/build-isolation.test.ts
npx vitest run tests/capabilities tests/security tests/controlplane/tenancy.test.ts tests/runners tests/hosted tests/sources tests/platform tests/offered-catalog tests/effects tests/machines
```

Expected: all pass. The first command is the new suite. The second and third are the regression neighbourhood of the
eight fixes: if a pre-existing test pinned the old behaviour (for example an address in `198.18/15` or `2001:db8::/32`
treated as connectable by a portability test, or a hosted source fixture with case-colliding names) it needs the fixture
corrected, not the fix reverted.

Things most likely to need a first-run adjustment, because they were written without being executed:

1. `cross-tenant.test.ts` repository sweep depends on `Function.prototype.toString` parameter names surviving the
   transform; it asserts at least 15 functions were exercised and says so if not.
2. `approvals-forgery.test.ts` relies on the harness world key format `${workspaceId}|${userId}` for demotions.
3. `prompt-injection.test.ts` asserts proposal-quality properties only for payloads under 20 kB and excludes the NUL
   category (a NUL makes a file binary and the repository unanalysable).
4. `malicious-archives.test.ts` `unpackBundle` duplicate-name forgery builds raw container bytes from the documented
   layout (`ZBK1`, version byte, u32 manifest length, entries of u16 name length, u64 content length, name, content).
5. `integration-compromise.test.ts` plugin mutation test excludes the single `signature.value` suffix mutation (lenient
   base64 decoding); it expects more than 30 generated mutants.

## 5. Known gaps and shared-file updates for the orchestrator

- No gate-manifest, workflow or ledger edit was made. To run in CI add `tests/adversarial` to the unit lane in
  `scripts/ci/gate-manifest.mjs` (the assembler owns it). The suite is PGlite-only and takes a few minutes: the
  capability sweeps run 700 proposals per store.
- No new table; nothing to add to `src/lib/sensitivedata/inventory.ts` or the tenancy classifications.
- Live acceptance, real DNS rebinding and real GitHub behaviour are not exercised and not claimed.
- The webhook block cannot run on Windows (secret custody checks need POSIX).
- Verified behaviours changed: none intentionally. Behaviour tightened only where the fixes above refuse previously
  accepted hostile input.

## 6. Suggested ledger implementationStatus

`implementation_complete_verification_pending`: nine-file adversarial suite with generated cases, threat model, eight
narrow fixes recorded; unrun pending verifier execution; eight observed residual items recorded as follow-ups.

## 7. Residual-risk follow-up (F9-F13)

Regression tests: `tests/adversarial/residual-hardening.test.ts`. Existing tests adjusted because they exercised the old behaviour: the hosted gateway callback tests (`tests/hosted/gateway/reserved.test.ts`, `journey.test.ts`, `tests/hosted/acceptance/gate-02-second-identity.test.ts`) now send the login nonce cookie; `tests/capabilities/routes.test.ts` and `tests/offered-catalog/route.test.ts` mock a `postgres` authority. Tests that write a GitHub App key file (`tests/sources/fixtures.ts` uses mode 0600) need a POSIX host; the F13 block is skipped on Windows.

## 8. Residual-risk follow-up, 2026-10-26 (three fixes)

Changed in code; regression tests added. F14 and F15 have no verification run attached. F16 has a local run on its branch (see its bullet), which is not an independent verification.

- F14, dispatch quota fail-open (was residual item in `ADVERSARIAL-ACCEPTANCE.md`). `src/lib/ops/admission.ts` `assertDispatchAdmitted` admitted when the quota lookup or the active-operation count failed. Root cause: `QuotaCache.get` swallowed load errors (returned the last known value or defaults), and the active-count `catch` logged and allowed. Fix: `QuotaCache.get(ws, { failClosed })` throws on a failed load when the platform store is configured; the count failure also refuses. Refusal is `BackpressureError` code `admission_unavailable` (503, layer `dispatch`, retry 5 s), with a fixed message that carries no store detail. Unconfigured installs keep the defaults and no count, as before. Tests: `tests/ops/admission.test.ts` (quota lookup throws, control store unreadable, count unreadable then readable, under quota admitted, over quota refused, unconfigured admitted). The earlier test that asserted admission on a failed quota read now asserts refusal.
- F15, recall of a grant revoked after receipt (was residual item). A delivered job's grant was checked at poll and enqueue only, so a grant revoked after the agent received the job still got its result accepted. Root cause: no check at the agent's later control-plane step. Fix: `settleResult` (`src/lib/runners/service.ts`) re-reads the job's grant status through the authoritative grant store (`repos.grants.status`, one indexed read, via a new optional `RunnerRuntime.grantStatus` whose production default is that read; the revocation hook is the fallback). `active` and `consumed` proceed; `revoked`, `expired` and `unknown` refuse with 403 `grant_not_active`, and the job is not settled. Scope: this gates the control-plane result step only; the agent-side check before each step is F16. Work the agent already started locally is not stopped by this gate. Tests: `tests/runners/grant-recall.test.ts` (revoked after receipt refused and nothing settled, active proceeds, expired and unknown refused, consumed proceeds, hook fallback, no source).
- F16, recall before each step of a multi-step job (the agent-side half of F15's "not stopped" scope). Root cause: the Go agent never asked the control plane whether a delivered job's grant was still live, so a `tofu.run` job ran every remaining step after a recall. Fix: the agent attaches a step gate to each job's context (`go/internal/agent/stepgate.go`, `WithStepGate` from `safeRun`; `CheckStep` in the job). The gate calls `GET .../jobs/{jti}/grant` (`src/app/api/platform/v1/{runners|machines}/[id]/jobs/[jti]/grant`), served by `checkGrantLive` (`src/lib/runners/service.ts`) on the same `grantStillLive` rule as F15. No existing heartbeat or poll response carried grant state, so a new read route was added; it is signature-authenticated and listed in `paths.ts` and `bearer-paths.ts`. `tofu.run` (`go/internal/runner/kinds/tofu.go`, `refusedStep`) checks before its version probe, init, plan, show and apply and ends the job `rejected` with `grant_not_active`, or `grant_unverified` when liveness cannot be confirmed (fail closed). A refused apply runs nothing and does not consume the plan. Not stopped: a step already running when the grant is revoked runs to its end; machine operations are single-step and not gated. Tests: `go/internal/agent/agent_test.go` (`TestRecalledGrantBetweenStepsStopsTheJob`, `TestLiveGrantRunsEveryStepWithACheckBeforeEach`), `go/internal/runner/kinds/tofu_gate_test.go`, `tests/runners/grant-recall.test.ts` (live, revoked, expired and unknown, consumed, recall between two checks, another agent's job gets 404), route-inventory pin in `tests/middleware/platform-bearer.test.ts` raised from 116 to 118. Local run on the branch: `go vet ./...`, `go test ./...`, vitest on `tests/runners`, `tests/middleware`, `tests/ci/platform-coverage.test.ts`, `tests/docs/operator-docs.test.ts`, and `tsc --noEmit` all passed.
- F1 (section 2) regression coverage confirmed: `tests/adversarial/ssrf-rebinding.test.ts` covers the NAT64, 6to4, IPv4-translated, Teredo, documentation, benchmarking and metadata literals listed there. No new test was needed for it.
- Schema: no migration. No SQL added or changed, so the SQL source audit (`tests/security/controlplane-sql-scoping.test.ts`) needed no pin change.

## L1-LIVE-AWS provider slice (8 October 2026)

Acceptance: Tenant/role/stale-approval/SSRF/rebinding/prompt injection/archive/build/exfiltration/forgery/escalation/integration compromise tested independently.

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

Acceptance contract: Tenant/role/stale-approval/SSRF/rebinding/prompt injection/archive/build/exfiltration/forgery/escalation/integration compromise tested independently.

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
node scripts/ci/wave6-gates.mjs --requirement PROD-OPS-08 --print > /tmp/zenith-wave6-PROD-OPS-08.commands.json
```

This prints the exact argv for each contract batch and required engine case, its gate names, private prerequisites, and its strict report-validation command. Set only the gates for the selected lane after preparing its owned fixture; a skip cannot satisfy that lane. Run each `argv` sequentially and then its `verify` argv. [Final integration setup and results](FINAL-INTEGRATION.md), [canonical inventory](../../../../scripts/ci/wave6-gates.json), [owner live runbook](../LIVE-ACCEPTANCE.md).
