/**
 * The request scope: what `route()` works out once, and where it keeps it.
 *
 * `RequestState` is resolved before the handler runs and read back by every
 * helper in this directory through `currentRequest()`, so `requireWorkspace()`
 * stays a synchronous zero-argument call that cannot answer differently twice
 * in one request.
 *
 * The resolution itself lives in `server/actor.ts` and is reached through a
 * dynamic import: that module reads this one's request scope, and importing it
 * back statically would be the only import cycle in `src/lib/server`.
 *
 * Split out of `server/context.ts`, which re-exports everything here.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import type { NextRequest } from "next/server";
import type { Role } from "@/lib/actions/core";
import type { Actor, Member, Workspace } from "@/lib/domain/types";
import type { SessionUser } from "@/lib/auth/session";
import { withRequestId } from "@/lib/log";
import { ApiError, errorResponse, json } from "@/lib/server/errors";
import type { MemberDenial } from "@/lib/server/membership";
import { redactCredentials } from "@/lib/credentials/redact";

export interface RequestState {
  /** signed-in user, or null in demo mode / signed out */
  user: SessionUser | null;
  /** the workspace this request acts in */
  workspace?: Workspace;
  /** the caller's member row *in that workspace* */
  member?: Member;
  /** why the caller holds no membership, when that is why there is no workspace */
  denial?: MemberDenial;
  /**
   * This request's view of the Postgres store, loaded **before** the handler
   * runs (`ZENITH_STORE=postgres` only; undefined on the file store).
   *
   * `Store.db()` is synchronous and ~113 files depend on that, so the round
   * trip cannot happen inside a handler — it happens here, once, and the
   * handler then reads and mutates a graph that is already in memory. One
   * snapshot per request is also what keeps two concurrent requests from
   * sharing one mutable object.
   *
   * Typed loosely on purpose: naming `Snapshot` here would make every module
   * that imports the request scope import the Postgres store as well.
   */
  snapshot?: unknown;
}

/** Resolved once per request by `route()`; every helper in this directory reads it. */
const requestState = new AsyncLocalStorage<RequestState>();

/** What `route()` worked out about this request, if we are inside one. */
export const currentRequest = (): RequestState | undefined => requestState.getStore();

type RouteCtx<P> = { params: Promise<P> };

/** Methods that are allowed to have changed nothing, so never need the flush. */
const READ_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * Close the store's 50ms coalescing window before this request is answered,
 * on serverless only.
 *
 * `save()` defers the snapshot write behind an unref'd timer, which is exactly
 * right for a long-lived process: a burst of mutations costs one write and the
 * exit hook covers shutdown. A serverless instance has neither property — it
 * can be frozen the instant the response leaves, and then the timer fires on
 * the next request, or on no request at all. So a mutating route there waits
 * for the write, and "commit before ACK" means the same thing on both hosts.
 *
 * One place, so every mutating route is covered without remembering to. Local
 * `next dev` is untouched: `isServerless()` is false and nothing is awaited.
 *
 * This is also the request's commit point for the action runner's replay
 * window: `route()` promotes the request's idempotent outcomes only after this
 * resolves, and a rejection here leaves none of them behind.
 */
async function flushMutation(req: NextRequest): Promise<void> {
  if (READ_METHODS.has(req.method.toUpperCase())) return;
  const { flushPendingAsync, isPostgres } = await import("@/lib/db/store");
  // Postgres flushes on every host, not only serverless. A deferred network
  // write is not a coalescing window: the very next request can land on another
  // instance and read the row before this one's write arrives, which has
  // nothing to do with freezing. So the write-through is unconditional there.
  if (isPostgres()) {
    await flushPendingAsync();
    return;
  }
  const { isServerless } = await import("@/lib/serverless");
  if (!isServerless()) return;
  await flushPendingAsync();
}

/**
 * Load this request's store snapshot before the handler runs.
 *
 * Only on Postgres, and only once per request. The prefetch is the caller's
 * workspace slice in three rounds — members (by id **or** lower(email), which
 * is how an invited user is found before they have ever signed in), then the
 * workspaces those rows name, then everything keyed by those workspace ids —
 * plus the install-global settings row and the change-feed versions. Handlers
 * then read entirely from memory.
 */
async function prefetch(req: NextRequest, integration?: IntegrationRequestAccess): Promise<unknown> {
  const { isPostgres } = await import("@/lib/db/store");
  if (!isPostgres()) return undefined;
  // The session is read here rather than taken from `resolveRequest`, because
  // that function is itself a `db()` reader: membership, the workspace cookie
  // and the member row all come out of the snapshot this call is loading. The
  // JWT read is local (no round trip), so asking twice costs nothing.
  const { sessionUserFromRequest } = await import("@/lib/supabase/route");
  // A bearer request reads only its verified subject's memberships. Never
  // turn a missing browser cookie into loadSnapshot(null), which loads ALL
  // tenants for scripts. The empty email cannot accept an invitation.
  const user = integration
    ? { id: integration.subject, email: "" }
    : await sessionUserFromRequest(req).catch(() => null);
  // With auth configured, a caller with no session can reach no workspace (workspacesFor(null) is empty), so it
  // loads nobody's rows rather than every tenant's: an anonymous request must not cost a full-store read (PROD-OPS-01
  // capacity). Only the auth-off demo and the in-process Navigator act without a session over the whole store.
  let nobody = false;
  if (!user) {
    const { isSupabaseConfigured } = await import("@/lib/supabase/env");
    const { isNavigator } = await import("@/lib/server/actor");
    nobody = isSupabaseConfigured() && !isNavigator(req);
  }
  const { loadSnapshot, pgClient } = await import("@/lib/db/postgres-store");
  return loadSnapshot(pgClient(), user ? { id: user.id, email: user.email } : nobody ? { id: "", email: "" } : null);
}

/** The permission a route needs, stated once instead of re-typed per handler. */
export interface IntegrationRequestAccess {
  /** Verified credential subject, never taken from a caller-supplied header. */
  subject: string;
}

export interface RouteOptions {
  /** Transport-specific error body, including refusals before the handler. */
  errorResponse?: (error: unknown) => Response | undefined;
  /**
   * Optional transport authentication, before admission/boot/tenant reads.
   * Return a verified integration subject to bypass browser admission, a
   * refusal Response to stop, or undefined to preserve session admission.
   * Only principal-aware handlers may use this; workspaceRole stays human-only.
   */
  integrationAccess?: (req: NextRequest) => Promise<IntegrationRequestAccess | Response | undefined>;
  /**
   * Refuse a caller whose role in the resolved workspace is below this, before
   * the handler runs — the same refusal `requireAdmin`/`workspaceRole` threw
   * when each route spelled the check out itself.
   */
  workspaceRole?: Role;
}

export { safeRequestError } from "@/lib/server/errors";

/** What the options above settled, handed to the handler rather than re-derived. */
export interface RouteGrant {
  /** the caller, resolved once for this request */
  actor: Actor;
  /** their role in the resolved workspace */
  role: Role;
}

type PlainHandler<P> = (req: NextRequest, params: P) => Promise<unknown>;
type GrantHandler<P> = (req: NextRequest, params: P, grant: RouteGrant) => Promise<unknown>;

/**
 * Boots the process, resolves the caller and their workspace, awaits Next 15's
 * async `params`, JSON-encodes the return value (a returned `Response` — e.g.
 * SSE — passes through) and maps thrown errors to `{ error: { message, fix? } }`.
 *
 * With an options object first, the permission the handler needs is a
 * parameter rather than its first two lines: `route({ workspaceRole: "admin" },
 * handler)` resolves the actor, refuses anybody below that role, and passes the
 * actor and role in.
 */
export function route<P extends Record<string, string> = Record<string, string>>(
  handler: PlainHandler<P>
): (req: NextRequest, ctx: RouteCtx<P>) => Promise<Response>;
export function route<P extends Record<string, string> = Record<string, string>>(
  options: RouteOptions,
  handler: GrantHandler<P>
): (req: NextRequest, ctx: RouteCtx<P>) => Promise<Response>;
export function route<P extends Record<string, string> = Record<string, string>>(
  optionsOrHandler: RouteOptions | PlainHandler<P>,
  maybeHandler?: GrantHandler<P>
) {
  const options: RouteOptions = typeof optionsOrHandler === "function" ? {} : optionsOrHandler;
  const handler = (
    typeof optionsOrHandler === "function" ? optionsOrHandler : maybeHandler
  ) as GrantHandler<P>;

  return async (req: NextRequest, ctx: RouteCtx<P>): Promise<Response> => {
    // One id per request, carried through every log line it produces and
    // handed back to the caller on a 500 so a report can be matched to a log.
    const suppliedId = req.headers.get("x-request-id");
    const requestId = suppliedId && /^[A-Za-z0-9_-]{1,64}$/.test(suppliedId) && redactCredentials(suppliedId) === suppliedId
      ? suppliedId : crypto.randomUUID().slice(0, 8);
    return withRequestId(requestId, async () => {
      // PROD-OPS-02: admission (maintenance, in-flight ceiling) and the request's trace span. A refusal
      // is a BackpressureError that errorResponse() answers as 429/503 + Retry-After.
      let scope: import("@/lib/ops/admission").RequestScope | undefined;
      try {
        scope = await (await import("@/lib/ops/admission")).beginRequest({ method: req.method, pathname: req.nextUrl.pathname, headers: req.headers, requestId });
        // Inside the request scope so a transport that resolves the workspace (bearer credential) can apply its quota.
        const access = await scope.run(async () => options.integrationAccess?.(req));
        if (access instanceof Response) {
          access.headers.set("x-request-id", requestId);
          scope.finish(access.status);
          return access;
        }
        if (access && options.workspaceRole) throw new ApiError("This route requires a browser session.", 403);
        // Session admission still precedes workspace reads and invitation joins.
        // A transport may skip it only AFTER verifying an integration credential.
        if (!access) {
          const { requireProductRequestAccess } = await import("@/lib/waitlist/enforcement");
          await requireProductRequestAccess(req);
        }
        // Server-rendered reads also use context helpers. Only API handling
        // needs to load/resume the action and provider runtime.
        const { ensureBoot } = await import("@/lib/server/boot");
        await ensureBoot();
        // BEFORE the actor is resolved, and therefore before the handler: on
        // Postgres, `resolveRequest` is itself a store read.
        const snapshot = await prefetch(req, access);
        const { runWithSnapshot } = await import("@/lib/db/request-snapshot");
        const { withActionOutcomes } = await import("@/lib/actions/core");
        const out = await runWithSnapshot(snapshot, async () =>
          // The commit scope spans the handler AND the flush, because the
          // action runner may only retain an idempotent outcome once this
          // request's durable write has landed — see `retainOutcome` in
          // `actions/core.ts`. A throw anywhere below abandons those outcomes,
          // so a retry re-runs the action instead of replaying a mutation that
          // was never committed.
          withActionOutcomes(async (outcomes) => {
            const { resolveRequest, routeGrant } = await import("@/lib/server/actor");
            // Integration principals are resolved by their transport, never by
            // browser membership helpers (which can accept invitations).
            const state: RequestState = { ...(access ? { user: null } : await resolveRequest(req)), snapshot };
            // The workspace is known now: apply its rate and concurrency quota (throws BackpressureError).
            await scope!.bindWorkspace(state.workspace?.id);
            const result = await requestState.run(state, async () => {
              const params = ctx?.params ? await ctx.params : ({} as P);
              // A route that demands nothing must not resolve an actor: the
              // invitation routes answer callers `resolveActor()` would refuse.
              const grant = options.workspaceRole
                ? await routeGrant(req, options.workspaceRole)
                : (undefined as unknown as RouteGrant);
              return scope!.run(async () => {
                await (await import("@/lib/auth/mfa-routes")).guardPrivilegedRoute(req, options.workspaceRole === "admin", !!access);
                return handler(req, params, grant);
              });
            });
            // Inside the snapshot scope, deliberately: the flush writes *this*
            // request's snapshot, and outside it would find the process-global one.
            await flushMutation(req);
            outcomes.commit();
            return result;
          })
        );
        const res = out instanceof Response ? out : json(out);
        res.headers.set("x-request-id", requestId);
        res.headers.set("traceparent", scope.traceparent);
        scope.finish(res.status);
        return res;
      } catch (err) {
        const res = options.errorResponse?.(err) ?? errorResponse(err);
        res.headers.set("x-request-id", requestId);
        if (scope) { res.headers.set("traceparent", scope.traceparent); scope.finish(res.status, err); }
        return res;
      }
    });
  };
}

/**
 * Integer query parameter, clamped. A forgotten clamp is an unbounded
 * response, so the bounds live here: default 0..1000, callers narrow them.
 *
 * Takes a request or a bare `URL`, because some handlers have already parsed
 * the one out of the other and there is no second rule for those.
 */
export const intParam = (
  from: NextRequest | URL,
  key: string,
  fallback: number,
  bounds: { min?: number; max?: number } = {}
): number => {
  const min = bounds.min ?? 0;
  const max = bounds.max ?? 1000;
  const params = from instanceof URL ? from.searchParams : from.nextUrl.searchParams;
  const raw = params.get(key);
  const n = raw === null ? NaN : Math.trunc(Number(raw));
  const value = Number.isFinite(n) ? n : fallback;
  return Math.min(max, Math.max(min, value));
};
