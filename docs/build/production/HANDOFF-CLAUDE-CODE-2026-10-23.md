# Handoff: Claude Code session, paused 2026-10-23

Fork `saivedant169/zenith`, branch `codex/production-2026-10-02`. Work was done in the worktree
`/Users/saivedanthava/.codex/worktrees/dev-port-offset/zenith` (detached HEAD, pushed with
`git push origin HEAD:codex/production-2026-10-02`). Upstream `GODOSTROYER/zenith` was not touched.
The last commit before this file is `130390b0`. The working tree is clean apart from untracked user files.

## Ledger

30 of 78 verified, 46 in progress, 2 planned (`docs/build/production/ledger.json`). Promoted in this
session: PROD-PKG-02 on `c8967b15`, after independent review (PROMOTE on the fourth round).

## Hosted gate status (`.github/workflows/operated-gate-linux.yml`)

| Gate | Status | Evidence |
|---|---|---|
| drv2-drift-repair, drv2-crash-partition, drivers-d4-two-tenants, j15-operated-upgrade, j15-operated-restore | passed (ubuntu-latest) | `docs/build/production/evidence/PROD-CI-08/2026-10-21-*` |
| drivers-d4-export | passed, run 39737514124 on 86b37e7a | `.../PROD-CI-08/2026-10-22-86b37e7a-drivers-d4-export-hosted.json` |
| drv1-update-rollback | passed 8/8, native ubuntu-24.04-arm, run 39808050607 on 5d9bf648 | `.../PROD-CI-08/2026-10-22-5d9bf648-drv1-update-rollback-hosted-arm64.json` |
| drv1-private-source | **in progress**, not yet passed | see below |

The J2 clean-host journey (`clean-host-journey.yml`) runs native amd64 and arm64 legs and passed 20/20 on
both at `c8967b15` (run 39772691346).

### drv1-private-source: where it stands

The last run with a result, 39840957288, passed `preconditions`, `source-build-preconditions` and
`browser-source-binding`. It failed at `private-source-snapshot` because the recreated execution worker
crashed at startup (category `configuration`, "Execution stopped unexpectedly").

Root cause, fixed in `08890406`: the source fixture recreated api/worker from the raw `stack.compose.json`,
but on native Linux J1 composes from `stack.compose.staged.json` (uid-owned 0400 private bind copies).
The same commit makes the J2 build-worker memory cap configurable (`ZENITH_J2_BUILD_WORKER_MEMORY`) and
sets 3g on the hosted gate, ahead of the J6 build.

Run 39845300936 (on `08890406`) was still in progress when paused; it is the first run with that fix.
Check it first:

```bash
gh run view 39845300936 -R saivedant169/zenith --log | grep -E 'operated step|outside-step|http-refused|command-failed|drv1-[a-z-]+:| (passed|failed|skipped)$'
gh run view 39845300936 -R saivedant169/zenith --log | grep 'Application warnings and errors' | grep -E '^.*(== |[0-9]+x |last:)'
```

Rerun:

```bash
gh workflow run operated-gate-linux.yml -R saivedant169/zenith --ref codex/production-2026-10-02 -f gate=drv1-private-source
```

Remaining receipt checks after the snapshot: isolated-private-build (real J6 rootless build in gVisor),
provenance-verified-deploy, browser-snapshot-approval, source-revocation-refused,
post-revocation-proposal-refused, independent-source-readback. Owned cleanup also failed in recent runs
(`operations/:id/cancel` 409 `invalid_state` on the stuck operation); re-check it once the worker runs.

## Product bugs found and fixed by the hosted DRV-1 gates

- `5e1bec82`: in-place Kubernetes updates had no reviewable plan (`forcesReplacement` missing in
  `src/lib/execution/direct-kubernetes.ts`), so every Kubernetes update failed at approval.
- `033dc583`: the GitHub bind form page sent `Referrer-Policy: no-referrer`, so the browser's own POST
  carried `Origin: null` and step-up refused it (`src/app/api/platform/v1/github/callback/route.ts`).

## Findings that change scope

- PROD-MACH-05 (review: HOLD). Kubernetes runner-mode connections can be created and bound but never
  operate: `src/lib/platform/credentials.ts:485` denies non-OCI runner sessions and nothing enqueues
  `k8s.http`. The AWS runner pins `*.amazonaws.com` over HTTPS (`go/internal/runner/kinds/awshttp.go:66`),
  so LocalStack cannot stand in. Closing it needs a real AWS/OCI runner (cloud) or new Kubernetes runner
  transport work (product decision).
- PROD-COST-01/02: local suites pass (1058/0/35, PostgreSQL lane 18/0/0, recorded in `acf0dc91`). The open
  gap is a reviewed refresh of the bundled price catalog from official provider price files.
- wave6 kind lanes (`managed-kind`, J6 `kind`, `operated-release`) are blocked on
  `ZENITH_ISOLATED_BUILD_PROFILES`, not on tenant custody (the ledger note "harness predates tenant operator
  custody" is stale). No hosted workflow runs them yet.

## Next steps (no cloud accounts needed; owner instruction 2026-10-23)

1. Finish drv1-private-source. Then record evidence for PROD-CI-08, PROD-REL-01, PROD-LIFE-09 and run
   independent reviews.
2. Add a hosted wave6-kind gate on ubuntu-24.04-arm that reuses `scripts/release/drivers/drv1-isolation.ts`
   (Calico, gVisor, seccomp, AppArmor, approved profile digest) and sets `ZENITH_ISOLATED_BUILD_PROFILES`;
   run managed-kind, J6 kind and operated-release (PROD-LIFE-07/08/09/10, part of LIFE-03).
3. Hosted-closable triage list (Haiku triage, 2026-10-23): LIFE-11, UX-02, UX-03, COST-03, OBS-02, LIFE-01,
   LIFE-10, then the hosted parts of OPS-03 (N-1/N matrix), MIX-04, OPS-07, MAN-02, LIFE-06, LIFE-03, OPS-09,
   MACH-06.
4. Promote only after an independent (Haiku) review returns PROMOTE with all required levels on one commit.
5. Then the consolidated cloud-account request (see `docs/build/production/LIVE-ACCEPTANCE.md`; the AWS
   and OCI trust files hard-code `repo:GODOSTROYER/zenith` and must point at the fork first).

## Owner decisions pending

1. MACH-05 runner scope (AWS/OCI runner with cloud accounts, or build a Kubernetes runner transport).
2. Cloud accounts for the live-only and mixed requirements (owner will provide after the non-cloud work).
3. OPS-01 SLO targets, OPS-07 retention policy (DEC-RETENTION), MAN-07 pricing/terms/payment account.
4. Second Docker cleanup pass (~20 GB): the running `zenith-newmac-build` builder, running
   `zenith-mach02dbg` and `zenith-c1ba963525e2…-api-1`, stopped `supabase_db_zenith-local-*` containers with
   `supabase/postgres:17.6.1.075`, the digest-only rust image, and labeled test volumes.

## Working notes

- Node 22: `/Users/saivedanthava/.local/share/zenith-verifier/node-v22.23.3-darwin-arm64/bin`;
  actionlint: `~/.local/share/zenith-verifier/bin`; Docker: `DOCKER_HOST=unix:///Users/saivedanthava/.docker/run/docker.sock`.
- Typecheck: `NODE_OPTIONS=--max-old-space-size=8192 npx tsc --noEmit -p .`
- Pre-existing failures, unchanged: `tests/deploy/default-stack-j4.test.ts` (16).
- Operated diagnostics are on in the hosted gate (`ZENITH_OPERATED_DIAGNOSTICS=1`): fixed-vocabulary failure
  codes, Playwright first lines, elided command stderr, worker message keys from recreated containers.
- Watch hosted runs with `gh run watch <id> --interval 120`; parallel fast watchers exhausted the GitHub API
  limit once.
