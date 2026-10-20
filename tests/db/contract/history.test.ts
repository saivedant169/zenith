/**
 * The history half of the store contract: revisions and their manifests,
 * deployments, and the deployment event log.
 *
 * The first block is the contract every implementation must keep, run against
 * every factory in `./factories.ts` — a revision's manifest is reachable but
 * never serialised, a deployment round-trips its promoted columns, `readEvents`
 * honours `afterSeq`, and `reset()` takes all three with it.
 *
 * The second block is the part that only means something over a shared
 * database, so it runs only when `ZENITH_CONTRACT_POSTGRES=1` names a real
 * project: two "instances" appending to one deployment's log must produce one
 * dense sequence, a manifest must survive a cold cache, and a write against a
 * row somebody else already moved must be a 409 rather than a silent overwrite.
 *
 *   export NEXT_PUBLIC_SUPABASE_URL=… SUPABASE_SERVICE_ROLE_KEY=… \
 *   ZENITH_CONTRACT_POSTGRES=1 npx vitest run tests/db/contract/history.test.ts
 */
import { afterAll, describe, expect, it } from "vitest";
import type {
  Deployment,
  Environment,
  Manifest,
  Member,
  Project,
  Revision,
  Workspace,
} from "@/lib/domain/types";
import type { Store } from "@/lib/db/types";
import {
  CONTRACT_PREFIX,
  cleanupPostgresContract,
  contractStores,
  postgresContractEnabled,
} from "./_shared";

/* --------------------------------- fixtures -------------------------------- */

const WS = `${CONTRACT_PREFIX}-ws`;
const MEMBER = `${CONTRACT_PREFIX}-mem`;
const PROJ = `${CONTRACT_PREFIX}-proj`;
const ENV = `${CONTRACT_PREFIX}-env`;
const REV = `${CONTRACT_PREFIX}-rev`;
const DEP = `${CONTRACT_PREFIX}-dep`;

const manifest = (serviceName: string): Manifest => ({
  version: 1,
  services: [
    {
      id: "svc-1",
      name: serviceName,
      kind: "web",
      source: { type: "image", image: "nginx:1.27" },
      size: "small",
      replicas: 1,
      port: 80,
      env: [],
      ownership: "managed",
    },
  ],
  resources: [],
  routes: [],
  bindings: [],
});

const workspace = (id: string): Workspace => ({
  id,
  name: "History",
  slug: `history-${id.slice(-6)}`,
  createdAt: "2026-01-01T00:00:00.000Z",
});

const member = (id: string, workspaceId: string): Member => ({
  id,
  workspaceId,
  name: "You",
  email: `${id}@contract.invalid`,
  role: "admin",
});

const project = (id: string, workspaceId: string): Project => ({
  id,
  workspaceId,
  name: "Atlas",
  slug: `atlas-${id.slice(-6)}`,
  workingManifest: manifest("web"),
  createdAt: "2026-01-01T00:00:00.000Z",
  origin: { type: "blank" },
});

const environment = (id: string, projectId: string): Environment => ({
  id,
  projectId,
  name: "sandbox",
  class: "sandbox",
  connectionId: `${CONTRACT_PREFIX}-conn`,
  region: "us-east-1",
  policies: { approvalRequired: false, allowStatefulDeletion: false },
  baseDomain: "atlas.zenith.test",
  createdAt: "2026-01-01T00:00:00.000Z",
});

const revision = (id: string, projectId: string, m: Manifest): Revision => ({
  id,
  projectId,
  number: 1,
  manifest: m,
  message: "first",
  author: { type: "user", id: MEMBER, name: "You" },
  createdAt: "2026-01-01T00:00:00.000Z",
});

const deployment = (
  id: string,
  projectId: string,
  environmentId: string,
  revisionId: string
): Deployment => ({
  id,
  projectId,
  environmentId,
  revisionId,
  status: "applying",
  steps: [],
  outputs: [],
  changeSummary: "1 service created",
  estCostDeltaUsd: 0,
  actor: { type: "user", id: MEMBER, name: "You" },
  createdAt: "2026-01-01T00:00:00.000Z",
});

/** Wait for the store's writes to land; a no-op on the file store. */
const settle = (store: Store): Promise<unknown> =>
  Promise.resolve((store as { flushAsync?: () => Promise<boolean> }).flushAsync?.());

afterAll(cleanupPostgresContract);

/* ------------------------------ the contract ------------------------------- */

describe.each(contractStores)("history contract — $name", ({ store }) => {
  it("seeds a workspace, a project and an environment", async () => {
    store.reset();
    store.db().workspaces.push(workspace(WS));
    store.db().members.push(member(MEMBER, WS));
    store.db().projects.push(project(PROJ, WS));
    store.db().environments.push(environment(ENV, PROJ));
    store.save(PROJ);
    store.flush();
    await settle(store);
    expect(store.db().projects.map((p) => p.id)).toEqual([PROJ]);
  });

  it("round-trips a revision and its manifest", async () => {
    store.db().revisions.push(revision(REV, PROJ, manifest("web")));
    store.save(PROJ);
    store.flush();
    await settle(store);

    expect(store.revisionManifest(REV)?.services[0].name).toBe("web");
    // The property still reads, through the accessor, off the record itself.
    expect(store.db().revisions[0].manifest.services[0].name).toBe("web");
    expect(store.db().revisions[0].number).toBe(1);
  });

  it("keeps the manifest accessor non-enumerable and out of serialisation", () => {
    const r = store.db().revisions[0];
    const desc = Object.getOwnPropertyDescriptor(r, "manifest");
    expect(desc?.enumerable).toBe(false);
    expect(typeof desc?.get).toBe("function");
    expect(typeof desc?.set).toBe("function");
    expect(Object.keys(r)).not.toContain("manifest");

    const serialised = JSON.stringify(store.db().revisions);
    expect(serialised).not.toContain('"manifest"');
    expect(JSON.parse(serialised)[0].manifest).toBeUndefined();
  });

  it("writes an assigned manifest through", async () => {
    store.db().revisions[0].manifest = manifest("web-2");
    expect(store.revisionManifest(REV)?.services[0].name).toBe("web-2");
    await settle(store);
    expect(store.db().revisions[0].manifest.services[0].name).toBe("web-2");
  });

  it("inserts and then updates a deployment", async () => {
    store.db().deployments.push(deployment(DEP, PROJ, ENV, REV));
    store.save(PROJ);
    store.flush();
    await settle(store);
    expect(store.db().deployments[0].status).toBe("applying");

    const d = store.db().deployments[0];
    d.status = "succeeded";
    d.endedAt = "2026-01-01T00:05:00.000Z";
    store.save(PROJ);
    store.flush();
    await settle(store);
    expect(store.db().deployments[0].status).toBe("succeeded");
    expect(store.db().deployments[0].endedAt).toBe("2026-01-01T00:05:00.000Z");
  });

  it("appendEvent / readEvents honours afterSeq", async () => {
    for (let seq = 0; seq < 4; seq++)
      store.appendEvent({
        ts: new Date(1_700_000_000_000 + seq * 1000).toISOString(),
        deploymentId: DEP,
        seq,
        type: "log",
        stepId: "s0",
        line: `line ${seq}`,
        stream: "info",
      });
    await settle(store);

    expect(store.readEvents(DEP).map((e) => e.seq)).toEqual([0, 1, 2, 3]);
    expect(store.readEvents(DEP, 1).map((e) => e.seq)).toEqual([2, 3]);
    expect(store.readEvents(DEP, 3)).toEqual([]);
    expect(store.readEvents(`${CONTRACT_PREFIX}-nobody`)).toEqual([]);
    const [first] = store.readEvents(DEP);
    expect(first).toMatchObject({ deploymentId: DEP, type: "log", stepId: "s0", stream: "info" });
  });

  it("reset drops revisions, deployments, events and manifests", async () => {
    store.reset();
    await settle(store);
    expect(store.db().revisions).toEqual([]);
    expect(store.db().deployments).toEqual([]);
    expect(store.readEvents(DEP)).toEqual([]);
    expect(store.revisionManifest(REV)).toBeUndefined();
  });
});

/* --------------------------- the shared-database part ---------------------- */

const WS2 = `${CONTRACT_PREFIX}-ws2`;
const OTHER = `${CONTRACT_PREFIX}-wsx`;
const PROJ2 = `${CONTRACT_PREFIX}-proj2`;
const ENV2 = `${CONTRACT_PREFIX}-env2`;
const REV2 = `${CONTRACT_PREFIX}-rev2`;
const DEP2 = `${CONTRACT_PREFIX}-dep2`;

const pgStore = (): Store =>
  contractStores.find((s) => s.name === "PostgresStore")!.store;

describe.skipIf(!postgresContractEnabled())("history contract — Postgres only", () => {
  const user = { id: MEMBER, email: `${MEMBER}@contract.invalid` };

  it("seeds a second workspace to work in", async () => {
    const store = pgStore();
    store.reset();
    store.db().workspaces.push(workspace(WS2));
    store.db().members.push(member(MEMBER, WS2));
    store.db().projects.push(project(PROJ2, WS2));
    store.db().environments.push(environment(ENV2, PROJ2));
    store.db().revisions.push(revision(REV2, PROJ2, manifest("api")));
    store.db().deployments.push(deployment(DEP2, PROJ2, ENV2, REV2));
    store.save(PROJ2);
    store.flush();
    await settle(store);
    const { flushHistory } = await import("@/lib/db/pg/history");
    await flushHistory();
  });

  it("promotes the indexed columns and leaves them out of data", async () => {
    const { pgClient } = await import("@/lib/db/postgres-store");
    const { data } = await pgClient().from("deployments").select("*").eq("id", DEP2);
    const row = (data ?? [])[0] as Record<string, unknown> | undefined;
    expect(row).toBeDefined();
    expect(row).toMatchObject({
      workspace_id: WS2,
      project_id: PROJ2,
      environment_id: ENV2,
      revision_id: REV2,
      status: "applying",
    });
    const bag = row!.data as Record<string, unknown>;
    expect(bag.projectId).toBeUndefined();
    expect(bag.status).toBeUndefined();
    expect(bag.changeSummary).toBe("1 service created");

    const rev = await pgClient().from("revisions").select("*").eq("id", REV2);
    const revRow = (rev.data ?? [])[0] as Record<string, unknown>;
    expect(revRow.number).toBe(1);
    // The manifest is in cold storage, never in the revision row.
    expect((revRow.data as Record<string, unknown>).manifest).toBeUndefined();
    const man = await pgClient()
      .from("revision_manifests")
      .select("manifest")
      .eq("revision_id", REV2);
    expect(((man.data ?? [])[0] as { manifest: Manifest }).manifest.services[0].name).toBe("api");
  });

  it("reads a manifest back through the accessor with a cold cache", async () => {
    const { flushHistory, resetHistoryCaches } = await import("@/lib/db/pg/history");
    const { pgClient } = await import("@/lib/db/postgres-store");
    const store = pgStore();
    // Make sure the Postgres accessor owns the property before the table is
    // changed underneath it — the file store seals manifests too, and whichever
    // reaches a freshly pushed revision first attaches its own.
    expect(store.revisionManifest(REV2)?.services[0].name).toBe("api");
    await flushHistory();

    // Change cold storage and nothing else. A read that still answers "api" is
    // reading something other than `revision_manifests`.
    await pgClient()
      .from("revision_manifests")
      .update({ manifest: manifest("api-from-table") })
      .eq("revision_id", REV2);
    resetHistoryCaches(); // what a freshly started instance knows: nothing

    expect(store.db().revisions[0].manifest.services[0].name).toBe("api-from-table");
    expect(store.revisionManifest(REV2)?.services[0].name).toBe("api-from-table");
  });

  it("assigns a dense seq per deployment across two instances", async () => {
    const store = pgStore();
    const { flushHistory, nextEventSeq, readEventsAsync, resetHistoryCaches } = await import(
      "@/lib/db/pg/history"
    );
    const emit = (seq: number, line: string) =>
      store.appendEvent({
        ts: "2026-01-01T00:00:00.000Z",
        deploymentId: DEP2,
        seq,
        type: "log",
        stepId: "s0",
        line,
        stream: "info",
      });

    // Instance A.
    for (const line of ["a0", "a1", "a2"]) emit(nextEventSeq(DEP2), line);
    await flushHistory();

    // Instance B: no counter, no tail. It must resume after what the table
    // holds rather than starting again at zero.
    resetHistoryCaches();
    expect(nextEventSeq(DEP2)).toBe(3);
    emit(3, "b3");
    await flushHistory();

    // An instance that guesses a number somebody already took: the insert
    // retries from max(seq) and the event ends up with the number it really got.
    resetHistoryCaches();
    const stale = {
      ts: "2026-01-01T00:00:00.000Z",
      deploymentId: DEP2,
      seq: 0,
      type: "log" as const,
      stepId: "s0",
      line: "collision",
      stream: "info" as const,
    };
    store.appendEvent(stale);
    await flushHistory();
    // It asked for 0, the table said 0..3 are taken, so it got 4 — and the
    // object carries the number the SSE cursor will actually see.
    expect(stale.seq).toBe(4);

    const all = await readEventsAsync(DEP2);
    expect(all.map((e) => e.seq)).toEqual([0, 1, 2, 3, 4]); // dense, no gaps
    expect(all.map((e) => (e.type === "log" ? e.line : e.type))).toEqual([
      "a0",
      "a1",
      "a2",
      "b3",
      "collision",
    ]);
    expect((await readEventsAsync(DEP2, 3)).map((e) => e.seq)).toEqual([4]);
    expect(await readEventsAsync(DEP2, 4)).toEqual([]);
  });

  it("refuses a write against a row another instance already moved", async () => {
    const { loadSnapshot, pgClient } = await import("@/lib/db/postgres-store");
    const { runWithSnapshot } = await import("@/lib/db/request-snapshot");
    const store = pgStore();

    // Two instances, each with its own baseline of the same row.
    const a = await loadSnapshot(pgClient(), user);
    const b = await loadSnapshot(pgClient(), user);

    await runWithSnapshot(a, async () => {
      const d = a.data.deployments.find((x) => x.id === DEP2)!;
      d.status = "verifying";
      store.save(PROJ2);
      await settle(store);
    });

    await expect(
      runWithSnapshot(b, async () => {
        const d = b.data.deployments.find((x) => x.id === DEP2)!;
        d.status = "failed";
        store.save(PROJ2);
        await settle(store);
      })
    ).rejects.toMatchObject({ status: 409 });

    const { data } = await pgClient().from("deployments").select("status").eq("id", DEP2);
    expect(((data ?? [])[0] as { status: string }).status).toBe("verifying");
  });

  it("refuses a delete against a row another instance already moved", async () => {
    const { loadSnapshot, pgClient } = await import("@/lib/db/postgres-store");
    const { runWithSnapshot } = await import("@/lib/db/request-snapshot");
    const store = pgStore();
    const a = await loadSnapshot(pgClient(), user);
    const b = await loadSnapshot(pgClient(), user);

    await runWithSnapshot(a, async () => {
      a.data.deployments.find((x) => x.id === DEP2)!.status = "succeeded";
      store.save(PROJ2);
      await settle(store);
    });

    // b still holds the older version; its delete must not erase a's update
    await expect(
      runWithSnapshot(b, async () => {
        b.data.deployments = b.data.deployments.filter((x) => x.id !== DEP2);
        store.save(PROJ2);
        await settle(store);
      })
    ).rejects.toMatchObject({ status: 409 });

    const { data } = await pgClient().from("deployments").select("status").eq("id", DEP2);
    expect(((data ?? [])[0] as { status: string }).status).toBe("succeeded");
  });

  it("a stale start-projection repair is refused, and a fresh retry converges without undoing the worker's status", async () => {
    // projectAcknowledgedStart (src/lib/bridge/projection.ts) sets workflowStartedAt and saves through this same snapshot path
    const { loadSnapshot, pgClient } = await import("@/lib/db/postgres-store");
    const { runWithSnapshot } = await import("@/lib/db/request-snapshot");
    const store = pgStore();
    const repair = await loadSnapshot(pgClient(), user);
    const worker = await loadSnapshot(pgClient(), user);
    const startedAt = "2026-10-21T00:00:00.000Z";

    await runWithSnapshot(worker, async () => {
      worker.data.deployments.find((x) => x.id === DEP2)!.status = "applying";
      store.save(PROJ2);
      await settle(store);
    });
    await expect(
      runWithSnapshot(repair, async () => {
        repair.data.deployments.find((x) => x.id === DEP2)!.workflowStartedAt = startedAt;
        store.save(PROJ2);
        await settle(store);
      })
    ).rejects.toMatchObject({ status: 409 });

    const retry = await loadSnapshot(pgClient(), user);
    await runWithSnapshot(retry, async () => {
      const d = retry.data.deployments.find((x) => x.id === DEP2)!;
      expect(d.workflowStartedAt).toBeUndefined();
      d.workflowStartedAt = startedAt;
      store.save(PROJ2);
      await settle(store);
    });
    const { data } = await pgClient().from("deployments").select("status, data").eq("id", DEP2);
    const row = (data ?? [])[0] as { status: string; data: { workflowStartedAt?: string } };
    expect(row.status).toBe("applying");
    expect(row.data.workflowStartedAt).toBe(startedAt);
  });

  it("bumps the change feed for the workspace a deployment belongs to", async () => {
    const { pgClient } = await import("@/lib/db/postgres-store");
    const { data } = await pgClient()
      .from("workspace_versions")
      .select("workspace_id,version,touched_projects")
      .eq("workspace_id", WS2);
    const row = (data ?? [])[0] as
      | { version: number; touched_projects: string[] | null }
      | undefined;
    expect(row).toBeDefined();
    expect(row!.version).toBeGreaterThan(0);
    expect(row!.touched_projects ?? []).toContain(PROJ2);
  });

  it("keeps rows outside the snapshot's scope when it resets", async () => {
    const { pgClient } = await import("@/lib/db/postgres-store");
    const client = pgClient();
    // A row this process's snapshot never loaded. `reset()` is scoped to what
    // the snapshot holds, so it must still be there afterwards.
    await client.from("workspaces").insert({
      id: OTHER,
      workspace_id: OTHER,
      slug: `other-${OTHER.slice(-6)}`,
      name: "Somebody else",
      created_at: "2026-01-01T00:00:00.000Z",
      data: {},
      version: 1,
    });
    await client.from("projects").insert({
      id: `${OTHER}-proj`,
      workspace_id: OTHER,
      slug: "other",
      name: "Other",
      created_at: "2026-01-01T00:00:00.000Z",
      data: {},
      version: 1,
    });
    await client.from("revisions").insert({
      id: `${OTHER}-rev`,
      workspace_id: OTHER,
      project_id: `${OTHER}-proj`,
      number: 1,
      created_at: "2026-01-01T00:00:00.000Z",
      data: {},
      version: 1,
    });

    const store = pgStore();
    store.reset();
    await settle(store);

    const survived = await client.from("revisions").select("id").eq("workspace_id", OTHER);
    expect((survived.data ?? []).map((r) => (r as { id: string }).id)).toEqual([`${OTHER}-rev`]);
  });
});
