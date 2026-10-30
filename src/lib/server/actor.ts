/**
 * Who is calling, and what they may do in the workspace they are calling into.
 *
 * One demo session = one local user ("You"); the Navigator identifies itself
 * with `navigatorHeaders()` — the actor header plus a process-local key — and
 * is then bound by the workspace autonomy level. The Navigator's in-process
 * path (lib/navigator/run.ts) never goes through HTTP at all, so nothing
 * outside this server can claim its name.
 *
 * `resolveRequest` lives here too: it is the identity half of what `route()`
 * settles before a handler runs, and `route()` reaches it by dynamic import so
 * this directory keeps a one-way import graph.
 *
 * Split out of `server/context.ts`, which re-exports everything here.
 */
import type { NextRequest } from "next/server";
import type { Role } from "@/lib/actions/core";
import { db } from "@/lib/db/store";
import type { Actor } from "@/lib/domain/types";
import { roleReaches } from "@/lib/domain/roles";
import { membershipPolicy } from "@/lib/auth/policy";
import { sessionUserFromRequest } from "@/lib/supabase/route";
import { ApiError } from "@/lib/server/errors";
import { ensureMember, type MemberDenial } from "@/lib/server/membership";
import { currentRequest, type RequestState, type RouteGrant } from "@/lib/server/request";
import { WORKSPACE_COOKIE, pickWorkspace, requireWorkspace } from "@/lib/server/workspace";

export const demoActor = (): Actor => ({ type: "user", id: "local", name: "You" });

export const navigatorActor = (): Actor => ({
  type: "navigator",
  id: "navigator",
  name: "Navigator",
});

/**
 * Navigator attribution has to be earned, not asserted: the audit log is
 * evidence, so a browser must not be able to sign its actions "Navigator".
 * The Navigator's own server-side calls carry a secret minted at boot and
 * never leaving this process; anything else is just the user.
 */
type GK = typeof globalThis & { __zenithNavKey?: string };

const navigatorKey = (): string => {
  const g = globalThis as GK;
  return (g.__zenithNavKey ??= crypto.randomUUID());
};

/** Headers the Navigator's own HTTP calls must send to be attributed to it. */
export const navigatorHeaders = (): Record<string, string> => ({
  "x-zenith-actor": "navigator",
  "x-zenith-actor-key": navigatorKey(),
});

export const isNavigator = (req: NextRequest): boolean =>
  req.headers.get("x-zenith-actor") === "navigator" &&
  req.headers.get("x-zenith-actor-key") === navigatorKey();

/**
 * Identity-aware actor: a proven Navigator call wins; otherwise the signed-in
 * Supabase user when auth is configured (verified via getClaims); otherwise
 * the local demo user. Inside `route()` the answer was already computed once
 * for the request, so the actor and the resolved workspace can never disagree.
 */
export async function resolveActor(req: NextRequest): Promise<Actor> {
  if (isNavigator(req)) return navigatorActor();
  const state = currentRequest();
  if (state) {
    if (!state.user) return demoActor();
    if (state.member) return { type: "user", id: state.member.id, name: state.member.name };
    if (state.denial)
      throw new ApiError(state.denial.message, 403, { fix: state.denial.fix });
  }
  const user = state?.user ?? (await sessionUserFromRequest(req));
  if (!user) return demoActor();
  const outcome = ensureMember(user);
  if ("denied" in outcome)
    throw new ApiError(outcome.denied.message, 403, { fix: outcome.denied.fix });
  return { type: "user", id: outcome.member.id, name: outcome.member.name };
}

/**
 * The actor's role **in the resolved workspace**.
 *
 * `roleOf` (actions/core) finds a member row by id across every workspace, so
 * for a user who belongs to two it answers with whichever sorted first. Every
 * membership decision here is about one workspace, so it asks this instead.
 */
export function workspaceRole(actor: Actor): Role {
  const here = db().members.filter((m) => m.workspaceId === requireWorkspace().id);
  const mine = here.find((m) => m.id === actor.id);
  if (mine) return mine.role;
  // Demo mode ("local") has nobody to defer to, and a brand-new workspace has
  // nobody to defer to only where the policy says an empty one is a seat.
  return actor.id === "local" || (here.length === 0 && membershipPolicy().emptyWorkspaceGrantsAdmin)
    ? "admin"
    : "viewer";
}

/**
 * The refusal a demanded workspace role reads as.
 *
 * `admin` is the sentence `requireAdmin` has always thrown: every admin-gated
 * route on this surface manages members. The others are the same refusal
 * written for a role that is not about members.
 */
const roleRefusal = (role: Role, min: Role): ApiError =>
  min === "admin"
    ? new ApiError(
        `Managing members needs the admin role and you are ${role} in ${requireWorkspace().name}.`,
        403,
        { fix: "Ask a workspace admin to make this change, or to give you the admin role." }
      )
    : new ApiError(
        `This needs the ${min} role and you are ${role} in ${requireWorkspace().name}.`,
        403,
        { fix: "Ask a workspace admin to raise your role in Settings → Members, or have them do this." }
      );

/**
 * The caller and their role, refused if the role is below `min`.
 *
 * This is what `route({ workspaceRole })` resolves before the handler runs, so
 * a route states the permission it needs instead of opening with two lines
 * that derive it.
 */
export async function routeGrant(req: NextRequest, min: Role): Promise<RouteGrant> {
  const actor = await resolveActor(req);
  const role = workspaceRole(actor);
  if (!roleReaches(role, min)) throw roleRefusal(role, min);
  return { actor, role };
}

/** Every caller of a route that mutates membership passes through here. */
export async function requireAdmin(req: NextRequest): Promise<Actor> {
  const { actor } = await routeGrant(req, "admin");
  return actor;
}

/**
 * Who is calling and which workspace they are in — worked out once, before the
 * handler runs, so `requireWorkspace()` stays a synchronous zero-argument call
 * at every one of its call sites and cannot answer differently twice in a
 * request. `ensureMember` runs first because signing in is where a user joins:
 * resolving memberships before that would 404 the invited user's first visit.
 */
export async function resolveRequest(req: NextRequest): Promise<RequestState> {
  const cookie = req.cookies.get(WORKSPACE_COOKIE)?.value;
  // The Navigator's own HTTP calls carry no session — they are trusted because
  // the key never leaves this process — and act where the browser is.
  if (isNavigator(req)) {
    const all = db().workspaces;
    return { user: null, workspace: all.find((w) => w.id === cookie) ?? all[0] };
  }
  const user = await sessionUserFromRequest(req);
  let denial: MemberDenial | undefined;
  if (user) {
    const outcome = ensureMember(user);
    if ("denied" in outcome) denial = outcome.denied;
  }
  const workspace = pickWorkspace(cookie, user);
  const member =
    user && workspace
      ? db().members.find((m) => m.workspaceId === workspace.id && m.id === user.id)
      : undefined;
  return { user, workspace, member, denial };
}
