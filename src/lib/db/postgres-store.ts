/**
 * The Postgres-backed `Store`: Supabase (PostgREST) under the same synchronous
 * façade every caller already uses.
 *
 * ## Why it can be synchronous at all
 *
 * `Store` is a synchronous interface (see `./types.ts` — the "sync now, async
 * later" note) and ~113 files depend on that. A network round trip cannot be
 * made synchronous, so this implementation does not try: it reads a
 * **snapshot** that was loaded *before* the caller ran, hands the caller a
 * live mutable graph exactly as the file store does — its **own** graph, one
 * per load, never the process-global one the file store owns — and writes the
 * diff back on `flush`. The load happens in one of two places:
 *
 *  - **per request** — `route()` (src/lib/server/request.ts) prefetches the
 *    caller's workspace slice into `RequestState.snapshot` before the handler
 *    runs, so one request sees one consistent view;
 *  - **per process** — a script, a seed, a test, a cron pass or a server
 *    component primes one *explicitly* (`primeProcessSnapshot()`,
 *    `inCronScope()`, `runInStoreScope()`), and it is then found on
 *    `globalThis` by any `db()` with no request scope.
 *
 * There is no third way in. A `db()` that finds neither **throws** — see
 * `processSnapshot()`. It used to hand back an empty snapshot over
 * `FileStore.db()`, which meant an unprimed reader (a server component, a
 * worker) silently answered out of a different authority, with no error and
 * no row: an empty activity list rather than a fault.
 *
 * ## Writes: row-level optimistic concurrency
 *
 * Every table carries `version bigint`. A flush compares the snapshot against
 * the baseline captured at load, writes only the rows that actually changed,
 * and guards each update with `.eq("version", loadedVersion)`. Zero rows
 * updated means somebody else moved that row first, and that is a **409**, not
 * a silent overwrite — the last-writer-wins alternative is how two admins
 * editing a member list quietly lose one of the edits.
 *
 * ## Change feed
 *
 * `onChange` cannot be an in-process EventEmitter once more than one instance
 * serves the app. Each flush bumps `workspace_versions` for the workspaces it
 * touched and records which projects moved; `onChange` polls that one narrow
 * table at the SSE tick (300 ms), at most once per window per workspace, and
 * only while a listener is attached.
 *
 * ## What Postgres is the authority for
 *
 * All of `Database`, and this file holds none of that knowledge itself: every
 * collection is an adapter in `./pg/registry.ts`, and everything here iterates
 * the registry.
 *
 *     ./pg/core.ts     workspaces · members · invites · connections
 *                      projects · environments · settings · workspace_versions
 *     ./pg/history.ts  revisions · revision_manifests · deployments
 *                      deployment_events
 *     ./pg/audit.ts    audit_events (and the secrets backend)
 *     ./pg/alerts.ts   findings · navigator runs · alert rules/events/outbox
 *
 * `./pg/all.ts` imports the four in foreign-key order. The method groups that
 * are not part of the row graph — manifests, deployment events, audit — arrive
 * through `./pg/delegates.ts`, and those four modules replace them with
 * `setDelegate("audit", …)` without touching this file. So on
 * `ZENITH_STORE=postgres` the file store is **not** a fallback authority for
 * any collection, and it does not hold this store's graph either: a snapshot
 * is built over its own `emptyGraph()`, so two requests in one process cannot
 * see each other's rows. The `FileStore` calls left in this module are
 * `reset()`'s — the empty graph a seed or a test starts from, which no request
 * path reaches — and `onChange`'s, which keeps the in-process emitter as a
 * second *notification* source (never as durability) so a listener still hears
 * a `reset()` or a seed.
 *
 * What is *not* closed, and is tracked rather than hidden: a flush is a
 * sequence of PostgREST requests, so this store does not claim cross-table
 * atomicity (see `./pg/audit.ts` and docs/ARCHITECTURE.md, ADR 1).
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { AuditEvent, DeploymentEvent, AnyManifest } from "@/lib/domain/types";
import { createAdminClient, isDefaultAdminClientFor } from "@/lib/supabase/admin";
import { FileStore } from "./file-store";
import "./pg/all"; // registers every collection and delegate group, in FK order
import { delegates } from "./pg/delegates";
import {
  adapterFor,
  adapters,
  INSTALL_SETTINGS_ID,
  keyScope,
  type CollectionAdapter,
  type PgCollection,
  type PgRow as Row,
  type PrefetchContext,
  rowAdapters,
  runPrefetch,
  setTenant,
  storeError,
  tenantOf,
} from "./pg/registry";
import { requestSnapshot } from "./request-snapshot";
import type {
  AuditCountResult,
  AuditFilter,
  AuditPage,
  Database,
  Store,
  StoreChange,
} from "./types";

/* ------------------------------- the client ------------------------------- */

type GClient = typeof globalThis & { __zenithPgClient?: SupabaseClient };

/**
 * One service-role client per process. `createAdminClient()` already builds
 * exactly the right thing (service-role key, no session persistence, no token
 * refresh) and already owns the "you forgot the keys" error, so this reuses it
 * rather than restating either.
 */
export function pgClient(): SupabaseClient {
  const g = globalThis as GClient;
  if (g.__zenithPgClient) return g.__zenithPgClient;
  // Built on first use, never at import: the file store is the default and must
  // keep booting on an install with no Supabase configuration at all.
  return (g.__zenithPgClient = createAdminClient() as unknown as SupabaseClient);
}

/** Read-only ownership of the actual cached default product client; no override or identity getter. */
export function isDefaultProductClientFor(origin: string): boolean {
  return isDefaultAdminClientFor(pgClient(), origin);
}

/** Test seam: drop the cached client so a mock can take its place. */
export function resetPgClient(client?: SupabaseClient): void {
  (globalThis as GClient).__zenithPgClient = client;
}

/* ------------------------------ the row shape ------------------------------ */

/**
 * Every per-collection fact — table, promoted columns, key, tenant, hydration
 * and prefetch round — now lives in `./pg/registry.ts`, registered by
 * `./pg/core.ts`. This file iterates that registry and knows nothing about any
 * particular table. Re-exported here because the migration script and the
 * contract tests import them from the store.
 */
export { INSTALL_SETTINGS_ID, tenantOf };
export type { PgCollection };

/* -------------------------------- snapshots -------------------------------- */

interface Baseline {
  version: number;
  /** canonical JSON at load, so the flush writes only what actually moved */
  json: string;
}

export interface Snapshot {
  data: Database;
  /** `collection:id` → what the database held when this snapshot loaded */
  baseline: Map<string, Baseline>;
  /** collections a `save()` has touched since the last flush */
  dirty: Set<PgCollection | "settings">;
  /** the workspaces this snapshot is authoritative for (deletes are scoped here) */
  scope: Set<string>;
  /** `workspace_versions.version` at load, so a bump does not need a re-read */
  feed: Map<string, number>;
  /** version of the install-global settings row at load */
  settingsVersion: number;
  /** projects named by `save(projectId)` since the last flush */
  touched: { ids: Set<string>; all: boolean };
  /** true once `save()` has scheduled a write nobody has flushed yet */
  scheduled: boolean;
}

const canonical = (row: unknown): string => JSON.stringify(row);

const bkey = (collection: string, id: string, workspaceId = ""): string =>
  `${collection}:${workspaceId}:${id}`;

const emptySnapshot = (data: Database): Snapshot => ({
  data,
  baseline: new Map(),
  dirty: new Set(),
  scope: new Set(),
  feed: new Map(),
  settingsVersion: 0,
  touched: { ids: new Set(), all: false },
  scheduled: false,
});

/**
 * An empty `Database`, and a **new one every call**.
 *
 * Declared here rather than borrowed from `FileStore` because the whole point
 * is that it is *not* the file store's graph: `FileStore.db()` is one object
 * per process (see that file's header), and a snapshot built over it would be
 * shared by every other snapshot in the same process — see `loadSnapshot`.
 * Typed as `Database` so a new collection cannot be forgotten silently.
 */
const emptyGraph = (): Database => ({
  workspaces: [],
  members: [],
  connections: [],
  projects: [],
  environments: [],
  revisions: [],
  deployments: [],
  findings: [],
  navigatorRuns: [],
  alertRules: [],
  alertEvents: [],
  alertOutbox: [],
  settings: { invites: [] },
});

/* --------------------------------- loading -------------------------------- */

async function selectRows(
  client: SupabaseClient,
  table: string,
  filter?: { column: string; values: string[] }
): Promise<Row[]> {
  let query = client.from(table).select("*");
  if (filter) {
    if (filter.values.length === 0) return [];
    query = query.in(filter.column, filter.values);
  }
  const { data, error } = await query;
  if (error) throw storeError(table, "read", error.message);
  return (data ?? []) as Row[];
}

/**
 * Load one workspace slice.
 *
 * Order is the point, and the registry declares it: round 1 answers "which
 * workspaces is this caller in" (by id **or** by the email an invite named
 * before they first signed in — the same rule `workspacesFor` applies), round 2
 * fetches everything keyed by those ids, round 3 everything keyed by what round
 * 2 loaded. `null` for `user` loads everything, which is what a script, a
 * migration or a test wants.
 *
 * **Every load gets its own graph.** This used to build the snapshot over
 * `FileStore.db()` — one object per process — while `adopt()` below truncates
 * and refills the very arrays it is handed. Two requests served concurrently
 * by one Node process therefore shared one graph: request A awaited anything,
 * request B's prefetch emptied the arrays and refilled them with B's tenant's
 * rows, and A resumed reading them. That is a cross-tenant read, and a
 * cross-tenant *write* too, because `diff()` compares `snap.data` — by then
 * B's rows — against A's `baseline` and turns the mismatch into inserts and
 * deletes. `emptyGraph()` is one allocation per load and the isolation is
 * structural: no snapshot can reach another's objects.
 */
export async function loadSnapshot(
  client: SupabaseClient,
  user: { id: string; email: string } | null
): Promise<Snapshot> {
  const base = emptyGraph();
  const snap = emptySnapshot(base);

  const ctx: PrefetchContext = { client, user, workspaceIds: [], projectIds: [] };
  const rows = new Map<PgCollection, Row[]>();
  for (const round of [1, 2, 3] as const) {
    const group = adapters().filter((a) => a.prefetch.round === round);
    const results = await Promise.all(group.map((a) => runPrefetch(a, ctx)));
    group.forEach((a, i) => {
      rows.set(a.collection, results[i]);
      // Rounds feed each other: members hand on the workspace ids, projects the
      // project ids. Nothing else in this loop knows a collection by name.
      a.prefetch.provides?.(results[i], ctx);
    });
  }

  const feedRows = await selectRows(
    client,
    "workspace_versions",
    user ? { column: "workspace_id", values: ctx.workspaceIds } : undefined
  );

  // Settings first: `invites` live inside the bag (see the invites adapter), so
  // the array they are adopted into has to exist before the adopt loop runs.
  const settingsRow = (rows.get("settings") ?? [])[0];
  snap.settingsVersion = Number(settingsRow?.version ?? 0);
  const settings = { ...((settingsRow?.data ?? {}) as Record<string, unknown>) };
  settings.invites = [];
  base.settings = settings;
  snap.baseline.set(
    bkey("settings", INSTALL_SETTINGS_ID),
    { version: snap.settingsVersion, json: canonical(withoutInvites(settings)) }
  );

  for (const adapter of rowAdapters())
    adopt(snap, adapter, rows.get(adapter.collection) ?? [], adapter.rows!(base));

  for (const id of ctx.workspaceIds) snap.scope.add(id);
  for (const r of rows.get("workspaces") ?? []) snap.scope.add(String(r.id));
  for (const r of feedRows) snap.feed.set(String(r.workspace_id), Number(r.version ?? 0));

  return snap;
}

const withoutInvites = (settings: Record<string, unknown>): Record<string, unknown> => {
  const { invites: _invites, ...rest } = settings;
  return rest;
};

/** Hydrate rows into the live array the callers mutate, and record the baseline. */
function adopt(
  snap: Snapshot,
  adapter: CollectionAdapter<never>,
  rows: Row[],
  target: { id: string }[]
): void {
  target.length = 0;
  for (const row of rows) {
    const obj = adapter.hydrate(row) as { id: string };
    const workspaceId = adapter.tenant(obj as never, { row });
    setTenant(obj, workspaceId);
    target.push(obj);
    snap.baseline.set(bkey(adapter.collection, obj.id, keyScope(adapter.collection, workspaceId)), {
      version: Number(row.version ?? 1),
      json: canonical(obj),
    });
  }
}

/* ------------------------------- the snapshot ------------------------------ */

type GSnap = typeof globalThis & { __zenithPgSnapshot?: Snapshot };

/**
 * What an unprimed read says, and how to stop saying it.
 *
 * Exported so a test can assert the refusal by identity rather than by
 * matching prose that is allowed to improve.
 */
export const UNPRIMED_SNAPSHOT_ERROR =
  "The Postgres product store was read with no snapshot in scope, so there is nothing to read: " +
  "`db()` is synchronous and cannot load one, and answering from the file store would serve a " +
  "different authority's rows as if they were this store's. " +
  "Fix: run the read inside `route()` (src/lib/server/request.ts, which prefetches the caller's " +
  "slice), `inCronScope()` (src/lib/server/cron.ts), or `runInStoreScope()` (src/lib/db/store.ts) " +
  "for a server component — or await `primeProcessSnapshot()` first, which is what the scripts, " +
  "the seed and the contract tests do.";

/** The process-global snapshot if one was primed, without demanding it. */
const primedSnapshot = (): Snapshot | undefined => (globalThis as GSnap).__zenithPgSnapshot;

/**
 * The snapshot a caller with no request scope gets: the one somebody primed.
 *
 * An unprimed read is a **fault, not a fallback**. Returning
 * `emptySnapshot(FileStore.db())` here — which is what this did — meant a
 * server component or a worker outside `route()` read a different authority
 * and could not tell: no error, no rows, and once a cron pass had primed an
 * unfiltered snapshot, every workspace on the install instead. Scripts, the
 * seed, the cron scope and the contract tests all prime explicitly already, so
 * the refusal costs them nothing.
 */
function processSnapshot(): Snapshot {
  const snap = primedSnapshot();
  if (snap) return snap;
  throw new Error(UNPRIMED_SNAPSHOT_ERROR);
}

/** Load the process-global snapshot from Postgres. Awaited by scripts and tests. */
export async function primeProcessSnapshot(
  user: { id: string; email: string } | null = null
): Promise<Snapshot> {
  const snap = await loadSnapshot(pgClient(), user);
  (globalThis as GSnap).__zenithPgSnapshot = snap;
  return snap;
}

/** Drop the process-global snapshot (tests, and `reset()`). */
export const clearProcessSnapshot = (): void => {
  delete (globalThis as GSnap).__zenithPgSnapshot;
};

/**
 * A snapshot that loaded nothing and is nobody's — its own graph, not
 * `FileStore`'s.
 *
 * What a *signed-out* reader gets in a scope that needs one. It is not a
 * fallback: `scope` is empty, `baseline` is empty, so a flush of it writes
 * nothing and can delete nothing. `loadSnapshot(client, null)` is the other
 * answer and the wrong one here — that means "every workspace on the install",
 * which is right for the scheduler and a leak for a page.
 */
export const detachedSnapshot = (): Snapshot => emptySnapshot(emptyGraph());

/**
 * Rows of one registered collection by primary key, with **no snapshot**.
 *
 * The bounded read a page outside every scope needs: it names the ids it wants
 * and gets those rows, so it can never widen into a tenant slice or an
 * install-wide graph the way a snapshot can. Read-only by construction — the
 * objects it returns are in no baseline, so no flush will ever write them
 * back. Collections whose primary key is `(workspace_id, id)` are refused,
 * because an id alone does not name one of their rows.
 */
export async function readRowsByIdAsync<T extends { id: string }>(
  collection: PgCollection,
  ids: string[]
): Promise<T[]> {
  const spec = adapterFor(collection);
  if (spec.scopedByWorkspace)
    throw new Error(
      `"${collection}" is keyed by (workspace_id, id), so an id alone does not name a row. ` +
        `Fix: read it through a snapshot scope instead of readRowsByIdAsync().`
    );
  const wanted = [...new Set(ids.filter(Boolean))];
  if (wanted.length === 0) return [];
  const rows = await selectRows(pgClient(), spec.table, { column: "id", values: wanted });
  return rows.map((row) => {
    const obj = spec.hydrate(row) as T;
    setTenant(obj, String(row.workspace_id ?? ""));
    return obj;
  });
}

/**
 * The snapshot this call should read: the request's, when there is one.
 *
 * `route()` put it on `./request-snapshot`'s AsyncLocalStorage (and on
 * `RequestState.snapshot`, which is the same object) before the handler ran.
 * Outside a request — a script, the seed, a test — the process-global one is
 * the right and only answer.
 */
export function currentSnapshot(): Snapshot {
  return (requestSnapshot() as Snapshot | undefined) ?? processSnapshot();
}

/* --------------------------------- writing -------------------------------- */

/** Rows of one collection that moved since the snapshot loaded. */
interface Change {
  collection: PgCollection;
  row: { id: string };
  workspaceId: string;
  baseline?: Baseline;
}

/** Each row as it stood when a flush computed its writes. */
type Captured = Map<string, { json: string; workspaceId: string }>;

function diff(snap: Snapshot): { writes: Change[]; deletes: Change[]; captured: Captured } {
  const writes: Change[] = [];
  const seen = new Set<string>();
  const captured: Captured = new Map();

  for (const adapter of rowAdapters()) {
    const collection = adapter.collection;
    for (const row of adapter.rows!(snap.data)) {
      const workspaceId = adapter.tenant(row as never, { db: snap.data });
      const key = bkey(collection, row.id, keyScope(collection, workspaceId));
      seen.add(key);
      const json = canonical(row);
      captured.set(key, { json, workspaceId });
      const baseline = snap.baseline.get(key);
      if (baseline && baseline.json === json) continue;
      // The live row may change again before it is written; the baseline records
      // `json`, so the next pass still sees any difference and writes it.
      writes.push({ collection, row, workspaceId, baseline });
    }
  }

  // Anything the snapshot loaded and no longer holds was deleted by this
  // caller. Scoped to what this snapshot actually loaded, so a request that
  // only ever saw one workspace can never delete another one's rows.
  const deletes: Change[] = [];
  for (const [key, baseline] of snap.baseline) {
    if (seen.has(key) || key.startsWith("settings:")) continue;
    const [collection, workspaceId, ...rest] = key.split(":");
    deletes.push({
      collection: collection as PgCollection,
      row: { id: rest.join(":") },
      workspaceId,
      baseline,
    });
  }
  return { writes, deletes, captured };
}

/** A 409 the caller can act on, rather than a silently lost edit. */
async function conflict(): Promise<never> {
  const { ApiError } = await import("@/lib/server/errors");
  throw new ApiError("Someone else changed this workspace; reload and retry", 409, {
    fix: "Reload the page so you are editing the current version, then make the change again.",
  });
}

/** One flush entry for `zenith_product_flush` (supabase/migrations/0027): the same row the old per-row calls wrote. */
function flushWrite(change: Change, now: string): Record<string, unknown> {
  const spec = adapterFor(change.collection);
  const promoted = spec.promote(change.row as never);
  const data = stripPromoted(change.row, change.collection);
  const key = spec.key({ id: change.row.id, workspaceId: change.workspaceId });
  if (!change.baseline)
    return { table: spec.table, key, baseline: null,
      row: { id: change.row.id, workspace_id: change.workspaceId, ...promoted, data, version: 1, updated_at: now } };
  return { table: spec.table, key, baseline: change.baseline.version,
    row: { ...promoted, data, version: change.baseline.version + 1, updated_at: now } };
}

function flushDelete(change: Change): Record<string, unknown> {
  const spec = adapterFor(change.collection);
  return { table: spec.table, key: spec.key({ id: change.row.id, workspaceId: change.workspaceId }), baseline: change.baseline!.version };
}

/**
 * Every changed row of one pass in ONE transaction. Each row keeps its own
 * guard (an update or delete matches the loaded version, an insert must be
 * new), and a refusal anywhere rolls back the whole pass, so rows that decide
 * a fence together (an environment's writer lease and its deployment) never
 * land half-written.
 */
async function writeRows(client: SupabaseClient, writes: Change[], deletes: Change[]): Promise<void> {
  if (writes.length === 0 && deletes.length === 0) return;
  const now = new Date().toISOString();
  const { error } = await client.rpc("zenith_product_flush", {
    p_writes: writes.map((change) => flushWrite(change, now)),
    p_deletes: deletes.map(flushDelete),
  });
  // moved, removed or created by another instance first: a conflict to reload, not a store failure
  if (error?.code === "PZ409" || error?.code === "23505") await conflict();
  if (error) throw storeError("product rows", "flush", error.message);
}

/**
 * One domain object as the row that stores it. Exported for the migration
 * script, so the bulk import and the request path cannot encode a row two
 * different ways.
 */
export function toRow(
  collection: PgCollection,
  row: { id: string },
  workspaceId: string
): Record<string, unknown> {
  const spec = adapterFor(collection);
  return {
    id: row.id,
    workspace_id: workspaceId,
    ...spec.promote(row as never),
    data: stripPromoted(row, collection),
    version: 1,
    updated_at: new Date().toISOString(),
  };
}

/** The table one collection writes to. */
export const tableOf = (collection: PgCollection): string => adapterFor(collection).table;

/** Everything that is not a promoted column, so `data` never duplicates one. */
function stripPromoted(row: { id: string }, collection: PgCollection): Record<string, unknown> {
  const out: Record<string, unknown> = { ...(row as Record<string, unknown>) };
  delete out.id;
  for (const field of Object.values(adapterFor(collection).rename)) delete out[field];
  return out;
}

/**
 * The install-global settings row, guarded exactly like `zenith_product_flush` guards every
 * other collection: a row that existed at load is updated only `where version =
 * <the version loaded>`, and matching nothing is the same 409. This used to be
 * an unguarded upsert, so two requests that read the same version each
 * "succeeded" and the later flush silently replaced the earlier edit.
 *
 * Version 0 is "no row at load" (see `loadSnapshot`), so the first write is an
 * insert, and a unique violation — somebody inserted it first — is the same 409.
 */
async function writeSettings(client: SupabaseClient, snap: Snapshot): Promise<void> {
  const data = withoutInvites(snap.data.settings);
  const baseline = snap.baseline.get(bkey("settings", INSTALL_SETTINGS_ID));
  if (baseline && baseline.json === canonical(data)) return;
  const loaded = baseline?.version ?? 0;
  const next = loaded + 1;
  const now = new Date().toISOString();

  if (loaded === 0) {
    const { error } = await client
      .from("settings")
      .insert({ workspace_id: INSTALL_SETTINGS_ID, data, version: next, updated_at: now });
    if (error) {
      // 23505 unique_violation: the row appeared after this snapshot loaded.
      if (error.code === "23505") await conflict();
      throw storeError("settings", "insert into", error.message);
    }
  } else {
    const { data: updated, error } = await client
      .from("settings")
      .update({ data, version: next, updated_at: now })
      .eq("workspace_id", INSTALL_SETTINGS_ID)
      .eq("version", loaded)
      .select("workspace_id");
    if (error) throw storeError("settings", "update", error.message);
    if (!updated || updated.length === 0) await conflict();
  }
  snap.settingsVersion = next;
  snap.baseline.set(bkey("settings", INSTALL_SETTINGS_ID), { version: next, json: canonical(data) });
}

/**
 * Bump the change feed for every workspace this flush touched.
 *
 * Deliberately *not* guarded on `version`: this table is a notification, not a
 * record. A lost bump would only mean one listener polls a beat later; a 409
 * here would mean a successful write reported failure.
 */
async function bumpFeed(client: SupabaseClient, snap: Snapshot, ids: Set<string>): Promise<void> {
  if (ids.size === 0) return;
  const projects = snap.touched.all ? [] : [...snap.touched.ids];
  const now = new Date().toISOString();
  const rows = [...ids].map((workspace_id) => {
    const next = (snap.feed.get(workspace_id) ?? 0) + 1;
    snap.feed.set(workspace_id, next);
    return { workspace_id, version: next, touched_projects: projects, updated_at: now };
  });
  const { error } = await client
    .from("workspace_versions")
    .upsert(rows, { onConflict: "workspace_id" });
  if (error) throw storeError("workspace_versions", "write", error.message);
}

/** Write every pending change in one pass, then re-baseline the snapshot. */
async function flushSnapshot(snap: Snapshot): Promise<void> {
  const client = pgClient();
  const { writes, deletes, captured } = diff(snap);
  const touchedWorkspaces = new Set<string>();

  // FK order: a workspace before its members, a project before its
  // environments — which is registration order, by the registry's contract.
  const ORDER = rowAdapters().map((a) => a.collection);
  const orderedWrites = ORDER.flatMap((collection) => writes.filter((c) => c.collection === collection));
  // Deletes run in reverse, for the same reason.
  const orderedDeletes = [...ORDER].reverse().flatMap((collection) => deletes.filter((c) => c.collection === collection));
  await writeRows(client, orderedWrites, orderedDeletes);
  for (const change of [...orderedWrites, ...orderedDeletes]) touchedWorkspaces.add(change.workspaceId);

  await writeSettings(client, snap);
  await bumpFeed(client, snap, touchedWorkspaces);

  // Rebaseline from what this pass wrote, not from the snapshot as it stands
  // now. The writes above yield, and a caller in the same request can mutate
  // the snapshot meanwhile (a deploy saves its revision, which starts this
  // flush, then creates the deployment and claims the environment lease).
  // Recording those later rows as the baseline marked them written when they
  // never were, so the deployment silently never reached the database.
  rebaseline(snap, captured);
  snap.touched.ids.clear();
  snap.touched.all = false;
  const leftover = diff(snap);
  if (leftover.writes.length === 0 && leftover.deletes.length === 0) {
    snap.dirty.clear();
    snap.scheduled = false;
  } else {
    snap.scheduled = true;
  }
}

/** After a successful flush the database holds what the pass captured. Say so. */
function rebaseline(snap: Snapshot, captured: Captured): void {
  const next = new Map<string, Baseline>();
  for (const [key, row] of captured) {
    const previous = snap.baseline.get(key);
    next.set(key, {
      version: previous ? previous.version + (previous.json === row.json ? 0 : 1) : 1,
      json: row.json,
    });
    snap.scope.add(row.workspaceId);
  }
  const settings = snap.baseline.get(bkey("settings", INSTALL_SETTINGS_ID));
  if (settings) next.set(bkey("settings", INSTALL_SETTINGS_ID), settings);
  snap.baseline = next;
}

/* ------------------------------ change events ------------------------------ */

/** The SSE tick. Polling faster than the consumer reads buys nothing. */
const POLL_MS = 300;

type GFeed = typeof globalThis & {
  __zenithPgListeners?: Set<(c: StoreChange) => void>;
  __zenithPgPoll?: ReturnType<typeof setInterval>;
  __zenithPgSeen?: Map<string, number>;
};

const listeners = (): Set<(c: StoreChange) => void> =>
  ((globalThis as GFeed).__zenithPgListeners ??= new Set());

const seenVersions = (): Map<string, number> =>
  ((globalThis as GFeed).__zenithPgSeen ??= new Map());

async function pollFeed(): Promise<void> {
  // Deliberately the non-demanding accessor: the poller runs on a timer, not
  // on a caller's behalf, so "nobody has primed a snapshot yet" is a reason to
  // poll nothing this tick, not a fault to raise from an interval callback.
  const snap = requestSnapshot() as Snapshot | undefined ?? primedSnapshot();
  const ids = snap ? [...snap.scope] : [];
  if (ids.length === 0 || listeners().size === 0) return;
  const { data, error } = await pgClient()
    .from("workspace_versions")
    .select("workspace_id,version,touched_projects")
    .in("workspace_id", ids);
  if (error) return; // a transient feed failure must not take the stream down
  const seen = seenVersions();
  const projectIds = new Set<string>();
  let moved = false;
  for (const row of (data ?? []) as Row[]) {
    const id = String(row.workspace_id);
    const version = Number(row.version ?? 0);
    const before = seen.get(id);
    seen.set(id, version);
    if (before === undefined || version <= before) continue;
    moved = true;
    for (const p of (row.touched_projects as string[] | null) ?? []) projectIds.add(p);
  }
  if (!moved) return;
  const change: StoreChange = { projectIds: [...projectIds] };
  for (const fn of listeners()) fn(change);
}

/**
 * Subscribe to write notifications. Returns an unsubscribe function.
 *
 * One poller per process, not per listener: a hundred open streams must cost
 * one query per tick, not a hundred. It starts with the first listener and is
 * cleared with the last, so an idle process makes no queries at all.
 */
function onChange(fn: (c: StoreChange) => void): () => void {
  const g = globalThis as GFeed;
  // The file store's emitter is kept as a second source, not as durability: it
  // still carries anything that writes through `FileStore` in this process
  // (`reset()`, a seed) so a listener does not miss it. The ordinary local echo
  // is `announce()` below.
  const offLocal = FileStore.onChange(fn);
  listeners().add(fn);
  if (!g.__zenithPgPoll) {
    g.__zenithPgPoll = setInterval(() => void pollFeed(), POLL_MS);
    (g.__zenithPgPoll as { unref?: () => void }).unref?.();
  }
  return () => {
    offLocal();
    listeners().delete(fn);
    if (listeners().size === 0 && g.__zenithPgPoll) {
      clearInterval(g.__zenithPgPoll);
      g.__zenithPgPoll = undefined;
    }
  };
}

/**
 * The local echo an open SSE stream needs, emitted where the mutation happened.
 *
 * This used to be a side effect of `FileStore.save()`: Postgres mode called it
 * for its own reasons and the emitter came along. Nothing writes `state.json`
 * in Postgres mode any more, so the notification is raised here instead —
 * synchronously, so an in-process save reaches its own stream without waiting
 * for the 300 ms feed poll to bring the round trip back.
 */
function announce(projectId?: string): void {
  if (listeners().size === 0) return;
  const change: StoreChange = { projectIds: projectId ? [projectId] : [] };
  for (const fn of listeners())
    try {
      fn(change);
    } catch {
      /* a listener's failure is the listener's problem; the write already happened */
    }
}

/* ------------------------------ the interface ------------------------------ */

/** Every registered collection, settings included; the rest is `FileStore`. */
const ALL = (): PgCollection[] => adapters().map((a) => a.collection);

type GPending = typeof globalThis & { __zenithPgPending?: Promise<void> };

function schedule(snap: Snapshot): Promise<void> {
  const g = globalThis as GPending;
  const run = (g.__zenithPgPending ?? Promise.resolve())
    .catch(() => undefined)
    .then(() => flushSnapshot(snap));
  g.__zenithPgPending = run.catch(() => undefined);
  return run;
}

/**
 * Wait for every write this process has started. `route()` awaits this before
 * answering a mutating request — on every host, not only serverless: a write
 * that has not reached Postgres when the response leaves is a write the very
 * next request can fail to read, and that has nothing to do with freezing.
 */
export async function flushPostgres(): Promise<boolean> {
  const snap = currentSnapshot();
  const had = snap.scheduled || snap.dirty.size > 0;
  const pending = (globalThis as GPending).__zenithPgPending;
  if (!had) {
    if (pending) await pending;
    // A pass already in flight may leave rows it did not capture.
    if (!snap.scheduled) return false;
  }
  // Each pass writes what it captured; anything a caller changed meanwhile is
  // left scheduled for the next pass. Bounded so a runaway writer cannot pin
  // the request.
  for (let pass = 0; pass < 5; pass++) {
    await schedule(snap);
    if (!snap.scheduled) break;
  }
  if (snap.scheduled) throw storeError("store", "flush", "changes kept arriving during the flush; retry the request");
  return true;
}

export const PostgresStore: Store & {
  flushAsync: () => Promise<boolean>;
} = {
  db(): Database {
    return currentSnapshot().data;
  },

  save(projectId?: string): void {
    const snap = currentSnapshot();
    if (projectId) snap.touched.ids.add(projectId);
    else snap.touched.all = true;
    for (const c of ALL()) snap.dirty.add(c);
    snap.scheduled = true;
    // No `FileStore.save()`. Postgres is the authority for every collection
    // (see the header), so writing `state.json` too produced a second, partial
    // copy of whichever tenant's slice this instance last prefetched — a file
    // that nothing reads back and that a serverless instance keeps in its own
    // /tmp. The one thing that call still bought is the local change event,
    // which `announce()` raises directly.
    announce(projectId);
    void schedule(snap).catch(() => undefined);
  },

  flush(): void {
    void flushPostgres().catch(() => undefined);
  },

  /**
   * Synchronous by contract, so it can only report and start the write.
   * `flushAsync()` is the one that waits, and `route()` calls that.
   */
  flushPending(): boolean {
    const snap = currentSnapshot();
    const had = snap.scheduled || snap.dirty.size > 0;
    if (had) {
      // Claim the work now: the write is in flight from this moment, so a
      // second call before it lands has nothing new to report. `diff()` reads
      // the snapshot against its baseline, not this set, so nothing is lost.
      snap.scheduled = false;
      snap.dirty.clear();
      void schedule(snap).catch(() => undefined);
    }
    return had;
  },

  flushAsync(): Promise<boolean> {
    return flushPostgres();
  },

  /**
   * Reset is scoped to what this snapshot loaded, never a global truncate:
   * `reset()` is a test and seed affordance, and a store pointed at a real
   * project must not be one call away from emptying it.
   *
   * `FileStore.reset()` here is deliberate: it is how a seed or a test gets an
   * empty graph (and clears this process's cold-storage side files), not a
   * durability path. It does write `state.json`, and it is the one place a
   * Postgres snapshot ends up pointing at the file store's process-global
   * graph — which is safe only because no request path reaches `reset()`. A
   * loaded snapshot never does: see `loadSnapshot`.
   */
  reset(data?: Partial<Database>): Database {
    const snap = currentSnapshot();
    const base = FileStore.reset(data);
    snap.data = base;
    snap.data.settings.invites ??= [];
    snap.dirty = new Set(ALL());
    snap.touched = { ids: new Set(), all: true };
    snap.scheduled = true;
    void schedule(snap).catch(() => undefined);
    return snap.data;
  },

  /* ---- Phase 3 debt: delegated, file store by default (./pg/delegates) ---- */
  appendEvent: (e: DeploymentEvent) => delegates.events.appendEvent(e),
  readEvents: (deploymentId: string, afterSeq?: number) =>
    delegates.events.readEvents(deploymentId, afterSeq),
  appendAudit: (e: AuditEvent) => delegates.audit.appendAudit(e),
  readAuditPage: (filter?: AuditFilter): AuditPage => delegates.audit.readAuditPage(filter),
  readAudit: (filter?: AuditFilter): AuditEvent[] => delegates.audit.readAudit(filter),
  countAudit: (filter?: AuditFilter): AuditCountResult => delegates.audit.countAudit(filter),
  revisionManifest: (id: string): AnyManifest | undefined => delegates.manifests.revisionManifest(id),

  onChange,
  changed: (c: StoreChange, projectId: string): boolean =>
    c.projectIds.length === 0 || c.projectIds.includes(projectId),
};
