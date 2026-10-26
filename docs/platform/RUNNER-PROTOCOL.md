# Runner and zenithd wire protocol — v1

Two outbound-only agents speak to the Zenith control plane:

| Agent | Protocol id | Runs where | Does |
|---|---|---|---|
| `zenith-runner` | `zenith.runner/v1` | customer cloud/network (container, Helm, binary) | executes signed jobs with the customer's **local workload identity**: OpenTofu, an AWS SigV4 signing proxy, a Kubernetes API proxy, network probes |
| `zenithd` | `zenith.machine/v1` | on a Linux VM | executes signed **semantic machine operations** (inspect, service status/restart, container logs, bounded reads, checks); `machine.exec` only when locally enabled |

Neither agent accepts inbound connections. Neither ever receives cloud master
credentials, model credentials, or Zenith database access. Cloud credentials
used by the runner never leave the customer environment.

Both are Go, one module at `go/` (`go/cmd/zenith-runner`, `go/cmd/zenithd`),
static binaries (`CGO_ENABLED=0`), Linux first.

## 1. Keys and identities

| Key | Holder | Algorithm | Purpose |
|---|---|---|---|
| control-plane signing key | Zenith control plane (`ZENITH_CONTROL_SIGNING_JWK`, private Ed25519 JWK; KMS-backed in production) | EdDSA (Ed25519) | signs job envelopes (`typ: zenith-job+jwt`), machine requests (`typ: zenith-machine+jwt`) and capability grants (`typ: zenith-grant+jwt`) |
| agent identity key | each runner / zenithd, generated locally at registration, never leaves the host | Ed25519 | signs every HTTP request the agent makes |
| OIDC issuer key | control plane (`ZENITH_OIDC_SIGNING_JWK`, RSA) | RS256 | cloud workload-identity federation only; never used by these agents |

The agent pins the control-plane public key (and `kid`) returned at
registration. A key rotation is announced in heartbeat responses
(`nextKeys`) at least 24 hours before use.

## 2. Registration

1. An admin creates a registration token in Zenith (single use, ≤ 1 hour,
   shown once, stored only as SHA-256). The token names the workspace and the
   agent kind (`runner` | `machine`) and, for machines, an optional
   environment/resource binding.
2. The agent generates an Ed25519 key pair and calls
   `POST /api/platform/v1/{runners|machines}/register`:
   ```json
   { "token": "zrt_…", "publicKey": "<base64url raw 32 bytes>", "name": "prod-vpc-runner",
     "version": "1.0.0", "capabilities": ["tofu.run", "aws.http", "probe.http"], "labels": {"region":"ap-south-1"},
     "host": {"os":"linux","arch":"amd64"} }
   ```
3. Response:
   ```json
   { "id": "run_…", "workspaceId": "…", "controlPlaneKeys": [{"kid":"cp-2026-09","publicKey":"<base64url>"}],
     "pollIntervalSec": 5, "protocol": "zenith.runner/v1" }
   ```
   The token is consumed in the same transaction that creates the agent row.

## 3. Signed requests (agent → control plane)

Every request after registration carries:

```
X-Zenith-Agent:          <agent id>
X-Zenith-Timestamp:      <unix seconds>
X-Zenith-Nonce:          <16 random bytes, base64url>
X-Zenith-Content-SHA256: <hex sha256 of the exact body bytes; of "" for no body>
X-Zenith-Signature:      <base64url Ed25519 signature>
```

over the UTF-8 string (fields joined by `\n`, no trailing newline):

```
<protocol id>
<HTTP METHOD uppercase>
<path including query, exactly as sent>
<timestamp>
<nonce>
<content sha256 hex>
```

The server rejects: unknown or revoked agent (`401 agent_revoked` —
terminal, the agent stops), clock skew > 60 s, a nonce seen within the last
10 minutes for that agent, a body digest mismatch, a bad signature.

TLS: the agent always verifies the server certificate (system roots, or a
pinned CA via `tls.caFile`). Where the control plane terminates client-cert
mTLS (self-hosted), the agent presents `tls.clientCert/clientKey`. A control
plane on Vercel cannot terminate client-cert mTLS; there the request
signature above is the client authentication, and the docs say so.

## 4. Jobs (control plane → runner)

`POST /api/platform/v1/runners/{id}/poll` (signed, body `{"max":1,"waitSec":20}`,
long-poll ≤ 25 s) returns `{"jobs": ["<compact JWS>", …]}`.

Each job is a compact JWS, header `{"alg":"EdDSA","kid":"…","typ":"zenith-job+jwt"}`,
payload:

```json
{
  "protocol": "zenith.runner/v1",
  "jti": "job_…",
  "runnerId": "run_…",
  "workspaceId": "…",
  "operationId": "…",
  "capability": "infrastructure.apply",
  "kind": "tofu.run | aws.http | k8s.http | probe.http | probe.tcp | probe.dns",
  "payload": { },
  "grant": "<compact JWS capability grant>",
  "iat": 1790000000,
  "exp": 1790000300,
  "timeoutSec": 1800,
  "maxOutputBytes": 1048576
}
```

The runner verifies, in order, and rejects (reporting `rejected` with a
reason) on any failure: signature with a pinned key; `typ`; `runnerId` is
itself; `iat`/`exp` (skew 60 s); `jti` unseen (persisted replay cache,
retained ≥ 24 h; an already accepted job id is dropped silently, without a
second result that could race the original); `kind` enabled in local config; the embedded grant's
signature, `exp`, `aud == "runner:<id>"`, `cap == capability`, `op ==
operationId`; the payload schema; kind-specific allowlists (below).

Grant ids are not single-use at the runner: the job id prevents replay, and
one operation grant can authorize several bounded jobs for that operation.

Results: `POST /api/platform/v1/runners/{id}/jobs/{jti}/result` (signed):

```json
{ "status": "succeeded | failed | rejected | timed_out", "startedAt": "…", "finishedAt": "…",
  "exitCode": 0, "result": { }, "error": "…" }
```

Logs (optional, streamed): `POST …/jobs/{jti}/logs` with
`{"seq": n, "lines": [{"ts":"…","stream":"stdout|stderr|info","line":"…"}]}`,
≤ 64 KiB per call, redacted by the runner for credential patterns.

Grant check (runner, before each step of a multi-step job): `GET …/jobs/{jti}/grant`
(signed, no body). `200 {"live": true, …}` when the grant is active or consumed;
`403 grant_not_active` when it is revoked, expired or unknown. The runner ends the job
without running the step on any answer other than `200` (fail closed).

The control plane accepts exactly one result per job (first writer wins,
conditional update); a duplicate returns `409 already_settled`.

### Job kinds

**`tofu.run`** — payload `{ "command": "plan|apply|show", "files": [{"path","contentB64"}],
"lockfile": "…", "configDigest": "…", "planFileSha256": "…", "destroy": true }` (`destroy` optional, `plan` only). The runner
recomputes `configDigest` and refuses a mismatch. The rule, identical in
`src/lib/tofu/workspace.ts` (`configDigestOf`) and Go: files sorted by path
bytes (paths are ASCII), then
`sha256( concat( path ‖ 0x00 ‖ lowercase-hex(sha256(content)) ‖ 0x0A ) )`,
lockfile excluded; golden vector `tests/tofu/fixtures/config-digest-vector.json`.
It runs its pinned OpenTofu with `-lockfile=readonly` in a fresh temp dir.
- `plan` keeps the binary plan file it produced (keyed by `configDigest` and
  the file's sha256, retained ≤ 24 h) and returns `{ exitCode, output,
  planJson, planFileSha256 }`. Optional `destroy: true` builds a destroy plan;
  applying that retained plan requires `infrastructure.destroy`.
- The **control plane** normalizes `planJson` (`normalizePlan`) and computes
  the plan digest; the runner never re-implements normalization.
- `apply` requires a retained plan file the runner itself produced for the
  same `configDigest` whose sha256 equals `planFileSha256`, and applies
  exactly that file. The control plane only issues an apply job after a
  fresh `plan` job whose normalized digest equals the approved digest.
Result: `{ exitCode, output (redacted, truncated), planJson?, planFileSha256? }`.
`planJson` has a separate `maxPlanJsonBytes` limit (default 3 MiB); exceeding it
fails with `plan_json_too_large`, never truncates JSON. `maxOutputBytes` bounds
the textual output, not the plan JSON.

**`aws.http`** — the SigV4 signing proxy. Payload `{ "service", "region", "method",
"url", "headers", "bodyB64" }` is an *unsigned* AWS API request serialized by
the control plane's AWS SDK. The runner: requires `https://` and a host
matching `*.amazonaws.com` / `*.amazonaws.com.cn` / `*.api.aws`; strips any
`Authorization`, `X-Amz-Security-Token`, `X-Amz-Date`; derives the action
(JSON protocol `X-Amz-Target`, query protocol `Action=`, REST protocols by
method+path pattern) and checks `service:Action` against the allowlist for
the job's capability; signs with the **local** credential chain; executes
with the job timeout; returns `{ status, headers (allowlisted), bodyB64 }`
capped at `maxOutputBytes`. It never returns its own credentials.

**`k8s.http`** — payload `{ "method", "path", "bodyB64", "contentType" }` against
the in-cluster API server with the runner's service-account token; allowlist
of verb + API group/resource per capability.

**`probe.http` / `probe.tcp` / `probe.dns`** — bounded checks. The runner
always refuses link-local and instance-metadata addresses
(`169.254.0.0/16`, `fd00:ec2::254`, `metadata.google.internal`).

## 5. Machine requests (control plane → zenithd)

Same registration, signing, polling (`/machines/{id}/poll`) and result
shapes, with `typ: zenith-machine+jwt` and payload:

```json
{ "protocol": "zenith.machine/v1", "jti": "mreq_…", "machineId": "mac_…", "workspaceId": "…",
  "operationId": "…", "operation": "service.status", "args": { "unit": "nginx.service" },
  "grant": "<JWS>", "iat": 0, "exp": 0, "timeoutSec": 30, "maxOutputBytes": 65536 }
```

The machine grant's `cap` equals the envelope's `operation`, with audience
`machine:<machineId>`. Results and logs use the same `jobs` segment as runners:
`POST /api/platform/v1/machines/{id}/jobs/{jti}/result` and
`POST /api/platform/v1/machines/{id}/jobs/{jti}/logs`. An already accepted
request id is dropped silently, and grant ids are not consumed once per request.
The posted `result` is `{ok, operation, data, output?}`; `data` follows
[`MachineResultDataSchemas`](../../src/lib/machines/results.ts), or
`{error: <MachineFailureCode>, reason?}` for a semantic failure. Exec data carries
`exitCode`, and output carries `stdout`, `stderr`, `exitCode`, `truncated`.
Arguments are normalized by the TS machine plane; `since` is a relative duration
such as `15m` or `2d`, positive and bounded to 7d. Protocol rejections still
carry the shared agent's protocol reason and are mapped by the machine driver.

zenithd implements each operation as fixed code — no shell string is ever
built from `args`:

| Operation | Implementation | Local guard |
|---|---|---|
| `machine.inspect` | os-release, uptime, load, memory, disks | — |
| `process.list` | `/proc` scan | — |
| `service.status` | `systemctl show <unit>` (argv, validated unit name) | unit name regex |
| `machine.service.restart` | `systemctl restart <unit>` | `services.restartAllow` list |
| `container.list/inspect/logs` | Docker Engine API over the unix socket | `containers.enabled` |
| `container.exec` | Docker exec | `exec.enabled` + grant |
| `file.read` | open + bounded read | `files.readAllow` path prefixes; no symlink escape |
| `network.portCheck` / `network.dnsCheck` | dial / resolver | metadata IPs refused |
| `system.metrics` | `/proc` | — |
| `system.logs` | `journalctl -u <unit> --since … -n …` (argv) | line cap |
| `machine.exec` | argv exec (`args.argv: string[]`, never a shell) | `exec.enabled: false` by default |

Every request, accepted or rejected, is appended to a local JSONL audit log
(`/var/lib/zenithd/audit.jsonl`, 0600) with the request id, operation, grant
id, outcome and output digest — never the output itself for `file.read`.

## 6. Heartbeat, revocation, reconnect

`POST /{runners|machines}/{id}/heartbeat` every 30 s with `{version, capabilities,
running, host}` → `{revoked, nextKeys?, pollIntervalSec}`. A `revoked: true`
response or `401 agent_revoked` on any call makes the agent stop taking
work, finish nothing further, and exit non-zero. Transient network errors
back off exponentially (1 s → 60 s, jittered) and resume; in-flight jobs keep
their own deadlines. The control plane marks an agent `stale` after 3 missed
heartbeats and never dispatches to it; a job whose runner goes silent past its
deadline becomes `uncertain` on the operation, never re-dispatched
automatically.

**Delivery lifecycle.** Results are durable on the agent: a finished job's
result is written to a local spool (`<stateDir>/spool`, fsync, atomic rename)
before it is posted, and removed only after the control plane accepted it,
answered `409 already_settled`, or refused it terminally. After an outage or
restart the agent replays what is still spooled, at start and on every
reconnect. Replay is idempotent on the control plane: the first outcome of a
job wins, an exact logical retry of it is accepted (`200`), a different one is
`409 already_settled`. The heartbeat body may carry an informational
`lifecycle` object (`connection`, `spool`, `update`); the control plane
validates and bounds it, drops it silently when malformed, and never lets it
change revocation, staleness or dispatch. The admin list shows one
`connection.state`: `online`, `recovering` (heard from again but still
delivering saved results), `offline` (stale) or `revoked`. A revoked agent
also records the revocation locally and refuses to take work after a restart
until it registers again. See `docs/platform/RUNNER-UPDATES.md` for the signed
update channel and rollback.

## 7. Versioning

The protocol id is in every signed string and every envelope. A breaking
change is `v2` with both served in parallel during migration; the control
plane refuses an agent whose protocol it does not speak with
`426 upgrade_required` naming the minimum version.
