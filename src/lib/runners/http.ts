/**
 * HTTP glue for the agent-facing routes (`/api/platform/v1/{runners|machines}/…`).
 *
 * These routes do NOT use `route()`: their caller is an agent, not a signed-in
 * user, so there is no session, workspace cookie, waitlist or product snapshot
 * to resolve. Authentication is the agent's per-request Ed25519 signature
 * (`request-auth.ts`). The session middleware must let these paths through
 * (`isAgentSignedPath` in `paths.ts`); the admin routes (token creation, revoke,
 * list) stay behind the session and `route({ workspaceRole })`.
 *
 * Errors are `{ error: { code, message, … } }` — the shape the Go client's
 * `errorFields` reads. Only `code` is load-bearing on the agent side
 * (`agent_revoked` stops it; `409 already_settled` ends a result retry).
 */
import { log } from "@/lib/log";
import { assertPathAgent, authenticateAgentRequest, parseJsonBody, readBodyBytes } from "@/lib/runners/request-auth";
import { RunnerStoreError, type AgentRecord } from "@/lib/runners/ports";
import { getRunnerRuntime, type RunnerRuntime } from "@/lib/runners/runtime";
import {
  AgentApiError,
  MAX_LOG_BODY_BYTES,
  MAX_RESULT_BODY_BYTES,
  MAX_SMALL_BODY_BYTES,
  type AgentKind,
} from "@/lib/runners/types";
import { appendAgentLogs, checkGrantLive, heartbeatAgent, pollAgent, registerAgent, settleResult } from "@/lib/runners/service";

const NO_STORE = { "cache-control": "no-store" };

export const agentJson = (data: unknown, status = 200): Response => Response.json(data, { status, headers: NO_STORE });

export function agentError(error: unknown): Response {
  if (error instanceof AgentApiError) return agentJson({ error: { code: error.code, message: error.message, ...error.extra } }, error.status);
  if (error instanceof RunnerStoreError) {
    const status = error.code === "not_found" ? 404 : error.code === "conflict" ? 409 : 400;
    return agentJson({ error: { code: error.code, message: error.message } }, status);
  }
  log.error("unhandled error in an agent route", { scope: "runners", error });
  return agentJson({ error: { code: "internal_error", message: "The control plane hit an unexpected error; retry with backoff." } }, 500);
}

type Ctx = { params: Promise<Record<string, string>> };
type Handler = (req: Request, ctx: Ctx) => Promise<Response>;

interface SignedCall {
  req: Request;
  rt: RunnerRuntime;
  agent: AgentRecord;
  body: Uint8Array;
  params: Record<string, string>;
}

function signedRoute(kind: AgentKind, maxBodyBytes: number, handle: (c: SignedCall) => Promise<unknown>): Handler {
  return async (req, ctx) => {
    try {
      const rt = await getRunnerRuntime();
      const params = await ctx.params;
      const auth = await authenticateAgentRequest(req, kind, { store: rt.store, now: rt.now }, { maxBodyBytes });
      assertPathAgent(auth.agent, params.id);
      return agentJson(await handle({ req, rt, agent: auth.agent, body: auth.body, params }));
    } catch (error) {
      return agentError(error);
    }
  };
}

/** `POST …/register` — token-authenticated, unsigned (the agent has no identity yet). */
export function registerHandler(kind: AgentKind): Handler {
  return async (req) => {
    try {
      const rt = await getRunnerRuntime();
      const body = parseJsonBody(await readBodyBytes(req, MAX_SMALL_BODY_BYTES));
      return agentJson(await registerAgent(rt, kind, body), 201);
    } catch (error) {
      return agentError(error);
    }
  };
}

export const pollHandler = (kind: AgentKind): Handler => signedRoute(kind, MAX_SMALL_BODY_BYTES, ({ rt, agent, body, req }) => pollAgent(rt, agent, parseJsonBody(body), req.signal));

export const heartbeatHandler = (kind: AgentKind): Handler => signedRoute(kind, MAX_SMALL_BODY_BYTES, ({ rt, agent, body }) => heartbeatAgent(rt, agent, parseJsonBody(body)));

export const resultHandler = (kind: AgentKind): Handler => signedRoute(kind, MAX_RESULT_BODY_BYTES, ({ rt, agent, body, params }) => settleResult(rt, agent, params.jti, parseJsonBody(body)));

export const logsHandler = (kind: AgentKind): Handler => signedRoute(kind, MAX_LOG_BODY_BYTES, ({ rt, agent, body, params }) => appendAgentLogs(rt, agent, params.jti, parseJsonBody(body)));

export const grantHandler = (kind: AgentKind): Handler => signedRoute(kind, MAX_SMALL_BODY_BYTES, ({ rt, agent, params }) => checkGrantLive(rt, agent, params.jti));
