# Provider configuration — decision record and environment matrix (G34)

Prepared 2026-09-07 by W11 against `ffb2753` on `zenith/hosted-r3`.

G34 is a **Decision** row, not a Missing one: the code paths exist or are being
written, and what is absent is a set of accounts, terms acceptances, domains
and an approved budget. This file is the list of those decisions, one per
capability, with the exact variable that flips each from *blocked* to
*available*.

Rules this file obeys:

- **No capability is advertised because a variable could be set.** Absence is
  reported as blocked, naming the missing input. Nothing degrades into a
  simulation.
- **"Verified" means verified in this repository**, by a test or a run
  recorded in `docs/hosted/CHECKPOINT.md`. Nothing here has been verified
  live.
- **Every cost is `unverified`** unless a dated official source is cited from
  the gap analysis. A cited base price is a base price, not a bill.
- **No account was created, no terms accepted, no purchase made, no provider
  contacted.** That needs explicit approval (`ATT-HANDOFF-02`, `blocked`).

## 0. Approvals not yet given

| Approval | State | Blocks |
| --- | --- | --- |
| Cost envelope | The plan's $300 is an **unconfirmed planning envelope**, not permission to spend and not a cap — provider billing lags. | Every billable row below. |
| Billable provisioning | Not approved. | Cloudflare, E2B, host, domain, off-host storage, email. |
| Terms acceptance | Not given for any provider. E2B's terms in particular need clarification for customer-code execution and adversarial testing. | E2B; any provider whose terms restrict running third-party code. |
| Production DNS changes | Not approved. | Control and app domains. |
| Real external email | Not approved. | Invitation delivery. |
| Owner / accountable person per provider | `unknown` for all. | Incident response, [OPERATOR-ACCESS.md](OPERATOR-ACCESS.md). |

## 1. Runtime

Two implementations behind one `HostedRuntime` interface (`R3-03`).

| | `local` | `cloudflare` |
| --- | --- | --- |
| What it is | The control service serves immutable artifacts itself and runs the fixed broker against per-app SQLite files. Real, single host, labelled as such. | Workers for Platforms dispatch + D1 + a fixed broker worker, over the real API. |
| Variables | `ZENITH_RUNTIME=local` (default) | `ZENITH_RUNTIME=cloudflare`, `ZENITH_CF_ACCOUNT_ID`, `ZENITH_CF_NAMESPACE`, `ZENITH_CF_API_TOKEN` |
| Verified in this repo | Being built by W6 in this wave. Not yet landed at the time of writing. | An offline, GET-only binding/settings **inspection** harness with 84 synthetic tests (`scripts/hosted-spike/`). It makes no Cloudflare calls by default. |
| Unverified live | Two apps on distinct hosts under a real proxy; admission before invocation under load. | Everything. No account, no credentials, no namespace, no request has ever been made. |
| Approval | None. Runs on the host you already pay for. | Billable + account + token issuance. |
| Cost | Host cost only; see §5. | **Unverified.** The gap analysis records that Cloudflare's official Workers for Platforms pricing page listed a **$25/month base** when checked on 2026-09-07 (`https://developers.cloudflare.com/cloudflare-for-platforms/workers-for-platforms/reference/pricing/`). Usage, D1, storage and egress are **separate and unpriced here**. A base price is not a bill. |

### Cloudflare caveats carried forward from DECISIONS.md

None of these is closed by choosing Cloudflare; each is a gate to prove.

- **Binding isolation.** Editable releases need a strict allowlist. The fixed
  broker owns its one D1 binding; editable code gets no database, dispatch,
  service, mTLS or Durable Object binding. Read every deployed binding back.
- **Outbound policy.** Outbound Workers do not cover every binding path.
  Durable Object and mTLS paths need separate denial.
- **Private assets.** Assets must be admitted before dispatch, and
  namespace-wide asset deduplication needs tenant-aware artifact identity.
  Direct worker and preview URLs must be tested.
- **Release immutability.** Script upload can *replace* an existing name. A
  digest in a name is not create-only; ownership, fencing and readback are.
- **D1 transactions.** Zero affected rows do not throw. Version, idempotency
  and quota conditions must be enforced inside the transaction and tested
  against real D1.
- **Request quotas.** Native rate limiting is eventually consistent and is not
  an exact daily ledger.
- **Storage quota.** A strict 100 MB *physical* cap has not been demonstrated.
  Revision 3 discloses a **logical-byte** quota instead (`R3-12`); that is a
  different contract and must be stated as such to customers.

## 2. Build

Three runners, one interface (`R3-05`). Hosted mode refuses to build when none
is configured — it does not fall back.

| | `recipe-local` | `e2b` | `docker` |
| --- | --- | --- | --- |
| What it is | The platform's pinned recipe in a child process with a clean environment, timeout and memory cap — **on the control host**. | The pinned recipe inside a disposable E2B sandbox. | The pinned recipe inside a container on a local daemon. |
| Variables | `ZENITH_BUILD_RUNNER=recipe-local`; in hosted mode additionally `ZENITH_ALLOW_UNSANDBOXED_BUILDS_IN_HOSTED_MODE=1` or it refuses | `ZENITH_BUILD_RUNNER=e2b`, `E2B_API_KEY`, `ZENITH_E2B_TEMPLATE`, `ZENITH_E2B_TEMPLATE_DIGEST`, `ZENITH_E2B_TEMPLATE_ATTESTATION_PUBLIC_KEY`, `ZENITH_E2B_TEMPLATE_ATTESTATION_KEY_ID` | `ZENITH_BUILD_RUNNER=docker` + a reachable daemon + `ZENITH_RECIPE_IMAGE` (a digest; a tag is refused) |
| Isolation claim | **None beyond process boundaries, and no network policy at all** — the build child shares this host's network namespace and can reach the database, the instance-metadata endpoint and the internet. Labelled *not a hostile-code sandbox*. Defensible only because `R3-04` means no submitted code is executed: the recipe runs esbuild/rollup transforms over submitted *sources*, and submitted `vite.config.*`, scripts and lockfiles are rejected at intake. | Disposable VM per build, created with `allowInternetAccess: false`. | Container per build, started with `--network none`, `--read-only`, source mounted `:ro`, from a digest-pinned image. |
| Verified in this repo | The platform recipe and module-origin boundary are contract-tested; toolchain pinned in `package.json`: `vite@7.3.6`, `@vitejs/plugin-react@5.1.4`. The hosted-mode refusal and the acknowledgement variable are tested. | `e2b@2.46.1` is installed. The adapter requires a bare `ZENITH_E2B_TEMPLATE` ID, a matching `ZENITH_E2B_TEMPLATE_DIGEST`, a trusted Ed25519 public key and a key id; it checks the attestation (see below) before uploading job data, re-checks the provider-resolved ID, performs no job-time package install, checks pinned recipe versions, requests `allowInternetAccess: false` — now asserted on the options the factory actually receives — forwards the abort signal to every command, and always tears down within a bounded time. Contract-tested with an injected SDK double and real Ed25519 signatures. **No sandbox has ever been created.** | The argument vector is asserted verbatim. The image reference must be an image ID or a digest reference; a tag, `latest`, a short or uppercase digest is refused before the daemon is contacted, and no container is started from an unvalidated reference. The image's own toolchain is installed frozen (`npm ci` from `docker/recipe/package-lock.json`) and script-free (`--ignore-scripts`). |
| Unverified live | Memory/time caps under a hostile fixture; that a rejected input really never reaches a shell. | Everything provider-side: egress enforcement, controller access, teardown, artifact extraction before teardown, inter-job contamination, timeout behaviour. | **`docker build` has not been run from these changes.** Docker Desktop's Linux engine pipe is unavailable on this machine (`failed to connect to the docker API at npipe:////./pipe/dockerDesktopLinuxEngine`), so neither image has been built, no digest has been produced, and no container has been run. CI builds the app image; it builds no recipe image and runs no customer build. |
| Approval | None to run, but **do not select it for a deployment serving anyone but the founder.** | Billable + **terms clarification required** for customer-code execution and adversarial testing. Not an approved dependency. | None. |
| Cost | Host CPU only. | **Unverified.** The gap analysis is explicit: do not treat the plan's E2B price example as a current quote, and do not assume a paid plan is required. Recheck the selected plan against the actual workload before procurement. | None beyond the host. |

E2B's own documentation records that **default network access is open** and
that domain allowlisting has shared-hosting and protocol caveats; controller
and public-service access need explicit configuration. Those are configuration
gates to prove live, not properties inherited by adding the SDK.

### What the E2B template attestation is, and is not

Before any job data is uploaded, the runner reads
`/etc/zenith/template-attestation.json` from inside the sandbox and requires it
to name the configured template ID and digest, to carry the configured
`keyId`, to carry an ISO-8601 UTC `expiresAt` that has not passed, and to be
signed under `ZENITH_E2B_TEMPLATE_ATTESTATION_PUBLIC_KEY` over the canonical
payload

```
zenith-e2b-template-attestation-v2\n<templateId>\n<digest>\n<keyId>\n<expiresAt>\n
```

Then it asks the provider which template it actually resolved and requires the
same ID. A missing, unreadable or past expiry is a refusal, not a warning.

**This binds a provider-reported template ID to a signed digest string, and
nothing more.** Nothing computes that digest over the image's bytes or over its
package set — it is a value the image declares about itself. An image carrying
a byte-for-byte copy of a valid statement passes. So:

- Against **drift** — the wrong template, a rebuild that lost the statement, a
  retired signing key, a signature past its stated life — the check is real and
  it fails closed.
- Against a **malicious or compromised provider** the check is worth nothing,
  because every input to it comes from that provider.

Do not describe it as remote attestation or as image-digest pinning. Binding
the digest to something measurable is open work.

Operational note, unfixed: a sandbox whose `kill()` fails or times out is
logged with its id and nothing else. Nothing lists or re-kills a survivor, so a
leak bills until the provider's own timeout.

### Building and pinning the recipe image

```
docker build -t zenith-recipe:build -f docker/recipe/Dockerfile .
docker image inspect --format '{{.Id}}' zenith-recipe:build      # sha256:...
# or, for a pushed image:
docker image inspect --format '{{index .RepoDigests 0}}' <tag>   # name@sha256:...
```

Set `ZENITH_RECIPE_IMAGE` to whichever of those two the operator uses. There is
no default and no tag fallback: without it the `docker` runner reports itself
unavailable and names the variable. Neither command above has been run on this
machine — see the "Unverified live" row.

## 3. Artifacts and backup storage

| | `filesystem` | `s3` |
| --- | --- | --- |
| Variables | `ZENITH_BACKUP_TARGET=filesystem`, `ZENITH_BACKUP_DIR`, `ZENITH_BACKUP_KEY` | `ZENITH_BACKUP_TARGET=s3`, `ZENITH_BACKUP_S3_BUCKET`, `ZENITH_BACKUP_S3_REGION` (the bucket's region; falls back to `AWS_REGION`, then `AWS_DEFAULT_REGION`), `ZENITH_BACKUP_S3_ENDPOINT` (LocalStack or another S3-compatible endpoint; the region is optional with it), `ZENITH_BACKUP_KEY`, plus AWS-style credentials |
| What it gives | A WAL-safe encrypted copy on a path you choose. Off-host **only if the path is off-host** — a directory on the same volume is not a backup. | Real off-host object storage. Against LocalStack it is real S3 semantics on this machine; against a cloud endpoint it is a real off-host copy. |
| Verified in this repo | Being built by W8. | LocalStack S3 is already **real** for the existing product (`s3:CreateBucket` verified with `HeadBucket`, listed back by drift detection). That establishes the adapter, not off-host durability. |
| Unverified live | A restore from it. | A real cloud bucket, its region, its retention policy, its access controls, and a restore from it. |
| Approval | None. | Billable + account + region decision (feeds [DATA-LIFECYCLE.md](DATA-LIFECYCLE.md)). |
| Cost | None. | **Unverified.** No provider, plan, storage class or region selected. |

`ZENITH_ARTIFACT_DIR` (default `<ZENITH_DATA>/artifacts`) holds the
content-addressed store. It is on the same volume by default; a host loss
loses it unless it is in the backup set.

`ZENITH_BACKUP_KEY` must be **distinct from `ZENITH_SECRET_KEY`** and
recoverable independently of the host. Custody is `unknown`. There is no
key-rotation tooling and no re-wrap command for the existing secret store; the
same limitation applies to backups until W8 proves otherwise.

## 4. Email (invitation delivery)

| Item | State |
| --- | --- |
| Variables | `ZENITH_SMTP_URL` (carries the password; never echoed), `ZENITH_ALERT_FROM`, `ZENITH_INVITE_FROM`, and the `nodemailer` package installed. |
| Provider | `unknown`. Not selected. |
| Verified in this repo | The existing alert path sends real SMTP when configured, and reports the missing variable or `npm install` as the delivery failure rather than dropping silently. Hosted invitations use a **separate** transactional outbox (`R3-11`, W5), not the alert outbox. |
| Unverified live | That an invitation reaches an external mailbox. |
| Semantics | Provider acceptance is recorded as **sent**. *Delivered* requires stronger evidence and is a different state; bounces are retained. Do not report sent as delivered. |
| Delivery-payload subtlety | A hash-only token record cannot recreate the secret a retried email needs, so a bounded **encrypted delivery payload** with its own retention and key scope is required (`R3-11`). |
| Approval | Sending real external email needs explicit approval. |
| Cost | **Unverified.** No provider, plan or volume estimate. |

## 4b. Alert webhook egress and channel secrets

Two operator-facing policies live in `src/lib/alerts/`. Neither is a provider
choice, but both change what a deployment can reach and what it must run once
before alerting works, so they are recorded here rather than in a changelog.

### Webhook egress policy

An alert channel is an operator-supplied URL that this server POSTs to. Left
unconstrained that is a server-side request forgery primitive, so the
destination is checked twice: the URL itself (scheme, embedded credentials,
fragment, port) and **every address the hostname currently resolves to** —
the connection then uses that validated address, so a second resolution cannot
land somewhere else.

| Item | Production / hosted | Local development |
| --- | --- | --- |
| Scheme | `https://` only | `http://` allowed |
| Destination | Public addresses only | Loopback, RFC1918 and link-local allowed |
| Ports | 443 and 8443, plus `ZENITH_ALERT_WEBHOOK_ALLOWED_PORTS` | any |
| Metadata services and IPv6 transition ranges | refused | **still refused** |

**Never reachable, under any policy:** `169.254.169.254`, `100.100.100.200`,
`fd00:ec2::254`, and the IPv6 transition ranges that wrap an arbitrary IPv4
destination — NAT64 `64:ff9b::/96` and `64:ff9b:1::/48`, 6to4 `2002::/16` and
its relay anycast prefix `192.88.99.0/24`, IPv4-compatible `::a.b.c.d`, and
Teredo `2001::/32`. On an IPv6-only host behind DNS64 these are how a webhook
reaches the instance metadata service, and nothing legitimate points at them.

**`ZENITH_ALERT_WEBHOOK_ALLOW_INSECURE=1`** is an acknowledgement, not a
switch. It is honoured only when the process is plainly a development one —
`ZENITH_HOSTED_MODE` unset, `ZENITH_STORE=file`, and not serverless
(`ZENITH_SERVERLESS`/`VERCEL` unset). Set it on a hosted, PostgreSQL-backed or
serverless deployment and it does nothing; the refusal an operator sees then
says so in as many words, so the variable is never silently ineffective.

**`ZENITH_ALERT_WEBHOOK_ALLOWED_PORTS`** is a comma-separated list added to the
443/8443 default, e.g. `9443,10443`. A malformed entry is ignored rather than
fatal — a typo must not take every channel in the install offline — and the
refusal names the list actually in force, so the mistake is visible the first
time it matters.

**Upgrade impact.** A channel created before this policy whose target is
`http://` or on a private address becomes undeliverable. That is deliberate,
and the failure is actionable rather than mysterious: the delivery record, the
Test button and every retry all carry one sentence naming the scheme/port/
address class and pointing at Settings → Alerts. No resolved address, resolver
detail or internal IP appears in any of them. Before upgrading, list the
workspace's channels and re-point anything that is not a public `https://`
endpoint; there is no in-place migration for a destination only the operator
can choose.

### Alert channel secrets

A channel's signing key and its credential-bearing target URL are sealed by
`src/lib/secrets` (AES-256-GCM under `ZENITH_SECRET_KEY`, with
`"<workspaceId> <ref>"` as additional authenticated data) and the channel row
keeps only a reference plus a non-secret display origin.

Moving an existing install to that shape is an **explicit operator action**,
never a boot step:

```
npm run migrate:alert-secrets              # rehearsal; writes nothing, exits 2
npm run migrate:alert-secrets -- --apply   # the move, one channel at a time
```

| Exit | Meaning |
| --- | --- |
| 0 | nothing to do, or the apply succeeded |
| 1 | one or more channels are **blocked** (see below); nothing was written |
| 2 | a rehearsal was printed and nothing was written |
| 3 | the apply failed; the failing channel was rolled back and is named in the journal |

Both modes print a per-channel report: the channel id, its name, its kind, and
what it is still holding in the clear.

**`ZENITH_STORE=postgres` is held, and says so per channel.** The secret row
and the channel row live in two authorities with no shared transaction (see
ADR D-4), so an in-place migration could commit one and lose the other. The
script therefore refuses on that store with exit 1 and the line
`blocked: Postgres legacy row requires the coordinated migration (see runbook)`
against every held channel, and delivery for those channels stays refused with
a message naming the channel. The two ways forward:

1. **Per channel, now, from the UI.** Re-enter the channel's target (and
   signing secret) under Settings → Alerts. That write goes through the
   encrypted path, so the row stops being legacy and delivery resumes for it.
   This is the supported remedy for a small number of channels.
2. **All at once, under a maintenance window.** The coordinated migration — a
   single SQL/RPC that writes the sealed rows and the channel metadata together
   — is not in this build. Until it is, option 1 is the only complete path.

**Old plaintext copies, and what to do about them (required step).** A
successful migration removes the plaintext from the *current* state, and from
nothing else. Every copy taken before it still holds the credentials in the
clear:

- `<ZENITH_DATA>/state.json` in any filesystem snapshot or file-level backup;
- the `settings` jsonb of every PostgreSQL dump and PITR window;
- any export or support bundle produced before the run.

Because those copies cannot be edited, the credentials must be **rotated at the
receiver**, not merely re-encrypted here: revoke and re-issue the Slack
incoming-webhook URL, re-issue any generic webhook token, and generate a new
HMAC signing key (updating the receiver at the same time — the old signature
stops verifying the moment the key changes). Until that is done, treat every
pre-migration backup as holding live credentials.

**Retention.** Pre-migration backups are not deleted to remove the plaintext;
they are kept for their normal retention period and the rotation above is what
makes their contents worthless. Record the rotation date against the retention
window in [DATA-LIFECYCLE.md](DATA-LIFECYCLE.md); a backup older than the
rotation can then be reasoned about as holding only dead credentials.

**An interrupted apply is resumable.** Each channel is journaled in
`settings.pendingAlertSecretMigrations` before it is touched and cleared after
it commits, and both writers use a reference derived from the channel id. A
crash between the secret write and the settings write therefore leaves an
orphaned secret row that nothing can name and nothing can open — and re-running
the command overwrites it rather than adding a second one. Re-run the apply;
do not hand-edit the store.

## 5. Domains, TLS and host

| Item | Decision | State |
| --- | --- | --- |
| Control origin | `ZENITH_CONTROL_ORIGIN` | `unknown`. Default `http://localhost:3400` is local only. |
| App domain | `ZENITH_APP_DOMAIN`, apps at `<slug>.<app-domain>` | `unknown`. Default `apps.localhost` resolves in browsers without DNS — a development convenience, not a deployment. |
| Separation | The app domain must be a **different registrable domain** from the control origin, so an app host can never receive a platform cookie. | Decided (`R3-09`); domains not registered. |
| DNS | Wildcard `*.<app-domain>` | Not registered. Registrar `unknown`. |
| TLS | Certificate for the control host and a **wildcard** for `*.<app-domain>` | Not issued. Issuer `unknown`. `ZENITH_APP_SCHEME=https` is required for the `__Host-` cookie. |
| Control host | One always-on instance with a persistent volume | `unknown`. See [RUNBOOK-DEPLOY.md](RUNBOOK-DEPLOY.md) §1 and §7 — a platform with an ephemeral filesystem, Vercel included, cannot host this. |
| Region | Feeds the data map | `unknown`. |
| Approval | Billable + DNS changes. | Not given. |
| Cost | **Unverified.** Host, domain and certificate costs unpriced. |

## 6. Identity

| Item | State |
| --- | --- |
| Provider | Supabase Auth — already in use by the existing product, so this is a continuation, not a new selection. |
| Variables | `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` (**build arguments**, inlined at build time), `SUPABASE_SERVICE_ROLE_KEY` (server-only). |
| Region | `ap-south-1` (Mumbai) for the existing project, per the project's own operating notes. **Not re-verified from the Supabase dashboard in this session.** Recorded in [DATA-LIFECYCLE.md](DATA-LIFECYCLE.md) with that caveat. |
| Verified in this repo | Sign-in, confirmation, reset, OAuth wiring behind `NEXT_PUBLIC_SUPABASE_OAUTH_PROVIDERS`, workspace membership. The OAuth handshake itself has never been exercised against a real provider in this repo. |
| Unverified live | The one that matters for hosted: that a token issued **before** sign-out is rejected afterwards, on the deployed Auth version. `R3-10` selects `auth.getUser()` for grant-sensitive endpoints; the integration test is W5/W10's and has not run. |
| Fail-closed | With `ZENITH_HOSTED_MODE=1`, missing or partial auth configuration must refuse, never fall back to the local demo admin. |
| Approval | Existing project; no new spend identified. Plan and quota fit for a pilot: `unknown`. |
| Cost | **Unverified.** |

## 7. Summary — what one decision unblocks

| Decision to make | Unblocks | Register rows |
| --- | --- | --- |
| An always-on host with a persistent volume, and its region | The entire hosted journey, backups, RPO/RTO measurement | G33, G22, G27, G36 |
| Two registrable domains + wildcard DNS + TLS | App hosts, cross-domain exchange, recipient journey | G12, G14, G30 |
| Off-host backup target + key custody | Backup, clean-host restore, revocation reconciliation | G22, G23 |
| A build runner that is not the control host | Honest isolation for anything beyond a founder demo | G06, G25 |
| Cloudflare account + token + namespace | The edge runtime and all seven caveats in §1 | G02, G14–G16 |
| Email provider + approval to send | Real invitation delivery, sent-vs-delivered evidence | G11, G38 |
| An approved cost envelope with a named owner | Every billable row above | G20, G40 |

Until each of those is made and recorded here with a date and an accountable
name, G34 stays a **Decision** row and every capability it gates stays
blocked-with-reason.
