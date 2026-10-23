# Reference plugin sandbox

The main executable is `npx --no-install tsx src/cli/bin.ts plugin ...` and
dispatches install, run, list and revoke. Use `plugin --help` for arguments.
Install validates the signed manifest and hands off to `/platform/plugins`
for registration and exact-digest trust review (exit 3, like connection creation).
List uses a linked credential. Run/revoke use only the dedicated child on stdin.
The standalone `src/cli/plugins/bin.ts` calls the same implementation.

Browser consent issues children at `POST /api/integrations/plugins/launch/tokens`
with registrationId, manifestDigest, the member's own credentialId, explicit
projectIds/environmentIds and minutes (1 to 1440). Registration, review and
issuance call `assertPrivilegedConsent`: the verified live browser session must
have a verified AAL2 claim bound to the same subject/session. The MFA job supplies
enrolment/challenge UI; missing proof refuses. Withdrawal remains available.
`POST /api/integrations/plugins/launch/check` resolves the token hash through
the existing plugin-grant store and rechecks the approved signed manifest, live
parent, membership and target ownership. MCP v3 preserves this plugin binding;
other agent/REST authorities cannot accept the child. No migration is needed.
Existing plugin/grant browser revocation and RFC `/api/agent/oauth/revoke` revoke
the child server-side. The supervisor and gateway observe that refusal and stop
the sandbox. Parent withdrawal invalidates the child through its live authority.

The launcher requires a local signed manifest, its human-reviewed canonical
digest, trusted publisher keys, a local Node22 Linux image by immutable digest,
and a freshly issued dedicated scoped `za_` child token through stdin. Only the
gateway container receives that token; the plugin process never does, and the
gateway refuses plugin-supplied credentials. It does not read saved login
credentials or `ZENITH_TOKEN`. Artifact download uses the
signed HTTPS URL without authentication or redirects, is capped at 16 MiB,
and must match the signed SHA-256 before container creation. There is no image
pull, host extraction, host command supplied by the manifest, or unsigned mode.

The plugin container has no IP network, runs as uid/gid 65532, has a read-only
root filesystem, drops all capabilities, sets no-new-privileges, and has bounded
CPU, memory, processes and scratch storage. A public-payload host scratch bind
is read-only. A private 1 MiB tmpfs Docker volume supplies a Unix socket; it is
read-only in the plugin. No Docker socket, parent directory, home, credential
store or platform store is mounted. Each of two containers has 128 MiB memory,
no swap, 0.25 CPU and 32 processes; `/work` is a 64 MiB tmpfs charged against
the memory limit. Large packages can exceed the memory limit and are refused
by the runtime; these limits are deliberately fixed.

Only the trusted gateway has IP networking. It forwards JSON MCP v3 calls to
one configured HTTPS origin, owns upstream authorization, permits only the
live lease's tools and targets, filters discovery, refuses incoming bearers,
cookies, other routes, batches, arbitrary RPC and redirects. It checks live
authority before each request and every second. Request bodies, responses,
concurrency and request durations are bounded. The Node22 fetch adapter lets
plugins use `fetch(ZENITH_URL + '/api/agent/v3/mcp', ...)` through that socket.
Other transports need explicit socket support; there is no networking fallback.

Only one signed stdio server is supported per launch: command `node`, first
argument `${CLAUDE_PLUGIN_ROOT}/path/to/module.mjs` or `.js`, optional plain args,
and optional `ZENITH_API_VERSION=3`. Packages must be gzip ustar archives with
at most 256 regular files/directories and 64 MiB expanded size. Links, PAX/GNU
extensions, devices, traversal, duplicate paths and archive modes are refused.
Put the entry at the archive root or use its exact signed relative path. No
installation scripts run. The plugin receives only the dedicated child token
and public configuration. Plugin stdout/stderr are suppressed; this reference
command supervises lifetime and exit status, and does not provide a host stdio
MCP bridge or claim Claude Code/Codex interoperability.

The host rechecks authority every second, with a 3-second request timeout.
Revocation, expiry, review/lease changes, gateway failure, authority outages and
cancellation cause forced removal of both containers and then the owned volume.
Forced container removal kills all descendants, including TERM-resistant ones.
Dispatch already accepted by Zenith is not undone by killing the plugin.
Cleanup failures are errors and retain host scratch; operators should remove
only the positively owned `zenith.plugin.launch` resources after repair.

`POST /api/integrations/plugins/launch/check` is an explicit integration seam.
It is absent in the base worktree. Until the integrator supplies authoritative
review plus dedicated `za_` child issuance/revocation, the executable refuses
with `launch_authority_unavailable` before fetching or creating resources.
An ordinary linked `za_` token cannot self-assert this authority, and existing
plugin `zp_` issuance is not a fallback. See the contract, Mac verification
commands and known joins in `docs/build/production/verify/PROD-UX-03.md`.

Runtime flags follow the [Docker container reference](https://docs.docker.com/reference/cli/docker/container/run/)
and the [none network driver](https://docs.docker.com/engine/network/drivers/none/).
