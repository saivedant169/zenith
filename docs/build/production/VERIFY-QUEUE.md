## Current verification — 19 October 2026

Exact source `a17f60a61aecf11cd076289fb2b87f7f5d3a8385` completed all three GitHub Actions workflows: 32 jobs total, 24 success, 8 configured conditional skips, and 0 failures. Main run 39239179351, native packaged-worker run 39239179399, and native platform run 39239179238 all passed. The two packaged-worker architectures each passed 22/22 with all six cleanup fields true; both native platform leaves passed 1/1. The platform-PostgreSQL artifact recorded 4,142 passed / 15 skipped / 0 failed, with all 1,160 required identities passing. The sanitized verify footer did not expose an allowlisted test-count summary, so no full-unit aggregate is claimed. This is a docs/evidence source and does not validate or explain the frozen E3 runtime. [Exact-source CI evidence](evidence/PROD-CI-08/2026-10-19-a17f60a6-coherent-ci.json)

A separate focused transport candidate passed its six-test/two-file run and four-file lint; the three wire cases are contained within the six-test result and are not added to the separate overlapping fixture report. This checkpoint integrates the reviewed normal-root autocommit dispatch hook and leaves transaction/savepoint behavior unchanged. The wire regression requires the locked Postgres.js 3.4.7 version; this is a test guard, not a runtime version check. These checks are focused only; the candidate is not yet covered by exact-source successor CI, and no real pooler cause or canonical J4 acceptance is established. [Focused transport evidence](evidence/PROD-OBS-04/2026-10-19-j4-transport-focused.json)

Offline review decoded a read-only copy of the preserved Temporal history (71 nodes, 143 events) and observed a 100.003-second Start-to-Close timeout with retry state `MAXIMUM_ATTEMPTS_REACHED`. This is a positive event observation; authoritative transaction selection, SQL origin, and root cause remain unproven. A bounded read-only pooler-log capture found four closed SSL handshakes paired with client-join mismatch warnings, plus one idle transaction-handler termination after socket closure. It contained no SQLSTATE/protocol error, pipeline mention, or pooler version; it proves no cause. [Transport/forensics evidence](evidence/PROD-OBS-04/2026-10-19-j4-transport-focused.json)

The current-epoch J4 attempt ended with outer exit 2 and `cleanup_unconfirmed` after a maintenance deadline at lease exclusion. Original services were restored; root custody closeout recorded 749 commands closed, 921 PIDs and 750 process groups absent twice, and 3,346 sealed files. Ten owned containers remain stopped with data retained. The failure cause remains undiagnosed, and this focused candidate does not alter that result. [Failure and restoration receipt](evidence/PROD-OBS-04/2026-10-19-j4-lease-exclusion-failure.json). Current blockers are reconciliation of the read-only pooler baseline with the focused transport behavior, followed by a fresh coherent natural J4 run over the validated current-epoch graph, plus local browser/default-stack acceptance. The earlier memory-warning refusal is historical, not a current blocker. Ledger remains **11 verified / 65 in progress / 2 planned (14.1%)**; all four release flags remain false. No criteria or requirement states are promoted.

## Historical verification and J4 blockers — 19 October 2026 (C760)

C760 exact-source CI is terminal: main run39176394612 has19 successes, one `platform-postgres` timeout, and8 conditional skips; packaged-worker run39176394586 passed AMD64 and ARM64 at22/22 each with all six cleanup fields; platform run39176394570 passed2/2. The timeout was the 20-second lease-loss uncertainty test. A reviewed test-only wait-guard candidate is integrated in the working tree; focused PGlite passed19/19 and a synthetic AbortController diagnostic passed4/4. Those checks support fixture semantics only. Fresh publication CI and actual PostgreSQL validation remain pending, and the failure cause is not proven. The prior 04003377 all-workflow pass remains historical. [C760 evidence](evidence/PROD-CI-08/2026-10-19-c760-postflight-and-lease-wait.json).

The approved two-service interruption is complete and restored. Read-only postflight matched12 configuration/port checks, observed all nine dependencies recovered to baseline, DB/Gateway healthy and API at its baseline unhealthy state, closed38 commands, and confirmed51 PIDs/38 groups absent twice; host and VM observers joined with no postflight service mutation. Canonical J4 has not started. Current blockers are the device-epoch31→32 full admission and ToFu fixture, Astra's fresh explicit per-path bridge, and fresh J1/Temporal/API prerequisites; no new J4 stack was created. Before another J4 attempt, validate all current prerequisites and bind a fresh bounded interruption/restoration plan to the authorized local scope. Ledger remains11 verified /65 in progress /2 planned; all release flags false.

## Historical J4 census before the approved interruption — 19 October 2026

A fresh census identifies unrelated host services on ports 54321 (Kong) and 54322 (PostgreSQL), plus the owned API unhealthy on port 36400. Root/Astra completed offline review of 6,057 source files, 31 pins, 14 lease checks, and 15 orchestration checks; these are preparation checks, not an actual J4 run. A bounded interruption of exactly the two foreign services for 12,600 seconds is planned with safe restoration, but approval is pending. No service interruption or canonical J4 execution has started. Private helper evidence is not a product fix or acceptance result. Keep ledger at 11 verified / 65 in progress / 2 planned, all release flags false.


The Actions-disabled dispatch refusal is now historical: GitHub displayed its fork-usage notice, the user re-enabled Actions, and exact source `040033770399239e585d39356f7f3348b809abac` completed all three workflows (main20 success/8 conditional skips/0 failures; native package2/2 with 22/22 per architecture and all cleanup checks; platform2/2). The reconciliation successor passed39/39 without proving a cause for its earlier failure. Verify passed, but exact verify test counts are unavailable in sanitized artifacts. No requirement or milestone promotion follows. [Sanitized exact-SHA evidence](evidence/PROD-CI-08/2026-10-19-04003377-coherent-ci.json).
## 19 October 2026 reconciliation

Current ledger state is unchanged at **11 verified / 65 in progress / 2 planned**; all four release flags remain false and the 78 criteria are preserved. BG3 remains a failed `sampler-exit` diagnostic; clean individual samples, paused schedules, stable action counts, and clean worker close do not resolve the wrapper failure or prove worker-only query causality. The diagnostic wrapper exited 2; root custody closeout separately exited 0 and sealed 795 regular files plus one symlink. The approved one-use Docker restart used one restart command. The PostgreSQL investigation later resumed via Astra High; its 57/57 synthetic fixture-validator cases are not actual PostgreSQL tests. Four isolated PostgreSQL/TLS diagnostics ended before SQL; attempt 5 passed 20/20 sequential and 20/20 concurrent fixed mixed-query cases and the stdlib TLS checks. Independent review and root custody closeout passed (109 host PIDs and 108 process groups absent twice; four owned resources absent; guard empty). Thirteen fixture input files were then removed after identity/hash verification; OS trust was never installed, prior reports/logs/manifests and the unrelated stack were preserved, and the old fixture contracts are nonreusable. Any future run requires fresh inputs/contracts; never restore secrets to rerun the passing fixture. BG3 worker-stop candidate SHA-256 `059269dc913256dee532862c698d21e7ef972a01579f31a1a6e23e7e38db9913` is held at preparation only: 15/15 synthetic normal-stop boundary cases passed with no process launches or service calls; the sole normal-stop change drains an active read-only query, while stop flags block another iteration and all error/signal paths and time limits are unchanged. Independent root review remains HELD; no actual BG3 run or runtime fix is claimed. Canonical J4 acceptance remains incomplete, blocked by unrelated host port 54322 and fresh J1, Temporal, and API prerequisites; no J4 acceptance or cause is established. No further Docker restart is needed. See [recovery and BG3 preparation](evidence/PROD-OBS-04/2026-10-19-bg3-resume.json) and [PostgreSQL attempts and input cleanup](evidence/PROD-OBS-04/2026-10-19-pg-tls-attempts.json).

For reconciliation CI, the timeout-observability candidate has source review complete, focused Node 22 ESLint, syntax transpilation, and semantic typecheck passed. The typecheck used a 5,120 MiB V8 heap and stable 4,009-entry source snapshot with source/resource guards and custody clear; it is focused evidence only. An earlier attempt exited 134 from V8 heap exhaustion around 4 GiB, with no established host-memory-pressure cause. At the pre-rerun checkpoint, the pushed candidate had no automatic run and manual dispatch returned HTTP 422 (“Actions has been disabled for this repository”) despite enabled repository permissions and an active workflow. Cause remains unknown; no retry/settings change occurred. That dispatch failure and exact-source predecessor (19 success /1 reconciliation failure /8 conditional skips) remain historical. After the fork Actions setting was re-enabled, exact-source CI for `040033770399239e585d39356f7f3348b809abac` completed successfully across three workflows: main 20 successful jobs and 8 conditional skips (0 failures), plus both native workflows 2/2. Both packaged-worker architectures passed 22/22 checks with all six cleanup fields true; the Linux systemd and Windows ACL targeted leaves each passed 1/1. The reconciliation lane passed 39/39, but this successor pass does not establish a causal fix for the earlier timeout. Lane reports overlap and are not summed; sanitized skip-identity limitations and all job statuses are recorded in [2026-10-19-04003377-coherent-ci.json](evidence/PROD-CI-08/2026-10-19-04003377-coherent-ci.json). The earlier HTTP 422 dispatch-disabled response remains a historical blocker with unknown cause. The CI source is distinct from the E3 PostgreSQL runtime fixture; canonical J4 acceptance remains incomplete, with no runtime cause or acceptance claim. The previous ARM64 dependency-install failure is preserved, but current exact-source ARM64 package checks pass22/22 without identifying the earlier failure cause. Do not infer a PostgreSQL lock cause, a J4 link, runtime fix, or acceptance. See [candidate report](verification/RECONCILE-OBSERVATION-2026-10-19.md), [prior CI evidence](evidence/PROD-CI-08/2026-10-19-reconcile-observation.json), and [historical dispatch blocker](evidence/PROD-CI-08/2026-10-19-ci-dispatch-blocker.json).

---

## Current verification checkpoint — 14 October 2026, E3CF verification active

The registry repair is pushed to the working fork at `e3cf95bfb13921d0196f221bd08627b1bc29d78c`. Fresh source capture passed for 6057 files; previous F2D0 results remain historical. Exact E3CF CI currently has **24 successful jobs / 0 running / 8 conditional dispatch skips** across 3 workflows. Both native packaged-worker architectures passed 22/22 checks with cleanup; native Windows ACL and systemd leaves each passed 1/1 (Windows 15 excluded siblings are not executed skips). Main CI is now terminal success; all 17 artifacts and 11 strict lanes were inspected. Unit 24,738 passed /1,925 skipped /0 failed; Smoke/Gimbal passed.

Fresh local Full R2 exited 0 (root 18455, tool session 8051): 24,720 passed /1,943 conditional skips /0 failed, with all 26,663 identities and 13 strict commands reconciled; source stayed stable and maximum memory pressure stayed 1. Initial R1 preflight refused before guard acquisition/tests at memory-warning level 2. After measured unused memory increased 2592→5567MiB and three normal-pressure samples, the reviewed streaming-pin launcher began the fresh run. Independent terminal review, owned cleanup and fresh source-bound computational admission passed: 22,824 owned entries removed; 401 numeric PIDs /20 groups absent twice; lock cleared. This closes the computational phase only. J4's original 100.005s timeout cause remains unproven; fresh native push/J4, browser/default-composition and registered-agent runbook acceptance remain on the critical path. [Evidence](evidence/PROD-CI-08/2026-10-14-e3cf-verification-progress.json). Ledger remains **11 verified / 65 in progress / 2 planned (14.1%)**; release flags remain false.

---

## Current verification checkpoint — 14 October 2026, registry OOM repair

The instrumented startup's owned registry was OOM-killed (exit 137, 64 MiB cap) while the migration image push failed. This is a proved startup failure; it does not establish the cause of the earlier J4 maintenance timeout. The partial stack was then preserved and cleaned: 13 owned resources removed, 0 remaining, 0 forced stops; 48 held commands closed and 58 PIDs / 48 groups were absent twice before guard clear.

The reviewed three-file repair gives the registry a 256 MiB topology budget and includes it in the lean budget test (3424 MiB < 4096). All 43 unique focused tests and lint passed; the initial macOS temporary-path fixture failure remains preserved. Native push success, a fresh coherent source admission/CI, and full J4 acceptance remain pending. [Evidence](evidence/PROD-OBS-04/2026-10-14-j4-preserved-cleanup.json). Ledger remains **11 verified / 65 in progress / 2 planned (14.1%)**; release flags remain false.

---

## Current verification checkpoint — 14 October 2026, preserved J4 cleanup

Retained-stack cleanup passed: **19 owned resources removed, 0 remaining, 0 forced stops**; 49 held commands closed and 64 PIDs / 49 process groups were absent twice before guard clear. The protected builder, witness image, unrelated resources and frozen source passed preservation checks. Both database archives, four closed workflow histories, two paused schedules and 42 host files were saved privately before deletion. R3's explicit-opt-in refusal is preserved separately. This is cleanup-only evidence, with no J4 acceptance or production-readiness claim. [Evidence](evidence/PROD-OBS-04/2026-10-14-j4-preserved-cleanup.json).

The first instrumented launch refused memory preflight before any startup. Measured additional headroom and three normal-pressure observations allowed one retry: session 88990, root 15080, frozen F2D0 source. Startup entered, then failed at `default-stack:push-migration` while pushing the migration image to the owned local registry. All 80 held commands closed; maximum pressure stayed 1. Root observed 91 PIDs / 80 groups absent twice before guard clear. The machine-schedules phase and live observer were not reached; underlying push failure remains under diagnosis. The live observer captures bounded read-only database wait states alongside the unchanged canonical test. Ledger remains **11 verified / 65 in progress / 2 planned (14.1%)**; release flags remain false.

---

## Current verification checkpoint — 14 October 2026, retained J4 diagnostics

R8/R9 added bounded, read-only diagnostics on the exact frozen F2D0 source. The first critical activity completed in 0.358s (workflow duration 0.453s); the second activity reached its 100.005s start-to-close timeout and its workflow failed. No second committed engine lease was observed: unheld critical scopes used fence 1, while only the three test-held billing, key-rewrap, and runbook scopes used fence 2. DB and pooler logs were empty in the bounded interval; the post-run DB snapshot is not proof of state during the failure. The actual cause remains unproven. Both R8/R9 diagnostic parents exited 0 with custody and guard-clear proofs; neither is an acceptance result. R6 preflight and R7 SDK ScheduleHandle.describe ValueError remain preserved; the conversion explanation is inferred, and R8 raw projection changed diagnostics only. [Diagnosis](verification/J4-DIAGNOSIS-2026-10-14.md) and [sanitized evidence](evidence/PROD-OBS-04/2026-10-14-retained-j4-diagnosis.json).

R10 completed as a read-only diagnostic but exited 2 at its final resource check when memory pressure reached warning level 2; its 47 commands closed and `heldCloseoutProven=true`, with separate root custody closeout complete: 48 PIDs and 47 process groups were absent twice, no signals were sent; proof `57f22882316e48b20804a2f3c3f12fa5c810305ba5e9b293fac09472d20ef964`, guard-clear `4892e2c2c15836c1f203b471d9faa94fa1d94002d705c358a0b4f08750db577b`. Its warm SELECT 1 took 1ms; after 25,002ms idle, SELECT 1 took 22ms, so a basic idle-reconnect issue was not reproduced. PostgreSQL timeout settings were zero and `max_connections=60`; no Supavisor metadata tables were observed, so the actual pool configuration remains unproven. Fast completed `pg_stat_statements` calls do not rule out a hung or cancelled call. The probe's semantic result is diagnostic only and acceptance remains false. A later host sample at 11:27 showed pressure 1 and swap 0. F2D0 Full computational admission remains 24,720 P / 1,943 S / 0 F across 26,663 identities; ledger remains **11 verified / 65 in progress / 2 planned (14.1%)**, with release flags false.

---

## Current verification checkpoint — 14 October 2026, after host reboot

The earlier post-cleanup warning-level-2 pressure sample is historical. Following the actual Mac reboot, the observed boot time is `kern.boottime=1791966211.006225`; the current observation is pressure level 1, swap 0, and compressor memory 32 MB. Memory state changed across the reboot. Root completed the new-boot guarded custody clear: actual root execution exited 0; 68 PIDs and 40 process groups each returned ESRCH twice. The new guard inode was 9425823; the prior guard inode was missing after reboot. Independent guard review passed its bounded static safety review. The new J4 launch is prepared and under review; no actual J4 attempt has run. No additional Docker restart has been authorized or used. The current Docker CLI matches the actual R6/R7 signed Docker Inc fingerprints; `6c` was a recovery-controller-only pin, not general CLI drift.

The earlier J4 startup attempt remains `refused-retain-owned-state`: root PTY 5896 exited 2 after deferred startup pressure rose from level 1 to 2. Its original receipt (`27ea795b3947b5ddf2cacf3952f461d064497967f70f3271a756d8da9229be0c`) remains unchanged; `heldCloseoutProven=false`, `custodyUncertain=true`, and `sourceBindingStable=false`. No maintenance, PostgreSQL diagnostics, or J2 tests ran. The separate cleanup-only action did complete: root PTY 64456 exited 0; 40/40 commands closed strictly; 10 owned resources were removed, 0 remain, and none were force-stopped. The protected builder, unrelated baseline, and native W image were preserved. Cleanup review is P (lineage SHA-256 `d804ca8399e3919410b3538131b5a08a38da590061472106e93065e736221e99`; custody SHA-256 `84bc2c53e67c5ae47a43037eece350eba9837f06543e6622675812e1237ff07f`). Process-ID review covers 68 PIDs across 40 groups, all P. The post-boot custody clear completed under the new guard; this closes prior cleanup custody only and does not alter the original J4 refusal.

Exact-SHA CI on `97f3387ab9aded7ef47b70feba988e1c884e2ab9` remains terminal at 32 jobs: 24 passed, 8 conditional skips, 0 failed; 17 artifacts and 11 gate reports record 1,686 required identity entries passed (overlapping, not additive). F2D0 Full computational admission remains 24,720 passed / 1,943 skipped / 0 failed across 26,663 identities. Native W remains build-only: exit 0, no push, no entrypoint. These results do not establish J4 or product acceptance. The cleanup-time Docker snapshot (protected builder 181.2 MiB of its 6 GiB limit) does not establish startup peak memory or a leak; startup reached migrations and registry setup, while API build start/completion remains unproven.

Ledger remains **11 verified / 65 in progress / 2 planned (14.1%)**. All release flags remain false; no requirement, milestone, or acceptance state is promoted. Evidence: [CI and recovery](evidence/PROD-CI-08/2026-10-14-97f3387a-ci-and-docker-recovery.json), [J4 refusal and cleanup](evidence/PROD-OBS-04/2026-10-14-f2d0-j4-resource-refusal.json), and [native W build](evidence/PROD-PKG-01/2026-10-14-f2d0-native-witness-build.json).



Post-boot closeout evidence is verified: cleanup/custody closeout SHA-256 `0f47f1d12c4e90c03cd84cd5e0e3d3dad8ccc994173c9dff4561eb0a636ae514`; new-boot guard-clear receipt SHA-256 `232d1af53684463423a1104a01bfbb15ce1d0ae57c61523e5879ffd8179bac9c`; independent `GUARD-REVIEW.md` SHA-256 `12f86b848bfc52f3fb77c9f9498a6c291bb6ba6a538e19275306e793e962d30d`. The closeout records root exit 0, no process signaling, and two ESRCH observations for each of 68 PIDs and 40 groups. The guard-clear receipt confirms the retained new guard was emptied and leaves acceptance false. The new J4 launch remains preparation under review; no J4 engine or test attempt has run.
---

## Current verification checkpoint — 14 October 2026

Frozen product/test source remains F2D0 `f2d0cb4cce4f0d97496bf134fdb2a66a8c755a98`; latest exact-SHA fork CI on `97f3387ab9aded7ef47b70feba988e1c884e2ab9` remains terminal: 32 jobs, 24 passed, 8 conditional main-workflow skips, 0 failed across three runs. Seventeen sanitized artifacts and 11 gate reports record 1,686 required identity entries passed; entries overlap. This remote CI evidence does not promote acceptance or release state. [CI and prior recovery evidence](evidence/PROD-CI-08/2026-10-14-97f3387a-ci-and-docker-recovery.json).

The earlier approved one-use Docker restart completed as recovery-only and used its full one-use budget; no restart remains. The separate J4 startup attempt still stands as `refused-retain-owned-state`: deferred startup pressure rose from level 1 to warning level 2, root PTY 5896 exited 2, and no maintenance, PostgreSQL diagnostics, or J2 tests ran. Its original flags remain `heldCloseoutProven=false`, `custodyUncertain=true`, and `sourceBindingStable=false`; this was a resource/custody refusal, not an OBS-04 behavior test failure. The failed-attempt archive and independent custody review remain preserved. [J4 refusal and separate cleanup evidence](evidence/PROD-OBS-04/2026-10-14-f2d0-j4-resource-refusal.json).

A separate cleanup-only run has now completed: root PTY 64456 exited 0; all 40 commands returned 0 with strict closeout; source binding was stable. Its cleanup receipt reports 10 owned resources removed, 0 remaining, 0 forced stops, and `productionReady=false`. The protected builder, unrelated baseline, and native W image remained preserved. This closes the owned cleanup action only; final independent cleanup review and root guarded custody clear are pending. The earlier J4 refusal and its uncertain closeout are not rewritten by this cleanup result.

After cleanup, memory pressure remains at warning level 2. The latest host sample reported about 23 GB used, 11 GB compressor, 156 MB unused, and 88% CPU idle. Docker reported MemTotal 8,319,238,144 bytes; the protected builder used 181.2 MiB of its 6 GiB limit, the registry 35.25 MiB, and Mailpit 37.27 MiB. Five Supabase containers were already stopped; the observed OOM flag was false, which does not establish peak memory or explain the refusal. An owned registry resource was present during the refused startup, showing that startup reached migrations and registry setup; API image-build start or completion is unproven. This is not evidence of an API build failure or a heap leak.

The F2D0 computational admission remains 24,720 passed / 1,943 skipped / 0 failed across 26,663 exact identities. The native ARM64 W image remains build-only: exit 0, no push, no entrypoint. [W build evidence](evidence/PROD-PKG-01/2026-10-14-f2d0-native-witness-build.json). The 22 local cold packaged-worker checks remain blocked pending measured capacity improvement. No identical startup retry should occur until headroom improves measurably; close the unused apps and extra Codex windows requested before measuring again. J4 acceptance checks, PostgreSQL diagnostics, MFA, browser, and MACH-03 delivery remain unrun.

Ledger remains **11 verified / 65 in progress / 2 planned (14.1%)**. All release flags remain false; no requirement, milestone, or acceptance state is promoted.

---
## Current verification checkpoint — 14 October 2026

The inspected publication `119ce1e16f666ecc30e1ac153eb9e6cfcc2d7c4c` contains documentation and evidence only; product code and test inputs remain frozen at F2D0 `f2d0cb4cce4f0d97496bf134fdb2a66a8c755a98`. Exact-SHA CI is terminal: **32 jobs, 24 passed, 8 conditional main-workflow skips, 0 failed**. Main run `38510891511` completed 20 passed / 8 skipped / 0 failed; packaged-worker run `38510901573` passed both architectures (22/22 checks each for amd64 and arm64); native-platform run `38510910927` passed both jobs. Seventeen artifacts and 11 gate reports record 1,686 required identity entries passed; entries overlap and are not a unique or additive test count. Eight integrations remain conditionally skipped. This is remote CI evidence for the docs/evidence publication, not a code/test-source change or acceptance promotion. [Exact-SHA CI evidence](evidence/PROD-CI-08/2026-10-14-119ce-exact-ci-terminal.json).

The F2D0 Full computational admission remains published and independently reviewed P: **24,720 passed, 1,943 conditional skips, 0 failed, 26,663 exact identities**. It does not establish engine, workflow, or product acceptance.

The original R5 package run remains refused and preserved unchanged; its raw archive contains 492 files, 1,883,597 bytes, and 122 custody ledgers. The separate R5 cleanup-only receipt reports exit 0, with 35 main commands and 10 VM probes strictly closed, exact owned-builder/container/state-volume removal, and protected builder/source/tools preserved. Independent terminal review is P for cleanup-only proof (SHA-256 `a023ba4ef3d67c6a5f5937cd0904201c17bbe0c9cd41dd1a2c9859875ac54f20`). Root then completed guarded custody clear (proof SHA-256 `79a070680f99b1b9f60e2a87bfa21474d01bf4cd48b021c7fb8fdcdbd531e50c`): 45 raw ledgers/45 command groups and 46 identity PIDs were absent twice. Supplemental proof (SHA-256 `8712b5d87934a37f619073d14ebb50627d2e5e815d3b756614918b87f3767e93`) covers all 50 captured PIDs plus the launcher (51 total), including five capture-only helpers; all were absent twice across 45 groups, and the canonical heavy-work lock was empty. This closes custody for the cleanup only; the original package refusal remains unchanged and no acceptance is claimed. The earlier R4 cleanup attempt refused before mutation; its protected-image-tag correction review applies only to that correction. The corrected R5 cleanup subsequently completed, and no second builder cleanup remains. [Full and cleanup evidence](evidence/PROD-CI-08/2026-10-14-f2d0-owned-package-cleanup.json).

Native W R6 source review is P (source SHA-256 `03724b625bdc8efe8f3c120df702e9fe614c1775150e066cc397cf51b710a69a`; source-delta review SHA-256 `4b241f29d55756a32e8884e298d7d3861a897b56edc4fd6daa57478dd3d2a69c`), but no build ran. J4 candidate `537b5864b8cda8d4b3a579e8a190889fd462065634de937773bef4c610e9a0db` passed source-delta review and remains HELD pending resource recovery and the actual W launcher receipt; its status is not promoted. Host pressure is level 2; no heavy tests are active. The additional Docker restart request remains pending and not approved. The recovery controller source review passed; it remains held pending explicit renewed approval and a pinned one-use budget. No restart budget is created. Do not retry the known-bad package profile or start heavy work while resource-blocked.

Ledger remains **11 verified / 65 in progress / 2 planned (14.1%)**; all four release flags remain false. No requirement or acceptance state is promoted.

---

## Completed exact-source CI, recovery and Full computational admission — 14 October 2026

Primary/fork source `7d14ecee4493a7a3c5820bf775f7e7d4fc891c0c` now has terminal exact-source CI: **32 jobs, 24 success, 8 conditional operated main-job skips, 0 failures** across three runs. Both native worker architectures passed 22 checks each and both native platform jobs passed. Seventeen sanitized artifacts and 11 gate reports contain 1,862 required identity entries; entries overlap and are not a unique or additive test count. This appends remote evidence to the already-verified PROD-CI-09 state.

On frozen source `3aa2e655a0b869a2458d9e69dde4a3948888f9a5`, the actual recovery stage passed: 10 required tests, all 3 required identity IDs, 0 failures/skips, and 11 held commands closed. This is typed recovery evidence after the separately P-reviewed native `platform-postgres` stage; its generic custody label remains `native-pg-stage`, with backend label and typed stage explicit and no case waiver.

The Full run’s original R6 terminal remains **refused** for `persistent-copy-failed`. A fresh computational phase/archive admission is now P: 24,704 passed, 0 failed, 1,943 skips reconciled under the unchanged broad predicate, 26,647 exact identities, and all 13 held commands closed. The complete archive contains 20,615 regular files, 717 directories, and one intentional fixture symlink represented as metadata only. The admission explicitly sets `engineStarted:false`, `engineAcceptance:false`, and `acceptanceClaim:false`; it is computational admission only and fabricates no legacy engine acceptance.

ToFu 1.12.5 `darwin_arm64` packaging/version and fixture admission are P within scope (two held commands closed). VM floor calibration is P with three samples and all six probes closed; builder configuration is unchanged. W R4/R6 preflights refused before build; corrected parser/argument cases passed focused checks (Buildx 3/0/0; tag 2/0/0). W R8 native build completed with exit 0, then the supervisor refused at build-metadata-identity because Buildx `metadata file` was mode 0644. Independent R8 terminal review is P for custody/closeout only (all 22 held commands closed; review SHA-256 `f15c82d4fa05a60896c5b9e321147e57e40ed53d918a942fdc6b9a0189e8fd83`). The original refusal remains; image inspection and source-after receipt are absent, and acceptance is false. Root cleared the exact R8 custody marker under a nonblocking exclusive lock after a 95-file hash manifest and all 22 closeouts (proof SHA-256 `ac640027734db0ef3ef2fdd8456abf738b45024ad0f6ab2f3e0e77c9b8dc45ec`). This clears custody only; the W postflight hold remains. R9 finalize-only preparation is running, with no rebuild or push. Heavy workload is none and the lock is empty. J4 R5 has source-only hold review P and pure publication 4/0/0; no J4 engine has executed, and OBS04 awaits W postflight. MACH03 consent-registered Auth/MFA work remains pending. PKG03 remains blocked by cold-build memory pressure and was not retried.

Ledger remains **11 verified / 65 in progress / 2 planned (14.1%)**. All four release flags remain false; criteria, requirement states, and required evidence levels are unchanged. Native ARM64 Mac and native Linux CI are separate. [Sanitized CI, recovery, Full computational admission, ToFu fixture, and VM calibration evidence](evidence/PROD-CI-08/2026-10-14-7d14ecee-recovery-full-admission.json).

**Current action:** root finalizes W R9 only; no rebuild or push. Keep quarantine until root guarded clear after the independent custody-only review. J4/OBS04 remains gated on W postflight; continue MACH03 Auth/MFA consent registration. Preserve the refused Full outer record and computational-only admission boundary.

---

## Current exact-SHA CI / PG / cleanup checkpoint — 14 October 2026

- **PROD-CI-09:** exact-SHA `34896d103f7336501212b0557883d8f82ab397e4` CI is terminal across 32 jobs (24 pass, 8 conditional main-job skips, 0 fail). Native amd64 and arm64 worker checks pass 22/22 each; both platform jobs pass. All 1,686 required identity entries pass across 11 reports; entries may overlap. Append evidence only; existing `verified` state is unchanged.
- **PROD-CI-08 / PG3aa:** fresh native ARM64 macOS PostgreSQL stage is P-reviewed for `platform-postgres` only: 4,142/0/15 of 4,157; 1,160 required identities, 2,653 required tests and native100 100/100 pass; 11/11 held commands close. Recovery and overall acceptance remain open.
- **Owned-stack cleanup:** terminal P, 17/17 commands; 10 owned resources removed, 0 remaining, 0 forced stops; protected builder preserved; quarantine clear followed proof. Cleanup is not acceptance.
- **Full R6:** refused at persistent-copy-failed. Counts, custody and independent review are pending; raw run is retained privately. Earlier full/W P reviews lack raw evidence after reboot and are not eligible for new J admission.

Ledger remains 11 verified / 65 in progress / 2 planned, with all four release flags false. [Evidence](evidence/PROD-CI-08/2026-10-14-34896d10-pg-cleanup-checkpoint.json).

---

## Exact-source CI and local resource recovery, 14 October 2026

Exact `3aa2e655` CI is terminal: **24 successful jobs / 8 conditional skips / 0 failures across 32**. Node/DOM reported **24,722 passed / 0 failed / 1,925 skipped**; compiler, lint, smoke and production assets passed. All required identities in thirteen canonical main-CI artifacts passed. Native AMD64 and ARM64 workers each passed22 checks; targeted Linux systemd and Windows ACL leaves each passed1/0/0. Counts overlap and are not summed. [Sanitized evidence](evidence/PROD-CI-08/2026-10-14-3aa2e655-ci-pkg-checkpoint.json).

Local package preflight first refused inherited Node26 before resource creation. The pinnedNode22 successor then hit host memory-pressure2 during fresh image build: **zero acceptance checks**. That run remains refused with incomplete custody and no accepted final source-stability proof. Exactowned builder/container/volume recovery subsequently passed19 strictheld commands and independent terminal review; no unrelated inventory changed.

The next package profile retains canonical4GiB builder limits and all22 checks, with BuildKit OCI maximum parallelism1. Its private-config custody and retention correction passed17 isolated regressions and independent source review. The earlier two-failure retention regression is preserved; no engine acceptance is claimed. User approved up to3 additional recovery restarts between terminated, cleaned runs; one additional restart recovered normal pressure1 with unchanged settings. The fresh3aa full Node/DOM run is active at this checkpoint; its outcome and the serial package run remain pending.

Ledger remains **11 verified / 65 in progress / 2 planned (14.1%)**. CI09 stays verified with current3aa remote evidence; CI08 and default-stack/browser/scheduling/registered-runbook acceptance remain open. All four release flags remain false.

## Current pre-push verification queue — 13 October 2026

1. Apply and review only the one-line verifier fixture expectation for `workflow_dispatch: null`, then run the focused fixture check and obtain fresh exact-source CI for the resulting commit. Preserve the current 6d03043f terminal failure as historical evidence.
2. Keep 5ca58d93 local PostgreSQL **REFUSED**: 4,142/0/15 inner gate counts do not override the outer 128-event capacity overflow. Run the capacity-boundary regression and any needed fresh PostgreSQL successor on the corrected 4,096-event / 8,192-KiB bounded design; the source review is P, tests remain pending. Do not issue retroactive acceptance for the refused run.
3. Keep full Node/DOM at its separately reviewed P scope (24,703/0/1,943; 1,723 static plus 220 runtime skips, no pinned baseline claim). It does not establish strict all-canonical-gates or PROD-CI-08 acceptance.
4. Keep W1's stale-HELD refusal; W1's pre-launch `buildExecuted` flag is not build evidence. W2 retry run 91109 remains in progress after P review. Package evidence is source-review P only, with actual engine checks pending. J4 leaf relocation review remains open.
5. Preserve ledger **11/65/2**, all four release flags false, and no promotion.

The current ARM64 witness build passed with independent terminal review P. The capacity-only supervisor calibration passed11 mocked regression tests; a fresh native PostgreSQL attempt is running. These results do not close default-stack acceptance.

Evidence: [scoped CI and local verification checkpoint](evidence/PROD-CI-08/2026-10-13-6d03043f-ci-pg-checkpoint.json).

---

## Current full-core / CI08 gates — 13 October 2026, source 5ca58d93

1. Preserve the P terminal review for the broad full Node/DOM unit execution: 24,703 passed / 0 failed / 1,943 skipped across a 6,025-file source freeze. This is broad unit execution evidence; it does not establish strict all-canonical-gates acceptance.
2. Record exact-source native platform CI run `38433721078` as completed SUCCESS for source `5ca58d93a69d75260e291bd3cbc7593dd609daf4`. Keep native worker run `38433711110` pending until terminal.
3. Track main workflow run `38434314187` separately on source `6d03043fdd67479e56109afbefc22ec83761033d`; it remains in progress. The manual-fix focused evidence and Actionlint pass are not terminal main-workflow results.
4. Keep the exact-source CI aggregate pending while either required workflow remains active. Keep PROD-CI-08 in progress / HOLD and the ledger at 11 verified / 65 in progress / 2 planned, with all four release flags false. No requirement promotion is proposed.

Evidence: [reviewed full-core execution](evidence/PROD-CI-08/2026-10-13-5ca58d93-full-core-r16.json).

---

## Owner decisions 2026-10-13

Three owner decisions were approved by Arnav Bule on 2026-10-13 and implemented on the build machine (typecheck and unit and PGlite tests only). Nothing below has run on the verifier. Run each block on Node 22, sequentially, one heavy workload at a time. Record each result with its exact commit SHA, and keep pending, failed and passed distinct. Real PostgreSQL, object store, Temporal, browser and Stripe test-mode checks are required, and a skipped check is not a pass.

### Retention (DEC-RETENTION)

Doc: [verify/PROD-OPS-07.md](verify/PROD-OPS-07.md) and [verify/PROD-OPS-05-06.md](verify/PROD-OPS-05-06.md).

Commands (PROD-OPS-07): `npx vitest run tests/retention`; `npx vitest run tests/platform/critical-jobs.test.ts tests/sensitivedata tests/security tests/controlplane/migrations.test.ts`; `npx tsc --noEmit -p . && npx eslint src/lib/retention src/app/api/admin/ops/retention src/app/admin/retention scripts/data-retention.ts tests/retention`. Manual live check, not counted: `ZENITH_RETENTION_ARCHIVE_TARGET=s3` against LocalStack with a policy file, then `npx tsx --env-file-if-exists=.env.local scripts/data-retention.ts`.

Commands (PROD-OPS-05-06): `npx vitest run tests/keycustody tests/sensitivedata tests/security/sensitive-inventory.test.ts tests/security/persistence-leaks.test.ts`; `ZENITH_TEST_PLATFORM_PG_URL=postgres://... npx vitest run tests/security/persistence-leaks.test.ts`; `npx vitest run tests/secrets tests/runners tests/machines tests/workflows/codec.test.ts tests/workflows/codec-wiring.test.ts tests/workflows/critical-schedule.test.ts tests/platform tests/server tests/security tests/controlplane tests/capabilities`; `npx vitest run tests/docs/operator-docs.test.ts` (expected to fail until the DEPLOYING.md rows in PROD-OPS-05-06 section 4 are added); `npx tsx scripts/key-custody.ts diagnose --no-db`; `npx tsx scripts/sensitive-inventory.ts --only unreviewed`. With a Postgres platform store and migration 39 applied: `npx tsx --env-file-if-exists=.env.local scripts/key-custody.ts sync`; `npx tsx --env-file-if-exists=.env.local scripts/key-custody.ts rewrap --workspace <id> --run`; `npx tsx --env-file-if-exists=.env.local scripts/sensitive-data-census.ts`; `npx tsx --env-file-if-exists=.env.local scripts/data-minimize.ts`.

Services: real PostgreSQL (migrations 39 and 45, the PostgreSQL lane of the leak suite, and the sync, rewrap, census and minimize commands); object store (LocalStack or MinIO) for the S3 archive check; Temporal (the `data-retention`, `key-rewrap` and `data-minimize` critical jobs on the critical-maintenance schedule, and the payload codec); browser (`/admin/retention`, operator only). The offline commands need none of these. Stripe is not used.

Confirm on the verifier:

1. Real PostgreSQL for `tests/retention`. The builder added no PostgreSQL lane for it (PROD-OPS-07 section 3). Check the SQL that PGlite may accept differently: tuple comparisons and `make_interval(days => case ...)` in `job.ts` and `store.ts`; `delete ... using` and `pg_advisory_xact_lock` in `store.ts`; and `insert ... overriding system value ... jsonb_populate_recordset` plus the staging `create table ... (like ...)` in `restore.ts`.
2. Legal holds on a real engine: a held first candidate returns `{ status: "blocked", reason: "legal_hold" }`, held rows are not archived, pruned or minimized, and the row is archived normally after release.
3. S3 archive against LocalStack or MinIO: sealed objects appear under `retention/<workspace>/<class>/`, `verifyArchive` passes, `restoreArchive` into a staging schema works, and prune deletes only verified manifest ids.
4. With `ZENITH_RETENTION_APPLY` and `ZENITH_DATA_MINIMIZE_APPLY` unset, nothing is deleted or pruned, and the `data-minimize` pass only counts candidates.

### Service levels (DEC-BUSINESS)

Doc: [verify/PROD-OPS-01.md](verify/PROD-OPS-01.md) and [SLO.md](../../platform/operations/SLO.md).

Commands (PROD-OPS-01, decision section): `npx tsc --noEmit -p .`; `npx vitest run tests/slo tests/ops/recovery-manifest.test.ts tests/ops/data-plane-independence.test.ts tests/docs/operator-docs.test.ts tests/ci/packaged-workers.test.ts --no-file-parallelism --maxWorkers=2`; `ZENITH_TEST_PLATFORM_PG_URL=postgres://... npx vitest run tests/slo/slo.engine.test.ts`; `npx vitest run tests/reconcile`. Commands (PROD-OPS-01, earlier sections): `npx eslint src/lib/slo src/app/admin/slo src/app/api/admin/ops/slo src/app/api/internal/slo src/lib/ops/sampler.ts tests/slo`; `npx vitest run tests/slo/definitions.test.ts tests/slo/sli-budget.test.ts tests/slo/slo-artifacts.test.ts`; `npx vitest run tests/slo/slo.engine.test.ts`; `npx vitest run tests/docs/operator-docs.test.ts tests/ops`; `node scripts/slo/capacity-test.mjs --self-test`; `node scripts/slo/report-recovery.mjs --dry-run --failure-at 2026-10-07T10:00:00Z --data-through 2026-10-07T09:56:30Z --restored-at 2026-10-07T10:42:10Z`; optional `promtool check rules deploy/observability/alerts/zenith-slo.rules.json`; manual capacity run on loopback: `node scripts/slo/capacity-test.mjs --url http://127.0.0.1:3000 --path / --concurrency 16 --duration 20`.

Services: real PostgreSQL (the PostgreSQL lane of `slo.engine`, including the dispatch approval join); a deployed environment with an external uptime probe; a managed production environment with reconcile running; a restore rehearsal for RPO and RTO; a running `next start` for the capacity run; browser for `/admin/slo`.

Confirm on the verifier:

1. The dispatch latency join on real PostgreSQL starts the clock at the last required approval from `platform.approvals`, and approved or queued operations already waiting more than 30 s count as misses.
2. An external probe is wired per SLO.md (five-minute aligned windows, the `CRON_SECRET` bearer, idempotent replacement). `/admin/slo` shows both availability sources and uses the lower ratio, and says "External probe not reporting" until the probe reports.
3. A managed production environment accumulates `managed_runtime_availability` samples after a reconcile pass, and observations with unknown health stay out of the ratio.
4. RPO and RTO show "Not measured yet" until a real restore rehearsal reports through `scripts/slo/report-recovery.mjs`. The capacity figure describes only the machine that ran the test.

### Pricing (DEC-BUSINESS)

Doc: [verify/PROD-MAN-06.md](verify/PROD-MAN-06.md) (section "Pricing decision update") and [verify/PROD-MAN-07.md](verify/PROD-MAN-07.md).

Commands: `npx vitest run tests/billing tests/platform/billing-schedule.test.ts --no-file-parallelism --maxWorkers=2`; `npx vitest run tests/capabilities/autonomy.test.ts tests/managed-serving/catalog.test.ts --no-file-parallelism --maxWorkers=2`. Stripe test mode, by hand, on a disposable workspace: `export ZENITH_BILLING=managed`; `export ZENITH_BILLING_STRIPE_SECRET_KEY="$STRIPE_TEST_SECRET_KEY"` (an `sk_test_` key from the Stripe test-mode dashboard); `curl -s -X PUT "$ZENITH_ORIGIN/api/admin/billing/assignment" -H "content-type: application/json" -d '{"workspaceId":"<ws>","planId":"builder"}'`; `curl -s -X POST "$ZENITH_ORIGIN/api/admin/billing/invoices" -H "content-type: application/json" -d '{"workspaceId":"<ws>","period":"YYYY-MM"}'`. PROD-MAN-06 section 3 describes the PostgreSQL lane (set `ZENITH_TEST_PLATFORM_PG_URL`) but gives no exact command, so record the exact command you use.

Services: real PostgreSQL (billing engine PostgreSQL lane; the two `assertDispatchAdmitted` cases skip there unless `ZENITH_TEST_OPS_EXCLUSIVE_PG=1`); Stripe test mode (an `sk_test_` key and a disposable workspace, never a live key); a running app at `$ZENITH_ORIGIN` with an operator session for the admin routes; browser for the comparison table. No object store or Temporal is needed: the billing pass is an HTTP tick at `/api/internal/tick/billing`, not a Temporal schedule.

Confirm on the verifier:

1. In Stripe test mode, the Builder invoice has a "Builder monthly minimum" item of 2900 cents with no "(provisional pricing)" suffix. An Enterprise assignment creates no invoice, and the admin route returns `contract_billed`.
2. On a seeded period, Builder at 1,933 ZCU-hours bills $29.00, Builder at 1,934 bills $29.01, and Team at 13,267 bills $199.01, with the charged lines summing to the amount due.
3. Entitlements apply only with `ZENITH_BILLING=managed`: Explore deploy dispatch returns 402 `plan_feature_unavailable`, a Builder policy edit returns 402 with `details.feature` `org_policies`, and a Team policy edit succeeds. A live key is refused and invoicing stays off.
4. Before billing is enabled, reassign legacy `free_provisional` accounts that were deploying, since they now fall to Explore and lose deploy. Check the comparison table in the browser, which the builder did not run.

Separate item, not a decision: `tests/ops/route-wiring.test.ts` showed 6 failures on the build machine, with an import-order error in `registerAllActions` (`src/lib/server/boot.ts`). This predates the owner-decision work. Confirm it on the verifier.

## Current shutdown/recovery gates — 12 October 2026, integrated commit 6410def1

1. Run a fresh coherent full test and post-push exact-source CI after commit `6410def173ff03a160be1d5200c3543325e8c283` receives its evidence update and source freeze.
2. Keep actual shutdown cause, graceful shutdown, signal ordering, stop-grace, and zero-forced-stop acceptance gates open. The focused 13/0/0 diagnostic fixture does not close them.
3. Preserve cleanup R5 as failed/unaccepted (19 removed, zero owned remaining, two forced stops). Recovery R4 terminal PASS is limited to failed-cleanup postcondition closeout; recovery R3 failed and is not the successful recovery.
4. Continue remaining PROD-CI-08 gates. The canonical ledger is 11/65/2 (14.1%); preserve earlier 9/67/2 and 10/66/2 checkpoints. Keep all release flags false.

### Earlier queue entries below are historical and superseded where inconsistent with this update.

## Current 673f candidate status — 12 October 2026

This candidate records PROD-CI-07 as **verified** for the current, time-bound known-finding scope after the reviewed input-equivalence and exact-source supply-chain evidence were joined. The historical 8-versus-7 raw audit discrepancy remains unresolved and preserved as provenance. The ledger is **11 verified / 65 in progress / 2 planned** across 78 requirements; all four release flags remain false.

PROD-CI-08 remains **in progress / HOLD**. Current exact-source full-core Node/DOM evidence is 24,624 passed / 0 failed / 1,943 skipped across 26,567 identities. Exact-source CI is 24 successful / 8 skipped / 0 failed jobs of 32; skipped jobs and incomplete gate families remain open. This scoped evidence does not establish full PROD-CI-08 acceptance.

Cleanup remains pending with three owned images under source-proof review. The latest J4 cleanup R5 failed validation: 19 resources removed, 0 owned resources remaining, 2 forced stops; the engine lock remains sticky. Independent terminal custody review is P for the canonical-down process-tree absence (34 events, 9 pending births resolved absent, two final confirmations); this does not convert the cleanup into an accepted receipt. The historical J6 R2 27-case source-availability incident remains an incident, not a passed test run or retained source snapshot. Fresh exact-673f J6 R8 pure/model plus pinned-module interop passed 30/30 with zero errors, failures, or skips on the unchanged 6,012-entry freeze. This scoped result does not establish native-kernel, broker-runtime, accepted-run, or product acceptance; the historical R6 failure remains refused.

Evidence in this candidate: [CI07 closure](evidence/PROD-CI-07/2026-10-12-673f33f1-current-closure.json), [CI07 input equivalence](evidence/PROD-CI-07/2026-10-12-673f33f1-current-input-equivalence.json), [CI08 full-core execution](evidence/PROD-CI-08/2026-10-12-673f33f1-full-core-r16.json), [terminal CI](evidence/PROD-CI-08/2026-10-12-673f33f1-terminal-ci.json), and [CI08 HOLD assessment](evidence/PROD-CI-08/2026-10-12-673f33f1-ci08-hold-assessment.json); [J6 R8 pure terminal review](evidence/PROD-CI-08/2026-10-12-673f33f1-j6-pure-r8-terminal-review.json), [failed cleanup R5 terminal review](evidence/PROD-CI-08/2026-10-12-673f33f1-cleanup-r5-failed-terminal-review.json).

## Current focused evidence update — 12 October 2026, source 673f33f1

The candidate ledger has CI07 integrated as **verified** for current time-bound dependency findings and stands at **11 verified / 65 in progress / 2 planned**. The primary ledger remains **10/66/2** pending root integration; all four release flags remain false. The historical 8-versus-7 audit discrepancy remains unresolved provenance, and new advisories require fresh review.

Current exact-source full-core R16 passed **24,624 / 0 failed / 1,943 skipped** across 26,567 identities; terminal CI has **24 successful / 8 skipped / 0 failed** jobs of 32. Skips remain skips, and this scoped execution does not close CI08. CI08 remains **in progress / HOLD** for missing exact-count gate families, including the unexecuted browser/default-stack path.

Focused evidence includes the seven-test candidate run (7/7), the R8 parent-order synthetic run (12 methods / 51 declared alias cases), and fresh exact-673f J6 R8 pure/model plus pinned-module interop (30/30, zero errors/failures/skips, unchanged 6,012-entry freeze). J6 R8 is scoped pure proof, not native-kernel, broker-runtime, accepted-run, or product acceptance. Keep the historical R2 27-case source-availability event as an incident rather than a passed run or retained source snapshot; the R6 failure remains refused.

J4’s read-only Temporal R5 probe found both schedules paused and payload projections consistent with the codec candidate. The subsequent cleanup R5 reached canonical down but failed validation: **19 resources removed, 0 owned resources remaining, 2 forced stops**; outer exit was 2 and the engine lock remains sticky. Independent process-custody review is P for terminal process-tree absence (34 events; 9 pending births resolved absent; two final absence confirmations). That proves process absence only; cleanup remains unaccepted and lock-clearance is pending read-only parity recovery. Three owned images remain under source-proof review.

Next: complete read-only parity recovery for the sticky lock and source review for the three owned images, then continue the ordered R19 J-default and J2 OBS/MACH gates. The primary ledger and release flags remain frozen as noted above; this candidate records no CI08 or product acceptance.

Evidence: [CI07 closure](evidence/PROD-CI-07/2026-10-12-673f33f1-current-closure.json), [CI07 input equivalence](evidence/PROD-CI-07/2026-10-12-673f33f1-current-input-equivalence.json), [full-core R16](evidence/PROD-CI-08/2026-10-12-673f33f1-full-core-r16.json), [terminal CI](evidence/PROD-CI-08/2026-10-12-673f33f1-terminal-ci.json), [CI08 HOLD](evidence/PROD-CI-08/2026-10-12-673f33f1-ci08-hold-assessment.json), [J6 R8 terminal review](evidence/PROD-CI-08/2026-10-12-673f33f1-j6-pure-r8-terminal-review.json), [cleanup R5 failed terminal review](evidence/PROD-CI-08/2026-10-12-673f33f1-cleanup-r5-failed-terminal-review.json).
---

### Prior R2 checkpoint (superseded by this update; preserved for history)

## Current verification queue — 12 October 2026

| Gate | Current evidence | Remaining action |
| --- | --- | --- |
| Full-core R16 | 24,624 passed / 0 failed / 1,943 skipped; strict review P; source and custody checks pass. | Keep separate from application acceptance. |
| Exact-source CI | 24 passed / 8 conditional skips / 0 failed across 32 terminal jobs; native workflows 4/4. | CI07 closure is eligible after root integration; no ledger promotion yet. |
| R19 downstream binding | R6 source review P; actual J/K/U/A graph matches its bindings. | Run required R19 J-default acceptance and remaining default-stack gates. |
| J4 Temporal | R5 read-only probe P; both schedules paused; payload lengths/projections match the codec-fix candidate. | Run codec tests; resolve retained J4 stack after safe cleanup review. No J4 acceptance yet. |
| Builder | Next planned gate. | Complete source-bound rotation/build. |
| J2 OBS/MACH | Pending. | Complete after builder and R19 default acceptance. |

Ledger remains 10/66/2; all release flags remain false. Historical 6aed refusal, J4 cleanup failure, and earlier harness refusals remain in the record.

---

## Source 673f33f1 verification queue — 12 October 2026

| Gate | Latest evidence | Remaining gate |
| --- | --- | --- |
| Full-core R16 | Strict wrapper passed on 673f33f1; 24,624 passed / 0 failed / 1,943 skipped. Source snapshots match; custody clean; floor passed. | Test execution is proven; separate application acceptance remains open. |
| Exact-source CI | 22 passed, 8 conditional skips, 2 active, 0 failed of 32. Native workflows each 2/2 passed; main workflow 18 passed, 8 skipped, 2 active. | Wait for terminal status and assess all remaining gates; skips remain conditional. |
| Builder | Rotation/build is the next planned activity. | Complete source-bound builder gate. |
| R19 J-default | Pending. | Complete required default acceptance. |
| J2 OBS/MACH | Pending after R19. | Complete the ordered observability and machine acceptance. |

The 6aed full-core wrapper refusal remains historical and is not overwritten by this later successful run. Ledger remains 10/66/2; all release flags remain false.

### Previous integrated-worker verification queue (historical)

### Previous integrated-worker checkpoint (historical, before the 673f full-core run)

The real React worker fixture now lets natural peer IPC EOF complete Node 22 child-close accounting. The real close event, 10-second deadline, assertions and cleanup IPC remain strict. Fresh post-change full Node/DOM and exact-source CI are pending.

The process-tracker ordering repair passed independently reviewed held synthetic checks: 7 methods/21 subcases, the 47-method/61-case custody regression suite, and 6 additional methods/33 subcases, each with zero failures or skips. These separate overlapping results do not replace full native acceptance or erase the refused 6aed run. Native100100/100 and actual Temporal10/10 remain scoped evidence at 6aed.

Ledger: 10 verified / 66 in progress / 2 planned (12.82%); all release flags remain false. Next: publish this checkpoint, bind the fresh clean source, run full I/O acceptance, then continue default-stack J1/J4/J2 and natural maintenance verification.


## Historical source 6aed3a99 verification queue — 12 October 2026 (R4)

| Gate | Latest evidence | Remaining gate |
| --- | --- | --- |
| Exact-source CI | Terminal overall: 22 passed, 8 conditional skips, 2 failed of 32. Both failures are the same React natural-close test in Hosted and Verify Unit; Verify Typecheck passed. Native workflows each passed 2/2 selected jobs. | Resolve and verify the real React child natural close, then obtain passing exact-source CI. |
| Native100 | Focused 100/100; independent review confirms cleanup, lock clear, observer join and matching source checkpoints. | Focused proof only; no milestone acceptance. |
| Temporal restart | Focused 10/10 across five suites; cleanup and custody review P. | Focused proof only; broader observability acceptance remains separate. |
| Full Node/DOM | 24,624 passed, 0 failed, 1,943 pending; wrapper refused `parent_capture_mismatch`. | Resolve custody/source-finalization issue and obtain an accepted full run. |
| Tracker | Strict synthetic proof: 7 methods / 21 subcases passed. | Mandatory 47-case suite and supplemental cases pending. |
| WSET IPC | Test-only R2 source-reviewed. | Runtime focused checks and exact-source CI. |

Ledger remains 10/66/2; all release flags remain false. No acceptance promotion is proposed.

### Prior verification queue

## Current source 27c01268 verification queue — 12 October 2026

| Gate | Latest evidence | Remaining gate |
| --- | --- | --- |
| Integrated code | Five code files are committed at `27c0126888a3f5cbafabb6ca8e3033eeaa96aed3`; not pushed. | Push and bind a fresh source publisher receipt. |
| Native100 | 100/100 focused tests; independent review confirms cleanup, lock clear, observer join, source checkpoints and secret removal. | Scoped proof only; no milestone acceptance. |
| Go retry/PID1 | 204/204 focused checks passed; terminal review confirms 29 settled custody ledgers, 28 held Git commands and matching freezes. | Darwin-focused evidence; no Linux systemd/PID1 acceptance. |
| Exact-source CI | Previous 068 baseline: 21 passed / 8 conditional skips / 3 failed of 32; separate native workflows 2/2 each. | Fresh full CI on pushed source. |
| React worker close | Linux React build succeeds but natural close remains unresolved. | Establish the cause and verify natural close. |
| Remaining gates | Current publisher, R9, full Node/DOM, default J1/J4/J2 pending. | Complete in the required order and preserve scoped result limits. |

Ledger remains 10/66/2; all release flags remain false. No acceptance promotion is proposed.

### Prior verification queue

# Integrated verification checkpoint — 12 October 2026

The 24 reviewed source changes are committed as `35ef780463d1e43faa7da9cefabe9604f7cb4041`. Every integrated postimage matches its reviewed candidate. This evidence update will accompany that source before publication; fresh exact-source CI, source publishing and broader acceptance remain pending.

The final worker overlay passed all 92 cases across six complete files (21 suites), zero failures/skips. The strict wrapper passed all 29 held commands with complete custody, final absence, no quarantines/overflow, stable dependency-link identity, matching before/after/final source snapshots and joined disk-floor monitoring. Proof SHA-256: `7e27aa4a4c2334fec54e66aadf4f8889ba2c7ce68cb64a01ee7d90886781bfdc`; independent terminal review: `003ee669838033cd77d74d8614c505cc3352e188321e7f34b160e4debdf4b3c0`.

Final affected-file ESLint and full-project TypeScript no-emit both returned zero. All 30 held commands, source freezes, dependency-link and floor checks passed. Static proof SHA-256: `2dabe07b3699d23bd0ac459155a8d554a5a1583bc93f664587e1ba7d969af41f`; independent review: `0d16c4547abdeee082b10a3dab563f01591edc0db4012dbfb587587fa14ded86`.

These are scoped native macOS ARM64 focused/static proofs on the recorded f73 base plus exact worker overlay, whose bytes are now integrated. They have no product accepted-run receipt and do not establish whole-suite, Linux, cloud or production acceptance. All four WSET identities are included in the passing 92 cases; the redundant IPC-disconnect cleanup race is repaired. Earlier 91/92, parent-quarantine refusals and diagnostic failures remain historical, not accepted by this later pass. Stop diagnostics 5/5 and PID1 readiness 203/203 remain separately scoped focused evidence.

Next: publish the coherent source, capture a fresh H/N/F/C contract, bind reviewed runners, run native100/full Node/DOM and the authorized default-stack J1/J4/J2, browser, scheduling, runbook and recovery gates in their required order. One heavy local workload runs at a time; exact-pushed-SHA CI can run concurrently. The preceding f73 CI finished 23 successful jobs, 8 conditional skips and 1 Go/PID1 failure; no green claim transfers to this new source. Cloud/DNS/private-source and accountable release signoff remain externally gated.

Ledger: 10 verified / 66 in progress / 2 planned (78 total; 12.82% verified). All four release flags remain false. [Scoped evidence](evidence/PROD-CI-08/2026-10-12-f73-worker92-static-focused-r9.json) retains exact hashes, limitations and failure history.

### Previous f73 evidence update R5 (historical)


#### Archived R5 queue — historical, 12 October 2026

| Gate | Current evidence | Remaining gate |
| --- | --- | --- |
| Typed worker static checks | Final R8 overlay: ESLint 0, full TypeScript 0, 30 strict held commands; terminal review P for static proof. | No test or accepted run receipt is implied. |
| Worker-child settlement | 92/92 passed twice (old typed R6; final typed R8); each wrapper refused on parent-bracket/capture quarantines, one each. Earlier 83/9 → 85/7 → 87/5 preserved. | Resolve wrapper custody anomalies and produce accepted receipt with clean after-run source proof. |
| R18 | Initial startup refused at source allowlist before tests. Corrected immutable-leaf/source-chain review is source-only P. Prior synthetic 47/47 is not a native run. | Complete native probe after exact chain/source binding; then run the full candidate. |
| WSET | 4/4 diagnostic identities failed harness natural-exit closeout. Children joined, React build 25 modules, production child exit 0; one historical quarantine retained and no after-freeze proof. | Use reviewed R13 instrumentation and satisfy natural close plus source-freeze/custody gates. |
| Exact-source CI | 23 success / 8 conditional skips / 1 Go failure of 32; Verify 24,609/1,925/0; native workflows each 2/2 selected. | Resolve Go baseline and capture coherent CI for the integrated final source. |
| Scoped results | Native100 cleanup P; stop 5/5 and PID1 203/203 focused P. Historical native100 tests remain unaccepted. | Retain scope; no product acceptance inferred. |

The 24-section source/implementation patch is prepared outside the primary tree; integration and fresh source binding remain pending. Ledger is unchanged at 10/66/2 and every release flag remains false.

### Previous f73 evidence update R4 (historical)

#### Archived R4 queue — historical, 12 October 2026

| Gate | Current evidence | Remaining verification |
| --- | --- | --- |
| Exact-source CI | 23 success / 8 conditional skips / 1 Go failure of 32; Verify 24,609/1,925/0; each native workflow 2/2 selected. | Resolve Go baseline and capture CI coherent with the final candidate source. |
| Full R16 | R18 synthetic run passed 47/47 (9+10+24+4), but engine did not start and acceptedRunReceipt is false. | Actual full suite with strict custody and final source freeze. |
| Worker-child settlement | Three 92-case outcomes: 83/9 → 85/7 → 87/5; latest run refused. | Resolve five failures and provide accepted closeout with after-run source evidence. |
| WSET diagnostic | 4/4 identities failed at harness closeout. All 13 ledgers show final absence, one historical quarantine observation remains; production React child exited 0 after 25-module build. Assertions passed except contaminated afterEach; no after-freeze proof, and harness-close cause unresolved. | Use source-reviewed R13 instrumentation, rerun and establish natural harness exit plus final source freeze. |
| Focused results and cleanup | Native100 cleanup reviewed; stop 5/5 and PID1 203/203 focused results passed review. | Keep scopes bounded; historical native100 tests remain unaccepted. |

Source-reviewed fixture compatibility, lifecycle, Docker, and WSET candidates still need scoped runtime verification. Ledger stays 10/66/2; all release flags remain false.

### Previous f73 evidence update R3 (historical)

#### Archived R3 checkpoint — historical, 12 October 2026

Source remains `f73da18901b38c94374b2a101c724c83874191c9` (5,987 entries; content digest `f5466cbc4a945085787e30ff25f4ae4b5cffa613648802395ce941ace6c45b28`; freeze `a1aa925bd5f82807acad822f0cfd91a15cde34b80a6d29493fbdeb9adbfd6c53`).

| Verification item | Latest evidence | Remaining gate |
| --- | --- | --- |
| Full R16 | Historical full report 24,591/1,943/0; held-runner custody refused on orphan PID 64809. R18 R4 ordinary suite passed 9/9; failure-path suite had 9 passes and one test error out of 10 (`IndexError: list index out of range`); the producer refused. | Fix the failure-path fixture/index error, complete the currently running R5 only when it terminates, and obtain accepted full-suite custody plus final source freeze. No accepted full-suite result exists. |
| Worker-child settlement | 83 passed / 9 failed / 0 pending across 92 identities. Absence/custody scope passed review. | Resolve failures and provide after-run source freeze; current proof refused and is not accepted. |
| Candidate compatibility | Source review passed for fixture R6, lifecycle R3, Docker R3, WSET R9. | Runtime verification for each remains pending. |
| Focused diagnostics | Stop 5/5 and PID1 203/203 passed within reviewed focused scopes. | No broader product or native Linux runtime acceptance follows. |
| Native100 | Owned fixture and sticky marker recovery passed review. Historical 100/0/0 command refused; not rerun. | Historical test acceptance remains pending. |
| CI | 23 successful / 8 conditional skips / 1 Go failure across 32 jobs; Verify 24,609/1,925/0; native workflows each 2/2 selected jobs. | Diagnose Go baseline and produce whole-CI success. Cause of PID1 `comm=init` remains unproven. |

Ledger remains 10/66/2 and all release flags remain false. These are verification gates, not feature completion or requirement promotion.

### Prior f73 evidence update R2 (historical)

## f73da189 verification queue update — 12 October 2026

The frozen source is `f73da18901b38c94374b2a101c724c83874191c9` (5,987 entries; content digest `f5466cbc4a945085787e30ff25f4ae4b5cffa613648802395ce941ace6c45b28`; freeze `a1aa925bd5f82807acad822f0cfd91a15cde34b80a6d29493fbdeb9adbfd6c53`).

Current completed evidence is bounded as follows: full R16 reports 24,591 passed / 1,943 skipped / 0 failed, but acceptance was refused after orphan PID 64809 failed custody proof; native100 reports 100/0/0, but acceptance was refused after two child-capture mismatches. The native100 fixture and marker have since been cleaned under the reviewed exact-owner recovery receipt; the historical tests were not rerun and remain unaccepted.

Focused stop diagnostics passed 5/5 and focused PID1 diagnostics passed 203/203. Both reviews limit their scope to focused candidate proofs; neither closes product, native Linux, or release acceptance. The synthetic custody-regression setup failed before any methods ran because the loader denied `__future__.annotations`; the producer refused with exit 2 despite successful custody/source/floor checks. Corrected proof remains pending. Worker R4 source review passed; worker tests and exit fixes remain pending.

The terminal exact-source CI inventory has 23 successful jobs, 8 conditional skips, and 1 failed Go job out of 32. Verify passed 24,609 / skipped 1,925 / failed 0; both native workflows passed 2/2 selected jobs. Go guest PID 1 was `comm=init`; cause remains unproven. There is no numeric skip ceiling in the saved CI evidence.

| Next evidence | State | Acceptance boundary |
| --- | --- | --- |
| R16 orphan custody and accepted full-suite run | Pending | Preserve refusal; no accepted full-suite receipt exists. |
| Native100 historical test acceptance | Pending | Cleanup is complete; original run remains refused and was not rerun. |
| Synthetic custody regression | Pending correction | First launch ran zero test methods; do not count as passed cases. |
| Worker R4 tests and exit fixes | Pending | Source review alone does not establish runtime results. |
| Go PID1 baseline diagnosis and exact-source CI success | Pending | Current CI is failed overall; startup cause is only a hypothesis. |
| Native Linux PID1/runtime acceptance | Pending | Focused 203-case proof is not a native runtime run. |

Ledger stays 10/66/2; release flags remain false. No requirement promotion is proposed.


### Prior-source history

The following dated source sections are preserved as historical records; their earlier “current” states and next steps do not describe this f73da189 update.

### Prior-source history

The preexisting C45/685 and older sections below are preserved as source-bound history; their former current/next instructions do not describe f73da189.

## Current source 685fb836 verification queue — R5

1. Commit and publish the integrated three-file J4 diagnostic change and this evidence update, bind the new clean source freeze, and run the required fresh acceptance chain; the existing focused proofs remain candidate-only.
2. Cleanup R4 has independent terminal PASS for its scoped cleanup receipt: 19 removed, zero remaining, two forced stops, and `acceptedRunReceipt:false`. This does not establish graceful shutdown or fresh J4 acceptance. Preserve R3 refusal history.
3. Execute the corrected native canonical-role R5 candidate under its authorized workflow. The original R4 suite remains failed/unaccepted; invalid `NOINHERIT` seed configuration is distinct from the unproven inner initializer exception.
4. Complete native witness invocation/J2 acceptance; current witness evidence covers image build only.
5. Resolve the historical PROD-CI-07 advisory reconciliation dependency. Current exact-source CI and Verify log capture are terminal; do not report them as pending.
6. Preserve the 10/66/2 ledger, all 78 requirement IDs, and false release flags.

### Historical source snapshots retained below

The following preexisting CFB and earlier-source sections are retained as historical records. Their old “current” headings and next steps describe those dated snapshots, not the 685fb836 status above.

## Current verification status, 12 October 2026 — CFB evidence and integrated verifier fixes

Exact source `cfb715bfcff8049e031e1422c526da4bc13d5d5c` passed full Node/DOM core: **24,578 passed / 1,943 skipped / 0 failed**, with 26,521 reconciled identities. All three exact-source CI workflows finished: **24 successful jobs / 8 conditional skips / 0 failures** across 32 jobs. Architecture-specific native evidence remains separate; skipped jobs remain unverified.

The latest bounded component work has **67 distinct passing cases**: 11 mixed, 35 workflows, 3 Docker, 9 diagnostic, 6 PostgreSQL and 3 stop-grace cases. The combined 12-case run repeated those same nine diagnostics and added three stop-grace cases; TypeScript and ESLint also passed, with independent source and terminal reviews. The five integrated file hashes exactly match the tested candidate. The committed successor still needs fresh full-core, CI and stack acceptance; these focused results do not close milestones.

The failed J4 stack has been removed under reviewed owned cleanup: **19 resources removed, zero remaining**, nine settled held stages, unchanged foreign resources and protected builder/witness, with continuous disk floors preserved. **Two forced stops** are recorded; cleanup is not graceful-shutdown acceptance. The fixture fix gives positively identified disposable infrastructure 60 seconds while keeping workers and unknown roles at 660 seconds, retaining all ownership and forced-stop checks.

PostgreSQL continuation passed six selected cases with 39 filtered, and completed container/credential cleanup. Temporal completion and Docker image cleanup also finished. Original refusals remain preserved. Two patch transport defects were detected and corrected to the exact tested postimages; no new product behavior was introduced by transport correction. Original stop-grace R1 patch bytes were overwritten; its reconstruction is explicitly not exact historical evidence.

**Ledger: 10 verified / 66 in progress / 2 planned =12.82%**, up from9 verified (11.54%) at handoff. All four release flags remain false. Next: commit/push, bind the fresh source contract, run the full suite and native witness, then fresh J4 scheduling, J1 continuation and J2 browser/MFA acceptance. Later local runbook/agent/recovery journeys depend on those fixtures. Cloud/DNS/private-source acceptance, the168-hour trusted cost window and separate production signoff remain external prerequisites. PKG-04's12GiB Docker prerequisite is not met by the current7.75GiB VM; its protected builder cannot be restarted without authorization.

[Reviewed evidence](evidence/PROD-CI-08/2026-10-12-cfb715bf-verification-r1.json) · [Exact-source CI](evidence/PROD-CI-09/2026-10-12-cfb715bf-terminal-ci-r1.json) · [Builder blockers](verification/BUILD-BLOCKERS-2026-10-12.md).

## Current c45 checkpoint, 12 October 2026 — retained evidence snapshot

- Frozen c45 core remains **24,575 passed / 1,943 skipped / 0 failed**; witness image build passed, acceptance invocation pending.
- The focused canary supplement remains 124/0/0 across two memory/PGlite files. The initial wrapper metric failure remains historical; no PostgreSQL or production acceptance follows.
- Carrier 184 CI R4 remains nonterminal: 22 success /8 conditional skips /1 failed /1 running across 32 jobs. `go` failed before acceptance at the guest PID-1 systemd baseline; Verify is running.
- A focused run of the three-file PID-1 diagnostic candidate passed 201/0/0 on the full guest-file target. Its receipt says `acceptedFocusedProof:false`; independent terminal PASS applies only to the focused diagnostic proof, and no native Go rerun or failure fix is claimed. The diagnostics do not weaken the systemd hard gate.
- R13 synthetic preflight: 8/8, independent terminal PASS, wrapper acceptance false. Actual R12 R7 refused on `Aliases:null` before cleanup; marker retained and host watcher join missing. R7 tree: synthetic 3/3 with unaccepted receipt. Parser R4: synthetic 5/5 with independent terminal PASS, receipt unaccepted. Successor census remains HOLD after two pre-engine schema/path defects; R9 is under preparation, with no cleanup run. R13 preparation HOLD; no cleanup authority.
- Ledger remains 10/66/2; all release flags false. Later results supersede this dated snapshot. [Sanitized evidence](evidence/PROD-CI-08/2026-10-12-c45c9591-r18-pid1-and-cleanup-evidence.json).

## Historical c45c9591 in-progress CI snapshot, observed 18:06:58Z

On exact source `c45c95915531799b455b0f21faf7885de05ba6db`, the native CI audit passed all four jobs: both non-emulated packaged-worker architectures passed 22/22 checks each (44 total), and the Linux systemd and Windows ACL selected leaves each passed 1/1. At the 18:06:58Z inventory snapshot, the main workflow had 18 successful jobs, eight conditional skips, zero failures, and two active jobs (`platform-postgres` and `verify`). This was a nonterminal observation superseded by the terminal results above. The separate workflows job passed 1,559 tests in 113 required groups with no failures or skips. The Windows ACL artifact reports 15 sibling tests excluded by selection; these were not executed skips. Native CI results do not establish local J4 acceptance. Full-core verification, the native witness build, and the J1/J4 acceptance journey remain pending. Ledger remains **10 verified / 66 in progress / 2 planned (12.82%)**; all four release flags remain false. No production acceptance or milestone promotion is claimed. [Scoped native and workflow snapshot](evidence/PROD-CI-08/2026-10-11-c45c9591-native-ci-r1.json).

## J4 local worker startup correction, 11 October 2026

The same-source projected worker deterministically refused its missing packaged OpenTofu identity and production Temporal TLS configuration. A genuine native Darwin ARM64 OpenTofu 1.12.5 fixture was packaged from the retained checksum-pinned release archive and its exact executable payload. With explicit disposable local test mode and that verified identity, both actual startup validators returned successfully. This is bounded configuration evidence; it does not reconstruct the original generic J4 failure or establish natural-timer acceptance.

The fixture-only correction preserves production worker identity and authenticated-TLS checks and the exact nine-key maintenance overlay. The final candidate passed all 39 focused tests with zero failures or skips, affected-file lint, and full TypeScript compilation. The initial candidate type errors are preserved; the reviewed optional-UID and literal-type repairs passed the successor checks. New-source CI, full local acceptance, J4 natural timers, and human-CA/J2 journeys remain pending. Ledger remains **10 verified / 66 in progress / 2 planned (12.82%)**, with all four release flags false. [Startup correction evidence](evidence/PROD-CI-08/2026-10-11-55463591-j4-worker-startup-remedy-r2.json).

## Current source 55463591 terminal CI, fresh R16, and marker completion, 11 October 2026

Exact-source CI for `554635916dfc8ce6c74e7b699a24e2f61670bebc` is terminal with 24 successful jobs and eight conditional jobs skipped across three workflows; no job failed or was cancelled. The main workflow had 20 successful jobs, and both native workflows passed 2/2. Verify passed typecheck, lint, unit suites, Smoke, and Gimbal. Its file-level report records 24,590 passed / 0 failed / 1,925 skipped across 26,515 outcomes; this remote report does not provide an exact unique-identity audit. These remote counts are separate from the local R16 counts below. The eight conditional jobs remain unverified. [Terminal CI inventory](evidence/PROD-CI-08/2026-10-11-55463591-terminal-ci-r5.json).

A fresh local R16 run on exact source `554635916dfc8ce6c74e7b699a24e2f61670bebc` returned exit 0 and reported **24,572 passed / 0 failed / 1,943 skipped** across 26,515 collected identities. Before/after source binding matched 5,954 fingerprints. Independent terminal review passed for this R16 run’s source binding, identity arithmetic, custody, and closeout; its scope is limited to this run and does not make the result a production acceptance or milestone promotion. [R16 execution evidence](evidence/PROD-CI-08/2026-10-11-55463591-r16-r1.json).

The exact R3 marker-completion operation returned exit 0 and its independent terminal review passed for the marker transition only: the reviewed owned marker now has empty content, with the same owned inode retained. The original R3 cleanup refusal remains historical evidence; this does not promote any acceptance gate or broaden the earlier R6 cleanup result. [Marker-completion evidence](evidence/PROD-CI-08/2026-10-11-55463591-marker-completion-r3.json).

The latest R15 preparation attempt failed at `j4MachineSchedules` with exit 1 after deferred J1Up and prestart checks passed. The generic CLI output does not localize the cause. A bounded source comparison raises a host ToFu identity / production Temporal configuration gap as a plausible but unconfirmed cause; the original child environment does include its configured CA path, so this does not establish a missing TLS trust file. Both owned trees are settled; the stack is retained for read-only diagnosis, and no human-CA step completed. Read-only R2, R5, and R9 guard diagnostics returned successfully and passed their bounded terminal reviews. R10 imported the default module and returned its diagnostic record, but the wrapper exited 2 when trailing Node SQLite warning text broke its last-line JSON parser; the independent review confirmed capture and child settlement only. R10 did not invoke acceptance and does not reproduce or resolve the original failure. Ledger remains **10 verified / 66 in progress / 2 planned (12.82%)**; all four release flags remain false. Remaining work includes resolving the original J4 failure and completing R15/J2 plus the human-CA journey. No production acceptance or milestone promotion is claimed. [Read-only J4 diagnostics](evidence/PROD-CI-08/2026-10-11-55463591-j4-readonly-diagnostic-r2-r5-r9-r10.json).
A separate read-only catalog check on this source returned successfully and closed its database connection: the three J4 billing/nonce tables each had one fixture row, the current role had INSERT/UPDATE privileges, RLS was enabled but not forced and inactive for that role (which reported bypass), and no mutation was attempted. This describes the catalog state only and does not identify which attempt created the rows or establish acceptance. A separate two-file fixture candidate is independently source-reviewed and its focused suite passed 39/0/0. It uses explicit test mode and genuine absolute OpenTofu identity paths only behind the owned-local J4 fixture gate; production worker identity and TLS checks remain unchanged. This focused result does not establish genuine artifact packaging, current-source CI, or actual J4 acceptance. [Catalog and fixture-candidate evidence](evidence/PROD-CI-08/2026-10-11-55463591-j4-db-catalog-and-fixture-focused-r1.json).

## Historical source 3608084b Verify and native-worker update, 11 October 2026 (superseded by 55463591)

Exact-source CI is terminal with a failure. The main workflow has 19 successful jobs, one failure, and eight conditional skips; across three workflows, 23 jobs succeeded, one failed, and eight conditional jobs were skipped. The Verify failure remains TS7053 in the new packaged-worker boundary test. Verify failed at `tsc --noEmit` with TS7053 in the new packaged-worker boundary test (`tests/ci/packaged-workers.test.ts:174:12`): a callback key widened to `string` indexes a finite inferred object. `npm ci` passed; lint and unit suites were skipped after typecheck. This is a typing error in the new test, not a reported failure in the three packaged-worker implementation files. No full-source typecheck had been run on this change before this result. This change includes the literal-key tuple fix for the three disk-floor keys; both the below-18-GiB rejection and exact-18-GiB acceptance assertions remain unchanged. Before publication, the full-project `npm run typecheck` passed with Node v22.23.3 and the affected-file ESLint check passed. The full Vitest suite was not run, and successor remote CI remains pending; the terminal Verify failure above records the prior source snapshot. [Verify failure and CI snapshot](evidence/PROD-CI-08/2026-10-11-3608084b-verify-ts7053-failure-r1.json).

On the same exact source, native Linux AMD64 and ARM64 packaged-worker jobs each passed all 22 required checks; all six cleanup flags passed for each job. The source gate enforces the 18 GiB disk admission requirement. This is remote native worker-gate evidence only; it does not establish local Mac stack, browser, or PROD-PKG-05 journey acceptance. [Native worker evidence](evidence/PROD-CI-08/2026-10-11-3608084b-native-worker-gates-r1.json).

A separate local cleanup-only R6 outer command returned exit 0, with an execution receipt and terminal-seal hash recorded. Its receipt is not an acceptance receipt. The independent terminal review passed for this owned cleanup settlement only, while the historical marker remains retained pending its separate completion review. This does not establish local stack or browser acceptance or authorize marker removal. No local stack or browser acceptance is claimed. [R6 cleanup observation](evidence/PROD-CI-08/2026-10-11-cleanup-postdown-r6-observation-r1.json).

Ledger remains **10 verified / 66 in progress / 2 planned**; all four release flags remain false. No milestone promotion or source-gap closure is claimed.

## Historical source 62d8da91 packaged-worker admission and cleanup observations, 11 October 2026

The latest recorded exact-source CI inventory is terminal for base commit `62d8da913b523b09ee6d4fa5bd599d524e634e37`: across three workflows, 24 jobs succeeded, eight conditional jobs were skipped, and none failed or was cancelled. The main workflow passed 20/28 jobs; each native workflow passed 2/2. Verify reported 24,587 passed, 0 failed, and 1,925 skipped across 26,512 remote tests. These results apply to the 62d8 base source and do not validate the separate worker-admission candidate in this change. The platform PostgreSQL job also passed on that exact source: 4,105 passed, 0 failed, and 15 skipped; its required identity inventory retained all 1,160 IDs. The changed migration-concurrency case passed 11/11 in 1,620 ms. This is one regression run, not proof that the race is impossible; post-job cleanup absence was not independently established. This change includes the reviewed three-file packaged-worker admission update: the source, temporary, and Docker-root disk gates require 18 GiB; RAM remains 12 GiB total and 8 GiB available, and the runtime reserve remains 8 GiB. The change adds no continuous 18 GiB monitor. A prior CI resource observation measured more than 18 GiB free while the wrapper enforced its 12 GiB threshold; that observation is resource evidence, not worker acceptance. The prepublication worker candidate passed the focused worker suite (139 passed, 0 failed, 6 skipped) and ESLint, and independent source review passed. No actual packaged-worker acceptance run was performed; the 62d8 CI result predates this candidate and does not validate it. [Worker admission repair evidence](evidence/PROD-CI-08/2026-10-11-62d8da91-worker-disk-admission-repair-r1.json). [Terminal CI and PostgreSQL regression evidence](evidence/PROD-CI-08/2026-10-11-62d8da91-terminal-ci-and-pg-regression-r1.json).

A separate cleanup-only attempt remains unaccepted and source-bound to `cf299647df8551f246e04021a8784a7742b06749`. Its R3 wrapper exited 2 with `ObserverRefusal`, leaving the checkpoint incomplete and settlement uncertain. A down command exited 0 and its receipt reports 15 removed, 0 owned resources remaining, and one forced stop; independent review did not accept full cleanup settlement, and no current absence probe is recorded. The historical marker remains retained. [Cleanup attempt evidence](evidence/PROD-CI-08/2026-10-11-cf299647-cleanup-recovery-r3-failure-r1.json).

Ledger remains **10 verified / 66 in progress / 2 planned**; all four release flags remain false. No milestone promotion or source-gap closure is claimed.

## Observed f07030bc CI snapshot and PostgreSQL assertion repair, 11 October 2026

At the observed R6 snapshot, exact-source CI for `f07030bcb4fed1349448161ad5b5fe0708ff66b5` showed 21 successful jobs, eight conditional skips, and three active jobs; no failure was observed in that nonterminal snapshot. It does not establish a green terminal run.

The retained PostgreSQL CI failure is from the prior `a58bb8ff` source: run `38144120018`, job `114483794662`, recorded **4,104 passed / 1 failed / 15 skipped**. The single failing required identity is the concurrent empty-database migration test. The flattened concurrent results contained versions `5–58` followed by `1–4`, with every version present exactly once; the assertion expected ascending order. The failure is the order assertion, not a missing or duplicate version. [a58 PostgreSQL failure evidence](evidence/PROD-CI-08/2026-10-11-a58bb8ff-platform-postgres-failure-r1.json).

This change includes the reviewed one-line numeric sorted-multiset assertion correction: it sorts the flattened applied migration IDs before exact comparison with `ALL`, preserving every one of the 58 IDs exactly once and leaving existing schema-current, ledger-count, and idempotency assertions unchanged. Focused ESLint and one pure migration-manifest test passed on the prepublication overlay; 25 tests were skipped, and that test does not exercise the changed PostgreSQL race. These are prepublication observations, not fresh validation of the published change. Fresh PostgreSQL, full CI, and local acceptance remain pending; this is not a promotion. [Reviewed assertion-repair evidence](evidence/PROD-CI-08/2026-10-11-f07030bc-migration-race-assertion-repair-r1.json).

The failed-prepare cleanup R2 remains incomplete, and new recovery candidates have not executed. Ledger remains **10 verified / 66 in progress / 2 planned**; all four release flags remain false. No milestone promotion or source-gap closure is claimed.

## Historical source a58bb8ff Verify typecheck failure, 11 October 2026

The a58bb8ff exact-source Verify job for `a58bb8ffe95f1c02d2372c6b42cb0f61da5f86a0` failed at `tsc --noEmit` with exit 2. TypeScript reported TS2741 at `tests/release/local-target-module-compatibility.test.ts:14:11` and TS2769 at `:59:17`; both diagnostics arise because typed `ProcessEnv` fixture objects omit required `NODE_ENV`. `npm ci --ignore-scripts` completed, but lint, resource precheck, unit suites, smoke, and Gimbal were skipped after the typecheck failure. The after-unit resource snapshot ran only as an always-run diagnostic and is not test evidence. No test suite or assertion pass is claimed. The original failure evidence remains retained. This change integrates the independently reviewed two-line `NODE_ENV: "test"` fixture correction in the two explicit child-process environment maps; the parent environment is not spread. Focused typecheck, the 2/2 regression, and ESLint checks were recorded on the uncommitted `a58`-based overlay before publication, with the CI heap setting. The initial default-heap typecheck attempt exited 134 from a Node heap OOM without producing TypeScript diagnostics. Fresh successor CI, full-suite validation, and J1/J4 acceptance remain pending. [Focused repair evidence](evidence/PROD-CI-08/2026-10-11-a58bb8ff-node-env-focused-repair-r1.json). [Verify failure evidence](evidence/PROD-CI-08/2026-10-11-a58bb8ff-verify-typecheck-failure-r1.json).

The earlier `cf299647` R16, CI, and native-build results below are historical and remain bound to that source. The failed-prepare cleanup R2 did run and returned exit 2 (`HeldCommandRefusal`), leaving an incomplete checkpoint marked settlement uncertain. Historical process-absence evidence does not prove owned-resource absence; cleanup remains incomplete. A new recovery design is source-only and pending execution. [Cleanup-only observation](evidence/PROD-CI-08/2026-10-11-cf299647-failed-prepare-cleanup-r2-r1.json). Ledger remains **10 verified / 66 in progress / 2 planned**; all four release flags and required evidence remain unchanged. No milestone promotion or acceptance is claimed.

## Historical source cf299647 checkpoint, 11 October 2026

The bounded temporary-storage repair for the pooler probe is integrated at exact source `cf299647df8551f246e04021a8784a7742b06749`. Its focused contract check supports only the bounded probe-command contract.

A separate unchanged-source R16 retry passed the Node/DOM core: **24,567 passed / 0 failed / 1,943 skipped across 26,510 identities and 4,887 suites**. All 26,510 collected/completed identities matched with no duplicates; the 5,934-entry source freeze was stable. Strict custody closed with 53 complete events; one off-root child admission was recorded, then all 15 pending identities were resolved absent, with no quarantine or live children and 24 capture checks without errors. The minimum host free space stayed above the floor, and only this run’s owned data was removed. This is accepted execution evidence for the R16 core retry only. The first attempt’s hard custody refusal remains preserved and unaccepted; the retry does not retroactively accept it. The 1,943 skipped identity set matches the historical accepted run, but those cases remain skipped. [R16 retry](evidence/PROD-CI-08/2026-10-11-cf299647-r16-retry-r1.json) · [Skip-scope comparison](evidence/PROD-CI-08/2026-10-11-cf299647-r16-skip-scope-r1.json) · [First-attempt refusal](evidence/PROD-CI-08/2026-10-11-cf299647-r16-custody-refusal-r1.json).

Exact-source CI is terminal: all **24 required jobs passed** and eight conditional jobs were skipped. The main workflow passed 20/20 required jobs; both native workflows passed 2/2 selected jobs. Verify’s remote unit run reported 24,585 passed and 1,925 skipped across 26,510 tests using two workers. Those remote counts are separate from local R16 and are not combined. [Terminal CI evidence](evidence/PROD-CI-09/2026-10-11-cf299647-terminal-ci-r6.json).

The earlier J2 witness preflight refusal remains preserved. A reviewed cleanup-only rotation then removed the fixed tag without force while preserving the image by its alias. A subsequent native ARM64 build on this same clean source passed with exit 0, runtime user `65532:65532`, pinned base images, and push disabled. The image remains uninvoked; this is build-only evidence and does not establish J2/J1 acceptance. [Preflight refusal](evidence/PROD-CI-08/2026-10-11-cf299647-j2-witness-refusal-r1.json) · [Tag-rotation cleanup](evidence/PROD-CI-08/2026-10-11-cf299647-owned-witness-tag-rotation-r5.json) · [Native build](evidence/PROD-PKG-05/2026-10-11-cf299647-native-witness-r1.json).

The MinIO R11 marker-writer provenance blocker remains unresolved: the marker lacks an exact receipt binding its writer and attempt, so no ledger append or override is supported (review SHA-256 `eb6844bc509dd4390a6ad8c9ee77bcbf3412ef152e83cb95ade003b4d11f4326`). The current R15 preparation attempt ended in a terminal J4 module-transformation failure before acceptance assertions; owned state was retained. [R15 failure evidence](evidence/PROD-CI-08/2026-10-11-cf299647-j1-j4-r15-failure-r1.json).

The J4 machine-schedules driver exited 1 during module transformation because top-level `await` was unsupported under CJS output; acceptance assertions did not run and no test report was produced. The deferred J1-up phase exited 0, and the pre-API and pre-start receipts recorded 13/0/0 and 14/0/0. These receipts show those phases progressed; they do not establish full J1/J4 acceptance. The prepare wrapper retained owned state. Failure-only cleanup R2 terminated with exit 2 (`HeldCommandRefusal`) and an incomplete checkpoint marked settlement uncertain. Its custody record proves historical terminal absence for captured process identities only; it is not a current process query or proof that owned resources were removed. No canonical cleanup receipt or command receipt exists, and no bound host-floor proof is available. Resource cleanup therefore remains incomplete. This change includes the reviewed CLI guard correction and subprocess regression; fresh successor CI and coherent local acceptance remain pending. [Cleanup-only terminal evidence](evidence/PROD-CI-08/2026-10-11-cf299647-failed-prepare-cleanup-r2-r1.json).

Ledger remains **10 verified / 66 in progress / 2 planned**; all four release flags, required evidence, and acceptance criteria remain unchanged. No milestone promotion or source-gap closure is claimed.

## Historical source 2029575f checkpoint, 11 October 2026

Exact-source full R16 passed **24,566 / 0 failed / 1,943 skipped** across 26,509 identities and 4,886 suites. The 5,926-entry source freeze `ee06fae2373fbdd44fee144964dd9a261e87fb53ac937d8c5166263f899467a0` was stable, identity and case counters matched, wrapper exit was 0, and minimum free space was 324,630,163,456 bytes against the 23,622,320,128-byte floor. This proves full-core scope only; skipped identities remain skipped. [R16 evidence](evidence/PROD-CI-08/2026-10-11-2029575f-r16-full-core-r1.json).

Exact-source CI is terminal success for its required lanes: main run `38127637038` passed 20/28 jobs with eight conditional jobs skipped; Native packaged workers and Native skipped platforms each passed 2/2. Verify recorded 24,584 / 0 / 1,925 across 26,509 identities in 1,606.94 seconds. The command configured `--maxWorkers=2`; simultaneous occupancy was not measured, and before/after host snapshots do not establish peak usage. Native ARM64 J2 witness build passed with exit 0 and no push, but the image was not invoked. [Terminal CI evidence](evidence/PROD-CI-09/2026-10-11-2029575f-ci-terminal-r2.json) · [Native build evidence](evidence/PROD-CI-08/2026-10-11-2029575f-j2-native-build-r1.json).

PROD-PKG-06 has scoped contract evidence from the same R16 collection: 104/0/0 across four contract files; 70 separately gated local-engine identities remained skipped. Its required `local_engine` evidence remains unmet, so the requirement stays in progress. [Contract evidence](evidence/PROD-CI-08/2026-10-11-2029575f-pkg06-contract-r1.json).

J1/J4 R13 remains a failed-retain-owned-state preparation (exit 2 before the API-authority pooler probe). Separate read-only diagnostic R4 launched its authority probe but exited 1 before database connection because temporary `tsx` cache creation returned `ENOENT`; no SQL writes occurred. Its wrapper exit 0 only captured that failure. The reviewed 16 MiB UID/GID 1001 tmpfs repair is integrated in this successor. Its isolated candidate passed 19/0/0 focused tests, ESLint0, and independent source review. Fresh full-core, CI, and actual pooler verification remain required for this changed source; the preceding results apply to `2029575f`. [R13 refusal](evidence/PROD-CI-08/2026-10-11-2029575f-pooler-r13-refusal-r1.json) · [R4 diagnostic](evidence/PROD-CI-08/2026-10-11-2029575f-pooler-diagnostic-r4-r1.json) · [tmpfs candidate](evidence/PROD-CI-08/2026-10-11-2029575f-pooler-tmpfs-candidate-r1.json).

Cleanup-only R3 refused before command admission during canonical-path/backlink validation. Cleanup-only R6 returned exit 0 and reports **17 removed / 0 owned remaining / 2 forced stops**. Independent terminal review passed: 18 pending identities resolved absent, with zero live, quarantined, or active identities; 24 bounded ESRCH checks showed no capture exhaustion. Host/VM observers joined without failures, source/freeze and floors passed, custody closed, and the lock is empty and unheld. The original failure and retain receipts remain preserved. This clears owned cleanup only; two forced stops do not establish graceful shutdown, and no pooler readiness, acceptance, or milestone promotion is claimed. [Cleanup evidence](evidence/PROD-CI-08/2026-10-11-2029575f-pooler-cleanup-r6-r1.json).

Joined runner R15, handoff R8 published at the fixed R1 path, outer R17, and issuer R8 remain source-review evidence only; their corrected composition has not completed runtime acceptance. Ledger remains **10 verified / 66 in progress / 2 planned (12.82%)**; all four release flags remain false, with no milestone promotion or source-gap closure.

## CI timeout trial integrated, 11 October 2026

The reviewed canonical core-unit trial now uses two workers and preserves both unfiltered projects, all test and skip gates, and the 45-minute Verify timeout. A focused working-overlay check passed **67 / 0 failed / 0 skipped**, plus ESLint exit 0; all 14 held commands closed strictly, the 5,925-entry source stayed stable, and minimum host free disk was 326,511,194,112 bytes above the 22-GiB floor. This is diagnostic-only evidence. Before/after hosted runner resource snapshots were added without changing gate outcomes; they do not measure peak usage. Fresh committed-source R16 and exact-source CI remain pending; the Ubuntu timeout repair is not yet proven. [Focused evidence](evidence/PROD-CI-08/2026-10-11-daa21596-ci-workers-focused-r1.json).

Ledger remains **10 verified / 66 in progress / 2 planned (12.82%)**; all release flags remain false. The immediate sequence is publish this reviewed trial, run fresh full-core verification, rebuild the native witness, and continue J1/J2/UX/J4 acceptance with the reviewed custody helpers.

## Historical source daa21596 verification update, 11 October 2026

Fresh full R16 on exact source `daa21596ee546cd5498afb8fcd29f94e1fb20b2a` passed **24,566 / 0 failed / 1,943 skipped** across 26,509 unique identities and 4,886 suites in 477.253 seconds. Node reported 23,501 passed and 1,943 skipped; DOM reported 1,065 passed. Collection, completion, and reported identity sets matched. The source freeze `35ec00fa5eef253e86efdf15705fc96b504bc7d9a4b7d9680ff9fc6c2769b454` was stable across 5,922 entries. The wrapper exited 0, and minimum free space was 326,374,715,392 bytes against the 23,622,320,128-byte floor. Skips remain skips. This is full-core execution evidence only, not broader acceptance. [R16 evidence](evidence/PROD-CI-08/2026-10-11-daa21596-r16-full-core-r1.json).

Predecessor source 731 exact-source CI is terminal: main run `38123549396` has 19 successful required jobs, one cancelled Verify job, and eight conditional jobs skipped (28 jobs). The Verify annotation states the 45-minute maximum execution time was exceeded; the run conclusion remains cancelled. Across the three workflows, 23 jobs succeeded, one was cancelled, and eight were skipped (32 jobs total). These results belong to source 731, not `daa21596ee546cd5498afb8fcd29f94e1fb20b2a`. The candidate worker-two trial remains pending review, testing, and new exact-source CI; no fix or acceptance claim is made. [predecessor CI evidence](evidence/PROD-CI-09/2026-10-11-7313824e-terminal-ci-r1.json).

The historical source-731 witness R4 receipt remains refused and incomplete. A separately reviewed cleanup-only resolution records that the exact owned image, tag, and digest alias are absent and the 13 unrelated image rows remain unchanged. It resolves owned-image cleanup only; it does not establish the full pre-build baseline, continuous Docker VM floor status, or acceptance. [cleanup-resolution evidence](evidence/PROD-CI-08/2026-10-11-731-witness-cleanup-resolution-r1.json).

The ledger remains **10 verified / 66 in progress / 2 planned (12.82%)**. All four release flags remain false; required evidence and acceptance status are unchanged. No milestone promotion or source-gap closure is claimed.

## Historical source 7313824e verification update, 11 October 2026

Fresh full R16 on exact source `7313824e3f34615c63ca88cd904c4f3551c34236` passed **24,566 / 0 failed / 1,943 skipped** across 26,509 collected identities and 4,886 suites in 464.313 seconds. Node reported 25,444 identities: 23,501 passed and 1,943 skipped; DOM reported 1,065 passed. The collected, completed, and reported identity sets matched. Skips remain skips. Source freeze `b99d337dd01296b555fd04831ae0faf5f6f3ea0a03e03d39e0872e58fd1f5892` was stable across 5,918 source entries; the minimum free space was above the recorded 22-GiB floor. This is full-core execution evidence, not broader acceptance. [R16 evidence](evidence/PROD-CI-08/2026-10-11-7313824e-r16-full-core-r1.json).

Native R10 built the ARM64 J2 witness image on the same source with exit 0, runtime user `65532:65532`, and no push. The exact owned image remains local and was not invoked. This is a native image-build witness only, not J2 runtime acceptance. [R10 build evidence](evidence/PROD-CI-08/2026-10-11-7313824e-j2-witness-build-r1.json).

Exact-source CI is still in progress. Main run `38123549396` currently shows 19 successful jobs, one active job, and eight skipped jobs (28 total); the Go job is successful, but the workflow has no terminal result yet. Separate native packaged-worker run `38123549401` completed successfully for both Linux/AMD64 and Linux/ARM64. Separate native skipped-platform run `38123549406` passed its selected Linux systemd and Windows ACL leaves only; these are not full platform suites. The supply-chain audit job passed with zero known dependency findings and an empty exception registry; the historical eight-versus-seven advisory discrepancy remains unresolved. These components do not complete the active main workflow. [CI evidence](evidence/PROD-CI-09/2026-10-11-7313824e-ci-progress-r1.json).

The reviewed two-file post-J2 fixture-admission fix is now applied on the source-731 working overlay. The focused check passed both Node syntax checks and ESLint, with all 19 held commands closed strictly, stable 5,918-entry source, joined floor watcher, and passing floors. This is diagnostic-only (`acceptedRunReceipt=false`), not runtime acceptance. Fresh committed-source R16, exact-source CI, native build, and J1/J2/UX/J4 execution remain required. Ledger remains **10 verified / 66 in progress / 2 planned**; all four release flags remain false. No milestone promotion or broader acceptance is claimed. [Focused evidence](evidence/PROD-CI-08/2026-10-11-7313824e-post-j2-focused-r1.json).

## Historical source-f6 focused-preflight status, 11 October 2026

The 34-path candidate is based on source `f6d18a711508551ffe4f5fef81960178056cc3ce`. Earlier focused attempts remain preserved: R3 ran 22/0/0 but refused duplicate case identities; R5 ran 72/0/0 but refused four `any` findings and missing callback closure; R6 ran 72/0/0 plus ESLint0 but TypeScript exited -6 after a V8 heap OOM near 4 GiB. R7’s 6,144-MiB artifact remains preserved and unexecuted. R8 ran 72/0/0 and ESLint0, then TypeScript at 5,120 MiB exited 2 with 11 diagnostics and no OOM. R9 (freeze `184154c4557cecdc5b0781b9227f5bb9fde733a1a78900b3d8da506274cfc35c`) and R10 (freeze `12c7ca56c52cb4fae850d5d5dd226c521cc7c93d44018a6ed8f5e390d8a20bcc`) each recorded 83/0/0 and ESLint0, then refused at TypeScript/custody respectively. R10’s process return code 0 did not establish strict closeout. Preserve those refusals.

R11 passed a strict TypeScript no-emit diagnostic on the older 12c7 freeze, without rerunning tests or lint; it remains diagnostic-only and is not transferable to later source. R13 on freeze `ba9812e3083558b3cedbc2fbac243119f3866e7a16281fabd3f33c97d376bb80` recorded UX receipt 6/0/0 and ESLint0, while the TypeScript command record showed return code 2 and 20 diagnostics (19 TS2345, one TS2790). Independent process-identity capture also failed after bounded retries; custody is uncertain, strict closeout is false, and source-after is unavailable. No physical process termination is inferred. Preserve both the type diagnostics and the capture refusal.

R14 on freeze `d3e7fb7390eef046f0608bc2903c0cb7b0bdceb05de9ad6b306ebeb79641bf9c` (42 paths, 5,913 source entries) passed the focused UX receipt file 6/0/0, ESLint0, and TypeScript0 with 20 strict held-command closeouts, three source checkpoints, child absence, stable source, and floor/watcher checks. This is `passed-diagnostic-only` with `acceptedRunReceipt=false`; it does not establish full acceptance. The R2 UX receipt types fix is now integrated and passed this focused check. UX journey R5 is reviewed and integrated; J4 outer R4 and its live proof R3 are independently reviewed and frozen. R15 R2 refused before child launch because its path list lacked separators; the corrected R3 ran all six JavaScript syntax checks successfully on the 46-path / 5,917-entry source snapshot `51f6aa7efd8ddd9dd818638e71ea731e6ef4a0927dbd598ba24fe23ddc17954f`. All 35 held commands settled strictly, but ESLint found four unused bindings across three J4 modules. That attempt remains refused; its final source-after snapshot is unavailable. The independently reviewed minimal import/binding fix and required module-hash propagation are integrated. R15 R4 passed syntax and ESLint for exactly the three changed modules on the 47-path / 5,918-entry snapshot `f0d46f74d0a0c4a0310b57fc2119a2ed975806560c5dfb8062b0daf128a5cddc`, with all 24 strict held-command closeouts, stable source, joined watcher, and a minimum 328,013,291,520 free bytes. The other three modules retain their unchanged R15 R3 syntax results. J4 outer R5’s pin-only successor also passed independent review and retains live proof R3. These source checks are diagnostic-only; fresh coherent CI, full R16, and actual stack/browser acceptance remain pending. R14 does not validate the newer overlay, and these documentation updates follow the observed source snapshot.

Exact-source CI-09 applies only to f6: 24 required jobs passed, eight conditional jobs remain unverified, and none of the dirty focused overlays is covered by that CI result. After recording the f6-scoped entry, the ledger is 10 verified / 66 in progress / 2 planned; all four release flags remain false. A fresh full R16 on the clean committed and pushed source remains required. No broader acceptance or source-gap closure is claimed. [Focused preflight evidence](evidence/PROD-CI-08/2026-10-11-acceptance-r6-focused-preflight-r6.json) · [Exact-source CI evidence](evidence/PROD-CI-09/2026-10-11-f6d18a71-terminal-ci-r5.json).

## Historical source 760113 update, 11 October 2026

**Historical handoff:** Fresh full R16 passed on exact source `76011357944f9ccda33ba0c33a0fc7b660f12b8f`: **24,552 passed / 0 failed / 1,939 skipped across 26,491 exact identities** (Node 25,426; DOM 1,065). Collection, completion, report, and case identities matched; the 1,939 skips remain visible as skips, not passes. The wrapper exited 0; source freeze `f6a65a481df07826f409970a41f79aee9e04d95538b7e7769fb04256a0032650` remained stable, owned cleanup completed, and disk floors passed. This closes full-core scope only. [R16 evidence](evidence/PROD-CI-08/2026-10-11-760113-r16-full-core.json).

The latest exact-source CI refresh at 05:53:55 UTC is terminal, not green: 23/24 required jobs succeeded and the Go job failed; Verify passed. All eight optional jobs were skipped and remain unverified. Aggregate totals are 23 success / 1 failure / 8 skipped / 0 active (32 jobs). The main CI workflow has 19 success / 1 failure / 8 skipped / 0 active (28 jobs); both native workflows passed 2/2. The Go job remains the known guest-baseline mount-order failure before PID1 tests. A reviewed two-file mount-order repair passed focused diagnostics on a local overlay (tracked-source freeze `d6824172fb1ba76e1d607126effebdf90c5e44adc72ededf7d8d6d4c254c1675`): the whole guest-file-write gate passed 199/0/0 and ESLint passed on the changed TypeScript file. The diagnostic preserves exact test identity and strict identity controls while comparing complete mount rows as an unordered multiset, including all attributes and duplicate counts. The receipt is `passed-diagnostic-only` with `acceptedRunReceipt=false`; the published-source Go failure remains, and fresh CI on the repaired published SHA is pending. [Focused Go repair evidence](evidence/PROD-CI-09/2026-10-11-760113-go-mount-order-focused-r1.json). [Terminal CI evidence](evidence/PROD-CI-09/2026-10-11-760113-ci-terminal-r4.json).

UX03 R7 refused during pre-engine preflight on runner-path alias binding, then on the pinned R17 module being sent to an executable-integrity checker despite its required mode `0400`. The OpenSSL symlink was not the cause: the checker resolves executable paths before hashing. R8 also refused before engine use: the pinned R17 module is mode `0400`, and the executable-integrity checker applies an `X_OK` check. Neither R7 nor R8 used the engine or created owned resources; preserve both refusals. R9 review passed against this source and the fresh R16 binding. Its first invocation refused because the manifest image reference lacked the required tag-mapped reference; a manifest-only correction preserved the original binding. The subsequent real-engine attempt pulled successfully (exit 0) but refused at the approved-image post-pull platform/digest check: observed ID/reference `sha256:c3de60bf2f9dd0ac6370e6117950ff62d6e339527e7472301c9c78a017978392` / `node@sha256:c3de60bf2f9dd0ac6370e6117950ff62d6e339527e7472301c9c78a017978392` did not match required `docker.io/library/node@`. No test started and the R9 run remains refused. A later cleanup-only pass removed only that exact image reference without force, restored the 13-image baseline, confirmed plugin container/volume parity, and passed 15 cleanup commands plus 43 historical held commands under strict custody; host and VM floors passed. Root then verified full baseline restoration, preserved the historical refusal marker, and restored the owned lock to empty. This clears cleanup custody only; it does not adopt R9 or create an accepted run receipt. R10’s canonical-alias fix passed three actual revoke/outage/cancel validator cases (3/0/0, no skips) against this exact source. The run status is `prepared-run-passed`, but `acceptedRunReceipt` is false: this is component-fixture proof only, not milestone acceptance. Root verified 51 strict held-command custody/closeouts, source/freeze binding, full image and plugin baseline parity, completed image cleanup, joined host-floor watcher, and passing host/VM floors. It makes no MinIO, cloud, or browser claim. [R10 component evidence](evidence/PROD-UX-03/2026-10-11-760113-ux03-r10-component-r1.json). [UX03 R7/R8 preflight evidence](evidence/PROD-UX-03/2026-10-11-760113-ux03-preflight-r7-r8.json) · [R9 refusal evidence](evidence/PROD-UX-03/2026-10-11-760113-ux03-r9-result-r3.json) · [R9 cleanup-only evidence](evidence/PROD-UX-03/2026-10-11-760113-ux03-r9-cleanup-r1.json).

Ledger remains **9 verified / 67 in progress / 2 planned**; all four release flags remain false. No milestone promotion, Go/UX03 acceptance, or source-gap closure is claimed.

## Historical source 7bd4 update, 11 October 2026

**Current handoff:** On exact source `7bd4b85d39a73002906173942c622fdbb377ae20`, the R16 attempt recorded 24,548 passed / 1 failed / 1,939 skipped and refused with exit 2; two quarantines remain in that refusal record. Its cleanup-only follow-up returned `ESRCH`. Preserve both results; neither is a passing full-core acceptance. The source-bound PG R7 run passed 75/0/0 across 15 schema cases, 39 UX03 launch/integration cases, and 21 UX03 service cases. Cleanup, custody, source stability, and floors passed for that run. A separate R7 cleanup-only pass has now completed with exit 0: all owned containers, volumes, networks, and credential links were absent; strict custody, source stability, and floors passed. It binds the original failed R6 and interrupted-container-removal records, but does not adopt or change the R6 test result. The R2–R6 PG refusals remain preserved. This cleanup evidence does not promote a milestone. [Cleanup-only evidence](evidence/PROD-CI-08/2026-10-11-7bd4-pg-r7-cleanup-r7.json).

Exact-source CI is terminal: main run `38109790338` has 28 jobs (18 success, 2 failure, 8 skipped); the three-workflow aggregate has 32 jobs (22 success, 2 failure, 8 skipped). Verify failed its timeout-policy assertion (`expected 60 to be less than or equal to 45`); the Go workflow’s six phases passed, but outer binding failed. The six-file CI repair is present as uncommitted, unpushed changes on the 7bd4 primary. The focused R5 diagnostic passed 710/0/0 across four files (release-gates 136, guest-file-write-gate 198, gate-manifest 309, platform-coverage 67), plus lint exit 0, strict custody, source stability, and floors. It ran on the six-file uncommitted 7bd4 overlay with tracked-source freeze `dddcc2bb529e3df2fdc952e28539da27613418a7265a26ea7bef29cff822e751`; the receipt explicitly has `acceptedRunReceipt=false`, so this is focused diagnostic evidence only, not full CI or release acceptance. Earlier R4 duplicate-identity and incomplete-selection refusals remain preserved. The first R5 custody-quarantine attempt also remains a separate refusal; its later process-absence proof is SHA-256 `1c126e8e0030e586ac07f18c54af536c1129eccb6f98984e17426b1fd3e93194`. [Focused R5 evidence](evidence/PROD-CI-08/2026-10-11-7bd4-ci-focused-r5.json). The six CI edits are still dirty, uncommitted, and unpushed; fresh exact-source CI remains pending. Next: fresh integration, then R16, R10, and R9. Ledger remains 9 verified / 67 in progress / 2 planned; all four release flags remain false. No milestone promotion or source-gap closure is claimed. [PG evidence](evidence/PROD-CI-08/2026-10-11-7bd4-wave6-pg-r7.json) · [terminal CI evidence](evidence/PROD-CI-09/2026-10-11-ci-7bd4-terminal-r5.json).

## Historical source 69 queue status, 11 October 2026

**Current handoff:** Source 69 full R16 passed 24,543/0/1,939; the ARM64 witness build passed without push. Reviewed output-cap and namespace-readiness repairs are integrated in this working tree; focused diagnostics passed 195/0/0 and 18/0/0 respectively, with lint. The outer Verify job budget is now 60 minutes; inner gates are unchanged. Failed-stack cleanup completed: 17 removed, zero remaining, two forced stops; all 193 held commands, stable source and host/VM floors passed. Exact witness-tag cleanup also completed with strict closeout and tag absence. These are cleanup/diagnostic results, not graceful-shutdown or J1/J4/J2 acceptance. Original failures remain preserved. Exact source-69 CI remains terminal 22 success / 1 failure / 1 cancelled / 8 skipped across all 32 jobs. Next: commit/pull/push the coherent repairs, then fresh R16 → R10 → R9 and remaining authorized acceptance. Ledger remains 9 verified / 67 in progress / 2 planned, all four release flags false. [Cleanup evidence](evidence/PROD-CI-08/2026-10-11-69-owned-cleanup-r10.json).


- **R16 full core:** completed 24,543/0/1,939 in 458.032 seconds with wrapper exit 0 on source 69; execution receipt confirms source/custody/floor/owned-data checks. Broader acceptance remains open.
- **J2 witness:** R10 ARM64 build exited 0 without push and binds to the R16 receipt. This is build-witness evidence, not runtime or release acceptance.
- **J1/J4:** R9 wrapper exit 2 / child exit 1 at namespace admission (`gRPC 5`) before the J4 body. Retained state remains. Read-only probe observed namespace state 1 and absent schedule owner; no acceptance claim. A separate candidate-focused J4 diagnostic passed 18/0/0 plus ESLint0 after the reviewed one-line expected `withDeadline` count correction from4 to5; the prior R1/R2 focused failures, including the 17/18 result and R1 typecheck receipt remain preserved, and typecheck was not rerun after the test-only line. Primary/candidate source-freeze hashes differ despite matching HEAD, so this does not validate the clean primary or establish J4 runtime acceptance. The R9 admission refusal remains current.
- **Exact-source CI:** Main run 38105216483 is terminal failure: 28 jobs (18 success / 1 failure / 1 cancelled / 8 skipped; Go failed, Verify cancelled). The three-workflow aggregate is terminal: 32 jobs (22 success / 1 failure / 1 cancelled / 8 skipped). The prior r5 active snapshot is historical; Verify’s check-run annotation confirms the 45-minute maximum execution time, while its GitHub conclusion remains cancelled. Artifact-backed lanes are audited separately; their counts are not combined. The output-cap focused overlay passed 195/0/0 plus lint, while prior 47768 remains a refusal at 194/1 due to missing AST helper.
- **MinIO:** secure marker-writer attribution is a hard blocker. No ledger append, base acquisition, or engine probe; preserve markers.

The prior R7 capture-exhaustion refusal and canonical cleanup counts (16 removed / 0 remaining / 2 forced stops) remain in history. Native R14 is an unchanged historical single-case result. Ledger remains **9/67/2**, required evidence is unchanged, and all four release flags remain false. [Current evidence](evidence/PROD-CI-08/2026-10-11-69-current-progress-delta.json).

## Historical source-94 verification queue, 11 October 2026 — R3

This section supersedes older open-queue ordering below. Source remains `94d60798a376c49beaa5c1bc60f14d2e6aa5e430`; ledger remains 9 verified / 67 in progress / 2 planned. Preserve the fresh exact-94 full core (**24,534 passed / 0 failed / 1,939 skipped**) and completed local-gate receipts as scoped passes. Do not requeue an unchanged completed gate; repeat only when its bound source or required inputs change. No ledger promotion or future pass is implied here.

### Current J1 retained-state disposition

The read-only Temporal R4 receipt (`2f1a7645c3f77e70bc7a3ef420bb8004321cbf33c2584d4c4263f45fc0045f1c`) observed the namespace present and the target search attribute absent. It did not mutate Temporal. This answers current namespace/attribute state only; it does not convert the failed J1 journey into acceptance.

R5 and the old R7 wrapper refusal remain historical. The canonical cleanup receipt records 16 removed, zero remaining, and two forced stops (SHA-256 `1a15d8728196df99d21f7a1496ee4e89c2c10da75dfbae62cea792c6398f6982`); no outer-wrapper exit is claimed. Follow-up R4 exited 0 and confirmed current owned-resource absence and both historical process identities absent twice (report SHA-256 `f396bafa8d1dcd1f3c7137204ff7119d3063187d4da09de3e1c030d4bf20f83a`). Host floor was observed clean; no VM floor probe is claimed. This is cleanup-only evidence, not J1/J4/J2 acceptance. [Sanitized reconciliation](evidence/PROD-CI-08/2026-10-11-cleanup-reconciliation-r4.json).

The Go compile-only adapter R3 completed, and its retained container was cleaned in a separate successful cleanup-only lane. Native R8 has terminated with wrapper exit 2 before any case executed; diagnosis is ongoing. The prior native R7 wrapper refusal remains terminal at zero cases and is not a test-assertion failure.

### Other current evidence boundaries

- The Auth restart fault is proven: lean restart started Auth before PostgreSQL became ready, and Auth exited on connection refused. The database-first fix R2 and its six fake-Docker cases remain staged, not integrated or validated. Preserve the existing failed J1 receipt.
- PROD-CI-07’s fresh exact-94 local dependency gate passed with zero findings. The requirement remains open because historical raw reports still disagree on eight versus seven advisories; full historical ID/version/platform and reachability reconciliation is not established.
- J2 fixture R3 has source-only Node syntax and ESLint passes and all 17 receipt-contract identities passed. The held wrapper incorrectly expected six receipt tests and refused while retaining artifacts. Its post-hoc corrected validator expects 17 but has not been run; do not repeat the unchanged wrapper or state that the correction passed. Actual J2/browser acceptance is pending.
- DRV4 tenant R3 focused candidate evidence remains 28 passed / 0 failed / 0 skipped, with lint passing on two candidate files. This is not an operated tenant/export result. MinIO R11 remains source/build evidence; actual export still needs a fresh owned J1 registry, current-run ARM64 runtime image and observed digest, and a separate fresh J1/J2 export fixture. Resolve the reviewed exact-byte composition-hash readiness defect before launching export.

### Ordered next work

1. Preserve the R5 and old R7 wrapper refusals. The canonical cleanup receipt records 16 removed / 0 remaining / 2 forced stops; follow-up R4 confirms owned-resource/process absence. No J1 acceptance is established; continue with remaining source-bound J1/J4 acceptance gates.
2. Native R8 terminated with wrapper exit 2 (`daemon-build-exit`) before any case executed. Preserve the compile-only R3 result separately; this zero-case wrapper refusal is not a failed assertion.
3. Integrate the approved Auth restart fix, DRV4 candidate, J2 fixture R3 and corrected source-validation pins, Go cleanup adapter, and remaining reviewed local-gate preparation into one coherent source. Preserve their original candidate receipts and resolve source conflicts before acceptance.
4. On that exact integrated source, run a fresh full suite and native witness, then the fresh J1/J4 journey with the readiness barriers and current local image/source pins. Keep all previous exact-94 receipts scoped to 94.
5. After J1/J4 readiness, complete the human-approved invocation-scoped SSL CA trust and Auth/login step. Then run actual J2 on a separate fresh owned fixture; real UX/browser acceptance follows only after its required J2 result and cleanup pass.
6. MinIO R5 has two terminal local wrapper refusals on exact source 94d60798; preserve both, await the second PID-absence proof, and continue mapping transport repair. Do not launch a third retry. Builder collector R3 remains diagnostic only; no image build/push mutation or MinIO testcase pass occurred. [Evidence](evidence/PROD-LIFE-11/2026-10-11-minio-r5-runtime-refusals.json). Continue other local tiers independently; no cloud/live-service use or spend is implied.

Existing external blockers remain separate: resource floors, cached/pinned local engines and images, current source binding, human trust/authentication, independent browser/tenant readbacks, owner approvals, and release evidence. Historical R10, source-only checks, unit/lint, compile-only, image-build, and cleanup-only receipts cannot be relabelled as the new operated journey.

---

## Historical source-8e467 checkpoint, 11 October 2026

The exact frozen source `8e4670825b4e6cab15fed8dea4c5c77fd5eeaa9e` passed the root-accepted R16 full Node/DOM core: **24,533 passed / 0 failed / 1,939 skipped across 26,472 exact identities** (25,407 Node, 1,065 DOM, 4,871 suites). The source freeze matched and the wrapper exited 0. Custody recorded 44 events, no drops or quarantines, and all 12 pending births resolved absent with two terminal absence confirmations each. No active processes remained; three cleanup attempts completed and owned data was removed. Minimum free space was 375,583,862,784 bytes, above the 22 GiB floor. This closes core-suite scope only.

The R10 native ARM64 witness image build passed with pinned inputs and runtime user `65532:65532`; the image was not pushed. This is an image-build result, not a complete J2 journey. The human-authorized, independently reviewed SYS1 architecture candidate `32f951ab` is unpushed. Focused validation tested base `8e467` plus reviewed patch `89f9f445`; it passed **194/0/0** with 13 strict commands and lint, and the 6 GiB compiler retry exited 0 after a preserved 4 GiB OOM. The patch was later committed as `32f951ab`; that commit was not the tested source. No actual native Linux image execution or CI acceptance follows from this focused result.

A fresh default-stack attempt on the same source failed at deferred J1-up during the canonical migration build (child exit 1; wrapper exit 2), after Supabase start/migrations and API/worker build had succeeded. A later cleanup-only R3 pass removed all 12 owned resources, left zero, and used no forced stops; source, custody, floor and watcher checks passed. The failed state and joined records remain preserved byte-identically. The runner receipt-path metadata mismatch is retained in the cleanup evidence; this does not accept the failed run or establish J1/J4/J2/default-stack acceptance.

Exact-source CI run **38089224123** is terminal failure: **19 success / 1 failure / 8 skipped**; all four native jobs passed. Verify passed its unit step (**1,139 passed / 94 skipped / 1,233 files**), Smoke, and Gimbal. The Go race portion passed **1,074/0/3 across 22 packages**, but the separate BuildKit fixture failed before PID1 tests because an ARM64 base was pulled where Linux/AMD64 was expected (`exec format error`); cleanup completed. The prior `2f55fda` run is terminal **18 success / 1 failure / 8 skipped / 1 Verify cancellation**; Verify was cancelled by a higher-priority queue annotation, its unit suites were cancelled, and Smoke/Gimbal were skipped. Neither run is green.

Earlier f32 evidence remains separately source-bound: R17 core passed **24,528/0/1,939**; PG10 services passed **38/0/0**; an R15 attempt reconciled the assertion inventory but remained refused; SMTP passed **18/0/0** in a focused candidate test; and a separate J1/J4 cleanup-only pass removed two owned resources without establishing operated acceptance. None of these results transfers to 8e467. MinIO R11 proves cross-compilation and staged binary identity only; Linux/ARM64 runtime remains pending. The R9 historical refusal is permanent; a fresh R9 attempt must use cached inputs and the current source head. [R17 core](evidence/PROD-CI-08/2026-10-11-f32-r17-full-core.json), [PG10 services](evidence/PROD-CI-08/2026-10-11-pg10-services-r6.json), [cleanup-only result](evidence/PROD-CI-08/2026-10-11-j1-owned-cleanup-only.json), [MinIO R11 cross-compile](evidence/PROD-LIFE-11/2026-10-11-minio-r11-cross-compile.json).

The ledger remains **9 verified / 67 in progress / 2 planned** across 78 criteria, with all four release flags false. [R16 core](evidence/PROD-CI-08/2026-10-11-r16-full-core.json), [R10 witness build](evidence/PROD-CI-08/2026-10-11-r10-witness-build.json), [SYS1 focused candidate](evidence/PROD-CI-08/2026-10-11-sys1-apt-platform-r2-focused.json), [retained stack failure](evidence/PROD-CI-08/2026-10-11-j1-default-stack-retained-failure.json), [CI disposition](evidence/PROD-CI-09/2026-10-11-ci-8e467-and-2f55-disposition.json). [cleanup R3](evidence/PROD-CI-08/2026-10-11-j1-failed-stack-cleanup-r3.json)
## Immediate dependency queue, 10 October 2026

1. Publish the integrated lint/diagnostic fixes and evidence; inspect exact-source CI while running the reviewed full R15 core on the same frozen source. Preserve954 full PASS and6612eeaa focused345/0/0 as scoped historical evidence.
2. Resolve retained PG5 custody using the independently reviewed bounded spawn-admission repair; then exact-owned cleanup and real PG6 acceptance. Never retry an unchanged refusal or infer ownership from absence.
3. After current full core acceptance, execute native ARM64 witness R6, joined J1/J4 R4, canonical J1 resume and strict real J2. Require reviewed J2-only cleanup/absence before UX; retain J1 until Auth cleanup.
4. MinIO R6 source review and19 mock contracts passed conditionally; actual signatures, source/SDK build and native runtime remain pending. UX1.3 is conditionally reviewed with17 mock passes; real browser acceptance remains pending.
5. Continue existing OBS-04, MACH-03, OBS-02, MACH-04 and remaining local maps with each prerequisite. COST-03 requires seven continuous days/168 actual hourly samples; external/operational approvals remain separate.

Keep one heavy local workload at a time and all host/VM floors. AirPlay stays off while authorized port5000 tests need it, then restore its prior setting. No cloud spend or production sign-off is authorized.

## Current open queue, 11 October 2026

1. Cleanup-only R3 is complete: the failed default-stack attempt’s 12 owned resources are removed with zero remaining and zero forced stops. Preserve the failed run and receipt-path metadata limitation; no J1/J4/J2/default-stack acceptance is inferred.
2. Publish the human-authorized, independently reviewed architecture fixture change and its evidence through the required pull-before-push sequence; candidate `32f951ab` is not pushed.
3. Pull the reviewed candidate into a clean primary source tree, then run a fresh coherent R16 full-core verification bound to that exact new source. The accepted 8e467 result remains scoped to 8e467.
4. After the fresh core run, repeat the R10 witness on the new source, then retry R9 with cached inputs and the actual new source head. Never relabel prior evidence.
5. Keep exact CI, full default-stack, J4/J2 operated acceptance, browser journey, trust and release approval open until separately evidenced. Continue independent authorized preparation; the terminal CI run is failed, not green.
## Historical integrated CI-08 checkpoint, 10 October 2026

Published source `9543936c8cb1c40a1345cbe92fafeb5382e05c29` passed the reviewed two-worker full R15 Node/DOM run: **24,527 passed / 0 failed / 1,939 skipped across 26,466 exact identities**, wrapper 0 in 481.38 seconds. Source and identity/case counters matched; custody recorded no quarantines; owned temporary data was removed. Minimum free space was 394,202,906,624 bytes, above the 23,622,320,128-byte floor. This establishes core-suite scope only. Skip accounting joins same-process collection/completion identities and checks suite-counter arithmetic; it has no independent suite inventory.

Exact-SHA CI954 is terminal: **22 succeeded / 2 failed / 8 skipped across 32 jobs** (main18/2/8; each native workflow2/2). Verify failed at ESLint before unit suites in `tests/controlplane/services.test.ts`. Go failed at `build-apt-image`, child exit1 before PID1 events; cleanup completed, deeper stderr is unavailable, and the absent OOM marker does not rule out OOM. Platform PostgreSQL passed.

Commits `a211db03` and `6612eeaa` integrate the lint repair and strict closed-enum BuildKit diagnostics. Focused ESLint passed. The R15 regression run on6612eeaa passed **345/0/0 across345 exact identities**, wrapper0, stable source/custody/floors and owned cleanup. Preserve a211db03’s earlier344/1/0 wrapper1 failure (incomplete synthetic cleanup-state whitelist). A fresh full run and exact-source CI remain pending for the next published head; the954 full pass is not evidence for changed source.

PG5 retained-only preflight passed174 recorded identities without resource mutation. Its later cleanup attempt on a211db03 refused at `vm-disk-probe`: the fast direct-child leader vanished before positive initial capture. Custody remains uncertain; no PostgreSQL stop/remove/volume command was reached and no disk-floor breach was measured. Preserve the original and later refusals and retained data. A bounded spawn-admission repair is under independent review.

The ledger remains **9 verified / 67 in progress / 2 planned (11.5% verified)** across78 requirements. Criteria, required evidence and all four false release flags are unchanged. No promotion. See [sanitized evidence](evidence/PROD-CI-08/2026-10-10-9543936c-r15-full.json) and [builder blockers](BUILD-BLOCKERS-2026-10-10.md).

## Current verifier status and builder blockers, 10 October 2026

- f99 focused R4: **582P/0F/2 skipped-gated J4**,584 exact identities, `pendingIdentityCount: 0`; all nine prior failures passed. Compiler/lint f99 exit0; eight changed paths independently reviewed by Sol.
- 975a real-child J4 regression: **3P/0F/0S**,one file/three identities, wrapper0, source freeze and cleanup passed. Full J4 remains open.
- 273b93ee compiler repair: non-incremental5120MiB compiler exit0 and new-test ESLint exit0; private outputs empty. Full Node/DOM and the process-custody successor remain pending.
- CI84 terminal only for predecessor84a: observedAt `2026-10-10T14:40:28+00:00`,18 success/2 failure/8 skipped. Verify failed24,516P/8F/1,921S; eight112-vs-113 assertions. Go failed in BuildKit builder setup before tests; systemd acceptance did not run. Separate native runs succeeded. No exact CI snapshot for f99/975a/273b93ee is available.
- Next: complete full Node/DOM and canonical engine/native gates on coherent273b93ee source, then inspect every job on that exact push. Keep all earlier failed receipts intact.
- Local journey order: J1 -> UX-01 -> OBS-04 -> MACH-03 -> OBS-02 -> MACH-04. Keep AirPlay Receiver off while approved tests need port5000; do not repeat Settings changes. MACH-04 requires genuine Linux PID1 lifecycle and separate default-stack delivery.
- DRV3/4: PostgreSQL17 `pg_dump`/`pg_restore` 17.11 are installed at `/opt/homebrew/opt/libpq@17/bin`; no PATH/service changes and no acceptance run. Temporal CLI1.9.1 is available. Docker is available; reviewed ARM64 digests for PostgreSQL17/MySQL8.4/MinIO remain prerequisites. Cloud spend, DNS/private-app access, retention and release sign-off remain separately authorized decisions.

Ledger CI-08 gets evidence and implementationStatus updates only. All78 states/criteria/dependencies/requiredEvidence remain unchanged (9/67/2); all four release flags false. [Builder-facing dependency list](BUILD-BLOCKERS-2026-10-10.md).


## Browser verification and Linux diagnostics, 10 October 2026

Reviewed source `e8970f2510d617da825b6861e2c3b1023456e152` integrates two browser fixture repairs and bounded reconciliation/SYS1 failure diagnostics. Agent browser **44/44** and hosted browser **24/24** passed on native Mac ARM64 with Node22.23.3 and Chromium141.0.7390.37, with retained case identities, continuous22GiB floor and owned cleanup. Both use synthetic identity and preserve shipping guards; real default Supabase MFA remains pending. Root integrated typecheck5120MiB/lint passed; SYS1 contracts186/0/0 and classifier1/0 passed. No privileged SYS1 execution is inferred.

Actual e854 reconciliation passed **38/0/0** with owned PostgreSQL16.15/TemporalCLI1.9.1, minimum398889807872bytes; container and credentials removed. Exact e854 main CI snapshot:15 success/4 failure/8 skipped/1 active verify; native worker/platform workflows each2 success. Each native worker architecture passed22 checks. Linux reconciliation and SYS1 failure causes remain unknown; successor diagnostics preserve strict admission. Full coherent gates, publication CI and real default-stack acceptance remain pending.

User explicitly selected existing-profile browser acceptance after canceling separate-account setup; no account was created. Temporary user-level SSL trust is planned only for the owned default-stack CA, with exact removal afterward; no trust has been changed at this checkpoint. Live cloud remains unauthorized. Ledger **9 verified /67 in progress /2 planned**,78 criteria and four false release flags remain. [Evidence](evidence/PROD-CI-08/2026-10-10-newmac-browser-checkpoint.json), [every inspected CI job](verification/CI-2026-10-10-e8540c59.md).

## Results: Mac mini successor repairs, 10 October 2026

Integrated repair source `460874751776b8d8bfd648cfb31264b96a266c96`. Evidence retains earlier executed candidate hashes; full coherent gates and publication CI remain pending.

Current pulled e2f27ca8 contains MCP2.2.0 and build heap fixes. Root owned hosted22/0/0, agent40/0/0 and real PG16.15/Temporal recovery10/0/0 passed their limited scopes. Linux ARM64 image build passed after its missing-ledger context repair; combined contracts1961/0/11 passed. Compiler fixture typing and reviewed64-bit filesystem-ID encoding are corrected; affected suites696/0/0 and full5120MiB compiler passed, final Sol review accepted. Mandatory actual SYS1/full coherent local gates/default operated journeys/final pushed CI remain pending. Current mainCI14 success/6 failure/8 skipped; native worker/platform2 successful jobs each are separate evidence. Ledger9/67/2,78 criteria, four release states false; no promotion. [Current results](verification/RESULTS-2026-10.md#mac-mini-repair-verification-10-october-2026).

## Current new-machine entry point, 10 October 2026

Read [Mac mini handoff](HANDOFF-MAC-MINI-2026-10-10.md) first. Includes actual unfinished source packets, hash-verified transfer, final baseline CI and permissions. Supersedes older machine/identity/status summaries; preserves verifier scope and historical evidence. Baseline28ea: main12 success/7 failure/1 cancelled; native worker2 success; native platform2 success. Ledger9 verified/67 in progress/2 planned. Old-host work remains paused; no acceptance run or requirement promotion in this publication.

## Current verifier results, 8 October 2026

Integrated5e5417b9; CI08 root437/0/6, realfreshPG162/0/0(62native), authority92/0/0; compiler/lint/actionlint0. Linux/full/successorCI pending. CI07 reopened for new MCP advisory, upgrade permission pending. Ledger9/67/2 across78; four release states false. No requirement closed. [Exact current context](verification/VERIFIER-C7-REPAIR-PROGRESS-2026-10-08.md).

## Results: Temporal source pin, 8 October 2026

- PROD-CI-08: in_progress; fix b279aac8215ac1ed57ea6ac72bd93100ed6d5289, integration ebd309ac2ec8e6351554285f7674a6433b8255fb; affected295/0/0, complete native successor pending.
- PROD-CI-09: in_progress; exact ed93a676e1b92b8b10c34bc0f7ae5d5437ed59af terminal19/20jobs successful, stale-pin verify failure; fresh pushed CI required.

Results PROD-LIFE-12 (8 October): integrated7427a7d0/fix40012d75; mandatory additiond25b1a85/current1156, gate295/0/0 and coverage/sanitizer174/0/0; native17/0/0 and mixed affected124/0/0, compiler/lint/independent cleanup accepted. Bounded CAS only; common writer coordination/preissued policy/default acceptance remain open. [Evidence](evidence/PROD-LIFE-12/2026-10-08-ownership-snapshot-cas.json).

Results: PROD-CI-09 verified for exact e4c0c237,20/20 terminal CI jobs; PROD-CI-08 native bootstrap86/0/0 plus remote unit21826/0/1637, complete native local gate still pending. [Current milestone](verification/RESULTS-2026-10.md#green-e4-ci-and-native-bootstrap-acceptance-8-october-2026).

## Results: green published baseline, 8 October 2026

Results: PROD-CI-09 verified for exact b9191887 after 20/20 terminal jobs; CI08 remains in_progress. Later root 74729261 native browser 44/0/0 is separately accepted, fresh diagnostic publication CI pending. Original bootstrap/default-stack and external gates stay open. [Every job](verification/CI-2026-10-08-b9191887.md), [current evidence](verification/RESULTS-2026-10.md#green-published-baseline-and-integrated-browser-diagnostics-8-october-2026).

## Publication context, 8 October 2026

Results: PROD-CI-08 remains in_progress; b420d0e1 terminal19/20 jobs, browser43/1, unit21826/0/1637. Provenance fix41333416 focused24/0/0; nativeTofu17/0/0. Two partial Mac browser attempts failed and were cleaned. Isolated diagnostic packetd887c7b7 is reviewed but not integrated or executed. See [current context](WIP-HANDOFF-2026-10-08.md) and [CI jobs](verification/CI-2026-10-08-b420d0e1.md).

## Results update: provenance fixture, 8 October 2026

- PROD-LIFE-09: fix41333416, full provenance contract24/0/0; lint/compiler passed after recorded heap retry. [Evidence](evidence/PROD-LIFE-09/2026-10-08-signature-fixture.json). Default operated isolation acceptance remains open.

## Results update: real skipped cases, 8 October 2026

- PROD-CI-08: five formerly excluded engine identities executed in their exact scopes; Temporal fixture fixed40c53c94/root1/0/0, Tofu10/0/0 and nativePG57/0/0 source10ec, SSM1selected/95filtered source40c. [Results](verification/RESULTS-2026-10.md#real-skipped-case-successors-8-october-2026). No project-wide zero-skip claim; full default acceptance still open.

## Results update, 8 October 2026

- PROD-CI-08: complete remote gate passed on455d12e5,20/20jobs; unit21826/0/1637. Native e5c4 reduced-resource compilation and independent artifact assembly passed their scoped child/closure checks; default-stack acceptance resource-blocked. [Results](verification/RESULTS-2026-10.md#green-tested-ci-and-native-artifact-progress-8-october-2026).
- PROD-CI-09: exact455d12e5 nativeAMD64/ARM64 workers22/0/0 each, all cleanup; new publication CI remains pending. [Every job](verification/CI-2026-10-08-455d12e5.md). Broader requirement states unchanged.

## Results, 8 October kind successor and publication

- PROD-CI-08 Results: integrated12547335 validator; 293 gate plus160 report controls, zero failures/skips. Exact5f4 CI19/20 succeeded; sole pre-repair timeout. New pushed CI pending.
- PROD-MACH-01 Results: scoped kind provider6/release1/guest49 all passed on reviewedddc27415, relevant source parity with0f995b44 and owned cleanup confirmed. Broader evidence states unchanged.
- PROD-MACH-02 Results: local kind49 passes do not verify underlying bearer expiry; independently confirmed builder-owned session-deadline security gap remains open.
- Default Mac Results: fresh0f standalone controller exited1 before terminal receipt, PermissionError during process-group check; no build or cleanup pass claimed.

## Current gate and kind results, 8 October 2026

- PROD-CI-08: in_progress; unchanged title predicate reordered, all293 gate/160 report controls passed, compiler/lint0. Exact successor CI remains mandatory.
- PROD-MACH-01: in_progress; current local kind guest42 passed/7 failed/0 skipped after successful verification. Actual mint reason pending; all original guards retained. Provider6/release1 passed separately; owned cleanup confirmed in a separate receipt.

## Results, native transport successors, 8 October 2026

- PROD-LIFE-11: in_progress; integrated60d78730 MySQL protocol6/0/0 and cleanup;5687 PG2/DNS3/MinIO3 selected cases passed with filtered siblings separate. Wider lifecycle remains open. [Results](verification/RESULTS-2026-10.md#native-transport-acceptance-successors-8-october-2026).
- PROD-CI-08: in_progress; exact5687 native1146/workflows105 succeeded;19/20 jobs success, terminal verify failure:unit21825/1/1637, exhaustive gate-manifest timeout. Final integrated source/push CI pending.

## Results, integrated native checkpoint, 8 October 2026

- PROD-CI-08: in_progress;871f73d9 native platform3762/0/15, all1146 required; new complete CI pending. [Results](verification/RESULTS-2026-10.md#integrated-native-verification-checkpoint-8-october-2026).
- PROD-OPS-03: in_progress; reviewed a8416305 reconciliation38/0/0, all26, integrated871f73d9; previous-release/in-flight upgrade acceptance remains open.
- PROD-LIFE-11: in_progress;871f73d9 MySQL2/Rclone1 selected cases passed; genuine MinIO2/1; PostgreSQL2 passed but cleanup failed; native DNS3 not run. No promotion.

## Results: 8 October publication successor

PROD-CI-08: source105b5ea4 workflows105 failed1376/2/0; sourcea7 native platform runtime3762/0/15 failed strict seven-label binding. Corrective packets not integrated; no verified promotion. PROD-OPS-03: mandatory105 replay activation integrateda1259fdc, scoped34/0/0; combined105 remains failed. Fresh pushed CI pending. See [current context](WIP-HANDOFF-2026-10-08.md).

## Results: mandatory replay integration, 8 October 2026

- PROD-OPS-03 Results: a1259fdc activates105 canonical workflow requirements, preserving71; root metadata463/0/0, SDK replay/audit34/0/0, compiler/lint passed. Full105 lane, previous-release/upgrade proof and fresh CI pending. No promotion.
- PROD-CI-08 Results: bb54ab16 native dispatch successor103/0/0; f38bc8a2 metadata348/0/0. Full1146 PostgreSQL gate and fresh CI pending; earlier failures retained.

## Results: 8 October publication checkpoint

PROD-CI-08: in_progress; c7332a56; native100 successor100/0/0 at5fc3cb2c, native dispatch97/6/0 and failed history recording19/2/1 retained. Full combined gate pending.

PROD-CI-09: in_progress; 3dae8f9a CI13 passed/2 failed/1 running at pre-publication inspection; exact successor CI pending.

[Executed scopes and pending packets](verification/RESULTS-2026-10.md#verification-publication-checkpoint-8-october-2026).

PROD-CI-08: Results sourceb69a6c12 focused native41/0/0;23 PostgreSQL/17 PGlite/1 contract; full mandatory successor pending, earlier65/12/0 retained.

PROD-CI-09: in_progress;9b568108; all20CIjobs inspected14passed/6failed.
[Report](verification/CI-2026-10-07-9b568108.md).

## Results: native migration42 successor

PROD-CI-08: in_progress;9b568108; migration9/0/48filtered, effects96/0/0,
compilerpassed; full9b CI14passed/6failed, all20terminal; no promotion. [Results](verification/RESULTS-2026-10.md#native-migration42-successor-7-october-2026).

## Results: migration42 repair, 7 October 2026

PROD-CI-08: in_progress; `cc9fb51bb639f1e7813a8ad4977b647b24e0d3ad`; local focused8/0/105filtered, nativePG/compiler/CI
pending. [Results](verification/RESULTS-2026-10.md#additive-migration42-repair-7-october-2026).

## Incoming builder CI stop, 7 October 2026

Merged newer builder source `c02c097e79de032e9414c104183961329e834c77`, preserving62 incoming commits and source80 verifier history. Current builder CI: **14 jobs passed /6 failed**; prior80bb7352 green result remains historical. CI08/09 reopened; ledger **10 verified /49 in progress /19 planned**, recomputed across78 rows. All criteria and four false release flags retained. [Every current job, counts and causes](verification/CI-2026-10-07-c02c097e.md), [stop and next work](verification/RESULTS-2026-10.md#incoming-builder-ci-stop-2026-10-07).

Default Mac acceptance also remains resource-blocked. Docker4GiB/swap4GiB settings retained, idle backend stopped, disk23.1GiB. Schema now41 with23 SQL files, six saved worker/package/schema bindings changed; old21-file migration wrapper and source80 standalone build cannot verify current bytes. OBS02 endpoint wiring now exists; actual default acceptance remains open. No builder-owned code or published migration edited. New checkpoint CI is pending until exact pushed SHA is inspected.

Earlier entries retain their exact historical source scope.

## Results: Mac bootstrap and storage, 7 October 2026

Source80bb7352 remote CI20/20 passed. Full default acceptance remains resource-blocked after healthy bootstrap, not a Vitest skip. See [exact scope](verification/RESULTS-2026-10.md#mac-bootstrap-and-storage-2026-10-07).

- PROD-CI-07: Results exact-source remote CI20/20 passed; existing verified state retained; successor publication CI pending.
- PROD-CI-08: Results exact-source remote CI20/20 passed; existing verified state retained; successor publication CI pending.
- PROD-CI-09: Results exact-source remote CI20/20 passed; existing verified state retained; successor publication CI pending.
- PROD-UX-01: Results default acceptance blocked, zero complete cases at80bb7352; prior leaf evidence retained; storage floor and exact prerequisites remain open.
- PROD-OBS-04: Results default acceptance blocked, zero complete cases at80bb7352; prior leaf evidence retained; storage floor and exact prerequisites remain open.
- PROD-MACH-03: Results default acceptance blocked, zero complete cases at80bb7352; prior leaf evidence retained; storage floor and exact prerequisites remain open.
- PROD-OBS-02: Results default acceptance blocked, zero complete cases at80bb7352; prior leaf evidence retained; storage floor and exact prerequisites remain open.
- PROD-MACH-04: Results default acceptance blocked, zero complete cases at80bb7352; prior leaf evidence retained; storage floor and exact prerequisites remain open.

## Reduced-resource local checkpoint, 7 October 2026

Local730 leaf verification passed within scoped evidence; default Supabase startup disk-blocked before tests despite Docker6GiB/swap4GiB. Owned resources removed. Newerc9 fresh install/security/compiler/lint/ledger checks passed; failed resource attempts retained. Docker backend stopped idle; settings retained. Further heavy work blocked below22GiB floor. Ledger12 verified/38 in progress/28 planned; all78 criteria/four false release flags retained. Counts overlap. [Exact results, skips, cleanup and resume](verification/RESULTS-2026-10.md#reduced-resource-verification-7-october-2026).

### Wave 4 (7 October 2026, assembled on prod/compose, build-only; live cloud acceptance deferred by the user)

**Verify waves 1 to 3 first.** Wave 4 shares the migration registry, `tenancy.test.ts`, `platform-bearer.test.ts`, the generated aggregate, `destroy.ts`, `workers/execution/run.ts`, the workflow bundle and the inventory with them. No wave-4 byte has been executed: no vitest, go test, Docker, PostgreSQL, Temporal, kind or cloud run, and no real cloud API was called. Checks run at assembly: typecheck, eslint on the files changed since `ad78c593`, `emit-sql --check`, `capability-matrix --check`, `offered-catalog --check`, `production-ledger --check`, Go `build`, `vet` and `gofmt -l`, `lockfile-integrity`, `generate-tofu-policies --check` and `least-privilege-diff --check`.

**FIRST verifier steps (in this order, before any wave-4 requirement):**
1. Record the workflow-history fixtures: `npm run replay:record` (needs the Temporal test server; `ZENITH_TEST_TEMPORAL=1`), commit `tests/fixtures/workflow-histories` (21 scenario files now: the wave-4 assembly added `mixed-parent-all-children-succeed` and `mixed-parent-child-fails`), run `npm run replay:check`, and only then add the replay lane to `scripts/ci/gate-manifest.mjs` (today `history-replay.test.ts` and `history-record.test.ts` are excluded from the `workflows` lane on purpose, see `REPLAY_OPT_IN_FILES`; the replay lane must stay out of mandatory CI until the fixtures exist).
2. Refresh the cost catalog snapshots online from the public price files (AWS Price List, GCP Cloud Billing Catalog with `ZENITH_LIVE_GCP_CATALOG_API_KEY_FILE`, Azure Retail Prices, OCI price list) with `ZENITH_LIVE_CATALOG_REFRESH=1`, review the report and commit the new dated snapshots (`docs/platform/operations/COST.md` has the steps). The bundled catalog `2026-10-05.2` still has no tiers or extended dimensions.
3. Check the SigV4 test vector in `tests/cost/billing.test.ts` ("reproduces the documented get-vanilla signature") against AWS's published SigV4 test suite before suspecting the signer.
4. Live harnesses stay deferred by user decision: none of the `ZENITH_LIVE_*` gates is set in CI; a skipped live test is never a pass.

### Migrations and shared files as shipped (wave 4)

Platform migrations 37 COST-01/02 `actual_spend`, 38 OPS-02 `fair_bounded_control_plane`, 39 OPS-05/06 `key_custody`, 40 MIX-01/02 `mixed_parent_plans`, 41 MIX-03/04 `mixed_runs` (the workers authored them as 40, 41, 42, 43 and 44 and the assembler renumbered them contiguously after wave 3's 36; the files, ids, constants, verify-doc headers and test expectations were updated; `DEPLOYING.md` checksums were recomputed). The aggregate is `supabase/migrations/0023_platform_core.sql` (migrations 1 to 41); `0016` to `0022` are byte-identical. `emit.ts` grants, `apply-supabase-migrations.sh`, the `DEPLOYING` inventory, `migrations.test.ts`, `platform-coverage.test.ts`, `tenancy.test.ts` (every new repo function classified, plus the join functions the assembler added) and the route count (97, recounted by script) are updated. The sensitive-data inventory classifies every wave-3 and wave-4 table and column (`src/lib/sensitivedata/inventory.ts`, plus an at-rest census check for `plan_custody_grants.wrap_ciphertext`).

Composition order where wave 4 touches the execution core: OPS-02 fairness and quota check BEFORE the authority claim at the four dispatch entry points (MCP execute, bridge lifecycle, bridge destroy, portability start), then authority and durable intent (DUR-A), semantics digest and authorization re-check (DUR-B), plan custody re-verify (DUR-C), external-effect record (DUR-D), then the provider call. LIFE-05/06 DNS ownership proofs are produced inside `guardDns` and bound with `bindDnsProofs` at the same two guard calls of the apply, so they sit between the semantics re-check and the effect record of `destroy.ts`; the review summary carries `dnsOwnership` next to `semantics`.

Joins made at assembly (read these when a combined test fails):
- MIX join: `src/lib/execution/mixed/orchestration-join.ts`. `verifyMixedParent` opens the MIX-03/04 run (deadline = the parent approval's expiry); `advanceMixedChild` syncs finished children, materializes incoming references (`materializeIncoming`) and wraps the real launcher so a `start` run event is recorded immediately before each broker claim; `awaitMixedChild` syncs outcomes and ticks timeouts; `settleMixedParent` cancels the run when the parent is cancelled. A changed parent digest opens a review operation (`mixedParentReviewOf`, never startable) and the consumer waits; `platformParentReviewPort` verifies a live human approval of exactly that digest. Production has no producer output reader (`MixedWorld.childTypedOutputs` is unset), so a plan with cross-partition references is still refused at start; the join is exercised by `tests/execution/mixed-orchestration-join.test.ts`. `mixedParentWorkflow` is in `REGISTERED_WORKFLOW_TYPES` and `RegisteredWorkerActivities`, and the composition test registers `createMixedActivities`.
- DUR-C plan custody now takes its cipher through `vaultCipherFromEnv(process.env, { purpose: "enc:plan-artifacts" })` (same format and AAD; the fail-closed separation checks stay). Verified native contracts must pass unchanged.
- `_lib/mixed.ts` (MIX-01/02 REST helpers) and `_lib/mixed-run.ts` (MIX-03/04 REST helpers) are separate files: both workers created `_lib/mixed.ts`.
- `workers/execution/run.ts` carries both the OPS-02 fair-activity interceptor and the OPS-03 worker deployment options.
- The platform-postgres lane also runs `tests/ops/store.engine.test.ts`; set `ZENITH_TEST_OPS_EXCLUSIVE_PG=1` only on an exclusively owned database.

### PROD-LIFE-03
Doc: [verify/PROD-LIFE-03.md](verify/PROD-LIFE-03.md). `npx vitest run tests/credentials/aws tests/credentials/bootstrap-templates.test.ts tests/credentials/session-policy.test.ts tests/execution/aws-limits-compile.test.ts tests/execution/aws-bootstrap-context.test.ts tests/acceptance/aws-iam-live.test.ts tests/providers/aws/drivers tests/providers/aws/identity`; `npx tsx deploy/aws/tools/generate-tofu-policies.ts --check`; `npx tsx deploy/aws/tools/least-privilege-diff.ts --check`; `cd deploy/aws/tofu-module && tofu init -backend=false && tofu test` (the `hosted_zones_overflow_into_extra_policies` run and the two `expect_failures` runs first). The ECS image pointer moved to `/zenith<suffix>/image-pointer/*`: check the plan diff for an existing environment (pointer replaced, task definition updated) and the orphaned old parameter (DEPLOYING.md, LIMITATIONS.md). Live IAM acceptance is deferred (`ZENITH_LIVE_AWS_IAM=1`, FILE credentials).

### PROD-LIFE-04
Doc: [verify/PROD-LIFE-04.md](verify/PROD-LIFE-04.md). `npx vitest run tests/providers/azure tests/tofu tests/platform tests/connections tests/execution`. Verified contracts changed on purpose and must be checked first: the `deploy.test.ts` audience regex, role assignments with `skip_service_principal_aad_check`, stricter ACR host detection (`tests/providers/azure/{static-checks,deploy,credentials,source-storage,helpers,build-digest}.test.ts`, `tests/tofu/{security-hardening,backends}.test.ts`). `live.test.ts` shows one skipped test. Sovereign clouds are contract-level only; live harness `scripts/acceptance/azure-live.ts` (`ZENITH_LIVE_AZURE=1`) stays deferred.

### PROD-LIFE-05 and PROD-LIFE-06
Doc: [verify/PROD-LIFE-05-06.md](verify/PROD-LIFE-05-06.md). `npx vitest run --maxWorkers=1 tests/providers/oci tests/providers/dns-teardown-proof.test.ts tests/providers/gcp/dns-ownership.test.ts tests/providers/azure/dns-ownership.test.ts tests/execution/destroy-dns-ownership.test.ts tests/execution/destroy.test.ts tests/execution/deletion-guards-clouds.test.ts tests/runners/oci-contract.test.ts tests/runners/oci-payload.test.ts tests/acceptance/non-aws-dns-live.test.ts tests/docs`; Go: `cd go && GOTOOLCHAIN=local go test ./internal/oci/... ./internal/runner/kinds/...` (the allowlist sizes 58/58/11 in `oci_test.go` were hand-edited; `npx tsx scripts/generate-oci-allowlist.ts` reproduces the committed JSON at assembly). `destroy.ts` merged DUR guards with the DNS proofs: read `planStage` and the apply `beforeDispatch` first if `destroy*.test.ts` fails. A pre-existing non-AWS DNS teardown review is refused at apply by design: redo it. Live DNS harness deferred (`ZENITH_LIVE_GCP|AZURE|OCI=1`).

### PROD-COST-01 and PROD-COST-02
Doc: [verify/PROD-COST-01-02.md](verify/PROD-COST-01-02.md). `npx vitest run tests/cost tests/placement tests/docs/operator-docs.test.ts tests/middleware/platform-bearer.test.ts tests/capabilities/routes.test.ts tests/agent-v3 tests/controlplane/tenancy.test.ts tests/security/controlplane-sql-scoping.test.ts tests/controlplane/migrations.test.ts`; PGlite always, PostgreSQL with `ZENITH_TEST_PLATFORM_PG_URL`. See FIRST steps 2 and 3. The MCP tool schema digest (`tests/agent-v3/golden/catalog.json`) must be unchanged. The live billing cases skip with the reason in the title.

### PROD-OPS-02
Doc: [verify/PROD-OPS-02.md](verify/PROD-OPS-02.md). `npx vitest run tests/ops`; `ZENITH_TEST_PLATFORM_PG_URL=... npx vitest run tests/ops/store.engine.test.ts` (and `ZENITH_TEST_OPS_EXCLUSIVE_PG=1` on an owned database for the maintenance-row cases); regression `tests/middleware tests/api tests/runners tests/controlplane tests/workers tests/workflows/config.test.ts tests/docs tests/bridge tests/agent-v3 tests/portability tests/server`. The four dispatch entry points check admission before the claim; confirm that order against the DUR guard tests. Run one worker integration test that builds a worker through `workerOptions` (`tests/workflows/codec-replay.test.ts`) to see the activity interceptor load next to the OPS-03 deployment options.

### PROD-OPS-03
Doc: [verify/PROD-OPS-03.md](verify/PROD-OPS-03.md) (sections 3 and 7). FIRST step 1 above, then `npx vitest run tests/workflows/versioning-audit.test.ts tests/workers/versioning-config.test.ts tests/runners/protocol-window.test.ts tests/ops/rolling-upgrade.test.ts tests/controlplane/migration-compat.test.ts tests/controlplane/migrations.test.ts` (PGlite and PostgreSQL), `ZENITH_TEST_TEMPORAL=1 npx vitest run tests/workflows/upgrade-rehearsal.test.ts tests/workflows/replay.test.ts tests/workflows/deploy.test.ts`, and the runbook dry run (`node scripts/ops/rolling-upgrade.mjs plan ...`). `mixedParentWorkflow` is now a registered workflow type, so its replay scenarios need recording too. The `deploy/k8s` manifests carry placeholder digests. The `workflows` lane excludes the two opt-in replay files; do not re-add them before the fixtures are committed.

### PROD-OPS-05 and PROD-OPS-06
Doc: [verify/PROD-OPS-05-06.md](verify/PROD-OPS-05-06.md). `npx vitest run tests/keycustody tests/sensitivedata tests/security/sensitive-inventory.test.ts tests/security/persistence-leaks.test.ts` (PGlite; add `ZENITH_TEST_PLATFORM_PG_URL` for the leak suite); behaviour that must not regress: `tests/secrets tests/runners tests/machines tests/workflows/codec.test.ts tests/workflows/codec-wiring.test.ts tests/workflows/critical-schedule.test.ts tests/platform tests/server tests/security tests/controlplane tests/capabilities` (plan custody now resolves its key through the registry: `tests/security/plan-artifact-secrecy.test.ts`, `tests/controlplane/plan-custody.test.ts`, `tests/platform/plan-custody-crypto.test.ts` must pass unchanged). The inventory guard was run as a script at assembly (zero gaps); `sensitive-inventory.test.ts` is the real check. DEC-RETENTION: `data-minimize` is a dry run unless `ZENITH_DATA_MINIMIZE_APPLY=1` and `ZENITH_RESULT_RETENTION_HOURS` are set; do not set them on a shared database.

### PROD-MIX-01 and PROD-MIX-02
Doc: [verify/PROD-MIX-01-02.md](verify/PROD-MIX-01-02.md). `npx vitest run tests/execution/mixed tests/execution/mixed-orchestration-join.test.ts tests/execution/mixed-partitions.test.ts tests/acceptance/mixed-evidence.test.ts tests/live`; `npx vitest run tests/controlplane/mixed-parent-plans.test.ts` (PGlite and PostgreSQL); `ZENITH_TEST_TEMPORAL=1 npx vitest run tests/workflows/mixed-parent.test.ts tests/workflows/sandbox.test.ts tests/workflows/replay.test.ts`; regression `tests/controlplane tests/workflows/start-intent.test.ts tests/middleware/platform-bearer.test.ts tests/execution tests/capabilities tests/bridge tests/workers`. The live describe in `tests/live` skips (`ZENITH_LIVE_MIXED=1` plus `ZENITH_LIVE_MIXED_API_URL`, `_WORKSPACE_ID`, `_PLAN_ID`, `_TOKEN_FILE`).

### PROD-MIX-03 and PROD-MIX-04
Doc: [verify/PROD-MIX-03-04.md](verify/PROD-MIX-03-04.md). `npx vitest run tests/execution/mixed-orchestration.test.ts tests/execution/mixed-orchestration-service.test.ts tests/execution/mixed-orchestration-join.test.ts tests/controlplane/mixed-runs.test.ts tests/platform/housekeeping.test.ts tests/server/cron-housekeeping.test.ts tests/middleware/platform-bearer.test.ts` (PGlite, then PostgreSQL). The join with MIX-01/02 is wired in `orchestration-join.ts` (see Joins above); what stays refused is listed in the doc's "Not wired" and in LIMITATIONS (no producer output reader, no drift or migration signals, compiler reference coverage unavailable).

### K8S-CONN (one Kubernetes connection, two roles)
Doc: [verify/K8S-CONNECTION-JOIN.md](verify/K8S-CONNECTION-JOIN.md). `npx vitest run tests/machines/k8s-connection-join.test.ts tests/machines/scoped-guest-session.test.ts tests/machines/default-kubernetes-session.test.ts tests/platform/credentials-verification.test.ts tests/platform/kubernetes-vault-target.test.ts tests/connections tests/bridge/connection-kubernetes.test.ts tests/controlplane/kubernetes-connection-link.test.ts`; kind (disposable cluster): `ZENITH_TEST_KIND=1 KUBECONFIG=<abs private> ZENITH_TEST_KIND_GUEST_CLUSTER=zenith-<n> npx vitest run tests/machines/kubernetes-connection-join-kind.test.ts`. No gate manifest cohort lists the machine tests, so they run in the default vitest job. `scoped-guest-session.test.ts` changed on purpose: observe without a deployer part now expects `deployer_credential_refused`. The CLI create handoff text now mentions the deployer part.

### Wave 3 (7 October 2026, assembled on prod/compose, build-only)

**Verify waves 1 and 2 first.** Wave 3 shares the migration registry, `tenancy.test.ts`, `platform-bearer.test.ts`, the generated aggregate, the platform nav, `destroy.ts`, `ports.ts`, `platform/execution.ts` and the workflow bundle with them. No wave-3 byte has been executed: no vitest, go test, Docker, PostgreSQL, Temporal, kind or cloud run. Checks run at assembly: typecheck, eslint on changed files, `emit-sql --check`, `capability-matrix --check`, `offered-catalog --check`, `production-ledger --check`, Go `build` and `vet`, `scripts/ci/lockfile-integrity.mjs`. Run `npm ci` first (mysql2 is a dependency; the lockfile is unchanged by the assembly).

### Migrations and shared files as shipped

Platform migrations 30 DUR-A `durable_intent_authority`, 31 DUR-B `executable_semantics`, 32 DUR-C `plan_custody_state_recovery`, 33 DUR-D `external_effects`, 34 MACH-02 `k8s_guest_bindings`, 35 UX-02 `mcp_streams`, 36 MACH-06 `coding_agent_runs` (the workers built MACH-02, UX-02 and MACH-06 as 35, 36 and 37 and the assembler renumbered them; files, ids, constants, verify docs and test comments were updated; `DEPLOYING.md` checksums were recomputed). The aggregate is `supabase/migrations/0022_platform_core.sql` (migrations 1 to 36, generated by `npx tsx scripts/platform/emit-sql.ts`); `0016` to `0021` are byte-identical. `emit.ts` hardening now restores the narrower grants of 30, 31, 33, 34 and 36 after the blanket service-role grant (the aggregate path must show the same grants as the direct migrator path; this is the likeliest first migrations.test.ts failure). `scripts/ci/apply-supabase-migrations.sh` applies `0021` then `0022`. Counts: `platform-bearer.test.ts` route inventory is 84 (counted from the route files at assembly). `tests/controlplane/migrations.test.ts` EXPECTED_TABLES gained 16 tables (all carry `workspace_id`). `tenancy.test.ts` classifies the 19 new repository functions (`codingAgentRuns.*`, `k8sGuestBindings.*`, `incidentStability.listRepairsAwaitingVerification`) as workspace-bound; `controlplane-sql-scoping` needed no new entry. Gate manifest: the platform-postgres lane now runs `tests/effects`, `tests/repair/lifecycle.platform.test.ts`, `tests/coding-agent/store.test.ts` and `tests/agent-v3/stream-store.test.ts`, and discovers `tests/effects`, `tests/repair` and `tests/coding-agent` for required Postgres scenarios; the kind suites (`tests/machines/kubernetes-guest-scoped-kind.test.ts`, `tests/providers/kubernetes/lifecycle-acceptance.test.ts`) stay env-gated outside the manifest like the existing kind suites.

Composition order where the DUR branches wrap the same call (destroy, apply, build, proxy): authority and durable intent (DUR-A) then semantics digest and authorization re-check (DUR-B) then worker custody re-verify (DUR-C, inside the `planArtifacts` port wrapper) then external-effect record (DUR-D) then the provider call. Git merged `destroy.ts`, `ports.ts` and `platform/execution.ts` without textual conflicts; the order was confirmed by reading the merged result, not by running it.

Joins made or confirmed at assembly (read these when a combined test fails):
- OBS-01 remediation dispatch goes through the broker `beginExecution` (`src/lib/platform/reconcile.ts` startRepair path), which DUR-B re-authorizes at dispatch (current policy, roles, standing grants).
- DUR-D `proxy_request` effects wrap the mutating `aws.http` and `oci.http` runner proxy requests that DUR-A keeps unkeyed by design; `k8s.http` has no TypeScript sender yet.
- The DUR-B semantics digest includes ownership transfers (LIFE-12), runbook version and definition digest (MACH-03), build context directory and inspected context digest (LIFE-08/09), the migration class (LIFE-10) and adoption claims (LIFE-11 decommission). The digest components were not extended at assembly because they were already present.
- `codingAgentRunWorkflow` is exported from `src/lib/workflows/definitions/index.ts` (the workflow bundle) and its activities are registered in `workers/execution/worker.ts`; nothing was dropped by the merge.
- LIFE-07 and MACH-02: machine sessions use the broker `withSession` with `kubernetesGuest`, so StatefulSet and CronJob pods are reachable through the namespace-wide pod verbs of the guest Role. LIFE-07's own deploy, observe, logs, events, scale and snapshot paths use deploy or observe sessions, which MACH-02 refuses for a `scoped_guest` connection. A new Kubernetes connection therefore defaults to a mode that cannot deploy; the operator needs a legacy connection for deploy and a scoped one for machine access. This is documented (LIMITATIONS, DEPLOYING) and is a product decision to revisit, not a verified design.

### PROD-DUR-01 and PROD-DUR-02
Doc: [verify/PROD-DUR-01-02.md](verify/PROD-DUR-01-02.md). `npx vitest run tests/controlplane/durable-intent-authority.test.ts tests/runners/idempotent-enqueue.test.ts`; with `ZENITH_TEST_PLATFORM_PG_URL`, the same files; real Temporal: `ZENITH_TEST_TEMPORAL=1 ZENITH_TEST_WORKFLOW_START_REQUIRED=1 ZENITH_TEST_PLATFORM_PG_URL=... npx vitest run tests/workflows/start-recovery.test.ts tests/workflows/start-intent.test.ts`; regression: `npx vitest run tests/controlplane tests/platform/critical-jobs.test.ts tests/bridge tests/runners tests/capabilities/routes.test.ts tests/platform/plan-approval-routes.test.ts tests/docs/operator-docs.test.ts`.

### PROD-DUR-03 and PROD-DUR-04
Doc: [verify/PROD-DUR-03-04.md](verify/PROD-DUR-03-04.md). `npx vitest run tests/execution/semantics.test.ts tests/execution/semantics-dispatch.test.ts tests/execution/destroy-semantics.test.ts tests/capabilities/standing-grants.test.ts tests/platform/semantics-approval.test.ts tests/controlplane/executable-semantics.test.ts`; with `ZENITH_TEST_PLATFORM_PG_URL` also the three Postgres files; regression `tests/execution/apply.test.ts plan.test.ts release.test.ts journey.test.ts destroy.test.ts destroy-providers.test.ts tests/workflows/destroy.test.ts tests/platform-ui`.

### PROD-DUR-05 and PROD-DUR-06
Doc: [verify/PROD-DUR-05-06.md](verify/PROD-DUR-05-06.md). `npx vitest run tests/platform/plan-custody-crypto.test.ts tests/tofu/backend-capabilities.test.ts tests/tofu/state-backend-s3.test.ts tests/tofu/state-backend-gcs.test.ts tests/platform/state-session.test.ts tests/security/plan-view-separation.test.ts`; `ZENITH_TEST_PLATFORM_PG_URL=... npx vitest run tests/controlplane/plan-custody.test.ts tests/controlplane/state-backend-recovery.test.ts`; unchanged native contracts must keep their results: `tests/controlplane/cleanup-writer-barriers.test.ts` (100/100), `plan-artifact-retention.test.ts`, `plan-artifacts.test.ts`, `tests/security/plan-artifact-secrecy.test.ts`.

### PROD-DUR-07 and PROD-DUR-08
Doc: [verify/PROD-DUR-07-08.md](verify/PROD-DUR-07-08.md). `npx vitest run tests/effects` (PGlite, and Postgres with `ZENITH_TEST_PLATFORM_PG_URL`); neighbours `tests/platform-ui tests/platform/housekeeping.test.ts tests/server/cron-housekeeping.test.ts tests/execution/destroy.test.ts tests/execution/release.test.ts tests/workflows/failures.test.ts`; real-Postgres verified contracts `tests/controlplane/build-launches.test.ts build-launch-broker-binding.test.ts tests/platform/codebuild-launch-authority.test.ts`. Check specifically that identical mutating proxy requests within one operation are deduplicated by request digest without suppressing a legitimate repeated mutation.

### PROD-OBS-01
Doc: [verify/PROD-OBS-01.md](verify/PROD-OBS-01.md). `npx vitest run tests/repair tests/reconcile tests/workflows/reconcile.test.ts tests/workflows/operations.test.ts tests/controlplane/incident-stability.test.ts tests/incidents`; `ZENITH_TEST_PLATFORM_PG_URL=... npx vitest run tests/repair/lifecycle.platform.test.ts`. Also run a replay-determinism check of the reconcile workflow (it now returns `not_evaluated` where the pre-patch branch behaved differently; return value only, no new commands) against stored histories.

### PROD-MACH-02
Doc: [verify/PROD-MACH-02.md](verify/PROD-MACH-02.md). `npx vitest run tests/providers/kubernetes/guest.test.ts tests/controlplane/k8s-guest-bindings.test.ts tests/machines/scoped-guest-session.test.ts`; broader `tests/machines tests/platform/credentials-verification.test.ts tests/providers/kubernetes tests/connections`; kind: `ZENITH_TEST_KIND=1 KUBECONFIG=<abs private> ZENITH_TEST_KIND_GUEST_CLUSTER=zenith-<n> ZENITH_TEST_KIND_RELEASE_IMAGE=<repo@sha256:..> npx vitest run tests/machines/kubernetes-guest-scoped-kind.test.ts`. Behaviour change: legacy `kubeconfig_ref` guest sessions are refused; `default-kubernetes-session.test.ts` and `kubernetes-kind.test.ts` were re-baselined, and two kind tests (empty namespace, the 401 revocation expectation) changed meaning (documented in the verify doc); confirm neither is a weakening.

### PROD-MACH-06
Doc: [verify/PROD-MACH-06.md](verify/PROD-MACH-06.md). `npx vitest run tests/coding-agent tests/middleware/platform-bearer.test.ts tests/docs/operator-docs.test.ts tests/workflows/sandbox.test.ts tests/platform-ui`; real Temporal `ZENITH_TEST_TEMPORAL=1 npx vitest run tests/workflows/coding-agent.test.ts tests/workers/reconcile-composition.test.ts`. Live evaluation needs a key and is the only evidence for model behaviour: `ANTHROPIC_API_KEY=... npm run eval:coding-agent`. A skipped eval is not a pass; the report must say so.

### PROD-UX-02
Doc: [verify/PROD-UX-02.md](verify/PROD-UX-02.md). `npx vitest run tests/agent-v3 tests/screens/integrations-consent.test.tsx tests/plugins tests/agent-control-oauth.test.ts tests/cli tests/controlplane/migrations.test.ts tests/controlplane/tenancy.test.ts` (Postgres lane: `ZENITH_TEST_PLATFORM_PG_URL=... npx vitest run tests/agent-v3/stream-store.test.ts tests/agent-v3/client-conformance.test.ts tests/agent-v3/oauth-revoke.test.ts`). The `--official` leg of `npm run agent:conformance` needs the devDependency `@modelcontextprotocol/client`, which is NOT installed and was not added (adding it needs user approval). Instead run real Claude Code and Codex against a running Zenith following [docs/platform/CLIENT-INTEROP.md](../../platform/CLIENT-INTEROP.md) (`npm run agent:conformance -- --print-commands` prints the commands). Record those runs as the interoperability evidence; the fetch-client harness is not an official-client result.

### PROD-LIFE-07
Doc: [verify/PROD-LIFE-07.md](verify/PROD-LIFE-07.md). `npx vitest run --maxWorkers=1 tests/providers/kubernetes tests/providers/zenith tests/resources tests/execution tests/ownership tests/incidents tests/capabilities`; real cluster (docker, kind >= 0.33, kubectl): `scripts/k8s/lifecycle-acceptance.sh kind-calico`. Managed-cluster acceptance is deferred. Guest-credential acceptance for StatefulSet and CronJob pods belongs with the MACH-02 kind file once both run.

### OBS-02 and LIFE-11 gap fixes
Doc: [verify/WAVE3-GAPS.md](verify/WAVE3-GAPS.md). `npx vitest run tests/observability tests/execution/machines.test.ts tests/execution/capability-clouds.test.ts tests/machines tests/agent-v3 tests/portability`; real MySQL by DNS name over TLS: `ZENITH_TEST_MYSQL_DNS_TLS_URL=... ZENITH_MYSQL_CA_FILE=/abs/ca.pem ZENITH_PORTABILITY_ALLOW_PRIVATE_HOSTS=1 npx vitest run tests/portability/mysql-inprocess.test.ts`; existing lanes `ZENITH_TEST_MYSQL_URL=... tests/portability/mysql-engine.test.ts` and `ZENITH_TEST_MYSQL_CLI_TLS=1 tests/portability/mysql-cli-tls.test.ts`. The verifier must review the sub-case removed from the gated real-server test in `mysql-engine.test.ts` (it was a refusal expectation that dialled a public address) and the edited `mysql-cli-tls.test.ts` expectations, and confirm neither weakens a verified contract. The MySQL wire fixture (`tests/portability/mysql-wire-fixture.ts`) is hand built: a failure there is more likely the fixture than the transport.

### Wave 3 known risks

- The merge is mechanical in `destroy.ts`, `ports.ts`, `platform/execution.ts`, `operation-review.ts`, the repos index, nav and `bearer-paths.ts`; nothing was run together. Likeliest first breaks: `migrations.test.ts` (aggregate grants after the new hardening block, contiguity, EXPECTED_TABLES), `tenancy.test.ts` (the new WRITES entries assume refusals covered in the owning suites), `platform-bearer.test.ts` (84 was counted, not run), `operator-docs.test.ts` (inventory rows 30 to 36, the five `ZENITH_OBSERVE_*` variables), and `gate-manifest.test.ts`.
- Two sides now touch the same operations: DUR-A authority CAS and DUR-B semantics recheck both run before dispatch; a refusal that names the wrong stage is a composition bug, not a requirement bug.
- Behaviour changes that will fail old fixtures: backend compile refusing non-locking or non-encrypting backends; legacy Kubernetes guest sessions refused; plans without recorded semantics refused at dispatch; `MACH-06` default model id `claude-opus-5-5`.
- DUR-B: provider-direct teardown binding is untested and the standing-grants page has no component test. DUR-C: restore is AWS and GCS only and uses an in-process grant with no operation row; custody does no key re-wrap. DUR-D: identical mutating proxy requests within one operation are deduplicated (check legitimate repeats); the operation status column is not rewritten by effect state.
- MACH-06: `tests/workflows/coding-agent.test.ts` has no recorded replay history; live eval is key gated.
- UX-02: SDK 2.0.0 stream behaviour was read from source only; the official-client leg is not installed.
- LIFE-07: kind plus Calico only; a `scoped_guest` Kubernetes connection cannot deploy (see joins above).
- Live cloud, hosted CI, real Temporal and PostgreSQL, the signed browser approval journey and real clients were never exercised for any wave 3 requirement.

## Results

- PROD-LIFE-01: Results 602/0/1, source730; scoped leaf evidence, broader acceptance remains open.
- PROD-LIFE-08: Results 312/0/1, source730; scoped leaf evidence, broader acceptance remains open.
- PROD-LIFE-10: Results 899/0/13; Temporal21/0/0, source730; scoped leaf evidence, broader acceptance remains open.
- PROD-LIFE-12: Results 236/0/0, source730; scoped leaf evidence, broader acceptance remains open.
- PROD-MACH-05: Results 1526/0/11; security11/0/0; reader15/0/0; Go368/0/2 plus realTofu2/0/0, source730; scoped leaf evidence, broader acceptance remains open.
- PROD-COST-03: Results 449/0/0, source730; scoped leaf evidence, broader acceptance remains open.
- PROD-UX-01: Results resource-blocked default acceptance, zero tests; prerequisite and independent review recorded.
- PROD-OBS-04: Results resource-blocked default acceptance, zero tests; prerequisite and independent review recorded.
- PROD-MACH-03: Results resource-blocked default acceptance, zero tests; prerequisite and independent review recorded.
- PROD-OBS-02: Results resource-blocked default acceptance, zero tests; prerequisite and independent review recorded.
- PROD-MACH-04: Results resource-blocked default acceptance, zero tests; prerequisite and independent review recorded.

## Local startup authorization and bounded result, 7 October 2026

DEC-STARTUP approved for disposable local default API/server startup only. Root executed **2 HTTP / 3 real-browser controls, all passed, zero failed or skipped**, with owned processes, ports and private data removed. Login keyboard and axe scans passed at1280/375px; six nonpublic prefetch requests were blocked. This used an existing warmed build whose source origin is unestablished, not an authenticated operator journey or clean packaged API proof. First fixture failure is retained with separate cleanup recovery. [Scoped result](verification/RESULTS-2026-10.md#local-startup-2026-10-07).

Ledger remains **12 verified / 38 in progress / 28 planned**; all78 criteria and four false release states unchanged. Authenticated default acceptance needs private real Supabase Auth/PostgREST and verified-TLS pooler configuration; shipped7GiB fixture ceilings exceed Docker5.79GiB before Supabase. Default telemetry endpoint/machine-health wiring remains builder work. Cloud/DNS/privateApp and retention/business/signoff permissions remain open; NOT_READY maintenance draft never run. Publisheda370 fullCI20/20 green remains historical until any successor publication is inspected.

Earlier entries retain their historical source and permission scope.

## Coherent verifier result, 7 October 2026

Tested published `d6965d75eb9522527c7a91b06cf8f490f6531d20`: all20 CI jobs completed successfully, with no fresh job-status anomaly. Unit **19,622 passed / 0 failed / 1,532 skipped**. Real PostgreSQL **3,034/0/8**, all1,124 required; workflows **1,275/0/0**, all62; PG **379/0/0**, all93. Native packaged AMD64 and ARM64 each **22/0/0**, no emulation, all cleanup flags. Complete dependency audit zero known findings, no exception. [Fresh job/skip report](verification/CI-2026-10-07-d6965d75.md). Counts overlap and are not summed.

Fresh root transport rerun on that same source: DNS/socket/TLS **27/0/0**, portability regressions **45/0/0**, MySQL **15/0/0**. Contract, protocol-fixture and real-engine scopes are distinct; these are not87 engine or cloud acceptances. Both parent exits0; independent report/case/source/cleanup review accepted. Four setup failures remain recorded, each0 tests, all recovered; corrections only addressed Docker profile representation, mount ordering and exact Docker Desktop binary mapping. No product assertion/gate/TLS weakening. [Transport evidence](evidence/PROD-LIFE-11/2026-10-07-coherent-transports-d6965d75.json).

Ledger **12 verified / 38 in progress / 28 planned**, all78 criteria and four false release flags retained. MySQL DNS-hostname TLS remains explicitly unsupported; wider adoption/backup/decommission, installed-agent update/rollback and default operated journey remain incomplete. Default API/server startup, live cloud/DNS/private GitHub App and retention/business/sign-off decisions remain blocked. Maintenance draft NOT_READY, never run. This evidence-only publication retains the tested source SHA; inspect its successor CI independently. Author/committer Arnav Bule; normal same-branch push after pull --no-rebase. [Results and next steps](verification/RESULTS-2026-10.md#coherent-verifier-source-2026-10-07).

Earlier entries retain their original scope.

## Results, 7 October 2026 repair checkpoint

Inspected f582 CI and local PG/kind passed; CI07/08/09 verified on that exact source. Ledger12/38/28. Integrated d3e test candidate88/0/0; fresh successor CI/native transport rerun pending. Existing skipped cases remain explicitly accounted; no waiver. Earlier tables below are historical.

- PROD-CI-05: verified; tested f582 scoped evidence, d3e for new test controls only; [results](verification/RESULTS-2026-10.md#verifier-repair-checkpoint-2026-10-07).
- PROD-CI-08: verified; tested f582 scoped evidence, d3e for new test controls only; [results](verification/RESULTS-2026-10.md#verifier-repair-checkpoint-2026-10-07).
- PROD-CI-09: verified; tested f582 scoped evidence, d3e for new test controls only; [results](verification/RESULTS-2026-10.md#verifier-repair-checkpoint-2026-10-07).
- PROD-MACH-01: verified; tested f582 scoped evidence, d3e for new test controls only; [results](verification/RESULTS-2026-10.md#verifier-repair-checkpoint-2026-10-07).
- PROD-MACH-03: in_progress; tested f582 scoped evidence, d3e for new test controls only; [results](verification/RESULTS-2026-10.md#verifier-repair-checkpoint-2026-10-07).
- PROD-OBS-02: in_progress; tested f582 scoped evidence, d3e for new test controls only; [results](verification/RESULTS-2026-10.md#verifier-repair-checkpoint-2026-10-07).
- PROD-OBS-03: verified; tested f582 scoped evidence, d3e for new test controls only; [results](verification/RESULTS-2026-10.md#verifier-repair-checkpoint-2026-10-07).
- PROD-LIFE-02: verified; tested f582 scoped evidence, d3e for new test controls only; [results](verification/RESULTS-2026-10.md#verifier-repair-checkpoint-2026-10-07).
- PROD-LIFE-12: in_progress; tested f582 scoped evidence, d3e for new test controls only; [results](verification/RESULTS-2026-10.md#verifier-repair-checkpoint-2026-10-07).
- PROD-COST-03: in_progress; tested f582 scoped evidence, d3e for new test controls only; [results](verification/RESULTS-2026-10.md#verifier-repair-checkpoint-2026-10-07).
- PROD-OBS-04: in_progress; tested f582 scoped evidence, d3e for new test controls only; [results](verification/RESULTS-2026-10.md#verifier-repair-checkpoint-2026-10-07).
- PROD-LIFE-01: in_progress; tested f582 scoped evidence, d3e for new test controls only; [results](verification/RESULTS-2026-10.md#verifier-repair-checkpoint-2026-10-07).
- PROD-LIFE-08: in_progress; tested f582 scoped evidence, d3e for new test controls only; [results](verification/RESULTS-2026-10.md#verifier-repair-checkpoint-2026-10-07).
- PROD-LIFE-09: in_progress; tested f582 scoped evidence, d3e for new test controls only; [results](verification/RESULTS-2026-10.md#verifier-repair-checkpoint-2026-10-07).
- PROD-LIFE-10: in_progress; tested f582 scoped evidence, d3e for new test controls only; [results](verification/RESULTS-2026-10.md#verifier-repair-checkpoint-2026-10-07).
- PROD-LIFE-11: in_progress; tested f582 scoped evidence, d3e for new test controls only; [results](verification/RESULTS-2026-10.md#verifier-repair-checkpoint-2026-10-07).
- PROD-MACH-04: in_progress; tested f582 scoped evidence, d3e for new test controls only; [results](verification/RESULTS-2026-10.md#verifier-repair-checkpoint-2026-10-07).
- PROD-MACH-05: in_progress; tested f582 scoped evidence, d3e for new test controls only; [results](verification/RESULTS-2026-10.md#verifier-repair-checkpoint-2026-10-07).
- PROD-UX-01: in_progress; tested f582 scoped evidence, d3e for new test controls only; [results](verification/RESULTS-2026-10.md#verifier-repair-checkpoint-2026-10-07).
- PROD-UX-03: in_progress; tested f582 scoped evidence, d3e for new test controls only; [results](verification/RESULTS-2026-10.md#verifier-repair-checkpoint-2026-10-07).

- PROD-CI-07: verified f582; audit zero known findings/no exceptions; same results anchor.


## Sharp repair and local package closure, 7 October 2026

Sharp fix `27d47f0770d77487762c992e828683e5f4e55b74` follows transport fix50e08ca6; Arnav author/committer. Human Continue accepted the finite mandatory native bundle scope. Exactly26 official companions updated;886 unrelated lock records unchanged. Independent integration review accepted exact package/lock bytes. Fresh canonical install, lock integrity and complete security audit exited0 with **zero known findings**, no exception. Fresh compiler3GiB heap failure retained; serial4GiB retry passed. Lint and Next production build passed. Package suites **544 passed /0 failed /6 skipped**; six Linux process-supervisor cases remain mandatory CI execution. Real native DarwinARM Sharp0.35.5 PNG roundtrip passed; worker/client/workflow bundles compiled and workflow sandbox passed. These are closure results, not composed/native worker startup acceptance.

[Exact checks, case identities, versions, skips and limitations](evidence/PROD-CI-07/2026-10-07-sharp-27d47f07.json). Local canonical native22 blocked by Darwin8GiB /Docker5.79GiB versus Linux12GiB prerequisites; fresh remote AMD64 and ARM64 required separately. Combined normal push and every exact pushed-SHA CI job pending at this record. Ledger9/41/28 across78, release flagsfalse. Older pending Sharp scope notes below are superseded by this authorized execution; broader default API/cloud/privateApp decisions unchanged.

## Authorized security repair, 7 October 2026

Results PROD-LIFE-11: local transport security fix50e08ca6; PG/S3 72/0/0, MySQL15/0/0; compiler/lint0; in progress, hostname MySQL and wider acceptance open.

Local security fix `50e08ca659d0d49399297f705c5249f246b77ab9`, author and committer Arnav Bule <arnav.bule05@gmail.com>. Production edits confined to `src/lib/portability/**`; tests confined to portability suites. Independent source reviews accepted exact postimages; root executed final committed bytes. Every actual PostgreSQL/S3 connection validates all DNS answers and connects only to validated destination, preserving original TLS hostname identity and HTTP Host/SigV4. MySQL pins validated literal IP with full CA/IP-SAN identity verification; DNS-hostname TLS explicitly refuses because stock CLI cannot preserve original hostname identity on pinned destination. This is a remaining support blocker, not a TLS downgrade.

Executed separately on exact fix SHA: PostgreSQL/S3 **72 passed /0 failed /0 skipped**; MySQL **15 passed /0 failed /0 skipped**. MySQL includes9 contracts,5 actual stock-client TLS protocol-fixture cases,1 actual native Linux MySQL engine case; protocol fixture is not real-engine evidence. Compiler and lint exited0. Native Darwin ARM64 clients and Linux ARM64 engines; no native or emulated AMD64 execution in this repair. Historical fixture failures and compiler exits remain recorded. All owned disposable containers/networks/volumes, temporary credentials and private keys removed with independent absence/custody checks; unrelated services/images preserved. Free disk approximately23GiB.

[Finding, source hashes, independent reviews, executed reports, historical failures and cleanup](evidence/PROD-LIFE-11/2026-10-07-transport-repair-50e08ca6.json). Current ledger **9 verified /41 in progress /28 planned**, all78 requirements and four false release flags unchanged. LIFE11 remains in progress: local transport repair does not close full backup/adoption/decommission acceptance.

Sharp bump remains unapplied pending already-present scope clarification:0.35.5 requires26 official native companion updates, with886 unrelated lock records unchanged in finite metadata plan. No unrelated upgrade, exception or gate edit. Fresh installation/security/lock/build/package/full combined gates and exact pushed CI remain pending. Repair has not been pushed: user requires repair and bump together. Published historical green CI cannot verify this local fix.

Default maintenance draft independently reviewed **NOT_READY_DO_NOT_EXECUTE** and never run. Seeded cleanup-writer epoch contradicts draft's empty-table admission; draft lacks current-source default worker scheduling proof. OBS04 default proof remains blocked. Default product API/server, live clouds/private GitHub App retain DEC-STARTUP/DEC-CLOUD prerequisites. Earlier security-stop notes below are historical; authorization6October reopened only specified repair/bump scope.

## Security stop, 6 October 2026

Verifier stopped under HANDOFF-VERIFIER §7 after independently confirming current LIFE11 destination-custody defect: DNS addresses are checked, then PostgreSQL/MySQL/S3 transports independently resolve original hostname. Required repair spans actual transports, TLS hostname identity and reconnect/retry behavior; existing preflight tests cannot prove containment. No exploit or secret disclosure was executed or claimed. Report-only checkpoint follows group1–2 publication `adb6fb42`; no product fix or requirement promotion. Ledger **9 verified / 41 in progress / 28 planned**, all78 criteria and four false release flags preserved.

Executed before stop: fresh install/compiler/lint/migrations passed; canonical workflows **1275/0/0**, required62; focused runbook/telemetry contracts **113/0/0**; ownership controls **65/0/0**. Counts overlap and are not summed. Plugin233 result remains an independently reviewed local candidate, not root-integrated evidence. Default maintenance drafts were never run. Owned PG container/network/volume removed; unrelated resources preserved; disk26GiB free. [Finding and stop record](verification/RESULTS-2026-10.md#security-stop-prod-life-11-2026-10-06); [precise handoff](verification/VERIFIER-SECURITY-STOP-2026-10-06.md).

Current dependency blocker: sharp0.35.4 / GHSA-wq5f-xc86-pv6w; group1–2 supply-chain job failed with1 finding. CI07/08/09 reopened; no upgrade or exception applied. Primary advisory lists patched0.35.5, within current Next declared range; disposition/provenance/runtime checks remain open. [Dependency receipt](evidence/PROD-CI-07/2026-10-06-sharp-advisory-adb6fb42.json).

Earlier notes retain their original source scope.

## Verifier continuation, group 1–2, 6 October 2026

Tested `ec18bb9c8973787ab16123040d00d7be1407eb08`: fresh installation, compiler, lint and fresh product/platform/agent migrations passed. Full canonical workflows62: **1,275 passed / 0 failed / 0 skipped**, all62 mandatory identities executed. Fresh runbook/telemetry contracts: **113 passed / 0 failed / 0 skipped** across6 files. Counts overlap with other evidence and are not summed. Default maintenance worker effects/health/fallback proof remains in progress; registered runbook delivery and complete default scoped telemetry remain blocked or incomplete. Ledger: **12 verified / 38 in progress / 28 planned**, all78 requirements preserved, all four release flags false.

New author and committer: **Arnav Bule <arnav.bule05@gmail.com>**, per latest human instruction. Existing Saivedant commits remain unchanged. Before every push: `git pull --no-rebase`, merge newer building-machine work, never force. Wave3 source/harnesses remain building-machine owned. Disk free25GiB before next workload; preserve18GiB packaged-worker minimum. Default product API/server startup and external acceptance are not authorized by worker permission. [Group evidence and prerequisites](verification/RESULTS-2026-10.md#verifier-group-1-2-2026-10-06).

Earlier checkpoint notes below are historical, with their original source scope.

## Final published test checkpoint, 6 October 2026

Published `77131a70ec1a25971714f643981475e456c1e2ed`: main 37416369852 all16 jobs and native 37416369867 both jobs terminal success, attempt1. Unit 19521 passed / 0 failed / 1521 skipped; typecheck/lint/Smoke/Gimbal executed successfully. Complete locked dependency audit reports zero known findings, without exceptions or gate weakening. All current seven canonical lanes satisfy their strict required cohorts; native22 each and Linux152/systemd15/custody passed. No mandatory missing/failure/skip waiver. [Exact per-job/source/count/skip evidence](evidence/PROD-CI-08/2026-10-06-ci-77131a70-final.json).

Standard canonical artifacts export matched required groups, not individual raw Vitest assertions. Unit skips remain explicitly accounted by file/source prerequisites; passing same-file groups do not prove every skipped leaf executed. Platform8 are memory/PGlite SQL-only counterparts with six distinct fresh PostgreSQL passes; tofu18 remain conditional source skips. Counts overlap and are never added.

Runnable reported failures are repaired in their recorded scope. Continue fixed20 order; Remaining work is product/default-journey and external acceptance: registered signed guest delivery, default telemetry/session, current-owner/new-writer and preissued-effect limits, measured-cost opt-in, MFA/accessibility, external plugin isolation, installed customer-runner lifecycle, genuine Windows, owned private GitHub App/hosted builder/serving targets and MySQL/S3/provider decommission. No API/server, cloud/account, budget or production permission follows. All78 acceptance criteria, required evidence, dependencies, previous evidence/history and four false release flags are unchanged. OnlyCI07/CI08/CI09 current states are updated after verified771 conditions; totals12 verified/38 in progress/28 planned. Current known-advisory clearance is time-bound; historical8-versus7 raw audit inputs remain unavailable and unreconciled.

Earlier checkpoint notes retain their exact historical source scope.

## Results: current selected20

| Requirement | Status | Tested source | RESULTS record |
|---|---|---|---|
| PROD-CI-05 | verified | `77131a70ec1a25971714f643981475e456c1e2ed` | [current record](verification/RESULTS-2026-10.md#current-prod-ci-05) |
| PROD-CI-08 | reopened_supply_chain_failed / in_progress | `adb6fb422b337bb6b981e99039ad5ce0a6aa45ed` | [security/advisory stop](verification/RESULTS-2026-10.md#dependency-stop-sharp-2026-10-06) |
| PROD-CI-09 | reopened_supply_chain_failed / in_progress | `adb6fb422b337bb6b981e99039ad5ce0a6aa45ed` | [security/advisory stop](verification/RESULTS-2026-10.md#dependency-stop-sharp-2026-10-06) |
| PROD-MACH-01 | verified | `77131a70ec1a25971714f643981475e456c1e2ed` | [current record](verification/RESULTS-2026-10.md#current-prod-mach-01) |
| PROD-MACH-03 | in_progress | `ec18bb9c8973787ab16123040d00d7be1407eb08` | [group1–2 results](verification/RESULTS-2026-10.md#verifier-group-1-2-2026-10-06) |
| PROD-OBS-02 | in_progress | `ec18bb9c8973787ab16123040d00d7be1407eb08` | [group1–2 results](verification/RESULTS-2026-10.md#verifier-group-1-2-2026-10-06) |
| PROD-OBS-03 | verified | `77131a70ec1a25971714f643981475e456c1e2ed` | [current record](verification/RESULTS-2026-10.md#current-prod-obs-03) |
| PROD-LIFE-02 | verified | `77131a70ec1a25971714f643981475e456c1e2ed` | [current record](verification/RESULTS-2026-10.md#current-prod-life-02) |
| PROD-LIFE-12 | in_progress | `77131a70ec1a25971714f643981475e456c1e2ed` | [current record](verification/RESULTS-2026-10.md#current-prod-life-12) |
| PROD-COST-03 | in_progress | `77131a70ec1a25971714f643981475e456c1e2ed` | [current record](verification/RESULTS-2026-10.md#current-prod-cost-03) |
| PROD-OBS-04 | in_progress | `ec18bb9c8973787ab16123040d00d7be1407eb08` | [group1–2 results](verification/RESULTS-2026-10.md#verifier-group-1-2-2026-10-06) |
| PROD-LIFE-01 | in_progress | `77131a70ec1a25971714f643981475e456c1e2ed` | [current record](verification/RESULTS-2026-10.md#current-prod-life-01) |
| PROD-LIFE-08 | in_progress | `77131a70ec1a25971714f643981475e456c1e2ed` | [current record](verification/RESULTS-2026-10.md#current-prod-life-08) |
| PROD-LIFE-09 | in_progress | `77131a70ec1a25971714f643981475e456c1e2ed` | [current record](verification/RESULTS-2026-10.md#current-prod-life-09) |
| PROD-LIFE-10 | in_progress | `77131a70ec1a25971714f643981475e456c1e2ed` | [current record](verification/RESULTS-2026-10.md#current-prod-life-10) |
| PROD-LIFE-11 | security_blocked / in_progress | `ec18bb9c8973787ab16123040d00d7be1407eb08` | [security stop](verification/RESULTS-2026-10.md#security-stop-prod-life-11-2026-10-06) |
| PROD-MACH-04 | in_progress | `77131a70ec1a25971714f643981475e456c1e2ed` | [current record](verification/RESULTS-2026-10.md#current-prod-mach-04) |
| PROD-MACH-05 | in_progress | `77131a70ec1a25971714f643981475e456c1e2ed` | [current record](verification/RESULTS-2026-10.md#current-prod-mach-05) |
| PROD-UX-01 | in_progress | `77131a70ec1a25971714f643981475e456c1e2ed` | [current record](verification/RESULTS-2026-10.md#current-prod-ux-01) |
| PROD-UX-03 | in_progress | `77131a70ec1a25971714f643981475e456c1e2ed` | [current record](verification/RESULTS-2026-10.md#current-prod-ux-03) |

Earlier source-specific guidance remains historical; no missing external/operational level is inferred passed.

## Integrated test checkpoint, 6 October 2026

Runnable PG13/vault1/tool/security failures now have reviewed scoped repairs and local evidence; exact sources and historical failures remain in RESULTS. Next build passed. Kind local55/cleanup passed within explicit limitations; current native packages/fresh CI still require terminal identity/cleanup proof; no mandatory skip can be waived. Preserve the fixed20 order and current9/41/28 states.

Local kind55 and cleanup are terminal passed. Inspect remaining current-source prerequisites without reusing older runtime as fresh. Publish the coherent checkpoint normally on the same branch, then observe every new main/native job and mandatory identity/skip/exit/cleanup receipt. Continue the exact HANDOFF20-ID order only after the CI gate. Default product/browser, Windows, hosted/cloud, private-source and customer-runner prerequisites remain separate; no live account or API startup permission follows.

Earlier checkpoint notes below retain their original source scope.

## Current continuation, 6 October 2026

Local integrated `7c86ad44` has scoped scheduling10/0/0 (eight models plus two actual Temporal cases), JOIN8 within04be453/0/0 and standalone reader15/0/0. Full canonical workflows62 and fresh whole-candidate CI remain pending. Publishedc5f4bd53 is terminal: main15 success/1 supply-chain failure, native2 success/22 checks each; unit19484/0/1519, Smoke/Gimbal passed. [Final per-job evidence](evidence/PROD-CI-08/2026-10-06-ci-c5f4bd53-final.json).

CI07/08/09 remain reopened; ledger9 verified/41 in progress/28 planned,78 criteria and four false release flags preserved. Three dependency findings remain; source-map lock-only authorization is pending and production sprintf/OPA has no validated patch or compatible exception. No upgrade or gate-policy change applied. Next: normal same-branch publication, fresh whole-candidate CI including full62, independent review and builder handoff; the dependency decision remains a separate blocker. Same branch, Saivedant identity; tests and minimal fixes only. Read latest RESULTS before the historical notes below.

## Current 20-requirement checklist

Current state is copied from the ledger; this table changes no acceptance or execution order. CI repair blocks ordered acceptance; JOIN8 is executed preparation, while fullworkflows62 is pending. Historical commands and results below remain source scoped.

| Requirement | Ledger state | Remaining verifier scope |
|---|---|---|
| PROD-CI-05 | verified | Scoped9e contract/local evidence retained; security-dependent complete CI is not green. |
| PROD-CI-08 | in_progress | Resolve approved dependency repair/remaining security blockers, then exact-source complete gates. |
| PROD-CI-09 | in_progress | Push normally and inspect every fresh main/native job; c5 main failed supply-chain. |
| PROD-MACH-01 | verified | Scoped9e acceptance retained; c5 actual152/15 and both cleanup scopes passed. |
| PROD-MACH-03 | in_progress | Route42 passed; registered signed guest/default broker execution remains unproved. |
| PROD-OBS-02 | in_progress | Loopback protocol6 passed; registered-machine/current credential and genuine telemetry-engine join pending. |
| PROD-OBS-03 | verified | Scoped9e native stability evidence retained; no paging/cloud acceptance implied. |
| PROD-LIFE-02 | verified | Scoped catalog criterion retained; strict1c check passed, no provider lifecycle acceptance. |
| PROD-LIFE-12 | in_progress | Seven native ownership guards passed; competing owner/resource-fact and preissued effect limits remain. |
| PROD-COST-03 | in_progress | Optimizer contracts exist; measured collector/explicit opt-in join remains pending. |
| PROD-OBS-04 | in_progress | Actual scheduling2 passed within10; complete canonical62 and default maintenance/health joins pending. |
| PROD-LIFE-01 | in_progress | Current credential rotation/revocation and product/CLI mirror join needs scoped real fixtures. |
| PROD-LIFE-08 | in_progress | JOIN8 covers controlled inspected-context boundaries; actual private App installation lifecycle needs permission. |
| PROD-LIFE-09 | in_progress | JOIN8 preserves attestation floors; actual isolated builder/network/provenance engine proof pending. |
| PROD-LIFE-10 | in_progress | Controlled signed release joins passed; actual build/migration/readiness/cutover engine proof pending. |
| PROD-LIFE-11 | in_progress | Preserve contract and scoped engine evidence; current admitted real PG/MySQL/S3 targets and readback required. |
| PROD-MACH-04 | in_progress | Agent lifecycle controls passed; coherent installed registration/update/rollback journey pending. |
| PROD-MACH-05 | in_progress | Reader15 passed; customer credential/signed execution/current revocation join remains pending. |
| PROD-UX-01 | in_progress | DOM contracts are scoped; real-browser keyboard/focus/axe/screen-reader acceptance pending. |
| PROD-UX-03 | in_progress | Plugin authority contracts are scoped; actual archive hash/isolation launcher and default parent join pending. |

## 6 October current verifier checkpoint

Published9e4a42af completed main16/16 and native2/2 green. Local test-only source1c3913a8 adds route42 and telemetry6, exact combined48/0/0; new successor full CI remains pending. Candidate ledger12verified/38in_progress/28planned,78 criteria/fourfalse retained. Read current RESULTS first; older entries below are history. Same branch, Saivedant author+committer. Next: wave-1 push, held JOIN8/critical1+registration3 actual tests and mandatory62 workflows, combined gate and final per-job CI/builder handoff. Default API/live/cloud permission absent.

## 6 October verifier: main CI passed, one native failure preserved and repaired candidate awaiting rerun

Integrated code `a4c8f0826e4c81cab8199a18abf898e65d4dd2da` fixes only readiness sampling in the packaged-worker harness. Both initial and recovery joins now validate exact HTTP200 and all five readiness checks from one current response; unchanged91-probe/90-delay limits, all22 obligations, downstream Temporal/history/authority/shutdown and owned cleanup remain. Root exact committed affected suites544 passed/0 failed/6 skipped:411 acceptance controls plus133 CI models; six Linux process-supervisor scenarios require native execution. Scoped lint0 and identical reviewed packet compiler0. Changed native runtime remains unverified.

Previous published `99db69d8ad25d78e6d8155506c4a282b5297a2a6` fully observed: main37393944961 **16/16 successful**, native37393944707 **ARM64 success/AMD64 failure**. Unit19416/0/1519; compiler/lint/Smoke/Gimbal executed success. Actual Linux guest152 and all15 ordered systemd cases passed with both cleanup scopes confirmed. Platform3034/0/8 with1124 required, PG322/0/0 with80, workflows1273/0/0 with60, reconciliation38/0/0, intents156/0/0, policy238/0/0 and realTofu3916/0/18 passed strict lanes. Counts overlap and are never summed. AMD failed in `inflight-fresh-worker-recovery` with `worker-readiness-evidence-incomplete`; no mandatory status rows exported, so no partial22 count inferred. Both architectures retained all six cleanup proofs. Exact second response remains unknown; log-classifier `unavailable` identifies no particular health check. Source-supported sampling risk is corrected, not yet a proved runtime cure.

Corrected local source56 finished unit19655/0/1280, policy238/0/0, realTofu3916/0/18; generated/static/Go/security and strict validators0, owned child settled/private data removed. This remains source56 evidence, not changed worker runtime. Previous failures remain retained.

Next: normal same-branch push, observe every new main/native job, then fixed HANDOFF-VERIFIER order. Route42, JOIN8, critical scheduling source1 plus mandatory registration3 remain local reviewed packets, not published implementation. Registration models334/0/0 and lint/compiler0; actual native2 still unrun. A different machine must obtain those packets and receipts, not assume this checkpoint contains them. Default API/server, live cloud, business and operational acceptance remain unapproved. All78 criteria retained:6 verified/44 in progress/28 planned; four release flags false. Commit identity Saivedant Hava. No wave3 features or weakened gates.

Evidence: [complete99 CI](evidence/PROD-CI-08/2026-10-06-ci-99db69d8-final.json), [local56](evidence/PROD-CI-08/2026-10-06-local-56aeb01a.json), [readiness repair](evidence/PROD-CI-08/2026-10-06-readiness-a4c8f082.json).

## 6 October corrected verifier candidate: three local failures repaired, native service acceptance pending

Current integrated code `56aeb01a0bfd306df9135223540c592c12676fd8`: source-pin correction `005cd1cc`, public synthetic fixture modes `7a3c1909`, and strict idle systemd Job correction `56aeb01a`. Independent source reviews retained all100 native identities,152 guest cases,15 service cases, ownership, UID/GID, capabilities, NoNewPrivileges and cleanup guards. Upstream systemd255 prints a present empty `Job=` for an idle job; missing/duplicate/foreign/nonempty values still refuse.

Whole local source228 finished19650 passed/3 failed/1280 skipped. Two failures were stale native100 source hashes; one fixture model assumed0644 despite the gate's077 umask. Child settled and owned data removed; strict gate stopped before security/OPA/OpenTofu. The failed attempt remains retained: [unit receipt](evidence/PROD-CI-08/2026-10-06-unit-22857333.json). Exact successor7a passed both affected suites438/0/0 under077. Reviewed idle-Job packet passed root181/0/0; this is packet-postimage contract evidence, not native service execution. Actual integrated56 passed full compiler/lint. [Correction scope](evidence/PROD-MACH-01/2026-10-06-systemd-fixture-corrections.json).

Published `45b853afbb519ddc85372c5c43c451943471c766` is now terminal: main run37390088534 has14 successful/2 failed jobs (Go,Verify); native37390086824 has2 fresh successes,22 cases and six cleanup proofs each nativeAMD64/ARM64. Verify19412 passed/2 failed/1519 skipped; both failures are the repaired source-pin comparisons. Typecheck/lint passed; Smoke/Gimbal skipped. Go152 and goldens passed, but service setup failed at `setup-unit-poststate`;15 cases unexecuted, service cleanup failed/canonical cleanup skipped. Platform3034/0/8 with1124 required (1107 PG plus17 SDK), PG322/0/0 with80, workflows1273/0/0 with60, policy238/0/0, OpenTofu3916/0/18, reconciliation38/0/0 and intents156/0/0 passed in separate lanes. No overlapping sums. [Every job and source-bound counts](evidence/PROD-CI-08/2026-10-06-ci-45b853af-final.json). Corrected56 still requires complete new observation.

Corrected56 full local gate is running in a clean isolated worktree; actual service15 plus both cleanups and every final pushed CI job remain required.

No requirement promotion:78 original criteria,6 verified/44 in progress/28 planned, four release flagsfalse. Same branch/Saivedant identity. MACH03 route42 and wave2 joins8 remain held; two real critical-schedule tests are being prepared independently. Next: finish coherent gates, publish fixes/evidence normally after predecessor terminal, inspect native service execution, then fixed wave1/wave2 order. Default API/server, live resources and broader building-agent capability gaps remain open.

Current integrated verifier code `22857333`: actual PostgreSQL source80a4 passed native100100/0/0, platform3034/0/8, PG322/0/0, workflows1273/0/0, reconciliation38/0/0, intents156/0/0 and migrations/strict validators; owned cleanup confirmed. Fresh kind228 provider6/release1/guest48 all0F0S and cleaned. Linux custody fix57c30782 has root179/0/0 and independent source review; real systemd15 and full new CI still required. Full local gate currently running on frozen228. See latest [RESULTS](verification/RESULTS-2026-10.md); older chronology remains source-scoped. Same branch, Saivedant identity,20 verifier obligations/78 original criteria/four false release flags preserved.

## 6 October current verifier: workflow correction committed, combined candidate failed

Primary code `59d583884f5d34eb452eddd984a23c10676f8b56` fixes only two stale systemd workflow-condition expectations after independent review. Root111 passed /0 failed /0 skipped and scoped lint passed. Production guards, exact conditions and cleanup fence remain intact. Diagnostics `1aeed6e6` still await hosted execution.

Published `cd71457de4503d69e0828eaba611833ad743b852` is now terminal: main run37380124397 has14 successful /2 failed jobs (Go and Verify); native run37380124506 has2 successful jobs, each22 checks and six cleanup proofs on fresh native AMD64/ARM64. Unit19400 passed /2 failed /1515 skipped; both failures were the corrected expectations. Go152 and goldens passed, but systemd setup and cleanup refused; new15 cases, subsequent root cleanup and interop/crossbuild steps did not execute. Smoke/Gimbal skipped after Verify failure. No complete CI success.

Isolated LIFE-12 candidate `6bdf5adf1acd678e3df986fffbb210874c280839` executed seven real PostgreSQL ownership/race controls successfully. Combined gate failed: native10099/1/0; platform3030/4/8; PostgreSQL322/0/0; workflows1273/0/0; reconciliation38/0/0; intents154/2/0. Reports overlap and are not summed. Fresh/reapply/published27-to29 upgrade and Supabase migrations passed. All owned container/volume/image cleanup proofs passed, baseline resources preserved. [Candidate evidence](evidence/PROD-LIFE-12/2026-10-06-pg-6bdf5adf.json).

Reviewed corrections preserve all100 native identities and add explicit foreign-tenant coverage for the new ownership helper. Two remaining historical-schema failures require a narrow fixed-literal claim query: private null ownership result uses the original query; non-null retains every guarded predicate. No published migration changes or schema-probing bypass. Current repair is not runtime accepted or root-integrated. Default API/server, live accounts and wider build-agent feature gaps remain separate blockers. All78 criteria,6 verified/44 in progress/28 planned, and four false release flags remain unchanged.

Current verifier successor `1aeed6e6`: reviewed fixed-phase systemd diagnostics/root174pass. Published predecessor `cd71457d` main14success/1Go setup failure/1Verify pending; nativeARM/AMD22 each passed. Complete predecessor observation before pushing successor; actual systemd15 still unexecuted. LIFE-12 safety repair remains unintegrated pending review and native PostgreSQL races. HANDOFF-VERIFIER fixed20 order supersedes historical instructions below; Saivedant identity and same branch.

# Verification queue (for the verifying agent)

Current verifier code checkpoint: `7d1a89fb`, exact local PostgreSQL acceptance at `3346e4d4`; prior published `68a1f3b7` CI14 success/2 failure, nativeARM22 success/AMD recovery failure. Fresh pushed CI remains required. Read latest RESULTS and evidence above older chronology; preserve newer ancestry and user files. Tests/minimal fixes only; Saivedant identity; HANDOFF-VERIFIER fixed order applies.

Current override: branch `codex/production-2026-10-02`, candidate `5f4713a7`, Saivedant Hava <saivedant169@gmail.com>. Retain all20 verifier obligations and fixed order. CI repair not complete; actual executed counts in latest RESULTS section. Older prod/compose and Arnav instructions below are historical and superseded by human authorization.

> Scope contract and required deliverables: [HANDOFF-VERIFIER.md](HANDOFF-VERIFIER.md). Read it first.

Branch to verify: `prod/compose`. Verify the exact tip you checked out; run `git rev-parse HEAD` first and record that SHA in every piece of evidence. If you push fixes, the new tip is the SHA that evidence must name.

Nothing below has been executed by the builders. Every requirement here is `implementation_complete_verification_pending` in `ledger.json`. Typecheck, eslint, `emit-sql --check`, `capability-matrix --check`, `offered-catalog --check` and `production-ledger --check` were the only checks run at assembly time.

## Rules for you

- You may fix failures and commit. Identity: `Arnav Bule <arnav.bule05@gmail.com>`, no Co-Authored-By trailer, no em dashes in messages.
- Push only normally to the same branch (`prod/compose`). No force push, no history rewrite, no rebase of published commits.
- Never weaken, skip, delete or loosen a test, gate, pin or expectation to make something pass. Fix the cause. If a test is wrong, say why in the commit message and keep the original intent.
- Record evidence in `docs/build/production/ledger.json` using its schema: each evidence item has `level` (one of `ledger.evidenceLevels`), `result`, and a 40-hex `commit`. Do not invent levels.
- Keep pending, failed and passed distinct. A failed or unrun lane is recorded as such, never as passed.
- Mark a requirement `verified` only when every evidence level its acceptance needs is met on the exact commit. Otherwise leave it `in_progress` and keep `implementationStatus` honest (for example `verification_partial_<what_remains>`).
- After a run, update the Results section of this file and re-run `node scripts/build/production-ledger.mjs` so REQUIREMENTS.md stays current (`--check` must pass).
- No credentials in the repository or in chat. Run heavy Docker/DB lanes serially. Clean up only resources you own.

## Migrations as shipped on this branch

Platform migrations: 17 MACH-03 runbooks, 18 LIFE-12 ownership_transfers, 19 OBS-03 incident_stability, 20 COST-03 optimizer_settings (registry in `src/lib/controlplane/db/migrations/index.ts`, contiguous 1..20). Supabase files are cumulative snapshots and published ones are immutable: `0018_platform_core.sql` is byte-identical to base `76a0652`; the new aggregate is `0019_platform_core.sql` (it contains migrations 1..20, generated by `npx tsx scripts/platform/emit-sql.ts`). `scripts/ci/apply-supabase-migrations.sh` applies `0018` then `0019`. A database that applied `0018` alone is behind and must apply `0019` (or run `npm run migrate:platform`).

## Order

1. The full CI-repair runbook: [verify/PROD-CI-REPAIR.md](verify/PROD-CI-REPAIR.md) section 3 (covers PROD-CI-05, PROD-CI-08, PROD-CI-09). Do this first; later requirements depend on a working platform-postgres lane.
2. Then each requirement below, in this order: MACH-01, OBS-02, LIFE-02, LIFE-12, MACH-03, OBS-03, COST-03.
3. Finally, one full pushed-CI inspection on the exact final commit (CI-REPAIR step 8).

Common setup: Node 22; `export ZENITH_TEST_PLATFORM_PG_URL=<owned PG16 url>` where a block says so; Go with `GOTOOLCHAIN=local`.

## Per requirement

### PROD-CI-05 / PROD-CI-08 / PROD-CI-09
Doc: [verify/PROD-CI-REPAIR.md](verify/PROD-CI-REPAIR.md). Commands: `python docs/build/production/transfer/2026-10-05/verify.py`; `npm run typecheck`; `npm run lint`; `npx vitest run tests/ci tests/docs/operator-docs.test.ts tests/machines/go-results.test.ts`; native100 `tests/controlplane/cleanup-writer-barriers.test.ts` with the REQUIRED env vars; `node scripts/ci/run-gate.mjs <lane> --run` then `--validate ... --require-execution` for platform-postgres, postgres, workflows, reconciliation, workflow-intents, policy, tofu, core; guest gate `scripts/ci/run-guest-file-write-gate.mjs` on real Linux; `opa check --strict policy/rego && opa test policy/rego`; packaged workers; then pushed CI per-job inspection. Note `tests/ci/platform-coverage.test.ts` now expects the committed list to end `0015_agent_oauth_grants, 0016, 0017, 0018, 0019`.

### PROD-MACH-01
Doc: [verify/PROD-MACH-01.md](verify/PROD-MACH-01.md). `npx vitest run tests/machines/service-configure.test.ts tests/machines/args.test.ts tests/machines/zenithd.test.ts tests/machines/file-upload.test.ts tests/machines/file-write.test.ts tests/machines/service.test.ts tests/docs/capability-matrix.test.ts`; in `go/`: `go test ./internal/machine/... -run 'ServiceConfigure|Executor|E2EMachine|MachineGrant'`; on Linux, unprivileged, fixed root: `go test ./internal/machine/ops -run ServiceConfigure -count=1` and `go test ./internal/machine -run ServiceConfigure -count=1`; `go vet ./...` for linux/amd64, linux/arm64 and host.

### PROD-OBS-02
Doc: [verify/PROD-OBS-02.md](verify/PROD-OBS-02.md). `npx vitest run tests/observability tests/machines/telemetry.test.ts tests/machines/service.test.ts tests/agent-v3 tests/security/signal-boundaries.test.ts`.

### PROD-LIFE-02
Doc: [verify/PROD-LIFE-02.md](verify/PROD-LIFE-02.md). `npx vitest run tests/offered-catalog tests/middleware/platform-bearer.test.ts tests/docs/capability-matrix.test.ts tests/agent-v3`; `npx tsx scripts/docs/offered-catalog.ts --check` and `--strict`. CI already runs the `--check` step; the test files are not yet in the gate manifest (see risks).

### PROD-LIFE-12
Doc: [verify/PROD-LIFE-12.md](verify/PROD-LIFE-12.md). `ZENITH_TEST_PLATFORM_PG_URL=... npx vitest run tests/capabilities/ownership-transfers.test.ts tests/capabilities/field-ownership-broker.test.ts tests/controlplane/tenancy.test.ts tests/controlplane/migrations.test.ts tests/security/controlplane-sql-scoping.test.ts tests/ci/platform-coverage.test.ts tests/docs/operator-docs.test.ts tests/ownership tests/providers/aws/drivers/compute/ecs-ownership-lifecycle.test.ts`; regression `npx vitest run tests/capabilities tests/reconcile tests/resources tests/providers/aws/drivers/compute tests/execution`. The doc's mention of `0020_platform_core.sql` is superseded: the aggregate is `0019`.

### PROD-MACH-03
Doc: [verify/PROD-MACH-03.md](verify/PROD-MACH-03.md). `npx vitest run tests/machines/runbooks.test.ts tests/machines/runbook-step-executor.test.ts tests/controlplane/machine-runbooks.test.ts tests/controlplane/migrations.test.ts tests/middleware/platform-bearer.test.ts tests/engine/postgres-scheduler.test.ts tests/docs` (also with the PG env var). `POST /api/internal/tick/runbooks` is now listed in `.github/workflows/tick.yml`.

### PROD-OBS-03
Doc: [verify/PROD-OBS-03.md](verify/PROD-OBS-03.md). `npx vitest run tests/incidents tests/controlplane/incident-stability.test.ts tests/controlplane/migrations.test.ts`, then the same with the PG env var. The migration is version 19 (`0019_incident_stability.ts`).

### PROD-COST-03
Doc: [verify/PROD-COST-03.md](verify/PROD-COST-03.md). `npx vitest run tests/placement/optimizer.test.ts tests/placement/optimizer-pass.test.ts`, `tests/placement`, `tests/capabilities/broker.test.ts`, and with the PG env var `tests/controlplane/migrations.test.ts tests/controlplane/tenancy.test.ts tests/security/controlplane-sql-scoping.test.ts`. The migration is version 20 (`0020_optimizer_settings.ts`).

## Known risks collected from the verify docs

- `tests/machines/file-write.test.ts:105` (`ZENITHD_OPERATIONS` not containing `package.install`) may already fail at base; check against `76a0652` before blaming MACH-01.
- `service.configure` result goldens were not produced: they need a real Linux unprivileged run on a fixed-root fixture (`ZENITH_UPDATE_MACHINE_GOLDENS=1`). Do not hand-write them. `package.install.json` golden bytes (key order from Go marshaling) are unconfirmed; `TestResultGoldens` plus `git diff --exit-code -- internal/machine/testdata/results` is the check.
- About 65 platform-postgres saved-plan dispatch failures were never diagnosed; the dispatch error now exposes the cause name and code. Read `error.cause` first. The native100 target is 100 passed / 0 failed / 0 skipped; the last attempt was 60/40.
- Likeliest first breaks elsewhere: the `inventoryForNativeOrigin` choice in `tests/controlplane/tenancy.test.ts`; OBS-03 SQL using `to_char(... at time zone 'utc')` and `pg_advisory_xact_lock(hashtextextended(...))`; the merged tenancy SWEPT sets (ownershipTransfers plus optimizerSettings) and the `EXPECTED_TABLES` unions in `tests/controlplane/migrations.test.ts`, which were resolved by hand in the merges.
- MACH-03: the runbook tick is in `tick.yml` but is not yet registered as a durable critical schedule; route handlers have no route-level test; step operations for critical capabilities fail closed unless policy allows them without a per-step approval; windows are UTC only; cloud-transport targets are refused.
- COST-03: no measurement collector is wired (utilization is an input), and there is no human opt-in endpoint for `optimizer_settings`; the optimizer cannot act until both exist. Non-container right-sizing needs the plan pipeline to consume an `optimize` input.
- OBS-03: the escalation channel is a durable record plus a platform event only; no paging or channel delivery exists. `reserveRemediation` has no production caller and no observer loop calls `observeSignal` (PROD-OBS-04 owns schedules).
- LIFE-02: `tests/offered-catalog/*` are not yet in `scripts/ci/gate-manifest.mjs`, so CI does not run them as a required lane. Adding them changes manifest pins; recompute pins, do not edit by hand.
- LIFE-12: revocation has a store function but no REST or UI route; ownership is rechecked at propose time only.
- OBS-02: all source evidence is `contract` or `simulated`; no live-provider run exists.
- Docker, Postgres, Temporal, kind, real systemd, the signed browser approval journey and hosted CI were never exercised for any of these requirements.

## Wave 2 (5 October 2026, assembled on prod/compose, build-only)

**Verify wave 1 first.** Everything above (CI repair, MACH-01, OBS-02, LIFE-02, LIFE-12, MACH-03, OBS-03, COST-03) must be run and green before the blocks below: wave 2 shares the migration registry, `tenancy.test.ts`, `platform-bearer.test.ts`, the generated Supabase aggregate and the platform nav with it, so a wave 1 failure will confuse every wave 2 result. No wave 2 byte has been executed: no vitest, go test, Docker, PostgreSQL, Temporal or cloud run. Typecheck, eslint (changed files), `emit-sql --check`, `capability-matrix --check`, `offered-catalog --check`, `production-ledger --check`, and Go `build`/`vet` were the only checks.

### Migrations and shared files as shipped

Platform migrations 21 OBS-04 `scheduled_job_runs`, 22 LIFE-01 `connection_rotations`, 23 LIFE-10 `release_pipelines`, 24 LIFE-11 `portability`, 25 MACH-04 `agent_lifecycle`, 26 UX-03 `plugin_boundaries`, 27 LIFE-08 `github_revocation_reason` (workers built them as 21, 22, 24, 25, 26, 28, 30 and the assembler renumbered to contiguous 1..27; checksums in DEPLOYING.md were recomputed). The new aggregate is `supabase/migrations/0020_platform_core.sql` (migrations 1..27, generated); `0016` to `0019` are untouched. `scripts/ci/apply-supabase-migrations.sh` applies `0019` then `0020`. Counts: `platform-bearer.test.ts` route inventory is now 65 (counted from the route files; LIFE-11's two portability routes were unclassified and are now in `bearer-paths.ts`); `action-bridge.test.ts` needed no edit (27 deliberately unmapped actions, checked against the registry).

Cross-requirement joins made at assembly (read these when a combined test fails):
- LIFE-09 provenance into LIFE-10: `admitBuiltArtifacts` (release.ts) is the single verification; its per-service result is handed to the release gate as `BeginInput.builtAdmission` and consumed by the registered `zenith.build-attestation` verifier as the `attested` verdict. Built images are held to `attested`; pinned images to `ZENITH_RELEASE_MIN_PROVENANCE` (default `pinned_digest`). Test: `tests/release-safety/built-attestation.test.ts`.
- LIFE-08 into LIFE-09: a non-root `contextDir` needs the inspection `contextDigest` in the pipeline spec; `admitBuildContext` re-derives it from the approved commit through `deps.sourceContext` (`createGithubContextVerifier`) before the bundle is prepared, and the digest is signed into the provenance statement and re-checked at admission. The product service source now carries optional `contextDir` / `contextDigest` and `expand.ts` passes them. No dedicated test yet for the re-derivation path (see risks).
- Platform nav: one list in `src/app/(product)/platform/_components/platform-nav.tsx` (Operations, Environments, Releases, Runbooks, Readiness, Runners, GitHub source, Plugins, Connections, Connect AWS, Workspace policy); the layout uses it alone.
- `tick.yml` gained the OBS-04 `status` pass.

### PROD-OBS-04
Doc: [verify/PROD-OBS-04.md](verify/PROD-OBS-04.md). `npx vitest run tests/platform/critical-jobs.test.ts tests/workflows/critical-schedule.test.ts tests/workflows/sandbox.test.ts tests/platform/housekeeping.test.ts tests/controlplane/migrations.test.ts tests/controlplane/tenancy.test.ts tests/security/controlplane-sql-scoping.test.ts`; real Temporal: `ZENITH_TEST_PLATFORM_PG_URL=... ZENITH_TEST_RECONCILE_SCHEDULE=1 ZENITH_TEST_TEMPORAL=1 ZENITH_TEST_TEMPORAL_CLI=<cli> npx vitest run tests/workflows/reconcile-schedule.test.ts tests/workers/reconcile-composition.test.ts`. Worker needs `ZENITH_STORE=postgres` for engine/alerts/outbox.

### PROD-LIFE-01
Doc: [verify/PROD-LIFE-01.md](verify/PROD-LIFE-01.md). `npx vitest run tests/connections tests/cli tests/middleware/platform-bearer.test.ts tests/bridge/connection-aws.test.ts tests/bridge/connection-kubernetes.test.ts tests/actions/connection-env-isolation.test.ts tests/platform/credentials-verification.test.ts tests/controlplane/migrations.test.ts tests/controlplane/tenancy.test.ts tests/security/controlplane-sql-scoping.test.ts tests/capabilities/action-bridge.test.ts tests/docs/operator-docs.test.ts`. PGlite plus synthetic cloud fetch.

### PROD-LIFE-08
Doc: [verify/PROD-LIFE-08.md](verify/PROD-LIFE-08.md). `npx vitest run tests/sources tests/middleware/platform-bearer.test.ts tests/controlplane/migrations.test.ts tests/controlplane/tenancy.test.ts`; lifecycle test is POSIX only; with `ZENITH_TEST_PLATFORM_PG_URL` also `tests/sources/github-webhook.test.ts`.

### PROD-LIFE-09
Doc: [verify/PROD-LIFE-09.md](verify/PROD-LIFE-09.md). `npx vitest run tests/execution/build-isolation.test.ts tests/execution/build-provenance.test.ts tests/execution/build-admission.test.ts tests/execution/release.test.ts tests/execution/journey.test.ts tests/execution/approved-source.test.ts tests/release-safety/built-attestation.test.ts tests/providers/aws/drivers/compute/codebuild.test.ts tests/providers/gcp/release.test.ts tests/providers/gcp/build-gcp.test.ts tests/providers/azure/release.test.ts tests/providers/azure/build-digest.test.ts tests/platform/release.test.ts tests/platform/release-multi.test.ts tests/platform/codebuild-launch-authority.test.ts tests/workflows`.

### PROD-LIFE-10
Doc: [verify/PROD-LIFE-10.md](verify/PROD-LIFE-10.md). `npx vitest run tests/release-safety tests/execution/release-safety.test.ts tests/execution/release.test.ts tests/execution/manifest-release.test.ts tests/providers/gcp/release-progressive.test.ts tests/providers/gcp/release.test.ts tests/providers/kubernetes tests/controlplane/release-pipelines.test.ts tests/controlplane/migrations.test.ts tests/middleware/platform-bearer.test.ts tests/platform/deploy-e2e.test.ts tests/platform/composition.test.ts tests/docs`; repeat the two controlplane files with `ZENITH_TEST_PLATFORM_PG_URL`. Behaviour change: tag-only images are refused.

### PROD-LIFE-11
Doc: [verify/PROD-LIFE-11.md](verify/PROD-LIFE-11.md). `npx vitest run tests/portability tests/execution/portability.test.ts tests/capabilities/portability-broker.test.ts tests/controlplane/tenancy.test.ts tests/security/controlplane-sql-scoping.test.ts tests/capabilities tests/execution tests/policy tests/security/policy-invariants.test.ts tests/docs tests/ownership`; real engines: `ZENITH_TEST_PLATFORM_PG_URL`, `ZENITH_TEST_POSTGRES_URL`, `ZENITH_TEST_S3_ENDPOINT` with `ZENITH_PORTABILITY_ALLOW_PRIVATE_HOSTS=1`, `ZENITH_TEST_MYSQL_URL` (see the doc for the exact files). `npx tsx scripts/docs/capability-matrix.ts --check`.

### PROD-MACH-04
Doc: [verify/PROD-MACH-04.md](verify/PROD-MACH-04.md). In `go/` with `GOTOOLCHAIN=local`: `go vet ./... && go test -race ./internal/release ./internal/agent/... ./internal/runner/... ./internal/machine/...` and `go test -race -count=3 ./internal/agent -run 'Spool|Heartbeat|Revocation'`; `npx vitest run tests/runners/lifecycle.test.ts tests/runners/store-contract.test.ts tests/runners/admin-routes.test.ts tests/runners/e2e-platform-store.test.ts tests/runners/late-effect-receipts.test.ts` (also with the PG env var). The real systemd update acceptance is manual and Linux only.

### PROD-MACH-05
Doc: [verify/PROD-MACH-05.md](verify/PROD-MACH-05.md). `npx vitest run tests/security/result-sanitizer.test.ts tests/runners tests/agent-v3 tests/agent-control* tests/security tests/execution/platform.test.ts`; `node scripts/test-agent-reader.mjs`; in `go/`: `go test ./internal/runner/... ./internal/redact/... ./internal/agent/...`. Expect to touch existing tests that assert the old `[redacted]` marker or exact runner registration labels.

### PROD-UX-01
Doc: [verify/PROD-UX-01.md](verify/PROD-UX-01.md). `npx vitest run tests/platform-ui tests/docs/operator-docs.test.ts`. The nav list moved: any assertion on the old `PLATFORM_LINKS` contents must follow the merged list. A real-browser accessibility pass (axe, keyboard, screen reader) is still owed.

### PROD-UX-03
Doc: [verify/PROD-UX-03.md](verify/PROD-UX-03.md). `npx vitest run tests/plugins tests/agent-v3 tests/agent-control-oauth.test.ts tests/capabilities tests/controlplane/migrations.test.ts tests/controlplane/tenancy.test.ts tests/security/controlplane-sql-scoping.test.ts tests/docs`; `ZENITH_TEST_PLATFORM_PG_URL=... npx vitest run tests/plugins/service.test.ts`.

### Wave 2 known risks

- The join code (`builtAdmission`, `minProvenanceFor`, `sourceContext`, `contextDigest` provenance field) was written at assembly without running anything. Likeliest first breaks: `tests/execution/build-provenance.test.ts` and `build-admission.test.ts` (new optional statement field, `contextDigest` expectation), `tests/execution/release.test.ts` and `journey.test.ts` (admission now returns a map; `beginRuns` input gained `admissions`), and `tests/release-safety/pipeline.test.ts` (new option).
- There is no test of `createGithubContextVerifier` or `admitBuildContext` yet: add owning, foreign and mismatched-digest cases beside `tests/sources/github-inspect.test.ts` and `tests/execution/build-admission.test.ts`.
- Merged tests added by different workers were never run together: `tenancy.test.ts` (SWEPT additions for `connectionRotations` and `plugins` use nonexistent ids as foreign probes), `migrations.test.ts` (`EXPECTED_TABLES` union; `scheduled_job_runs` has no `workspace_id` and is in `NO_WORKSPACE_COLUMN`), `platform-bearer.test.ts` (65), `operator-docs.test.ts` (migration inventory rows 21 to 27, new env vars).
- The `tick.yml` `status` pass is informational (200 unless `?strict=1`); a never-run job will not fail the workflow.
- LIFE-09, LIFE-10, LIFE-01, LIFE-08 and UX-01 touch the platform nav and `bearer-paths.ts`; check the nav contains each page and that no route is reachable but unlisted.
- OBS-04 and MACH-04 have Temporal and systemd acceptance that cannot be reproduced without those environments; record them as pending, not passed.
- Live cloud, hosted CI and the signed browser approval journey were never exercised for any wave 2 requirement.

## Results

Not yet run. Append one dated block per requirement here: SHA verified, commands, counts, and which evidence levels were reached or remain pending.

**Wave 2 assembly gap (write these tests first):** the cross-requirement joins added during assembly have no tests yet. Add vitest coverage for (1) build admission re-deriving LIFE-08 `contextDigest` and refusing a mismatched or non-inspected `contextDir`, (2) the single provenance admission path (LIFE-09 attestation consumed as LIFE-10 `attested` verdict; unattested Zenith-built images refused, pinned external digests admitted at `pinned_digest`), then run them with the rest of wave 2.

## Verifier checkpoint, 5 October 2026

- PROD-CI-05: pending complete acceptance; tested code387b0efe; [results](verification/RESULTS-2026-10.md#prod-ci-05).
- PROD-CI-08: pending complete acceptance; tested code387b0efe; [results](verification/RESULTS-2026-10.md#prod-ci-08).
- PROD-CI-09: pending complete acceptance; tested code387b0efe; [results](verification/RESULTS-2026-10.md#prod-ci-09).
- PROD-MACH-01: pending complete acceptance; tested code387b0efe; [results](verification/RESULTS-2026-10.md#prod-mach-01).
- PROD-MACH-03: pending complete acceptance; tested code387b0efe; [results](verification/RESULTS-2026-10.md#prod-mach-03).
- PROD-OBS-02: pending complete acceptance; tested code387b0efe; [results](verification/RESULTS-2026-10.md#prod-obs-02).
- PROD-OBS-03: pending complete acceptance; tested code387b0efe; [results](verification/RESULTS-2026-10.md#prod-obs-03).
- PROD-LIFE-02: pending complete acceptance; tested code387b0efe; [results](verification/RESULTS-2026-10.md#prod-life-02).
- PROD-LIFE-12: pending complete acceptance; tested code387b0efe; [results](verification/RESULTS-2026-10.md#prod-life-12).
- PROD-COST-03: pending complete acceptance; tested code387b0efe; [results](verification/RESULTS-2026-10.md#prod-cost-03).
- PROD-OBS-04: pending complete acceptance; tested code387b0efe; [results](verification/RESULTS-2026-10.md#prod-obs-04).
- PROD-LIFE-01: pending complete acceptance; tested code387b0efe; [results](verification/RESULTS-2026-10.md#prod-life-01).
- PROD-LIFE-08: pending complete acceptance; tested code387b0efe; [results](verification/RESULTS-2026-10.md#prod-life-08).
- PROD-LIFE-09: pending complete acceptance; tested code387b0efe; [results](verification/RESULTS-2026-10.md#prod-life-09).
- PROD-LIFE-10: pending complete acceptance; tested code387b0efe; [results](verification/RESULTS-2026-10.md#prod-life-10).
- PROD-LIFE-11: pending complete acceptance; tested code387b0efe; [results](verification/RESULTS-2026-10.md#prod-life-11).
- PROD-MACH-04: pending complete acceptance; tested code387b0efe; [results](verification/RESULTS-2026-10.md#prod-mach-04).
- PROD-MACH-05: pending complete acceptance; tested code387b0efe; [results](verification/RESULTS-2026-10.md#prod-mach-05).
- PROD-UX-01: pending complete acceptance; tested code387b0efe; [results](verification/RESULTS-2026-10.md#prod-ux-01).
- PROD-UX-03: pending complete acceptance; tested code387b0efe; [results](verification/RESULTS-2026-10.md#prod-ux-03).

## Results, coherent verifier source 7 October 2026

- PROD-CI-05: verified; Prior scoped verification retained; currentd6965d75 CI also passed, no wider release promotion. [Results](verification/RESULTS-2026-10.md#coherent-verifier-source-2026-10-07).
- PROD-CI-07: verified; Fresh exactd6965d75 mandatory CI scopes passed; all20 job conclusions success. [Results](verification/RESULTS-2026-10.md#coherent-verifier-source-2026-10-07).
- PROD-CI-08: verified; Fresh exactd6965d75 mandatory CI scopes passed; all20 job conclusions success. [Results](verification/RESULTS-2026-10.md#coherent-verifier-source-2026-10-07).
- PROD-CI-09: verified; Fresh exactd6965d75 mandatory CI scopes passed; all20 job conclusions success. [Results](verification/RESULTS-2026-10.md#coherent-verifier-source-2026-10-07).
- PROD-MACH-01: verified; Prior scoped verification retained; currentd6965d75 CI also passed, no wider release promotion. [Results](verification/RESULTS-2026-10.md#coherent-verifier-source-2026-10-07).
- PROD-MACH-03: in_progress; Current CI d6965d75 scope passed; dedicated acceptance receipts retain original source and missing levels. [Results](verification/RESULTS-2026-10.md#coherent-verifier-source-2026-10-07).
- PROD-OBS-02: in_progress; Current CI d6965d75 scope passed; dedicated acceptance receipts retain original source and missing levels. [Results](verification/RESULTS-2026-10.md#coherent-verifier-source-2026-10-07).
- PROD-OBS-03: verified; Prior scoped verification retained; currentd6965d75 CI also passed, no wider release promotion. [Results](verification/RESULTS-2026-10.md#coherent-verifier-source-2026-10-07).
- PROD-LIFE-02: verified; Prior scoped verification retained; currentd6965d75 CI also passed, no wider release promotion. [Results](verification/RESULTS-2026-10.md#coherent-verifier-source-2026-10-07).
- PROD-LIFE-12: in_progress; Current CI d6965d75 scope passed; dedicated acceptance receipts retain original source and missing levels. [Results](verification/RESULTS-2026-10.md#coherent-verifier-source-2026-10-07).
- PROD-COST-03: in_progress; Current CI d6965d75 scope passed; dedicated acceptance receipts retain original source and missing levels. [Results](verification/RESULTS-2026-10.md#coherent-verifier-source-2026-10-07).
- PROD-OBS-04: in_progress; Exactd6965d75 workflows1275/0/0/all62 passed; NOT_READY maintenance draft never run; default scheduling proof open. [Results](verification/RESULTS-2026-10.md#coherent-verifier-source-2026-10-07).
- PROD-LIFE-01: in_progress; Current CI d6965d75 scope passed; dedicated acceptance receipts retain original source and missing levels. [Results](verification/RESULTS-2026-10.md#coherent-verifier-source-2026-10-07).
- PROD-LIFE-08: in_progress; Current CI d6965d75 scope passed; dedicated acceptance receipts retain original source and missing levels. [Results](verification/RESULTS-2026-10.md#coherent-verifier-source-2026-10-07).
- PROD-LIFE-09: in_progress; Current CI d6965d75 scope passed; dedicated acceptance receipts retain original source and missing levels. [Results](verification/RESULTS-2026-10.md#coherent-verifier-source-2026-10-07).
- PROD-LIFE-10: in_progress; Current CI d6965d75 scope passed; dedicated acceptance receipts retain original source and missing levels. [Results](verification/RESULTS-2026-10.md#coherent-verifier-source-2026-10-07).
- PROD-LIFE-11: in_progress; Exactd6965d75 local DNS27/45regressions/MySQL15 all passed and cleaned; broader portability criteria remain open. [Results](verification/RESULTS-2026-10.md#coherent-verifier-source-2026-10-07).
- PROD-MACH-04: in_progress; Current CI d6965d75 scope passed; dedicated acceptance receipts retain original source and missing levels. [Results](verification/RESULTS-2026-10.md#coherent-verifier-source-2026-10-07).
- PROD-MACH-05: in_progress; Current CI d6965d75 scope passed; dedicated acceptance receipts retain original source and missing levels. [Results](verification/RESULTS-2026-10.md#coherent-verifier-source-2026-10-07).
- PROD-UX-01: in_progress; Current CI d6965d75 scope passed; dedicated acceptance receipts retain original source and missing levels. [Results](verification/RESULTS-2026-10.md#coherent-verifier-source-2026-10-07).
- PROD-UX-03: in_progress; Current CI d6965d75 scope passed; dedicated acceptance receipts retain original source and missing levels. [Results](verification/RESULTS-2026-10.md#coherent-verifier-source-2026-10-07).

Results PROD-CI-08 (8 October):648a historical77/0/0; frozen4c canonical intents156/0/0 all141;722 actual codec/deploy30/0/0. Scopes overlap; current71 workflow inventory. Full combined gate/CI pending; no promotion.

Results PROD-CI-08 (8October): full9354Vitest21851/0/1624, strictidentityadmissionFAILED; stabletitle44/0/0+Countermatch/lint0 integrated5072c4a0; six actualPythoncollectorpasses separate. Fullsuccessorpending.
Results PROD-OBS-04 (8October): actualownedTemporal10/0/0 with boundeddiagnostic98a3f6f5; cleanup/endbindingverified; remote9354startupcause/defaultmaintenanceeffectsstillopen.

## Wave 5

Historical Wave 5 assembly used schema 52. Final integration now uses contiguous schema 58 and aggregate 0026; release states remain false. Run every command in [W5-ASSEMBLY.md](verify/W5-ASSEMBLY.md) in order: (1) owned PostgreSQL16 migration/tenancy/SLO/billing/domain stores, (2) matching pg_dump/pg_restore and pinned Temporal CLI for recovery plus complete workflows, (3) OpenTofu1.12.5 provider/local-variable contracts, adversarial and Wave 5 contracts, (4) Docker/kind/Gateway API with digest-pinned registry/builder/probe images, tenant bootstrap readiness and Calico/Cilium isolation, (5) IAM-enforcing S3 emulator, (6) browser/DOM operator QA. The linked runbook supplies exact env gates and commands; W5-ASSEMBLY-ONBOARDING supplies prepared/missing namespace fixtures and cleanup. No skipped gate is a pass. Live clouds, protected release-key creation and permissions.json approval remain deferred human actions.

## Wave 6 build jobs

Run sequentially on the native Mac with Node 22, the owned lean profile (8 GB), at most two Vitest workers and no file parallelism. Full commands and external prerequisite lanes are in [FINAL-INTEGRATION](verify/FINAL-INTEGRATION.md) and the committed `scripts/ci/wave6-gates.json`. Do not enable live gates without the owner scope and DEC-CLOUD approval.

| Requirement | Exact Mac command |
|---|---|
| PROD-PKG-04 | `node scripts/ci/wave6-gates.mjs --requirement PROD-PKG-04 --print` then execute each emitted command sequentially with the documented owned prerequisites. |
| PROD-PKG-05 | `node scripts/ci/wave6-gates.mjs --requirement PROD-PKG-05 --print` then execute each emitted command sequentially with the documented owned prerequisites. |
| PROD-PKG-06 | `node scripts/ci/wave6-gates.mjs --requirement PROD-PKG-06 --print` then execute each emitted command sequentially with the documented owned prerequisites. |
| PROD-MIX-01 | `node scripts/ci/wave6-gates.mjs --requirement PROD-MIX-01 --print` then execute each emitted command sequentially with the documented owned prerequisites. |
| PROD-MIX-02 | `node scripts/ci/wave6-gates.mjs --requirement PROD-MIX-02 --print` then execute each emitted command sequentially with the documented owned prerequisites. |
| PROD-MIX-03 | `node scripts/ci/wave6-gates.mjs --requirement PROD-MIX-03 --print` then execute each emitted command sequentially with the documented owned prerequisites. |
| PROD-MIX-04 | `node scripts/ci/wave6-gates.mjs --requirement PROD-MIX-04 --print` then execute each emitted command sequentially with the documented owned prerequisites. |
| PROD-MIX-05 | `node scripts/ci/wave6-gates.mjs --requirement PROD-MIX-05 --print` then execute each emitted command sequentially with the documented owned prerequisites. |
| PROD-MIX-06 | `node scripts/ci/wave6-gates.mjs --requirement PROD-MIX-06 --print` then execute each emitted command sequentially with the documented owned prerequisites. |
| PROD-MIX-07 | `node scripts/ci/wave6-gates.mjs --requirement PROD-MIX-07 --print` then execute each emitted command sequentially with the documented owned prerequisites. |
| PROD-DUR-01 | `node scripts/ci/wave6-gates.mjs --requirement PROD-DUR-01 --print` then execute each emitted command sequentially with the documented owned prerequisites. |
| PROD-DUR-02 | `node scripts/ci/wave6-gates.mjs --requirement PROD-DUR-02 --print` then execute each emitted command sequentially with the documented owned prerequisites. |
| PROD-DUR-03 | `node scripts/ci/wave6-gates.mjs --requirement PROD-DUR-03 --print` then execute each emitted command sequentially with the documented owned prerequisites. |
| PROD-DUR-04 | `node scripts/ci/wave6-gates.mjs --requirement PROD-DUR-04 --print` then execute each emitted command sequentially with the documented owned prerequisites. |
| PROD-DUR-05 | `node scripts/ci/wave6-gates.mjs --requirement PROD-DUR-05 --print` then execute each emitted command sequentially with the documented owned prerequisites. |
| PROD-DUR-06 | `node scripts/ci/wave6-gates.mjs --requirement PROD-DUR-06 --print` then execute each emitted command sequentially with the documented owned prerequisites. |
| PROD-DUR-07 | `node scripts/ci/wave6-gates.mjs --requirement PROD-DUR-07 --print` then execute each emitted command sequentially with the documented owned prerequisites. |
| PROD-DUR-08 | `node scripts/ci/wave6-gates.mjs --requirement PROD-DUR-08 --print` then execute each emitted command sequentially with the documented owned prerequisites. |
| PROD-LIFE-01 | `node scripts/ci/wave6-gates.mjs --requirement PROD-LIFE-01 --print` then execute each emitted command sequentially with the documented owned prerequisites. |
| PROD-LIFE-03 | `node scripts/ci/wave6-gates.mjs --requirement PROD-LIFE-03 --print` then execute each emitted command sequentially with the documented owned prerequisites. |
| PROD-LIFE-04 | `node scripts/ci/wave6-gates.mjs --requirement PROD-LIFE-04 --print` then execute each emitted command sequentially with the documented owned prerequisites. |
| PROD-LIFE-05 | `node scripts/ci/wave6-gates.mjs --requirement PROD-LIFE-05 --print` then execute each emitted command sequentially with the documented owned prerequisites. |
| PROD-LIFE-06 | `node scripts/ci/wave6-gates.mjs --requirement PROD-LIFE-06 --print` then execute each emitted command sequentially with the documented owned prerequisites. |
| PROD-LIFE-07 | `node scripts/ci/wave6-gates.mjs --requirement PROD-LIFE-07 --print` then execute each emitted command sequentially with the documented owned prerequisites. |
| PROD-LIFE-08 | `node scripts/ci/wave6-gates.mjs --requirement PROD-LIFE-08 --print` then execute each emitted command sequentially with the documented owned prerequisites. |
| PROD-LIFE-09 | `node scripts/ci/wave6-gates.mjs --requirement PROD-LIFE-09 --print` then execute each emitted command sequentially with the documented owned prerequisites. |
| PROD-LIFE-10 | `node scripts/ci/wave6-gates.mjs --requirement PROD-LIFE-10 --print` then execute each emitted command sequentially with the documented owned prerequisites. |
| PROD-LIFE-12 | `node scripts/ci/wave6-gates.mjs --requirement PROD-LIFE-12 --print` then execute each emitted command sequentially with the documented owned prerequisites. |
| PROD-MACH-02 | `node scripts/ci/wave6-gates.mjs --requirement PROD-MACH-02 --print` then execute each emitted command sequentially with the documented owned prerequisites. |
| PROD-MACH-03 | `node scripts/ci/wave6-gates.mjs --requirement PROD-MACH-03 --print` then execute each emitted command sequentially with the documented owned prerequisites. |
| PROD-MACH-04 | `node scripts/ci/wave6-gates.mjs --requirement PROD-MACH-04 --print` then execute each emitted command sequentially with the documented owned prerequisites. |
| PROD-MACH-05 | `node scripts/ci/wave6-gates.mjs --requirement PROD-MACH-05 --print` then execute each emitted command sequentially with the documented owned prerequisites. |
| PROD-MACH-06 | `node scripts/ci/wave6-gates.mjs --requirement PROD-MACH-06 --print` then execute each emitted command sequentially with the documented owned prerequisites. |
| PROD-OBS-01 | `node scripts/ci/wave6-gates.mjs --requirement PROD-OBS-01 --print` then execute each emitted command sequentially with the documented owned prerequisites. |
| PROD-OBS-04 | `node scripts/ci/wave6-gates.mjs --requirement PROD-OBS-04 --print` then execute each emitted command sequentially with the documented owned prerequisites. |
| PROD-MAN-01 | `node scripts/ci/wave6-gates.mjs --requirement PROD-MAN-01 --print` then execute each emitted command sequentially with the documented owned prerequisites. |
| PROD-MAN-02 | `node scripts/ci/wave6-gates.mjs --requirement PROD-MAN-02 --print` then execute each emitted command sequentially with the documented owned prerequisites. |
| PROD-MAN-03 | `node scripts/ci/wave6-gates.mjs --requirement PROD-MAN-03 --print` then execute each emitted command sequentially with the documented owned prerequisites. |
| PROD-MAN-04 | `node scripts/ci/wave6-gates.mjs --requirement PROD-MAN-04 --print` then execute each emitted command sequentially with the documented owned prerequisites. |
| PROD-MAN-05 | `node scripts/ci/wave6-gates.mjs --requirement PROD-MAN-05 --print` then execute each emitted command sequentially with the documented owned prerequisites. |
| PROD-MAN-06 | `node scripts/ci/wave6-gates.mjs --requirement PROD-MAN-06 --print` then execute each emitted command sequentially with the documented owned prerequisites. |
| PROD-MAN-07 | `node scripts/ci/wave6-gates.mjs --requirement PROD-MAN-07 --print` then execute each emitted command sequentially with the documented owned prerequisites. |
| PROD-OPS-01 | `node scripts/ci/wave6-gates.mjs --requirement PROD-OPS-01 --print` then execute each emitted command sequentially with the documented owned prerequisites. |
| PROD-OPS-02 | `node scripts/ci/wave6-gates.mjs --requirement PROD-OPS-02 --print` then execute each emitted command sequentially with the documented owned prerequisites. |
| PROD-OPS-03 | `node scripts/ci/wave6-gates.mjs --requirement PROD-OPS-03 --print` then execute each emitted command sequentially with the documented owned prerequisites. |
| PROD-OPS-04 | `node scripts/ci/wave6-gates.mjs --requirement PROD-OPS-04 --print` then execute each emitted command sequentially with the documented owned prerequisites. |
| PROD-OPS-05 | `node scripts/ci/wave6-gates.mjs --requirement PROD-OPS-05 --print` then execute each emitted command sequentially with the documented owned prerequisites. |
| PROD-OPS-06 | `node scripts/ci/wave6-gates.mjs --requirement PROD-OPS-06 --print` then execute each emitted command sequentially with the documented owned prerequisites. |
| PROD-OPS-07 | `node scripts/ci/wave6-gates.mjs --requirement PROD-OPS-07 --print` then execute each emitted command sequentially with the documented owned prerequisites. |
| PROD-OPS-08 | `node scripts/ci/wave6-gates.mjs --requirement PROD-OPS-08 --print` then execute each emitted command sequentially with the documented owned prerequisites. |
| PROD-OPS-09 | `node scripts/ci/wave6-gates.mjs --requirement PROD-OPS-09 --print` then execute each emitted command sequentially with the documented owned prerequisites. |
| PROD-UX-01 | `node scripts/ci/wave6-gates.mjs --requirement PROD-UX-01 --print` then execute each emitted command sequentially with the documented owned prerequisites. |
| PROD-UX-02 | `node scripts/ci/wave6-gates.mjs --requirement PROD-UX-02 --print` then execute each emitted command sequentially with the documented owned prerequisites. |
| PROD-UX-03 | `node scripts/ci/wave6-gates.mjs --requirement PROD-UX-03 --print` then execute each emitted command sequentially with the documented owned prerequisites. |
| PROD-COST-01 | `node scripts/ci/wave6-gates.mjs --requirement PROD-COST-01 --print` then execute each emitted command sequentially with the documented owned prerequisites. |
| PROD-COST-02 | `node scripts/ci/wave6-gates.mjs --requirement PROD-COST-02 --print` then execute each emitted command sequentially with the documented owned prerequisites. |
| PROD-COST-03 | `node scripts/ci/wave6-gates.mjs --requirement PROD-COST-03 --print` then execute each emitted command sequentially with the documented owned prerequisites. |
| PROD-REL-01 | `node scripts/ci/wave6-gates.mjs --requirement PROD-REL-01 --print` then execute each emitted command sequentially with the documented owned prerequisites. |
| PROD-REL-02 | `node scripts/ci/wave6-gates.mjs --requirement PROD-REL-02 --print` then execute each emitted command sequentially with the documented owned prerequisites. |
| PROD-REL-03 | `node scripts/ci/wave6-gates.mjs --requirement PROD-REL-03 --print` then execute each emitted command sequentially with the documented owned prerequisites. |
| PROD-REL-04 | `node scripts/ci/wave6-gates.mjs --requirement PROD-REL-04 --print` then execute each emitted command sequentially with the documented owned prerequisites. |

Live procedure: [one owner runbook](LIVE-ACCEPTANCE.md). All rows remain implementation_complete_verification_pending. Unsupported J2 scenario projections remain incomplete, never passed.

Results: PROD-CI-08 remains in_progress. Published0cc full CI10 successful/14 failed jobs; a15 scope repair174/0/0; historical4 native candidate105/2/0 remains unintegrated. See verification/CI-2026-10-08-0cc97c4a.md and RESULTS-2026-10.md.

Results: PROD-CI-08 remains in_progress at integratedea8f7093: native107/0/0 including58 required; contracts671/0/0; route82/0/0; packaging135/0/6; combinedcompiler0. Every broader gate/remainingLinuxcase/pushedCI still open. RESULTS integrated-targeted-successor section preserves source scope and prior failures.

Results PROD-CI-08: `59fe02bee566b244dc458b33cc58e34281994078` integrates heap guard120/0/0, full compiler0 (before later release test edit), release fixture5/0/0. Complete gates/new CI/Linux/default journeys pending.


## Packaged worker COPY custody correction, 8 October 2026

Fix `58c4e192dfc3bbbf717e28b6769130cdde83714d` binds canonical SLO asset in the strict source inventory. Fresh d90 native ARM64 and AMD64 jobs failed before building: original source digest refused `Packaged Docker COPY inventory differs from its source binding.` Root independently reproduced exit1, verified repaired digest exit0, ran whole affected suite136/0/6 and lint/diff0. New controls cover changed bytes, restoration and missing/directory/symlink refusal. Six actual Linux cases, native image/runtime and complete new CI remain pending. No gate or inventory bound weakened.


## Ownership native successor, 8 October 2026

Integrated `c8c874027dd687d4a133e5de5d971a323eeed40b` after two complete files55/0/0, including36 genuine PostgreSQL and19 PGlite cases. Root and independent reviewer verified full case Counter, source/tool binding,155 absent process groups, removed runtime/socket and refused listener. Whole gate/platform contract successor368/0/0, compiler0 in14.69s, lint/diff0. Prior339/29 contract attempt remains failed: two renamed IDs leaked into historical cohorts until their exact finite metadata references were updated. Current1160, ownership10, other1158, custody101 and native100 counts remain unchanged. Human approvals are modeled; default Auth/cloud/user journey remains open.


## Recovery client custody repair, 8 October 2026

Fix `1d99b5e217c4ea3150fcecd3976f3f7380c05a0f` creates private0700 temp files under the existing same-path runner mount, preserving file ownership and argument quoting. PostgreSQL password/TLS-mode forwarding uses environment names only. Original host/tmp container mismatch is documented; no product/migration or permission-widening changes. Root full120/0/0, compiler0 in12.19s, lint/actionlint/diff0 and independent review passed. Actual recovery lane, complete final CI and remaining default journeys are pending.


Results PROD-CI-08, 10 October: de8079cd integrates reviewed browser shutdown/SYS1 admission. Browser44/44, SYS1 targeted187/0/0, compiler/lint pass. Earlier browser orphan/receipt failure retained. Full8bb unit failed24321/169/1939 with collection mismatch and lost supervisor custody; exact8bb CI main18success/2failure/8skip, side workflows2success each. Complete local/default/operated gates and successor CI remain pending. See latest RESULTS and cleanup checkpoint; no promotion.

## Results: unit repair candidate, 10 October 2026

Current reviewed candidate1019/0/0 across24 targeted files; compiler/lint pass. Exact de807 CI18success2fail8skip; full verify and actual SYS1 remain failed. Complete clean-SHA full/native/default/operated gates pending; no milestone promotion. [Evidence](evidence/PROD-CI-08/2026-10-10-newmac-unit-repairs.json).

Resume delta, 11 October 2026: runtime **40 Lunas** is supported. Canonical cleanup receipt SHA-256 `1a15d8728196df99d21f7a1496ee4e89c2c10da75dfbae62cea792c6398f6982` records 16 removed, zero remaining, and two forced stops. The R7 wrapper refusal for capture exhaustion is unchanged; fresh custody remains pending. Native validator passed 14 finite fake cases only, with no actual compile or native execution. Ledger remains 9 verified / 67 in progress / 2 planned; source-gap closure awaits root review.

MACH04 Go delta, 11 October: R7 wrapper remains refused (exit 2) because the Docker process-inspection request omitted the required PID column after compile; gofmt/compile/version and baseline/cleanup/custody/source/floor checks were clean. R8 source `691f50a3bb2beac3c773f411d323afe4b55119284c09c604661e9116bf4e81bf` passed compile-only validation (39/39 held commands exit 0, strict validation clean). The 11,281,832-byte ARM64 ELF was not invoked (0 cases). Native R7 on its recorded source terminated with wrapper exit 2 before any case executed; the refusal remains preserved. No MACH04 completion or promotion. [Evidence](evidence/PROD-MACH-04/2026-10-11-go-compile-only-r8.json).

MACH04 native R7 terminal update, 11 October: wrapper exit 2, zero cases executed, before guest/test execution; this is not a failed assertion. Receipt SHA-256 `bc39d3b460d51015c01b6b33755c0c92330783a002c0190ef69c15b9643fa577`. Owned-container drift followed Go process start; the daemon `OomKillDisable` observation changed false to null, likely fixture-guard normalization, diagnosis ongoing. Cleanup incomplete and start-Go unconfirmed; host/VM floors clean, watcher joined, custody clean. One owned Go compile container remains and blocks new heavy work pending exact cleanup. Native source `7ced6aa9d2bdbe23a24b049320fdf84e670b9003f220fc6067131fd37a9d7c76` is unaccepted. [Evidence](evidence/PROD-MACH-04/2026-10-11-go-native-r7-r2.json).


The old 94 witness tag `localhost:5000/zenith-j2-witness:rc` was removed and exact-tag absence was confirmed; its receipt makes no J2 acceptance claim. Go cleanup R3 is complete; native R8 terminated with wrapper exit 2 before any case executed. [Cleanup evidence](evidence/PROD-CI-08/2026-10-11-cleanup-reconciliation-r4.json).

Native R8 is terminal at wrapper exit 2 (`daemon-build-exit`) with zero executed cases. Cleanup and custody are complete; preserve this as a wrapper refusal rather than a test failure. Diagnosis remains ongoing, and no acceptance or release state changes. [Evidence](evidence/PROD-MACH-04/2026-10-11-native-r8-terminal-r2.json).


## 12 October fresh full-core result

Fresh R16 on exact frozen source `c45c95915531799b455b0f21faf7885de05ba6db` exited 0: 24,575 passed / 1,943 skipped / 0 failed across 26,518 exact identities; source stayed stable. Treat this as core execution evidence, with skips still skipped. Native witness, J1/J4, and browser acceptance remain queued. Historical failures and refusals remain preserved. Ledger: 10 verified / 66 in progress / 2 planned; no promotion or release-flag change. [Evidence](evidence/PROD-CI-08/2026-10-12-c45c9591-fresh-full-core-r16.json).


## 12 October witness and J1/J4 prepare update

The old fixed witness tag was rotated cleanly and its image preserved; fresh R13 built the source-bound ARM64 witness image with no push. R13 remains build-only, with full-run acceptance pending. Fresh R15/R5 joined preparation ended exit 1 with a sticky `parent_bracket_mismatch` custody quarantine and retained owned state. J4 prestart 14/0 and pre-API 13/0 are phase-only; outer joined execution was refused. No cleanup receipt proves resource deletion. CA trust was not changed; AirPlay remains off under prior authorization. Keep J1/J4 and J2 acceptance pending. [Rotation](evidence/PROD-CI-08/2026-10-12-c45c9591-witness-tag-rotation-r3.json) · [Build](evidence/PROD-CI-08/2026-10-12-c45c9591-j2-witness-r13-build.json) · [Failure diagnosis](evidence/PROD-CI-08/2026-10-12-c45c9591-j1-j4-r15-prepare-failure.json).


## 12 October offline DNS and recovery-hold status

Offline DNS R3 passed 59/59 pinned assertion identities on unchanged c45 source; nine held commands closed cleanly. R2's wrapper exit 1 from the suite-count expectation remains historical and unaccepted. This is offline unit coverage only, with no live DNS or milestone acceptance and no addition to full-core totals because overlap is unknown. Clarification: R13's ARM64 witness image build succeeded; invoking that built image for acceptance is still pending. The c45 Node/DOM full-core result is already 24,575 passed / 1,943 skipped / 0 failed. Cleanup R2 remains HOLD pending deterministic-gap review; registry R2 remains HOLD while its test/telemetry baseline fix is in progress. No acceptance or ledger change. [DNS R3 evidence](evidence/PROD-CI-08/2026-10-12-c45c9591-dns-offline-r3.json).


## 12 October registry held-test disposition

Strict held R4 passed the explicit 87 R16 baseline +13 staged-parent tests (100/100; no runtime skips), with exact pinned identity sets, stable source, and clean custody. The earlier 103-method attempt remains failed/unaccepted at 100 pass /2 fail /1 error; preserve it. Three R17-only capacity method identities are excluded from this R16-policy scope, not skipped or passed. The event/identity bounds remain 128; R17's expanded event and byte-guard contracts remain deferred and unclosed. Focused fake-only proof is not production/engine acceptance; exact consumer/source binding review remains required for integration. Cleanup R3 is HOLD with two defects; R4 cleanup guards/review remain pending. No gate waiver or ledger promotion. [Evidence](evidence/PROD-CI-08/2026-10-12-c45c9591-registry-policy-unit-r4.json).


## 12 October cleanup and successor readiness

R4 cleanup was a preflight refusal before lock/work/engine because its capture parser expected a dictionary but received the preserved R15 list; original resources were untouched. Its separate synthetic guards passed 11/11, with independent review allowing only a fresh, internally gated cleanup attempt. Cleanup R5 adds strict list parsing and exact retained-lock recovery; source review and focused parser/lock tests remain pending, so cleanup has not occurred. Phase successor bindings pass source review but actual invocation is pending; historical R16 stays unchanged. J6 remains HOLD on the missing owner-authorized generated PostgreSQL credential readback; source-only producer drafts do not satisfy it. [Evidence](evidence/PROD-CI-08/2026-10-12-c45c9591-cleanup-successor-j6-readiness-r4.json).


## 12 October current status and cleanup R5 preflight

The full c45 Node/DOM core is already green at 24,575 passed /1,943 skipped /0 failed. The ARM64 witness image build passed; invocation of that built image for acceptance remains queued. Cleanup R5 preflight closed exit 2 after 11/12 guard cases passed. The lone failure is a test-fixture AttributeError (`read_private_stable` missing), independently confirmed as fixture-only. Actual cleanup was not entered; original resources and sticky marker remain untouched. R5 source review is conditional on focused tests; fixture R2 repair is pending. Cleanup R3 stays HOLD; no product change or milestone promotion. [Evidence](evidence/PROD-CI-08/2026-10-12-c45c9591-cleanup-r5-preflight-r1.json).


## 12 October cleanup R5 attempt

The corrected R5 parser/lock-guard preflight passed all 12 synthetic cases and independent terminal review; this supported a cleanup attempt subject to fresh runtime gates. That actual attempt admitted the lock, created owned work, and completed initial census, source freeze, and owned inventory, then failed exit 1 at `protectedImagesBefore` (`held-command-not-strictly-settled`) before owned-down/removal began. No resource deletion is claimed. The marker remains retained; no new exact-byte readback is asserted. Keep both prior R5 preflight history and actual cleanup failure. Full core is already passed; the ARM64 witness image build passed and invocation for acceptance remains pending. [Evidence](evidence/PROD-CI-08/2026-10-12-c45c9591-cleanup-r5-attempt-r2.json).


## 12 October CI and focused-run status

The c45 Node/DOM full core is already passed (24,575 /1,943 skipped /0 failed); the ARM64 witness image build passed, with image acceptance invocation pending. c45's prior terminal CI inventory remains unchanged. The newer exact-source 34764541 inventory is nonterminal: 22 success, 8 skipped, 2 running, 0 failed across three workflows. Cleanup R5 stopped before deletion after two optional build references were absent and custody settled cleanly; R6 remains HOLD, R7's corrected source review is conditional PASS, focused proof pending. OBS04 R2 raw 10/10 assertions are unaccepted because wrapper ancestor validation failed and final freeze/floor evidence is absent; source-reviewed R3 rerun remains pending. [Evidence](evidence/PROD-CI-08/2026-10-12-c45c9591-r5-r7-obs04-and-ci-r3.json).


## 12 October OBS04 focused R3 result

OBS04 R3 passed terminal review for the focused actual-owned Temporal run: 10/10 tests, 5/5 suites, exact identities, nine settled commands, stable c45 source, and final floor/cleanup checks. Scope remains narrow; it does not establish broad OBS04, default maintenance effects, J4 natural-timer acceptance, or production acceptance. Keep the R2 wrong-ancestor wrapper failure unaccepted and preserved; its four owned cache artifacts were later removed by a separate cleanup receipt. Cleanup R7 remains pending. Ledger and flags unchanged. [Evidence](evidence/PROD-CI-08/2026-10-12-c45c9591-obs04-focused-r3.json).


## 12 October cleanup-helper and CI checkpoint

Protected-image helper R6 reports 18/18 and custody-guard R8 reports 8/8 on stable c45 source; each used nine strictly settled held commands and remained above the 12 GB floor. Independent terminal reviews are pending, so neither is acceptance yet. Preserve failed helper R2 (17/18, unused joined command) and custody R7 (2/8, plural-key/snapshot-count defects). R8's minimal source fixes have conditional review approval; actual cleanup R8 has not started. Latest 34764541 CI snapshot is 23 success /8 conditional skips /1 running /0 failures across three exact-SHA workflows; c45's terminal CI is unchanged. Full core remains passed, witness image build passed with image invocation pending. [Evidence](evidence/PROD-CI-08/2026-10-12-c45c9591-cleanup-helper-r8-preterminal.json).


## 12 October cleanup R8 and helper-review update

Terminal reviews pass the focused R6 protected-image helper (18/18) and R8 custody guards (8/8); both are scoped unit/guard proofs, not cleanup acceptance. Actual cleanup R8 failed after successful list and inspect at a validator that rejected digest-qualified `RepoTags`; it stopped before predelete/down/delete. Lock admission and owned work occurred, so this is not a preflight refusal. No resource deletion is claimed. R9's helper source review is conditional-positive; its 21-capture regression and 50-identity context remain pending. CI347R6 remains nonterminal. Preserve the R2/R7 helper failures and prior core/witness scope; no ledger or flag changes. [Evidence](evidence/PROD-CI-08/2026-10-12-c45c9591-cleanup-r8-terminal-and-failure-r9-review.json).


## 12 October cleanup R10 and carrier CI disposition

Cleanup R10 closed exit 1 after partial deletion at held command 004 (`cleanup-image-disappeared-with-refs`, default-stack adapter R3 line 265). The before and predelete protected-image checks passed; the after-check is unproven. No postinventory, cleanup receipt, final checkpoint, or lock clearance exists; retain the lock and treat recovery as active. The 004 custody stream is complete (329 events, no drop/error/quarantine/off-root/pending-live events); 107 absence records do not reconstruct 150 root admissions. This is not cleanup completion or acceptance.

Carrier CI1e3 is terminal 23 success /8 skipped /1 failed across 32 jobs; `platform-postgres` is the sole failure and Verify passed after 28m49s. The failure is the raw `za_` canary matching a generated base-36 fixture ID. A two-file isolated fixture candidate uses cryptographic 128-bit lowercase-hex suffixes and adds a deterministic collision regression; source review passed and focused proof is pending. Existing canary assertions remain. Because these test files change the source freeze, old c45 R16/R13 receipts cannot certify the successor; new R16/R13 and R15/direct-consumer pins are required. Ledger and release flags unchanged. [Evidence](evidence/PROD-CI-08/2026-10-12-c45c9591-focused-canary-r3-and-cleanup-r10-status.json).


## 12 October focused canary proof and cleanup recovery hold

The focused memory/PGlite run is now supported by a terminal supplement: 124/0/0 assertions across two files, 36 derived suites, with strict custody and source freezes. The original wrapper metric failure remains intact; the review validates its underlying report and corrects the suite-count interpretation. This is not PostgreSQL CI or production acceptance.

Cleanup R10 remains a failed partial cleanup at command 004. No post-delete image proof, postinventory, cleanup receipt, checkpoint, or lock clearance exists; the lock remains retained. The R4 adapter candidate and 24-vector proof are not cleanup acceptance, and read-only R12 census/context proof is pending. Do not replay the failed down stage. CI1e3 remains terminal at 23 success /8 skipped /1 `platform-postgres` failure; Verify passed in 28m49s. Source change requires fresh R16/R13 and R15/direct-consumer pins. Ledger/flags unchanged. [Evidence](evidence/PROD-CI-08/2026-10-12-c45c9591-focused-canary-r3-and-cleanup-r10-status.json).


## Current verification checkpoint — 14 October 2026

Exact fork source `38e98cbb9ff3741ce85fd67b0d8821ef305c72de` has terminal CI: **24 successful jobs / 0 failed / 8 conditional skips across 32 jobs**. Main CI passed20 jobs; both native packaged-worker architectures passed22 checks each; Linux systemd and Windows ACL targeted leaves passed. The15 Windows sibling exclusions remain outside the targeted leaf. Operated jobs are still gated; this is not production acceptance.

Separate frozen source `5ca58d93a69d75260e291bd3cbc7593dd609daf4` passed the canonical native PostgreSQL stage: **4,142 passed / 0 failed / 15 allowed skips**, all1,160 required identities and exact100 cleanup-writer-barrier cases passed. Independent terminal review confirmed source/tool stability, complete custody with no overflow, credentials absent and terminal process absence. Its ARM64 W witness image build also passed independent terminal review without a registry push. Earlier refused PostgreSQL attempts remain refused.

The separate local recovery attempt passed its inner10 tests but **remains refused** after an ambiguous process capture and incomplete held closeout. Independent forensics now confirms all59 tracked PIDs absent and secret files removed; this does not retroactively pass that attempt.

PKG-03's reviewed supervisor fixes passed21 focused regressions. Its R6 attempt reached fresh-image build but was stopped when macOS host memory pressure changed from normal1 to warning2; the package harness exited130 with zero completed checks. Docker usage stayed below0.7GiB and host disk above247GB. Cleanup-only passed19 strict held commands: the sole fresh owned builder/container/volume is absent and the unrelated current baseline is preserved; independent terminal review passed. No package acceptance is claimed. Earlier setup failures and refusals remain preserved. J1/J4/J2 bindings are source-reviewed but unrun. PKG-03 actual image execution, OBS-04 default effects/restart acceptance, and MACH-03 consent-registered delivery remain pending. Ledger stays **11 verified / 65 in progress / 2 planned (14.1% verified)**; all release flags remain false.

Evidence: [stage-scoped verification and terminal CI](evidence/PROD-CI-08/2026-10-14-5ca58d93-platform-w-38e98cbb-ci.json).

The MACH-03 coordinator now derives its repository root from its module URL instead of a hardcoded Mac path. Independent source review, Node22 syntax validation and two isolated-location checks passed, including a clone path containing spaces. Source-scope, symlink and authorization checks are unchanged. Fresh coherent source binding and actual registered delivery remain pending; the frozen5ca evidence is not relabelled.

## E3 J4 preflight result — 14 October 2026

J4 R1 exited 2 after default-stack startup, registry migration and push succeeded at pressure max 1. The host-pooler-select1 preflight failed before any client or query because the private-node probe targeted the old F2D0 output directory while the adapter created the E3 directory. This establishes a path mismatch only; the database was not shown to refuse service. The machine phase did not run, phases are none, and source-binding stability was not reached. Root sealed 1,010 files; 272 positive PIDs and 252 actual PGIDs were absent twice. Canonical owned cleanup completed (tool session 10354 exit 0; root PID 28416; 39 command rows; diagnostic `j4-774878dc`), removing 19 resources with 0 owned remaining and 0 forced stops (`productionReady=false`; terminal hash `8605e1280b20791a9f56bdf52e5b7b130fefad53f9a2a6f704c40d4642fcb84b`). Source/tool/protected-resource checks passed at pressure max 1; private failure evidence and full stack archive were preserved. Cleanup custody is now complete: 213 files sealed; 39/39 commands exited 0 with strict closure (16 VM rows included); 69 positive PIDs and 39 actual PGIDs were confirmed absent twice under current boot/flock. Closeout hash `3f5e23ef5e1569780b0b1b2d034ca20c011514816e60843f1b75630adb83a84d`; guard-clear hash `1ae6eb00989666c754f2394cd74132f641fcc2d7f24d2b2c7dc1bd58672c75a8`. Fsynced proof preceded guard clear; 0 resources remain, and original failure evidence plus private stack archive were preserved. J4 R2 (tool 9481 / root PID 29643) failed exit 2 after startup and its J4 preflight SELECT 1 passed; machine-schedules then exited 1 at the `lease_exclusion` deadline. A separate follow-up protocol diagnostic (tool 46867, root PID 32665) later passed parameterized SELECT 1 in 21.514 ms; it was not part of the J4 run. Held closeout passed, source postflight was not reached, and the stack remains for diagnosis. No acceptance. [Bounded evidence](evidence/PROD-OBS-04/2026-10-14-e3cf-j4-r2-stall.json). This cleanup-only closeout does not accept J4. Preserve J4 acceptance as pending. Independent R4 review approved only a private-probe path correction and four pins; no product fix or acceptance follows. [Sanitized evidence](evidence/PROD-CI-08/2026-10-14-e3cf-j4-probe-path.json).

Fresh ARM64 W build-only exited 0 with witness hash `79796632944e6e9759c387c547ebba9dad620d1db59050639ca16769199d8ca5`; root proved 36 PIDs and 33 PGIDs absent twice. This is not witness entrypoint execution or J2 acceptance. Exact-source CI is green at 24 success / 8 conditional skips / 0 failed across 32 jobs. Full local verification is 24,720 passed / 1,943 conditional skipped / 0 failed, 26,663 identities. Milestones and release flags are unchanged. [W and CI evidence](evidence/PROD-CI-08/2026-10-14-e3cf-j4-probe-path.json).

F7EB push CI run 38579269656 is terminal at 19 successes / 1 Go failure / 8 conditional skips. Its Docker build failed resolving Ubuntu package archives before PID1 test emission; race and package-native substeps passed. Separate manual CI 38579457963 completed at 20 successes / 0 failures / 8 conditional skips. Fresh Go job 115919864408 passed native race/golden and real systemd operations. Artifact 11904621856 returned HTTP 503 due account egress quota; raw fresh guest counts remain unverified. The push failure remains historical evidence; no retry is claimed. [Evidence](evidence/PROD-CI-08/2026-10-14-f7eb-go-dns-failure.json).

### 14 October current CI and bounded browser-step candidate

Run 38588888074 for pushed source 4606571d is terminal failure: 19 successes, 1 agent-job failure, and 8 conditional skips; every job is terminal. Agent job 115938153948 failed at the real-browser approval screen: Next exited 77 after one development-memory restart, with no OOM or forced stop observed, and the 380px Deny locator timed out. Event ordering and failed-run heap/RAM values were not captured, so this does not establish a browser root cause or J4 cause. Verify, platform-postgres, and Go passed; native worker 38588888634 and native platform 38588888234 each passed 2/2. The committed two-line 4096 heap patch on source 99ba2a0f passed actionlint and 136/136 focused release-gates tests; publication is being prepared and fresh real-browser validation remains pending. J4’s wrapper remains HELD and UNEXECUTED; canonical NODE_ENV=test / owned ToFu / health 9464 bindings are reconciled, while independent source review has passed; execution remains pending. No J4 cause or acceptance, milestone promotion, or release-flag change. [Evidence](evidence/PROD-CI-08/2026-10-14-browser-heap-budget.json).

### 14 October 6CE5 terminal CI

Exact source `6ce5f1ed6142b7c9e8c5bd4fca840f808f027bac`, run 38593806448, is terminal failure: 19 success / 1 failure / 8 conditional skips across 28 jobs. Verify passed 24,738 / 1,925 skipped / 0 failed (26,663 identities; 1,155 files passed / 97 skipped), and browser job 115955225180 passed 44/44 with clean child teardown. Reconciliation job 115955225212 is the sole failure: the schema lock was acquired, but the wait for the triggered schedule action timed out before SQL-waiter observation; workflow/activity pollers were ready. Cause remains unresolved; this does not prove a PostgreSQL lock failure or link to J4. Go and platform-postgres passed. Native platform passed 2/2; AMD64 packaged worker passed, while ARM64 failed in fresh-image `dependency_install` before product checks; all six cleanup fields were true. Eight conditional operated jobs remain skipped. J4 BG2 separately refused at temporal-rpc before worker spawn; the raw-RPC correction passed independent review and remains HELD/unexecuted. No promotion; milestones stay 11/65/2 and release flags false. [Evidence](evidence/PROD-CI-08/2026-10-14-6ce5-ci-terminal.json).
