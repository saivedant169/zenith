/**
 * PROD-DUR-01 runner crash window: between "job queued" and "caller learned its id".
 * With an idempotency key the job id is deterministic, so a retry attaches to the
 * already queued job instead of queueing a second effect. Memory store, PGlite and
 * (when ZENITH_TEST_PLATFORM_PG_URL is set) real PostgreSQL with two independent
 * stores racing on one identity.
 */
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { openPlatformDb, repos, type PlatformDbHandle } from "@/lib/controlplane/db";
import { enqueueRunnerJob, type EnqueueRunnerJobInput } from "@/lib/runners/dispatch";
import { createPlatformRunnerStore } from "@/lib/runners/db/pg-store";
import { registerHandler } from "@/lib/runners/http";
import { createMemoryRunnerStore } from "@/lib/runners/memory-store";
import type { RunnerStore } from "@/lib/runners/ports";
import { createPlane, registerFakeAgent, runnerGrant, teardownPlane } from "./_support";

const PG_URL = process.env.ZENITH_TEST_PLATFORM_PG_URL?.trim();
const LANES = [{ name: "memory" as const }, { name: "pglite" as const }, ...(PG_URL ? [{ name: "postgres" as const }] : [])];
const id = (prefix: string) => `${prefix}_${randomUUID()}`;

describe.each(LANES)("idempotent runner enqueue [$name]", (lane) => {
  let db: PlatformDbHandle | undefined, db2: PlatformDbHandle | undefined;
  let store: RunnerStore, store2: RunnerStore;
  beforeAll(async () => {
    if (lane.name === "memory") { store = createMemoryRunnerStore(); store2 = store; return; }
    db = await openPlatformDb({ kind: lane.name, url: lane.name === "postgres" ? PG_URL : undefined, migrate: true, max: 4 });
    db2 = lane.name === "postgres" ? await openPlatformDb({ kind: "postgres", url: PG_URL, migrate: true, max: 4 }) : db;
    store = createPlatformRunnerStore(db);
    store2 = createPlatformRunnerStore(db2);
  }, 60_000);
  afterAll(async () => { if (db2 && db2 !== db) await db2.close(); await db?.close(); });
  afterEach(() => teardownPlane());

  async function fixture(operationCount = 1) {
    const plane = await createPlane("real", {}, store);
    const workspaceId = id("ws");
    const operations = Array.from({ length: operationCount }, () => id("op"));
    if (db) {
      for (const operationId of operations) {
        await repos.operations.create(db, { id: operationId, workspaceId, principal: { kind: "user", id: "fixture-admin", name: "Fixture" },
          proposal: { capability: "infrastructure.observe", scope: { workspaceId }, input: {}, summary: "Idempotent enqueue fixture", details: [], risk: "low" } });
      }
    }
    const agent = await registerFakeAgent(plane, registerHandler("runner"), { kind: "runner", workspaceId });
    const input = async (operationId: string, over: Partial<EnqueueRunnerJobInput> = {}): Promise<EnqueueRunnerJobInput> => ({
      workspaceId, runnerId: agent.id, operationId, capability: "infrastructure.observe", kind: "probe.tcp",
      payload: { host: "10.0.0.1", port: 22, timeoutMs: 2000 },
      grant: await runnerGrant(plane, { runnerId: agent.id, workspaceId, operationId, capability: "infrastructure.observe" }), ...over,
    });
    const jobs = (operationId: string) => store.jobs.listForOperation(workspaceId, operationId);
    return { plane, workspaceId, operations, input, jobs, agent };
  }

  it("without a key every enqueue is a new job (the control)", async () => {
    const f = await fixture();
    const a = await enqueueRunnerJob(await f.input(f.operations[0]), f.plane.rt);
    const b = await enqueueRunnerJob(await f.input(f.operations[0]), f.plane.rt);
    expect(a).not.toBe(b);
    expect(await f.jobs(f.operations[0])).toHaveLength(2);
  });

  it("a retry after a lost enqueue acknowledgement attaches to the queued job", async () => {
    const f = await fixture();
    const first = await enqueueRunnerJob(await f.input(f.operations[0], { idempotencyKey: "tofu.apply:approved-digest" }), f.plane.rt);
    // the process "died" before the caller saw `first`; the retry carries a fresh grant but the same identity
    const retry = await enqueueRunnerJob(await f.input(f.operations[0], { idempotencyKey: "tofu.apply:approved-digest" }), f.plane.rt);
    expect(retry).toBe(first);
    expect(await f.jobs(f.operations[0])).toHaveLength(1);
  });

  it("the identity is scoped by operation and by key", async () => {
    const f = await fixture(2);
    const a = await enqueueRunnerJob(await f.input(f.operations[0], { idempotencyKey: "k" }), f.plane.rt);
    const otherOperation = await enqueueRunnerJob(await f.input(f.operations[1], { idempotencyKey: "k" }), f.plane.rt);
    const otherKey = await enqueueRunnerJob(await f.input(f.operations[0], { idempotencyKey: "k2" }), f.plane.rt);
    expect(new Set([a, otherOperation, otherKey]).size).toBe(3);
  });

  it("a definite failure lets the retry queue a new generation, while a succeeded or running job is attached", async () => {
    const f = await fixture();
    const op = f.operations[0];
    const first = await enqueueRunnerJob(await f.input(op, { idempotencyKey: "gen" }), f.plane.rt);
    const settle = async (jobId: string, status: "failed" | "succeeded") => {
      const claimed = await store.jobs.claimNext({ workspaceId: f.workspaceId, agentId: f.agent.id, max: 5, leaseMs: 30_000 });
      expect(claimed.map((j) => j.id)).toContain(jobId);
      expect(await store.jobs.settle({ workspaceId: f.workspaceId, agentId: f.agent.id, jobId, status, ...(status === "failed" ? { error: "definite failure" } : {}) })).toBe(true);
    };
    // queued: attach
    expect(await enqueueRunnerJob(await f.input(op, { idempotencyKey: "gen" }), f.plane.rt)).toBe(first);
    await settle(first, "failed");
    const second = await enqueueRunnerJob(await f.input(op, { idempotencyKey: "gen" }), f.plane.rt);
    expect(second).not.toBe(first);
    expect(await enqueueRunnerJob(await f.input(op, { idempotencyKey: "gen" }), f.plane.rt)).toBe(second);
    await settle(second, "succeeded");
    // succeeded: a retry never queues a second effect
    expect(await enqueueRunnerJob(await f.input(op, { idempotencyKey: "gen" }), f.plane.rt)).toBe(second);
    expect(await f.jobs(op)).toHaveLength(2);
  });

  it("a job cancelled after the agent claimed it is attached, never queued again; one cancelled before any claim is not", async () => {
    const f = await fixture(2);
    // cancelled while still queued: the agent never received it, so a new generation is a definite retry
    const unclaimed = await enqueueRunnerJob(await f.input(f.operations[0], { idempotencyKey: "tofu.apply:digest" }), f.plane.rt);
    expect(await store.jobs.cancel(f.workspaceId, unclaimed, "the job was not claimed before its expiry")).not.toBeNull();
    expect(await enqueueRunnerJob(await f.input(f.operations[0], { idempotencyKey: "tofu.apply:digest" }), f.plane.rt)).not.toBe(unclaimed);
    // cancelled after hand-over (a waiter gave up on a lapsed lease): the agent may still be applying
    const handed = await enqueueRunnerJob(await f.input(f.operations[1], { idempotencyKey: "tofu.apply:digest" }), f.plane.rt);
    expect((await store.jobs.claimNext({ workspaceId: f.workspaceId, agentId: f.agent.id, max: 5, leaseMs: 30_000 })).map((j) => j.id)).toContain(handed);
    expect(await store.jobs.cancel(f.workspaceId, handed, "the agent did not report before the job's lease ended")).not.toBeNull();
    expect(await enqueueRunnerJob(await f.input(f.operations[1], { idempotencyKey: "tofu.apply:digest" }), f.plane.rt)).toBe(handed);
    expect(await f.jobs(f.operations[1])).toHaveLength(1);
  });

  it("two workers racing on one identity queue exactly one job", async () => {
    const f = await fixture();
    const rt2 = { ...f.plane.rt, store: store2 };
    const [a, b] = await Promise.all([
      enqueueRunnerJob(await f.input(f.operations[0], { idempotencyKey: "race" }), f.plane.rt),
      enqueueRunnerJob(await f.input(f.operations[0], { idempotencyKey: "race" }), rt2),
    ]);
    expect(a).toBe(b);
    expect(await f.jobs(f.operations[0])).toHaveLength(1);
  });
});
