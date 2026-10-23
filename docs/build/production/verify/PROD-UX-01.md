# PROD-UX-01 Accessible privileged operator journey: verification notes

The original journey slice below is retained as historical context. The J3 MFA additions and current execution results follow at the end. No browser, engine, screen-reader or production verification is claimed by J3.

## 1. What was built

Audit first: `/platform` already had operations list, operation detail (digest-bound approve/reject, plan changes table, cost, policy, timeline, pre-execution cancel), environments, incidents, settings, AWS connect. Missing: any runbook UI, readiness UI, live progress, replan/reapproval handling, ownership-transfer review, an explicit uncertain next-steps flow, a legacy deployment view, and a nav with current-page semantics.

New code:

- `src/lib/platform/operator-journey.ts`: the ONE projection (pure, client-safe). `projectPlatformOperation`, `projectLegacyDeployment` (a workflow deployment defers to its linked operation, so uncertainty is carried over), `projectRunbookRun` (a failed run with an uncertain step is uncertain), `reapprovalState` (digest change), `ownershipTransferRows` / `ownershipWarnings` (read the digest-covered `proposal.broker.ownershipTransfers`), `diffRunbookSteps` (exact effect vs previous version), `describeSchedule`, `runbookApprovalEligibility` (display mirror of the route rules), `nextStepsFor`.
- `src/components/platform/journey-panel.tsx`: renders a `JourneyView`: labelled region, one polite `aria-live` status, step list with state words (colour never alone), `aria-current="step"`, explicit uncertain/failed callouts with numbered next steps.
- `src/components/platform/ownership-transfer-review.tsx`: exact transfer table (caption, column/row headers) bound to the proposal digest.
- `src/app/(product)/platform/_components/journey-live.tsx`: polls the same read endpoints (operation, deployment+linked operation, runbook run) and re-runs the same projection; stops when terminal, pauses when the tab is hidden, marks stale after 2 failures, refreshes the server render on stage change, raises a focused `role="alert"` reapproval notice when the review digest changes.
- `_components/platform-nav.tsx` + `layout.tsx`: nav landmark with `aria-current="page"` (most specific link wins), links to Runbooks, Readiness, Connections (LIFE-01), keeps the existing GitHub source link literal (tests/docs asserts it).
- Pages: `operations/[id]` (live progress, ownership review ahead of the approval card, deployment link), `deployments/[id]`, `runbooks`, `runbooks/runs/[id]` (+ `run-actions.tsx`: approve with `bindingDigest`, cancel), `runbooks/schedule-actions.tsx`, `readiness`.
- Loaders (`_lib/loaders.ts`): `loadDeployment`, `loadRunbooks`, `loadRunbookRun`, `loadReadiness`; `loadOperation` now also returns `linkedDeploymentId`. `browser-api.ts`: `browserRead` (GET, platform read paths and `/api/deployments/:id` only).
- `operation-actions.tsx`: focus moves to the decision confirmation; cancel reason linked by `aria-describedby`.

No new API routes, tables, migrations, npm dependencies or shared-registry edits. Every page uses the existing session auth, broker role resolution, runbook service authorization and browser-only approval routes.

## 2. Acceptance mapping

Acceptance: "Connection admin/onboarding/readiness/plan/progress/cancellation/replan/reapproval/uncertainty/accessibility with consistent legacy/platform projections; MFA/step-up and workspace controls for privileged humans."

| Clause | Implementation | Tests |
| --- | --- | --- |
| readiness | `/platform/readiness` over `executionPlaneReadiness`, role-gated, honest limits | operator-pages "readiness page" |
| plan (exact effect diff, approval binding) | existing PlanChangesTable + ApprovalCard (planDigest/proposalDigest bound); runbook `diffRunbookSteps` + binding digest on `/runbooks/runs/[id]` | operator-journey "runbook effect diff"; operator-pages "runbook run page" |
| LIFE-12 ownership-transfer approvals | `OwnershipTransferReview` rendered before the approval card from digest-covered transfers | journey-live "ownership transfer approvals"; operator-pages "operation page journey wiring" |
| MACH-03 runbook approvals | run and schedule approve controls, independent-admin display rules, raw-exec warning, audit trail | journey-live "runbook decisions"; operator-pages |
| progress | `JourneyLive` polling + polite live region | journey-live "JourneyLive" (interval and terminal stop with fake timers) |
| cancellation | operation cancel (pre-execution), runbook cancel (pending/running), reasons when unavailable | operator-journey "cancellation states"; journey-live "cancels through the cancel route" |
| replan / reapproval | `reapprovalState` + focused alert + server refresh; operation page remounts decision on new digest | operator-journey "replan and reapproval"; journey-live "raises a reapproval alert" |
| uncertainty | `uncertain` stage, `outcomeKnown=false`, next steps ("do not retry/re-run", observe, propose new) | operator-journey; journey-live; operator-pages |
| consistent legacy/platform projections | single projection module used by server and client for all three sources | operator-journey "legacy and platform views agree" |
| accessibility (WCAG 2.1 AA) | landmarks (`nav`, labelled `section`, one `main` from the shell), heading order, table captions/scopes, `aria-live`, `aria-current`, focus moves, disabled controls explained via `aria-describedby`, tokens only | journey-live "JourneyPanel semantics"; operator-pages heading/landmark checks |
| connection admin / onboarding | NOT built here (LIFE-01); nav links to `/platform/connections` and `/platform/connections/aws` | n/a |
| MFA/step-up, workspace controls | J3 server guard, TOTP screens and workspace controls (see addendum) | tests/auth/mfa*.test.ts; tests/screens/mfa.test.tsx |

## 3. Verification commands (other machine)

```
npx vitest run tests/platform-ui tests/docs/operator-docs.test.ts
npx tsc --noEmit -p . && npx eslint "src/app/(product)/platform" src/components/platform src/lib/platform/operator-journey.ts tests/platform-ui
```

Expected: all pass. `tests/platform-ui/interactions.test.tsx` and `pages.test.tsx` are unchanged and should still pass (operation page keeps its structure; the loaders mock there does not need the new exports because those pages do not import them). No env vars or services are needed; HTTP replies are fakes, so no live-API claim is made.

## 4. Known gaps and orchestrator follow-ups

- Accessibility was reasoned from structure and jsdom assertions only. No axe run, screen-reader pass, contrast measurement or keyboard walk in a real browser was done; tokens are the existing ones.
- `/platform/connections` (index) is LIFE-01's. Until it merges the nav link 404s. `/platform/connections/aws` exists.
- J3 adds server-side MFA / step-up and workspace controls. Operated browser acceptance remains pending; see the addendum.
- Readiness is a server page only (no REST route), to avoid touching the bearer-path inventory. It reads this process's driver registry, as documented in `bridge/readiness.ts`.
- J3 adds a confirmed UI for the existing engine `deploy.cancel` action. Workflow deployments continue to point to their linked operation.
- Runbook publish and request-run have no browser form; REST remains the entry. Run approval has no separate reject: cancel is the refusal.
- The replan alert relies on the review digest changing between polls; an approval round bump with the same digest is not a replan (the server render and `approvalRound` already govern approval eligibility).
- Hidden-tab polling pauses via `document.visibilityState`; an interval tick is skipped, not queued.

## 5. Suggested ledger implementationStatus

`implementation_complete_verification_pending`

## J3 MFA and legacy cancellation addendum, 2026-10-08

Base: `3a9de905`; worktree `prod6-j3-mfa`. All changes remain uncommitted for the orchestrator. No `.git` writes, dependency edits, migrations, SQL snapshots, real cloud calls or privileged fallbacks.

### Implementation and acceptance mapping

| Contract | Implementation and tests |
| --- | --- |
| Supabase TOTP enrollment and challenge | `src/app/(product)/account/mfa/{enrol,challenge}/page.tsx`, `mfa-flow.tsx`: live account check, verified TOTP selection, enroll, challengeAndVerify, explicit unverified-enrollment cancellation; key/code erased after verification. `tests/screens/mfa.test.tsx` uses mocked SDK responses. |
| AAL2 on privileged human routes | ONE `requireStepUp(req, { subject, workspaceId? })` in `src/lib/auth/mfa.ts`: signature-verified getClaims, exact AAL2, finite unexpired exp, matching live getUser and confirmed email, currently verified TOTP factor. Missing/unknown AAL and removed factors refuse. No getSession, metadata claim, demo identity or provider outage can grant access. `tests/auth/mfa.test.ts`. |
| Reachable server guard | `mfa-routes.ts` runs in the real `server/request.ts` scope before each handler; admin mutation metadata is covered even for new paths. Actions use their registered mutates/risk/role/category metadata and the parsed execute mode. Plan/read helpers remain accessible. `tests/auth/mfa-routes.test.ts` tests the real wrapper, concrete approval/action/confirmation routes and an explicit route inventory with SDK claims mocked. |
| Installation operator controls | `ops/operator.ts` and `waitlist/http.ts` call the same guard after their existing user-ID allowlist checks. No workspace admin becomes an installation operator. Raw maintenance/quotas and waitlist admission/preview are covered. `tests/auth/mfa-operators.test.ts`. |
| Workspace controls | Migration 56 / `repos/workspace-mfa-controls.ts` persist workspace-owned controls. `mfa-policy.ts` reads current state and refuses store outages. Admin/AAL2-only `PUT /api/workspace/mfa` uses a reviewed version and atomically appends `workspace.mfa_controls_changed`; viewers can GET. The settings form edits the actual selected workspace; privileged AAL2 remains immutable. Tests: `tests/auth/mfa-workspace-state.test.ts`, `tests/screens/mfa.test.tsx`. |
| Accessible screens | Native form submit, explicit labels, OTP/numeric input hints, described help, focus on code/alert/success, busy/duplicate-submit guard, existing Button/Input tokens, accessible manual setup key and QR alternative. DOM assertions are contract evidence only. Real Playwright/axe gate below. |
| Legacy engine cancellation | `platform/deployments/[id]/legacy-cancel.tsx` confirms and executes the existing tenant-scoped `deploy.cancel` action, disables viewers, preserves partial-change warning, refreshes only after confirmed success. Page and shared `operator-journey.ts` projection are wired; terminal deployments remain uncancellable. Workflow ownership and cancellation are unchanged. |

The orchestrator review assigned expand-only migration 56. New table `platform.workspace_mfa_controls` is workspace-keyed, RLS-enabled and denied to browser roles, with service-only select/insert/update, like sibling settings. It is classified in `src/lib/sensitivedata/inventory.ts`. New repository functions `getWorkspaceMfaControls` (scoped read) and `putWorkspaceMfaControls` (scoped transactional write/audit) are exposed in bindRepos and classified/swept in `tests/controlplane/tenancy.test.ts`. Versions 44-56 remain reserved for their owners and must be inserted by the assembler; no placeholders, published migration edits or aggregate SQL changes. No Auth factors or secrets are stored by this table.

Changed/added files (26 total):

```text
docs/build/production/ledger.json
docs/build/production/verify/PROD-UX-01.md
src/app/(product)/account/mfa/challenge/page.tsx
src/app/(product)/account/mfa/enrol/page.tsx
src/app/(product)/account/mfa/mfa-flow.tsx
src/app/(product)/account/page.tsx
src/app/(product)/platform/deployments/[id]/legacy-cancel.tsx
src/app/(product)/platform/deployments/[id]/page.tsx
src/app/(product)/platform/layout.tsx
src/app/(product)/platform/settings/mfa-controls.tsx
src/app/(product)/platform/settings/page.tsx
src/app/api/auth/mfa/verify/route.ts
src/app/api/workspace/mfa/route.ts
src/lib/auth/mfa-navigation.ts
src/lib/auth/mfa-policy.ts
src/lib/auth/mfa-routes.ts
src/lib/auth/mfa.ts
src/lib/ops/operator.ts
src/lib/platform/operator-journey.ts
src/lib/server/request.ts
src/lib/waitlist/http.ts
tests/auth/mfa-browser.test.ts
tests/auth/mfa-operators.test.ts
tests/auth/mfa-routes.test.ts
tests/auth/mfa.test.ts
tests/screens/mfa.test.tsx
```

Admin PUT body example (same-origin browser, selected workspace, current AAL2; no credentials):

```json
{"workspaceId":"ws-example","requireForAllMutations":true,"maxAgeSeconds":300,"expectedVersion":0}
```

`maxAgeSeconds` accepts null (the current AAL2 session) or integer seconds 60..86400. No row means immutable defaults at version 0, without a write. GET returns the version; PUT requires every field, refuses unknown/weakening fields and returns 409 for a stale version or changed workspace selection. The old host map is ignored. Product actions use the resolved cookie workspace, not a caller-supplied foreign workspace header. Platform routes keep their named workspace/role checks. MFA grants no membership or execution authority; existing independent-human, digest, quota, approval, authority, custody and effect checks still run.

### Privileged route coverage at this base

All mutations in the following groups are protected; GET/HEAD/OPTIONS remain ordinary reads except the GitHub callback (it binds trust on GET):

- Operation approve/reject/cancel, portability start, mixed-run cancel/teardown; mixed plans create/adopt children/start.
- Connections create (generic and AWS UI action), rotate, promote/abort rotation, verify/revoke.
- Runbooks publish, request run/schedule, run/schedule approve, cancellation and schedule state.
- Workspace policy, environment autonomy/spend, backend restore review/approve/reject/execute/probe, teardown review.
- Standing grants and mixed-output preauthorizations create/revoke; migration approvals; effect resolution.
- GitHub binding/unbind/callback; runner/machine registration-token issuance and revocation; coding-agent run/create/adopt/cancel/resume.
- Integrations agent review/grants/link approve/revoke; plugin registration/trust review/revoke/token issue/revoke.
- Workspace members/invites/ownership management; hosted app lifecycle/access management; account deletion.
- Raw `/api/admin/ops/maintenance` PUT, `/api/admin/ops/quotas` PUT/DELETE and waitlist preview/admit POST through their operator helpers.
- `/api/actions/:actionId` execution: admin or high-risk mutations, connection/secret/service-operation/deployment changes and legacy cancellation. Human approval/trust/admin actions never accept machine transport. Existing verified integration/Navigator execution seams retain deterministic credential/scope/policy authority; merely adding Authorization to an AAL1 browser request cannot bypass MFA.

### Wave 5 integration joins (read-only inspection, not reimplemented)

| Owner / routes | Join |
| --- | --- |
| MAN-02/03: POST `/api/platform/v1/environments/:id/domains`, `/domains/verify`, `/domains/revoke` | Add as human routes in the inventory when merging. Their existing assertBrowserSession guards stay in place. |
| MAN-06: PUT `/api/admin/billing/assignment`, POST `/api/admin/billing/invoices`, POST `/api/admin/billing/suspension` | Already call requireOpsOperator(request, true), so inherit the updated helper on integration. Require AAL1 refusal/no mutation and AAL2 success fixtures. Billing webhook/internal tick remains authenticated machine authority. |
| OPS-04: POST `/api/platform/v1/recovery/items/:id/decide` | Add human decision route to inventory. Preserve recovery plan/effect and independent-review bindings. |
| OPS-07: POST/DELETE `/api/admin/ops/retention/holds`, POST `/retention/preview`, POST `/retention/archives/:id/verify` and `/restore` | Already use mutating operator helper and inherit it. Future deletion/apply/admission endpoints must call requireStepUp after verified operator identity, before any decision/write. MFA grants no retention-policy approval. |
| OPS-07: `/api/workspace/retention-destination` future mutating export/destination controls | Inspect its exported methods at merge; protect every human mutation through admin metadata or explicit inventory. |
| OPS-09: POST `/api/platform/v1/audit/exports` | Add human inventory entry; keep signature/export authorization. No production signing-key approval is inferred. |
| OPS-01/REL-03 and other new sign-off, retention or release-key/rollout controls | Guard all human decision mutations through requireStepUp; if wrapped with workspaceRole: admin they inherit the generic hook. Raw routes need the explicit helper. Existing SLO GET is read-only; measurement ingest remains deterministic machine authority. |
| MAN-01/04/05 and OPS-08 | No new privileged HTTP mutation paths were found in their available worktree snapshots. Reinventory the final assembled routes; internal workflows/brokers are not replaced by MFA. |

The Wave 5 directories on this machine are snapshots without usable `.git` metadata, so their API files were inventoried directly. Final assembled-route and authority checks remain the integrator's responsibility.

### Exact Mac browser verification commands and prerequisites

Not run here: needs actual local Supabase Auth (TOTP enabled), the prepared Zenith API/platform store, two disposable admitted workspace admins, and installed Chrome. No Docker, PostgreSQL, Temporal, kind or browser service was started on Windows. No live cloud is needed or allowed by this gate.

**Startup join:** the follow-up enables BOTH TOTP enrollment and verification in `supabase/config.toml` and retains `[auth.mfa] max_enrolled_factors = 10`. J1/verifier must preserve this exact block in the prepared default stack and provision two confirmed users. Separate GoTrue containers require the explicit Auth environment settings in [MFA operator setup](../../../platform/operations/MFA.md); changing Next.js environment alone cannot enable Auth MFA. There is no fallback when Auth MFA is disabled. The assembled platform schema must include migration 56 after the sibling 44-56 join.

Use the J1 prepared configuration/private-CA pooler and fixture workspace database. For a lean 8 GiB Mac / 4 GiB Docker MFA lane, run only Auth, API gateway, PostgREST, PostgreSQL/pooler and one native Zenith API, then one headless browser/one test worker. No Temporal worker, kind, build worker, telemetry stack or cloud emulator is needed for this MFA-only test. Stop other heavy lanes first; do not ignore health checks. Keep the existing verifier disk floor. This lean lane does not replace the full default-stack or J2 operation journey.

```sh
# Shell must use the verifier's pinned Node 22 (check before starting).
node --version
# ZENITH_MFA_STACK_DIR is J1's owned, prepared disposable Supabase directory.
# Its copied config has TOTP enroll/verify enabled; retain J1's TLS pooler.
npx supabase start --workdir "$ZENITH_MFA_STACK_DIR" \
  --exclude studio,imgproxy,edge-runtime,logflare,vector,realtime,storage-api

# In a separate shell load J1's private prepared .env.local, including real
# local Auth public URL/key and platform DB/TLS configuration. Never print it.
export ZENITH_PLATFORM_ORIGIN='http://127.0.0.1:3400'
NODE_OPTIONS='--max-old-space-size=1536' npx next dev -p 3400

# Private fixture file, created by J1/J2's disposable-user setup, chmod 600.
# Shape: {origin,identities:[{email,password,workspaceId},{email,password,workspaceId}]}.
# Use two distinct confirmed/admitted admins, initially without verified TOTP.
# Values are runtime-generated local fixture credentials, never committed.
export ZENITH_MFA_BROWSER=1
export ZENITH_MFA_BROWSER_FIXTURES_FILE="$ZENITH_MFA_FIXTURE_FILE"
export ZENITH_MFA_BROWSER_EXECUTABLE='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
npx vitest run tests/auth/mfa-browser.test.ts --no-file-parallelism --maxWorkers=2
```

Expected opted-in result: **2 passed / 0 failed / 0 skipped**. Both identities enroll through the real UI/provider, confirm AAL2 on the real server, start a fresh AAL1 password session, fail a wrong code and complete step-up. AAL1 approval probes fail 403; after step-up deliberately malformed approval requests reach existing validation (400) without changing an operation. Real keyboard Enter and axe WCAG 2/2.1 AA checks run at 1280 and 375 px on enrollment, success and challenge states. Browser DOM containing QR/key is never included in receipts. Assertions never intercept Auth or API traffic. Missing opted-in prerequisites fail, rather than becoming skips. Without ZENITH_MFA_BROWSER=1 the two cases explicitly skip and count as **not run**, never passed.

Cleanup: close browser (suite finally/afterAll), stop only the API process started for this lane, then run `npx supabase stop --workdir "$ZENITH_MFA_STACK_DIR"` for the positively owned disposable stack. Delete the two disposable users/factors/private fixture file through J1/J2 cleanup. The suite intentionally never deletes identities, workspaces or unrelated Auth factors.

Manual NVDA acceptance (Windows, not run by this job): after owner-approved startup is available here, walk enrollment/challenge and legacy-cancel confirmation with Tab/Shift-Tab/Enter; record label announcements, alert and success focus, QR manual alternative and role-denial explanation. Mac axe is not an NVDA result. The broader platform-page contrast/a11y/default two-operator journey remains with the existing UX-01/J2 verifier.

Primary references: [Supabase TOTP enrollment/challenge](https://supabase.com/docs/guides/auth/auth-mfa/totp), [MFA overview/AAL](https://supabase.com/docs/guides/auth/auth-mfa), [CLI start/excluded services](https://supabase.com/docs/reference/cli/supabase-start).

### Original Windows execution record (committed by orchestrator as e40837ce)

Every shell prepended `C:\Users\user\.local\sdk\node22` to PATH; `node --version` returned `v22.23.3`. No npm install/ci, Go command, whole-suite run, Docker, actual PG/Temporal/kind, cloud request, commit or history operation.

| Exact check command | Passed / failed / skipped |
| --- | --- |
| `npx vitest run tests/auth/mfa.test.ts tests/auth/mfa-routes.test.ts tests/screens/mfa.test.tsx --no-file-parallelism --maxWorkers=2` | 155 / 1 / 0; the new missing-AAL fixture helper accidentally defaulted explicit undefined to AAL2. Fixture construction fixed; assertion retained. |
| `npx vitest run tests/auth/mfa.test.ts tests/auth/mfa-routes.test.ts tests/screens/mfa.test.tsx tests/auth/mfa-browser.test.ts --no-file-parallelism --maxWorkers=2` | 160 / 0 / 2; browser gated, not run. |
| `npx vitest run tests/platform-ui/operator-journey.test.ts tests/platform-ui/operator-pages.test.tsx tests/auth/workspace-sharing.test.ts tests/screens/account-page.test.tsx --no-file-parallelism --maxWorkers=2` | 93 / 1 / 0; existing legacy-cancel-unavailable assertion is stale against the assigned requirement (see below). |
| `npx vitest run tests/auth/mfa.test.ts tests/auth/mfa-routes.test.ts tests/auth/mfa-operators.test.ts tests/screens/mfa.test.tsx tests/auth/mfa-browser.test.ts --no-file-parallelism --maxWorkers=2` | 143 passed / 0 assertion failures / 2 gated skips, plus 1 unhandled worker-start error; DOM worker timed out before its 25 tests could run. Exit 1, NOT a pass. |
| `npx vitest run tests/auth/mfa.test.ts tests/auth/mfa-routes.test.ts tests/auth/mfa-operators.test.ts tests/auth/mfa-browser.test.ts --no-file-parallelism --maxWorkers=2` | Final Node successor: 146 / 0 / 2, exit 0. Includes static coverage of every existing explicit browser-only platform mutation. |
| `npx vitest run tests/screens/mfa.test.tsx --no-file-parallelism --maxWorkers=2` | Final DOM successor: 25 / 0 / 0, exit 0. |
| `npx vitest run tests/auth/mfa.test.ts tests/auth/mfa-operators.test.ts --no-file-parallelism --maxWorkers=2` | After explicit parameterized header-fixture typing: 63 / 0 / 0, exit 0. Same assertions and cases retained. |
| `$files = @(git diff --name-only -- '*.ts' '*.tsx'); $files += @(git ls-files --others --exclude-standard -- '*.ts' '*.tsx'); npx eslint @files` | Executed twice (before and after final fixes): both exit 0, 24 files, 0 errors / 0 warnings. |
| `npx eslint tests/auth/mfa.test.ts tests/auth/mfa-operators.test.ts` | Recheck after fixture typing: exit 0, 2 files, 0 errors / 0 warnings. |
| `$env:NODE_OPTIONS = '--max-old-space-size=4096'; npx tsc --noEmit -p .` | Attempt 1 stopped via Ctrl+C, exit 1 without a compiler verdict during prolonged shared-machine contention. Attempt 2 exit 1, exactly 2 TS2345 diagnostics in new parameterized header fixtures. Explicit Record fixture types added, no assertions changed. Attempt 3 exit 0, 0 diagnostics. |
| `git diff --check` | exit 0; no whitespace findings at that checkpoint. |
| `node --version`; `npx --no-install tsc --version` | exit 0: Node 22.23.3, TypeScript 5.9.3. |
| `node -e 'const fs = require("fs"); const ledger = JSON.parse(fs.readFileSync("docs/build/production/ledger.json", "utf8")); const row = ledger.requirements.find(r => r.id === "PROD-UX-01"); if (row.implementationStatus !== "implementation_complete_verification_pending" || row.state !== "in_progress" || !row.implementationNote) process.exit(1); console.log("UX-01 ledger status/note: pass");'` | exit 0, 1 metadata check passed / 0 failed / 0 skipped. |

Counts overlap and must not be summed as unique acceptance. SDK/provider and execution doubles are contract evidence, not operated Supabase or engine proof.

Original-commit focused evidence: **171 passed / 0 failed / 2 gated browser skips** across the Node and DOM runs, with the affected 63 Node cases repeated successfully after the typing fix. Original typecheck and lint passed. The separate original regression run had one stale assertion, corrected in the authorized follow-up below. These historical counts do not describe the follow-up source. Operated acceptance remains pending.

Read-only inspection used `git status --short`, `git log --oneline -10`, `git diff --stat`, `git diff --name-only`, `git ls-files --others --exclude-standard`, `rg`/`rg --files`, PowerShell Get-Content/Get-ChildItem/Get-Item/Select-Object/Measure-Object and Get-Process. Missing guessed files/globs during discovery produced diagnostic errors and were corrected by file inventory; no mutation resulted. An optional Get-Item probe for root tsconfig.tsbuildinfo found no file (exit 1); no build artifact was removed or modified. Attempts to diff nine Wave 5 snapshot directories with `git -C <snapshot> diff --name-only c02c097e HEAD -- src/app/api` failed as not Git worktrees; direct read-only API inventory replaced them. Get-CimInstance Win32_Process was denied by the sandbox; no permissions escalation or peer process termination was attempted. Only this job's first typecheck session was stopped with Ctrl+C, as recorded above. SDK/CLI primary documentation was read through web search/open/find; no application or provider request was made by that lookup.

### Remaining integration work, stale assertion and scope decisions

- `tests/platform-ui/operator-journey.test.ts` now expects legacy cancellation because UX-01 requires it and the existing guarded `deploy.cancel` action honors it; stage/order assertions remain unchanged.
- The newly authored J3 screen test initially expected POST for server confirmation; it now expects GET because confirmation has no side effects and must remain available during read-only maintenance. The same AAL2 guard protects both methods. A new route/maintenance contract assertion checks this explicitly. This is a change to J3's own draft test, not a pre-existing assertion/gate change.
- Older route tests outside tests/auth/tests/screens that fake only sessionUser/verifyRequestIdentity must also provide explicit signed AAL2 claims (finite unexpired exp), matching confirmed live user and a verified TOTP factor. Keep all their denial, policy, digest, tenant and effect assertions. Do not mock requireStepUp or bypass it to go green. Their assembled successor is pending, not claimed passed here.
- The middleware/boot/admission order is preserved. Step-up runs before the route handler, after existing admission and request/membership resolution; it does not defer quota or DUR execution checks.
- The review replaced the initial host-managed controls with real per-workspace state using assigned migration 56, API/UI edits and transactional audit events. No host-map override/import remains. Seven old host-parser cases now assert that those obsolete values cannot override persisted enforcement; invalid persisted controls are refused by new repository/API assertions. The prior environment-parser expectation is stale because that configuration is no longer authoritative.
- Operated MFA, axe, browser keyboard, contrast, manual NVDA and engine/provider cancellation remain not run (need the Mac/local default stack or owner-approved Windows screen-reader environment). Supabase TOTP must be enabled by the stack owner. Supabase-level factor recovery/removal stays with the identity provider; this UI only cancels its current unverified enrollment.
- Ledger row remains `implementation_complete_verification_pending`, state `in_progress`; historical evidence remains unchanged. The orchestrator must regenerate aggregate docs and add the five test files to the unit/browser gate inventory without weakening required identities. No release flag or verification state was promoted.

Suggested commit: `feat(auth): require operator MFA for privileged actions`

### Orchestrator review follow-up (based on e40837ce)

This follow-up completes the three requested build joins: persisted controls, authorized legacy assertion/audit coverage, and exact local/default/production TOTP setup. `tests/auth/mfa-workspace-state.test.ts` uses actual PGlite SQL and the actual API/guard with mocked Auth; its separate PostgreSQL lane requires `ZENITH_MFA_PG=1`. Settings changes and the precise before/after/actor audit commit together, including rollback when an actual audit constraint refuses the insert. The positive and negative controls cover concurrency, version conflicts, foreign workspace isolation, malformed/weakening bodies, role denial, old MFA timestamps and store outages. `tests/auth/mfa-legacy-cancel.test.ts` exercises the actual route, action and file-store audit with an explicit engine double, including AAL1 denial, successful cancel, viewer denial and foreign/unknown targets. This is not operated engine proof.

`tests/screens/mfa.test.tsx` covers labeled fields, keyboard form submission, current-version writes, viewer/editor read-only behavior, focused step-up refusal and duplicate-submit exclusion. The real gated Playwright test now also refuses AAL1 controls PUT, saves controls through the actual settings form with Enter, reads persisted state and runs axe on the settings page. No Auth/API interception is used by that gate.

Additional Mac PostgreSQL lane (not run on this machine): start the J1 local PostgreSQL/private-CA pooler and prepare an **isolated disposable** database through J1's owned setup. This test temporarily adds an audit-refusal constraint inside a transaction, so do not use a shared install database. Load its private URL into the environment without printing it, then run:

```sh
export ZENITH_MFA_PG=1
# ZENITH_TEST_PLATFORM_PG_URL is supplied by J1's private disposable DB setup.
npx vitest run tests/auth/mfa-workspace-state.test.ts --no-file-parallelism --maxWorkers=2
```

Expected opted-in result: **46 passed / 0 failed / 0 skipped** (24 PGlite/static checks plus 22 PostgreSQL cases). With the PostgreSQL gate off: **24 PGlite/static cases + 22 explicitly not-run PostgreSQL skips**. Missing URL with the gate enabled fails immediately. Use the browser commands above after all assigned migrations are assembled/applied; expected browser result remains **2 passed / 0 failed / 0 skipped**, now including persisted settings and their a11y. Manual NVDA, real engine cancellation, full assembled tenancy/default-stack acceptance and live clouds remain not run; live cloud acceptance is deferred.

No commit, dependency installation, aggregate generation or production action was performed by this agent. The orchestrator committed the first slice as e40837ce; this follow-up is left in the working tree.

Follow-up files (25: 20 modified, 5 added):

```text
docs/build/production/ledger.json
docs/build/production/verify/PROD-UX-01.md
docs/platform/operations/MFA.md (new)
docs/platform/operations/README.md
src/app/(product)/platform/settings/mfa-controls.tsx
src/app/(product)/platform/settings/page.tsx
src/app/api/workspace/mfa/route.ts
src/lib/auth/mfa-policy.ts
src/lib/auth/mfa-routes.ts
src/lib/auth/mfa.ts
src/lib/controlplane/db/migrations/0056_workspace_mfa_controls.ts (new)
src/lib/controlplane/db/migrations/index.ts
src/lib/controlplane/db/repos/index.ts
src/lib/controlplane/db/repos/workspace-mfa-controls.ts (new)
src/lib/controlplane/types.ts
src/lib/sensitivedata/inventory.ts
supabase/config.toml
tests/auth/mfa-browser.test.ts
tests/auth/mfa-legacy-cancel.test.ts (new)
tests/auth/mfa-routes.test.ts
tests/auth/mfa-workspace-state.test.ts (new)
tests/auth/mfa.test.ts
tests/controlplane/tenancy.test.ts
tests/platform-ui/operator-journey.test.ts
tests/screens/mfa.test.tsx
```

Follow-up Windows commands (each PowerShell shell prepended `C:\Users\user\.local\sdk\node22` to PATH):

| Exact check command | Passed / failed / skipped |
| --- | --- |
| `npx vitest run tests/auth/mfa-workspace-state.test.ts tests/auth/mfa-legacy-cancel.test.ts tests/auth/mfa.test.ts tests/auth/mfa-routes.test.ts tests/auth/mfa-operators.test.ts --no-file-parallelism --maxWorkers=2` | First attempt: 176 / 3 / 22, exit 1. One 20-second timeout and two expiry/outage assertions exposed the split mocked barrel/actual singleton store seam. The loader now imports the database-opening seam directly and fixtures mock that one seam. All assertions and timeouts retained. |
| `npx vitest run tests/screens/mfa.test.tsx tests/platform-ui/operator-journey.test.ts --no-file-parallelism --maxWorkers=2` | 25 projection tests passed / 0 assertion failures / 0 skips, plus 1 unhandled DOM worker-start timeout, exit 1. The DOM file never started, so this was not a successful combined run. |
| `npx vitest run tests/auth/mfa-workspace-state.test.ts --no-file-parallelism --maxWorkers=2` | Successor: 24 / 0 / 22, exit 0; all PostgreSQL cases explicitly not run. |
| `npx vitest run tests/screens/mfa.test.tsx --no-file-parallelism --maxWorkers=2` | Successor: 30 / 0 / 0, exit 0. |
| `npx vitest run tests/platform-ui/operator-journey.test.ts --no-file-parallelism --maxWorkers=2` | Isolated successor for the earlier combined worker failure: 25 / 0 / 0, exit 0; all unchanged stage/order assertions and the authorized legacy-cancel expectations pass. |
| `npx vitest run tests/auth/mfa.test.ts tests/auth/mfa-routes.test.ts tests/auth/mfa-operators.test.ts tests/auth/mfa-legacy-cancel.test.ts tests/auth/mfa-browser.test.ts --no-file-parallelism --maxWorkers=2` | Final guard/cancel: 155 / 0 / 2, exit 0; actual browser cases not run. |
| `$mfaChanged = @(git diff --name-only -- '*.ts' '*.tsx'); $mfaChanged += @(git ls-files --others --exclude-standard -- '*.ts' '*.tsx'); npx eslint @mfaChanged` | Executed twice, including after store-seam fixes: both exit 0, 20 files each, 0 errors / 0 warnings. |
| `npx vitest run tests/security/sensitive-inventory.test.ts --no-file-parallelism --maxWorkers=2` | 12 / 1 / 0, exit 1. The existing source-tree scan for the sole sealed idempotency caller timed out at its unchanged 20-second limit; table/column completeness and all other inventory checks passed. |
| `npx vitest run tests/security/sensitive-inventory.test.ts -t 'idempotency.complete has exactly one production caller, and it seals' --no-file-parallelism --maxWorkers=2` | Isolated successor: 1 / 0 / 12, exit 0; 12 cases not selected, not acceptance passes. The timed-out assertion and timeout were unchanged; the scan completed in 1.12 seconds. |
| `npx vitest run tests/controlplane/tenancy.test.ts -t 'completeness guard' --no-file-parallelism --maxWorkers=2` | 3 / 0 / 3, exit 0; 3 broader cases not selected. Both new repository functions are classified; actual workspace read/write isolation is exercised in the new PGlite/API suite. |
| `& 'C:\Program Files\Git\bin\bash.exe' 'Z:/Projects/Spawned.ai/zenith-wt/.resume/codex/tsc-serial.sh'` | Executed twice. Attempt 1: exit 1, 31 diagnostics. Required Principal names, complete legacy fixture fields and explicit route contexts were corrected without removing assertions. Attempt 2: exit 1, exactly 1 TS2741 diagnostic at `src/components/platform/event-sentences.ts:45`, because the new audit type needs an outside-owned exhaustive-map entry. 0 successful typechecks / 2 failed / 0 skipped; all 30 owned diagnostics resolved. Script uses Node 22, the shared temporary lock and an 8 GiB heap. No typecheck pass is claimed. |
| `npx eslint src/app/api/workspace/mfa/route.ts src/lib/controlplane/db/repos/workspace-mfa-controls.ts tests/auth/mfa-legacy-cancel.test.ts tests/auth/mfa-workspace-state.test.ts` | After compiler fixes: exit 0, 4 files, 0 errors / 0 warnings. |
| `npx vitest run tests/auth/mfa-workspace-state.test.ts tests/auth/mfa-legacy-cancel.test.ts --no-file-parallelism --maxWorkers=2` | After compiler fixes: 30 / 0 / 22, exit 0; actor-name audit coverage is strengthened, and all earlier guard/role/tenancy/effect assertions remain unchanged. PostgreSQL cases remain not run. |
| `node -e 'const fs = require("fs"); const ledger = JSON.parse(fs.readFileSync("docs/build/production/ledger.json", "utf8")); const row = ledger.requirements.find(r => r.id === "PROD-UX-01"); if (row.implementationStatus !== "implementation_complete_verification_pending" || row.state !== "in_progress" || !row.implementationNote) process.exit(1); console.log("UX-01 ledger status/note: pass");'` | Executed twice: each exit 0, 1 metadata check passed / 0 failed / 0 skipped; no verification status promoted. |
| `git diff --check` | exit 0, 0 whitespace findings at the recorded checkpoints. |

Counts overlap; do not sum attempts. Current focused feature evidence: **234 passed / 0 failed / 24 gated skips** (155 guard/cancel, 24 persistence/API, 30 DOM and 25 legacy projection). The complete inventory's 13 assertions passed across the first 12 successful cases and the isolated successor for the timed-out case; the initial whole-file failure is preserved. The 15 filtered skips in inventory/completeness selections are unselected cases, not gated acceptance passes. No legacy cancellation assertion was removed: available now equals true, reason equals undefined, and stage/step-order assertions remain exact.

The new audit vocabulary also needs a shared UI join in `src/components/platform/event-sentences.ts`: its exhaustive `Record<PlatformEventType, Rule>` must describe `workspace.mfa_controls_changed`. That file is outside the original owned list. The proposed entry below is reviewable but remains **unapplied** for the orchestrator under the original ownership restriction. A scope clarification was requested and no response was received before this handoff. Neither the event type nor the exhaustive map was weakened to hide this compiler failure:

```ts
"workspace.mfa_controls_changed": { sentence: (w) => `${w} changed workspace MFA controls.`, tone: "idle" },
```

Deviation from the reviewed handoff: none. The initial host-managed scope choice is superseded by the explicit review. Remaining assembler work: add the shared event sentence entry above and rerun serialized typecheck, insert the actual owned migrations 44-56 ahead of 57, regenerate the aggregate through the existing owner process, add the new test files to the gate inventory and retain the pending verification status. Operated Auth/browser/axe/NVDA/cancellation and real PostgreSQL require the stated external verifier environment.

Resource note for the 8 GiB Mac: stop the Next.js process and browser before running the SQL/PG-only lane (its Auth SDK is mocked); run the browser lane separately with the lean Auth stack above. Run inventory checks with `npx vitest run tests/security/sensitive-inventory.test.ts --no-file-parallelism --maxWorkers=2`; expected 13 passed / 0 failed / 0 skipped.

For the full assembled tenancy file, retain the owned disposable PostgreSQL URL from the SQL lane and all canonical broker/native-authority fixtures. Run this separate lane after the migration and fixture owners have assembled their joins:

```sh
export ZENITH_TEST_WORKFLOW_START_REQUIRED=1
export ZENITH_TEST_APPROVED_SOURCE_REQUIRED=1
# ZENITH_TEST_PLATFORM_PG_URL remains supplied by the owned disposable DB setup.
npx vitest run tests/controlplane/tenancy.test.ts --no-file-parallelism --maxWorkers=2
```

Expected assembled result: **7 passed / 0 failed / 0 skipped** (three classification checks, the PGlite and PostgreSQL sweeps, and two PostgreSQL native-authority sweeps). This full assembled lane was not run here; only its three classification checks and the new MFA-specific PGlite isolation contracts were run. The required flags refuse a missing PostgreSQL URL, and no canonical broker or native-authority assertion may be replaced to achieve this result.

Suggested follow-up commit: `feat(auth): persist workspace MFA controls and enable TOTP`


## Wave 6 final integration

Status remains `implementation_complete_verification_pending`. Node 22 only. Execute sequentially with Docker Desktop 4 GiB and one kind node; stop each heavy profile before starting another. Live acceptance stays deferred until separate owner approval.

```bash
node scripts/ci/wave6-gates.mjs --requirement PROD-UX-01 --print > /tmp/zenith-wave6-PROD-UX-01.commands.json
```

This prints the exact argv for each contract batch and required engine case, its gate names, private prerequisites, and its strict report-validation command. Set only the gates for the selected lane after preparing its owned fixture; a skip cannot satisfy that lane. Run each `argv` sequentially and then its `verify` argv. [Final integration setup and results](FINAL-INTEGRATION.md), [canonical inventory](../../../../scripts/ci/wave6-gates.json), [owner live runbook](../LIVE-ACCEPTANCE.md).


## Wave 6 UX receipt mapping

Wave 6 maps `tests/e2e/default/ux-receipt.test.ts` and `tests/e2e/default/ux-receipt-gated.test.ts` to `PROD-UX-01`; the actual-browser receipt gate is `wave6-03be46338cbeb148`. The contract test checks the closed receipt schema. The gated test validates the private UX receipt against the completed, source-bound J2 journey receipt and actual Wave 6 report.

This evidence records seven audited screens at the defined desktop and mobile viewports. The planned uncertainty scenario remains `not_run`, so the UX receipt result is `incomplete`; this mapping does not establish full UX acceptance.

## Hosted acceptance, 2026-10-23 (supersedes "pending" statements above)
- The UX cases run on GitHub-hosted native linux/amd64 and linux/arm64 through `clean-host-journey.yml`
  (`workflow_dispatch` input `ux`). `scripts/acceptance/ux01-window.mjs` writes the exclusive window from the
  owned installation's own state. The browser is real Google Chrome where the runner has it (amd64) and
  Playwright's Chromium on arm64 (Google publishes no Linux ARM64 Chrome); receipt schema 3 records the
  measured brand and version instead of a fixed label.
- Schema 3 adds two groups, connection onboarding (`connection-change-review`, the runner-connection review
  page before the human confirms) and connection administration (`connection-admin`), and a keyboard-only
  check on every audited page: Tab alone must reach every visible, enabled control (`keyboard` on each
  desktop scan). Manual screen-reader passes remain outside the automated evidence.
- MFA: `tests/e2e/default/mfa-fixtures.mjs` creates two fresh admins through the real UI on the same stack;
  the two registered browser cases (AAL1 refusal, real TOTP enrollment, workspace control save, later
  step-up) run in the same hosted job. Workspace MFA persistence runs on PostgreSQL.
- `scripts/ci/ux01-receipt.mjs` runs the local lanes (contract batches, receipt gate per architecture, MFA
  PostgreSQL) on the same commit.
- Registry: `oauth-issuer-live.test.ts` belongs to PROD-UX-02 (client OAuth issuer and audience) and
  `plugin-platform-live.test.ts` to PROD-UX-03's operated level; neither is in UX-01's acceptance text, so
  both were removed from UX-01's inventory (each remains registered under its owner).
- Scope qualifiers (independent review, 2026-10-23): "connection onboarding" here is the runner-connection review
  page; the AWS connect page is not audited. Keyboard evidence is Tab reachability on desktop only (no
  Enter/Space activation, focus-visible or mobile keyboard check); no screen-reader pass. Plugin trust actions
  are step-up-protected privileged routes, so the operated plugin platform case (`wave6-546689f4b22fdb85`,
  real browser AAL2 consent) is part of UX-01 step-up evidence and runs on the Mac (its gateway reaches the
  API through Docker Desktop's host mapping, which Linux runners do not provide).

## Operated plugin-platform step-up case, 2026-10-23

`wave6-546689f4b22fdb85` passed on the Mac against a real J1 lean stack built from `3da7177f` (source binding
`dirty: false`). Receipt: `evidence/PROD-UX-01/2026-10-23-plugin-platform-3da7177f/receipt.json`.

- Stack: `up.mjs --plugin-platform <file>` serves the API at `https://host.docker.internal:37443` through a
  pass-through TLS edge (`scripts/acceptance/default-stack/api-edge.mjs`) signed by the stack CA. The Host header is
  unchanged, so the API's configured-origin check still decides. Trusted publishers reach the API env file only.
- Product fix found on the way: self-hosted installations rejected `ZENITH_PLUGIN_TRUSTED_PUBLISHERS` as an unknown
  field, so no plugin could be trusted there. It is now accepted as public Ed25519 verify keys only.
- Runner: `scripts/ci/ux01-plugin-platform.mjs`. One Mailpit-confirmed operator signs in through the browser,
  creates a workspace, enrols TOTP (AAL2), creates a project, links a parent credential through the browser
  consent route, and the browser cookie drives registration, review and launch-token issue. The signed fixture
  plugin's artifact is served over HTTPS from the stack's CA-signed certificate; the launcher verifies its digest.
- Host resolution: the Mac does not resolve `host.docker.internal`. A test-process preload
  (`scripts/acceptance/loopback-docker-host.mjs`) maps only that name to loopback, as an `/etc/hosts` line would;
  TLS is still verified against the name. Chromium uses `--host-resolver-rules` and SPKI pins for the two stack
  edge certificates (no verification disabled).
- Outcome: sandbox started, MCP discovery returned exactly the one approved read tool, token revocation (RFC
  route) and registration revocation (browser route) each stopped the sandbox, then the launch check and MCP
  answered 401. Cleanup: no plugin containers, private dir removed, operator deleted, stack torn down (0 owned
  resources left).
- Execution worker and Temporal were stopped for memory; the case does not use them.
- Debug runs before the evidence run (not evidence): artifact fetch refused while the runner blocked on the case
  (fixed: async spawn), and `/api/bootstrap` 404 before workspace creation (fixed: mfa-fixtures order).

## Accessibility scope after the 2026-10-23 review (schema 4), evidence on 8b9a4fb0

The independent review held promotion because the receipts audited less than the acceptance's "accessibility". The
scope was not narrowed; the audit was widened:
- Every audited page, at 1280 px and 375 px: axe WCAG 2.0/2.1 A and AA, no horizontal overflow, and keyboard
  operability: Tab reaches every control present on the page (controls rendered while scanning are required too; the
  scan keeps tabbing until all are reached), every reached control shows a visible focus indicator (a change in
  outline, box-shadow or border colour on the control or its three nearest ancestors between focused and unfocused,
  WCAG 2.4.7), and no control is a non-native element with a widget role (so Enter/Space activation is the browser's).
- New page: AWS onboarding (`/platform/connections/aws`), case `ux01-aws-onboarding-a11y`.
- The legacy-engine cancellation control renders only for legacy (non-workflow) deployments, which J2 does not create.
  Its states (offered, confirming, unconfirmed outcome, success, disabled for viewers) get axe A/AA in the component
  lane (`tests/screens/legacy-cancel-axe.test.tsx`); colour contrast needs layout and is reported as not evaluated.
- Not covered by automation: a real screen-reader pass (VoiceOver/NVDA), which stays a supervised human step.

Evidence, all on 8b9a4fb0: hosted run 39968933457 (`2026-10-23-hosted-39968933457/`, both UX receipts and the J2/MFA
verdict lines), `2026-10-23-local-lanes-8b9a4fb0/` (contract batches, receipt gate, MFA PostgreSQL),
`2026-10-23-plugin-lanes-8b9a4fb0/`, `2026-10-23-plugin-platform-8b9a4fb0/`. Superseded runs on 4eea3026 and 7c4e2ccf are
kept beside them. The "uses verification disabled" wording in the plugin-platform addendum is corrected: Chromium uses
`--ignore-certificate-errors-spki-list` pinned to the two stack edge certificates (pinning, which also bypasses
hostname and chain checks for those exact keys); Node verifies normally against the stack CA.
