# Deploying the platform control plane

How the pieces of the platform control plane fit together, what each one needs
in its environment, and how to run them. This is for whoever operates a Zenith
install; the design is in [ARCHITECTURE.md](../ARCHITECTURE.md) and the ADRs.

Written against branch `prod/compose`, based on merged Wave 5 source at `443bfeaf537dd5d5324d33c84fc544ede0baa632` (2026-10-08).
Wave 5 assembly edits are in the working tree and not verified on native services; historical receipts retain their original scope. The last section collects the remaining verification.

## Status: what actually runs on this branch

The control plane is being built in several workstreams. Read this table before
the rest of the page, because a component that is "deployed" is not necessarily
doing work yet.

| Component | State on this branch |
|---|---|
| Platform control store (Postgres `platform` schema, PGlite locally) | Opened by the broker/routes, migration script and worker (`workers/execution/startup.ts`). The worker requires explicit configuration and checks schema before polling. `src/lib/platform/app.ts` composes the shared runtime only for an explicitly configured store. Real Postgres tests are gated by `ZENITH_TEST_PLATFORM_PG_URL`; not run in this sync. |
| Credential broker and OIDC issuer | Built with contract tests using mocks. The Next app serves the two public routes (`/api/oidc/jwks`, `/api/oidc/.well-known/openid-configuration`), and the control signing key signs capability grants. No live AWS STS or KMS verification is recorded. |
| OpenTofu engine (`src/lib/tofu`) | Worker composition supplies `planWorkspace` and `applyVerifiedPlan` in `src/lib/platform/execution.ts`. State backend selection is provider-specific (section 2.14). No live-cloud backend/apply was verified in this sync. |
| Policy engine (`policy/`, `src/lib/policy`) | Broker and worker execution broker load the committed bundle. `src/lib/platform/broker.ts` supplies plan facts/cost to worker policy evaluation. `next.config.ts` traces the bundle and the worker Dockerfile copies it (section 2.7); neither deployment was built here. |
| Capability broker and REST `/api/platform/v1` (`src/lib/capabilities`, `src/app/api/platform/v1`) | Merged and tested. Routes: `capabilities/check` and `propose`; `operations` (list, get, events, approve, reject, cancel); `environments/[id]/autonomy`; `workspace/policy`. Approve, reject and the two admin settings are **browser-only**: any `Authorization` header is refused, the identity is verified live and the `Origin` must match (section 2.8). Integrations call with a `za_` bearer. **Over REST** an `infrastructure.apply` or `infrastructure.destroy` capability proposal is always denied `plan_required`, because the reviewed plan can only come from the execution side. The browser approval route can deliver approval through the deploy/destroy bridge and start an approved destroy workflow. Integration bearer calls and runner/`zenithd` calls pass the session middleware only on their classified paths (section 2.8). |
| Runner and `zenithd` control-plane side (`src/lib/runners`, routes under `runners/*` and `machines/*`) | Signed authentication, replay protection, queues and sealed results are wired. AWS runner sessions use `src/lib/runners/aws-runner-transport.ts`; machine execution uses `src/lib/execution/capability.ts`. Cron passes call `platformRunnerReaperPass` in `src/lib/platform/app.ts`. `oci.http` is wired in dispatch and the Go executor; no live transport acceptance is claimed. |
| Resource model, placement and cost, observability | Worker composition supplies cost and observability ports. Placement is exposed by REST, actions, MCP and `/platform/placement` (COST.md). Legacy cost screens keep the older pricing table. App composition registers the MCP cloud-read hook through `src/lib/platform/agent-ports.ts`; OCI signals use the registered runner (OCI-SIGNALS.md). |
| Incident engine, repository analysis and platform UI | App composition registers the MCP investigator with tenant-scoped read ports (`src/lib/platform/agent-ports.ts`). Repository analysis remains a library. Platform pages render stored resources, drift/incidents, operations, policy, AWS setup, placement and teardown. Stored incidents do not prove fresh investigation. |
| Temporal workflows, client and execution worker | `workers/execution/worker.ts` opens the store and calls `createActivities`, which delegates to `composeExecutionActivities` in `src/lib/platform/execution.ts`. Product deploy bridge and MCP v3 start workflows. `createStubActivities` is an explicit test factory, never a production fallback. Startup requirements are section 6.2; this wiring has not been live-cloud verified. |
| Reconciliation controller (`src/lib/reconcile`, migration 2, `POST /api/internal/tick/reconcile`) | `ensurePlatformApp` registers `wireReconcilePorts`; the route boots composition after cron authentication. `.github/workflows/tick.yml` includes reconcile every five minutes. The controller observes and proposes repairs; allowed proposals dispatch day-two workflows through `src/lib/platform/reconcile.ts`. Unsupported execution can still fail. See section 2.9. |
| `zenith-runner` and `zenithd` (Go, `go/`, Helm chart, Dockerfiles) | Built by another workstream, with their own operator guides: [RUNNER.md](../RUNNER.md) and [ZENITHD.md](../ZENITHD.md). The control-plane side is the row above, with the gaps listed there. I did not run or verify the agents. |
| Machine plane (`src/lib/machines`) | Default composition supplies the `machines` port: workspace-scoped observations select AWS SSM fixed documents, Azure managed Run Command or read-only GCP Compute/OS Inventory; a uniquely bound, active registered machine selects the signed `zenithd` queue. Cloud calls use the operation's credential-broker session and existing policy/approval gates; `machine.exec` remains an admin-approved escape hatch. GCP guest mutations require `zenithd`. Kubernetes guest execution still requires an injected credential resolver. No live transport was verified. See [AWS-SETUP.md](AWS-SETUP.md) for customer permissions. |
| Provider drivers | `src/lib/platform/drivers.ts` calls all six provider registrars; evidence remains contract-only. `src/lib/platform/credentials.ts` verifies GCP, Azure and Kubernetes connections; OCI verification checks runner registration only, and OCI sessions require that runner. Runner modes for other non-AWS providers remain refused. A hosted managed substrate is not verified ([MANAGED-PLATFORM.md](../MANAGED-PLATFORM.md)). |
| Environment teardown | Browser admin action `env.teardown` consumes trusted recorded destroy evidence, proposes for approval and starts the destroy workflow after browser approval. The first destroy-review trigger and matching readable approval artifact remain entry-point gaps; see [TEARDOWN.md](TEARDOWN.md). |
| Builds from source | Default source preparation uploads canonical ZIP to customer S3 for AWS CodeBuild, or tar.gz to GCS for GCP Cloud Build. Azure ACR adapters require injected source wiring; default composition refuses. See [BUILDS.md](BUILDS.md). |
| Connections and approvals | `/platform/connections/aws` saves/verifies via its browser action adapter. `/api/platform/v1/connections` lists scoped connections and creates GCP/Azure/OCI connections through the browser-only lifecycle adapter. AWS and Kubernetes retain their dedicated creation flows. `/platform/operations/[id]` renders review; plan-bound approval stays disabled without a readable matching PlanView artifact. See `src/app/(product)/platform/README.md`. |

Machine dispatch stores an immutable, tenant-scoped evidence marker before contacting
the transport. Repeated completed requests replay a sealed result; a competing,
interrupted or unreadable request is uncertain and is never dispatched again. An
operation id cannot be reused with changed arguments, target, simulation mode or
budgets. Local grant, constraint and argument checks still run on every retry.
Outputs are bounded and redacted; evidence summaries exclude file contents, log
lines and DNS answers. Escape-hatch output is retained as a sealed artifact in the
existing idempotency store, referenced by `blobRef`, rather than placed in summaries
or workflow history. Replay results and artifacts use a separate HKDF domain of
`ZENITH_SECRET_KEY`; rotating that key makes older artifacts unreadable. The cache
may be pruned after 30 days; the dispatch marker remains and prevents re-execution.
An operator must reconcile an uncertain operation and submit a newly authorized
operation to try again. Sandbox transports remain explicitly simulated.

The execution path is composed, but no live-cloud success is recorded. Configure
the worker and a verified connection before dispatching; a started workflow is
not proof of a changed or healthy environment. Poll recorded status and events,
and preserve `unknown`, `unavailable` and `uncertain` outcomes.

## 1. Topology

```
 browser / REST / MCP / CLI
            |
            v
 +----------------------------+          +---------------------------+
 | web / API control plane    |  start / |  Temporal                 |
 | Next.js (Vercel or a Node  |  signal  |  Cloud or self-hosted;    |
 | host)                      |--------->|  `temporal server         |
 |  - /api/oidc/*             |  query   |  start-dev` locally       |
 |  - broker, /api/platform/v1 |          +-------------+-------------+
 |  - Temporal client         |                        | polls
 +-------------+--------------+                        v
               |                          +---------------------------+
               |  SQL (pooler)            | execution worker          |
               v                          | long-running container    |
 +----------------------------+           |  - workflows (sandbox)    |
 | platform Postgres          |<----------|  - composed activities   |
 | schema `platform`          |   SQL     |  - tofu binary            |
 +----------------------------+           +------+-------------+------+
                                                 |             |
                              brokered provider session        | provider state
                                                 v             v
                                        customer cloud / cluster
```

| Component | Runs on | State it holds | Talks to |
|---|---|---|---|
| Web / API control plane | Vercel or any Node host | Reads the product store; reads and writes the platform store | platform Postgres; Temporal start, signal and query via the deploy bridge and MCP adapters |
| Execution worker | A long-running container built from `docker/worker.Dockerfile` | Private local binary plans in `ZENITH_WORKER_PLAN_DIR`; ledger state is in Postgres | Temporal, platform/product stores, cloud APIs, provider downloads and customer state storage |
| Temporal | Temporal Cloud, self-hosted, or `temporal server start-dev` locally | Payloads encrypted by the client/worker codec; ids, visibility and default failure text are outside that encryption | The web app and the worker |
| Platform Postgres | Supabase (Supavisor transaction pooler) or any Postgres 16 | Schema `platform`: operations, leases, approvals, decisions, resources, connections | Web and worker |
| `zenith-runner`, `zenithd` (optional) | Customer VPC / VMs | Identity, replay cache, local saved plans/audit; see [RUNNER.md](../RUNNER.md) and [ZENITHD.md](../ZENITHD.md) | Outbound to the control plane and locally authorized cloud APIs |

### What must never run on Vercel

**The execution worker.** It is a process that polls Temporal continuously and
runs `tofu plan` and `tofu apply` for tens of minutes as child processes (the
workflow allows an apply up to 60 minutes, see [EXECUTION-WORKER.md](../EXECUTION-WORKER.md#retries-timeouts-heartbeats)).
A request-scoped serverless function can do neither. The worker is built as a
container for that reason.

Also keep off a serverless host:

- **PGlite as the platform store.** With no platform database URL set, the store
  defaults to PGlite on the local filesystem (`<ZENITH_DATA>/platform-pg`); on a
  serverless instance that is neither durable nor shared between instances. On
  Vercel set `ZENITH_PLATFORM_DB_URL` (or `SUPABASE_DB_URL`) explicitly.
- **The `tofu` binary and provider downloads.** Planning and applying belong to
  the worker, never to a route.

What may run on Vercel: the web app, the OIDC routes, and the Temporal *client*
(start / signal / query), which needs the Node runtime (not edge) and is already
listed in `serverExternalPackages` in `next.config.ts`.

## 2. Environment variables

### 2.1 How they are read

Configuration is read at the entry points below. Composition also reads the
secret key and plan directory. Validation reports variable names and fixed
guidance rather than secret values; it does not verify live provider readiness:

| Concern | The one reader | Also validated at boot by `env()`? |
|---|---|---|
| Platform store | `platformDbConfigFromEnv` in `src/lib/controlplane/db/open.ts` | Yes: `ZENITH_PLATFORM_DB*` are in the schema in `src/lib/env.ts` |
| Workload identity and signing keys | `loadCredentialsConfig` in `src/lib/credentials/config.ts` | Declared in `env.ts` but left loose there; the loader validates |
| Temporal connection | `temporalConfigFromEnv` in `src/lib/workflows/config.ts` | No |
| Execution worker | `executionWorkerConfigFromEnv` in `workers/execution/config.ts` | No |
| Execution composition and startup | `derivePlanFingerprintKey` in `src/lib/platform/execution.ts`, `workers/execution/startup.ts` and `workers/execution/worker.ts` | Startup validates its required inputs before polling |
| OpenTofu binary and plugin cache | `resolveTofuBinary` (`src/lib/tofu/binary.ts`) and `TofuRunner` (`src/lib/tofu/runner.ts`) | No |
| Policy bundle path | `DEFAULT_POLICY_WASM` and `ZENITH_POLICY_WASM` in `src/lib/policy/engine.ts` | No |
| Broker store selection | `defaultStore` and `isMemoryStoreEnabled` in `src/lib/capabilities/platform.ts` | No |
| Browser origin for approvals | `src/app/api/platform/v1/_lib/browser.ts` | No |
| Runner result sealing key | `createResultSealerFromEnv` in `src/lib/runners/seal.ts` | No |
| Product vault previous keys | `vaultCipherFromEnv` in `src/lib/secrets/index.ts` | No; validated when a vault value is read or the re-wrap command starts |
| Zenith-managed provider substrate | `readSubstrateConfig` in `src/lib/providers/zenith/substrate.ts` | No |

A variable that `env()` validates makes the **product** refuse to start when it
is malformed, even on an install that never uses the platform. Conversely, the
Temporal, worker, tofu and policy variables are checked only when their module
is used.

A variable is consumed when the named path runs. The tables describe readers,
not evidence that a production process has run with that configuration.

### 2.2 Platform store

| Variable | Default | Secret | Consumed on this branch | Meaning |
|---|---|---|---|---|
| `ZENITH_PLATFORM_DB` | `postgres` when a URL is set, otherwise `pglite` | no | app composition, broker/runner routes, worker, migrations, tests | `pglite` or `postgres`. Naming `postgres` without a URL is an error that says which variable to set. |
| `ZENITH_PLATFORM_DB_URL` | falls back to `SUPABASE_DB_URL` | **yes** (carries the password) | app composition, broker/runner routes, worker, migrations, tests | `postgres://` or `postgresql://` URI. For Supavisor use its transaction-pooler URI (port 6543); prepared statements are disabled and the store uses no session state or advisory locks. Pooler/TLS operation is not verified here. |
| `ZENITH_PLATFORM_DB_MAX` | `5` | no | same | Connection pool size, integer 1 to 100. Postgres only. |
| `ZENITH_DATA` | `<cwd>/.data` | no | same | PGlite files live in `<ZENITH_DATA>/platform-pg`. One process per directory: PGlite has no cross-process locking. |
| `SUPABASE_DB_URL` | unset | **yes** | the product store, and as the fallback above | Supabase's own name for the same connection string. |

In a production build (`NODE_ENV=production`) the broker **refuses** to use a store that
was not configured explicitly (no `ZENITH_PLATFORM_DB`, no URL): it answers
`platform_store_unavailable` instead of defaulting to a PGlite directory on the host's
disk. Local development still defaults to PGlite.

The code sets no `ssl` option on the connection. If your database requires TLS,
put it in the URL (for example `?sslmode=require`); the driver reads it from
there. This was not exercised against a TLS-only server here.

### 2.3 Workload identity and control-plane signing

Full reference, including what each key is for and how to rotate it:
[`src/lib/credentials/OPERATIONS.md`](../../../src/lib/credentials/OPERATIONS.md).
Summary:

| Variable | Secret | Needed where | Meaning |
|---|---|---|---|
| `ZENITH_OIDC_ISSUER` | no | every process that **mints** tokens (the worker) and, unless the request origin is right, the web app | Issuer URL, for example `https://app.example.com/api/oidc`. https only (http for localhost). Customers pin this URL in their IAM OIDC provider, so **changing it means every connected account must redeploy its bootstrap stack**. |
| `ZENITH_OIDC_SIGNING_JWK` | **yes** | see below | RS256 private JWK, JSON or base64 of JSON. |
| `ZENITH_OIDC_KMS_KEY_ID` | no | see below | AWS KMS key id, ARN or alias (RSA_2048 or larger, `SIGN_VERIFY`). Use this in production: the private key never leaves KMS. |
| `ZENITH_OIDC_EXTRA_PUBLIC_JWKS` | no | wherever the JWKS is served | Extra **public** keys to publish during rotation. A private key here is refused. |
| `ZENITH_CONTROL_SIGNING_JWK` | **yes** | the signer of grants and jobs (web / broker) | Ed25519 private JWK. Signs capability grants, runner jobs and machine requests. |
| `ZENITH_CONTROL_KMS_KEY_ID` | no | same | KMS alternative for the control key. **Not verified against real KMS** (Ed25519 via `ED25519_SHA_512`). |
| `ZENITH_CONTROL_EXTRA_PUBLIC_JWKS` | no | every **verifier** (the worker, runners) | Extra public Ed25519 keys accepted when verifying grants. A verifier needs the signer's public key: either the signer configuration or this. |
| `AWS_REGION` / `AWS_DEFAULT_REGION` | no | KMS signers | Region hint for the default KMS client when the key id is not an ARN. |

Rules the loader enforces: setting both the JWK and the KMS variable for the same
key family is an error; the OIDC key must be RS256 and the control key Ed25519,
so one cannot be loaded as the other; a private member in an `EXTRA_PUBLIC`
value is rejected outright.

Two placement consequences that follow from the code, not from a preference:

1. **The JWKS route needs a signer.** `GET /api/oidc/jwks` publishes the signing
   key's public half, derived from the configured signer. With no signer
   configured it answers `503 oidc_not_configured`. There is no public-key-only
   configuration for the OIDC key. So the process that serves the route (the web
   app) needs `ZENITH_OIDC_SIGNING_JWK` (a private key on the web host) **or**
   `ZENITH_OIDC_KMS_KEY_ID` with permission to call `kms:GetPublicKey` (no private
   key on the web host; this is the reason to prefer KMS).
2. **Token minting happens in the worker.** The credential broker runs inside
   activities, so the worker also needs the OIDC signer and `ZENITH_OIDC_ISSUER`
   (the minter has no request to derive the origin from).

The AWS SDK's default credential chain supplies the credentials for KMS calls
(`KMSClient` is built with only a region), and for `aws_assume_role` connections
the broker calls STS with Zenith's own default chain. Neither path has been run
against a real account.

### 2.4 Temporal

Read by `temporalConfigFromEnv`, for **both** the web app's client and the worker.

| Variable | Default | Secret | Meaning |
|---|---|---|---|
| `ZENITH_TEMPORAL_ADDRESS` | `localhost:7233` | no | Frontend `host:port`. |
| `ZENITH_TEMPORAL_NAMESPACE` | `default` | no | Namespace. Must already exist. |
| `ZENITH_TEMPORAL_API_KEY` | unset | **yes** | Temporal Cloud API key. Setting it forces TLS. Never logged; `describeTemporalConfig` reports only "set" or "unset". |
| `ZENITH_TEMPORAL_TLS` | `false` | no | `true` or `1` forces TLS without an API key. Without custom settings, the SDK's default TLS settings apply. API keys and any custom TLS setting force TLS even when this flag is `false` or `0`. |
| `ZENITH_TEMPORAL_TLS_CA_FILE` | unset | path only; contents kept private | Path to a PEM server CA bundle, passed as `serverRootCACertificate`. Optional for certificates trusted by the SDK defaults. |
| `ZENITH_TEMPORAL_TLS_CERT_FILE` | unset | path only; contents kept private | Path to a PEM client certificate chain for mTLS. Requires `ZENITH_TEMPORAL_TLS_KEY_FILE`. |
| `ZENITH_TEMPORAL_TLS_KEY_FILE` | unset | **private-key contents** | Path to the PEM client private key for mTLS. Requires `ZENITH_TEMPORAL_TLS_CERT_FILE`; keep the file readable only by the process account. |
| `ZENITH_TEMPORAL_TLS_SERVER_NAME` | unset | no; presence only in logs | Optional DNS hostname for TLS server identity/SNI (`serverNameOverride`), without a scheme, port or path. Defaults to the address host when unset; certificate verification remains enabled. |

Both `Connection.connect` (web client and availability probe) and
`NativeConnection.connect` (worker) receive these settings through
`connectionOptionsFor`. Cert and key must be configured together; a custom CA
can be used without a client identity, and mTLS can use the SDK's default trust
without a custom CA. API-key authentication may also be configured with these
TLS settings.

Files are read on the first configuration load (worker startup or the web
client's first use), must be readable regular files with nonblank contents, and
are bounded to **1 MiB per file**, including a bounded read if the file grows.
Successful reads are cached by absolute path for the process lifetime; neither
connection creation nor a status probe re-reads a cached file. **Restart the web
process and every worker after certificate/key rotation**. Mount files at
runtime on each host; the web process needs access to its own TLS files too.
The SDK checks PEM format, key/certificate compatibility and server trust when
connecting; successful file loading does not prove a working TLS handshake.

`describeTemporalConfig` reports only **set/unset** for API keys, CA, certificate,
key and server-name overrides. It never reports file paths or PEM. File-loading
errors identify only the variable, and custom TLS transport errors exposed by
the web client/probe use fixed guidance to avoid leaking SDK error contents.
Local file tests and mocked SDK wiring cover this configuration; **live mTLS
authentication is unverified**.
`tests/workflows/mtls-live.test.ts` is opt-in via
`ZENITH_TEST_TEMPORAL_MTLS=1`; it requires explicit address, namespace and client
cert/key file variables, then checks both SDK transports against that endpoint.
Leave the gate unset for offline runs. The target server must require client
certificates to establish that the handshake enforced mTLS authentication.

Payload encryption uses the shared `ZENITH_SECRET_KEY` and decrypt-only
`ZENITH_TEMPORAL_PREVIOUS_SECRET_KEYS`, documented in the worker table below.
Both the web client and worker configure the codec in `src/lib/workflows/codec.ts`;
production client creation refuses a missing key. See section 5.3 for rotation.

### 2.5 Execution worker

Read by `executionWorkerConfigFromEnv`. Details and defaults:
[EXECUTION-WORKER.md](../EXECUTION-WORKER.md#configuration).

| Variable | Default | Meaning |
|---|---|---|
| `ZENITH_WORKER_TASK_QUEUE` | `zenith-execution` | Task queue to poll. **Leave it alone.** The control plane's client starts workflows on the constant `zenith-execution`; there is no environment variable on the client side, so a worker polling another queue would never receive anything. |
| `ZENITH_WORKER_MAX_CONCURRENT_ACTIVITIES` | `8` | Parallel activities **per replica** (1 to 1000). Each `tofu` plan or apply spawns provider processes; lower this before you let the kernel kill one mid-apply. |
| `ZENITH_WORKER_MAX_CONCURRENT_WORKFLOW_TASKS` | `40` | Parallel workflow tasks (1 to 1000). |
| `ZENITH_WORKER_SHUTDOWN_GRACE_MS` | `600000` | How long running activities may finish after SIGTERM before they are cancelled. Set the container's stop timeout **above** this. |
| `ZENITH_WORKER_HEARTBEAT_THROTTLE_MS` | `10000` | Longest gap between heartbeats reaching Temporal; bounds how long a cancel takes to reach a running activity (100 to 60000). |
| `ZENITH_WORKER_WORKFLOW_BUNDLE` | unset | Path to a prebuilt workflow bundle. The image sets it to `/app/dist/execution/workflow-bundle.js`; unset, the worker bundles the TypeScript at start-up (development). |
| `ZENITH_WORKER_LOG_LEVEL` | `INFO` | `TRACE`, `DEBUG`, `INFO`, `WARN`, `ERROR`. |
| `ZENITH_WORKER_HEALTH_LOG_INTERVAL_MS` | `60000` | Period of the `health` log line; `0` disables. The HTTP endpoints are on `ZENITH_WORKER_HEALTH_PORT`. |
| `ZENITH_WORKER_IDENTITY` | `zenith-exec-<host>-<pid>` (sanitised, at most 64 characters) | Worker identity shown in Temporal and used in every lease holder: 1-64 letters, digits, `.`, `_` or `-`; any other explicit value is refused at startup. |
| `ZENITH_WORKER_HEALTH_PORT` | `9464` | Loopback port for `/healthz` (process up) and `/readyz` (Temporal, platform store, policy bundle, drivers). |
| `ZENITH_WORKER_PLAN_MAX_AGE_HOURS` | `24` | Legacy inspection threshold only; maintenance never deletes plan files. |
| `ZENITH_WORKER_PLAN_RETENTION_PREVIEW` | unset (disabled) | Optional bounded JSON configuration for counts-only artifact retention preview; exactly `workspaceId`, `createdBefore`, `limit` and `holdOperationIds`. Invalid configuration refuses worker startup. |
| `ZENITH_PLAN_ARTIFACT_KEY` | unset | **Secret**, required for workers: a dedicated 64-hex key disjoint from every product-vault key; share across cooperating workers and back up separately from PostgreSQL. |
| `ZENITH_PLAN_ARTIFACT_PREVIOUS_KEYS` | unset | **Secret**, optional: private JSON array of previous 32-byte artifact keys (hex/base64), decrypt-only. Retain while originals may need authentication. |
| `ZENITH_TOFU_IDENTITY_FILE` | packaged path | Checksum-verified packaged OpenTofu identity; version, platform and binary hash must match before polling. |
| `ZENITH_WORKER_PLAN_DIR` | `<ZENITH_DATA or .data>/platform-plans` | Worker-local binary plan directory, resolved to an absolute path and created with mode `0700`. Keep it private; binary plans may contain secrets. Cross-replica filesystem access and Windows ACL equivalence are not verified. |
| `ZENITH_SECRET_KEY` | unset | **Secret**, required: 64 hex characters. `derivePlanFingerprintKey` uses HKDF-SHA256 with `zenith.tofu.plan.fingerprint.v1`; there is no public default. The key also protects product vault secrets and encrypts Temporal workflow payloads (AES-256-GCM, HKDF info `zenith.temporal.payload.v1`); give the web app and cooperating workers the same key and back it up separately. |
| `ZENITH_TEMPORAL_PREVIOUS_SECRET_KEYS` | unset | **Secret**, optional: a JSON array of earlier 64-hex `ZENITH_SECRET_KEY` values. Payloads carry a key id; after rotating `ZENITH_SECRET_KEY`, list the old keys here (on the web app and every worker) so workflow histories written under them still decode. A malformed value is refused at startup. |
| `ZENITH_VAULT_PREVIOUS_SECRET_KEYS` | unset | **Secret**, optional: a private JSON array of previous product-vault keys, each 32 bytes encoded as hex or base64. Vault reads try the current key and then these decrypt-only keys; writes use only `ZENITH_SECRET_KEY`. Invalid JSON or keys fail closed on vault reads and command startup, without echoing values. This is separate from Temporal history keys. The operator command uses `ZENITH_STORE` (`file` by default; `postgres` for `public.secrets` via `SUPABASE_DB_URL`), requires an explicit workspace, and never uses `ZENITH_PLATFORM_DB_URL` to select the product database. See [vault key re-wrap](RECOVERY.md#product-vault-key-re-wrap). |

Leave `ZENITH_WORKER_PLAN_RETENTION_PREVIEW` unset to disable the optional preview.
An explicitly present value must be a JSON object of at most 131,072 UTF-8 bytes
with exactly these four required keys:

- `workspaceId`: the owning workspace identifier, 1 to 128 ASCII letters,
  digits, underscores or hyphens.
- `createdBefore`: an explicit real calendar timestamp already normalized to
  millisecond UTC form `YYYY-MM-DDTHH:mm:ss.SSSZ`, with a nonzero year. Dates
  without time, offsets, missing milliseconds and dates that normalize to a
  different value are refused. There is no default cutoff or retention duration.
- `limit`: a JSON integer from 1 to 1000, bounding the number of artifacts
  counted in the owning workspace's oldest-first window.
- `holdOperationIds`: an array of at most 1000 unique operation identifiers,
  each using the same 1 to 128 character rules as `workspaceId`. Supply an empty
  array when no operations are listed; omitting the key is invalid.

Empty, malformed, oversized or otherwise invalid configuration fails closed
before codec setup, health listener, store opening or polling. Startup diagnostics
do not echo the configured values. The preview uses the worker's existing guarded
control-store handle and runs after normal logical artifact expiry in the existing
single-flight maintenance pass. It reports `mode: "dry-run"`, `scanned`, `hasMore`
and the `held`, `active`, `unresolved`, `unavailable`, `withinRetention` and
`archiveReview` counts. Plan or state contents, row identities, storage references
and keys are absent from the preview output.

These counts are a current read-only snapshot, not authority for later cleanup.
`archiveReview` indicates possible future copy review; the preview does not
archive, delete, prune or unlink anything. Listed holds are preview classification
only, not accepted durable holds. They do not extend approvals or artifact expiry,
waive normal logical expiry or alter legacy inspection. Existing receipts,
tombstones and replay prevention remain unchanged. No destructive retention
policy is enabled or approved; such a policy requires separate operator approval.

#### 2.5.1 Wave 2 variables and behaviour changes (5 October 2026, verification pending)

| Variable | Default | Meaning |
|---|---|---|
| `ZENITH_BUILD_ALLOW_OPEN_EGRESS` | unset | `1` records an explicit exception that lets a source build run with unrestricted network egress. Unset, release admission refuses any build whose provider reports `egress: unrestricted`: on AWS re-apply the build pipeline (the guarded buildspec), on GCP set `spec.isolation.workerPool` to a private pool, on Azure a dedicated agent pool. The exception is signed into the build provenance statement as `open_egress`; removing the variable revokes it for later admissions. Worker only. |
| `ZENITH_RELEASE_MIN_PROVENANCE` | `pinned_digest` | Weakest provenance a release may carry: `pinned_digest`, `build_record` or `attested`. The default accepts an image the manifest pins by `@sha256:` digest and refuses a tag-only reference or an unknown digest. Images Zenith builds from source are always held to `attested` (admitted signed build provenance) regardless of this value. Setting `attested` also demands it for pinned images, which have no attestation source, so only raise it when every image is built by Zenith. Applies to the worker and to the release API. |
| `ZENITH_PLUGIN_TRUSTED_PUBLISHERS` | unset | JSON `{ "<publisher>": [{ "keyId": "...", "publicKey": "<base64 raw ed25519>" }] }`. Plugin registrations whose signed provenance does not verify under a listed key are not auto-trusted; unset, no publisher is trusted. Web app only. |
| `ZENITH_STORE` (worker) | `file` | Set `postgres` on the execution worker (with the Supabase keys) when it should run the engine, alert and outbox passes of `zenith-critical-maintenance-v1`. Without it those jobs record `failing` in `/api/internal/tick/status`. |
| `ZENITH_PORTABILITY_ALLOW_PRIVATE_HOSTS` | unset | Test and local development only: lets portability export/import connect to loopback or private addresses. Never set in production. |

Behaviour changes to plan for:

- Open build egress is refused (see `ZENITH_BUILD_ALLOW_OPEN_EGRESS`). AWS build projects created before wave 2 carry the old buildspec and are refused until the pipeline is re-applied.
- Tag-only images are refused: every managed workload needs an `@sha256:` pinned image or a Zenith build. Previously a mutable tag was merely waited on.
- Built images are released only when the signed provenance admitted in `deployWorkloads` verifies (signature under the pinned control-plane key, bound operation, service, digest, reviewed source, isolation profile). That single admission feeds the release gate as the `attested` verdict; nothing verifies it a second time.
- A build from a monorepo subdirectory requires the `contextDir` and `contextDigest` that `GET /api/platform/v1/github/inspect` returned; the digest is re-derived from the approved commit through the bound GitHub App at build time. Azure ACR Tasks cannot build from a subdirectory.
- Approving a data or contract migration is a separate browser approval (`/platform/releases/:id`); the operation fails before any effect when it is missing, and the person approves and deploys again.
- `.github/workflows/tick.yml` now also calls `POST /api/internal/tick/status` (durable-schedule health, always 200 unless `?strict=1`).
- Migrations 21 to 27 add `scheduled_job_runs`, `connection_rotations`, `release_pipelines`, `portability`, `agent_lifecycle`, `plugin_boundaries` and `github_revocation_reason`; apply the current `0023_platform_core.sql` or run `npm run migrate:platform`.
- **Wave 3 (7 October 2026), implementation complete, verification pending.** Migrations 30 to 36 add `durable_intent_authority` (30: `operation_authority`, `durable_intents`), `executable_semantics` (31: `approved_semantics`, `standing_grants`, `standing_grant_uses`), `plan_custody_state_recovery` (32), `external_effects` (33), `k8s_guest_bindings` (34), `mcp_streams` (35) and `coding_agent_runs` (36). The aggregate is now `supabase/migrations/0022_platform_core.sql` (migrations 1 to 36); `0016` to `0021` are immutable and unchanged. Operator-visible changes, each needing a deliberate step:
  - **Telemetry endpoints (optional).** `ZENITH_OBSERVE_PROMETHEUS_URL` and `ZENITH_OBSERVE_LOKI_URL` (http or https base URL, no credentials, no query; cloud metadata hosts refused) give every default observation caller a Prometheus and a Loki source; `ZENITH_OBSERVE_PROMETHEUS_TOKEN` and `ZENITH_OBSERVE_LOKI_TOKEN` are optional bearer tokens (secret, read at call time, redacted in the boot error); `ZENITH_OBSERVE_LOKI_TENANT` is the optional `X-Scope-OrgID`. They are platform wide (one backend for every workspace; tenant isolation is the existing label scoping). A malformed value makes an explicit `unavailable` source naming the variable, never a silent drop.
  - **Coding agents need a model key.** `ANTHROPIC_API_KEY` is optional: workers and the web process boot and serve every other workflow without it. Starting a coding-agent run is refused with `model_not_configured` when the web process has no key, and a worker without the key stops a run with the same reason. Set it on both processes to use `/platform/coding-agent`. The default model id is `claude-opus-5-5` (see `docs/RUNNING.md`).
  - **New Kubernetes connections default to `scoped_guest`.** `connection.createKubernetes` now creates a connection whose vault credential is a namespaced minter, never a guest credential; Zenith creates a per-binding ServiceAccount, Role and RoleBinding and issues short-lived TokenRequest tokens per machine dispatch. A legacy `kubeconfig_ref` connection still serves deploy and observe, but its guest (machine) sessions are now REFUSED (`guest_credential_refused`). To use a legacy connection for guest sessions, convert it with `connection.rotate` and `{ convertToScopedGuest: true, credentialRef: <new minter ref> }` (admin, browser, audited). A `scoped_guest` connection serves machine sessions only: the Kubernetes deploy and observe provider paths refuse it, so an environment that both deploys to and opens machine sessions on one cluster needs a legacy connection for the former and a `scoped_guest` connection for the latter. Creating a legacy connection requires an explicit `scopedGuest: false`.
  - **State backends.** The OpenTofu backend compile now refuses a backend that cannot lock state or does not encrypt it; configurations that relied on such a backend fail at compile time with a named reason. Restore of a previous state version is available for AWS S3 and GCS only, through brokered sessions, with a human approval of the exact digest (`/api/platform/v1/environments/:id/state-backend/restores`); Azure Blob, OCI Object Storage, http, local and pg backends are refused explicitly.
  - **Plan custody.** Every plan-artifact operation by a worker is admitted against the worker identity (`^[A-Za-z0-9._-]{1,64}$`, already enforced by worker config) and the live lease before any read or dispatch; a refusal is `plan_custody_refused`. No new variable: the existing `ZENITH_PLAN_ARTIFACT_KEY` is reused. Custody does not re-wrap artifacts per worker with a KMS key.
  - **Semantics binding.** Planning records the canonical executable-semantics digest write-once; final plan, apply, destroy, build, rollout and migration dispatch recompute it and refuse on any difference. A plan reviewed before this build has no recorded semantics and is refused at dispatch with a request to plan again. Standing grants (`/platform/standing-grants`, browser admin only) bound a person's pre-approval and never cover destroy.
  - **External effects.** Provider calls whose outcome can be unknown (build launches on every provider, destroy apply, mutating runner HTTP proxy requests) are recorded before the call in `platform.external_effects`. An operation with an unresolved effect shows as outcome uncertain; an admin resolves it in the browser from independent readback evidence (`/api/platform/v1/effects`). A retry never repeats the provider call.
  - **Portability.** MySQL by DNS hostname over TLS is served in-process (mysql2) with verified chain and hostname; `ZENITH_MYSQL_CA_FILE` names the CA bundle (system roots when unset) and `ZENITH_PORTABILITY_ALLOW_PRIVATE_HOSTS=1` is still required for a database on a private address. The in-process dump strips `DEFINER` clauses and is not byte-identical to `mysqldump`. mysql2 is a runtime dependency (already in `package.json`).
  - **MCP streaming.** The agent MCP endpoint streams progress with resumable event ids backed by `platform.mcp_streams`; resume needs the instance that holds the call to stay alive for up to 55 seconds. Zenith still hosts no authorization server.
  - **Repair.** The reconcile workflow now returns `not_evaluated` on the code path that changed its pass result; histories started before this build must replay-check clean (see VERIFY-QUEUE).
- **Wave 4 (7 October 2026), implementation complete, verification pending; live cloud acceptance deferred by decision.** Migrations 37 to 41 add `actual_spend` (37: `actual_spend_snapshots`), `fair_bounded_control_plane` (38: `ops_maintenance`, `ops_maintenance_history`, `tenant_quotas`), `key_custody` (39: `key_custody_keys`, `key_rewrap_jobs`), `mixed_parent_plans` (40: `mixed_parent_plans`, `mixed_child_plans`, `mixed_child_receipts`, `mixed_addresses`) and `mixed_runs` (41: `mixed_runs`, `mixed_run_events`, `mixed_output_preauthorizations`). The aggregate is now `supabase/migrations/0023_platform_core.sql` (migrations 1 to 41); `0016` to `0022` are immutable and unchanged. Apply the current `0023_platform_core.sql` or run `npm run migrate:platform`. Operator-visible changes, each needing a deliberate step:
  - **Per-tenant fairness and maintenance mode (OPS-02).** Every API route now runs admission (per-workspace token bucket and concurrency limits, a process in-flight cap); dispatch checks a per-workspace dispatch bucket and an active-operation quota BEFORE the operation is claimed, so a refused start changes nothing and answers 429 or 503 with `Retry-After`. Operators can pause dispatch or make the plane read-only (`/api/admin/ops/*` for the user ids in `ZENITH_OPS_ADMIN_IDS`, or the host override `ZENITH_MAINTENANCE_MODE=dispatch_paused|read_only` with `ZENITH_MAINTENANCE_REASON`). Every knob has a default (defaults are generous; a client that hammers one workspace harder than 50 requests per second sees 429): `ZENITH_OPS_EDGE_RATE_PER_SEC`, `ZENITH_OPS_EDGE_BURST`, `ZENITH_OPS_EDGE_MAX_KEYS`, `ZENITH_OPS_TRUSTED_IP_HEADER`, `ZENITH_OPS_API_RATE_PER_SEC`, `ZENITH_OPS_API_BURST`, `ZENITH_OPS_API_MAX_CONCURRENT_PER_TENANT`, `ZENITH_OPS_API_MAX_IN_FLIGHT`, `ZENITH_OPS_API_MAX_TENANTS`, `ZENITH_OPS_DISPATCH_RATE_PER_SEC`, `ZENITH_OPS_DISPATCH_BURST`, `ZENITH_OPS_MAX_ACTIVE_OPERATIONS`, `ZENITH_OPS_RUNNER_QUEUE_MAX_PER_TENANT`, `ZENITH_OPS_RUNNER_QUEUE_MAX_GLOBAL`, `ZENITH_OPS_RETRY_AFTER_SEC`, `ZENITH_OPS_MAINTENANCE_CACHE_MS`. The full table and the rehearsal script are in [CONTROL-PLANE-FAIRNESS.md](CONTROL-PLANE-FAIRNESS.md). Worker fairness is a bounded delay at the worker (`ZENITH_WORKER_FAIR_CAPACITY`, `ZENITH_WORKER_FAIR_MAX_WAIT_MS`) plus the dispatch quota; it does not reorder tasks already queued in the Temporal server. Metrics, traces and the OTLP export are dependency free: set `ZENITH_OTEL_EXPORTER_OTLP_ENDPOINT` (https, or http to loopback) with optional `ZENITH_OTEL_EXPORTER_OTLP_TOKEN_FILE`, `ZENITH_OTEL_EXPORT_INTERVAL_MS`, `ZENITH_OTEL_SERVICE_NAME` and `ZENITH_OTEL_TRACE_SAMPLE_RATIO`. A database that has not applied migration 38 treats maintenance as off.
  - **Rolling upgrades and the expand-only schema gate (OPS-03).** Optional Temporal Worker Deployment routing is off by default: `ZENITH_WORKER_VERSIONING=auto_upgrade|pinned` with `ZENITH_WORKER_DEPLOYMENT_NAME` and `ZENITH_WORKER_BUILD_ID` (the worker image digest or release tag, no `.`). `migratePlatformDb` on Postgres, or any run with `ZENITH_ENFORCE_EXPAND_ONLY=1`, now REFUSES a pending migration that is not expand-only (a NOT NULL column without a default, enabling row level security on an existing table, an unrecognised statement); a contract step needs `ZENITH_ALLOW_CONTRACT_MIGRATIONS=<version>` stating the exact SQL was reviewed, and static checks use `ZENITH_COMPAT_BASELINE_VERSION` (the highest version of the previous release) or the registry's highest. A fresh database is exempt. Runner and machine protocol windows now advertise `supportedProtocols`/`currentProtocol` (a 426 keeps its status and code). The Kubernetes manifests under `deploy/k8s/` carry placeholder zero digests; the runbook substitutes real image digests and the migration Job image (see [ROLLING-UPGRADES.md](ROLLING-UPGRADES.md)). The workflow-history replay lane is opt-in (`npm run replay:record`, then `npm run replay:check`) and is not part of the mandatory CI lanes until the verifier records and commits the not-yet-recorded tests/fixtures/workflow-histories directory.
  - **Key custody and sensitive persistence (OPS-05, OPS-06).** Keys are resolved through a purpose registry ([KEY-CUSTODY.md](KEY-CUSTODY.md)); `scripts/key-custody.ts diagnose` prints key ids, purposes and ages, never material. New variables: `ZENITH_RUNNER_RESULT_PREVIOUS_KEYS` (JSON array of 32-byte base64url keys, decrypt-only history of `ZENITH_RUNNER_RESULT_KEY`; with an explicit result key the legacy signing-key derivation stays decrypt-only) and `ZENITH_TEMPORAL_PAYLOAD_KEY` (64 hex, a dedicated root for Temporal payload encryption; client and worker must agree; move the old root into `ZENITH_TEMPORAL_PREVIOUS_SECRET_KEYS` before switching). Plan custody now takes its keys through the same registry (`ZENITH_PLAN_ARTIFACT_KEY` and `ZENITH_PLAN_ARTIFACT_PREVIOUS_KEYS` are unchanged and still must differ from the vault key). Worker start-up now refuses shared key material between purposes, or a release private key on the control plane. Two new durable-only critical jobs (`key-rewrap`, `data-minimize`) run on the Temporal scheduler; there is no cron fallback, the operator CLIs run them under the same lease. **DEC-RETENTION is approved (2026-10-13), but `data-minimize` is still a dry run by default.** It reports candidate counts and deletes nothing unless `ZENITH_DATA_MINIMIZE_APPLY=1` is set and the retention policy in force carries an approval (the built-in default does); the window is `ZENITH_RESULT_RETENTION_HOURS` (1 to 720) when set, else the approved 72 hours, and legal holds stop removal; only sealed result bodies may go, never receipts, the effect ledger, approvals or audit evidence. Log fields and error stacks are now redacted before the sink. [SENSITIVE-DATA.md](SENSITIVE-DATA.md) lists every table, column and sink with its protection.
  - **Actual spend and complete placement costs (COST-01, COST-02).** `GET /api/platform/v1/environments/:id/spend` returns the estimate, the provider-reported actual spend and the forecast as three separate kinds (none is a spending cap); `POST` (browser session) asks the provider billing API (AWS Cost Explorer, the GCP Cloud Billing export in BigQuery, Azure Cost Management, the OCI Usage API) for a period and stores the answer, with credentials read from FILES at call time and never stored. GCP needs `ZENITH_GCP_BILLING_EXPORT_TABLES` (project to export table map). The adapters have only been exercised against recorded provider responses, and live reads are opt-in per provider and are not run by CI: `ZENITH_LIVE_<PROVIDER>=1` with `ZENITH_LIVE_<PROVIDER>_BILLING_CREDENTIALS_FILE` (AWS, GCP, AZURE, OCI); the catalog refresh uses `ZENITH_LIVE_CATALOG_REFRESH=1` (GCP also `ZENITH_LIVE_GCP_CATALOG_API_KEY_FILE`). The committed price snapshots still carry no tiers or extended dimensions until the verifier refreshes them online from the public price files; estimates say so.
  - **AWS least privilege and the ECS image pointer (LIFE-03).** The AWS connection role policies now carry scoped grants for flow logs, instance profiles, ElastiCache users, tagged CloudFront distributions and `kms:ScheduleKeyDeletion` for tagged keys, and no longer carry the seven `iam:*Policy*` authoring grants; GovCloud and China partitions are built contract-level only. Re-apply the connection role stack (CloudFormation or the tofu module, see AWS-SETUP.md) to receive the change; nothing changes for a connection until then. **Upgrade note: the ECS image pointer moved.** The SSM parameter that holds the deployed image of a built ECS workload is now `/zenith<NameSuffix>/image-pointer/<environment>/<node>/image` (it was `/zenith/<environment>/<node>/image`), because the deploy role may only touch `parameter/zenith<NameSuffix>/image-pointer/*`. An existing environment keeps its old pointer, and its task definition keeps reading it, until the next apply or redeploy; that apply creates the new parameter and replaces the old one in state. The role can no longer delete the old path, so the old parameter can be left behind or the delete can be refused. Check with `aws ssm describe-parameters --parameter-filters Key=Name,Option=BeginsWith,Values=/zenith/` and remove each leftover `/zenith/<environment>/<node>/image` with an administrator credential (`aws ssm delete-parameter --name ...`) once the environment runs from the new path. Compare `tofu plan` output for an existing environment before approving it (the plan must show the pointer replaced and the task definition updated).
  - **Azure sovereign clouds (LIFE-04).** `usgov` and `china` clouds are wired through credentials, ARM, Key Vault, Log Analytics, ACR, Blob and DNS, but only the public cloud has a live harness (`ZENITH_LIVE_AZURE=1`, `ZENITH_LIVE_AZURE_CRED_FILE`, optional `ZENITH_LIVE_AZURE_ALLOW_BUILD`); sovereign values come from published tables and are contract-level only. The customer also configures the per-cloud `azurerm` provider environment in their own bootstrap provider block (`deploy/azure/README.md`).
  - **OCI deletion evidence and non-AWS DNS teardown (LIFE-05, LIFE-06).** OCI releases now record work-request receipts and family deletion readback. **A destroy review taken before this build for a teardown that deletes non-AWS DNS records carries no ownership proof and is REFUSED at apply; it must be redone** (request a new teardown review, have it approved, then apply). The reviewed `dnsOwnership` proof is bound to the approval, recomputed at apply, and a record that changed ownership refuses the destroy. An `already_absent` readback class is accepted for records proven gone. The OCI runner allowlist grew (Go sizes 58/58/11); rebuild and redeploy the runner and `zenithd` together with the control plane.
  - **One Kubernetes connection, two roles (K8S-CONN).** A `scoped_guest` connection can carry a separate customer-held deployer credential (`deployerCredentialRef`, scope `namespaced` or `cluster`); the broker picks the vault reference by request purpose, deploy and observe use only the deployer part, guest sessions only the minter, and neither ever stands in for the other. Without a deployer part deploy and observe are refused with `deployer_credential_refused`. Add one to an existing connection with `connection.rotate` and `{ deployerCredentialRef, deployerScope? }` (admin, browser, audited, both parts verified before promote). Revoking the connection stops Zenith using the deployer; the customer deletes the secret and identity cluster side.
  - **Mixed-provider plans (MIX-01 to MIX-04).** A mixed plan partitions a parent graph over child environments (each bound to its own verified connection and state backend), is approved as an ordinary operation whose immutable input carries the child digest set, and runs through `mixedParentWorkflow` (registered in the worker; children are separate operation workflows claimed through the durable start intent, one at a time, in dependency order; nothing is compensated or rolled back). The run service records every child transition and enforces ordering, timeouts, cancellation and expiry; teardown is a human-approved proposal per step. A child that consumes outputs of an earlier child starts only after the new materialization is applied; if it changes the parent digest, a review operation (`mixedParentReviewOf`) binding exactly that digest and the original child set is opened and the parent waits for a person (or a precise, live preauthorization), it never rebinds on its own. The platform has no producer output reader yet, so a plan with cross-partition references stays refused at start until one is wired. Gated live harness: `ZENITH_LIVE_MIXED=1`; not run.
  - **Live acceptance harnesses stay off.** Every `ZENITH_LIVE_*` gate (`ZENITH_LIVE_AWS_IAM`, `ZENITH_LIVE_AZURE`, the billing and catalog gates, `ZENITH_LIVE_MIXED`, and their credential FILE references such as `ZENITH_LIVE_AWS_CREDENTIALS_FILE`, `ZENITH_LIVE_API_URL`, `ZENITH_LIVE_API_TOKEN_FILE`, `ZENITH_LIVE_WORKSPACE_ID`, `ZENITH_LIVE_ENVIRONMENT_ID`, `ZENITH_LIVE_REGION`) must be set explicitly with credential file paths; without them the test skips with a stated reason and is never counted as passed.

### 2.6 OpenTofu engine

The Azure machine transport supplies `ZENITH_ARGV_B64` (protected, base64 JSON
argv), `ZENITH_CWD` (protected working directory) and `ZENITH_TIMEOUT_SEC`
(bounded execution time) as per-command guest parameters. They are internal
inputs to the fixed collector, not operator configuration on the control plane
or worker. Request values remain data; they are never interpolated into a script.

| Variable | Default | Meaning |
|---|---|---|
| `ZENITH_TOFU_BIN` | `tofu` found on `PATH` | Absolute path to the binary. The runner refuses any binary whose `tofu version -json` is not exactly the pinned `1.12.5` (`TOFU_VERSION` in `src/lib/tofu/types.ts`). The worker image installs 1.12.5 at `/usr/local/bin/tofu`, checksum-verified at build time. |
| `ZENITH_TOFU_PLUGIN_CACHE` | `<os tmp>/zenith-tofu-plugin-cache` | Absolute path of the shared provider plugin cache. The image's default lands in `/tmp`, which is lost whenever the container is replaced, so every new container re-downloads providers (the lockfile script notes about 160 MB per platform for the AWS provider). Pointing this at a persistent volume avoids that; this recommendation has not been tried. |

These are read from the **worker's** environment, but the child `tofu` process
never sees them: the runner builds the child environment from an
allowlist (`src/lib/tofu/env.ts`), and refuses `ZENITH_*`, `TF_CLI_ARGS*`,
`TF_LOG*`, `TF_VAR_*` and `TF_REATTACH_PROVIDERS` from any session or extra
configuration. No `ZENITH_*` variable, database URL or signing key can reach a
provider plugin.

The worker needs outbound HTTPS to `registry.opentofu.org` and the hosts the
registry points to for provider packages. `tofu init` runs with
`-lockfile=readonly`, so only the exact builds in the committed lockfiles
(`src/lib/tofu/locks/*.terraform.lock.hcl`) install.

The runner's own default wall-clock limit per command is 30 minutes
(`DEFAULT_LIMITS` in `src/lib/tofu/runner.ts`) while the workflow allows an apply
activity 60 minutes. The composed apply activity (`src/lib/execution/apply.ts`)
does not override that limit: long applies can be cut at 30 minutes and must
retain an uncertain outcome.

#### Ephemeral database credentials

`TofuFragment.ephemeral` is assembled as an `ephemeral` block in
`src/lib/tofu/workspace.ts`; temporary addresses never join state-backed resource
plans. A sensitive attribute alone is not a safe password sink. Azure MySQL
fresh creation uses ephemeral `random_password`, Key Vault `value_wo` and an
ephemeral Key Vault read feeding `administrator_password_wo`. The stored secret
is reused on retries/replacement and only its reference/version is exported
(`src/lib/providers/azure/drivers/data/mysql-bootstrap.ts`). Password values
are designed to stay out of OpenTofu plans/state; no live database apply was
verified in this sync.

AWS RDS uses service-managed master credentials (`manage_master_user_password`)
and exports only the Secrets Manager reference
(`src/lib/providers/aws/drivers/data/rds-compile.ts`). GCP Cloud SQL and Azure
Postgres use IAM/Entra authentication without a configured password
(`src/lib/providers/gcp/drivers/data/cloud-sql-instance.ts`,
`src/lib/providers/azure/drivers/data/postgres.ts`). Do not replace these paths
with literal password attributes or read a secret into a persistent data block.

OCI MySQL **creation remains disabled**: pinned `oracle/oci` 9.7.1 accepts
`admin_password` but has no proven `admin_password_wo` or provider-side Vault
reference. Fetching a Vault bundle into that attribute would persist the secret.
The driver has observe/runtime/verify/discover only and no compile method
(`src/lib/providers/oci/drivers/data/mysql.ts`). Gated provider-schema and
plan/state checks, rather than a suffix or mocked fixture alone, must prove a
safe path before creation can be enabled.

### 2.7 Policy engine

| Variable | Default | Meaning |
|---|---|---|
| `ZENITH_POLICY_WASM` | `<cwd>/policy/dist/policy.wasm` | Path of the compiled bundle. A missing, empty or tampered bundle makes `loadPolicyEngine()` reject with `PolicyLoadError`; callers must treat that as "deny everything". |

How the bundle ships:

- `next.config.ts` traces `policy/dist/**` into every route that evaluates policy
  (`outputFileTracingIncludes`), so a serverless build carries the bundle and its
  manifest. Checked by `tests/server/appwire-policy-bundle.test.ts`; no Vercel build
  has been run.
- `docker/worker.Dockerfile` copies `policy/dist/` into the worker's runtime image at
  the path the engine resolves, so the `evaluatePolicy` activity loads the same bundle.
  Not built with Docker here.
- Either way `ZENITH_POLICY_WASM` overrides the path; a missing or tampered bundle still
  makes the broker refuse everything (`policy_unavailable`), never allow.

### 2.8 Capability broker, approvals and the agent routes

| Variable | Default | Secret | Meaning |
|---|---|---|---|
| `ZENITH_PLATFORM_BROKER_MEMORY` | unset | no | `1` makes the broker use a per-process in-memory store. Tests and local development **only**: state is lost on restart and two instances share nothing. Never set it in production. Without it the broker uses the platform store and answers `platform_store_unavailable` when it cannot open it; it never falls back to memory silently. |
| `ZENITH_PLATFORM_ORIGIN` | `ZENITH_AGENT_ORIGIN`, then the request's own origin | no | The exact origin a browser approval, rejection or admin-setting request must come from: the `Origin` header must equal it (no prefix, no subdomain, not `null`) and `Sec-Fetch-Site`, when the browser sends it, must be `same-origin`. Set it to your public origin in production. |
| `ZENITH_AGENT_OAUTH_ISSUER` | unset | no | Exact trusted issuer for external OAuth JWTs. Set it together with `ZENITH_AGENT_OAUTH_JWKS`; leaving both unset disables this authentication path. Each URL must use HTTPS and have no credentials, query or fragment. Issuer matching uses the configured string exactly. |
| `ZENITH_AGENT_OAUTH_JWKS` | unset | no | HTTPS JWKS URL for the configured issuer. A partial or invalid issuer/JWKS pair refuses OAuth authentication. Tokens must also name the configured agent MCP resource as their audience; a valid signature alone grants no workspace access. |
| `ZENITH_AGENT_OAUTH_CLIENT_CLAIM` | `client_id` | no | Signed claim that identifies the OAuth client: only `client_id` or `azp` is supported. It must match the client in the current browser consent grant. |
| `ZENITH_AGENT_OAUTH_SUBJECT_CLAIM` | `sub` | no | Signed claim mapped to the product human subject. The configured claim name must start with a letter and contain at most 200 letters, digits, underscores, colons, slashes, dots or hyphens. Its value must be a bounded native subject identifier and match the current consent grant. |
| `ZENITH_RUNNER_RESULT_KEY` | derived from `ZENITH_CONTROL_SIGNING_JWK` | **yes** | base64url, 32 bytes. Seals runner and `zenithd` job results at rest (AES-256-GCM, bound to the workspace and job id), because a result can carry exactly what must never be stored in the clear (an AWS response body, a plan with sensitive values). Unset, the key is derived (HKDF-SHA256) from the private scalar of the local control signing JWK; with a KMS-backed control signer it **must** be set. Whoever opens results, an activity in the worker, needs the same key as the routes that seal them. Rotating it, or the signing key it was derived from, makes results still in flight unreadable; their operations end `uncertain`. |
| `ZENITH_GITHUB_APP_ID` | unset | no | Numeric GitHub App id, on web and worker. Together with the private-key file enables C3's tenant-scoped source binding. Unset keeps public reads anonymous. Register the App and apply platform migration 6 as described in [BUILDS.md](BUILDS.md#github-app-registration-and-workspace-binding). |
| `ZENITH_GITHUB_APP_PRIVATE_KEY_FILE` | unset | path only; file contents are **secret** | Absolute server path to the RSA App PEM, on web and worker. Read on demand to sign bounded RS256 JWTs. Never copy the PEM into an environment value or diagnostics. Partial/invalid configuration refuses access. |
| `ZENITH_GITHUB_APP_CLIENT_ID` | unset | no | GitHub App OAuth client id, web host only. Required by the browser install/bind flow to verify that the initiating GitHub user can access the installation repository. |
| `ZENITH_GITHUB_APP_CLIENT_SECRET_FILE` | unset | path only; file contents are **secret** | Absolute server path to the GitHub App OAuth client secret, web host only. Codes exchange server-side with PKCE; user tokens are discarded after verification and never stored or sent to the browser. |
| `ZENITH_GITHUB_APP_WEBHOOK_SECRET_FILE` | unset | path only; file contents are **secret** | Absolute server path to the GitHub App webhook secret, web host only. The signed revocation endpoint requires 32â€“4096 printable ASCII bytes in a regular file owned by the service identity, mode `0400` or `0600`, beneath its immediate private `0700` directory and trusted ancestors, with no symlink or multiply linked file; raw-body HMAC-SHA256 is verified before payload or database authority. Missing/invalid custody refuses. Configure the App to send supported installation/repository removal and suspension events; delivery never grants or re-enables a binding. Live GitHub delivery acceptance remains separate. |
| `ZENITH_TEST_SOURCE_GITHUB_APP`, `ZENITH_TEST_SOURCE_GITHUB_BINDING`, `ZENITH_TEST_SOURCE_REF` | private gate unset | no; identifiers only | Tests only: set the gate to `1` to authorize the opt-in private GitHub archive check, a strict JSON binding of non-secret identifiers, and a pinned 40-hex commit. Live private access was not run here. The existing public gate is `ZENITH_TEST_SOURCE_GITHUB` with `ZENITH_TEST_SOURCE_REPO` and the same ref variable. |

Identity is not new configuration: browsers use the product's Supabase setup
([RUNNING.md](../../RUNNING.md#supabase-auth-and-test-accounts)), and integration
callers use the product's `za_` credentials, verified against its credential authority
on every request, so revocation is immediate. The broker signs grants with the control
signing key (section 2.3).

External OAuth callers also need a current browser consent grant for the exact
subject, client, workspace and issuer. Revoked or expired grants refuse access;
effective scopes are the intersection of the signed token and that grant, and must
include `zenith:read`. The token must have a supported signing algorithm and a
lifetime of at most one hour. These settings configure verification and claim
mapping; they do not create consent or authorize a provider mutation. External
OAuth wire and browser acceptance remain separate checks.

What the broker enforces beyond the Rego rules, from `src/lib/capabilities/evaluate.ts`
(guards that only tighten): `plan_required` (an `infrastructure.apply` or `destroy`
without the reviewed plan from the execution side is denied) and `agent_autonomy_too_low`
(an agent cannot create a mutating proposal in an environment below autonomy 2).
A policy engine that cannot load, or a stored workspace policy that does not validate, is
`policy_unavailable`: refused, never allowed. See [POLICY.md](POLICY.md).

### 2.9 Reconciliation tick

The controller itself reads no environment except one development switch; the route
that drives it is gated like every other tick route.

| Variable | Default | Secret | Meaning |
|---|---|---|---|
| `CRON_SECRET` | unset | **yes** | Bearer token for `/api/internal/tick/*` (the product's name for it; see [RUNNING.md](../../RUNNING.md#environment-variables)). Unset, the route answers 503 and runs nothing; a wrong bearer is 401. |
| `ZENITH_RECONCILE_MEMORY` | unset | no | `1` runs the pass against an in-memory backend that is empty unless something seeded it. Local development and route smoke tests only: nothing is durable. |
| `ZENITH_WORKER_RECONCILE_SCHEDULE_MODE` | `observe` | no | Execution worker only: `observe` checks the existing owned schedule without creating, activating or unpausing it. Explicit `provision` reconciles only the fixed owned schedule after both pollers start; operator-pause state and ownership remain mandatory. Production requires an explicit namespace and authenticated TLS. See [RECONCILE-WORKER.md](RECONCILE-WORKER.md). |
| `ZENITH_WORKER_RECONCILE_MAX_ENVIRONMENTS` | `25` | no | Bounded sweep limit from 1 through 25. Fresh completed SQL observations determine readiness; an omitted, failed or deferred observation never reports healthy. |
| `ZENITH_WORKER_RECONCILE_CONCURRENCY` | `3` | no | Bounded per-sweep environment concurrency from 1 through 3, separate from host workload capacity. |

`src/lib/platform/app.ts` registers the production ports with
`wireReconcilePorts`. The route calls `ensurePlatformCron` after verifying its
bearer, so an unconfigured or incompatible store still yields
`platform_store_unavailable`; it never reports an unobserved fleet as healthy.

`.github/workflows/tick.yml` sends authenticated POSTs every five minutes,
including `/api/internal/tick/reconcile`. Set the repository's `CRON_SECRET`
to the same secret as the deployment, and use its dispatch `base_url` input
for a different origin. `vercel.json` only schedules the daily keepalive; a
long-lived host still needs to arrange reconcile POSTs. Scheduled Actions run
on the default branch; this configuration is not proof that a tick ran live.

The ordinary cron passes also call `platformRunnerReaperPass`, which expires
runner/machine jobs and marks their owning operations uncertain in a transaction.
The ledger backstop `reconcileOperations` (overdue proposals expire, lapsed running operations
become uncertain) runs in the leased housekeeping pass (`src/lib/platform/housekeeping.ts`),
triggered by the jobs tick with `?housekeeping=1`, together with idempotency-key and nonce pruning.

Reconciliation is paced by a backoff ladder (5, 15, 60, then 180
minutes while nothing changes; open drift never backs off past 60 minutes and an
open incident never past 15), with deterministic jitter and a per-pass budget of
about 20 seconds and at most a bounded number of environments; sandbox
environments and environments with no verified connection are not reconciled.
That is from `src/lib/reconcile/scheduler.ts` and `pass.ts`; none of it has run
against a fleet.

Repair proposals go through broker policy and approval. Allowed repairs call
`startDayTwo` in `src/lib/platform/reconcile.ts`; the controller itself performs
no mutation. Dispatch is not a successful repair: the execution capability path
can refuse unsupported work. Temporal reconciliation and the HTTP controller
share `reconcileObserveOnce`, `reconcileEnvironment` and `proposeRepairs`.
The worker renews its held `reconcile:<environmentId>` lease, heartbeats,
receives cancellation and checks the same fence before persistence, proposals
and dispatch. `allowAutoRepair` permits brokered proposal consideration; it
grants no mutation authority. Current workflow histories return counts and a
repair-decision digest; the retained legacy history branch preserves its
historical `not_implemented` result.

The shared declarative recipe admits only its bounded, managed AWS ECS
replica-count finding with a digest-pinned image. Its execution adapter remains
unmerged at this source snapshot, so proposal admission does not establish
executable remediation or production acceptance. Human approvals remain bound
to the immutable proposal digest and verified browser session; execution
retains current policy, saved-plan approval, scoped credentials and readback
verification. Uncertain operations block another dispatch until settled.
See [OBSERVATION-REPAIR.md](OBSERVATION-REPAIR.md) for the controller's bounds,
workflow history compatibility and remaining release blockers.

### 2.10 Tooling only (not runtime)

| Variable | Used by | Meaning |
|---|---|---|
| `ZENITH_OPA_BIN` | `npm run policy:build`, `policy:check` | Path to the OPA binary. Must be exactly 1.19.1. Default: `opa` on `PATH`. |

### 2.11 Modules that read no environment

The resource model (`src/lib/resources`), placement and cost (`src/lib/placement`),
the observability fabric (`src/lib/observability`), the incident engine
(`src/lib/incidents`), repository analysis (`src/lib/analysis`) and the merged AWS
network drivers (`src/lib/providers/aws/drivers`) read no environment variables.
Observability sources receive their clients and endpoints as arguments from the
broker session; the price catalog is a bundled JSON file.

### 2.12 Which component needs what

| Variable group | Web / API | Worker | Migration script |
|---|---|---|---|
| Platform store (`ZENITH_PLATFORM_DB*`, `ZENITH_DATA`) | yes | yes, explicitly configured | yes |
| OIDC issuer and signer | yes (serves the JWKS; needs a signer) | yes (mints tokens) | no |
| Control signing key | yes (signs grants/jobs) | yes, usable signer required at startup and for activity grants | no |
| Temporal connection | yes (client) | yes | no |
| `ZENITH_WORKER_*` | no | yes | no |
| Tofu variables | no | yes | no |
| Reconciliation tick (`CRON_SECRET`, `ZENITH_RECONCILE_MEMORY`) | yes (the route) | no | no |
| Policy bundle | yes (broker) | yes (execution broker) | no |
| `ZENITH_PLATFORM_BROKER_MEMORY` | development only | no | no |
| `ZENITH_PLATFORM_ORIGIN` | yes (browser approvals) | no | no |
| `ZENITH_RUNNER_RESULT_KEY` | yes (seals results) | yes, when an activity awaits runner jobs (opens them; must match) | no |
| `ZENITH_SECRET_KEY` | yes (product vault and Temporal payloads) | yes (plan fingerprints, vault and Temporal payloads) | no |
| `ZENITH_TEMPORAL_PREVIOUS_SECRET_KEYS` | when decrypting retained Temporal histories | same key set as the client | no |
| `ZENITH_VAULT_PREVIOUS_SECRET_KEYS` | when reading vault rows during rotation | when resolving vault references during rotation | no |
| GitHub App id/private-key file | yes (install verification) | yes (private source acquisition) | no |
| GitHub App OAuth client id/client-secret file | yes (browser binding only) | no | no |

### 2.13 Zenith-managed provider substrate

The `zenith` provider (`src/lib/providers/zenith`) reads **25 `ZENITH_MANAGED_*`
variables** in one function, `readSubstrateConfig`, and nothing else in that provider
reads the environment. They describe the platform's own cluster and services, not a
customer's. The authoritative table, with which are required and what each default is,
is [MANAGED-PLATFORM.md](../MANAGED-PLATFORM.md#configuration-zenith_managed_). Credentials
are `vault:` references, resolved at call time; an inline value (a PEM block, a kubeconfig
document) is refused by name. A missing required value makes the substrate
`configured: false` naming every missing variable, and a malformed one names the variable and
the problem; it never starts half-configured.

| Group | Variables |
|---|---|
| Cluster (required: server, kubeconfig reference, app domain) | `ZENITH_MANAGED_CLUSTER_SERVER`, `ZENITH_MANAGED_KUBECONFIG_REF`, `ZENITH_MANAGED_APP_DOMAIN`, `ZENITH_MANAGED_CLUSTER_CA_DATA`, `ZENITH_MANAGED_REGION` |
| Gateway and TLS | `ZENITH_MANAGED_GATEWAY_MODE`, `ZENITH_MANAGED_GATEWAY_CLASS`, `ZENITH_MANAGED_GATEWAY_NAMESPACE`, `ZENITH_MANAGED_GATEWAY_NAME`, `ZENITH_MANAGED_GATEWAY_LISTENER`, `ZENITH_MANAGED_INGRESS_CLASS`, `ZENITH_MANAGED_CLUSTER_ISSUER`, `ZENITH_MANAGED_INTERNAL_CIDRS` |
| Registry and object storage (optional) | `ZENITH_MANAGED_REGISTRY`, `ZENITH_MANAGED_OBJECT_STORAGE_ENDPOINT`, `ZENITH_MANAGED_OBJECT_STORAGE_BUCKET`, `ZENITH_MANAGED_OBJECT_STORAGE_PREFIX`, `ZENITH_MANAGED_OBJECT_STORAGE_REGION`, `ZENITH_MANAGED_OBJECT_STORAGE_CREDENTIAL_REF` |
| Managed database (optional) | `ZENITH_MANAGED_DB_PROVIDER`, `ZENITH_MANAGED_DB_API_BASE`, `ZENITH_MANAGED_DB_API_KEY_REF`, `ZENITH_MANAGED_DB_REGION`, `ZENITH_MANAGED_DB_ORG_ID`, `ZENITH_MANAGED_DB_EGRESS` |

The managed drivers are registered with the Kubernetes toolkit by
`src/lib/platform/drivers.ts`. Registration does not create a hosted cluster or
open a managed session: the platform credential contract has no `zenith` config.
No hosted substrate or tenant serving is verified here.

### 2.14 Customer state backends

`src/lib/execution/compile.ts` calls `backendForConnection` in
`src/lib/tofu/backends.ts`. Store these non-secret bootstrap identifiers on the
workspace's platform connection; credentials come only from the session/runner
environment and must never be written in backend configuration.

| Provider | Backend and required connection fields | State location / limit |
|---|---|---|
| AWS | `s3`: `stateBucket`, connection `region`; optional `stateKmsKeyArn` | Existing key remains `zenith/<workspace>/<environment>/terraform.tfstate`. Uses state locking; the optional KMS ARN configures OpenTofu state/plan encryption. |
| GCP | `gcs`: `stateBucket`; optional `stateKmsKey` | Prefix `zenith/<workspace>/<environment>`; the default workspace object is `default.tfstate`, not `terraform.tfstate`. |
| Azure | `azurerm`: `stateStorageAccount`, `stateContainer` | Key `zenith/<workspace>/<environment>/terraform.tfstate`; Entra auth, CLI auth disabled, OIDC enabled for OIDC connections. |
| OCI | S3-compatible: `stateBucket`, `stateNamespace`, connection `region` | Oracle-only endpoint `https://<namespace>.compat.objectstorage.<region>.oraclecloud.com`, path style and compatibility flags; no AWS KMS. Customer S3 secret key stays on the runner. Native principals used by `oci.http` cannot authenticate this backend. Platform OCI sessions go through the runner (`oci.http`), never through control-plane credentials. |
| Kubernetes | No automatic durable backend | An explicit execution backend override is required; no local fallback is silently selected. |

Unsafe scope segments, foreign-workspace connections, missing fields and
unsupported providers are refused. `src/lib/tofu/backend-config.ts` rejects
credential fields and arbitrary OCI endpoints. Provision and back up the state
storage before dispatching; backend locking, encryption and restore against
live providers are **not verified** here.

### 2.15 Operator CLI

`npm run cli -- --help` runs the existing `src/cli/bin.ts` entry point;
`package.json` also declares `bin.zenith`. See [CLI.md](../CLI.md) for login,
operation/event polling, proposal/check, browser approval links and exact-digest
execution. `ZENITH_URL`, `ZENITH_TOKEN` (**secret**) and `ZENITH_WORKSPACE` are
CLI-only inputs; no implicit server URL is selected. Approval happens in the
browser, never from a token or a yes in chat. MCP v3 has fifteen tools; its
complete catalog and scopes are in [MCP.md](../MCP.md#tool-catalog).

`ZENITH_CLI_ACL_PATH` and `ZENITH_CLI_ACL_ACTION` are internal variables passed
to the CLI's fixed Windows ACL helper (`src/cli/config.ts`). The CLI assigns
them itself; they are not operator configuration or authentication material.

## 3. The platform database

### 3.1 Choosing

| Where | Use | Migrations |
|---|---|---|
| Local development and tests | PGlite (Postgres compiled to WebAssembly, in process). Nothing to install. | Applied automatically when it opens. |
| Production and anything shared | PostgreSQL 16 through the pooler. | **You** apply them. The application never runs DDL against Postgres. |

### 3.2 Migrating

```bash
npm run migrate:platform                 # apply pending migrations
npm run migrate:platform -- --status     # print the ledger; exit 1 unless current
npm run migrate:platform -- --dry-run    # list what would be applied
npm run migrate:platform -- --url postgres://...   # target this database, not the environment's
```

The target is decided exactly as the application decides it (the variables in
section 2.2), and `.env.local` is read when present. The connection string is
never printed, only host, port and database name. Exit codes: 0 ok, 1 not
current or refused, 2 usage error.

What makes this safe to run from CI and by hand, at the same time if need be:
each migration and its ledger row (`platform.schema_migrations`: version, name,
checksum) commit in one transaction under a table lock, so two migrators
serialise and the loser finds the work done. A migration whose recorded checksum
differs from the code is refused (`schema_tampered`): shipped migrations are
never edited, a change is a new migration.

If you would rather apply SQL yourself (the Supabase SQL editor, `psql`), apply
`supabase/migrations/0023_platform_core.sql`. It is **generated** from the
TypeScript migrations by `npm run platform:emit-sql` (`-- --check` fails when it
is out of date; a test enforces byte equality). It is idempotent, writes the same
ledger rows with the same checksums (so the TypeScript migrator recognises it as
applied), turns row level security on for every table with no policies, and
revokes `anon` and `authenticated`. **`platform` must never be added to the Data
API's exposed schemas.**

The ordered canonical registry is `PLATFORM_MIGRATIONS` in
`src/lib/controlplane/db/migrations/index.ts`; each SQL checksum comes from
`migrationChecksum`. The following inventory was refreshed from the committed
current aggregate emitter output, including additive cleanup writer barrier migration 15 and authenticated standalone builtin settlement migration 16. Runtime source binding remains the exact integrated commit.
`tests/docs/operator-docs.test.ts` imports that canonical registry and checksum
function, then verifies every row, the count and highest version. A new migration
requires a regenerated inventory; changing a literal count alone does not pass.

Registered migrations: **60**; highest version: **60**.

<!-- platform-migrations:start -->
| Version | Name | SQL SHA-256 |
|---|---|---|
| 1 | `core` | `ec4e2c1a7185e25ea6afa803e87abcc1fe8a06cb65651773f573f0b66de13764` |
| 2 | `reconcile` | `af708ba78998ba35b05966afc4f037bacec9b38905853e6f43c8fdab92cb47f0` |
| 3 | `machine_requests` | `e1eccac97c7852592bcad8cd0e441b67a442c7405735ee9e2619e9e9b100bec6` |
| 4 | `approval_rounds` | `1e5d84e018bd35c3638bbd23bab8e5b0e7d9b6c3173a430259480508aca6f311` |
| 5 | `read_jobs` | `e8349e5ddf50a5396304850bd84bbffe81be1f4b0b7189677c1c1ad36ad4a387` |
| 6 | `github_sources` | `0e256ace8f784b996b2e6687dc42bb4705f91c4579b4ecb1da38987d9f68d78d` |
| 7 | `plan_artifacts` | `eb445d8479b4b8ba8c9c6e8df38fb95c3f9ca59f8949218e3c07f68727f62ae3` |
| 8 | `build_launches` | `90a025fd0c76ee84b14a26c9d8b1794e215ececec24333848904c22bc0f86e9d` |
| 9 | `github_revocation` | `7d00eb79279b57c682dda67af0a5eaffc5ff3825d5e6a370235dd0dfdb502060` |
| 10 | `github_deliveries` | `a4436e385563b8bd3b3528708b1db757c5a9872e1927dbd8ef5bd595e1e62bfd` |
| 11 | `agent_effect_receipts` | `f6c9d90f69447e430ad9ef2b8368b137b26cadcd05776d689959c99da9e0430b` |
| 12 | `workflow_start_intents` | `7eaa5e87e594d741e772e0cd9b77010c796d36c2c9ceac41f8f47720c804d811` |
| 13 | `approved_source_snapshots` | `eb513c01d41b1f7fbc680715b86699147374d9786aa3e17e355897388ff26e95` |
| 14 | `mixed_child_intents` | `5d676658116c3e66b1238c24a72da4ddbd65f06f30c57cf5dc753bcc0a56961e` |
| 15 | `cleanup_writer_barriers` | `1630821507e71c2ec68d0918bd82b0333aabb4f4211654927cc07d7eb4a6c123` |
| 16 | `cleanup_writer_settlements` | `30f73b35ae4bf2da289bd1a3ce403cc0bd409f383efb942a7aa095235333d711` |
| 17 | `machine_runbooks` | `757f57cf9d043b3f7bb2dcaa9af025c0a3251596a1ed5ddf9e6c21c6009518b9` |
| 18 | `ownership_transfers` | `d19177da5b80a5bde2ea6b51d232f288d7123546d7aca483d216d710bd769e7a` |
| 19 | `incident_stability` | `1db1a588796af8f7c9c01f62ab96e43d8f56a0f7e98b436a68af7e22813f8340` |
| 20 | `optimizer_settings` | `94217cb0c092fa1c268ba54b3fe10143382531dd74d9081c190030f26b67b249` |
| 21 | `scheduled_job_runs` | `462b8688f2776cf278dc0376c4f161c7169a3bc34ee77f6ad066006502108ab4` |
| 22 | `connection_rotations` | `a2048eb9416e3207b9a6a4b863a2458dc2667ef9c64b2903c306ffaefa2df79b` |
| 23 | `release_pipelines` | `6b29a1332678cf2d72942d72994d9a4faf34e5c8cb633cb09307a17daf0fb1f6` |
| 24 | `portability` | `9ae6f39475d3abb1317d44544ec0c8d6920e74f19c0b5af813339a5b41b11f20` |
| 25 | `agent_lifecycle` | `372c684b5da9f326f8852a3de713914a16b1a1849cb332967a6fb422f78e2fdd` |
| 26 | `plugin_boundaries` | `730dd0df2e58ff3f1e255ade7651cfac75879d84752f620d2785dff359c98c3a` |
| 27 | `github_revocation_reason` | `5af4252a6e4d0a65fe712b50b9d1da0f418ba3176c4c6f3ba0314bac7bd90b12` |
| 28 | `incident_stability_hardening` | `53fc08fb199fb67385b19a5bc251ca178c55026f50cb2c4a3db21ce44a5880b8` |
| 29 | `cleanup_writer_record_fields` | `e9cd8aaa47d4909c53f8ff5e71690cc6a07d85dae60de69d35192d97e5e7e0dc` |
| 30 | `durable_intent_authority` | `56ac37869bc4d4d64e03d0fff6eb063293961c9d56a3d3a6c2537aa27edaa178` |
| 31 | `executable_semantics` | `92e4ddbca876beb8b5fb5824a3ec03d5a932e7b35bcbc8a79a341f2e2ef493ed` |
| 32 | `plan_custody_state_recovery` | `27a0830cd2ef11dad72a582caf0c0613acc66984f22232e053194b9550babb28` |
| 33 | `external_effects` | `39a77c75890502a0a2d9851482014522a54718520715d506f502e698c1dd76dc` |
| 34 | `k8s_guest_bindings` | `dcb43344514109a0786cd4bd161e016dd472e5c00c5f5c33d08be3479e535f26` |
| 35 | `mcp_streams` | `2ff8e9a98ba733fdd3e934a6b9e0ffed3a68311b558ba05b6c10593565aca620` |
| 36 | `coding_agent_runs` | `404a4d5cfeb626eb491521cbfee6cde3904463364c002aae02ed252f8b9f9d65` |
| 37 | `actual_spend` | `dc00e59940187d352ac3fccf2c537ae381848f47ea4048b568cfb5536079f3e9` |
| 38 | `fair_bounded_control_plane` | `a62e1c17ee0cc4ac8ad23361ebcd5f7d7c95e17f80e9baf2e5b139264d8dbd9e` |
| 39 | `key_custody` | `333eed78e5f25e4a120c255bb87690fd5ffe6727c436350dbe833498ef48bdd1` |
| 40 | `mixed_parent_plans` | `53231efa3ea0a8275287b0672a1b76845ac1a3196bb2df6678843c61fe5bbd40` |
| 41 | `mixed_runs` | `adf77c2f92db4d7c74a58b4a056482a66866f12e43909eaf34f9c008a884cff8` |
| 42 | `external_effect_key_bounds` | `3dcc8f12119594941f82dd749f5471fb2578f1d5c37ec09083491aa6dc91f4b2` |
| 43 | `mcp_stream_events_tenant_index` | `903751ca1e2e2fff64979f699e6c44c6c98502f90374b788686e77ee080249cd` |
| 44 | `mixed_output_records` | `027e9fdbaced8902ee63d9c551ecfb812bd1fd7d96ea0356497200bac336d0d2` |
| 45 | `slo_measurements` | `1494c27a7ce8bdb8ca49b9c78cdf68e8e4bb7d3879e92f9e0a25a90bd55c5bf6` |
| 46 | `recovery_epochs` | `b60c5b5fd4ae95b2e7e3b14d503d0def9904561fceb73f8432c9984717ef4daf` |
| 47 | `retention` | `6be0f7bd6711cc5a37507541488bb09305d181823398929ed29e3aa9c8295909` |
| 48 | `audit_exports` | `44d625c45bf2e665cd424e96394d739a3d9733ce4a37a8812ff0fbedccae4fba` |
| 49 | `managed_source_provider` | `2ff01c3f1ccb9c4ed33122b7cfccfcb486aba0cec508dd9e555f62396b1a6313` |
| 50 | `managed_serving` | `84fd09e1866b387eb422173d38da18dd97aa7f5b967da8eb02f452a38ea99804` |
| 51 | `tenant_isolation_effects` | `78d3690342ffc5f35e73f67566ccfc48087095cfec2acf191468e560a99bb16a` |
| 52 | `billing` | `0236a9a6624adff33cce485ef54e4954cec5d629bfbb2fe4a0ccab5a51f5c45f` |
| 53 | `field_ownership_serialization` | `2c0dc88805c9d96c9ba133542ca4a31b8e8a0422f061250c14e92b5e513f2269` |
| 54 | `agent_update_controls` | `cbb2c080c4e5e5c3f09b4d999571d7bec54e121cb1f85b43fac407563ed189de` |
| 55 | `isolation_custody` | `b6e75e8ca5e06d8147f7b34086008551858f2bdf642cfc97f493d6ac9b902192` |
| 56 | `workspace_mfa_controls` | `aad9739d5412fe15b5ecd065a80dd205e74818287861c8484c68de578ecef3b0` |
| 57 | `wave5_gaps` | `55b72ecf1af8739036f17f1cd7f77b7e13f6de0e1de76773dd110af12aa8e450` |
| 58 | `kubernetes_source_provider` | `afef954e9417c33a3a0dadc254253ab523c9dbc425af27da5120927e8064df9a` |
| 59 | `field_ownership_grant_revocation` | `f5490db5eed06ab6ada997f33f13430eb249dbcfcc8a1b0c75252b6bb5a87b29` |
| 60 | `cleanup_writer_expand` | `ab27cfbe95d4380ebb2cc541fa953f7ce531ee17c5e122807ec9366119b223e7` |
<!-- platform-migrations:end -->

For the actual target, `npm run migrate:platform -- --status` calls the canonical
`platformSchemaStatus` verifier; the running build's registry and recorded ledger
checksums decide whether it is current. The documentation inventory is not an
installer or evidence that an operator's database has these migrations.

The historical migrations retain their purposes: `core` (1), `reconcile` (2),
`machine_requests` (3: the `zenithd` request queue), `approval_rounds` (4: a
plan-level review opens a new approval round while old decisions remain history),
`read_jobs` (5: runner reads that belong to no operation), `github_sources` (6:
tenant-scoped App source bindings and expiring install intents), and
`plan_artifacts` (7: immutable original ciphertext and source associations).
Subsequent registered migrations add permanent `build_launches` (8), monotonic
`github_revocation` (9), signed idempotent `github_deliveries` (10), and encrypted
immutable `agent_effect_receipts` (11), and permanent single-attempt `workflow_start_intents` (12). See [BUILD-LAUNCH-AUTHORITY.md](BUILD-LAUNCH-AUTHORITY.md),
[BUILDS.md](BUILDS.md) and [AGENT-EFFECT-RECEIPTS.md](AGENT-EFFECT-RECEIPTS.md)
for their authority and recovery limits; schema presence does not prove live
provider acceptance.
Canonical migration 7 enables RLS on each new artifact table and applies guarded
existing Supabase-role revocations and grants even when the migration owner differs
from the schema-6 emitted bootstrap owner. Custom runtime-role grants and RLS
bypass remain operator-owned and must be verified for the actual deployment.
Migration 6 also accepts tables installed by the former explicit GitHub schema
installer, preserving bindings and intents while recording the platform ledger.
A database that applied the emitted SQL before a later
migration landed is behind and the application refuses to use it until you re-apply
the file or run `npm run migrate:platform`.

Schemas 17 to 27 add, in order, the signed-runbook tables (`machine_runbook_*`; migration 17), append-only ownership transfers (18), incident stability state, remediation attempts, maintenance windows and postmortems (19), per-environment optimizer opt-in settings (20), scheduled critical job runs (21: `scheduled_job_runs`, PROD-OBS-04), connection rotation state (22: `connection_rotations`, PROD-LIFE-01), digest-bound release pipelines (23: `release_pipelines`, PROD-LIFE-10), portability export/restore records and resource adoptions (24: `portability`, PROD-LIFE-11), machine and runner lifecycle columns (25: `agent_lifecycle`, PROD-MACH-04), audience-bound plugin boundaries and grants (26: `plugin_boundaries`, PROD-UX-03) and the GitHub revocation reason (27: `github_revocation_reason`, PROD-LIFE-08). Schema 28 enables RLS without client policies on the four incident tables for direct canonical upgrades, retains only existing service-role DML, and adds a workspace-leading runbook schedule index. Schema 29 isolates grant-only record fields inside the grant branch of the shared cleanup trigger, preserving the existing held-plan and grant authority checks. Schemas 30 to 36 add durable operation authority and the intent outbox (30), approved executable semantics and standing grants (31), worker custody grants, reads and state backend probes and restores (32), the external-effect ledger (33), Kubernetes guest bindings (34), MCP streams (35) and coding-agent runs (36). The aggregate through schema 36 was `0022_platform_core.sql`; the current aggregate through schema 58 is `0026_platform_core.sql`. historical platform aggregates `0014`, `0016`, `0017`, `0018`, `0019`, `0020` and `0021` remain unchanged (published files are immutable, and an aggregate is a cumulative snapshot). The committed Supabase bootstrap applies `0023` after those aggregates and agent OAuth `0015`. Schema 16 adds immutable physical local-backend ownership and authenticated standalone builtin completion receipts. These receipts reconcile only eligible saved-plan history; they do not settle cloud calls, grants, workflows, builds or guest deliveries. Schemas 37 to 41 (wave 4) add actual spend snapshots (37), per-tenant maintenance, history and quotas (38), key custody facts and re-wrap jobs (39), mixed parent plans, child plans, receipts and the stable address registry (40) and mixed runs, their ledger and output preauthorizations (41); they are expand-only (new tables) and are emitted into `0023_platform_core.sql`.
If you apply migrations through the Supabase CLI's migration history, which records an applied
file by its version number and will not re-run a changed file, use
`npm run migrate:platform` (ledger-based) or apply the file by hand for any
schema version after the first. The emitted file holds every registered migration
in the inventory above. A database that applied it before a subsequent migration
landed is exactly this case. I did not exercise it through the Supabase CLI.

### 3.3 What the application does about the schema

On first use of a Postgres store, `platformDb()` calls `assertPlatformSchemaCurrent`
once. If the ledger is missing or a migration is pending it **fails closed** with
the command to run ("Nothing was read or written"). A database *ahead* of the
build (a newer deploy already migrated) is accepted, because refusing would break
every rolling deploy. The order that follows: **migrate first, then roll out the
new application**; an older build keeps working against a newer, additive schema.
Older code rolling back after a migration is safe only as long as migrations stay
additive; there are no down migrations.

### 3.4 Retention

Resource observations keep the latest 100 per resource; drift reports keep the
latest 50 per environment. The leased housekeeping pass
(`src/lib/platform/housekeeping.ts`) prunes expired idempotency keys and old
request nonces and runs `reconcileOperations`. The jobs tick with
`?housekeeping=1` and the in-process slow scheduler call it
(`src/lib/server/cron.ts`, `.github/workflows/tick.yml`). Repository pruning uses
`FOR UPDATE SKIP LOCKED` and rechecks expiry before deletion, so a refreshed
replay record is not removed (`src/lib/controlplane/db/repos/idempotency.ts`,
`src/lib/controlplane/db/repos/nonces.ts`). The worker's separate plan janitor
removes eligible old local binary plans (section 6.2). Nothing prunes events,
evidence, operations, approvals, policy decisions, grants or runner jobs; capacity
and audit retention for those tables remain operator responsibilities.

## 4. Signing keys

Generate them as described in
[`src/lib/credentials/OPERATIONS.md`](../../../src/lib/credentials/OPERATIONS.md#generating-keys)
(one `tsx` one-liner per key; KMS commands for production). Then:

- store the private JSON in the platform's secret manager or your host's
  encrypted environment, never in the repository, a manifest, a chat or a ticket;
- give the web app and the worker the variables in section 2.3 as that table
  says;
- confirm the public endpoints from outside:

```bash
curl -s https://<host>/api/oidc/.well-known/openid-configuration | jq .
curl -s https://<host>/api/oidc/jwks | jq '.keys[] | {kid, alg, kty}'
```

Both paths are public by design and are allowed through the session middleware in
`src/middleware.ts` on this branch. A `401` or a login redirect there would stop
AWS from creating or using the OIDC provider.

Rotation is in [RECOVERY.md](RECOVERY.md#6-key-rotation).

## 5. Temporal

### 5.1 Locally

```powershell
# 1. a local Temporal: in-memory, no UI
temporal server start-dev --headless --port 7233

# 2. the worker, from the repo root (reads .env.local if present)
$env:ZENITH_TEMPORAL_ADDRESS = "127.0.0.1:7233"
npm run worker
```

If something else on your machine already listens on 7233, pick another port and
give the same address to the worker and to the app. The dev server keeps history
**in memory**: stopping it loses every workflow. Add `--db-filename <path>` to
keep it in a file.

Before this command, supply the configuration in section 6.2, run the migrations
and select a spare Temporal port (do not reuse another project's server). A
ready worker prints `execution worker ready`, then a health line every minute.
It registers composed activities; a workflow may invoke external APIs. No
worker/cloud run is claimed by this docs sync.

### 5.2 In production

| | Temporal Cloud | Self-hosted |
|---|---|---|
| What you set | `ZENITH_TEMPORAL_ADDRESS=<namespace>.<account>.tmprl.cloud:7233`, `ZENITH_TEMPORAL_NAMESPACE=<namespace>.<account>`, plus API key or client cert/key files (section 2.4) | `ZENITH_TEMPORAL_ADDRESS`, namespace, and TLS settings from section 2.4: TLS flag for default trust, custom CA for private trust, cert/key files for mTLS. |
| Authentication | API key and/or mTLS client identity; either forces TLS. Configure the namespace's authentication requirements in Temporal Cloud. | Configure client-certificate authentication on the server and supply the cert/key pair here. Without an API key or client identity, TLS encrypts transport only; restrict access to the private network. |
| History | Held by Temporal; retention is a namespace setting. | Held in the database you run under it. Backing that up is yours. |
| What was verified | Nothing live. There is no Cloud account on the build machine; the option shapes follow the SDK's documented API-key and TLS options. | The dev server, locally. No production-shaped cluster. |
| Cost of operating | A subscription. | A cluster and its database to run, patch and back up. ADR-0009 names a Postgres-native engine as the fallback if this proves disproportionate. |

### 5.3 Payload encryption and rotation

`src/lib/workflows/codec.ts` encrypts complete protobuf payloads and their
original metadata with **AES-256-GCM**, a fresh nonce and an HKDF-derived key.
Both `src/lib/workflows/client.ts` and `workers/execution/worker.ts` configure
`temporalDataConverterFromEnv`. Use the same 64-hex `ZENITH_SECRET_KEY` and
previous-key set on clients and workers. Production refuses missing/invalid
keys; development clients without a key can read/write plaintext, but worker
startup still requires the key. Legacy plaintext histories remain readable.

Set `ZENITH_TEMPORAL_PREVIOUS_SECRET_KEYS` to a private JSON array of previous
64-hex keys. New writes use only the current key; previous keys decrypt retained
histories. Coordinate clients and workers during a key change, retaining all
keys needed for active workflows, retries, replay and archives. Removing a key
makes its payloads unreadable; histories are not automatically re-encrypted.
Changing this shared key also affects the product vault and plan fingerprints;
the Temporal previous-key option does not migrate either. See
[RECOVERY.md](RECOVERY.md#6-key-rotation) before rotating.

Workflow ids, task queues, visibility/search attributes and default failure
messages/stack traces are outside payload encryption. Keep the ids-only and
redaction contracts: no credentials, secret values, plan files or raw provider
responses in workflow history. No UI/CLI codec server is supplied. Live Temporal
Cloud acceptance and encrypted production recovery were not run here; the
implementation and local replay gate are described in
[EXECUTION-WORKER.md](../EXECUTION-WORKER.md#payload-encryption).

## 6. The execution worker

### 6.1 Image

```bash
docker build -f docker/worker.Dockerfile -t zenith-execution-worker .
```

Node 22.23.3 (base image pinned by tag and digest), OpenTofu 1.12.5 (pinned by
version and SHA-256; the build fails on an empty or wrong checksum), the bundled
worker and a prebuilt workflow bundle. It runs as a non-root user and exposes
loopback health probes (section 6.2); external connections are to Temporal, the
database and the clouds. It uses `tini`
as PID 1 so SIGTERM reaches the worker and orphaned provider processes are
reaped.

The default `production` image target excludes the packaged fixture client and
its store-seeding code. The separate `acceptance` derivative requires an
explicit build target. Its fixture client requires
`ZENITH_PACKAGED_ACCEPTANCE=1` plus the harness's exact disposable PostgreSQL,
Temporal, file-store and private plan-directory configuration; otherwise it
refuses to run. This switch is acceptance-only and does not enable a production
startup mode or grant cloud execution authority.

**Status: local `linux/arm64` image built successfully on 2026-10-02.** The image
ID is `sha256:ce29c543b82224ffd4db107351b33d671a16ce70754d1b478fc0493480e6b1ac`.
CLI probes with networking disabled and a read-only root filesystem verified
Node `v22.23.3`, non-root UID `10001`, OpenTofu `1.12.5` for `linux_arm64`, and
the packaged policy WASM SHA-256
`a1712c084ff7e492f187044cec5cb7ba86da32b76259f5d62e92df9e4cff0d57`
matching its manifest. No Zenith worker or server was started. The AMD64 image
build, actual worker startup and Temporal polling, cloud transports, and
production operation remain unverified for this image.

### 6.2 Running it

- Before polling, `workers/execution/startup.ts` requires an explicit
  `ZENITH_TEMPORAL_ADDRESS`, a valid 64-hex `ZENITH_SECRET_KEY`, a usable control
  signer (`ZENITH_CONTROL_SIGNING_JWK` or `ZENITH_CONTROL_KMS_KEY_ID`) and an
  explicitly configured platform store. It opens that store and checks schema;
  missing/behind/incompatible schema produces fixed guidance to run
  `npm run migrate:platform`. No stub fallback is registered.
- Supply the OIDC issuer/signer for federated sessions, matching runner result
  sealing keys where needed, the policy bundle and product-store configuration.
  Secrets arrive at run time; none is baked into the image. Startup does not
  verify cloud deploy permissions or every provider session.
- `ZENITH_WORKER_IDENTITY` is optional: the default (`zenith-exec-<host>-<pid>`) already satisfies
  the lease-holder rule (1â€“64 letters, digits, dots, underscores or hyphens). Set a stable value
  if you want the same identity across restarts; an invalid value stops the worker at startup.
- Read-only root filesystem works with `/tmp` and `/var/lib/zenith` writable
  (OpenTofu working directories and the plugin cache go to the temp directory).
- Stop timeout: set the orchestrator's stop timeout (Kubernetes
  `terminationGracePeriodSeconds`, Docker `--stop-timeout`) **above**
  `ZENITH_WORKER_SHUTDOWN_GRACE_MS`, or the worker is killed in the middle of an
  activity. On SIGTERM the worker stops polling and lets running activities
  finish for that long, then cancels them; a second signal exits immediately.
- Replicas: workers poll the same task queue; one queue serves every tenant.
  Binary plans live in `ZENITH_WORKER_PLAN_DIR` and later activities may run on
  another replica. Shared plan access and replica failover are not verified;
  do not infer safe multi-replica operation from workflow durability alone.
- **The product store.** The composed activities (`src/lib/execution`) read an
  operation's context from the product store and write the deployment projection back
  (`createProductPort`). So a worker that runs them needs the product store as the web app
  does: `ZENITH_STORE=postgres` with the Supabase keys ([RUNNING.md](../../RUNNING.md#running-on-vercel-with-postgres)).
  The file store is single-writer and cannot be shared between the web app and a worker.
  (From the port's header; not exercised.)
- Memory: `tofu` plans and applies are memory-hungry. The worker doc's rule of
  thumb of about 1 GiB per concurrent activity is an unmeasured guess.
- Health: `workers/execution/health.ts` listens on `127.0.0.1`, default port
  `9464` (`ZENITH_WORKER_HEALTH_PORT`). `/healthz` returns 200 for process
  liveness; `/readyz` returns 200 only when Temporal and the store are reachable,
  policy is loaded and all six providers have registered drivers, otherwise 503.
  Checks are bounded to two seconds and return only `ok`, `unavailable` or
  `unknown`, never configuration or raw errors. Readiness does not verify cloud
  permissions. Probe from inside the container; a remote pod probe cannot reach
  this loopback listener. JSON health logs and Temporal pollers remain useful.
- Plans: maintenance performs logical expiry only. Migration 7 stores authenticated original ciphertext in PostgreSQL, separate from sanitized evidence and mutable use attempts. `src/lib/execution/plan-janitor.ts` runs immediately and every five minutes, marking at most 100 expired uses per pass. Ciphertext and historical local files remain retained; there is no physical purge or new retention policy. Another worker uses the original after separate fresh checks, with no fresh-file fallback.

Drain old local-plan workers before migrating and installing custody-aware workers. Configure the dedicated artifact keyring and packaged executable identity before polling. Pending local-only plans require new review because their producer provenance cannot be reconstructed. Restore needs the original records, matching artifact/fingerprint keys and source/backend/lock/executable context. Previous artifact keys decrypt only. A lost dispatch response preserves uncertainty and blocks automatic replay; inspect provider state before proposing another reviewed write. Fences and policy revocation cannot atomically undo an accepted provider call.

What happens when a worker dies mid-operation is in
[RECOVERY.md](RECOVERY.md#4-what-happens-to-an-operation-when-something-crashes).

## 7. The web / API control plane

- The Next app serves `/api/oidc/*` and `/api/platform/v1/*` (the broker and the
  agent routes; section 1 and the status table list them) and `/api/agent/v3/mcp`
  (MCP v3, [MCP.md](../MCP.md)). `/platform` provides operations,
  environments/resources/drift/incidents, workspace policy, AWS connection setup
  and placement. Reads show persisted evidence and timestamps; refresh does not
  claim a fresh cloud read. See `src/app/(product)/platform/README.md`.
- **How the agent and integration routes get past the session middleware.** Browser
  routes (approve, reject, autonomy and policy writes, runner/machine administration)
  need a signed-in session, which the middleware enforces. Runner and `zenithd` calls
  (registration, poll, heartbeat, result, logs) are let through by exact path
  (`src/lib/runners/paths.ts`) and authenticate with their request signature.
  Integration calls are let through only for the exact method/path pairs classified
  `bearer-capable` in `src/app/api/platform/v1/_lib/bearer-paths.ts`, and only with a
  `Bearer` header; the route then verifies the `za_` credential before waitlist
  admission or any tenant read. A new route fails `tests/middleware` until it is
  classified. From tests; not reproduced against a live Supabase.
- Set `ZENITH_PLATFORM_ORIGIN` (or `ZENITH_AGENT_ORIGIN`) to your public origin:
  approvals demand an exact `Origin` match, and the fallback is the request's own origin.
- The broker needs a platform database URL in production (section 2.2), the control
  signing key (section 2.3) and the policy bundle (section 2.7).
- Route handlers that start or signal workflows must declare the Node runtime
  (`export const runtime = "nodejs"`); the Temporal client is a gRPC client.
- `@temporalio/client`, `@temporalio/worker`, `@electric-sql/pglite` and
  `@open-policy-agent/opa-wasm` are in `serverExternalPackages` already.
- The web app does not need the `tofu` binary, the worker variables, or
  `ZENITH_TOFU_*`.

## 8. Order of operations for a first install

1. Create the platform database; apply migrations (`npm run migrate:platform`,
   or the emitted SQL). Check with `-- --status`.
2. Generate the OIDC and control keys; store them as secrets (KMS for OIDC in
   production).
3. Deploy the web app with the variables in section 2.12 (including a platform
   database URL, the control signing key and `ZENITH_PLATFORM_ORIGIN`); verify the two
   OIDC URLs from outside. Bundle tracing and classified middleware paths are
   implemented (sections 2.7 and 7); deployment behavior remains unverified here.
4. Stand up Temporal (Cloud namespace, or your cluster) and confirm the namespace
   exists.
5. Build and run the worker; confirm `execution worker ready` and pollers in
   Temporal.
6. Connect a customer AWS account in `/platform/connections/aws`:
   [AWS-SETUP.md](AWS-SETUP.md). This uses the browser action adapter; observe-role
   identity verification does not verify deploy permissions.
7. Configure authenticated reconcile ticks (section 2.9), then review placement
   and any operation in the browser before dispatch. Missing matching plan
   artifacts keep plan-bound UI approval disabled.

## 9. What was and was not verified

Historical WS-DOCS run record (before this sync, Windows 11, Node 24.19;
not rerun or independently verified here):

- `npm run migrate:platform` and `-- --status` against an empty PGlite directory
  (migrations 1 and 2 applied; migration 3 landed afterwards and was exercised only by the
  repository's own suites; status current) and
  `npm run platform:emit-sql -- --check`.
- `npm run policy:check`: OPA 1.19.1, 205 of 205 Rego tests pass and the committed
  bundle matches a fresh build.
- `temporal server start-dev --headless` on a spare port and `npm run worker`
  against it: the worker compiled its workflows (with the esbuild fallback, because
  the `@swc/core` native binding does not load here), reported `execution worker
  ready` and kept logging `health` with state `RUNNING`.
- The migration ledger, leases, operations and `reconcileOperations` against a
  real PostgreSQL 16.15 (see [RECOVERY.md](RECOVERY.md#8-what-was-rehearsed)).
- The old worker boot record predates composition and used stub activities;
  it does not verify the current execution path.

This sync checks current wiring by reading the composition modules, worker,
cron, UI, placement and backend code and running `tests/docs` as recorded in the
handoff report. The drift assertions pin those calls and configuration fields.
No worker, provider API, migration, policy compiler or deployment was run here.

Written but **not run by me**: the platform CI lanes in `.github/workflows/ci.yml`
(`policy`, `tofu`, `go`, `workflows`, `platform-postgres`, `ledger`,
`supply-chain`) and `.github/workflows/live-acceptance.yml`. The lane that applies
the platform migrations with the production migrator and runs the control-store
suites with `ZENITH_TEST_PLATFORM_PG_URL` set is `platform-postgres`; it targets a
bare PostgreSQL 16.15 container, so it says nothing about Supabase's role graph,
PostgREST or pooler. `live-acceptance.yml` is dispatch-only and has never been
executed (no sandbox AWS account exists); until it has, nothing is `real`.

**Not verified**, and stated once here instead of hedged everywhere:

- Anything against a real AWS account: STS `AssumeRoleWithWebIdentity`, KMS
  `Sign` and `GetPublicKey` (Ed25519 in particular), IAM accepting Zenith's
  tokens, the bootstrap template applied for real.
- Temporal Cloud, API-key and mTLS authentication; a production-shaped
  self-hosted cluster.
- `docker build` of the worker image; SIGTERM handling on Linux; behaviour of the
  worker under load.
- A TLS-only Postgres (the `sslmode` note in section 2.2); the Supabase CLI
  history note in section 3.2.
- The recommendation to put `ZENITH_TOFU_PLUGIN_CACHE` on a persistent volume.
- A Vercel deployment of any of this: no Vercel build was run for these modules.
- The REST routes over HTTP against a real Supabase identity provider, the
  integration bearer path, and the runner and `zenithd` registration and poll flow
  end to end with the Go agents.


### External-effect key repair, schema 42

Migration42 (`external_effect_key_bounds`) repairs PostgreSQL's maximum regex
repeat count while retaining the original ASCII alphabets and 1â€“256-character
bounds. Apply the new cumulative `0024_platform_core.sql` after earlier published
snapshots; never modify migration33 or snapshots through0023. Fresh installations
apply42 before inserting external-effect records.

For an existing schema41 installation, stop and drain API/worker mutation writers
before running `ZENITH_ALLOW_CONTRACT_MIGRATIONS=42 npm run migrate:platform`.
The in-process migrator retains its contract gate: both the registered exact SQL
checksum and this explicit operator confirmation are required. The SQL snapshot
is an operator migration path; it must likewise be applied only after draining
writers. Never set this flag permanently on server or worker startup. Constraint
replacement is atomic and validates existing rows; invalid stored data stops the
upgrade without deleting receipts. Resume writers after schema verification.

### Additive MCP replay index, schema43

The verifier schema43 cumulative snapshot was `0025_platform_core.sql`. Migration43 adds a
nonunique `(workspace_id, stream_id, seq)` index to tenant-scoped MCP replay events.
Published migrations and prior snapshots remain immutable. Upgrade42â†’43 is
expand-only and does not require a contract exception; upgrading through42 still
requires its explicit drained-writer admission. Ordinary index creation may block
writes while building: no zero-downtime or live migration claim follows local tests.


## Wave 5 assembly inventory and operator gates

The current cumulative snapshot is `0026_platform_core.sql`, schema 59. Published schemas 1â€“43 and aggregates 0016â€“0025 remain byte-identical. The canonical inventory/checksums above include schemas 44 mixed outputs, 45 SLO measurements, 46 recovery epochs, 47 retention, 48 audit exports, 49 managed source CHECK widening, 50 managed serving, 51 isolation effect-family widening and 52 billing. `scripts/ci/apply-supabase-migrations.sh` applies 0026 last. Emit with `npx tsx scripts/platform/emit-sql.ts`; verify with `--check`.

`0027_product_flush_atomic.sql` adds `public.zenith_product_flush(jsonb, jsonb)`, the one-transaction product-store flush (`PostgresStore` writes every changed row of a pass through it, with per-row version guards; EXECUTE is granted only to `service_role`). Apply it with the other product migrations before deploying an API or worker image that contains this change, or every product write fails.

When upgrading schema 43, first drain writers, then explicitly name `ZENITH_ALLOW_CONTRACT_MIGRATIONS=49,51`. An older installation still needing the published regex repair also needs 42 in that list. Exact reviewed SQL hashes and approval references live in `CONTRACT_MIGRATION_APPROVALS`; changing SQL voids admission. This flag never authorizes real execution or bootstrap. Cumulative Supabase snapshots are a separate explicitly operated schema application path; drain writers there too.

| Variable / path | Default and purpose |
|---|---|
| `ZENITH_AUDIT_EXPORT_SIGNING_JWK` | Absent: signed audit export unavailable. Independent local EdDSA private key from the secret manager, purpose `signing:audit-export`; never reuse control/OIDC/release authority. |
| `ZENITH_BACKUP_KEY` | External backup root also derives a distinct `enc:archive` key through HKDF. No archive key bytes in configuration output. |
| `ZENITH_RETENTION_POLICY_FILE` / `ZENITH_RETENTION_POLICY` | At most one. Default is the approved DEC-RETENTION baseline: logs 30 days, audit-evidence classes retained, payloads 72 hours. A supplied policy needs its own `approval` object, and `pruneAfterDays` under 365 on `resource_observations` or `drift_reports` is refused. An approval and `ZENITH_RETENTION_APPLY=1` are both required to prune; `ZENITH_DATA_MINIMIZE_APPLY=1` (with an approved policy; window `ZENITH_RESULT_RETENTION_HOURS`, default 72) switches on payload removal. Archive objects and older backups are not expired by Zenith. |
| `ZENITH_BILLING` | `disabled`; opt-in `managed` uses test-mode Stripe only. `ZENITH_BILLING_STRIPE_SECRET_KEY` and `ZENITH_BILLING_STRIPE_WEBHOOK_SECRET` come from secret custody. |
| `ZENITH_MANAGED_OPERATOR_CREDENTIAL_PREFIX` | Required for tenant sessions. Separately provision approved isolation and tenant/node-pool credentials before first deploy. |
| `ZENITH_MANAGED_FQDN_ENGINE`, `ZENITH_MANAGED_EGRESS_FQDNS` | Existing profile controls; Cilium hostname enforcement needs verified chart pins. |
| `ZENITH_MANAGED_RUNTIME_CLASS` | Optional sandbox runtime, provision and verify it separately; namespace-only contracts prove no isolation. |

`billing`, `data-retention` and `managed-serving` remain in the union of `CRITICAL_JOBS`. Billing has a bearer-protected fallback in tick.yml using the same fenced OBS-04 runner. `/admin/slo` links from the operator navigation. `ops:recovery restore` registers the local SLO recording sink; measurement publication never clears continuation hand-offs or proves application availability. See [Wave 5 verification](../../build/production/verify/W5-ASSEMBLY.md), [managed onboarding](../../build/production/verify/W5-ASSEMBLY-ONBOARDING.md) and [limitations](../../LIMITATIONS.md).

Managed configuration additions (all external references, never inline credentials):

| Variable | Default / effect |
|---|---|
| `ZENITH_MANAGED_VAULT_SCOPE` | `zenith-platform`; reserved scope for separately provisioned platform/tenant credential references. |
| `ZENITH_MANAGED_DEFAULT_PLAN` | `free`; operator-selected provisional tier, not synchronized with billing assignments. |
| `ZENITH_MANAGED_HTTP_CLUSTER_ISSUER` | Absent; custom HTTPS domains unavailable until an ACME HTTP-01 ClusterIssuer is provisioned. |
| `ZENITH_MANAGED_OBJECT_STORAGE_IAM_ENDPOINT` | Optional HTTPS IAM admin endpoint for scoped principal provisioning; actual IAM enforcement needs emulator/native acceptance. |
| `ZENITH_MANAGED_OBJECT_STORAGE_ADMIN_CREDENTIAL_REF` | Optional vault reference for the separately authorized storage administrator; missing config refuses object-store plans. |
| `ZENITH_MANAGED_OBJECT_STORAGE_ADMIN_CONNECTION` | Optional `<workspaceId>/<connectionId>` for the admin broker; resolve and authorize before use. |
| `ZENITH_MANAGED_BUILDER_IMAGE` | Absent; contract build configuration requires a digest-pinned image. Default production builds still refuse pending isolated build custody. |
| `ZENITH_MANAGED_BUILD_NAMESPACE` | `zenith-build` in the injected build adapter; shared builds are unavailable in default composition. |
| `ZENITH_MANAGED_BUILD_PUSH_SECRET` | Optional existing dockerconfigjson Secret name in that build namespace; no secret material is accepted here. |
| `ZENITH_MANAGED_BUILD_REGISTRY_INSECURE` | `0`; `1` is only for a disposable loopback kind registry, never production. |

## Final integration configuration (verification pending)

`ZENITH_ISOLATED_BUILD_CONFIG` declares the owned isolated builder; `ZENITH_ISOLATED_BUILD_PROFILES` binds per-tenant namespaces, credentials and dedicated nodes. Source builds refuse absent or invalid custody.

`ZENITH_API_VERSION=3` is the only plugin entrypoint environment override. The isolated builder itself receives `ZENITH_BUILD_ID`, `ZENITH_REGISTRY_PROBE_URL` and `ZENITH_REGISTRY_PROBE_ENDPOINT` from deterministic rendering; these identify the bound build and pinned registry probe, and are not operator credentials.

Unpublished integration closes the unused J4 slot: isolation custody 55, workspace MFA 56, Wave 5 gaps 57 and Kubernetes source provider 58. Contract migrations 49, 51, 57 and 58 need their explicit reviewed compatibility approvals and a drained migration window. Published snapshots 0016 through 0025 are unchanged.

`ZENITH_LOCAL_MAINTENANCE_ENV_FILE`: Mac-only absolute private J4 overlay FILE for J15; local server/credentials remain bound to J1, with a fresh maintenance database, serverless/managed billing, pool 2 and an isolated j4-* namespace. See `docs/build/production/verify/J4-SCHEDULES-RUNBOOKS.md`.
