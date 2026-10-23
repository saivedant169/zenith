# Owner requests, 2026-10-23

Everything here needs a decision, an account, money or signoff that only the owner can give.
All work that needs none of these continues without waiting. Status: 32 of 78 requirements verified.

## Decisions (no account needed)

| # | Decision | Blocks | Options and recommendation |
|---|---|---|---|
| 1 | Isolated build runtime. gVisor `release-20260928.0` cannot join the pod user namespace that `hostUsers: false` requires (hosted run `39885437619`; `verify/ISOLATED-BUILD-PROFILES-REVIEW.md`). | DRV-1 private source, LIFE-09, LIFE-10 (source-to-readback), wave6-kind gate (LIFE-07/08, part of LIFE-03), CI-08 and REL-01 evidence | **Recommended:** the reviewed runc fallback with `hostUsers: false`, the same seccomp and AppArmor profiles and the user-namespace probe; re-derive the profile digest. Alternative: keep gVisor and drop `hostUsers: false` for that class (larger change to the reviewed model). |
| 2 | PROD-PKG-06 scope. Acceptance names hosted Supabase TLS, pooler, authorization and recovery; required levels are local only. | PKG-06 | Narrow to local PostgreSQL contracts, or keep hosted Supabase in scope (needs a hosted project, item 9). |
| 3 | PROD-LIFE-01 scope. Acceptance covers every supported provider and customer runner form; only Kubernetes is proven at engine level. | LIFE-01 | Narrow to Kubernetes, or prove AWS/GCP/Azure/OCI lifecycle with cloud accounts (item 9). |
| 4 | PROD-MACH-05 scope (Kubernetes runner transport does not exist). | MACH-05 | Build a Kubernetes runner transport, or accept a real AWS/OCI runner. |
| 5 | OPS-01 SLO targets, OPS-07 retention defaults, MAN-07 pricing. | OPS-01, OPS-07, MAN-07 | Business values only the owner can set. |
| 6 | Second Docker cleanup pass (~20 GB: builder `zenith-newmac-build`, `zenith-mach02dbg`, stopped `supabase_db_zenith-local-*`, digest-only rust image, labelled volumes). | Disk headroom only | Optional. |

## Credentials and accounts

| # | Need | Blocks | Notes |
|---|---|---|---|
| 7 | GCP Cloud Billing Catalog API key (free; a Google Cloud project, no billing) as a file for `ZENITH_LIVE_GCP_CATALOG_API_KEY_FILE`. | COST-01, COST-02 | AWS/Azure/OCI refresh already runs (dry run `evidence/PROD-COST-01/2026-10-23-live-refresh-dry-run`). Adoption waits for GCP so pinned figures change once. |
| 8 | Anthropic API key for the real coding-agent evaluations. | MACH-06 | Scripted harness is a model, not engine proof. |
| 9 | Sandbox cloud accounts with budgets: AWS, GCP, Azure (plus sovereign if LIFE-04 stays in scope), OCI tenancy; hosted Supabase project if item 2 keeps it. | LIFE-01/04/05/06 and every live_sandbox/operational_rehearsal requirement below | Trust files now take the fork repository as input (`deploy/live-sandbox/aws/main.tf` `github_repository`, OCI example placeholders). Steps: `docs/build/production/LIVE-ACCEPTANCE.md`. |
| 10 | Supervised Claude Code and Codex CLI sessions with the owner's logins. | UX-02 | Interactive; the owner drives, the agent records. |

## Requirements that need live sandbox or operational rehearsal

MIX-01..07, MAN-01..07, OPS-01..09, REL-01..04 (27), plus LIFE-01, LIFE-04, LIFE-05, LIFE-06 by acceptance wording.
Signoff (REL-03) stays with the owner after evidence exists.

## Not blocked (in progress here)

UX-01 (all hosted lanes green; operated plugin-platform case being built), COST-03
(needs a usage meter and seven days of real telemetry), LIFE-11 (adopted-object teardown built and kind-gated; tenant backup, MinIO arm64 runtime, MySQL DNS/TLS open), PKG-06 local half.
