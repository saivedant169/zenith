/**
 * Two tenants, one Node process: a snapshot is nobody else's.
 *
 * `loadSnapshot()` used to build every snapshot over `FileStore.db()`, which is
 * one object per process, while `adopt()` truncates and refills the arrays it
 * is handed. So two requests served concurrently by one instance shared one
 * graph: A awaited anything, B's prefetch emptied the arrays and refilled them
 * with B's rows, and A resumed reading them — a cross-tenant read, and a
 * cross-tenant write too, because the flush diffs `snap.data` (by then B's
 * rows) against A's `baseline`.
 *
 * What is pinned here is the isolation itself, at the seam where it broke:
 *
 *  1. two interleaved `runWithSnapshot` scopes, with a real await between one
 *     scope's prefetch and its read, each see only their own tenant's rows;
 *  2. a flush inside one scope diffs against **its own** baseline — one update
 *     for the row it changed, and no insert or delete for the other tenant;
 *  3. a loaded snapshot does not touch the file store's graph at all.
 *
 * The client is mocked at the supabase-js seam — there is no network, no
 * project and no keys — so what this proves is the store's object graph and
 * the statements it emits, not PostgREST behaviour.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { tempDataDir } from "../_support/data-dir";
import { productFlushRpc } from "../_support/product-flush-rpc";

tempDataDir("zenith-snapshot-isolation-", { fast: true });
process.env.ZENITH_STORE = "postgres";
process.env.NEXT_PUBLIC_SUPABASE_URL ||= "https://project.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY ||= "service-role-test-key";

/** Rows the fake project holds, keyed by table. */
const TABLES: Record<string, Record<string, unknown>[]> = {};

interface Statement {
  op: string;
  table: string;
  payload?: Record<string, unknown>;
}

/** Every statement the store sent, in order. */
const sent: Statement[] = [];

/** Runs once, inside the first write a flush sends — i.e. mid-flush. */
let onWrite: (() => void) | undefined;
let onSharingRpc: (() => Record<string, unknown>) | undefined;

/** A PostgREST-shaped builder that actually honours `.in(column, values)`. */
function builder(table: string) {
  let rows = TABLES[table] ?? [];
  const self: Record<string, unknown> = {};
  for (const name of ["select", "or", "like", "order", "limit", "eq"]) self[name] = () => self;
  self.in = (column: string, values: string[]) => {
    rows = rows.filter((r) => values.includes(String(r[column])));
    return self;
  };
  self.then = (resolve: (v: unknown) => unknown) =>
    Promise.resolve(resolve({ data: rows, error: null, count: rows.length }));
  return self;
}

vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({
    rpc: async (fn: string, args?: Record<string, unknown>) => {
      if (fn !== "zenith_product_flush") return { data: onSharingRpc?.() ?? {}, error: null };
      // the one-transaction flush, recorded as the per-row statements it carries
      return productFlushRpc(() => undefined, () => false, (writes, deletes) => {
        for (const w of writes) sent.push({ op: w.baseline === null ? "insert" : "update", table: w.table, payload: w.row });
        for (const d of deletes) sent.push({ op: "delete", table: d.table, payload: d.key });
        const hook = onWrite;
        if (hook && (writes.length || deletes.length)) { onWrite = undefined; hook(); }
      })(fn, args as never);
    },
    from(table: string) {
      const record =
        (op: string) =>
        (...args: unknown[]) => {
          sent.push({ op, table, payload: args[0] as Record<string, unknown> | undefined });
          const hook = onWrite;
          if (hook && op !== "select") {
            onWrite = undefined;
            hook();
          }
          return builder(table);
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

const { db, save, flushPendingAsync } = await import("@/lib/db/store");
const pg = await import("@/lib/db/postgres-store");
const { runWithSnapshot } = await import("@/lib/db/request-snapshot");
const { FileStore } = await import("@/lib/db/file-store");
const { pgSharingMutation } = await import("@/lib/db/pg/workspace-sharing");

const ADA = { id: "user-ada", email: "ada@acme.example" };
const GRACE = { id: "user-grace", email: "grace@globex.example" };

const row = (extra: Record<string, unknown>) => ({ data: {}, version: 1, ...extra });

function seed(): void {
  for (const key of Object.keys(TABLES)) delete TABLES[key];
  TABLES.workspaces = [
    row({ id: "ws-acme", workspace_id: "ws-acme", slug: "acme", name: "Acme", created_at: "2026-01-01T00:00:00.000Z" }),
    row({ id: "ws-globex", workspace_id: "ws-globex", slug: "globex", name: "Globex", created_at: "2026-01-01T00:00:00.000Z" }),
  ];
  TABLES.members = [
    row({ id: ADA.id, workspace_id: "ws-acme", email: ADA.email, role: "admin", data: { name: "Ada" } }),
    row({ id: GRACE.id, workspace_id: "ws-globex", email: GRACE.email, role: "admin", data: { name: "Grace" } }),
  ];
  TABLES.invites = [];
  TABLES.connections = [];
  TABLES.projects = [
    row({ id: "proj-acme", workspace_id: "ws-acme", slug: "atlas", name: "Atlas", created_at: "2026-01-01T00:00:00.000Z" }),
    row({ id: "proj-globex", workspace_id: "ws-globex", slug: "beacon", name: "Beacon", created_at: "2026-01-01T00:00:00.000Z" }),
  ];
  TABLES.environments = [];
  TABLES.revisions = [];
  TABLES.deployments = [];
  TABLES.revision_manifests = [];
  TABLES.deployment_events = [];
  TABLES.audit_events = [];
  TABLES.findings = [];
  TABLES.navigator_runs = [];
  TABLES.alert_rules = [];
  TABLES.alert_events = [];
  TABLES.alert_outbox = [];
  TABLES.settings = [];
  TABLES.workspace_versions = [];
}

/** A latch two "requests" use to hand control to each other. */
function latch(): { wait: Promise<void>; open: () => void } {
  let open = (): void => undefined;
  const wait = new Promise<void>((resolve) => {
    open = () => resolve();
  });
  return { wait, open };
}

const projectIds = (): string[] => db().projects.map((p) => p.id);
const workspaceIds = (): string[] => db().workspaces.map((w) => w.id);
const memberIds = (): string[] => db().members.map((m) => m.id);

beforeEach(() => {
  seed();
  sent.length = 0;
  onSharingRpc = undefined;
  pg.clearProcessSnapshot();
  pg.resetPgClient();
});

describe("two concurrent snapshots in one process", () => {
  it("loads peers in authorized workspaces without treating invitations as membership", async () => {
    TABLES.members.push(row({ id: "peer-acme", workspace_id: "ws-acme", email: "peer@acme.example", role: "viewer" }));
    TABLES.invites.push(row({ id: "invite-globex", workspace_id: "ws-globex", email: ADA.email, role: "editor", expires_at: "2099-01-01T00:00:00Z" }));
    const snapshot = await pg.loadSnapshot(pg.pgClient(), ADA);
    expect(snapshot.data.members.map((m) => m.id)).toEqual([ADA.id, "peer-acme"]);
    expect(snapshot.data.workspaces.map((w) => w.id)).toEqual(["ws-acme"]);
    expect(snapshot.data.projects.map((p) => p.id)).toEqual(["proj-acme"]);
    expect(snapshot.data.settings.invites).toEqual([]);
  });

  it("each read only their own tenant's rows, across an await", async () => {
    const bLoaded = latch();
    const bRead = latch();
    const acme: string[][] = [];
    const globex: string[][] = [];

    const first = async (): Promise<void> => {
      const snapshot = await pg.loadSnapshot(pg.pgClient(), ADA);
      await runWithSnapshot(snapshot, async () => {
        acme.push(projectIds());
        // Hand over *inside* the scope: the second request now prefetches
        // while this one is suspended, which is the exact interleaving a
        // shared graph turns into someone else's rows.
        bLoaded.open();
        await bRead.wait;
        acme.push(projectIds());
        expect(workspaceIds()).toEqual(["ws-acme"]);
        expect(memberIds()).toEqual([ADA.id]);
      });
    };

    const second = async (): Promise<void> => {
      await bLoaded.wait;
      const snapshot = await pg.loadSnapshot(pg.pgClient(), GRACE);
      await runWithSnapshot(snapshot, async () => {
        globex.push(projectIds());
        expect(workspaceIds()).toEqual(["ws-globex"]);
        expect(memberIds()).toEqual([GRACE.id]);
        bRead.open();
      });
    };

    await Promise.all([first(), second()]);

    // Before and after the other tenant's prefetch: the same rows, and only
    // this tenant's. (Before the fix the second reading was ["proj-globex"].)
    expect(acme).toEqual([["proj-acme"], ["proj-acme"]]);
    expect(globex).toEqual([["proj-globex"]]);
  });

  it("gives each snapshot its own graph, and neither is the file store's", async () => {
    const a = await pg.loadSnapshot(pg.pgClient(), ADA);
    const b = await pg.loadSnapshot(pg.pgClient(), GRACE);

    expect(a.data).not.toBe(b.data);
    expect(a.data.projects).not.toBe(b.data.projects);
    expect(a.data).not.toBe(FileStore.db());
    expect(b.data).not.toBe(FileStore.db());
    // The settings bag is rebuilt per load too — `invites` are projected into
    // it, so a shared object would be a shared invite list.
    expect(a.data.settings).not.toBe(b.data.settings);
  });

  it("leaves the file store's own graph untouched by a load", async () => {
    const decoy = FileStore.db();
    decoy.workspaces.length = 0;
    decoy.workspaces.push({
      id: "ws-file-decoy",
      name: "File decoy",
      slug: "file-decoy",
      createdAt: "2026-01-01T00:00:00.000Z",
    });

    await pg.loadSnapshot(pg.pgClient(), ADA);

    expect(FileStore.db().workspaces.map((w) => w.id)).toEqual(["ws-file-decoy"]);
  });
});

describe("a flush diffs against its own baseline", () => {
  it("rebases an atomic membership change before later snapshot saves", async () => {
    const peer = row({ id: "peer-acme", workspace_id: "ws-acme", email: "peer@acme.example", role: "viewer" });
    TABLES.members.push(peer);
    const snapshot = await pg.loadSnapshot(pg.pgClient(), ADA);
    onSharingRpc = () => {
      TABLES.members = TABLES.members.filter((member) => member.id !== "peer-acme");
      return { removed: peer, workspace: TABLES.workspaces[0] };
    };
    await runWithSnapshot(snapshot, async () => {
      const result = await pgSharingMutation({
        operation: "remove-member", workspaceId: "ws-acme", actorId: ADA.id,
        actorEmail: ADA.email, actorName: "Ada", memberId: "peer-acme",
      });
      expect(result.removed?.id).toBe("peer-acme");
      expect(db()).toBe(snapshot.data);
      expect(db().members.map((m) => m.id)).toEqual([ADA.id]);
      sent.length = 0;
      db().projects[0].name = "Atlas after removal";
      save("proj-acme");
      await flushPendingAsync();
    });
    expect(sent.filter((statement) => statement.table === "members" && statement.op !== "select")).toEqual([]);
    expect(sent.filter((statement) => statement.op === "update").map((statement) => statement.table)).toEqual(["projects"]);
  });

  it("writes the row this scope changed and nothing of the other tenant's", async () => {
    const other = await pg.loadSnapshot(pg.pgClient(), GRACE);
    const mine = await pg.loadSnapshot(pg.pgClient(), ADA);
    // The other tenant's request is still open and reading its own graph while
    // this one writes — that is the whole scenario.
    expect(other.data.projects.map((p) => p.id)).toEqual(["proj-globex"]);

    sent.length = 0;
    await runWithSnapshot(mine, async () => {
      db().projects[0].name = "Atlas Renamed";
      save("proj-acme");
      await flushPendingAsync();
    });

    const writes = sent.filter((s) => s.op !== "select");
    // One update for the row that moved, the feed bump, and nothing else: no
    // insert of the other tenant's rows (which a shared graph produced, since
    // they are absent from this snapshot's baseline) and no delete of them
    // either (which is what the missing-from-`seen` branch of `diff()` does).
    expect(writes.filter((w) => w.op === "update").map((w) => w.table)).toEqual(["projects"]);
    expect(writes.some((w) => w.op === "insert")).toBe(false);
    expect(writes.some((w) => w.op === "delete")).toBe(false);
    expect(writes.filter((w) => w.op === "upsert").map((w) => w.table)).toEqual([
      "workspace_versions",
    ]);

    const update = writes.find((w) => w.op === "update");
    expect(update?.payload).toMatchObject({ name: "Atlas Renamed", version: 2 });
    // The other tenant's open snapshot still holds its own rows afterwards.
    expect(other.data.projects.map((p) => p.id)).toEqual(["proj-globex"]);
  });
});

describe("a write made while a flush is in flight", () => {
  it("is still sent by the awaited flush, not marked written by the earlier pass", async () => {
    const snapshot = await pg.loadSnapshot(pg.pgClient(), ADA);
    await runWithSnapshot(snapshot, async () => {
      const project = db().projects.find((p) => p.id === "proj-acme")!;
      project.name = "Atlas renamed";
      // The deploy path in miniature: the first save starts a flush, and the
      // caller keeps mutating the same snapshot while that flush is writing.
      onWrite = () => {
        project.name = "Atlas renamed again";
        db().projects.push({ ...project, id: "proj-acme-2", slug: "atlas-2", name: "Atlas two" });
      };
      save(project.id);
      await flushPendingAsync();
    });
    const writes = sent.filter((s) => s.table === "projects" && s.op !== "select");
    const payloads = JSON.stringify(writes.map((w) => w.payload));
    expect(payloads).toContain("Atlas renamed again");
    expect(writes.some((w) => w.op === "insert" && (w.payload as { id?: string })?.id === "proj-acme-2")).toBe(true);
  });
});
