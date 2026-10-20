# PROD-UX-02: J10 client interoperability verification

Built from `3a9de905` in `prod6-j10-client-interop`, 2026-10-08. Implementation status remains
`implementation_complete_verification_pending`; no new acceptance evidence or verified state is claimed.

## Implementation and acceptance mapping

| Acceptance clause | Implementation and evidence to run |
|---|---|
| Actual official SDK list/call and version compatibility | `scripts/agent/mcp-conformance.ts --official` uses the pinned SDK's typed 2.0 API, including the two-argument `callTool`. Four explicit revisions: 2025-03-26, 2025-06-18, 2025-11-25, 2026-07-28. Unsupported 2024 revision must be HTTP 400. `official-client-conformance.test.ts` uses the real in-process Zenith server. |
| Exact issuer and audience | Production `verifyOAuth` unchanged. In-process SDK tests use real runtime RSA signatures and foreign-issuer/audience tokens. The Keycloak fixture signs an exact MCP audience and an administrator-managed `zenith_subject` claim mapping to an existing member. `oauth-issuer-live.test.ts` checks actual issuer discovery and browser-issued tokens. |
| Scoped consent and refusals | Exact effective scoped catalog and SDK -32602 withheld-tool refusal. Fixture exposes literal `zenith:*` scopes, default read only, mandatory issuer consent, public DCR with loopback redirects and at most 12 total clients. User profile and registration policies prohibit client/user edits to identity mappers. Zenith browser grants remain mandatory and intersect token scopes. |
| Streaming/reconnect | SDK progress callbacks, increasing durable ids, SDK `resumeStream` result replay and foreign-principal 404. In-process test drops the actual POST body after the stored priming event and proves SDK automatic reconnect delivers the held read once. A stalled resume GET is bounded by 15 seconds, including its header wait; the SDK transport is closed on timeout. Modern protocol reconnect is an idempotent retry, not Last-Event-ID; existing journey covers its envelope. |
| Cancellation | SDK AbortSignal emits legacy cancellation; SDK replay must contain the server's durable `request_cancelled` error. A held read is required; missing inputs are SKIP. The CLI accepts `--slow-tool/--slow-args` or their environment equivalents. Official cancellation probes must use read tools. |
| Revocation | `--official --revoke` runs resource revocation once, last, then requires the next SDK connect to be refused. CLI output redacts all supplied credentials. In-process authority/grant mutation is modeled; actual revocation is covered by the existing `oauth-revoke.test.ts` and operated steps below. |
| Actual Claude Code / Codex CLI | Exact Mac setup and supervised checklist below. These client runs and browser consent have not been performed on this machine. |

Owned changes: `scripts/agent/mcp-conformance.ts`; new `deploy/acceptance/oauth-issuer/{compose.yaml,prepare.mjs,authorize.mjs}`;
new tests `tests/agent-v3/{official-client-conformance,oauth-issuer-fixture,oauth-issuer-live}.test.ts`; this document; only PROD-UX-02 in `ledger.json`.
The existing package/lock modifications were supplied before this job and were preserved without edits.
No migrations, snapshots, execution guards, installer/default composition or dependencies were changed.

## Local check receipt

All shell commands prepend Node 22 to PATH. No npm install/ci, Git mutation or cloud call was run.

- Initial `npx vitest run tests/agent-v3/official-client-conformance.test.ts --no-file-parallelism --maxWorkers=2`: 4 passed, 1 failed, 0 skipped. The new test incorrectly counted 14 steps. Replaced the count with the exact required 13 step IDs; no production assertion or existing expectation was weakened.
- Focused new-suite run: `npx vitest run tests/agent-v3/official-client-conformance.test.ts tests/agent-v3/oauth-issuer-fixture.test.ts tests/agent-v3/oauth-issuer-live.test.ts --no-file-parallelism --maxWorkers=2`: **13 passed / 0 failed / 5 skipped**, exit 0 (two files passed, one gated file skipped).
- Broader targeted attempt: `npx vitest run tests/agent-v3/official-client-conformance.test.ts tests/agent-v3/oauth-issuer-fixture.test.ts tests/agent-v3/oauth-issuer-live.test.ts tests/agent-v3/client-conformance.test.ts tests/agent-v3/stream-store.test.ts tests/agent-v3/oauth-revoke.test.ts --no-file-parallelism --maxWorkers=2`: **54 passed / 2 failed / 5 skipped**, exit 1. One new cleanup assertion counted SDK close invocations rather than distinct clients (failed connects close internally as well). Replaced it with exact distinct-client coverage, ten clients. The existing stream-store follow test exceeded its unchanged 20-second timeout. Neither the test nor server was edited to evade the timeout.
- Successor on the affected files, with no concurrent typecheck from this job: `npx vitest run tests/agent-v3/official-client-conformance.test.ts tests/agent-v3/stream-store.test.ts --no-file-parallelism --maxWorkers=2`: **19 passed / 0 failed / 0 skipped**, exit 0 (two files passed; 299.71 seconds including 213.39 seconds of import work). The earlier timeout was not reproduced. Counts overlap across attempts and must not be summed as a single execution.
- Final SDK regression run after timeout hardening: `npx vitest run tests/agent-v3/official-client-conformance.test.ts --no-file-parallelism --maxWorkers=2`: **7 passed / 0 failed / 0 skipped**, exit 0 (one file passed; 108.17 seconds, 18.75 seconds of tests). The additional test uses the real SDK transport with a fetch that never delivers headers, advances the virtual clock through the actual 15-second deadline, and requires the request's signal to be aborted. The optional revocation POST also has that request deadline.
- Lint: `npx eslint scripts/agent/mcp-conformance.ts deploy/acceptance/oauth-issuer/prepare.mjs deploy/acceptance/oauth-issuer/authorize.mjs tests/agent-v3/official-client-conformance.test.ts tests/agent-v3/oauth-issuer-fixture.test.ts tests/agent-v3/oauth-issuer-live.test.ts`: exit 0, **0 errors / 0 warnings**, six files. Run six times during development, including after the final typing fixes and resume regression. The initial five-file command omitted the not-yet-created `oauth-issuer-live.test.ts` and also exited 0. After the last revocation timeout edit, `npx eslint scripts/agent/mcp-conformance.ts` also exited 0 with **0 errors / 0 warnings**.
- Compiler: `bash Z:/Projects/Spawned.ai/zenith-wt/.resume/codex/tsc-serial.sh`: initial exit 1, two diagnostics in new tests only (readonly grant arrays and an unnarrowed JWKS discovery extension field). Copied arrays into the mutable grant shape, but initially narrowed the registration URL instead of the JWKS URL. Second run exited 1 with the remaining JWKS diagnostic. Added explicit string validation at the actual JWKS fetch. **Third run: exit 0 / 0 diagnostics**, after waiting in the shared serial lane. The successful compiler's recorded source versions match all six final code/test files, including the late timeout hardening; no duplicate whole-repo typecheck was needed.
- `node --version`: **v22.23.3**, exit 0. `node --check deploy/acceptance/oauth-issuer/prepare.mjs` and `node --check deploy/acceptance/oauth-issuer/authorize.mjs`: **2 passed / 0 failed / 0 skipped**, exit 0.
- LibreSSL portability correction: `node --check deploy/acceptance/oauth-issuer/prepare.mjs` and `npx eslint deploy/acceptance/oauth-issuer/prepare.mjs`: exit 0, **1 syntax pass / 0 failures**, lint **0 errors / 0 warnings**. Uses a CA configuration file instead of OpenSSL-only `-addext`.
- Local certificate smoke: `node deploy/acceptance/oauth-issuer/prepare.mjs --dir <new GUID-named directory under C:\Users\user\AppData\Local\Temp> --zenith-origin https://localhost:3400 --subject <runtime GUID>` then `openssl verify -CAfile <dir>/tls/ca.crt <dir>/tls/server.crt`: **2 passed / 0 failed / 0 skipped**, exit 0. All passwords and keys were generated at runtime and not printed. This establishes Windows OpenSSL generation/chain validity only, not Mac LibreSSL or issuer execution. Automatic approval review blocked both checked-path recursive and explicit-file native PowerShell cleanup before execution, stating "blocked by policy". The owned directory remains `C:\Users\user\AppData\Local\Temp\zenith-j10-smoke-20442cf0ec6a401097d4ccb00a4819ca`.
- `npm run agent:conformance -- --print-commands --url https://localhost:3400`: **1 passed / 0 failed / 0 skipped**, exit 0; CLI command output includes the installed SDK and this verifier packet.
- With a runtime-generated disposable token in `ZENITH_CONFORMANCE_TOKEN`, `npm run agent:conformance -- --url https://localhost:3400 --tool zenith_prepare_deploy --official`: **1 expected refusal / 0 unexpected outcomes** (npm exit 1). Rejects mutating probes before a network request. Both read and slow probes are now checked before the fetch journey starts.
- Read-only `git status --short`, `git log --oneline -10`, `git diff -- package.json package-lock.json`, `git diff --stat`, `git diff --numstat`, `git diff --check` plus scoped `Get-Content`/`rg` inspections: completed. Test counts do not apply to these inspections. An initial read of the absent `verify/UX-02.md` failed; the actual `verify/PROD-UX-02.md` was subsequently read. Two exploratory rg paths were absent/invalid and corrected through explicit file reads; an exploratory Get-Content on the typecheck lock directory returned exit 1. A package-file read briefly returned a missing-path error; the pinned 2.0.0 package and full-path source were subsequently read successfully, without reinstalling. `Get-Item`/`Get-Process` inspected the lock/processes while waiting, without changing either. A `Get-CimInstance Win32_Process` inspection was access denied; status came from the original terminal session.
- Public Quay manifest lookup via `Invoke-WebRequest` was blocked by sandbox sockets; web Quay API access was unavailable. The digest is sourced from upstream [Keycloak issue 45415](https://github.com/keycloak/keycloak/issues/45415). Registry/ARM64 inspection and image execution are pending, never represented as passed.

Read-only compiler source-version check, exit 0: **6 matches / 0 mismatches / 0 missing files**.
This compares TypeScript's SHA-256 source versions, after the compiler exited successfully, with the
actual final files. It does not run another compiler or change its cache:

```bash
node --input-type=module -e 'import {readFileSync} from "node:fs"; import {createHash} from "node:crypto"; const build=JSON.parse(readFileSync("tsconfig.tsbuildinfo","utf8")); const files=["scripts/agent/mcp-conformance.ts","deploy/acceptance/oauth-issuer/prepare.mjs","deploy/acceptance/oauth-issuer/authorize.mjs","tests/agent-v3/official-client-conformance.test.ts","tests/agent-v3/oauth-issuer-fixture.test.ts","tests/agent-v3/oauth-issuer-live.test.ts"]; for (const file of files) { const i=build.fileNames.indexOf("./"+file); if(i<0) throw new Error("Not included: "+file); const info=build.fileInfos[i]; const saved=typeof info==="string" ? info : info.version; const actual=createHash("sha256").update(readFileSync(file,"utf8").replace(/^\uFEFF/, "")).digest("hex"); if(saved!==actual) throw new Error("Compiler source differs: "+file); console.log("MATCH "+file); }'
```

## Mac setup: pinned real issuer, no cloud

Node 22; native macOS ARM64; Docker 4 GiB. Run heavy services serially. Keycloak uses one CPU,
768 MiB (128-512 MiB Java heap), local cache, ephemeral H2, a tmpfs data directory and HTTPS only.
It needs no PostgreSQL/Temporal sidecar. This is a disposable interop fixture, not a production issuer.
The exposed port is loopback only; registration source-IP checks are disabled to accommodate Docker's
NAT while the redirect/root/admin URL loopback policy remains enforced. Do not publish this fixture on a shared network.

First record `node --version`, `docker version`, `claude --version`, `codex --version`, `git rev-parse HEAD`.
Verify the pinned image and native architecture before startup:

```bash
docker buildx imagetools inspect quay.io/keycloak/keycloak:26.4.7@sha256:9409c59bdfb65dbffa20b11e6f18b8abb9281d480c7ca402f51ed3d5977e6007
```

Expected: the immutable digest resolves and includes linux/arm64. Refuse emulation as native evidence.
If the upstream pin cannot be acquired or is not an ARM64 index, report blocked and request a reviewed
replacement digest, rather than falling back to a tag or fabricating a digest.

Use a new private temporary directory and an existing, disposable Zenith member (not `local`/`system`).
The HTTPS origin below must match the actual J1 local installation; changing a port means regenerating
the fixture because the exact audience is minted into every access token.

```bash
export ZENITH_CONFORMANCE_URL=https://localhost:3400
export ZENITH_INTEROP_SUBJECT='<existing Zenith member ID>'
export ZENITH_CONFORMANCE_WORKSPACE='<existing workspace ID>'
export ZENITH_CONFORMANCE_ARGS='{"target":{"workspaceId":"<ws>","projectId":"<project>","environmentId":"<environment>"}}'
export ZENITH_INTEROP_DIR="${TMPDIR%/}/zenith-interop-$(date +%s)"
node deploy/acceptance/oauth-issuer/prepare.mjs --dir "$ZENITH_INTEROP_DIR" \
  --zenith-origin "$ZENITH_CONFORMANCE_URL" --subject "$ZENITH_INTEROP_SUBJECT"
source "$ZENITH_INTEROP_DIR/zenith.env"
export ZENITH_TEST_OAUTH_ISSUER=1
docker compose --project-name zenith-interop --env-file "$ZENITH_INTEROP_DIR/compose.env" \
  -f deploy/acceptance/oauth-issuer/compose.yaml up -d issuer
node --input-type=module -e '
let ready=false;
for(let i=0;i<36;i++) {
  try { const r=await fetch(process.env.ZENITH_AGENT_OAUTH_ISSUER+"/.well-known/openid-configuration");
    if(r.ok && (await r.json()).issuer===process.env.ZENITH_AGENT_OAUTH_ISSUER) { ready=true; break; }
  } catch {}
  await new Promise(r=>setTimeout(r,5000));
}
if(!ready) process.exit(1);'
npx vitest run tests/agent-v3/oauth-issuer-live.test.ts --no-file-parallelism --maxWorkers=2
```

Expected first live run: 4 passed / 0 failed / 1 skipped (browser token needs explicit second gate).
A blocked container/import/metadata/DCR response is a failure, not a pass. The tests create and delete
only their own DCR clients and refuse outside redirect URIs without contacting that outside host.

Join with J1: start its reviewed real local Supabase Auth/PostgREST, private-CA pooler and platform DB.
This work does not start or recreate that subsystem. Pass the four `ZENITH_AGENT_OAUTH_*` bindings
from `zenith.env` plus the CA to its API process. Keycloak uses `azp`, not Zenith's default `client_id`;
its random Keycloak `sub` is not a Zenith member, so use the administrator-managed `zenith_subject` mapping.
For an already configured J1 stack whose API is run on the host, the exact API command is:

```bash
export ZENITH_AGENT_ORIGIN="$ZENITH_CONFORMANCE_URL"
npm run dev:webpack -- --hostname localhost --experimental-https \
  --experimental-https-key "$ZENITH_INTEROP_DIR/tls/server.key" \
  --experimental-https-cert "$ZENITH_INTEROP_DIR/tls/server.crt"
```

For a packaged API, J1 must mount the CA read-only and set `NODE_EXTRA_CA_CERTS` to its container path;
`localhost:8443` is the host issuer, so container-to-host routing/TLS must be provided by J1 without
changing the advertised issuer. No installer, Compose merge or DNS workaround was added here.
Expected protected resource metadata lists the literal `ZENITH_AGENT_OAUTH_ISSUER` and exact API resource.
Run the local stack at HTTPS, never disable OAuth HTTPS enforcement or TLS verification.

Trust the generated `tls/ca.crt` for the browser and CLI TLS clients in the verifier's disposable environment.
Node uses `NODE_EXTRA_CA_CERTS`; Rust Codex may need `SSL_CERT_FILE`/OS trust depending on its build.
For macOS login-keychain trust, record the certificate fingerprint before adding it:

```bash
openssl x509 -in "$ZENITH_INTEROP_DIR/tls/ca.crt" -noout -fingerprint -sha1
security add-trusted-cert -r trustRoot -k "$HOME/Library/Keychains/login.keychain-db" "$ZENITH_INTEROP_DIR/tls/ca.crt"
export SSL_CERT_FILE="$ZENITH_INTEROP_DIR/tls/ca.crt"
node deploy/acceptance/oauth-issuer/authorize.mjs "$ZENITH_INTEROP_DIR"
```

The authorization helper prints a public client ID and local URL, not passwords/tokens. Before following
that URL, authorize that client ID and exact issuer in Zenith Integrations for the existing member,
workspace, allowed projects and read/plan/logs only. Read the generated private `credentials.json` locally
for the fixture login; do not include it in evidence. Complete real issuer consent in the browser.
The callback validates state and issuer before code redemption, and exchanges S256 PKCE over trusted
TLS. It verifies the signed token identity/audience and writes `tokens.json` with mode 0600, refusing
to overwrite it. Tokens expire after five minutes; renew by starting a new authorization, preserving
old receipt files privately or regenerating the fixture.

Automated alternative for the disposable fixture only: `ZENITH_TEST_OAUTH_ISSUER=1 node deploy/acceptance/oauth-issuer/authorize-playwright.mjs "$ZENITH_INTEROP_DIR"`
(with `zenith.env` sourced and optional `ZENITH_TEST_BROWSER_BIN`). It drives the real Keycloak login and consent pages in Chromium
as the runtime-generated `interop-user` (trusting only the fixture leaf by SPKI pin), then reuses `authorize.mjs` unchanged for DCR, PKCE and
the code exchange. It records `"automated browser, disposable user"` in `tokens.json` and the non-secret `provenance.json`; the human path records `"human browser consent"`.

```bash
export ZENITH_TEST_OAUTH_BROWSER_TOKEN=1
npx vitest run tests/agent-v3/oauth-issuer-live.test.ts --no-file-parallelism --maxWorkers=2
export ZENITH_CONFORMANCE_TOKEN="$(node --input-type=module -e 'import{readFileSync}from"node:fs"; console.log(JSON.parse(readFileSync(process.env.ZENITH_INTEROP_DIR+"/tokens.json","utf8")).access_token)')"
export ZENITH_CONFORMANCE_ISSUER="$ZENITH_AGENT_OAUTH_ISSUER"
export ZENITH_CONFORMANCE_SCOPES=read,plan,logs
npm run agent:conformance -- --official --discover-issuer --json
```

Expected second live test run: 5 passed / 0 failed / 0 skipped, while the fresh token remains valid.
The conformance command must pass configured checks; official audience/issuer/principal isolation,
in-flight cancellation and revocation remain explicit skips unless their inputs are supplied.
Negative signed tokens are exercised locally by the contract tests. For actual-stack negative-token
proof, use a separate disposable realm/client whose signed issuer/audience differs; never alter the
token under test or relabel an invalid signature as a foreign-issuer/audience test.
Environment inputs: `ZENITH_CONFORMANCE_FOREIGN_AUDIENCE_TOKEN`, `_FOREIGN_ISSUER_TOKEN`,
`_FOREIGN_PRINCIPAL_TOKEN`, `_SLOW_TOOL`, `_SLOW_ARGS`. A slow read must actually remain in flight;
do not add production delays, use a fast call as fake cancellation evidence or use a mutating tool.

## Claude Code and Codex CLI: actual operated acceptance

Primary docs checked on 2026-10-08: [Claude Code MCP](https://code.claude.com/docs/en/mcp),
[Codex MCP](https://developers.openai.com/codex/mcp/), [Keycloak DCR](https://www.keycloak.org/securing-apps/client-registration),
[Keycloak containers](https://www.keycloak.org/server/containers). CLI versions/help output belong in
the receipt because auth registration flags and callback URLs vary by release.
These are Mac commands, not results reported by this builder. Use local server connections; do not run
agent/model prompts or provider operations without the verifier's separate authorization.

Claude Code OAuth (no bearer header, so discovery and consent are exercised):

```bash
claude mcp add --transport http --callback-port 8743 zenith-interop "$ZENITH_CONFORMANCE_URL/api/agent/v3/mcp" \
  --header "x-zenith-workspace: $ZENITH_CONFORMANCE_WORKSPACE"
claude mcp login zenith-interop
claude mcp list
claude mcp get zenith-interop
```

In the issuer admin UI at `https://localhost:8443`, identify the actual new DCR client ID. Add its exact
issuer/client grant in Zenith Integrations for the member and intended scopes. Reconnect or retry the
MCP login after the grant exists. The issuer consent page must show literal requested `zenith:*`
permissions. Claude `/mcp` must report Connected and the scoped tools. If automatic DCR is refused
because that version sends non-loopback client URLs, record the refusal and use a separately registered
public client with its exact callback plus `--client-id`; do not loosen the fixture's redirect policy.
This fallback is pre-registered-client evidence, not an automatic-DCR pass.

Codex OAuth: put this in the verifier's disposable CLI config, without `bearer_token_env_var`:

```toml
mcp_oauth_callback_port = 8744
[mcp_servers.zenith_interop]
url = "https://localhost:3400/api/agent/v3/mcp"
env_http_headers = { "x-zenith-workspace" = "ZENITH_CONFORMANCE_WORKSPACE" }
```

```bash
codex mcp login zenith_interop --oauth-client-registration dcr
codex mcp list
codex mcp get zenith_interop
```

Use the exact callback URL shown by that installed Codex version. Approve its separate DCR client in
Zenith Integrations as above, then Codex `/mcp` must show the same scoped tool catalog. A version lacking
`--oauth-client-registration` must use its documented default DCR flow and record that version; it must
not be described as exercising a flag it lacks. Do not supply a bearer during an OAuth acceptance run.

For each actual client, record sanitized evidence of: discovery/resource/issuer; actual registered client
ID; browser consent strings; tools/list and a successful read with the v3 envelope; withheld write tool
refusal; streaming progress; interrupted network and reconnection; a genuinely in-flight read cancelled;
Zenith grant revocation followed by a refused new call. Re-authorize a new grant for the next client.
If a client exposes neither progress/resume nor a cancellable long-running read, record unsupported or
blocked for that clause; the SDK result is separate evidence and cannot substitute for it.
No screenshots/transcripts may include access/refresh/registration tokens, passwords or keys.

Finally, use a disposable helper token for the automatic resource revocation check:

```bash
npm run agent:conformance -- --official --discover-issuer --revoke --json
```

Expected configured SDK checks pass and `official-revocation` proves immediate 401/403. Optional missing
inputs are still named skips. Revoking at Keycloak alone does not revoke Zenith's grant; disconnect at
Zenith Integrations or use its RFC 7009 endpoint to prove resource access ends.

## PostgreSQL lane and cleanup

With the actual J1 local PostgreSQL endpoint, set the existing `ZENITH_TEST_PLATFORM_PG_URL` secret
outside the repository, then run serially:

```bash
: "${ZENITH_TEST_PLATFORM_PG_URL:?Set the actual J1 PostgreSQL endpoint; do not run this lane on PGlite}"
npx vitest run tests/agent-v3/stream-store.test.ts tests/agent-v3/client-conformance.test.ts \
  tests/agent-v3/oauth-revoke.test.ts --no-file-parallelism --maxWorkers=2
```

Expected no failures. This lane is not run on the Windows builder; PGlite cannot establish PostgreSQL
acceptance. Temporal/kind/clouds are not required for the assigned read-only fixture.

```bash
claude mcp logout zenith-interop
claude mcp remove zenith-interop
codex mcp logout zenith_interop
codex mcp remove zenith_interop
docker compose --project-name zenith-interop --env-file "$ZENITH_INTEROP_DIR/compose.env" \
  -f deploy/acceptance/oauth-issuer/compose.yaml down
# Remove only the exact recorded disposable CA fingerprint, not other trusted roots:
security delete-certificate -Z '<recorded SHA1 fingerprint without colons>' "$HOME/Library/Keychains/login.keychain-db"
```

Stop the owned API process. Retain private files only as needed for verifier cleanup, then remove only
the positively owned temporary fixture directory. No global Docker pruning or shared-stack teardown.

## Remaining joins and limitations

- J1 owns actual stack startup, browser user seeding, grants and HTTPS host/container routing. This job
  defines the environment interface and host command; it does not recreate Wave 5 or default composition.
- Keycloak image pull/import/DCR, ARM64 manifest, browser consent and real clients are unexecuted here.
- This Keycloak release is an immutable local fixture pin, not a claim that it is the latest release or
  approved for production. Digest/architecture and vulnerability review remain verifier duties.
- Zenith is still a resource server; no embedded authorization server, refresh flow or privileged auth fallback.
- Legacy durable streams still require the executing instance to survive; a dead instance needs a repeat
  call with the same idempotency key. Modern streams do not have resumable event IDs.
- Add the three new test files to the appropriate bounded MCP gate cohort at integration. Installer,
  gate-manifest and public LIMITATIONS/PROGRESS updates remain orchestrator-owned.
- `docs/platform/CLIENT-INTEROP.md` has historical claims that the official dependency was not installed
  and had a 1.x-shaped API. The assigned script now points here; the orchestrator should reconcile that
  unowned documentation with this current packet.
- No existing production test expectation was changed. The two new assertion corrections (step IDs and distinct-client cleanup) are justified in the local receipt above.
- Suggested commit: `feat(agent): add official MCP interop and local OAuth issuer fixture`.


## Wave 6 final integration

Status remains `implementation_complete_verification_pending`. Node 22 only. Execute sequentially with Docker Desktop 4 GiB and one kind node; stop each heavy profile before starting another. Live acceptance stays deferred until separate owner approval.

```bash
node scripts/ci/wave6-gates.mjs --requirement PROD-UX-02 --print > /tmp/zenith-wave6-PROD-UX-02.commands.json
```

This prints the exact argv for each contract batch and required engine case, its gate names, private prerequisites, and its strict report-validation command. Set only the gates for the selected lane after preparing its owned fixture; a skip cannot satisfy that lane. Run each `argv` sequentially and then its `verify` argv. [Final integration setup and results](FINAL-INTEGRATION.md), [canonical inventory](../../../../scripts/ci/wave6-gates.json), [owner live runbook](../LIVE-ACCEPTANCE.md).
