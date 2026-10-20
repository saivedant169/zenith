/**
 * The Postgres store's read boundary, from outside a request.
 *
 * `route()` owns the request side and `tests/api/postgres-request-boundary.test.ts`
 * pins it. This file pins what happens **everywhere else** — a server
 * component, a worker, a script — now that an unprimed read is a fault rather
 * than a silent fall back to the file store:
 *
 *  1. `db()` with nothing primed **throws**, and the error names the way in;
 *  2. `runInStoreScope()` is that way in for a server component: it loads the
 *     signed-in caller's slice, and the rows that come back are Postgres' —
 *     never the file store's, even when the file store holds decoys;
 *  3. a signed-out reader gets an empty graph, not the install;
 *  4. the bounded by-id read the public preview page uses asks for the rows it
 *     names and nothing else, with no snapshot at all;
 *  5. a mutation in Postgres mode writes **no `state.json`** — Postgres is the
 *     authority and the file mirror is gone.
 *
 * The client is mocked at the supabase-js seam, so this runs with no network,
 * no project and no keys.
 */
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Deployment } from "@/lib/domain/types";
import { tempDataDir } from "../_support/data-dir";
import { productFlushRpc } from "../_support/product-flush-rpc";

const DATA = tempDataDir("zenith-rsc-scope-", { fast: true });
process.env.ZENITH_STORE = "postgres";
process.env.NEXT_PUBLIC_SUPABASE_URL ||= "https://project.supabase.co";
process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ||= "publishable-test-key";
process.env.SUPABASE_SERVICE_ROLE_KEY ||= "service-role-test-key";

/** Every table read or written, in order, for the boundedness assertions. */
const calls: string[] = [];

/** Rows the fake project holds, keyed by table. */
const TABLES: Record<string, Record<string, unknown>[]> = {};

const signedIn = { user: null as { id: string; email: string; name: string } | null };

vi.mock("@/lib/auth/session", () => ({
  getSessionUser: async () => signedIn.user,
  userFromClaims: () => null,
}));

/** A PostgREST-shaped builder that actually honours `.in(column, values)`. */
function builder(table: string, op: string) {
  let rows = TABLES[table] ?? [];
  const self: Record<string, unknown> = {};
  for (const name of ["select", "or", "like", "order", "limit", "eq"])
    self[name] = () => self;
  self.in = (column: string, values: string[]) => {
    rows = rows.filter((r) => values.includes(String(r[column])));
    return self;
  };
  self.then = (resolve: (v: unknown) => unknown) =>
    Promise.resolve(resolve({ data: op === "select" ? rows : rows, error: null, count: rows.length }));
  return self;
}

vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({
    rpc: productFlushRpc((call) => calls.push(call)),
    from(table: string) {
      const record = (op: string) => (..._args: unknown[]) => {
        void _args;
        calls.push(`${op}:${table}`);
        return builder(table, op);
      };
      return {
        select: record("select"),
        update: record("update"),
        insert: record("insert"),
        upsert: record("upsert"),
        delete: record("delete"),
      };
    },
  }),
}));

const store = await import("@/lib/db/store");
const pg = await import("@/lib/db/postgres-store");
const { FileStore } = await import("@/lib/db/file-store");

const row = (extra: Record<string, unknown>) => ({ data: {}, version: 1, ...extra });

function seedPostgres(): void {
  for (const key of Object.keys(TABLES)) delete TABLES[key];
  TABLES.workspaces = [
    row({ id: "ws-pg", workspace_id: "ws-pg", slug: "acme", name: "Acme", created_at: "2026-01-01T00:00:00.000Z" }),
  ];
  TABLES.members = [
    row({ id: "user-1", workspace_id: "ws-pg", email: "ada@example.com", role: "admin", data: { name: "Ada" } }),
  ];
  TABLES.invites = [];
  TABLES.connections = [];
  TABLES.projects = [
    row({ id: "proj-pg", workspace_id: "ws-pg", slug: "atlas", name: "Atlas", created_at: "2026-01-01T00:00:00.000Z" }),
  ];
  TABLES.environments = [
    row({ id: "env-pg", workspace_id: "ws-pg", project_id: "proj-pg", name: "Staging", data: { class: "staging", policies: {} } }),
  ];
  TABLES.revisions = [
    row({ id: "rev-pg", workspace_id: "ws-pg", project_id: "proj-pg", number: 4, created_at: "2026-01-02T00:00:00.000Z" }),
  ];
  TABLES.deployments = [
    row({
      id: "dep-pg",
      workspace_id: "ws-pg",
      project_id: "proj-pg",
      environment_id: "env-pg",
      revision_id: "rev-pg",
      status: "succeeded",
      created_at: "2026-01-02T00:00:00.000Z",
      data: { outputs: [], steps: [] },
    }),
    row({
      id: "dep-other",
      workspace_id: "ws-other",
      project_id: "proj-other",
      environment_id: "env-other",
      revision_id: "rev-other",
      status: "succeeded",
      created_at: "2026-01-02T00:00:00.000Z",
      data: { outputs: [], steps: [] },
    }),
  ];
  TABLES.findings = [];
  TABLES.navigator_runs = [];
  TABLES.alert_rules = [];
  TABLES.alert_events = [];
  TABLES.alert_outbox = [];
  TABLES.settings = [];
  TABLES.workspace_versions = [];
}

/** A decoy in the file store: if any read falls back, these ids show up. */
function seedFileStoreDecoys(): void {
  const graph = FileStore.db();
  graph.workspaces.length = 0;
  graph.projects.length = 0;
  graph.deployments.length = 0;
  graph.workspaces.push({ id: "ws-file", name: "File decoy", slug: "file-decoy", createdAt: "2026-01-01T00:00:00.000Z" });
  graph.projects.push({
    id: "proj-file",
    workspaceId: "ws-file",
    name: "File decoy",
    slug: "file-decoy",
    createdAt: "2026-01-01T00:00:00.000Z",
    workingManifest: { services: [], datastores: [], networks: [] },
  } as never);
}

const stateFile = path.join(DATA, "state.json");

beforeEach(() => {
  calls.length = 0;
  signedIn.user = null;
  seedPostgres();
  seedFileStoreDecoys();
  pg.clearProcessSnapshot();
  pg.resetPgClient();
  if (fs.existsSync(stateFile)) fs.unlinkSync(stateFile);
});

afterEach(() => {
  pg.clearProcessSnapshot();
});

describe("an unprimed read", () => {
  it("throws instead of answering out of the file store", () => {
    expect(() => store.db()).toThrowError(pg.UNPRIMED_SNAPSHOT_ERROR);
  });

  it("names primeProcessSnapshot() and the scopes that stand in for it", () => {
    expect(() => store.db()).toThrowError(/primeProcessSnapshot\(\)/);
    expect(() => store.db()).toThrowError(/runInStoreScope\(\)/);
    // The failure mode it replaced, stated so nobody reintroduces it.
    expect(pg.UNPRIMED_SNAPSHOT_ERROR).toContain("file store");
  });

  it("reads nothing while refusing", () => {
    expect(() => store.db()).toThrow();
    expect(calls).toEqual([]);
  });
});

describe("runInStoreScope — the server-component read path", () => {
  it("serves the signed-in caller's Postgres rows, never the file store's", async () => {
    signedIn.user = { id: "user-1", email: "ada@example.com", name: "Ada" };

    const seen = await store.runInStoreScope(async () => ({
      workspaces: store.db().workspaces.map((w) => w.id),
      projects: store.db().projects.map((p) => p.id),
      viaQuery: store.q.workspace("acme")?.id,
    }));

    expect(seen.workspaces).toEqual(["ws-pg"]);
    expect(seen.projects).toEqual(["proj-pg"]);
    expect(seen.viaQuery).toBe("ws-pg");
    // The decoys the file store held are nowhere in the answer.
    expect(seen.workspaces).not.toContain("ws-file");
    expect(seen.projects).not.toContain("proj-file");
    expect(calls).toContain("select:members");
    expect(calls).toContain("select:projects");
  });

  it("gives a signed-out reader an empty graph, not the install", async () => {
    signedIn.user = null;

    const seen = await store.runInStoreScope(async () => ({
      workspaces: store.db().workspaces.map((w) => w.id),
      projects: store.db().projects.map((p) => p.id),
    }));

    expect(seen).toEqual({ workspaces: [], projects: [] });
    // No prefetch at all: "nobody is signed in" must not mean "load everything".
    expect(calls).toEqual([]);
  });

  it("closes the scope again, so the next unscoped read still refuses", async () => {
    signedIn.user = { id: "user-1", email: "ada@example.com", name: "Ada" };
    await store.runInStoreScope(async () => store.db().workspaces.length);
    expect(() => store.db()).toThrowError(pg.UNPRIMED_SNAPSHOT_ERROR);
  });
});

describe("readRowsByIdAsync — the bounded read the public preview page uses", () => {
  it("returns the named rows with no snapshot in scope", async () => {
    const [deployment] = await pg.readRowsByIdAsync<Deployment>("deployments", ["dep-pg"]);
    expect(deployment?.id).toBe("dep-pg");
    expect(deployment?.projectId).toBe("proj-pg");
  });

  it("reads one table and never widens into a tenant slice", async () => {
    await pg.readRowsByIdAsync<Deployment>("deployments", ["dep-pg"]);
    expect(calls).toEqual(["select:deployments"]);
    expect(calls).not.toContain("select:members");
    expect(calls).not.toContain("select:workspaces");
  });

  it("does not hand back a row it was not asked for", async () => {
    const rows = await pg.readRowsByIdAsync<Deployment>("deployments", ["dep-pg"]);
    expect(rows.map((r) => r.id)).toEqual(["dep-pg"]);
  });

  it("asks for nothing when there is no id", async () => {
    expect(await pg.readRowsByIdAsync("deployments", [])).toEqual([]);
    expect(calls).toEqual([]);
  });

  it("refuses a collection an id alone does not identify", async () => {
    await expect(pg.readRowsByIdAsync("members", ["user-1"])).rejects.toThrow(
      /keyed by \(workspace_id, id\)/
    );
  });
});

describe("Postgres is the only authority a mutation reaches", () => {
  it("writes no state.json", async () => {
    signedIn.user = { id: "user-1", email: "ada@example.com", name: "Ada" };

    await store.runInStoreScope(async () => {
      store.db().workspaces[0].name = "Acme Renamed";
      store.save();
      await store.flushPendingAsync();
    });

    expect(calls).toContain("update:workspaces");
    expect(fs.existsSync(stateFile)).toBe(false);
  });

  it("still emits the local change event a stream listens for", async () => {
    signedIn.user = { id: "user-1", email: "ada@example.com", name: "Ada" };
    const seen: string[][] = [];
    const off = store.onChange((c) => seen.push(c.projectIds));
    try {
      await store.runInStoreScope(async () => {
        store.db().workspaces[0].name = "Acme Renamed Again";
        store.save("proj-pg");
        await store.flushPendingAsync();
      });
    } finally {
      off();
    }
    expect(seen).toContainEqual(["proj-pg"]);
    expect(fs.existsSync(stateFile)).toBe(false);
  });
});
