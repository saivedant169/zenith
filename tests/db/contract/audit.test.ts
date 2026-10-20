/**
 * The audit log, as a contract both stores keep.
 *
 * The file store walks `audit.jsonl` backwards from a byte offset; the Postgres
 * store runs `order by seq desc` from a sequence number. Nothing above the
 * store is allowed to know which — so this suite asserts the *promises*, never
 * the mechanism: newest first, filters that mean the same thing in both, a
 * cursor that is opaque and stable while the log grows underneath it, a count
 * that agrees with the rows, and a workspace that cannot read another's log.
 *
 * The Postgres row only appears with `ZENITH_CONTRACT_POSTGRES=1` plus real
 * keys (see `./factories.ts`); everywhere else this is the file store alone and
 * nothing here touches a network.
 */
import { afterAll, describe, expect, it } from "vitest";
import type { AuditEvent, Workspace } from "@/lib/domain/types";
import type { Store } from "@/lib/db/types";
import { CONTRACT_PREFIX, cleanupPostgresContract, contractStores, postgresContractEnabled } from "./_shared";

/** Two workspaces, so "this tenant's log" is a claim with a counter-example. */
const WS_A = `${CONTRACT_PREFIX}-audit-a`;
const WS_B = `${CONTRACT_PREFIX}-audit-b`;
const FOREIGN = `${CONTRACT_PREFIX}-audit-never-loaded`;
const P1 = "proj-audit-1";
const P2 = "proj-audit-2";

const workspace = (id: string, name: string): Workspace => ({
  id,
  name,
  slug: id,
  createdAt: "2026-01-01T00:00:00.000Z",
});

/** Fixed timestamps: `from`/`to` is a string compare in one store and a `timestamptz` in the other. */
const at = (n: number): string => new Date(Date.UTC(2026, 0, 2, 0, 0, n)).toISOString();

interface Seed {
  id: string;
  workspaceId: string;
  projectId?: string;
  environmentId?: string;
  actionId: string;
  actorType: AuditEvent["actor"]["type"];
  result: AuditEvent["result"];
  second: number;
}

/** Appended in this order, so "newest first" is this list reversed. */
const SEEDS: Seed[] = [
  { id: `${CONTRACT_PREFIX}-aud-0`, workspaceId: WS_A, projectId: P1, environmentId: "env-1", actionId: "deploy.start", actorType: "user", result: "ok", second: 0 },
  { id: `${CONTRACT_PREFIX}-aud-1`, workspaceId: WS_A, projectId: P1, actionId: "deploy.finish", actorType: "navigator", result: "ok", second: 1 },
  { id: `${CONTRACT_PREFIX}-aud-2`, workspaceId: WS_A, projectId: P2, actionId: "system.addService", actorType: "user", result: "error", second: 2 },
  { id: `${CONTRACT_PREFIX}-aud-3`, workspaceId: WS_A, projectId: P1, actionId: "system.addService", actorType: "system", result: "denied", second: 3 },
  { id: `${CONTRACT_PREFIX}-aud-4`, workspaceId: WS_B, projectId: P1, actionId: "deploy.start", actorType: "user", result: "ok", second: 4 },
  { id: `${CONTRACT_PREFIX}-aud-5`, workspaceId: WS_A, actionId: "workspace.rename", actorType: "user", result: "ok", second: 5 },
];

const eventFor = (s: Seed): AuditEvent => ({
  ts: at(s.second),
  id: s.id,
  workspaceId: s.workspaceId,
  ...(s.projectId ? { projectId: s.projectId } : {}),
  ...(s.environmentId ? { environmentId: s.environmentId } : {}),
  actor: { type: s.actorType, id: `actor-${s.actorType}`, name: "You" },
  actionId: s.actionId,
  input: { seed: s.id },
  result: s.result,
  summary: `seeded ${s.id}`,
  ...(s.result === "error" ? { error: "it did not work" } : {}),
});

const ids = (events: AuditEvent[]): string[] => events.map((e) => e.id);

/**
 * One step of the scenario. Ordered and sharing one store, like
 * `./store-contract.test.ts` — this is a story about one log, not a set of
 * independent cases.
 */
interface Step {
  name: string;
  run: (store: Store) => void;
  /** Skip the step unless the implementation under test is this one. */
  only?: string;
}

const SCENARIO: Step[] = [
  {
    name: "two workspaces exist, and the log starts empty",
    run: (store) => {
      // The Postgres store answers audit reads out of the workspaces its
      // snapshot holds, so the tenants have to exist before their log does.
      store.reset({ workspaces: [workspace(WS_A, "Audit A"), workspace(WS_B, "Audit B")] });
      store.flush();
      expect(store.readAudit()).toEqual([]);
      expect(store.countAudit()).toEqual({ total: 0, exact: true });
    },
  },
  {
    name: "appends, and reads them back newest first",
    run: (store) => {
      for (const seed of SEEDS) store.appendAudit(eventFor(seed));
      expect(ids(store.readAudit())).toEqual([`${CONTRACT_PREFIX}-aud-5`, `${CONTRACT_PREFIX}-aud-4`, `${CONTRACT_PREFIX}-aud-3`, `${CONTRACT_PREFIX}-aud-2`, `${CONTRACT_PREFIX}-aud-1`, `${CONTRACT_PREFIX}-aud-0`]);
    },
  },
  {
    name: "hands back every field the caller reads",
    run: (store) => {
      const row = store.readAudit({ actionId: "deploy.start", projectId: P1, workspaceId: WS_A })[0];
      expect(row).toEqual(eventFor(SEEDS[0]));
      // An absent optional field is absent, never null — the activity screen
      // and the audit route both serialise this object straight into a body.
      expect("projectId" in store.readAudit({ actionId: "workspace.rename" })[0]).toBe(false);
      expect(store.readAudit({ result: "error" })[0].error).toBe("it did not work");
    },
  },
  {
    name: "filters mean the same thing in both stores",
    run: (store) => {
      const distinct = (filter: Parameters<Store["readAudit"]>[0]): string[] => [
        ...new Set(ids(store.readAudit(filter))),
      ];
      expect(distinct({ projectId: P1 })).toEqual([`${CONTRACT_PREFIX}-aud-4`, `${CONTRACT_PREFIX}-aud-3`, `${CONTRACT_PREFIX}-aud-1`, `${CONTRACT_PREFIX}-aud-0`]);
      expect(distinct({ environmentId: "env-1" })).toEqual([`${CONTRACT_PREFIX}-aud-0`]);
      expect(distinct({ actorType: "navigator" })).toEqual([`${CONTRACT_PREFIX}-aud-1`]);
      expect(distinct({ result: "denied" })).toEqual([`${CONTRACT_PREFIX}-aud-3`]);
      // A trailing dot is a prefix; anything else is an exact action id.
      expect(distinct({ actionId: "deploy." })).toEqual([`${CONTRACT_PREFIX}-aud-4`, `${CONTRACT_PREFIX}-aud-1`, `${CONTRACT_PREFIX}-aud-0`]);
      expect(distinct({ actionId: "deploy.start" })).toEqual([`${CONTRACT_PREFIX}-aud-4`, `${CONTRACT_PREFIX}-aud-0`]);
      // Both bounds are inclusive.
      expect(distinct({ from: at(1), to: at(3) })).toEqual([`${CONTRACT_PREFIX}-aud-3`, `${CONTRACT_PREFIX}-aud-2`, `${CONTRACT_PREFIX}-aud-1`]);
    },
  },
  {
    name: "the cursor is opaque, and stable while the log grows",
    run: (store) => {
      const first = store.readAuditPage({ workspaceId: WS_A, limit: 2 });
      expect(ids(first.events)).toEqual([`${CONTRACT_PREFIX}-aud-5`, `${CONTRACT_PREFIX}-aud-3`]);
      expect(typeof first.nextCursor).toBe("string");

      // A row appended after the cursor was minted belongs to a page that was
      // already served. Paging on must not shift the window or repeat a row.
      store.appendAudit(eventFor({ ...SEEDS[0], id: `${CONTRACT_PREFIX}-aud-6`, second: 6 }));

      const second = store.readAuditPage({ workspaceId: WS_A, limit: 2, cursor: first.nextCursor });
      expect(ids(second.events)).toEqual([`${CONTRACT_PREFIX}-aud-2`, `${CONTRACT_PREFIX}-aud-1`]);
      const third = store.readAuditPage({ workspaceId: WS_A, limit: 2, cursor: second.nextCursor });
      expect(ids(third.events)).toEqual([`${CONTRACT_PREFIX}-aud-0`]);
      // A short page is the end of the log, and says so by carrying no cursor.
      expect(third.nextCursor).toBeUndefined();
    },
  },
  {
    name: "counts agree with the rows, and stay exact as the log grows",
    run: (store) => {
      const count = (filter: Parameters<Store["countAudit"]>[0]) => store.countAudit(filter);
      expect(count({ workspaceId: WS_A })).toEqual({ total: 6, exact: true });
      expect(count({ workspaceId: WS_A, projectId: P1 })).toEqual({ total: 4, exact: true });
      expect(count({ workspaceId: WS_B })).toEqual({ total: 1, exact: true });

      store.appendAudit(eventFor({ ...SEEDS[4], id: `${CONTRACT_PREFIX}-aud-7`, second: 7 }));
      expect(count({ workspaceId: WS_B })).toEqual({ total: 2, exact: true });
      // A count ignores the page size — it is "how many match", not "how many fit".
      expect(count({ workspaceId: WS_B, limit: 1 })).toEqual({ total: 2, exact: true });
    },
  },
  {
    name: "one workspace cannot read another's log",
    run: (store) => {
      expect(ids(store.readAudit({ workspaceId: WS_B }))).toEqual([`${CONTRACT_PREFIX}-aud-7`, `${CONTRACT_PREFIX}-aud-4`]);
      expect(ids(store.readAudit({ workspaceId: WS_B })).includes(`${CONTRACT_PREFIX}-aud-0`)).toBe(false);
      // A workspace this caller never loaded is empty, not an error and not a
      // leak — the same answer a made-up id gets.
      expect(store.readAudit({ workspaceId: FOREIGN })).toEqual([]);
      expect(store.countAudit({ workspaceId: FOREIGN })).toEqual({ total: 0, exact: true });
    },
  },
  {
    // Last, because it deliberately re-appends a row the counts above rely on.
    // Postgres only: the unique index on `id` is what makes a retried append a
    // no-op, and `audit.jsonl` has no such thing — the file store writes a
    // second line, which is a wart this contract does not pretend away.
    name: "a retried append writes nothing twice",
    only: "PostgresStore",
    run: (store) => {
      const before = store.countAudit({ workspaceId: WS_A });
      store.appendAudit(eventFor(SEEDS[2]));
      expect(store.countAudit({ workspaceId: WS_A })).toEqual(before);
      expect(ids(store.readAudit({ workspaceId: WS_A })).filter((id) => id === `${CONTRACT_PREFIX}-aud-2`)).toEqual([
        `${CONTRACT_PREFIX}-aud-2`,
      ]);
    },
  },
];

/**
 * Delete exactly what this run wrote. `cleanupPostgresContract` covers the
 * Phase-2 tables; `audit_events` is this package's, so it is this file's to
 * clear — and it filters on the same per-run prefix, so a second suite running
 * against the same project is untouched.
 */
afterAll(async () => {
  if (!postgresContractEnabled()) return;
  const { pgClient } = await import("@/lib/db/postgres-store");
  await pgClient().from("audit_events").delete().like("workspace_id", `${CONTRACT_PREFIX}%`);
  const { closeRestBridge } = await import("@/lib/db/pg/sync-rest");
  closeRestBridge();
  await cleanupPostgresContract();
});

describe.each(contractStores)("audit contract — $name", ({ name, store }) => {
  for (const step of SCENARIO)
    // registered only on the store it applies to: a skipped case fails the PostgREST lane
    if (!step.only || step.only === name) it(step.name, async () => {
      step.run(store);
      // The file store's writes are already on disk; the Postgres store's
      // organisational writes are a round trip, and the next step must not
      // start before they land.
      await (store as { flushAsync?: () => Promise<boolean> }).flushAsync?.();
    });
});
