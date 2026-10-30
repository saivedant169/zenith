/**
 * The Phase-2 collections — the organisational slice — as registry adapters.
 *
 * Importing this module registers them; `postgres-store.ts` does that once, at
 * import. Nothing else here is exported, and a Phase-3 agent adding a
 * collection writes its own sibling file rather than editing this one. See the
 * header of `./registry.ts` for the how-to.
 */
import type {
  CloudConnection,
  Environment,
  Invite,
  Member,
  Project,
  Workspace,
} from "@/lib/domain/types";
import type { Database } from "../types";
import {
  INSTALL_SETTINGS_ID,
  hydrateWith,
  iso,
  type PgRow,
  type PrefetchContext,
  type PrefetchQuery,
  registerCollection,
  storeError,
  tenantOf,
  type TenantContext,
} from "./registry";

/** Filtered by workspace id for a real caller; unfiltered for a script. */
const byWorkspace = (ctx: PrefetchContext): PrefetchQuery =>
  ctx.user ? { kind: "in", column: "workspace_id", values: ctx.workspaceIds } : { kind: "all" };

/**
 * The tenant answer for every table that carries `workspace_id`: the column
 * during a load, the object's own field during a diff, and the non-enumerable
 * fallback the load stamped on for the objects that have no field.
 */
const ownWorkspace = (row: { workspaceId?: string }, ctx: TenantContext): string =>
  String(ctx.row?.workspace_id ?? row.workspaceId ?? tenantOf(row));

/**
 * A member row is found by id **or** by lower(email): an invite names an address
 * and the id only exists once that person signs in, so matching on id alone
 * would refuse the very first request of every invited user.
 */
async function memberRowsFor(ctx: PrefetchContext): Promise<PgRow[]> {
  const user = ctx.user as { id: string; email: string };
  const email = (user.email ?? "").toLowerCase();
  // The anonymous caller (request.ts prefetch) is nobody: no membership to look up.
  if (!user.id && !email) return [];
  const { data, error } = await ctx.client
    .from("members")
    .select("*")
    .or(`id.eq.${JSON.stringify(user.id)},email_normalized.eq.${JSON.stringify(email)}`);
  if (error) throw storeError("members", "read", error.message);
  const mine = ((data ?? []) as PgRow[]).filter(
    (r) => r.id === user.id || String(r.email ?? "").toLowerCase() === email
  );
  const workspaceIds = [...new Set(mine.map((r) => String(r.workspace_id)))];
  if (!workspaceIds.length) return [];
  // Discover membership before loading peers. A member list must contain the
  // whole authorized workspace, while an invitation grants no tenant reads.
  const peers = await ctx.client.from("members").select("*").in("workspace_id", workspaceIds);
  if (peers.error) throw storeError("members", "read", peers.error.message);
  return ((peers.data ?? []) as PgRow[]).filter((r) => workspaceIds.includes(String(r.workspace_id)));
}

/* ---------------------------------------------------------------------------
 * Registration order is foreign-key order: writes run down this list, deletes
 * run back up it.
 * ------------------------------------------------------------------------- */

registerCollection<Workspace>({
  collection: "workspaces",
  table: "workspaces",
  key: (r) => ({ id: r.id }),
  tenant: (w) => w.id,
  promote: (w) => ({ slug: w.slug, name: w.name, owner_id: w.ownerId ?? null, created_at: iso(w.createdAt) }),
  rename: { slug: "slug", name: "name", owner_id: "ownerId", created_at: "createdAt" },
  hydrate: hydrateWith<Workspace>({ slug: "slug", name: "name", owner_id: "ownerId", created_at: "createdAt" }),
  prefetch: {
    round: 2,
    filter: (ctx) =>
      ctx.user ? { kind: "in", column: "id", values: ctx.workspaceIds } : { kind: "all" },
  },
  rows: (db: Database) => db.workspaces as unknown as { id: string }[],
});

// Round 1: members answer "which workspaces is this caller in", and that answer
// is the filter every other table uses.
registerCollection<Member>({
  collection: "members",
  table: "members",
  key: (r) => ({ workspace_id: r.workspaceId, id: r.id }),
  tenant: ownWorkspace,
  promote: (m) => ({ email: m.email ?? "", role: m.role }),
  rename: { workspace_id: "workspaceId", email: "email", role: "role" },
  hydrate: hydrateWith<Member>({ workspace_id: "workspaceId", email: "email", role: "role" }),
  prefetch: {
    round: 1,
    filter: (ctx) => (ctx.user ? { kind: "custom", run: () => memberRowsFor(ctx) } : { kind: "all" }),
    provides: (rows, ctx) => {
      ctx.workspaceIds = [...new Set(rows.map((r) => String(r.workspace_id)))];
    },
  },
  rows: (db: Database) => db.members as unknown as { id: string }[],
  scopedByWorkspace: true,
});

/**
 * Invites are the one collection with no home in `Database`: they live in the
 * install-global settings bag (src/lib/server/membership.ts). They are their own
 * table because they are looked up by address on the sign-in path, and they are
 * projected back into the bag so no caller changes.
 */
const inviteRename = {
  workspace_id: "workspaceId",
  email: "email",
  role: "role",
  accepted_at: "acceptedAt",
  created_at: "createdAt",
  expires_at: "expiresAt",
  revoked_at: "revokedAt",
};

registerCollection<Invite>({
  collection: "invites",
  table: "invites",
  key: (r) => ({ id: r.id }),
  tenant: ownWorkspace,
  promote: (i) => ({
    email: i.email.trim().toLowerCase(),
    role: i.role,
    accepted_at: iso(i.acceptedAt),
    created_at: iso(i.createdAt),
    expires_at: iso(i.expiresAt),
    revoked_at: iso(i.revokedAt),
  }),
  rename: inviteRename,
  hydrate: hydrateWith<Invite>(inviteRename),
  prefetch: { round: 2, filter: byWorkspace },
  rows: (db: Database) =>
    Array.isArray(db.settings.invites) ? (db.settings.invites as unknown as { id: string }[]) : [],
});

const connectionRename = {
  workspace_id: "workspaceId",
  provider: "provider",
  status: "status",
  created_at: "createdAt",
};

registerCollection<CloudConnection>({
  collection: "connections",
  table: "connections",
  key: (r) => ({ id: r.id }),
  tenant: ownWorkspace,
  promote: (c) => ({ provider: c.provider, status: c.status, created_at: iso(c.createdAt) }),
  rename: connectionRename,
  hydrate: hydrateWith<CloudConnection>(connectionRename),
  prefetch: { round: 2, filter: byWorkspace },
  rows: (db: Database) => db.connections as unknown as { id: string }[],
});

const projectRename = {
  workspace_id: "workspaceId",
  slug: "slug",
  name: "name",
  created_at: "createdAt",
};

registerCollection<Project>({
  collection: "projects",
  table: "projects",
  key: (r) => ({ id: r.id }),
  tenant: ownWorkspace,
  promote: (p) => ({ slug: p.slug, name: p.name, created_at: iso(p.createdAt) }),
  rename: projectRename,
  hydrate: hydrateWith<Project>(projectRename),
  prefetch: {
    round: 2,
    filter: byWorkspace,
    provides: (rows, ctx) => {
      ctx.projectIds = rows.map((r) => String(r.id));
    },
  },
  rows: (db: Database) => db.projects as unknown as { id: string }[],
});

const environmentRename = {
  project_id: "projectId",
  class: "class",
  connection_id: "connectionId",
  deployed_revision_id: "deployedRevisionId",
  active_deployment_id: "activeDeploymentId",
  created_at: "createdAt",
};

// Round 3: environments hang off projects, not off the workspace directly.
registerCollection<Environment>({
  collection: "environments",
  table: "environments",
  key: (r) => ({ id: r.id }),
  tenant: (e, ctx) => {
    const own = ctx.row?.workspace_id ?? (e as { workspaceId?: string }).workspaceId;
    if (own) return String(own);
    const project = ctx.db?.projects.find((p) => p.id === e.projectId);
    return project ? project.workspaceId : tenantOf(e);
  },
  promote: (e) => ({
    project_id: e.projectId,
    class: e.class,
    connection_id: e.connectionId ?? null,
    deployed_revision_id: e.deployedRevisionId ?? null,
    active_deployment_id: e.activeDeploymentId ?? null,
    created_at: iso(e.createdAt),
  }),
  rename: environmentRename,
  hydrate: hydrateWith<Environment>(environmentRename),
  prefetch: {
    round: 3,
    filter: (ctx) =>
      ctx.user ? { kind: "in", column: "project_id", values: ctx.projectIds } : { kind: "all" },
  },
  rows: (db: Database) => db.environments as unknown as { id: string }[],
});

/**
 * The install-global settings bag. Registered so its read lives with every
 * other read, but it carries no `rows`: it is one upserted row, not a
 * collection, and `writeSettings()` in the store owns its write.
 */
registerCollection({
  collection: "settings",
  table: "settings",
  key: () => ({ workspace_id: INSTALL_SETTINGS_ID }),
  tenant: () => INSTALL_SETTINGS_ID,
  promote: () => ({}),
  rename: {},
  hydrate: (row) => ({ ...(row.data ?? {}) }) as { id: string },
  prefetch: {
    round: 3,
    filter: () => ({ kind: "in", column: "workspace_id", values: [INSTALL_SETTINGS_ID] }),
  },
});
