/** LIFE-12: PGlite checks committed state/rollback; only PostgreSQL proves
 * overlapping independent transactions and observed native lock waits.
 * Approval identities are fixtures. No browser or cloud execution is claimed.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { openPlatformDb, type PlatformDbHandle } from "@/lib/controlplane/db";
import { PLATFORM_MIGRATIONS } from "@/lib/controlplane/db/migrations";
import { migration0053FieldOwnershipSerialization } from "@/lib/controlplane/db/migrations/0053_field_ownership_serialization";
import { renderSupabaseMigration } from "@/lib/controlplane/db/migrations/emit";
import { migratePlatformDb } from "@/lib/controlplane/db/migrator";
import { assessPlatformMigration } from "@/lib/controlplane/db/compat";
import * as repos from "@/lib/controlplane/db/repos";
import type { Sql } from "@/lib/controlplane/types";
import { checkNativeOperation, transferRequest } from "@/lib/ownership";
import { PG_URL, approve, newWorkspace, proposalFor, seedAwaitingApproval, uid, user, withScratchDatabase } from "./_support/harness";

const address = "service/web";
const kinds = ["owner", "fact", "spec"] as const;
type MutationKind = (typeof kinds)[number];
const conflict = { code: "conflict", details: { reason: "field_ownership_conflict" } };
const asService = <T>(db: PlatformDbHandle, fn: (tx: Sql) => Promise<T>) => db.tx(async tx => {
  await tx.query("set local role service_role");
  return fn(tx);
});

async function fixture(db: PlatformDbHandle, size?: "without-transfer" | "approved-transfer") {
  const workspaceId = newWorkspace(), environmentId = uid("env"), projectId = uid("project");
  const resource = await repos.resources.upsertDesired(db, { workspaceId, environmentId, node: {
    address, kind: "container_service", provider: "aws", region: "us-east-1", nativeType: "aws:ecs_service", ownership: "managed", specDigest: "a".repeat(64), spec: { replicas: 2, ...(size ? { size: "standard" } : {}) }, dependsOn: [], labels: {}, origin: [],
  } });
  const seeded = await seedAwaitingApproval(db, { workspaceId, proposal: {
    capability: "service.scale", scope: { workspaceId, projectId, environmentId, resourceId: resource.id },
    ...(size ? { input: { size: "small" } } : {}),
    ...(size === "approved-transfer" ? { broker: { ownershipTransfers: [transferRequest({ address, resourceType: "aws:ecs_service", path: "size", from: "iac", to: "native-op" })] } } : {}),
  } });
  const decision = await asService(db, tx => approve(tx, seeded, user()));
  const lease = await repos.leases.acquire(db, { workspaceId, scope: `env:${environmentId}`, holder: "worker:ownership-race", ttlMs: 120_000 });
  expect(lease).not.toBeNull();
  const claim = { workspaceId, id: seeded.operation.id, expectedDigest: seeded.operation.proposalDigest, holder: "worker:ownership-race", lease: lease! };
  const now = Date.now();
  const grant = { jti: uid("jti"), workspaceId, operationId: seeded.operation.id, capability: "service.scale", audience: "worker",
    issuedAt: new Date(now).toISOString(), expiresAt: new Date(now + 120_000).toISOString() };
  return { workspaceId, environmentId, projectId, resourceId: resource.id, operationId: seeded.operation.id, approvalId: decision.approval.id, claim, grant };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;

async function mutation(db: PlatformDbHandle, f: Fixture, kind: MutationKind): Promise<(tx: Sql) => Promise<unknown>> {
  if (kind === "owner") {
    const request = transferRequest({ address, resourceType: "aws:ecs_service", path: "replicas", from: "iac", to: "autoscaler" });
    const proposal = { ...proposalFor(f.workspaceId, { capability: "service.scale", scope: {
      workspaceId: f.workspaceId, projectId: f.projectId, environmentId: f.environmentId, resourceId: f.resourceId,
    } }), broker: { ownershipTransfers: [request] } };
    const pending = await seedAwaitingApproval(db, { workspaceId: f.workspaceId, proposal });
    return tx => approve(tx, pending, user());
  }
  if (kind === "fact") return tx => repos.resources.upsertDesired(tx, { workspaceId: f.workspaceId, environmentId: f.environmentId, node: {
    address: "native/scaler", kind: "provider_native", provider: "aws", region: "us-east-1", nativeType: "aws:appautoscaling_target", ownership: "managed", dependsOn: [], labels: {}, origin: [],
    specDigest: "b".repeat(64), spec: { config: { target: address } },
  } });
  // Direct SQL proves the trigger is mandatory, even without a repo hook.
  return tx => tx.query("update platform.resources set spec=$3::text::jsonb where workspace_id=$1 and id=$2",
    [f.workspaceId, f.resourceId, JSON.stringify({ replicas: 2, autoscaling: true })]);
}

async function state(db: PlatformDbHandle, f: Fixture) {
  const [row] = await db.query(`select o.status,
    (select count(*)::integer from platform.approvals a where a.workspace_id=o.workspace_id and a.operation_id=o.id and a.consumed_at is not null) as consumed,
    (select count(*)::integer from platform.capability_grants g where g.workspace_id=o.workspace_id and g.operation_id=o.id) as grants
    from platform.operations o where o.workspace_id=$1 and o.id=$2`, [f.workspaceId, f.operationId]);
  return row;
}

async function assertGuardRefuses(db: PlatformDbHandle, f: Fixture, kind: MutationKind) {
  const guard = await asService(db, tx => repos.ownershipTransfers.guardFor(tx, f.workspaceId, f.environmentId, f.resourceId));
  expect(guard).not.toBeNull();
  if (kind === "owner") expect(guard!.transfers).toMatchObject([{ from: "iac", to: "autoscaler" }]);
  else expect(guard!.facts).toEqual({ autoscaled: true });
  expect(checkNativeOperation({ capability: "service.scale", ...guard! })[0]).toMatchObject({ verdict: "transfer_required", resolution: { owner: "autoscaler" } });
}

describe("environment ownership serialization [pglite, serialized engine]", () => {
  let db: PlatformDbHandle;
  beforeAll(async () => {
    db = await openPlatformDb({ kind: "pglite" });
    await db.exec("create role service_role bypassrls");
    await db.exec(renderSupabaseMigration());
  });
  afterAll(async () => { await db?.close(); });

  it("requires the approved size transfer at claim and rechecks revocation at the final grant", async () => {
    const refused = await fixture(db, "without-transfer");
    await expect(asService(db, tx => repos.operations.claimForExecution(tx, refused.claim))).rejects.toMatchObject(conflict);
    expect(await state(db, refused)).toEqual({ status: "approved", consumed: 0, grants: 0 });

    const allowed = await fixture(db, "approved-transfer");
    const [receipt] = await repos.ownershipTransfers.listActive(db, allowed.workspaceId, allowed.environmentId, address);
    expect(receipt).toMatchObject({ path: "size", from: "iac", to: "native-op", approvalId: allowed.approvalId });
    expect(await asService(db, tx => repos.operations.claimForExecution(tx, allowed.claim))).not.toBeNull();
    expect(await asService(db, tx => repos.ownershipTransfers.revoke(tx, { workspaceId: allowed.workspaceId, operationId: allowed.operationId, transferDigest: receipt.digest, revokedBy: "operator-fixture" }))).toBe(true);
    await expect(asService(db, tx => repos.grants.insert(tx, allowed.grant))).rejects.toMatchObject(conflict);
    expect(await state(db, allowed)).toEqual({ status: "running", consumed: 1, grants: 0 });
  });

  it.each(["deleted", "missing"])("refuses a %s target for size admission even with an approved transfer", async status => {
    const f = await fixture(db, "approved-transfer");
    if (status === "deleted") await db.query("update platform.resources set status='deleted' where workspace_id=$1 and id=$2", [f.workspaceId, f.resourceId]);
    else await db.query("delete from platform.resources where workspace_id=$1 and id=$2", [f.workspaceId, f.resourceId]);
    await expect(asService(db, tx => repos.operations.claimForExecution(tx, f.claim))).rejects.toMatchObject({ code: "conflict" });
    expect(await state(db, f)).toEqual({ status: "approved", consumed: 0, grants: 0 });
  });

  it.each(kinds)("committed %s mutation refuses claim without approval consumption", async kind => {
    const f = await fixture(db), write = await mutation(db, f, kind);
    await asService(db, write);
    await assertGuardRefuses(db, f, kind);
    await expect(asService(db, tx => repos.operations.claimForExecution(tx, f.claim))).rejects.toMatchObject(conflict);
    expect(await state(db, f)).toEqual({ status: "approved", consumed: 0, grants: 0 });
  });

  it.each(kinds)("rechecks %s committed between claim and final mutation grant", async kind => {
    const f = await fixture(db), write = await mutation(db, f, kind);
    await asService(db, tx => repos.operations.claimForExecution(tx, f.claim));
    await asService(db, write);
    await expect(asService(db, tx => repos.grants.insert(tx, f.grant))).rejects.toMatchObject(conflict);
    expect(await state(db, f)).toEqual({ status: "running", consumed: 1, grants: 0 });
  });

  it.each(kinds)("rolled-back %s mutation leaves admission available", async kind => {
    const f = await fixture(db), write = await mutation(db, f, kind);
    await expect(asService(db, async tx => { await write(tx); throw new Error("fixture rollback"); })).rejects.toThrow("fixture rollback");
    await asService(db, tx => repos.operations.claimForExecution(tx, f.claim));
    await asService(db, tx => repos.grants.insert(tx, f.grant));
    expect(await state(db, f)).toEqual({ status: "running", consumed: 1, grants: 1 });
  });

  it("retains final-statement snapshot refusal under the environment coordinator", async () => {
    const f = await fixture(db), write = await mutation(db, f, "fact");
    await asService(db, tx => repos.operations.claimForExecution(tx, f.claim));
    let finalStatements = 0;
    const queries: string[] = [];
    const observe = (current: Sql): Sql => ({
      query: async <T>(text: string, params?: readonly unknown[]): Promise<T[]> => {
        queries.push(text);
        if (text.includes("insert into platform.capability_grants") && text.includes("from platform.operations o")) {
          finalStatements++;
          expect(queries.some(query => query.includes("pg_advisory_xact_lock"))).toBe(true);
          expect(queries.some(query => query.includes("as snapshot from platform.resources"))).toBe(true);
          // A mutation by this same transaction can reacquire its coordinator.
          // Independent writers are covered by the gated PostgreSQL lock races.
          await write(current);
        }
        return current.query<T>(text, params);
      },
      tx: fn => current.tx(inner => fn(observe(inner))),
    });
    await expect(asService(db, tx => repos.grants.insert(observe(tx), f.grant))).rejects.toMatchObject(conflict);
    expect(finalStatements).toBe(1);
    expect(await state(db, f)).toEqual({ status: "running", consumed: 1, grants: 0 });
    expect(await repos.resources.getByAddress(db, f.workspaceId, f.environmentId, "native/scaler")).toBeNull();
  });

  it("preserves exact JSONB numbers when serialized grant admission binds its inventory", async () => {
    const f = await fixture(db);
    await db.query("update platform.resources set spec=jsonb_set(spec,'{exact}',to_jsonb(9007199254740993::bigint)) where workspace_id=$1 and id=$2",
      [f.workspaceId, f.resourceId]);
    await asService(db, tx => repos.operations.claimForExecution(tx, f.claim));
    expect(await asService(db, tx => repos.grants.insert(tx, f.grant))).toMatchObject({ jti: f.grant.jti });
    expect(await db.query("select spec->>'exact' as exact from platform.resources where workspace_id=$1 and id=$2",
      [f.workspaceId, f.resourceId])).toEqual([{ exact: "9007199254740993" }]);
    expect(await state(db, f)).toEqual({ status: "running", consumed: 1, grants: 1 });
  });

  it("refuses a stale isolation snapshot for both readback and admission", async () => {
    const f = await fixture(db);
    for (const read of [false, true]) await expect(db.tx(async tx => {
      await tx.query("set transaction isolation level repeatable read");
      return read ? repos.ownershipTransfers.guardFor(tx, f.workspaceId, f.environmentId, f.resourceId)
        : repos.operations.claimForExecution(tx, f.claim);
    })).rejects.toMatchObject({ code: "invalid_state", details: { reason: "field_ownership_isolation" } });
    expect(await state(db, f)).toEqual({ status: "approved", consumed: 0, grants: 0 });
  });

  it("fails closed instead of omitting a newly inserted fact beyond the graph bound", async () => {
    const f = await fixture(db);
    await db.query(`insert into platform.resources(id,workspace_id,environment_id,address,kind,provider,native_type,ownership,spec_digest,spec)
      select $1||n,$2,$3,'zz/'||n,'provider_native','aws','aws:appautoscaling_target','managed',$4,
        jsonb_build_object('config',jsonb_build_object('target',$5::text)) from generate_series(1,2000) n`,
    [uid("res"), f.workspaceId, f.environmentId, "b".repeat(64), address]);
    const error = { code: "conflict", details: { reason: "field_ownership_graph_limit" } };
    await expect(repos.ownershipTransfers.guardFor(db, f.workspaceId, f.environmentId, f.resourceId)).rejects.toMatchObject(error);
    await expect(repos.operations.claimForExecution(db, f.claim)).rejects.toMatchObject(error);
    await expect(db.tx(tx => repos.ownershipTransfers.lockForGrant(tx, f.workspaceId, f.operationId))).rejects.toMatchObject(conflict);
    expect(await state(db, f)).toEqual({ status: "approved", consumed: 0, grants: 0 });
  });

  it("migration 53 is additive, registered after 52, and idempotent without rewriting history", async () => {
    const position = PLATFORM_MIGRATIONS.findIndex(migration => migration.version === 53);
    expect(PLATFORM_MIGRATIONS[position]).toBe(migration0053FieldOwnershipSerialization);
    expect(PLATFORM_MIGRATIONS[position - 1].version).toBe(52);
    expect(assessPlatformMigration(migration0053FieldOwnershipSerialization, 43).class).toBe("expand");
    await db.exec(migration0053FieldOwnershipSerialization.sql);
    expect(await db.query("select tgname from pg_trigger where tgname like 'field_ownership_%_serialization' order by tgname")).toEqual([
      { tgname: "field_ownership_resource_serialization" }, { tgname: "field_ownership_transfer_serialization" },
    ]);
  });

  it("moving and deleting an autoscaler changes the graph in both environment scopes", async () => {
    const f = await fixture(db), write = await mutation(db, f, "fact");
    await asService(db, write);
    await assertGuardRefuses(db, f, "fact");
    const other = uid("env");
    await asService(db, tx => tx.query("update platform.resources set environment_id=$3 where workspace_id=$1 and environment_id=$2 and address='native/scaler'", [f.workspaceId, f.environmentId, other]));
    const guard = await repos.ownershipTransfers.guardFor(db, f.workspaceId, f.environmentId, f.resourceId);
    expect(guard!.facts).toEqual({});
    await asService(db, tx => tx.query("delete from platform.resources where workspace_id=$1 and environment_id=$2", [f.workspaceId, other]));
    await asService(db, tx => repos.operations.claimForExecution(tx, f.claim));
    expect(await state(db, f)).toEqual({ status: "running", consumed: 1, grants: 0 });
  });

  it("an absent modern target retains final expiry checks after the coordinator", async () => {
    const f = await fixture(db);
    await db.query("delete from platform.resources where workspace_id=$1 and id=$2", [f.workspaceId, f.resourceId]);
    expect(await db.tx(tx => repos.ownershipTransfers.lockForOperation(tx, f.workspaceId, f.operationId))).toEqual([]);
    let injected = false;
    // Real SQL fault injection at the wait boundary, not a fabricated query
    // result or fake clock. The independent PostgreSQL sibling waits for time.
    const injectExpiry = (sql: Sql): Sql => ({
      query: async <T>(text: string, params?: readonly unknown[]): Promise<T[]> => {
        const rows = await sql.query<T>(text, params);
        if (!injected && text.includes("pg_advisory_xact_lock")) {
          injected = true;
          await sql.query("update platform.operations set expires_at=clock_timestamp()-interval '1 second' where workspace_id=$1 and id=$2", [f.workspaceId, f.operationId]);
        }
        return rows;
      },
      tx: fn => sql.tx(child => fn(injectExpiry(child))),
    });
    await expect(asService(db, tx => repos.operations.claimForExecution(injectExpiry(tx), f.claim))).rejects.toMatchObject(conflict);
    expect(injected).toBe(true);
    expect(await state(db, f)).toEqual({ status: "approved", consumed: 0, grants: 0 });
  });
});

async function withNative(fn: (db: PlatformDbHandle, independent: PlatformDbHandle) => Promise<void>) {
  await withScratchDatabase(async url => {
    const db = await openPlatformDb({ kind: "postgres", url, migrate: false, max: 2, txRetry: { attempts: 1 } });
    let independent: PlatformDbHandle | undefined;
    try {
      expect(await db.query("select rolbypassrls as bypass from pg_roles where rolname='service_role'")).toEqual([{ bypass: true }]);
      await db.exec(renderSupabaseMigration());
      independent = await openPlatformDb({ kind: "postgres", url, migrate: false, max: 2, txRetry: { attempts: 1 } });
      await fn(db, independent);
    } finally {
      await independent?.close();
      await db.close();
    }
  });
}

function signal<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}
async function pid(tx: Sql) {
  const [row] = await tx.query<{ pid: number }>("select pg_backend_pid() as pid");
  return row!.pid;
}
async function waitForLock(db: PlatformDbHandle, waiter: number, blocker: number, advisory = true) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const rows = await db.query(`select pid from pg_stat_activity where pid=$1 and wait_event_type='Lock'
      and $2::integer=any(pg_blocking_pids(pid))
      and (not $3::boolean or exists(select 1 from pg_locks where pid=$1 and locktype='advisory' and not granted))`, [waiter, blocker, advisory]);
    if (rows.length === 1) return;
    await new Promise(done => setTimeout(done, 10));
  }
  throw new Error("The independent PostgreSQL lock wait was not observed.");
}

describe.skipIf(!PG_URL)("environment ownership serialization [postgres, independent backends]", () => {
  for (const admission of ["claim", "grant"] as const) it.each(kinds)(`${admission} waits for new %s and rechecks committed ownership`, async kind => {
    await withNative(async (db, independent) => {
      const f = await fixture(db), write = await mutation(db, f, kind);
      if (admission === "grant") await asService(db, tx => repos.operations.claimForExecution(tx, f.claim));
      const ready = signal<number>(), release = signal<void>(), started = signal<number>();
      const writer = asService(independent, async tx => {
        await tx.query("set local lock_timeout='15s'");
        await write(tx); ready.resolve(await pid(tx)); await release.promise;
      }).then(() => undefined, error => { ready.reject(error); return error; });
      const blocker = await ready.promise;
      const attempt = asService(db, async tx => {
        await tx.query("set local lock_timeout='15s'"); started.resolve(await pid(tx));
        return admission === "claim" ? repos.operations.claimForExecution(tx, f.claim) : repos.grants.insert(tx, f.grant);
      }).then(value => ({ value }), error => ({ error }));
      try {
        const waiter = await started.promise;
        expect(waiter).not.toBe(blocker);
        await waitForLock(db, waiter, blocker);
        expect(await state(db, f)).toEqual({ status: admission === "claim" ? "approved" : "running", consumed: admission === "claim" ? 0 : 1, grants: 0 });
      } finally { release.resolve(); expect(await writer).toBeUndefined(); }
      expect(await attempt).toMatchObject({ error: conflict });
      await assertGuardRefuses(db, f, kind);
      expect(await state(db, f)).toEqual({ status: admission === "claim" ? "approved" : "running", consumed: admission === "claim" ? 0 : 1, grants: 0 });
    });
  }, 60_000);

  it.each(kinds)("readback waits for new %s and reads facts and transfers from one committed graph", async kind => {
    await withNative(async (db, independent) => {
      const f = await fixture(db), write = await mutation(db, f, kind);
      const ready = signal<number>(), release = signal<void>(), started = signal<number>();
      const writer = asService(independent, async tx => {
        await write(tx); ready.resolve(await pid(tx)); await release.promise;
      }).then(() => undefined, error => { ready.reject(error); return error; });
      const blocker = await ready.promise;
      const read = asService(db, async tx => {
        started.resolve(await pid(tx));
        return repos.ownershipTransfers.guardFor(tx, f.workspaceId, f.environmentId, f.resourceId);
      });
      try { await waitForLock(db, await started.promise, blocker); }
      finally { release.resolve(); expect(await writer).toBeUndefined(); }
      const guard = await read;
      expect(checkNativeOperation({ capability: "service.scale", ...guard! })[0]).toMatchObject({ verdict: "transfer_required", resolution: { owner: "autoscaler" } });
    });
  }, 60_000);

  it.each(kinds)("dispatch winning first blocks %s mutation until admission commits", async kind => {
    await withNative(async (db, independent) => {
      const f = await fixture(db), write = await mutation(db, f, kind);
      const ready = signal<number>(), release = signal<void>(), started = signal<number>();
      const dispatch = asService(db, async tx => {
        await repos.operations.claimForExecution(tx, f.claim);
        ready.resolve(await pid(tx)); await release.promise;
      }).then(() => undefined, error => { ready.reject(error); return error; });
      const blocker = await ready.promise;
      const writer = asService(independent, async tx => { started.resolve(await pid(tx)); return write(tx); });
      try {
        await waitForLock(db, await started.promise, blocker);
        expect(await state(db, f)).toEqual({ status: "approved", consumed: 0, grants: 0 });
      } finally { release.resolve(); expect(await dispatch).toBeUndefined(); }
      await writer;
      await assertGuardRefuses(db, f, kind);
      await expect(asService(db, tx => repos.grants.insert(tx, f.grant))).rejects.toMatchObject(conflict);
      expect(await state(db, f)).toEqual({ status: "running", consumed: 1, grants: 0 });
    });
  }, 60_000);

  it("reads without tuple-lock inversion when a fact update already owns its resource row", async () => {
    await withNative(async (db, independent) => {
      const f = await fixture(db), write = await mutation(db, f, "spec");
      const ready = signal<number>(), release = signal<void>(), started = signal<number>();
      const dispatch = asService(db, async tx => {
        // Hold the actual readback coordinator before the writer owns its tuple.
        await repos.ownershipTransfers.guardFor(tx, f.workspaceId, f.environmentId, f.resourceId);
        ready.resolve(await pid(tx)); await release.promise;
        return repos.operations.claimForExecution(tx, f.claim);
      }).then(value => ({ value }), error => { ready.reject(error); return { error }; });
      const blocker = await ready.promise;
      const writer = asService(independent, async tx => { started.resolve(await pid(tx)); return write(tx); });
      try { await waitForLock(db, await started.promise, blocker); }
      finally { release.resolve(); }
      expect(await dispatch).toMatchObject({ value: { status: "running" } });
      await writer;
      await assertGuardRefuses(db, f, "spec");
    });
  }, 60_000);

  it("transaction lock rollback releases a waiting claim without phantom facts", async () => {
    await withNative(async (db, independent) => {
      const f = await fixture(db), write = await mutation(db, f, "fact");
      const ready = signal<number>(), release = signal<void>(), started = signal<number>();
      const writer = asService(independent, async tx => {
        await write(tx); ready.resolve(await pid(tx)); await release.promise; throw new Error("fixture rollback");
      }).then(() => undefined, error => { ready.reject(error); return error; });
      const blocker = await ready.promise;
      const attempt = asService(db, async tx => { started.resolve(await pid(tx)); return repos.operations.claimForExecution(tx, f.claim); });
      try { await waitForLock(db, await started.promise, blocker); }
      finally { release.resolve(); expect(await writer).toMatchObject({ message: "fixture rollback" }); }
      expect(await attempt).toMatchObject({ status: "running" });
      await asService(db, tx => repos.grants.insert(tx, f.grant));
      expect(await state(db, f)).toEqual({ status: "running", consumed: 1, grants: 1 });
    });
  }, 60_000);

  it("an absent target cannot bypass final operation expiry after a real coordinator wait", async () => {
    await withNative(async (db, independent) => {
      const f = await fixture(db), write = await mutation(db, f, "fact");
      await db.query("delete from platform.resources where workspace_id=$1 and id=$2", [f.workspaceId, f.resourceId]);
      const ready = signal<number>(), release = signal<void>(), started = signal<number>();
      const writer = asService(independent, async tx => {
        await write(tx); ready.resolve(await pid(tx)); await release.promise; throw new Error("fixture rollback");
      }).then(() => undefined, error => { ready.reject(error); return error; });
      const blocker = await ready.promise;
      let attempt: Promise<unknown> | undefined;
      try {
        await db.query("update platform.operations set expires_at=clock_timestamp()+interval '5 seconds' where workspace_id=$1 and id=$2", [f.workspaceId, f.operationId]);
        attempt = asService(db, async tx => { started.resolve(await pid(tx)); return repos.operations.claimForExecution(tx, f.claim); })
          .then(value => ({ value }), error => ({ error }));
        await waitForLock(db, await started.promise, blocker);
        const deadline = Date.now() + 10_000;
        let expired = false;
        while (Date.now() < deadline) {
          const [clock] = await db.query<{ expired: boolean }>("select expires_at<=clock_timestamp() as expired from platform.operations where workspace_id=$1 and id=$2", [f.workspaceId, f.operationId]);
          if (clock?.expired) { expired = true; break; }
          await new Promise(done => setTimeout(done, 10));
        }
        expect(expired).toBe(true);
      } finally { release.resolve(); expect(await writer).toMatchObject({ message: "fixture rollback" }); }
      expect(await attempt).toMatchObject({ error: conflict });
      expect(await state(db, f)).toEqual({ status: "approved", consumed: 0, grants: 0 });
    });
  }, 60_000);

  it("another workspace or environment does not share the held coordinator", async () => {
    await withNative(async (db, independent) => {
      const f = await fixture(db), write = await mutation(db, f, "fact");
      const ready = signal<void>(), release = signal<void>();
      const writer = asService(independent, async tx => { await write(tx); ready.resolve(); await release.promise; })
        .then(() => undefined, error => { ready.reject(error); return error; });
      await ready.promise;
      try {
        await asService(db, async tx => {
          await tx.query("set local lock_timeout='500ms'");
          expect(await repos.ownershipTransfers.guardFor(tx, newWorkspace(), f.environmentId, f.resourceId)).toBeNull();
          expect(await repos.ownershipTransfers.guardFor(tx, f.workspaceId, uid("env"), f.resourceId)).toBeNull();
        });
      } finally { release.resolve(); expect(await writer).toBeUndefined(); }
    });
  }, 60_000);

  it("direct transfer INSERT waits for its operation FK before taking the coordinator", async () => {
    await withNative(async (db, independent) => {
      const f = await fixture(db), ready = signal<number>(), release = signal<void>(), started = signal<number>();
      const dispatch = asService(db, async tx => {
        await repos.operations.claimForExecution(tx, f.claim);
        ready.resolve(await pid(tx)); await release.promise;
      }).then(() => undefined, error => { ready.reject(error); return error; });
      const blocker = await ready.promise;
      const request = transferRequest({ address, resourceType: "aws:ecs_service", path: "replicas", from: "iac", to: "autoscaler" });
      // Synthetic SQL receipt, solely a FK/coordinator ordering probe. The
      // approved fixture proposal did not request this transfer; this is not
      // evidence for approver-bound transfer creation (covered by the broker).
      const writer = asService(independent, async tx => {
        started.resolve(await pid(tx));
        return tx.query(`insert into platform.ownership_transfers
          (id,workspace_id,project_id,environment_id,address,resource_type,field_path,from_owner,to_owner,transfer_digest,operation_id,approval_id,proposal_digest,approved_at)
          select $1,o.workspace_id,o.project_id,o.environment_id,$2,$3,$4,$5,$6,$7,o.id,a.id,o.proposal_digest,a.created_at
          from platform.operations o join platform.approvals a on a.workspace_id=o.workspace_id and a.operation_id=o.id
          where o.workspace_id=$8 and o.id=$9 and a.id=$10`,
        [uid("own"), address, request.resourceType, request.path, request.from, request.to, request.digest, f.workspaceId, f.operationId, f.approvalId]);
      }).then(value => ({ value }), error => ({ error }));
      try {
        const waiter = await started.promise;
        await waitForLock(db, waiter, blocker, false);
        expect(await db.query("select locktype from pg_locks where pid=$1 and locktype='advisory'", [waiter])).toEqual([]);
      } finally { release.resolve(); expect(await dispatch).toBeUndefined(); }
      expect(await writer).toMatchObject({ value: expect.any(Array) });
      await assertGuardRefuses(db, f, "owner");
    });
  }, 60_000);

  it("upgrades genuine schema 43 through migration 53 with unchanged earlier checksums and service-role ACLs", async () => {
    await withScratchDatabase(async url => {
      const db = await openPlatformDb({ kind: "postgres", url, migrate: false, max: 2 });
      try {
        await migratePlatformDb(db, PLATFORM_MIGRATIONS.filter(m => m.version <= 43));
        const before = await db.query("select version,checksum from platform.schema_migrations order by version");
        // This owned scratch fixture is drained. Admit only the contracts
        // actually pending in each bounded phase, restoring the caller exactly.
        const migrateOwnedRange = async (target: number, contracts: readonly number[]) => {
          const prior = process.env.ZENITH_ALLOW_CONTRACT_MIGRATIONS;
          process.env.ZENITH_ALLOW_CONTRACT_MIGRATIONS = [prior, ...contracts].filter(value => value !== undefined && value !== "").join(",");
          try { return await migratePlatformDb(db, PLATFORM_MIGRATIONS.filter(m => m.version <= target)); }
          finally {
            if (prior === undefined) delete process.env.ZENITH_ALLOW_CONTRACT_MIGRATIONS;
            else process.env.ZENITH_ALLOW_CONTRACT_MIGRATIONS = prior;
          }
        };
        expect(await migrateOwnedRange(52, [49, 51])).toMatchObject({ applied: PLATFORM_MIGRATIONS.filter(m => m.version > 43 && m.version <= 52).map(m => m.version) });
        const aclSql = `select c.relname,c.relacl::text as acl,c.relowner,c.relrowsecurity
          from pg_class c join pg_namespace n on n.oid=c.relnamespace
          where n.nspname='platform' and c.relkind in ('r','p','S') order by c.relname`;
        const before53Acl = await db.query(aclSql);
        expect(await migrateOwnedRange(53, [])).toMatchObject({ applied: [53] });
        expect(await db.query("select version from platform.schema_migrations order by version"))
          .toEqual(PLATFORM_MIGRATIONS.filter(m => m.version <= 53).map(m => ({ version: m.version })));
        expect(await db.query("select version,checksum from platform.schema_migrations where version<=43 order by version")).toEqual(before);
        // Migration 53 adds invoker triggers, no tables, roles or privilege elevation.
        expect(await db.query(aclSql)).toEqual(before53Acl);
        expect(await db.query("select prosecdef from pg_proc where oid='platform.serialize_field_ownership()'::regprocedure")).toEqual([{ prosecdef: false }]);
        // Current emitter/service-role behavior is a distinct 54..58 phase;
        // no current aggregate is presented as historical schema-53 SQL.
        expect(await migrateOwnedRange(PLATFORM_MIGRATIONS[PLATFORM_MIGRATIONS.length - 1].version, [57, 58])).toMatchObject({ applied: PLATFORM_MIGRATIONS.filter(m => m.version > 53).map(m => m.version) });
        const currentLedger = await db.query("select version,name,checksum from platform.schema_migrations order by version");
        await db.exec(renderSupabaseMigration());
        expect(await db.query("select version,name,checksum from platform.schema_migrations order by version")).toEqual(currentLedger);
        const f = await fixture(db), write = await mutation(db, f, "fact");
        await asService(db, write);
        await expect(asService(db, tx => repos.operations.claimForExecution(tx, f.claim))).rejects.toMatchObject(conflict);
      } finally { await db.close(); }
    });
  }, 60_000);
});
