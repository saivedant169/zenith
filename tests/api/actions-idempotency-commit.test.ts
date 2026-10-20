/**
 * An idempotent outcome is retained only after the request that produced it
 * committed — and never before.
 *
 * On the Postgres store `save()` merely schedules the write; the durable round
 * trip is `await flushMutation(req)` inside `route()`, *after* `runAction` has
 * already returned. Retaining the outcome in `runAction` therefore left the
 * replay window holding `ok: true` for a mutation that a failed flush had
 * thrown away — and, since the window is now reported on the wire, asserting
 * `replayed: true` for it. So `route()` opens a commit scope, the runner keeps
 * the outcome *pending* inside it, and the scope promotes it only once the
 * flush resolves.
 *
 * The PostgREST client is faked at the supabase-js seam, exactly as
 * `postgres-request-boundary.test.ts` does it: `stale` makes the next `update`
 * match zero rows, which is the 409 version conflict the review named as one of
 * the two ways this flush fails in production.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { z } from "zod";
import { tempDataDir } from "../_support/data-dir";
import { productFlushRpc } from "../_support/product-flush-rpc";

tempDataDir("zenith-idem-commit-", { fast: true });
process.env.ZENITH_STORE = "postgres";

/** Rows the fake project holds, keyed by table. */
const TABLES: Record<string, Record<string, unknown>[]> = {};

/** Flipped on to make the next `update` match zero rows — a lost race. */
let stale = false;

/** When set, every `update` waits on it: the request is mid-flush. */
let flushGate: Promise<void> | null = null;

function reset(): void {
  stale = false;
  flushGate = null;
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

function builder(table: string, op: string) {
  const state = { op, rows: TABLES[table] ?? [] };
  const self: Record<string, unknown> = {};
  const chain = () => (..._args: unknown[]) => {
    void _args;
    return self;
  };
  for (const name of ["select", "eq", "in", "or", "like", "order", "limit"]) self[name] = chain();
  self.then = (resolve: (v: unknown) => unknown) => {
    const matched = state.op === "update" && stale ? [] : state.rows;
    const value = {
      data: state.op === "select" ? state.rows : matched,
      error: null,
      count: matched.length,
    };
    const wait = state.op === "update" && flushGate ? flushGate : Promise.resolve();
    return wait.then(() => resolve(value));
  };
  return self;
}

vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({
    // the one-transaction flush: held by the same gate as a row update, refused the same way when stale
    rpc: async (fn: string, args?: { p_writes?: { baseline: number | null }[] }) => {
      if (flushGate && (args?.p_writes ?? []).some((w) => w.baseline !== null)) await flushGate;
      return productFlushRpc(() => undefined, (_table, op) => op === "update" && stale)(fn, args as never);
    },
    from(table: string) {
      return {
        select: (...args: unknown[]) =>
          (builder(table, "select") as { select: (...a: unknown[]) => unknown }).select(...args),
        update: () => builder(table, "update"),
        insert: () => builder(table, "insert"),
        upsert: () => builder(table, "upsert"),
        delete: () => builder(table, "delete"),
      };
    },
  }),
}));

/**
 * Audit is not what this file is about, and the Postgres audit append talks to
 * PostgREST over `fetch` rather than through the mocked client.
 */
vi.mock("@/lib/db/store", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/db/store")>();
  return { ...actual, appendAuditAsync: async () => {} };
});

process.env.NEXT_PUBLIC_SUPABASE_URL ||= "https://project.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY ||= "service-role-test-key";

const { route } = await import("@/lib/server/request");
const { db, save } = await import("@/lib/db/store");
const { defineAction, runAction } = await import("@/lib/actions/core");
const pg = await import("@/lib/db/postgres-store");

type IdempotencyReport = import("@/lib/actions/core").IdempotencyReport;
type ActionRun = import("@/lib/actions/core").ActionRun;

let executions = 0;

defineAction({
  id: "test.commitTag",
  title: "Tag the workspace",
  category: "system",
  risk: "low",
  requiredRole: "admin",
  mutates: true,
  input: z.object({ tag: z.string() }),
  plan: () => ({
    summary: "tag",
    details: [],
    costDeltaUsd: 0,
    risk: "low" as const,
    warnings: [],
    requiresApproval: false,
  }),
  execute: (_ctx, input) => {
    executions++;
    db().workspaces[0].name = `Acme|${input.tag}`;
    save();
    return { ok: true, summary: `tagged ${input.tag}`, data: { tag: input.tag } };
  },
});

/** Resolved by the handler the moment `runAction` has returned. */
let ran: (() => void) | null = null;

const handler = route(async (req) => {
  const params = req.nextUrl.searchParams;
  const out = await runAction(
    "test.commitTag",
    { workspaceId: "ws-1", actor: { type: "user", id: "user-1", name: "Ada" } },
    { tag: params.get("tag") ?? "one" },
    { mode: "execute", idempotencyKey: params.get("key") ?? undefined }
  );
  ran?.();
  return out;
});

const call = (query: string): Promise<Response> =>
  handler(new NextRequest(`http://zenith.test/api/test?${query}`, { method: "POST" }), {
    params: Promise.resolve({}),
  });

const body = async (res: Response): Promise<ActionRun> => (await res.json()) as ActionRun;

describe("the replay window and the request's durable flush", () => {
  beforeEach(() => {
    reset();
    executions = 0;
    ran = null;
    pg.clearProcessSnapshot();
    pg.resetPgClient();
    (globalThis as { __zenithIdem?: Map<string, unknown> }).__zenithIdem = new Map();
  });

  it("retains the outcome once the flush succeeds, and replays it", async () => {
    const first = await body(await call("key=k-ok&tag=one"));
    expect(first.result?.ok).toBe(true);
    expect(first.idempotency).toMatchObject({ applied: true, replayed: false });
    expect(executions).toBe(1);

    const replay = await body(await call("key=k-ok&tag=one"));
    expect(replay.result).toEqual(first.result);
    expect(replay.idempotency).toMatchObject({ applied: true, replayed: true });
    // The action ran once: the second answer is the retained outcome of a
    // request whose write landed, which is what `replayed: true` now means.
    expect(executions).toBe(1);
  });

  it("holds the returned mutation unconfirmed after flush failure and refuses to execute the retry", async () => {
    stale = true; // somebody else's write landed first → 409 on the flush
    const failed = await call("key=k-fail&tag=one");
    expect(failed.status).toBe(409);
    expect(executions).toBe(1);

    // This product flush failure cannot prove that every already returned
    // native effect rolled back. A current retry is a refusal, not re-execution.
    stale = false;
    const retry = await body(await call("key=k-fail&tag=one"));
    expect(retry.result).toMatchObject({ ok: false, data: { tag: "one" }, error: expect.stringMatching(/^persistence_unconfirmed:/) });
    expect(retry.idempotency).toMatchObject({ applied: true, replayed: false });
    expect(executions).toBe(1);

    const repeated = await body(await call("key=k-fail&tag=one"));
    expect(repeated.result).toEqual(retry.result);
    expect(repeated.idempotency).toMatchObject({ replayed: false });
    expect(executions).toBe(1);
  });

  it("uncertain settlement still enforces current role, changed input and tenant boundaries", async () => {
    stale = true; expect((await call("key=k-scoped&tag=one")).status).toBe(409);
    stale = false;
    const conflict = await body(await call("key=k-scoped&tag=two"));
    expect(conflict.result?.error).toMatch(/^idempotency_conflict:/); expect(executions).toBe(1);
    TABLES.members[0].role = "viewer";
    const demoted = await body(await call("key=k-scoped&tag=one"));
    expect(demoted.result?.error).toMatch(/^role_denied:/); expect(executions).toBe(1);
    TABLES.members[0].role = "admin"; TABLES.members[0].workspace_id = "foreign-workspace";
    const foreign = await body(await call("key=k-scoped&tag=one"));
    expect(foreign.result?.ok).toBe(false); expect(executions).toBe(1);
    TABLES.members[0].workspace_id = "ws-1";
    const original = await body(await call("key=k-scoped&tag=one"));
    expect(original.result?.error).toMatch(/^persistence_unconfirmed:/); expect(original.idempotency?.replayed).toBe(false);
    expect(executions).toBe(1);
  });

  it("refuses a second request under the same key while the first is committing", async () => {
    let release!: () => void;
    flushGate = new Promise<void>((resolve) => {
      release = resolve;
    });

    const ranFirst = new Promise<void>((resolve) => {
      ran = resolve;
    });
    const first = call("key=k-race&tag=one");
    await ranFirst; // the action has run; its outcome is pending, not retained

    const ranSecond = new Promise<void>((resolve) => {
      ran = resolve;
    });
    const second = call("key=k-race&tag=one");
    await ranSecond; // …and the second request was answered while it still was

    // Both responses are settled only after the gate opens — the second
    // request's *answer* was decided above, but `route()` still owes it the
    // same flush, which is the very write being held.
    release();
    const [committed, inFlight] = await Promise.all([first, second].map(async (r) => body(await r)));

    expect(inFlight.result?.ok).toBe(false);
    expect(inFlight.result?.error).toMatch(/^idempotency_in_flight:/);
    expect(inFlight.idempotency).toMatchObject({ applied: true, replayed: false });
    // Never a third thing: it neither replayed an uncommitted outcome nor ran
    // the action a second time behind the first one's back.
    expect(executions).toBe(1);
    expect(committed.result?.ok).toBe(true);

    // Once the first request committed, the same retry is an ordinary replay.
    flushGate = null;
    const replay = await body(await call("key=k-race&tag=one"));
    expect(replay.idempotency).toMatchObject({ replayed: true });
    expect(executions).toBe(1);
  });

  it("still refuses a different payload under the same key", async () => {
    await call("key=k-conflict&tag=one");
    const conflicting = await body(await call("key=k-conflict&tag=two"));
    expect(conflicting.result?.error).toMatch(/^idempotency_conflict:/);
    expect(executions).toBe(1);
  });

  it("says on the wire what a replay is worth", async () => {
    const { idempotency } = await body(await call("key=k-note&tag=one"));
    const report = idempotency as IdempotencyReport;
    expect(report).toMatchObject({ scope: "process", bestEffort: true, windowMs: 600_000 });
    expect(report.note).toMatch(/retained only once that request's own durable write has succeeded/);
    expect(report.note).toMatch(/idempotency_in_flight/);
    expect(report.note).toMatch(/this server process/);
  });
});
