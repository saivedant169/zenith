/**
 * Workspace creation — the one mutation that happens before any membership
 * exists, so it cannot be an action (`workspace.create` would have nobody to
 * role-check). Creates the workspace, a healthy sandbox connection and the
 * caller's admin seat in one atomic step, then selects it.
 * Integrator-owned exception inside api/ (see docs/OWNERSHIP.md).
 */
import { z } from "zod";
import { db, save } from "@/lib/db/store";
import { id, type Member } from "@/lib/domain/types";
import { workspaceSlug } from "@/lib/domain/workspace-slug";
import {
  ApiError,
  WORKSPACE_COOKIE,
  currentRequest,
  json,
  route,
} from "@/lib/server/context";
import { isSupabaseConfigured } from "@/lib/supabase/env";

export const dynamic = "force-dynamic";

const Body = z.object({ name: z.string().trim().min(1).max(60) });

export const POST = route(async (req) => {
  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success)
    throw new ApiError("Workspace needs a name.", 400, { fix: "Send { name: string } (1–60 chars)." });
  const data = db();

  // Demo mode has one local user who is admin of everything, so a second
  // workspace has no membership to separate it from the first — it would only
  // be a second name for the same permissions. Say that rather than pretend.
  if (!isSupabaseConfigured() && data.workspaces.length > 0)
    throw new ApiError(`A workspace already exists ("${data.workspaces[0].name}").`, 409, {
      fix: "Zenith in demo mode runs one workspace. Open the existing workspace, or configure Supabase auth (NEXT_PUBLIC_SUPABASE_URL + key) for real identities and multiple workspaces.",
    });

  const name = parsed.data.name;
  const workspaceId = id();
  const slug = workspaceSlug(name, workspaceId, isSupabaseConfigured());

  const user = currentRequest()?.user;
  const workspace = { id: workspaceId, name, slug, ownerId: user?.id, createdAt: new Date().toISOString() };
  data.workspaces.push(workspace);

  // The creator owns what they created. With no signed-in user (demo mode's
  // first workspace) no member is seeded: a placeholder "you@local" admin is a
  // seat nobody can sign in as, and it demoted every real user to editor
  // forever. The first real user to sign in becomes admin (ensureMember).
  if (user) {
    const member: Member = {
      id: user.id,
      workspaceId: workspace.id,
      name: user.name,
      email: user.email,
      role: "admin",
    };
    data.members.push(member);
  }

  data.connections.push({
    id: id(),
    workspaceId: workspace.id,
    provider: "sandbox",
    label: "Zenith Sandbox",
    region: "local-1",
    status: "healthy",
    grantedPermissions: [
      "Provision simulated services and resources",
      "Read simulated logs, health, and cost estimates",
      "No access to any real cloud account",
    ],
    createdAt: new Date().toISOString(),
    lastCheckedAt: new Date().toISOString(),
  });
  save();

  // Creating a workspace is how you enter it; the browser should not have to
  // make a second call to end up somewhere it did not ask to be.
  const res = json({ workspace }, 201);
  res.cookies.set(WORKSPACE_COOKIE, workspace.id, {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    maxAge: 365 * 24 * 60 * 60,
    secure: process.env.NODE_ENV === "production",
  });
  return res;
});
