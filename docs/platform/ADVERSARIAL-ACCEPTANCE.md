# Adversarial security acceptance: threat model and test map (PROD-OPS-08)

This document maps each threat class to the independent tests in `tests/adversarial/`, states the attacker model and
the invariant each test pins, and lists what is deliberately not covered. It complements
[THREAT-MODEL.md](./THREAT-MODEL.md), which prioritises findings from the earlier WS-SEC harness.

Independence rules the suite follows:

- Tests drive public interfaces only (route handlers, the capability broker, exported verifiers and validators). They
  do not import private helpers that could share a bug with the code under test.
- The oracle is never the guard's own table. The SSRF oracle is a `node:net` `BlockList` built from IANA registries;
  the approval and grant attacks verify through the exported grant verifier; archive attacks are built with the shared
  tar writer and patched headers.
- Cases are generated from inventories (route files, the capability catalog, repository exports, every leaf of a signed
  manifest, an address corpus times every encoding wrapper), so a new route, capability, repository function or
  outbound path is attacked, or fails an inventory test, without anyone remembering to add it.
- Setup helpers (the two-workspace capability harness, the two-tenant product fixture, the plugin signing helpers) are
  shared test support and are not part of what is asserted.

Nothing here is live-cloud acceptance. No test calls a real provider, DNS server or GitHub.

## Threat classes

| Class | Attacker model | Test file | What is pinned |
| --- | --- | --- | --- |
| Cross-tenant read and write | A signed-in admin of workspace B who knows real ids of workspace A | `cross-tenant.test.ts` | Every product route with a path id refuses every id of another tenant (never 2xx), leaks no canary, and answers like a nonexistent id (no existence oracle). Unauthenticated callers get nothing. Foreign admin cannot change A's members or invites. Every platform REST route and method is classified by the edge access table, and approvals, settings, grants and restores are browser-only. Reflective sweep: every repository function with a `(sql, workspaceId, ...)` signature, called as B with A's ids, returns nothing of A and leaves A's operation unchanged. |
| Role and scope escalation | Viewer, editor, read-only or environment-scoped agent credential, foreign admin, Navigator, system principal | `role-escalation.test.ts` | Admin-only broker operations (workspace policy, autonomy 5, standing grants) refuse every non-admin and every non-human actor and change nothing. Generated over the capability catalog: a viewer, a read-only credential or a scoped credential never gets any mutating capability allowed or queued; nobody proposes into a workspace they are not in; cancel and reads are tenant-bound. Both stores. |
| Stale, forged and replayed approvals, forged grants, semantics digests | Requester, agent, Navigator, foreign member, anyone holding a captured grant | `approvals-forgery.test.ts` | No non-human principal can approve, reject or revoke (matrix of eleven actor kinds); mutated digests never approve; an approval is single use and not transferable; lapsed, expired, tightened-policy and demoted-approver approvals do not execute. Grant verifier refuses payload tampering, `alg: none`, HS256 with the public key as secret, attacker signatures, embedded `jwk`, `crit`/`x5u`, wrong audience, wrong operation or capability, and skewed time. Semantics digest: every covered component changes the digest and is named by the diff; altered stored documents are refused. |
| SSRF, address-encoding smuggling, DNS rebinding | Tenant who controls a connection secret, alert URL, DNS record or probe host | `ssrf-rebinding.test.ts` | Every spelling of an internal destination (mapped, compatible, translated, NAT64, local NAT64, 6to4, zone ids, obfuscated URL hosts) is refused by the portability connect guard, the alert webhook guard and the probe classifier; metadata and transition ranges stay refused even under the private-range opt-in and the development acknowledgement. Mixed answers refuse. A validated address is returned as a literal and a flipped later answer is refused. Static outbound inventory fails on any unreviewed network primitive and checks that tenant-influenced paths name a guard. |
| Prompt injection into authority | Repository, package, plugin-in-repo, free-text reason, model output | `prompt-injection.test.ts` | For every corpus payload, honest and obedient agents keep the same tool set and system prompt, produce at most one deterministic proposal whose digest matches its manifest, never expose payload text in the artifact, and every tool result is fenced. Analysis output is unchanged by prose. Generated over the capability catalog: a payload in the reason is never more permissive than a routine reason; claims of pre-approval change nothing; authority-shaped request members are never honoured. |
| Malicious archives and bundles | Tenant or repository author supplying bytes that are unpacked | `malicious-archives.test.ts` | Hosted source upload, GitHub build bundle, analysis snapshot, Azure context re-pack, backup container and export artifact names are driven with zip-slip, absolute and drive paths, backslashes, NUL, symlinks, hard links, devices, FIFOs, long-link and pax tricks, case and Unicode collisions, file-directory conflicts, decompression bombs, entry floods, deep and long paths, truncated, checksum-corrupt and size-lying archives, duplicate names, unterminated and trailing-garbage archives. Download coordinates and redirects cannot leave the GitHub allowlist. |
| Token forgery and audience confusion | Holder of one token kind who wants another kind, resource, workspace or lifetime | `token-forgery.test.ts` | Mutation operators over `za_`, `zp_` and the cron bearer: no near-miss is accepted. OAuth: audience confusion between the v2 and v3 resources, wrong issuer, foreign key, `none`/HS256, tampered payload, unbounded lifetime, reserved subjects. Plugin tokens die with their parent credential, are audience-bound, and cannot be issued across tenants or to another subject. Runner request signing keeps its own deep suites (`tests/runners/signing`, `request-auth`, `protocol-window`). |
| Build-to-deploy credential exfiltration | Author of a Dockerfile, build script, dependency or OpenTofu configuration | `build-exfiltration.test.ts` | The child environment is built from scratch (no host secret reaches it), only the brokered session is a credential, cross-provider and loader-changing variables are refused in both positions, runner-owned variables win. Provider build admission refuses each single weakening (deploy credentials, shared identity, open egress, writable source, oversize resources, wrong profile, unknown provider including prototype keys). The recipe container has no network, read-only root and source, no environment, no privileged flags and never builds a shell string. Context directories and timeouts are bounded. |
| Compromised integration | Attacker who can POST to the webhook, a hostile GitHub endpoint, a tampered plugin manifest, attacker-influenced alert text | `integration-compromise.test.ts` | GitHub App webhook: near-miss signatures, edited and reformatted bodies, other App ids, non-lifecycle events, additions and creations, malformed ids, duplicate and aliased keys, oversize and hostile headers authenticate to nothing and never open the database (POSIX hosts). GitHub download: redirects off the allowlist, token confinement to codeload, loops, coordinate injection, size caps. Plugins: every single-field change to a signed manifest is refused, impossible capability claims are refused even when signed by a trusted key. Alerts: Slack control sequences are escaped, the signed webhook body is exactly what is signed. |

## Findings fixed during this work

See the findings table in [verify/PROD-OPS-08.md](../build/production/verify/PROD-OPS-08.md).

## Residual risks closed in the follow-up

Fixed and tested in `residual-hardening.test.ts` (findings F9-F13 in the verify doc): hosted launch state bound to a browser nonce cookie; platform REST bearer limited to a linked `za_` credential on the configured host with the authority-kind rule; runner dispatch honours grant revocation; hosted source tar requires a proper terminator and refuses trailing data; GitHub App private key custody checks (POSIX uid/mode/link checks; Windows reuses the native owner-only ACL verification); a grant revoked after enqueue is withdrawn at poll.

## Residual risks addressed 2026-10-26

Changed in code and covered by regression tests (`tests/ops/admission.test.ts`, `tests/runners/grant-recall.test.ts`). Not independently verified: no verification run is recorded for these changes in this document.

- Dispatch admission fails closed. When the platform store is configured and the tenant quota or the active-operation count cannot be read, `assertDispatchAdmitted` refuses with `admission_unavailable` (503, a fixed message, the cause only in the operator log) and claims nothing. Success path and unconfigured installs are unchanged.
- Recall of a grant revoked after receipt. The control plane refuses an agent's next control-plane step, the result submission, when the job's grant is revoked, expired or unknown in the authoritative grant store (`grant_not_active`, 403). `consumed` (the grant's own one-time use) is allowed. The agent's local work already started is not stopped: recall is enforced at the control plane, not on the agent host, and the Go agent is unchanged.

## Residual risk and non-goals

Recorded as observed but not fixed:

- `CredentialBroker.withSession` trusts decoded in-process claims; the Go agent's workspace check is vacuous when its own workspace id is empty. A grant revoked after the agent received its job is refused at the agent's next result (see above), but not stopped on the agent host.
- `CRON_SECRET` has no minimum strength; `/api/internal/*` is public at the edge and relies on every route calling the gate.
- Hosted source tar reader: quadratic directory handling, lossy UTF-8 decoding, GNU magic accepted as ustar, lenient base64 in `decodeTarball`.
- The Navigator translation prompt interpolates manifest names unescaped; the coding agent proposes as the creating human principal with the agent identity only in the free-text reason.
- The semantics digest is verified in the broker, not in the approval store; dispatch re-checks it against the write-once approved row.
- Runner request signing does not include the agent kind in the signed string (bound by registry lookup only).

Not covered: live cloud, live DNS, a real GitHub, real OAuth issuers, timing side channels beyond use of constant-time comparison, denial of service beyond the size and count bounds named above, and the Go runner's own archive reader (its Go tests own that).
