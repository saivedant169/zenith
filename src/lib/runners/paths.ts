/**
 * Which URL paths authenticate by agent signature instead of a browser session.
 *
 * `src/middleware.ts` runs the Supabase cookie gate on every `/api/*` request
 * and answers 401 "Sign in to use the API" to anything without a session. Agents
 * have no session — their per-request Ed25519 signature is the authentication
 * (`request-auth.ts`) — so the middleware must let exactly these paths through
 * and no others. The admin routes (`…/runners/tokens`, `…/{id}/revoke`, the
 * list routes) are NOT in this set: they need a signed-in admin.
 *
 * The orchestrator wires this into the middleware bypass (see the WS-RUNSRV
 * handoff; `src/middleware.ts` is outside this workstream's paths).
 */
// an id segment; never `.` or `..` (the URL parser resolves those, but the pattern should not rely on it)
const SEGMENT = String.raw`(?!\.{1,2}(?:/|$))[A-Za-z0-9_.:-]{1,128}`;
const COLLECTION = "(?:runners|machines)";

const AGENT_SIGNED_PATHS: readonly RegExp[] = [
  new RegExp(`^/api/platform/v1/${COLLECTION}/register$`),
  new RegExp(`^/api/platform/v1/${COLLECTION}/${SEGMENT}/(?:poll|heartbeat)$`),
  new RegExp(`^/api/platform/v1/${COLLECTION}/${SEGMENT}/jobs/${SEGMENT}/(?:result|logs|grant)$`),
];

export function isAgentSignedPath(pathname: string): boolean {
  return AGENT_SIGNED_PATHS.some((re) => re.test(pathname));
}
