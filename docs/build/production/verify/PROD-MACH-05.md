# PROD-MACH-05 Local customer credential custody: verification notes

Built only; nothing here has been executed except `tsc --noEmit`, `eslint` on the changed TS files, and `go build` / `go vet` for `go/`. No migration (version 27 was not needed): the runner credential mode travels in the existing registration `labels` column.

## 1. Audit (how credentials and results flow today)

- Runner-mode connections (`config.mode === "runner"`) keep credentials on the customer host. The control plane never holds them: `aws.http` jobs are SigV4-signed by the Go runner with its own identity (`go/internal/awsauth`: static env, web identity, container, IMDS), `tofu.run` copies only an allowlist of the runner's own environment into the tofu child (`go/internal/runner/kinds/tofu.go` `buildEnv`), `oci.http` jobs are unsigned REST payloads. Vault rewrap (`src/lib/secrets/*rewrap*`) only moves control-plane-stored secret values between KMS keys; runner connections explicitly refuse secret delivery (`src/lib/execution/secrets.ts`, `src/lib/platform/secret-grants.ts`).
- Federated (OIDC) connections are brokered by the control-plane worker (`src/lib/credentials/aws/broker.ts`, `src/lib/platform/credentials.ts`): short-lived credentials in worker memory only.
- Gaps found and closed here: (a) nothing declared whether a runner used local or Zenith-federated identity, so nothing could refuse a mismatch; (b) the runner-job enqueue path checked the runner's status but never re-proved the connection binding (a revoked connection held in memory could still dispatch); (c) `createConnectionsPort.resolve` could fall from a revoked connection to other connections extending the same product connection; (d) four different model-visible redactors with inconsistent markers, none reporting what they changed.

## 2. What was built

TypeScript
- `src/lib/security/result-sanitizer.ts` (new): single structured sanitizer for model-visible values. Value rules (PEM private keys, JWT, cloud key ids and session tokens, vendor tokens, bearer/basic, URL passwords, `name = value`), member-name rules (suffix match: `password`, `accessToken`, `clientSecret`, ...; `tokenCount`, `nextToken`, `secretRef`, `hasPassword` are not secrets), exact known-secret removal, bounded work that fails closed (`[REDACTED:unscanned]`). Markers are `[REDACTED:<kind>]`. The report always says `completeness: "best_effort"`; `redactionNote` and `SANITIZER_NOTE` state that unrecognised shapes can remain.
- `src/lib/runners/custody.ts` (new): `zenith.credentialMode` label, `local_only` / `federated`, `checkRunnerBinding` / `assertRunnerBinding`, `sanitizeInboundResult`.
- `src/lib/runners/dispatch.ts`: `EnqueueRunnerJobInput.bindingConnectionId`; the binding is re-read via `rt.connections` on every enqueue; new `DispatchError` codes `binding_revoked`, `binding_unavailable`, `custody_mismatch`; payloads carrying credential shapes are refused before signing.
- `src/lib/runners/runtime.ts`: `RunnerRuntime.connections` (fresh `repos.connections.get`, never cached).
- Callers now set the binding: `src/lib/runners/aws-runner-transport.ts` (broker `open({connection})`), `src/lib/platform/credentials.ts` (OCI mutating and read jobs), `src/lib/runners/read-jobs.ts`, `src/lib/runners/tofu-runner-dispatch.ts` (`RunnerTofuTarget.connectionId`). Tofu has no in-repo production caller yet; it carries the field for the first one.
- `src/lib/credentials/types.ts`: optional `runnerCustody` on runner-capable connection configs (default `local_only`).
- `src/lib/runners/service.ts`: result from a `local_only` runner with a high-confidence credential shape is sealed sanitized (logical digest stays over what the runner sent); the completion event records only `custody.kinds`.
- `src/lib/execution/platform.ts`: a revoked connection never resolves and never falls through to another connection.
- Model-visible paths now sanitized: MCP v3 envelopes and errors (`src/lib/agent-access/v3/redaction.ts`, `envelope.ts`: a note is added when anything was replaced), MCP v2 control results (`src/lib/agent-access/control/http.ts`, adds `structuredContent.sanitization` only when something was replaced), the read-only reader (`src/lib/agent-access/zenith-reader.ts`), runner log lines and error strings (`src/lib/runners/redact.ts`). Machine (zenithd) results reach models only through the v3 envelope, so they are covered there.

Go (`go/`)
- `internal/runner/custody.go` (new), `config.go` (`credentialMode`, default `local_only`, advertised as the registration label), `executor.go`: a `local_only` runner refuses to start if its `AWS_WEB_IDENTITY_TOKEN_FILE` JWT is issued by the Zenith control plane; every job payload with credential shapes is rejected (`invalid_payload`); every result is checked and a `local_only` runner withholds a result body that contains a known local secret value (env and active credential source) or a high-confidence credential shape, replacing it with an explicit `credential_material_detected` marker and keeping the job status; error strings are redacted in every mode.
- `internal/redact/redact.go`: `Shapes` (kind names only). `internal/runner/kinds/awshttp.go`: `LocalSecretValues`.
- Not touched: runner self-update and result spool code (MACH-04).

## 3. Acceptance mapping

| Clause | Implementation | Tests |
| --- | --- | --- |
| Supported runner modes keep credentials local | Explicit modes (Go config, label, `custody.ts`); local runner refuses Zenith-issued identity, rejects credential-bearing payloads, withholds credential-bearing results; control plane refuses mode mismatches and sanitizes inbound results | `go/internal/runner/custody_test.go`; `tests/runners/custody.test.ts` (mode, mismatch, payload, inbound) |
| Revoked bindings cannot trigger privileged fallback | Binding re-read at enqueue (`bindingConnectionId`), refusal is a `DispatchError`; `connections.resolve` does not fall through after revocation; OCI/AWS/read/tofu callers all set the binding | `tests/runners/custody.test.ts` (revoked, revoked between jobs, lookup failure, wrong runner, queues nothing); existing `tests/execution/platform.test.ts` "never when revoked" |
| Model-visible results contain no secrets | `sanitizeForModel` on v3, v2, reader and runner logs; explicit markers; best-effort statement | `tests/security/result-sanitizer.test.ts` (including envelope integration) |

## 4. Verification commands (other machine)

```
npx vitest run tests/security/result-sanitizer.test.ts tests/runners/custody.test.ts
npx vitest run tests/runners tests/agent-v3 tests/agent-control* tests/security tests/execution/platform.test.ts
node scripts/test-agent-reader.mjs
cd go && GOTOOLCHAIN=local go test ./internal/runner/... ./internal/redact/... ./internal/agent/...
```
Expected: all pass. Things most likely to need a look:
- Existing Go runner tests that assert exact registration labels, or send a payload containing a key-id-shaped string, now see the `zenith.credentialMode` label / an `invalid_payload` rejection.
- Existing MCP v3 tests that expected `[redacted]` from the old scrubber now see `[REDACTED:<kind>]` (canary assertions are unaffected). Tests under `tests/agent-v3/*` and `tests/security/mcp-secret-leakage.test.ts` should be run.
- `tests/runners/aws-transport.test.ts` / `tests/runners/oci-*.test.ts` call the transport without a connection lookup; the transport only checks a binding when a `connectionId` is passed, and the default `createPlane` lookup returns null (so a binding-checked job from a test that sets `connectionId` must stub `connections`).

## 5. Known gaps and shared-file updates

- No new tables or store functions; nothing for the migrations inventory, `tenancy.test.ts` or the gate manifest. `docs/build/production/verify` is the only new doc.
- Federated mode is a declaration plus enforcement of mismatch and a startup check; the control plane does not itself mint a token file for a runner. `federated` runners can only serve connections that set `runnerCustody: "federated"`.
- A runner that registered before this change carries no label and is treated as `local_only` (it has only ever used local identity).
- The runner's result withholding uses high-confidence shapes and exact local secret values it can list (env, active AWS provider cache); a secret from another source in an unrecognised shape is not detected. Redaction anywhere is best-effort and says so.
- Inbound control-plane sanitization of a federated runner's results is left to the model-visible layer, because rewriting stored plan JSON would change plan digests.
- The in-product Navigator sends only the user goal and node names to a model (no tool results), so it needed no sanitizer wiring. MCP v1 `agent-access/security.ts redact` was left unchanged on purpose (it is compiled standalone by `scripts/test-agent-reader.mjs` without path aliases and is measured by `tests/security/redaction-coverage.test.ts`); the reader's results are sanitized in `zenith-reader.ts` instead.
- Shared files the orchestrator updates: LIMITATIONS (best-effort redaction; federated mode scope), PROGRESS, ledger.

## 6. Suggested ledger implementationStatus

`implemented_unverified: runner credential modes (local_only/federated) with dispatch binding re-proof and custody mismatch refusal, local runner payload/result custody guard, shared best-effort model-visible sanitizer on MCP v3/v2/reader/runner logs; tests written, not run`


## Wave 6 final integration

Status remains `implementation_complete_verification_pending`. Node 22 only. Execute sequentially with Docker Desktop 4 GiB and one kind node; stop each heavy profile before starting another. Live acceptance stays deferred until separate owner approval.

```bash
node scripts/ci/wave6-gates.mjs --requirement PROD-MACH-05 --print > /tmp/zenith-wave6-PROD-MACH-05.commands.json
```

This prints the exact argv for each contract batch and required engine case, its gate names, private prerequisites, and its strict report-validation command. Set only the gates for the selected lane after preparing its owned fixture; a skip cannot satisfy that lane. Run each `argv` sequentially and then its `verify` argv. [Final integration setup and results](FINAL-INTEGRATION.md), [canonical inventory](../../../../scripts/ci/wave6-gates.json), [owner live runbook](../LIVE-ACCEPTANCE.md).

## Owner scope decision, 2026-10-23

- Verify with the existing AWS customer-side runner first (`aws.http`, `go/internal/awsauth`), then the required OCI
  runner (`oci.http`). Both need the owner-confirmed sandboxes in `docs/build/production/permissions.json`.
- No Kubernetes runner transport is built to close this requirement. Kubernetes runner mode stays **unsupported and
  deferred** for deployment and credential custody: `createKubernetesSession` refuses runner mode
  (`src/lib/providers/kubernetes/session.ts:206`), the credential broker denies non-OCI runner sessions
  (`src/lib/platform/credentials.ts:485`), and the connection form says the Kubernetes transport is unavailable and that
  a readiness pass does not enable it (`connection-admin.tsx`). The read-only `k8s.http` GET proxy used by the J2
  journey is a separate, existing read path and is not evidence for this requirement.
- If promised runner coverage beyond AWS and OCI remains unmet, that portion of PROD-MACH-05 stays open.
