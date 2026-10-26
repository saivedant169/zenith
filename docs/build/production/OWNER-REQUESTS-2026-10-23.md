# Owner requests, 2026-10-23 (revised after the owner's bounded authorization)

Status: 32 of 78 requirements verified. Work that needs nothing below continues without waiting.

## Decisions recorded (owner, 2026-10-23)

| Area | Decision | Where it is enforced or recorded |
|---|---|---|
| Isolated builds | runc fallback approved for **disposable build verification only**, on dedicated ephemeral single-tenant build hosts. Keeps rootless BuildKit, `hostUsers: false`, enforced seccomp/AppArmor, restricted egress, resource limits and every negative isolation probe. No privileged mode, no cloud-admin credentials in builds. gVisor stays where supported (tenant runtime). Not a production or shared-tenant isolation approval. Profile digest must be re-derived and independently security-reviewed before execution. | `deploy/zenith-managed/build/profiles/zenith-build-runc.runtimeclass.json`, `verify/ISOLATED-BUILD-PROFILES-REVIEW.md` |
| PKG-06 | Keep hosted Supabase (TLS, pooler, authorization, recovery) in scope, on a disposable hosted project. | ledger PROD-PKG-06 |
| LIFE-01 | Keep AWS, GCP, Azure, OCI and Kubernetes. Commercial regions first; sovereign variants reported as untested. | ledger PROD-LIFE-01 |
| MACH-05 | Existing AWS customer-side runner first, then OCI. No Kubernetes runner transport: it stays explicitly unsupported/deferred. Unmet promised runner coverage stays open. | ledger PROD-MACH-05 |
| Budget | $100 aggregate infrastructure allowance (four clouds plus disposable Supabase), at most $30 estimated per run across all providers, separate $20 for Anthropic evaluation calls. Stop launching chargeable work at 80% of either allowance and reconcile. Run tags, 4-hour default TTL, cleanup on failure, independent deletion readback. No GPUs, commitments, recurring subscriptions, real customer charges or production mutations. Longer telemetry/soak runs need a separately priced reservation. | `permissions.json` (`budgets`, `allowances`, `sandboxes`), shared ledger `budget-ledger.json`, `scripts/release/scope.ts` |
| Business baseline | 2026-10-13 decisions reconfirmed (DEC-RETENTION, DEC-BUSINESS in `REQUIREMENTS.md`): 99.9% control plane and separately measured 99.9% managed runtime (engineering targets, not SLAs); API p95 < 500 ms; 95% dispatch within 30 s after approval; RPO 15 min, RTO 4 h for covered data; logs 30 days; sensitive payloads deleted within 72 h after completion subject to legal holds; audit at least one year, never auto-deleted; Explore free, Builder $29 minimum, Team $199 minimum, Enterprise by contract, max(minimum, $0.015 x managed-resource-hours). Stripe stays test mode; payment activation, terms, tax and Enterprise contracts remain separate decisions. Deletion verified on disposable data only; never enabled on existing installations because of this policy. | PROD-OPS-01, PROD-OPS-07, PROD-MAN-06/07 |

The permission manifest is **not approved yet**. Every cloud sandbox identity is `null`, and the scope refuses any action on a provider whose identity is unconfirmed (`sandbox_unconfirmed`). Approval is done by you, in a terminal, after the identities are filled in (step 8 below).

## One-time secure setup (owner, on the Mac mini)

Nothing here goes in chat, logs or command arguments. Secret files go in `~/.config/zenith-secrets/` (directory 0700, files 0600). Paste with `pbpaste > file` so values never reach shell history.

```bash
umask 077; mkdir -p ~/.config/zenith-secrets
```

1. **AWS** (short-lived SSO session). Install the AWS CLI v2, then sign in to the sandbox account only:
   `aws configure sso --profile zenith-sandbox` and `aws sso login --profile zenith-sandbox`.
   I then read the account ID with `sts get-caller-identity`, plan `deploy/live-sandbox/aws` (GitHub OIDC trust for
   `repo:saivedant169/zenith:environment:live-sandbox`, no access keys) and show you the plan before applying.
   _Owner answer 2026-10-24 (DEC-CLOUD): AWS sandbox approved only, $10 per run; GCP, Azure, OCI, Supabase, owned DNS and private GitHub fixtures still pending._
2. **GCP** (your user account). Install the Google Cloud CLI, then `gcloud auth login` and
   `gcloud config set project <sandbox project>`. I then enable `cloudbilling.googleapis.com`, create one API key
   restricted to that API, and write it straight to `~/.config/zenith-secrets/gcp-catalog.key` without printing it
   (`ZENITH_LIVE_GCP_CATALOG_API_KEY_FILE`). Workload identity federation for live runs follows from
   `deploy/live-sandbox/gcp`, again shown as a plan first.
3. **Azure.** Install the Azure CLI, `az login`, `az account set --subscription <sandbox subscription>`.
   OIDC federation from `deploy/live-sandbox/azure` (no client secret) is planned and shown first.
4. **OCI** (session token). Install the OCI CLI, then
   `oci session authenticate --profile-name zenith-sandbox --region us-ashburn-1`, and tell me the sandbox
   compartment name.
5. **Anthropic** (MACH-06). Create an API key in the Anthropic Console, ideally in a workspace with a spend limit at or
   below $20, then `pbpaste > ~/.config/zenith-secrets/anthropic.key`.
6. **Disposable hosted Supabase** (PKG-06). Create a new project in your Supabase organization used only for this test
   (any charge counts against the $100). Put its values in `~/.config/zenith-secrets/supabase-pkg06.env`:
   `NEXT_PUBLIC_SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_DB_URL` (transaction pooler, port 6543,
   `sslmode=verify-full`), `SUPABASE_PROJECT_REF`.
6a. **Stripe test mode** (pricing verification only). A Stripe **test-mode** secret key (`sk_test_...`) from the
   Stripe test dashboard: `pbpaste > ~/.config/zenith-secrets/stripe-test.key`. A live key is refused by the adapter.
7. Tell me "setup done" and the profile names if you changed them. I read only identifiers (account, project,
   subscription, tenancy and compartment IDs, regions) and post them for your confirmation before any mutation.
8. After you confirm, I write them into `permissions.json`; you approve that exact content in a terminal:
   `npx tsx scripts/release/permissions-cli.ts approve --by "<your name>" --days 30`
   (it shows the digest and asks you to type its first 12 characters).

Later, scheduled separately: **UX-02 supervised session.** You sign in to Claude Code and Codex through their official
clients (`claude mcp login`, `codex mcp login`); I drive the Zenith connection, proposal, approval, deployment,
observation, revocation and reconnection paths and record real-client evidence apart from MCP test-client evidence.
In the same sitting, a **VoiceOver walk** for PROD-UX-01 (about 30 minutes, macOS VoiceOver, Safari or Chrome) over
every page the automated audit covers: operation review, approve and cancel; reapproval after a replan; the
uncertain-outcome callout; runbook approval and progress; platform readiness; connection administration and the
connection change confirmation; the AWS connect page; legacy cancellation (offered, confirming, and as a viewer); the
legacy deployment projection; and the MFA enrolment and step-up dialogs. You drive VoiceOver; I record what it announces (name, role, state) and where
focus lands after each action, from its caption panel, and fix any defect it finds. This is the one accessibility check
automation cannot do.

## Decision: teardown after deploy (added 2026-10-24; answered 2026-10-26)

**Answered 2026-10-26 (owner delegated the decision; recommended option B, revised, taken).** Decision 1: a refused teardown freezing an environment is not intended. The fix is superseding hold generations, released only when the inventory drains. Decision 2: revised option B is accepted with its residual risk (a provider-side asynchronous operation can finish after teardown verified absence; mitigated by delayed re-verification and cost reconciliation) and the post-deploy wait of about 1 to 2 hours. Recorded in the design document's "Decisions (2026-10-26)" section. Work packages follow in this order: WP1 expand schema, WP5 hold lifecycle, WP2 inventory rules, WP3 settlement writers, WP4 direct-path origin, WP6 wiring and UI, WP7 journeys and live. WP1 to WP5 each get an independent adversarial review before merge.

The original request is kept below for the record.



An environment that has been deployed cannot be torn down through the product today. Destroy is refused before
anything is deleted, and on the OpenTofu path a refused teardown appears to leave the environment permanently
undeployable. Both come from a deliberately strict "every earlier writer must be proven finished" barrier. Read
[TEARDOWN-AFTER-DEPLOY-DESIGN-2026-10-24.md](TEARDOWN-AFTER-DEPLOY-DESIGN-2026-10-24.md) (with its independent review
findings), then decide:

1. Is a refused teardown meant to freeze the environment for good?
2. Do you accept the revised settlement approach: proof by terminal state and database-clock expiry, credential
   rotation for static or customer-held identities, and a 1 to 2 hour wait after a deploy? Do you accept its residual
   risk that a slow cloud operation started earlier can finish after teardown verified absence?

Before 2026-10-26 no barrier code changed. Under these decisions, schema 60 (WP1) is the first code change; behaviour changes come in later work packages. PROD-LIFE-07, PROD-LIFE-11 and PROD-MIX-04 stay open until WP1 to WP7 are verified.

## Still open after setup

- Static secrets that remain by design: the GCP catalog key, the Anthropic key, the Supabase service-role key and DB
  URL, and the `za_` API token the live harnesses use (`scripts/acceptance/live/config.ts`). Everything else uses
  SSO sessions, OIDC/WIF federation or session tokens.
- MIX-01..07, MAN-01..07, OPS-01..09, REL-01..04 need live sandbox or operational rehearsal runs, which start with
  low-cost identity and connectivity smoke tests once the manifest is approved.
- Signoff (REL-03) stays with you after evidence exists.
- Optional: second Docker cleanup pass (~20 GB of leftovers from earlier runs).
