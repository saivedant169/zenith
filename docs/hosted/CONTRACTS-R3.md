# Hosted contracts — Revision 3 (READ FIRST, every hosted workstream)

Typed truth lives in `src/lib/hosted/contracts/` (pure: no `node:` imports,
no store, no env) and `src/lib/hosted/config.ts` (every `ZENITH_*` variable).
This page is the map and the HTTP surface. Rules from `docs/CONTRACTS.md`
still apply: errors name their fix, honest labels, no dead controls, plan
before apply.

## Files

| File | Holds |
| --- | --- |
| `contracts/errors.ts` | `HostedError`, `HostedErrorCode` → status table, `hostedErrorBody()` |
| `contracts/types.ts` | authority records: `HostedApp`, `AppGrant`, `AppInvite`, `InviteDelivery`, `AppSession`, `AppExchange`, `HostedJob`, `HostedOutboxEntry`, `Artifact`, `Release`, `HostedLimits`/`DEFAULT_LIMITS`, `QuotaCounter`, `UsageEntry`, `RevocationLedgerEntry`, `BackupManifest`, `HostedEvent` (+ `HOSTED_EVENTS`) |
| `contracts/tracker-v1.ts` | equipment-request schema, limits, request/response bodies, conflict payload, `canonicalWriteIntent()` |
| `contracts/source-v1.ts` | supported source: manifest, allowed paths/extensions/deps, limits, `RECIPE_V1`, `ValidatedSource` |
| `contracts/interfaces.ts` | `BuildRunner`, `ArtifactStore`, `AppDataStore`, `HostedRuntime`, `BackupTarget`, `SessionAuthority` |
| `config.ts` | `hostedConfig()`, `hostedMode()`, `controlDatabasePath()`, `appDataDir()`, `appHostname()`, `appOrigin()`, `slugFromHost()` |

## Environment (all optional; defaults are the local single-host profile)

`ZENITH_HOSTED_MODE`, `ZENITH_CONTROL_ORIGIN`, `ZENITH_APP_DOMAIN`,
`ZENITH_APP_SCHEME`, `ZENITH_RUNTIME`, `ZENITH_BUILD_RUNNER`,
`ZENITH_ARTIFACT_DIR`, `ZENITH_BACKUP_TARGET`, `ZENITH_BACKUP_DIR`,
`ZENITH_BACKUP_S3_BUCKET`, `ZENITH_BACKUP_S3_REGION`, `ZENITH_BACKUP_S3_ENDPOINT`, `ZENITH_CF_ACCOUNT_ID`,
`ZENITH_CF_NAMESPACE`, `ZENITH_CF_PROBE_URL`, `ZENITH_CF_BROKER_MODULE`,
`ZENITH_SPEND_ENVELOPE_USD`, `ZENITH_FOUNDER_SUBJECTS`, `ZENITH_TEST_SUBJECTS`,
`ZENITH_INVITE_FROM`. Presence-only secrets: `ZENITH_CF_API_TOKEN`,
`E2B_API_KEY`, `ZENITH_BACKUP_KEY` (32 bytes, base64/hex, distinct from
`ZENITH_SECRET_KEY`), `ZENITH_POLICY_SHARED_SECRET`, `ZENITH_EVENTS_SALT`.

## Authority (W1: `src/lib/hosted/authority/`)

One SQLite file `<ZENITH_DATA>/control.sqlite` opened once per process via
`node:sqlite` `DatabaseSync`; `PRAGMA journal_mode=WAL; synchronous=FULL;
foreign_keys=ON; busy_timeout=5000`. Versioned migrations table. Exports:

```ts
openAuthority(): Authority                 // idempotent per process; refuses a corrupt file (never starts empty over data)
authority().tx(fn)                          // BEGIN IMMEDIATE … COMMIT; fn runs synchronously; throws roll back
authority().repos.apps / grants / invites / deliveries / sessions / exchanges /
           jobs / outbox / artifacts / releases / quotas / usage / revocations / backups / events
closeAuthority()                            // tests
backupAuthority(destPath)                   // sqlite.backup, WAL-safe
```

Commit-before-ACK rule: a route returns only after `tx()` returned. Anything
that must happen outside the transaction (email, provider call) is an outbox
row written inside it.

## Control HTTP surface (control origin, signed-in, `route()` wrapper)

Prefix `/api/hosted`. Every handler: `ensureBoot()`, resolve workspace, then
hosted checks. Bodies JSON; errors `{ error: { code, message, fix?, details? } }`.

| Route | Who | Body → result |
| --- | --- | --- |
| `GET /api/hosted/apps` | workspace member | `{ apps: HostedApp[], limits, enforcement, runtime: { id, label, availability } }` |
| `POST /api/hosted/apps` | workspace editor+ | `{ name, slug }` → 201 `{ app }`; creator becomes `owner` grant |
| `GET /api/hosted/apps/:appId` | grant or workspace member | `{ app, activeRelease, releases: Release[], grants (owner only), invites (owner only), health, usage }` |
| `POST /api/hosted/apps/:appId/publish` | app owner **and** workspace editor+ | multipart or JSON `{ jobId (uuid), source: { kind: "tarball", base64 } \| { kind: "fixture", name } }` → 202 `{ job }`; 409 `idempotency_conflict` |
| `GET /api/hosted/apps/:appId/jobs/:jobId` | owner | `{ job, logs }` |
| `POST /api/hosted/apps/:appId/rollback` | owner + workspace editor+ | `{ jobId, releaseId }` → 202 `{ job }` |
| `POST /api/hosted/apps/:appId/suspend` / `resume` | owner + workspace admin | `{ jobId, reason? }` → 202 |
| `GET/POST /api/hosted/apps/:appId/grants` | owner | POST `{ subject?, email, role }` (direct grant only for existing platform users; otherwise use invites) |
| `PATCH/DELETE /api/hosted/apps/:appId/grants/:grantId` | owner | role change / revoke (`{ reason? }`); last owner protected (409) |
| `GET/POST /api/hosted/apps/:appId/invites` | owner | POST `{ email, role }` → 201 `{ invite, delivery }`; resend: `POST …/invites/:id/resend` |
| `DELETE /api/hosted/apps/:appId/invites/:id` | owner | revoke pending |
| `POST /api/hosted/invites/accept` | signed-in (verified email must equal invite email) | `{ token }` → `{ app, grant, launchUrl }` |
| `POST /api/hosted/apps/:appId/launch` | active grant | `{ state }` → `{ redirect }` (app host callback URL with single-use code); identity re-verified via `SessionAuthority` |
| `GET /api/hosted/apps/:appId/export` | owner | export bundle (JSON) |
| `GET /api/hosted/apps/:appId/health` | owner | real probes with release attribution; `simulated: false` |
| `GET /api/hosted/apps/:appId/usage` | owner | ledger + quota counters + limits/enforcement |
| `GET /api/hosted/ops/spending` | workspace admin | envelope, spent, thresholds, build pause state |
| `POST /api/hosted/session/terminate` | signed-in | terminates the caller's app sessions (called by sign-out before responding) |

## App host surface (gateway, W6: `src/app/hosted-gateway/[host]/[[...path]]/route.ts`)

Middleware rewrites any request whose Host matches `*.${ZENITH_APP_DOMAIN}` to
`/hosted-gateway/<host>/<path>`; the Host header travels with the rewrite. The
handler requires the Host header to equal the route's `host` segment
(case-insensitive) *and* to resolve to an app, so a direct control-origin
request to `/hosted-gateway/...` (Host `localhost:3400`) is `unknown_host`
404 without any stamp. Admission order:
host → app (404) → state (423) → quota (429) → reserved routes → session
cookie (401 → sign-in page on the app host, which links to the control
launch) → live grant (403) → then, and only then, artifact or broker.

| Path | Behaviour |
| --- | --- |
| `/_zenith/auth/callback?code&state` | redeem exchange atomically → set `__Host-zenith_app` → 303 `/` |
| `/_zenith/auth/signin` | HTML: "Open this app from Zenith" with the control launch link; no credentials here |
| `/_zenith/auth/signout` (POST) | terminate session, clear cookie |
| `/_zenith/session` | `SessionInfo` |
| `/_zenith/data/v1/*` | broker (contract in `tracker-v1.ts`); mutations require exact `Origin`; viewer → 403 |
| everything else | artifact file of the **active** release; `index.html` for SPA routes; HEAD and Range honoured after admission; `cache-control: private, no-store` for HTML, `private, max-age=300` for hashed assets |

Response guard: the gateway sets CSP (`default-src 'self'; connect-src 'self';
script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:;
frame-ancestors 'none'; base-uri 'none'; form-action 'self'`),
`x-content-type-options: nosniff`, `referrer-policy: no-referrer`; strips
any `set-cookie`, `location` or `access-control-*` an artifact might carry.
Platform cookies (`sb-*`, `zenith-*`) are never read on app hosts.

## Jobs (W7: `src/lib/hosted/release/`)

Ticker like the engine (250 ms, unref'd). Phases for `publish`:
`intake → build → artifact → verify_artifact → stage → probe → activate →
cleanup`. Each phase writes `phaseData` before its side effect and checks
`fenceToken` after. Single-flight: one running job per app (`UNIQUE` partial
index); pilot-wide build slots from `DEFAULT_LIMITS`. Restart: reclaim expired
leases, resume from the recorded phase, reconcile provider state by
content-addressed names before creating anything.

## Tests

Every test sets `process.env.ZENITH_DATA` to a fresh `mkdtempSync` directory
**before** any `await import`, opens the authority itself and closes it in
`afterAll`. Never touch `.data`. Two apps, three identities (owner, editor,
viewer) and one stranger are the standard fixture; helpers may live in
`tests/hosted/_fixtures.ts` (integrator-owned, append-only).
