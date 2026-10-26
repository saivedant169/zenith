# Hosted control service — deployment runbook (G33)

Prepared 2026-09-07 by W11 against `ffb2753` on `zenith/hosted-r3`.

**Nothing in this runbook has been executed.** No hosted control service
exists. There is no host, no domain, no TLS certificate, no volume and no
backup. This document states the exact target topology so the gap is a
procurement and execution gap rather than a design gap, and so the register
row G33 has something specific to be measured against.

Every value the operator must supply is written `unknown`. Do not fill one in
by inference — a wrong host, region or domain here becomes a wrong claim in
[DATA-LIFECYCLE.md](DATA-LIFECYCLE.md) and in any customer conversation.

## 1. Target topology

One process. That is not a simplification, it is the constraint:

- `src/lib/db` keeps the whole legacy store in memory and rewrites it on save,
  and `src/lib/data-lock` writes a pid file into the data directory. A second
  writer against the same directory silently destroys the first one's work,
  and across container boundaries the pid file cannot even detect it. See
  `docs/LIMITATIONS.md`.
- The Revision 3 control authority (`R3-01`) is a single SQLite file opened
  once per process with WAL and `synchronous=FULL`. WAL permits many readers
  and one writer **within one host**; it is not a network database.

So: **`replicas: 1`, always.** Horizontal scaling is not a configuration
change, it is a different architecture. A rolling deploy that briefly runs two
containers against the same volume is a data-loss event; use a stop-then-start
deployment, accepting the downtime.

```
                    ┌──────────────────────────────────────┐
  browser ──TLS──▶  │ reverse proxy (unknown product)      │
                    │  · control.<domain>                  │
                    │  · *.<app-domain>   (wildcard cert)  │
                    └───────────────┬──────────────────────┘
                                    │ Host header unchanged, no caching
                    ┌───────────────▼──────────────────────┐
                    │ one container, image built from this │
                    │ repo's Dockerfile                    │
                    │  node server.js   PORT=3400          │
                    │  Node >= 22.16 (R3-01)               │
                    └───────────────┬──────────────────────┘
                                    │
                    ┌───────────────▼──────────────────────┐
                    │ persistent volume at ZENITH_DATA     │
                    │  control.sqlite  (+ -wal, -shm)      │
                    │  apps/<appId>/{app.sqlite,test.sqlite}│
                    │  artifacts/sha256/<digest>/          │
                    │  backups/            (staging only)  │
                    │  state.json, revisions/, logs        │
                    └──────────────────────────────────────┘
                                    │ encrypted copies
                    ┌───────────────▼──────────────────────┐
                    │ off-host backup target (unknown)     │
                    │  + revocation ledger (R3-11)         │
                    └──────────────────────────────────────┘
```

| Component | Decision | Status |
| --- | --- | --- |
| Host / provider | unknown | Not selected. Must not be a platform with an ephemeral filesystem — see §7. |
| Region | unknown | Must be recorded in [DATA-LIFECYCLE.md](DATA-LIFECYCLE.md) once chosen. |
| Runtime | Node >= 22.16, image from this repo's `Dockerfile` (`node:22-alpine` base, non-root `zenith` user, `PORT=3400`, `ZENITH_DATA=/data`, `VOLUME /data`) | Image builds in CI. It has never been launched as an authenticated hosted service. |
| Instances | exactly 1 | Enforced by the store's single-writer rule, not by configuration. |
| Volume | one persistent block/filesystem volume mounted at `/data` | Size unknown. Must survive container replacement, not just restart. |
| Reverse proxy | unknown product | Requirements in §3. |
| Control DNS | unknown | |
| App DNS | wildcard `*.<app-domain>` | Not registered. |
| Backup target | unknown | `filesystem` on a *different* volume is the minimum; `s3` to an off-host bucket is the intent (`R3-11`). |

The container image is **not pinned by digest** and `package.json` declares no
`engines.node`, so nothing currently fails a deploy onto Node 22.15 or below,
where `sqlite.backup` and `busy_timeout` are unavailable. Both are listed as
integrator edits in the W11 handoff; until they land, the Node floor is a
convention, not a gate.

## 2. Environment

`ZENITH_*` variables are parsed in `src/lib/hosted/config.ts`; `ZENITH_*` in
`src/lib/env.ts`. Defaults are the local single-host profile, which is **not**
a deployment profile.

### Required for a hosted deployment

| Variable | Value | Why |
| --- | --- | --- |
| `ZENITH_HOSTED_MODE` | `1` | Turns on hosted admission: no claim-driven re-grant, fail-closed auth, gateway on. Without it the app is the local product. |
| `ZENITH_CONTROL_ORIGIN` | `https://<control host>` (unknown) | Where browsers reach the control app; exchange redirects return here. |
| `ZENITH_APP_DOMAIN` | `<app-domain>` (unknown) | Apps are served at `<slug>.<app-domain>`. Must be a *different* registrable name from the control host, so an app host can never receive a platform cookie. |
| `ZENITH_APP_SCHEME` | `https` | The `__Host-` app cookie requires Secure. `http` is only defensible for `*.localhost`. |
| `ZENITH_DATA` | `/data` | The persistent volume. Set explicitly in the Dockerfile; do not let a host `.env.local` override it. |
| `ZENITH_SECRET_KEY` | 32 bytes (unknown) | Existing secret store. Losing it makes stored values unreadable; there is no re-wrap command. |
| `ZENITH_BACKUP_KEY` | 32 bytes, base64 or hex (unknown) | AES-256-GCM key for backups. **Must differ from `ZENITH_SECRET_KEY`** (`R3-11`) so a host compromise that reads one does not decrypt the other. Store it somewhere the host cannot read. |
| `ZENITH_BACKUP_TARGET` | `filesystem` or `s3` | `none` means no backups and no revocation ledger; a hosted deployment with `none` cannot satisfy G22 or G23. |
| `ZENITH_BACKUP_DIR` *or* `ZENITH_BACKUP_S3_BUCKET` (+ `ZENITH_BACKUP_S3_REGION`, or `ZENITH_BACKUP_S3_ENDPOINT`) | unknown | Target location. A directory on the same volume is not off-host. The S3 region is required for AWS (it falls back to `AWS_REGION`, then `AWS_DEFAULT_REGION`; refused when none is set and no endpoint is named). |
| `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | unknown | **Build arguments, not runtime variables.** Next inlines them at build time; passing them at run time leaves the browser in demo mode. Changing them is a rebuild. |
| `NEXT_PUBLIC_SITE_URL` | same as `ZENITH_CONTROL_ORIGIN` | Build argument. |
| `SUPABASE_SERVICE_ROLE_KEY` | unknown | Server-only. |

### Optional, capability-gating

Each of these turns a capability from *blocked* to *available*; absence is
reported with the missing variable named, never simulated. Full matrix in
[PROVIDERS.md](PROVIDERS.md).

`ZENITH_RUNTIME`, `ZENITH_BUILD_RUNNER`, `ZENITH_ARTIFACT_DIR`,
`ZENITH_CF_ACCOUNT_ID`, `ZENITH_CF_NAMESPACE`, `ZENITH_CF_API_TOKEN`,
`E2B_API_KEY`, `ZENITH_E2B_TEMPLATE`, `ZENITH_E2B_TEMPLATE_DIGEST`,
`ZENITH_E2B_TEMPLATE_ATTESTATION_PUBLIC_KEY`,
`ZENITH_POLICY_SHARED_SECRET`, `ZENITH_EVENTS_SALT`,
`ZENITH_SPEND_ENVELOPE_USD`, `ZENITH_FOUNDER_SUBJECTS`, `ZENITH_INVITE_FROM`,
`ZENITH_SMTP_URL`, `ZENITH_ALERT_FROM`.

For the E2B runner, `ZENITH_E2B_TEMPLATE` must be the provider-resolved bare
template ID (not a name, alias, or tag), and `ZENITH_E2B_TEMPLATE_DIGEST` must
match the `sha256:<64-hex>` value in the pre-baked image's
`/etc/zenith/template-attestation.json`. The attestation must also contain an
Ed25519 signature over `<templateId>\\n<digest>\\n`, verified with the trusted
`ZENITH_E2B_TEMPLATE_ATTESTATION_PUBLIC_KEY`. The runner verifies the provider
resolved ID and signature before any job source is uploaded.

`ZENITH_BUILD_RUNNER` defaults to `none`, which refuses every build and says
why. On a shared host, `recipe-local` runs the pinned recipe in a child
process **on the control host itself**; it is labelled *not a hostile-code
sandbox* and should not be chosen for a deployment that serves anyone but the
founder.

## 3. Reverse proxy requirements

The gateway resolves an app from the `Host` header
(`slugFromHost()` in `src/lib/hosted/config.ts`) and the middleware stamps
`x-zenith-gateway` on rewritten requests; a direct request without the stamp
is a 404. A proxy that rewrites or normalises `Host` breaks app resolution, and
one that lets a client set the stamp defeats the gateway.

| Requirement | Detail |
| --- | --- |
| TLS on the control host | Certificate for `<control host>`. |
| TLS on every app host | **Wildcard** certificate for `*.<app-domain>`, plus wildcard DNS. Per-app certificates would make publishing depend on certificate issuance. |
| `Host` passed unchanged | Both origins. Do not rewrite to an internal name. |
| `X-Forwarded-Proto` set | The app cookie is `Secure`; the app must know it is behind TLS. |
| Strip client-supplied gateway headers | The proxy must delete any inbound `x-zenith-gateway` header. It is the process's own stamp, not a client input. |
| No caching | Nothing on an app host may be cached by the proxy or a CDN: admission happens per request, and a cached private page served to a revoked user is exactly the failure G14 exists to prevent. The gateway sets `cache-control: private, no-store` on HTML and `private, max-age=300` on hashed assets; the proxy must not add a shared cache in front of it. |
| Body limit >= 1 MB | The application enforces a 1 MB body limit (`R3-12`). A proxy limit below that turns an application-level 413 with a message into an opaque proxy error. Publish uploads are larger — size them against the source-contract limit in `contracts/source-v1.ts`, `unknown` until the operator measures a real submission. |
| Request timeout | Longer than the 5-minute build timeout for publish endpoints, or publish appears to fail while the job continues. Exact value unknown. |
| WebSocket / SSE passthrough | Existing product streams (`/api/projects/:id/stream`, deploy logs) are SSE. |
| Client IP | Not currently used for admission. Do not add IP allowlisting expecting the app to see the real address. |

## 4. Fail-closed behaviour

The rule: **when the service cannot confirm that access is still permitted, it
denies.** Hosted mode has no degraded read-only mode and no cached "yes".

| Dependency unreachable | Behaviour | Where it is decided |
| --- | --- | --- |
| Supabase Auth | Grant-sensitive control endpoints (`launch`, `publish`, grant management, invite acceptance) verify identity with `auth.getUser()`, a live round trip. If it fails they answer `503` naming the identity service. They do **not** fall back to `getClaims()`, and they do not fall back to demo mode. | `R3-10`, `CONTRACTS-R3.md` |
| Supabase Auth, app hosts | An existing app session cookie is validated against the local authority, so an app host can keep serving an already-signed-in recipient during a brief Auth outage; a *new* sign-in cannot complete, because the exchange requires a verified control-side identity. This is a deliberate asymmetry and must be stated to customers rather than described as high availability. | `R3-09`, `R3-10` |
| Policy service (`ZENITH_POLICY_SHARED_SECRET`) | Unavailable → `503`, no admission. | `CONTRACTS-R3.md` |
| Control authority (SQLite) missing or corrupt | The process refuses to start rather than creating an empty database over existing data. An empty authority would read as "nobody has access", then as "the first caller becomes owner". | `R3-01`, `openAuthority()` |
| Backup target unreachable | Backups fail loudly and are recorded as failed. Revocations still commit locally; the revocation ledger append is retried. A revocation that cannot be written off-host must be surfaced, because restore reconciliation depends on it. | `R3-11` |
| Build runner unavailable | Publish fails with the missing variable named. No simulated success. | `R3-05` |
| Disk full | Unknown. SQLite write failures under a full volume have not been tested on this topology; `ATT-VERIFY-08` covers it and is `not started`. |

**Demo mode must be impossible in a hosted deployment.** Without Supabase keys
the existing app runs as one local admin user. `ZENITH_HOSTED_MODE=1` is what
forbids that; deploying with the flag unset and the keys missing would publish
an open service. Treat the flag as a release gate, not a preference.

## 5. Backups

| Item | Value |
| --- | --- |
| What is backed up | `control.sqlite` via `sqlite.backup` (WAL-safe, online, under concurrent writes); per-app databases under `apps/`; the artifact store is content-addressed and can be re-uploaded, but is not reproducible without the source. |
| Encryption | AES-256-GCM under `ZENITH_BACKUP_KEY`. |
| Schedule | unknown — **proposed** every 6 hours plus one before every release activation and every restore. Not implemented as a scheduled job; `scripts/hosted/backup.ts` is W8's. |
| Retention | unknown. Proposed 30 days, stated in [DATA-LIFECYCLE.md](DATA-LIFECYCLE.md) once agreed. |
| Off-host | Required. A directory on the same volume protects against nothing that matters. |
| Revocation ledger | Appended to the same target on every grant revocation, so a restore of an older snapshot can be reconciled (`R3-11`, G23). |
| Key custody | unknown. `ZENITH_BACKUP_KEY` must be recoverable independently of the host and of `ZENITH_SECRET_KEY`. Losing it makes every backup unreadable; there is no recovery path. |
| Verification | unknown. A backup that has never been restored is not a backup. |

## 6. Clean-host restore (outline)

`scripts/hosted/restore.ts` is being written by W8; this outline is the
procedure it must implement and the drill that must be recorded. **It has
never been run.** Treat every step as unvalidated.

1. **Authorise.** In-place restore over live data requires explicit operator
   approval (`ATT-OPS-09`, `blocked`). A clean-host restore into an empty data
   directory does not.
2. **Stop the service.** One writer per data directory; a restore into a live
   directory is a second writer.
3. **Recover the key.** `ZENITH_BACKUP_KEY` from its independent custody
   location. Verify it decrypts the chosen backup *before* touching the target
   host.
4. **Provision the host and volume.** Same image, same `ZENITH_DATA` mount.
5. **Restore.** Decrypt and place `control.sqlite` and the per-app databases;
   restore or re-upload the artifact store.
6. **Reconcile revocations.** Read the off-host revocation ledger for entries
   newer than the snapshot. Any grant the ledger shows revoked is revoked. Any
   grant the ledger cannot confirm is marked `needs_reapproval`, and the app
   stays closed to it until an owner re-approves (`R3-11`).
7. **Check before opening.** Row counts and content spot-checks per app,
   schema version compatibility with the active release, artifact digests
   recomputed over bytes, active-release pointer sane.
8. **Reopen deliberately.** Apps stay suspended until the checks above pass.
   Clearing sessions is not sufficient: a stale *grant* survives a cleared
   session.
9. **Record it.** One acceptance record per drill, using
   [evidence/acceptance-record-template.md](evidence/acceptance-record-template.md).

### Measured recovery targets

| Target | Proposed | Measured |
| --- | --- | --- |
| RPO | <= 24 hours | `unknown until drilled` |
| RTO | <= 4 hours | `unknown until drilled` |

Both numbers are the plan's proposals. Neither has been measured on any
topology, and a procedure does not establish either (`ATT-OPS-08`,
classification `experiment/target`). Do not quote them to a customer.

## 7. Vercel is not a valid host for this topology

A `.vercel/project.json` exists in this checkout (project `zenith`). It is a
local artefact of a previous preview deployment of the *marketing and product
UI*. It is **not** a hosted control deployment and must not become one.

Vercel's serverless and edge runtimes give each invocation an ephemeral
filesystem and no shared writable volume across invocations. The control
service needs the opposite of that:

- `control.sqlite` must be the same file, on the same disk, for every request
  — WAL and `synchronous=FULL` guarantee nothing across ephemeral instances.
- The single-writer rule requires exactly one process; a serverless platform
  scales instances by design.
- Publish jobs run on an unref'd ticker after the HTTP response, with leases
  and fence tokens; a function that freezes after responding cannot run them.
- Artifacts and per-app databases live on the volume.

The same objection applies to any platform whose filesystem is ephemeral or
whose instance count is not exactly one. If the founder wants a managed
platform, the requirement to check first is "one always-on instance with an
attached persistent volume", not "supports Next.js".

## 8. What this runbook does not do

It does not deploy anything, provision anything, register a domain, request a
certificate, create a bucket or spend money. Every one of those needs explicit
approval (`ATT-HANDOFF-02`, `blocked`). It also does not prove that the
topology works: G33 stays `Unverified` until a real host runs this service,
serves an app on its own hostname, survives a restart with data intact and
completes the drill in §6 with a recorded result.
