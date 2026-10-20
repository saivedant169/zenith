/**
 * What `route()` owes the Postgres store, at the request boundary.
 *
 * Three claims, and all three are invisible from inside a handler, which is
 * exactly why they are pinned here rather than in the store's own tests:
 *
 *  1. the workspace slice is read **before** the handler runs — `db()` is
 *     synchronous, so a handler that had to wait for the round trip could not;
 *  2. a mutating request's write reaches Postgres **before** the response
 *     leaves, on every host and not only serverless;
 *  3. a row somebody else moved first is a **409**, not a silent overwrite.
 *
 * The client is mocked at the supabase-js seam — `from().select()` /
 * `.update()` — so this runs with no network, no project and no keys. What it
 * asserts is the ordering and the failure mode, which is all `route()` owns.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { tempDataDir } from "../_support/data-dir";
import { productFlushRpc } from "../_support/product-flush-rpc";

tempDataDir("zenith-pg-boundary-", { fast: true });
process.env.ZENITH_STORE = "postgres";

/** Everything the store asks the database, in order, for the assertions below. */
const calls: string[] = [];

/** Rows the fake project holds, keyed by table. */
const TABLES: Record<string, Record<string, unknown>[]> = {};

/** Flipped on to make the next `update` match zero rows — a lost race. */
let stale = false;

function reset(): void {
  calls.length = 0;
  stale = false;
  for (const key of Object.keys(TABLES)) delete TABLES[key];
  TABLES.workspaces = [
    {
      id: "ws-1",
      workspace_id: "ws-1",
      slug: "acme",
      name: "Acme",
      created_at: "2026-01-01T00:00:00.000Z",
      data: {},
      version: 3,
    },
  ];
  TABLES.members = [
    {
      id: "user-1",
      workspace_id: "ws-1",
      email: "ada@example.com",
      role: "admin",
      data: { name: "Ada" },
      version: 1,
    },
  ];
  TABLES.invites = [];
  TABLES.connections = [];
  TABLES.projects = [];
  TABLES.environments = [];
  TABLES.settings = [];
  TABLES.workspace_versions = [];
}

/**
 * The smallest thing that behaves like a PostgREST query builder: thenable,
 * chainable, and honest about how many rows an `update` matched.
 */
function builder(table: string, op: string) {
  const state = { op, rows: TABLES[table] ?? [] };
  const self: Record<string, unknown> = {};
  const chain = (name: string) => (..._args: unknown[]) => {
    void _args;
    if (name !== "eq" && name !== "in" && name !== "or" && name !== "like") calls.push(`${table}.${name}`);
    return self;
  };
  for (const name of ["select", "eq", "in", "or", "like", "order", "limit"])
    self[name] = chain(name);
  self.then = (resolve: (v: unknown) => unknown) => {
    const matched = state.op === "update" && stale ? [] : state.rows;
    return Promise.resolve(
      resolve({ data: state.op === "select" ? state.rows : matched, error: null, count: matched.length })
    );
  };
  return self;
}

vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({
    rpc: productFlushRpc((call) => calls.push(call), (_table, op) => op === "update" && stale),
    from(table: string) {
      return {
        select: (...args: unknown[]) => {
          calls.push(`select:${table}`);
          return (builder(table, "select") as { select: (...a: unknown[]) => unknown }).select(
            ...args
          );
        },
        update: (...args: unknown[]) => {
          calls.push(`update:${table}`);
          void args;
          return builder(table, "update");
        },
        insert: (...args: unknown[]) => {
          calls.push(`insert:${table}`);
          void args;
          return builder(table, "insert");
        },
        upsert: (...args: unknown[]) => {
          calls.push(`upsert:${table}`);
          void args;
          return builder(table, "upsert");
        },
        delete: () => {
          calls.push(`delete:${table}`);
          return builder(table, "delete");
        },
      };
    },
  }),
}));

process.env.NEXT_PUBLIC_SUPABASE_URL ||= "https://project.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY ||= "service-role-test-key";

const { route } = await import("@/lib/server/request");
const { db, save } = await import("@/lib/db/store");
const pg = await import("@/lib/db/postgres-store");

type Handler = (
  req: NextRequest,
  ctx: { params: Promise<Record<string, string>> }
) => Promise<Response>;

const call = (handler: Handler, method: string): Promise<Response> =>
  handler(new NextRequest("http://zenith.test/api/test", { method }), {
    params: Promise.resolve({}),
  });

describe("route() over the Postgres store", () => {
  beforeEach(() => {
    reset();
    pg.clearProcessSnapshot();
    pg.resetPgClient();
  });

  it("prefetches the workspace slice before the handler runs", async () => {
    let atHandler: string[] = [];
    const handler = route(async () => {
      atHandler = [...calls];
      // The graph is already in memory: no await, no round trip.
      return { workspaces: db().workspaces.map((w) => w.slug) };
    });

    const res = await call(handler, "GET");
    expect(await res.json()).toEqual({ workspaces: ["acme"] });
    // Members first — they are the membership answer and the filter for the
    // rest — and every Phase-2 table read before the handler saw anything.
    expect(atHandler).toContain("select:members");
    expect(atHandler.indexOf("select:members")).toBeLessThan(
      atHandler.indexOf("select:workspaces")
    );
    for (const table of ["workspaces", "projects", "environments", "connections", "invites"])
      expect(atHandler).toContain(`select:${table}`);
  });

  it("writes before it answers, on a mutating request", async () => {
    let atHandler: string[] = [];
    const handler = route(async () => {
      atHandler = [...calls];
      db().workspaces[0].name = "Acme Renamed";
      save();
      return { ok: true };
    });

    const res = await call(handler, "POST");
    expect(res.status).toBe(200);
    // The update was not there when the handler finished, and is there now:
    // `route()` closed the window itself, with no ZENITH_SERVERLESS in sight.
    expect(atHandler).not.toContain("update:workspaces");
    expect(calls).toContain("update:workspaces");
    expect(calls.indexOf("update:workspaces")).toBeLessThan(
      calls.indexOf("upsert:workspace_versions")
    );
  });

  it("does not write on a read", async () => {
    const handler = route(async () => ({ ok: true }));
    await call(handler, "GET");
    expect(calls.some((c) => c.startsWith("update:") || c.startsWith("insert:"))).toBe(false);
  });

  it("answers 409 when the row moved under the request", async () => {
    const handler = route(async () => {
      db().workspaces[0].name = "Acme Renamed";
      stale = true; // somebody else's write landed first
      save();
      return { ok: true };
    });

    const res = await call(handler, "POST");
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: { message: string; fix?: string } };
    expect(body.error.message).toBe("Someone else changed this workspace; reload and retry");
    expect(body.error.fix).toContain("Reload");
  });
});
