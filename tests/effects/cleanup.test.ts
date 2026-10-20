/**
 * PROD-DUR-08: external cleanup effects (the destructive apply of a reviewed destroy plan) use a durable
 * receipt and are never replayed blindly. Part one exercises the ledger helpers on the real control store;
 * part two drives the real destroy activities (C1 provider ports) with the ledger composed in, as
 * `composeExecutionActivities` does.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { PlatformDbHandle } from "@/lib/controlplane/db";
import * as operations from "@/lib/controlplane/db/repos/operations";
import * as leases from "@/lib/controlplane/db/repos/leases";
import { digest } from "@/lib/controlplane/digest";
import { acceptCleanupEffect, beginCleanupEffect, cleanupDedupKey, priorCleanupResult, uncertainCleanupEffect, type CleanupEffectScope } from "@/lib/effects/cleanup";
import { EffectTombstonedError, EffectUnresolvedError, createEffectLedger } from "@/lib/effects/ledger";
import { createRuntime } from "@/lib/execution/runtime";
import { createDestroyActivities, type DestroyProviderPorts, type TeardownInput, type TeardownResult } from "@/lib/execution/destroy";
import { LANES, openLane, uid } from "../controlplane/_support/harness";
import { createWorld, type World } from "../execution/fakes/world";
import { PROJECT, REVISION, webDbManifest } from "../execution/fakes/fixtures";
import { lease, seed } from "./_support";

describe.each(LANES)("cleanup effect helpers ($name)", (lane) => {
  let ctx: Awaited<ReturnType<typeof openLane>>;
  beforeAll(async () => { ctx = await openLane(lane); });
  afterAll(async () => { await ctx.close(); });

  const scopeOf = async (s: Awaited<ReturnType<typeof seed>>, planDigest = "p".repeat(64)): Promise<CleanupEffectScope> => {
    const l = await lease(ctx.db, s);
    return { workspaceId: s.workspaceId, operationId: s.operationId, environmentId: s.environmentId, provider: "kubernetes", planDigest, addresses: ["Deployment/ns/web", "Deployment/ns/api", "Deployment/ns/web"], fence: { scope: l.scope, token: l.fenceToken } };
  };

  it("keeps the address list out of the row: only its count and digest", async () => {
    const s = await seed(ctx.db);
    const scope = await scopeOf(s);
    const effect = await beginCleanupEffect(createEffectLedger(ctx.db), scope);
    expect(effect).toMatchObject({ family: "cleanup_apply", state: "pending", dedupKey: cleanupDedupKey(s.operationId, scope.planDigest), idempotencySupported: false,
      target: { planDigest: scope.planDigest, addressCount: 2, addressesDigest: digest(["Deployment/ns/api", "Deployment/ns/web"]) } });
    expect(JSON.stringify(effect.target)).not.toContain("Deployment/ns/web");
  });

  it("no effect before the first apply; a second begin is refused, never allowed to apply again", async () => {
    const s = await seed(ctx.db);
    const ledger = createEffectLedger(ctx.db);
    const scope = await scopeOf(s);
    expect(await priorCleanupResult(ledger, scope)).toBeUndefined();
    await beginCleanupEffect(ledger, scope);
    await expect(beginCleanupEffect(ledger, scope)).rejects.toBeInstanceOf(EffectUnresolvedError);
    await expect(priorCleanupResult(ledger, scope)).rejects.toBeInstanceOf(EffectUnresolvedError);
  });

  it("an accepted apply is answered from its saved result on every retry", async () => {
    const s = await seed(ctx.db);
    const ledger = createEffectLedger(ctx.db);
    const scope = await scopeOf(s);
    const effect = await beginCleanupEffect(ledger, scope);
    const accepted = await acceptCleanupEffect(ledger, effect, 7);
    expect(accepted.state).toBe("accepted");
    expect(await priorCleanupResult(ledger, scope)).toEqual({ deleted: 7 });
    expect(await priorCleanupResult(ledger, scope)).toEqual({ deleted: 7 });
  });

  it("a reply that arrives after the lease is gone is still recorded", async () => {
    const s = await seed(ctx.db);
    const ledger = createEffectLedger(ctx.db);
    const scope = await scopeOf(s);
    const effect = await beginCleanupEffect(ledger, scope);
    const held = await leases.current(ctx.db, scope.fence.scope);
    expect(held?.fenceToken).toBe(scope.fence.token);
    await leases.release(ctx.db, held!);
    const accepted = await acceptCleanupEffect(ledger, effect, 3);
    expect(accepted).toMatchObject({ state: "accepted", providerReceipt: { identity: { deleted: "3" } } });
  });

  it("only a still-pending effect becomes uncertain; an accepted one keeps its receipt", async () => {
    const s = await seed(ctx.db);
    const ledger = createEffectLedger(ctx.db);
    const scope = await scopeOf(s);
    const effect = await beginCleanupEffect(ledger, scope);
    await uncertainCleanupEffect(ledger, effect, "teardown outcome unconfirmed");
    expect((await ledger.get(s.workspaceId, effect.effectId))!.state).toBe("uncertain");
    await expect(priorCleanupResult(ledger, scope)).rejects.toBeInstanceOf(EffectUnresolvedError);

    const t = await seed(ctx.db);
    const tscope = await scopeOf(t, "q".repeat(64));
    const e2 = await beginCleanupEffect(ledger, tscope);
    const done = await acceptCleanupEffect(ledger, e2, 1);
    await uncertainCleanupEffect(ledger, done, "later evidence insert failed");
    expect((await ledger.get(t.workspaceId, e2.effectId))!.state).toBe("accepted");
  });

  it("a retired cleanup effect is refused for good", async () => {
    const s = await seed(ctx.db);
    const ledger = createEffectLedger(ctx.db);
    const scope = await scopeOf(s);
    const effect = await beginCleanupEffect(ledger, scope);
    await ledger.recordRejected(s.workspaceId, effect.effectId, "refused");
    await expect(priorCleanupResult(ledger, scope)).rejects.toBeInstanceOf(EffectTombstonedError);
    await expect(beginCleanupEffect(ledger, scope)).rejects.toBeInstanceOf(EffectTombstonedError);
  });

  it("a different plan digest is a different effect", async () => {
    const s = await seed(ctx.db);
    const ledger = createEffectLedger(ctx.db);
    const base = await scopeOf(s, "1".repeat(64));
    const a = await beginCleanupEffect(ledger, base);
    const b = await beginCleanupEffect(ledger, { ...base, planDigest: "2".repeat(64) });
    expect(a.effectId).not.toBe(b.effectId);
  });
});

/* ---------------------- the real destroy activities with the ledger composed in ---------------------- */

describe.each(LANES)("destroy apply is recorded, deduplicated and never replayed after an unknown outcome ($name)", (lane) => {
  const worlds: World[] = [];
  let db: PlatformDbHandle;
  // fresh ids per test: a persistent PostgreSQL lane keeps every row across tests and runs
  let ws: string;
  let op: string;
  let env: string;
  beforeEach(async () => {
    db = await lane.open();
    ws = uid("ws");
    op = uid("op");
    env = uid("env");
    // the platform operation the effect belongs to, and the live environment lease (fence 1, like the world's first acquire)
    await operations.create(db, { id: op, workspaceId: ws, principal: { kind: "user", id: uid("user"), name: "Alice" }, status: "approved",
      proposal: { capability: "infrastructure.destroy", scope: { workspaceId: ws, projectId: PROJECT, environmentId: env }, input: {}, summary: "Destroy", details: [], risk: "high" } });
    await leases.acquire(db, { scope: `env:${env}`, holder: "test-holder", ttlMs: 600_000, workspaceId: ws });
  });
  afterEach(async () => { worlds.splice(0).forEach((w) => w.dispose()); vi.restoreAllMocks(); await db.close(); });

  function setup() {
    const w = createWorld({ op: { id: op, workspaceId: ws, environmentId: env, capability: "infrastructure.destroy", status: "running",
      proposal: { capability: "infrastructure.destroy", scope: { workspaceId: ws, projectId: PROJECT, environmentId: env }, input: {}, summary: "Destroy", details: [], risk: "high" } } });
    worlds.push(w);
    w.product.base.workspace.id = ws;
    w.product.base.environment.id = env;
    w.product.base.environment.provider = "zenith";
    w.product.base.environment.deployedRevisionId = REVISION;
    const manifest = webDbManifest(); manifest.routes = []; manifest.bindings = []; manifest.resources = [];
    w.product.setManifest(manifest);
    const ledger = createEffectLedger(db);
    (w.deps as { effects?: typeof ledger }).effects = ledger;
    const calls: TeardownInput[] = [];
    let failApply = false;
    const transport = vi.fn(async (input: TeardownInput): Promise<TeardownResult> => {
      calls.push(input);
      if (!input.dryRun && failApply) throw new Error("connection reset by peer");
      return { deleted: ["Deployment/ns/web"], retained: [], skipped: [], uncertain: [] };
    });
    const session = { provider: "zenith", expiresAt: "2099-01-01T00:00:00Z" };
    const ports: DestroyProviderPorts = { teardownZenithEnvironment: transport, withZenithSession: async (_i, fn) => fn(session) };
    const activities = createDestroyActivities(createRuntime(w.deps), ports);
    return { w, ledger, activities, calls, failNextApply: () => { failApply = true; } };
  }
  async function reviewed() {
    const s = setup();
    const lease = await s.w.activities.acquireLease({ operationId: op, scope: `env:${env}`, ttlMs: 300_000 });
    const plan = await s.activities.planDestroyInfrastructure({ operationId: op, lease });
    s.w.broker.approval = { approved: true, rejected: false, approvalId: "human-fixture" };
    return { ...s, lease, plan, args: { operationId: op, lease, planDigest: plan.planDigest } };
  }
  const applies = (calls: TeardownInput[]) => calls.filter((c) => !c.dryRun).length;

  it("records the apply as an accepted cleanup effect with its result, and a retry returns that result without a second apply", async () => {
    const s = await reviewed();
    await expect(s.activities.applyDestroyInfrastructure(s.args)).resolves.toEqual({ deleted: 1 });
    expect(applies(s.calls)).toBe(1);
    const effect = await s.ledger.getByDedup(ws, "cleanup_apply", cleanupDedupKey(op, s.plan.planDigest));
    expect(effect).toMatchObject({ state: "accepted", provider: "zenith", environmentId: env, providerReceipt: { identity: { deleted: "1" } }, target: { planDigest: s.plan.planDigest, addressCount: 1 } });
    expect(effect!.fenceScope).toBe(`env:${env}`);
    // a retried activity (new attempt, new worker) is answered from the receipt: no provider call of any kind
    const before = s.calls.length;
    await expect(s.activities.applyDestroyInfrastructure(s.args)).resolves.toEqual({ deleted: 1 });
    await expect(s.activities.applyDestroyInfrastructure(s.args)).resolves.toEqual({ deleted: 1 });
    expect(s.calls.length).toBe(before);
    expect(applies(s.calls)).toBe(1);
  });

  it("an apply that ends without a known outcome leaves an uncertain effect, and no retry ever reaches the provider", async () => {
    const s = await reviewed();
    s.failNextApply();
    await expect(s.activities.applyDestroyInfrastructure(s.args)).rejects.toThrow(/without a confirmed outcome/);
    expect(applies(s.calls)).toBe(1);
    const effect = await s.ledger.getByDedup(ws, "cleanup_apply", cleanupDedupKey(op, s.plan.planDigest));
    expect(effect).toMatchObject({ state: "uncertain" });
    const before = s.calls.length;
    await expect(s.activities.applyDestroyInfrastructure(s.args)).rejects.toBeInstanceOf(EffectUnresolvedError);
    await expect(s.activities.applyDestroyInfrastructure(s.args)).rejects.toBeInstanceOf(EffectUnresolvedError);
    expect(s.calls.length).toBe(before);
    expect((await s.ledger.unresolvedForOperation(ws, op)).map((e) => e.state)).toEqual(["uncertain"]);
  });

  it("human approval is still required before anything is recorded or applied", async () => {
    const s = await reviewed();
    s.w.broker.approval.approved = false;
    await expect(s.activities.applyDestroyInfrastructure(s.args)).rejects.toThrow(/approval/);
    expect(applies(s.calls)).toBe(0);
    expect(await s.ledger.getByDedup(ws, "cleanup_apply", cleanupDedupKey(op, s.plan.planDigest))).toBeNull();
  });

  it("a stale fence cannot start a new apply, and nothing is recorded", async () => {
    const s = await reviewed();
    s.w.leases.steal(`env:${env}`);
    await expect(s.activities.applyDestroyInfrastructure(s.args)).rejects.toThrow();
    expect(applies(s.calls)).toBe(0);
    expect(await s.ledger.getByDedup(ws, "cleanup_apply", cleanupDedupKey(op, s.plan.planDigest))).toBeNull();
  });
});
