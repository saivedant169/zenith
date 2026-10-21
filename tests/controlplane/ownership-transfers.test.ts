/** Actual service-role SQL custody. Human approval inputs are fixture models;
 * canonical approval/storage SQL, role ACLs and independent backends are real.
 * No browser authentication, provider execution or current-role admission claim.
 */
import { describe, expect, it } from "vitest";
import { openPlatformDb, type PlatformDbHandle } from "@/lib/controlplane/db";
import { renderSupabaseMigration } from "@/lib/controlplane/db/migrations/emit";
import * as repos from "@/lib/controlplane/db/repos";
import type { Sql } from "@/lib/controlplane/types";
import { digest } from "@/lib/controlplane/digest";
import { createEffectLedger } from "@/lib/effects/ledger";
import type { EffectRecord } from "@/lib/effects/types";
import { transferRequest } from "@/lib/ownership/registry";
import { PG_URL, approve, newWorkspace, proposalFor, seedAwaitingApproval, uid, user, withScratchDatabase } from "./_support/harness";

const transfer = transferRequest({ address: "container_service/web", resourceType: "aws:ecs_service", path: "replicas", from: "autoscaler", to: "native-op" });

async function withNative<T>(fn: (db: PlatformDbHandle, independent: PlatformDbHandle) => Promise<T>): Promise<T> {
  return withScratchDatabase(async url => {
    const db = await openPlatformDb({ kind: "postgres", url, migrate: false, max: 2 });
    let independent: PlatformDbHandle | undefined;
    try {
      // Canonical agent bootstrap creates this cluster role first. No test
      // changes its attributes, membership or the protected table ACLs.
      expect(await db.query("select rolbypassrls as bypass from pg_roles where rolname='service_role'")).toEqual([{ bypass: true }]);
      await db.exec(renderSupabaseMigration());
      independent = await openPlatformDb({ kind: "postgres", url, migrate: false, max: 2 });
      return await fn(db, independent);
    } finally {
      if (independent) await independent.close();
      await db.close();
    }
  });
}

const asService = <T>(db: PlatformDbHandle, fn: (tx: Sql) => Promise<T>): Promise<T> => db.tx(async tx => {
  await tx.query("set local role service_role");
  expect(await tx.query("select current_user as name")).toEqual([{ name: "service_role" }]);
  return fn(tx);
});

async function pending(db: PlatformDbHandle, count = 1) {
  const workspaceId = newWorkspace(), environmentId = uid("env");
  const proposal = { ...proposalFor(workspaceId, { capability: "service.scale", scope: { workspaceId, projectId: uid("project"), environmentId } }), broker: { ownershipTransfers: [transfer] } };
  return seedAwaitingApproval(db, { workspaceId, count, proposal });
}

const rowsFor = (db: PlatformDbHandle, workspaceId: string, operationId: string) => db.query(
  "select * from platform.ownership_transfers where workspace_id=$1 and operation_id=$2 order by id", [workspaceId, operationId]
);

/** Finite expiry has no public writer today. These original SQL receipts
 * explicitly model the reviewed approval tuple to exercise native admission,
 * while the genuine browser/default broker positive lives in capabilities. */
async function admission(db: PlatformDbHandle, expiresMs: number | null = null, to: "native-op" | "iac" = "native-op", field: "replicas" | "size" = "replicas") {
  const receipt=transferRequest({address:transfer.address,resourceType:transfer.resourceType,path:field,from:field === "size" ? "iac" : transfer.from,to});
  const workspaceId = newWorkspace(), environmentId = uid("env"), projectId = uid("project"), resourceId = uid("resource");
  await db.query(`insert into platform.resources
    (id,workspace_id,environment_id,address,kind,provider,native_type,ownership,spec_digest,spec)
    values($1,$2,$3,'container_service/web','container_service','aws','aws:ecs_service','managed',$4,$5::text::jsonb)`,
    [resourceId,workspaceId,environmentId,"a".repeat(64),JSON.stringify({replicas:2,size:"standard",autoscaling:{min:2,max:8}})]);
  const seeded = await seedAwaitingApproval(db, { workspaceId, proposal: {
    capability: "service.scale", scope: { workspaceId, projectId, environmentId, resourceId },
    ...(field === "size" ? { input: { size: "small" } } : {}),
  } });
  const decision = await asService(db, tx => approve(tx, seeded, user()));
  const transferId = uid("own");
  await asService(db, tx => tx.query(`insert into platform.ownership_transfers
    (id,workspace_id,project_id,environment_id,address,resource_type,field_path,from_owner,to_owner,transfer_digest,operation_id,approval_id,proposal_digest,approved_at,expires_at)
    select $1,o.workspace_id,o.project_id,o.environment_id,$2,$3,$4,$5,$6,$7,o.id,a.id,o.proposal_digest,a.created_at,
      case when $11::bigint is null then null else clock_timestamp()+($11::bigint*interval '1 millisecond') end
    from platform.operations o join platform.approvals a on a.workspace_id=o.workspace_id and a.operation_id=o.id
    where o.workspace_id=$8 and o.id=$9 and a.id=$10 and a.decision='approve' and a.approver->>'kind'='user' and a.proposal_digest=o.proposal_digest`,
    [transferId,receipt.address,receipt.resourceType,receipt.path,receipt.from,receipt.to,receipt.digest,workspaceId,seeded.operation.id,decision.approval.id,expiresMs]));
  const lease = await repos.leases.acquire(db,{workspaceId,scope:`env:${environmentId}`,holder:"worker:ownership-native",ttlMs:60_000});
  expect(lease).not.toBeNull();
  const claim = { workspaceId, id: seeded.operation.id, expectedDigest: seeded.operation.proposalDigest, holder: "worker:ownership-native", lease: lease! };
  const now = Date.now();
  const grant = { jti: uid("jti"), workspaceId, operationId: seeded.operation.id, capability:"service.scale",audience:"worker",issuedAt:new Date(now).toISOString(),expiresAt:new Date(now+60_000).toISOString() };
  return { workspaceId, operationId:seeded.operation.id, transferId, claim, grant };
}

async function stateOf(db: PlatformDbHandle, input: { workspaceId: string; operationId: string }) {
  const [state] = await db.query<{ status: string; grants: number; consumed: number }>(`select o.status,
    (select count(*)::integer from platform.capability_grants g where g.workspace_id=o.workspace_id and g.operation_id=o.id) as grants,
    (select count(*)::integer from platform.approvals a where a.workspace_id=o.workspace_id and a.operation_id=o.id and a.consumed_at is not null) as consumed
    from platform.operations o where o.workspace_id=$1 and o.id=$2`,[input.workspaceId,input.operationId]);
  return state;
}

/** A genuine approved manifest baseline, with no enabling transfer to mask a new owner. */
async function manifestAdmission(db: PlatformDbHandle, capability: "service.scale" | "drift.repair" = "service.scale") {
  const workspaceId = newWorkspace(), environmentId = uid("env"), projectId = uid("project");
  const node = { address: "container_service/web", kind: "container_service" as const, provider: "aws" as const,
    region: "us-east-1", nativeType: "aws:ecs_service", ownership: "managed" as const,
    spec: { replicas: 2 } as Record<string, unknown>, specDigest: digest({ replicas: 2 }), origin: ["web"], dependsOn: [], labels: {} };
  const resource = await asService(db, tx => repos.resources.upsertDesired(tx, { workspaceId, environmentId, projectId, node }));
  const seeded = await seedAwaitingApproval(db, { workspaceId, proposal: {
    capability, scope: { workspaceId, projectId, environmentId, resourceId: resource.id },
    ...(capability === "drift.repair" ? { input: { action: "reapply_desired_state", attributes: ["replicas"] } } : {}),
  } });
  await asService(db, tx => approve(tx, seeded, user()));
  expect(await repos.ownershipTransfers.listActive(db, workspaceId, environmentId)).toEqual([]);
  const lease = await repos.leases.acquire(db, { workspaceId, scope: `env:${environmentId}`, holder: "worker:fact-race", ttlMs: 60_000 });
  expect(lease).not.toBeNull();
  const now = Date.now();
  return { workspaceId, environmentId, projectId, node, resourceId: resource.id, operationId: seeded.operation.id,
    claim: { workspaceId, id: seeded.operation.id, expectedDigest: seeded.operation.proposalDigest, holder: "worker:fact-race", lease: lease! },
    grant: { jti: uid("jti"), workspaceId, operationId: seeded.operation.id, capability, audience: "worker",
      issuedAt: new Date(now).toISOString(), expiresAt: new Date(now + 60_000).toISOString() } };
}

async function addAutoscaler(tx: Sql, owned: Awaited<ReturnType<typeof manifestAdmission>>) {
  const spec = { config: { target: owned.node.address } };
  return repos.resources.upsertDesired(tx, { workspaceId: owned.workspaceId, environmentId: owned.environmentId, projectId: owned.projectId,
    node: { address: "native/web-autoscaler", kind: "provider_native", provider: "aws", region: "us-east-1",
      nativeType: "aws:appautoscaling_target", ownership: "managed", spec, specDigest: digest(spec), origin: ["web"], dependsOn: [], labels: {} } });
}

const signal = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
};

async function waitForNativeLock(db: PlatformDbHandle, waiter: number, blocker: number) {
  const end = Date.now()+10_000;
  while (Date.now()<end) {
    const rows = await db.query(`select pid from pg_stat_activity where pid=$1 and wait_event_type='Lock'
      and $2::integer=any(pg_blocking_pids(pid))`,[waiter,blocker]);
    if (rows.length===1) return;
    await new Promise(done => setTimeout(done,10));
  }
  throw new Error("The owning native row wait was not observed.");
}

async function waitForExpiry(db: PlatformDbHandle, input: { workspaceId: string; transferId: string }) {
  const end = Date.now()+10_000;
  while (Date.now()<end) {
    const [clock] = await db.query<{ expired: boolean }>("select expires_at<=clock_timestamp() as expired from platform.ownership_transfers where workspace_id=$1 and id=$2",[input.workspaceId,input.transferId]);
    if (clock?.expired) return;
    await new Promise(done => setTimeout(done,10));
  }
  throw new Error("The finite native transfer expiry was not observed.");
}

async function claimAfterFactCommit(db: PlatformDbHandle, independent: PlatformDbHandle,
  owned: Awaited<ReturnType<typeof manifestAdmission>>, change: (tx: Sql) => Promise<unknown>) {
  const ready = signal<number>(), release = signal<void>(), started = signal<number>();
  const blocker = asService(independent, async tx => {
    const [backend] = await tx.query<{ pid: number }>("select pg_backend_pid() as pid");
    await tx.query("select id from platform.operations where workspace_id=$1 and id=$2 for update", [owned.workspaceId, owned.operationId]);
    ready.resolve(backend!.pid); await release.promise;
  }).then(() => undefined, error => { ready.reject(error); return error; });
  let attempt: Promise<unknown> | undefined;
  try {
    const blockerPid = await ready.promise;
    attempt = asService(db, async tx => {
      const [backend] = await tx.query<{ pid: number }>("select pg_backend_pid() as pid"); started.resolve(backend!.pid);
      return repos.operations.claimForExecution(tx, owned.claim);
    }).then(value => ({ value }), error => { started.reject(error); return { error }; });
    const waiterPid = await started.promise;
    await waitForNativeLock(db, waiterPid, blockerPid);
    await asService(independent, async tx => {
      const [backend] = await tx.query<{ pid: number }>("select pg_backend_pid() as pid");
      expect([blockerPid, waiterPid]).not.toContain(backend!.pid);
      await change(tx);
    }); // Resolves only after the independent fact mutation COMMIT.
    await waitForNativeLock(db, waiterPid, blockerPid);
  } finally {
    release.resolve(); expect(await blocker).toBeUndefined();
    await attempt;
  }
  return attempt!;
}

async function grantAfterFactCommit(db: PlatformDbHandle, independent: PlatformDbHandle,
  owned: Awaited<ReturnType<typeof manifestAdmission>>, change: (tx: Sql) => Promise<unknown>) {
  const ready = signal<number>(), release = signal<void>(), started = signal<number>();
  // The mutation owns the environment coordinator first. Migration 53 prevents
  // independent writers from committing behind an admission that already owns it.
  const writer = asService(independent, async tx => {
    const [backend] = await tx.query<{ pid: number }>("select pg_backend_pid() as pid");
    await change(tx);
    ready.resolve(backend!.pid); await release.promise;
  }).then(() => undefined, error => { ready.reject(error); return error; });
  let attempt: Promise<unknown> | undefined;
  try {
    const blockerPid = await ready.promise;
    attempt = asService(db, async tx => {
      const [backend] = await tx.query<{ pid: number }>("select pg_backend_pid() as pid"); started.resolve(backend!.pid);
      return repos.grants.insert(tx, owned.grant);
    }).then(value => ({ value }), error => { started.reject(error); return { error }; });
    const waiterPid = await started.promise;
    expect(waiterPid).not.toBe(blockerPid);
    await waitForNativeLock(db, waiterPid, blockerPid);
    expect(await db.query("select locktype from pg_locks where pid=$1 and locktype='advisory' and not granted", [waiterPid]))
      .toEqual([{ locktype: "advisory" }]);
    expect(await repos.resources.getByAddress(db, owned.workspaceId, owned.environmentId, "native/web-autoscaler")).toBeNull();
  } finally {
    release.resolve();
    const writerOutcome = await writer;
    await attempt;
    expect(writerOutcome).toBeUndefined();
  }
  // The writer is committed before admission can take its fresh graph snapshot.
  expect(await repos.resources.getByAddress(db, owned.workspaceId, owned.environmentId, "native/web-autoscaler")).not.toBeNull();
  return attempt!;
}

describe.skipIf(!PG_URL)("ownership transfer immutable service-role custody [postgres]", () => {
  it("refuses a size grant after the exact IaC transfer expires behind the final native coordinator", async () => {
    await withNative(async (db, independent) => {
      const owned = await admission(db, 3_000, "native-op", "size");
      expect(await asService(db, tx => repos.operations.claimForExecution(tx, owned.claim))).not.toBeNull();
      await db.query("insert into platform.cleanup_writer_scopes(workspace_id) values($1) on conflict do nothing", [owned.workspaceId]);
      const ready = signal<number>(), release = signal<void>(), started = signal<number>();
      const blocker = asService(independent, async tx => {
        const [backend] = await tx.query<{ pid: number }>("select pg_backend_pid() as pid");
        expect(await tx.query("select workspace_id from platform.cleanup_writer_scopes where workspace_id=$1 for update", [owned.workspaceId])).toEqual([{ workspace_id: owned.workspaceId }]);
        ready.resolve(backend!.pid); await release.promise;
      }).then(() => undefined, error => { ready.reject(error); return error; });
      const blockerPid = await ready.promise;
      const attempt = asService(db, async tx => {
        const [backend] = await tx.query<{ pid: number }>("select pg_backend_pid() as pid"); started.resolve(backend!.pid);
        return repos.grants.insert(tx, owned.grant);
      }).then(value => ({ value }), error => ({ error }));
      try { await waitForNativeLock(db, await started.promise, blockerPid); await waitForExpiry(independent, owned); }
      finally { release.resolve(); expect(await blocker).toBeUndefined(); }
      expect(await attempt).toMatchObject({ error: { code: "conflict", details: { reason: "field_ownership_conflict" } } });
      expect(await stateOf(db, owned)).toEqual({ status: "running", grants: 0, consumed: 1 });
    });
  }, 60_000);
  it("records and replays an exact human-approved transfer without immutable-column UPDATE privileges", async () => {
    await withNative(async (db, independent) => {
      const acl = await db.query(`select has_table_privilege('service_role','platform.ownership_transfers','SELECT,INSERT') as read_insert,
        has_column_privilege('service_role','platform.ownership_transfers','transfer_digest','UPDATE') as digest_update,
        has_column_privilege('service_role','platform.ownership_transfers','revoked_at','UPDATE') as revoke_update,
        has_table_privilege('service_role','platform.ownership_transfers','DELETE') as delete_rows`);
      expect(acl).toEqual([{ read_insert: true, digest_update: false, revoke_update: true, delete_rows: false }]);
      const seeded = await pending(db);
      const decision = await asService(db, tx => approve(tx, seeded, user()));
      const original = await rowsFor(db, seeded.workspaceId, seeded.operation.id);
      expect(original).toHaveLength(1);
      const input = { workspaceId: seeded.workspaceId, operationId: seeded.operation.id, approvalId: decision.approval.id };
      const expected = await repos.ownershipTransfers.listActive(db, seeded.workspaceId, seeded.operation.environmentId!);
      expect(await asService(independent, tx => repos.ownershipTransfers.recordForApprovedOperation(tx, input))).toEqual(expected);
      expect(await rowsFor(db, seeded.workspaceId, seeded.operation.id)).toEqual(original);
      expect(await asService(db, tx => tx.query("select has_column_privilege(current_user,'platform.ownership_transfers','transfer_digest','UPDATE') as allowed"))).toEqual([{ allowed: false }]);
    });
  }, 60_000);

  it("two independent service-role replay transactions preserve the original immutable receipt", async () => {
    await withNative(async (db, independent) => {
      const seeded = await pending(db);
      const decision = await asService(db, tx => approve(tx, seeded, user()));
      const original = await rowsFor(db, seeded.workspaceId, seeded.operation.id);
      const input = { workspaceId: seeded.workspaceId, operationId: seeded.operation.id, approvalId: decision.approval.id };
      const [first, second] = await Promise.all([asService(db, tx => repos.ownershipTransfers.recordForApprovedOperation(tx, input)), asService(independent, tx => repos.ownershipTransfers.recordForApprovedOperation(tx, input))]);
      expect(first).toHaveLength(1); expect(second).toEqual(first);
      expect(await rowsFor(db, seeded.workspaceId, seeded.operation.id)).toEqual(original);
    });
  }, 60_000);

  it("foreign, differently approved and revoked replays cannot rewrite or revive the stored transfer", async () => {
    await withNative(async (db, independent) => {
      const seeded = await pending(db, 2);
      const first = await asService(db, tx => approve(tx, seeded, user()));
      expect(first.operation.status).toBe("awaiting_approval");
      expect(await rowsFor(db, seeded.workspaceId, seeded.operation.id)).toEqual([]);
      const second = await asService(independent, tx => approve(tx, seeded, user()));
      expect(second.operation.status).toBe("approved");
      const original = await rowsFor(db, seeded.workspaceId, seeded.operation.id);
      const input = { workspaceId: seeded.workspaceId, operationId: seeded.operation.id, approvalId: second.approval.id };
      await expect(asService(db, tx => repos.ownershipTransfers.recordForApprovedOperation(tx, { ...input, workspaceId: newWorkspace() }))).rejects.toMatchObject({ code: "operation_not_found" });
      await expect(asService(db, tx => repos.ownershipTransfers.recordForApprovedOperation(tx, { ...input, approvalId: first.approval.id }))).rejects.toMatchObject({ code: "conflict" });
      expect(await rowsFor(db, seeded.workspaceId, seeded.operation.id)).toEqual(original);
      expect(await asService(db, tx => repos.ownershipTransfers.revoke(tx, { workspaceId: seeded.workspaceId, operationId: seeded.operation.id, transferDigest: transfer.digest, revokedBy: uid("human") }))).toBe(true);
      const revoked = await rowsFor(db, seeded.workspaceId, seeded.operation.id);
      await expect(asService(independent, tx => repos.ownershipTransfers.recordForApprovedOperation(tx, input))).rejects.toMatchObject({ code: "conflict" });
      expect(await rowsFor(db, seeded.workspaceId, seeded.operation.id)).toEqual(revoked);
      expect(await repos.ownershipTransfers.listActive(db, seeded.workspaceId, seeded.operation.environmentId!)).toEqual([]);
      await expect(asService(db, tx => tx.query("delete from platform.ownership_transfers where workspace_id=$1", [seeded.workspaceId]))).rejects.toMatchObject({ sqlstate: "42501" });
      await expect(asService(db, tx => tx.query("update platform.ownership_transfers set transfer_digest=$2 where workspace_id=$1", [seeded.workspaceId, "c".repeat(64)]))).rejects.toMatchObject({ sqlstate: "42501" });
      expect(await rowsFor(db, seeded.workspaceId, seeded.operation.id)).toEqual(revoked);
    });
  }, 60_000);
  it("rechecks a revoked enabling transfer after the owning operation lock wait without consuming approval", async () => {
    await withNative(async (db,independent) => {
      const owned=await admission(db), ready=signal<number>(), release=signal<void>(), started=signal<number>();
      const blocker=asService(independent,async tx=>{
        const [backend]=await tx.query<{pid:number}>("select pg_backend_pid() as pid");
        await tx.query("select id from platform.operations where workspace_id=$1 and id=$2 for update",[owned.workspaceId,owned.operationId]);
        ready.resolve(backend!.pid); await release.promise;
      }).then(()=>undefined,error=>{ready.reject(error);return error;});
      const blockerPid=await ready.promise;
      const attempt=asService(db,async tx=>{
        const [backend]=await tx.query<{pid:number}>("select pg_backend_pid() as pid"); started.resolve(backend!.pid);
        return repos.operations.claimForExecution(tx,owned.claim);
      }).then(value=>({value}),error=>({error}));
      try {
        await waitForNativeLock(db,await started.promise,blockerPid);
        expect(await repos.ownershipTransfers.revoke(db,{workspaceId:owned.workspaceId,operationId:owned.operationId,transferDigest:transfer.digest,revokedBy:uid("human")})).toBe(true);
      } finally { release.resolve(); expect(await blocker).toBeUndefined(); }
      expect(await attempt).toMatchObject({error:{code:"conflict",details:{reason:"field_ownership_conflict"}}});
      expect(await stateOf(db,owned)).toEqual({status:"approved",grants:0,consumed:0});
    });
  },60_000);

  it("rechecks a transfer whose one-way revocation committed during the native transfer row wait", async () => {
    await withNative(async (db,independent) => {
      const owned=await admission(db), ready=signal<number>(), release=signal<void>(), started=signal<number>();
      const blocker=asService(independent,async tx=>{
        const [backend]=await tx.query<{pid:number}>("select pg_backend_pid() as pid");
        expect(await repos.ownershipTransfers.revoke(tx,{workspaceId:owned.workspaceId,operationId:owned.operationId,transferDigest:transfer.digest,revokedBy:uid("human")})).toBe(true);
        ready.resolve(backend!.pid); await release.promise;
      }).then(()=>undefined,error=>{ready.reject(error);return error;});
      const blockerPid=await ready.promise;
      const attempt=asService(db,async tx=>{
        const [backend]=await tx.query<{pid:number}>("select pg_backend_pid() as pid"); started.resolve(backend!.pid);
        return repos.operations.claimForExecution(tx,owned.claim);
      }).then(value=>({value}),error=>({error}));
      try { await waitForNativeLock(db,await started.promise,blockerPid); }
      finally { release.resolve(); expect(await blocker).toBeUndefined(); }
      expect(await attempt).toMatchObject({error:{code:"conflict",details:{reason:"field_ownership_conflict"}}});
      expect(await stateOf(db,owned)).toEqual({status:"approved",grants:0,consumed:0});
    });
  },60_000);

  it("rolls back approval consumption when the selected transfer expires during the real approval row wait", async () => {
    await withNative(async (db,independent) => {
      const owned=await admission(db,3_000), ready=signal<number>(), release=signal<void>(), started=signal<number>();
      const blocker=asService(independent,async tx=>{
        const [backend]=await tx.query<{pid:number}>("select pg_backend_pid() as pid");
        await tx.query("select id from platform.approvals where workspace_id=$1 and operation_id=$2 for update",[owned.workspaceId,owned.operationId]);
        ready.resolve(backend!.pid); await release.promise;
      }).then(()=>undefined,error=>{ready.reject(error);return error;});
      const blockerPid=await ready.promise;
      const attempt=asService(db,async tx=>{
        const [backend]=await tx.query<{pid:number}>("select pg_backend_pid() as pid"); started.resolve(backend!.pid);
        return repos.operations.claimForExecution(tx,owned.claim);
      }).then(value=>({value}),error=>({error}));
      try { await waitForNativeLock(db,await started.promise,blockerPid); await waitForExpiry(independent,owned); }
      finally { release.resolve(); expect(await blocker).toBeUndefined(); }
      expect(await attempt).toMatchObject({error:{code:"conflict",details:{reason:"field_ownership_conflict"}}});
      expect(await stateOf(db,owned)).toEqual({status:"approved",grants:0,consumed:0});
    });
  },60_000);

  it("refuses final mutation grant insertion after transfer expiry behind the actual cleanup coordinator", async () => {
    await withNative(async (db,independent) => {
      // Both direct permission and the existing IaC warning can depend on a
      // live transfer from autoscaler; neither survives its native expiry.
      for (const to of ["native-op","iac"] as const) {
      const owned=await admission(db,3_000,to);
      await asService(db,tx=>repos.operations.claimForExecution(tx,owned.claim));
      await db.query("insert into platform.cleanup_writer_scopes(workspace_id) values($1) on conflict do nothing",[owned.workspaceId]);
      const ready=signal<number>(),release=signal<void>(),started=signal<number>();
      const blocker=asService(independent,async tx=>{
        const [backend]=await tx.query<{pid:number}>("select pg_backend_pid() as pid");
        await tx.query("select workspace_id from platform.cleanup_writer_scopes where workspace_id=$1 for update",[owned.workspaceId]);
        ready.resolve(backend!.pid);await release.promise;
      }).then(()=>undefined,error=>{ready.reject(error);return error;});
      const blockerPid=await ready.promise;
      const attempt=asService(db,async tx=>{
        const [backend]=await tx.query<{pid:number}>("select pg_backend_pid() as pid");started.resolve(backend!.pid);
        return repos.grants.insert(tx,owned.grant);
      }).then(value=>({value}),error=>({error}));
      try { await waitForNativeLock(db,await started.promise,blockerPid); await waitForExpiry(independent,owned); }
      finally { release.resolve();expect(await blocker).toBeUndefined(); }
      expect(await attempt).toMatchObject({error:{code:"conflict",details:{reason:"field_ownership_conflict"}}});
      expect(await stateOf(db,owned)).toEqual({status:"running",grants:0,consumed:1});
      expect(await repos.grants.get(db,owned.workspaceId,owned.grant.jti)).toBeNull();
      }
    });
  },60_000);

  it("refuses claim after a resource autoscaling fact commits during the owning operation wait", async () => {
    await withNative(async (db, independent) => {
      const owned = await manifestAdmission(db);
      const result = await claimAfterFactCommit(db, independent, owned, tx => {
        const spec = { ...owned.node.spec, autoscaling: true };
        return repos.resources.upsertDesired(tx, { workspaceId: owned.workspaceId, environmentId: owned.environmentId,
          projectId: owned.projectId, node: { ...owned.node, spec, specDigest: digest(spec) } });
      });
      expect((await repos.resources.get(db, owned.workspaceId, owned.resourceId))?.spec.autoscaling).toBe(true);
      expect(result).toMatchObject({ error: { code: "conflict", details: { reason: "field_ownership_conflict" } } });
      expect(await stateOf(db, owned)).toEqual({ status: "approved", grants: 0, consumed: 0 });
    });
  }, 60_000);

  it("refuses claim after a newly inserted autoscaler commits during the owning operation wait", async () => {
    await withNative(async (db, independent) => {
      const owned = await manifestAdmission(db);
      const result = await claimAfterFactCommit(db, independent, owned, tx => addAutoscaler(tx, owned));
      expect((await repos.resources.getByAddress(db, owned.workspaceId, owned.environmentId, "native/web-autoscaler"))?.spec)
        .toEqual({ config: { target: owned.node.address } });
      expect(result).toMatchObject({ error: { code: "conflict", details: { reason: "field_ownership_conflict" } } });
      expect(await stateOf(db, owned)).toEqual({ status: "approved", grants: 0, consumed: 0 });
    });
  }, 60_000);

  it("refuses a mutation grant after a new autoscaler commits through the environment coordinator", async () => {
    await withNative(async (db, independent) => {
      const owned = await manifestAdmission(db);
      await asService(db, tx => repos.operations.claimForExecution(tx, owned.claim));
      const attempt = await grantAfterFactCommit(db, independent, owned, tx => addAutoscaler(tx, owned));
      expect(await attempt).toMatchObject({ error: { code: "conflict", details: { reason: "field_ownership_conflict" } } });
      expect(await repos.grants.get(db, owned.workspaceId, owned.grant.jti)).toBeNull();
      expect(await stateOf(db, owned)).toEqual({ status: "running", grants: 0, consumed: 1 });
    });
  }, 60_000);

  it("revokes an issued native write grant, and refuses its consume, once an autoscaler took the field before use", async () => {
    await withNative(async (db, independent) => {
      const owned = await manifestAdmission(db);
      await asService(db, tx => repos.operations.claimForExecution(tx, owned.claim));
      await asService(db, tx => repos.grants.insert(tx, owned.grant));
      expect(await repos.grants.isRevoked(db, owned.workspaceId, owned.grant.jti)).toBe(false);
      // The autoscaler attaches after issue and before the worker uses the grant.
      await asService(independent, tx => addAutoscaler(tx, owned));
      // Revocation is the gate every execution surface checks (runner claim, dispatch, credential broker).
      expect(await repos.grants.isRevoked(db, owned.workspaceId, owned.grant.jti)).toBe(true);
      await expect(asService(db, tx => repos.grants.consume(tx, { workspaceId: owned.workspaceId, jti: owned.grant.jti, audience: "worker" })))
        .rejects.toMatchObject({ code: "conflict", details: { reason: "field_ownership_conflict" } });
      expect((await repos.grants.get(db, owned.workspaceId, owned.grant.jti))?.consumedAt).toBeUndefined();
    });
  }, 60_000);

  it("revokes a live drift.repair reapply grant once another operation's ownership transfer lands in its environment", async () => {
    await withNative(async (db, independent) => {
      const owned = await manifestAdmission(db, "drift.repair");
      await asService(db, tx => repos.operations.claimForExecution(tx, owned.claim));
      // Admission derives the reapplied fields from the proposal input: replicas is IaC-owned here, so the grant issues.
      await asService(db, tx => repos.grants.insert(tx, owned.grant));
      expect(await repos.grants.isRevoked(db, owned.workspaceId, owned.grant.jti)).toBe(false);
      const other = await seedAwaitingApproval(db, { workspaceId: owned.workspaceId, proposal: {
        capability: "service.scale", scope: { workspaceId: owned.workspaceId, projectId: owned.projectId, environmentId: owned.environmentId, resourceId: owned.resourceId } } });
      const decision = await asService(db, tx => approve(tx, other, user()));
      const receipt = transferRequest({ address: owned.node.address, resourceType: owned.node.nativeType, path: "replicas", from: "iac", to: "native-op" });
      await asService(independent, tx => tx.query(`insert into platform.ownership_transfers
        (id,workspace_id,project_id,environment_id,address,resource_type,field_path,from_owner,to_owner,transfer_digest,operation_id,approval_id,proposal_digest,approved_at,expires_at)
        select $1,o.workspace_id,o.project_id,o.environment_id,$2,$3,$4,$5,$6,$7,o.id,a.id,o.proposal_digest,a.created_at,null
        from platform.operations o join platform.approvals a on a.workspace_id=o.workspace_id and a.operation_id=o.id
        where o.workspace_id=$8 and o.id=$9 and a.id=$10 and a.decision='approve' and a.proposal_digest=o.proposal_digest`,
        [uid("own"), receipt.address, receipt.resourceType, receipt.path, receipt.from, receipt.to, receipt.digest, owned.workspaceId, other.operation.id, decision.approval.id]));
      // The IaC reapply would now revert a native-op-owned field: its grant is revoked, not left usable.
      expect(await repos.grants.isRevoked(db, owned.workspaceId, owned.grant.jti)).toBe(true);
    });
  }, 60_000);

  it("retains uncertain late evidence for a preissued write after current ownership changes", async () => {
    await withNative(async (db, independent) => {
      const owned = await manifestAdmission(db);
      await asService(db, tx => repos.operations.claimForExecution(tx, owned.claim));
      await asService(db, tx => repos.grants.insert(tx, owned.grant));
      expect(await asService(db, tx => repos.grants.consume(tx, { workspaceId: owned.workspaceId, jti: owned.grant.jti, audience: "worker" }))).toBe(true);
      const originalGrant = await repos.grants.get(db, owned.workspaceId, owned.grant.jti);
      expect(originalGrant?.consumedAt).toEqual(expect.any(String));
      const serviceSql: Sql = {
        query: <T>(text: string, params?: readonly unknown[]) => asService(db, tx => tx.query<T>(text, params)),
        tx: <T>(fn: (tx: Sql) => Promise<T>) => asService(db, fn),
      };
      const ledger = createEffectLedger(serviceSql), entered = signal<EffectRecord>(), release = signal<void>();
      const input = { workspaceId: owned.workspaceId, operationId: owned.operationId, environmentId: owned.environmentId,
        family: "proxy_request" as const, provider: "aws", dedupKey: `${owned.operationId}:scale`, requestDigest: digest({ replicas: 3 }),
        idempotencySupported: false, fence: { scope: owned.claim.lease.scope, token: owned.claim.lease.fenceToken }, actor: "fixture:worker" };
      const receipt = { resourceId: "fixture:ecs-service", requestIds: ["fixture:accepted-scale"] };
      let calls = 0;
      // Only the provider callback is modeled. SQL grant/effect authority and dispatch-once behavior are real.
      const delivery = ledger.dispatchOnce(input, async effect => {
        calls++; entered.resolve(effect); await release.promise;
        return { value: "modeled-accepted-write", receipt };
      }).then(value => ({ value }), error => { entered.reject(error); return { error }; });
      let effect: EffectRecord | undefined;
      try {
        effect = await entered.promise;
        await asService(independent, tx => addAutoscaler(tx, owned));
        await ledger.markUncertain(owned.workspaceId, effect.effectId, "Modeled reply not yet observed.");
        await expect(asService(db, tx => repos.grants.insert(tx, { ...owned.grant, jti: uid("later") })))
          .rejects.toMatchObject({ code: "conflict", details: { reason: "field_ownership_conflict" } });
      } finally { release.resolve(); await delivery; }
      expect(await delivery).toMatchObject({ value: { kind: "dispatched", effect: { state: "uncertain" } } });
      const retained = await ledger.get(owned.workspaceId, effect!.effectId);
      expect(retained).toMatchObject({ operationId: owned.operationId, family: "proxy_request", dedupKey: input.dedupKey,
        requestDigest: input.requestDigest, fenceScope: input.fence.scope, fenceEpoch: input.fence.token,
        state: "uncertain", lateReceipt: { ...receipt, staleFence: false } });
      expect((await ledger.begin(input))).toMatchObject({ created: false, effect: { effectId: effect!.effectId, state: "uncertain" } });
      await expect(ledger.dispatchOnce(input, async () => { calls++; return { value: "unexpected-retry", receipt }; }))
        .rejects.toMatchObject({ code: "effect_unresolved", state: "uncertain" });
      expect((await ledger.unresolvedForOperation(owned.workspaceId, owned.operationId)).map(row => row.effectId)).toEqual([effect!.effectId]);
      expect(calls).toBe(1);
      expect(await repos.grants.get(db, owned.workspaceId, owned.grant.jti)).toEqual(originalGrant);
      expect(await stateOf(db, owned)).toEqual({ status: "running", grants: 1, consumed: 1 });
      // Explicit uncertainty marking proves retention, not automatic revocation or real provider quiescence.
    });
  }, 60_000);

  it("refuses a grant after a direct service-role autoscaler INSERT commits during its coordinator wait", async () => {
    await withNative(async (db, independent) => {
      const owned = await manifestAdmission(db);
      await asService(db, tx => repos.operations.claimForExecution(tx, owned.claim));
      const result = await grantAfterFactCommit(db, independent, owned, tx => tx.query(`insert into platform.resources
        (id,workspace_id,environment_id,address,kind,provider,native_type,ownership,spec_digest,spec)
        values($1,$2,$3,'native/web-autoscaler','provider_native','aws','aws:appautoscaling_target','managed',$4,$5::text::jsonb)`,
      [uid("res"), owned.workspaceId, owned.environmentId, digest({ config: { target: owned.node.address } }),
        JSON.stringify({ config: { target: owned.node.address } })]));
      expect(result).toMatchObject({ error: { code: "conflict", details: { reason: "field_ownership_conflict" } } });
      expect(await stateOf(db, owned)).toEqual({ status: "running", grants: 0, consumed: 1 });
    });
  }, 60_000);

  it("blocks an independent owner INSERT while retaining final-statement snapshot refusal", async () => {
    await withNative(async (db, independent) => {
      const owned = await manifestAdmission(db);
      await asService(db, tx => repos.operations.claimForExecution(tx, owned.claim));
      const ready = signal<number>(), release = signal<void>(), writerStarted = signal<number>(), writerRelease = signal<void>(), writerInserted = signal<void>();
      const insertedOutcome = writerInserted.promise.then(() => undefined, error => error);
      let finalStatements = 0;
      const queries: string[] = [];
      const result = asService(db, tx => {
        const observe = (current: Sql): Sql => ({
          query: async <T>(text: string, params?: readonly unknown[]): Promise<T[]> => {
            queries.push(text);
            if (text.includes("insert into platform.capability_grants") && text.includes("from platform.operations o")) {
              finalStatements++;
              expect(queries.some(query => query.includes("pg_advisory_xact_lock"))).toBe(true);
              expect(queries.some(query => query.includes("as snapshot from platform.resources"))).toBe(true);
              expect(await current.query("select count(*)::integer as count from platform.resources where workspace_id=$1 and environment_id=$2",
                [owned.workspaceId, owned.environmentId])).toEqual([{ count: 1 }]);
              const [backend] = await current.query<{ pid: number }>("select pg_backend_pid() as pid");
              ready.resolve(backend!.pid); await release.promise;
              // Same-transaction mutation can reacquire its coordinator. Its
              // distinct address proves final refusal rolls back this row.
              const spec = { config: { target: owned.node.address } };
              await repos.resources.upsertDesired(current, { workspaceId: owned.workspaceId, environmentId: owned.environmentId,
                projectId: owned.projectId, node: { address: "native/injected-autoscaler", kind: "provider_native", provider: "aws", region: "us-east-1",
                  nativeType: "aws:appautoscaling_target", ownership: "managed", spec, specDigest: digest(spec), origin: ["web"], dependsOn: [], labels: {} } });
            }
            return current.query<T>(text, params);
          },
          tx: fn => current.tx(inner => fn(observe(inner))),
        });
        return repos.grants.insert(observe(tx), owned.grant);
      }).then(value => ({ value }), error => { ready.reject(error); return { error }; });
      let writer: Promise<unknown> | undefined;
      try {
        const blockerPid = await ready.promise;
        writer = asService(independent, async tx => {
          const [backend] = await tx.query<{ pid: number }>("select pg_backend_pid() as pid");
          writerStarted.resolve(backend!.pid);
          await addAutoscaler(tx, owned); writerInserted.resolve(); await writerRelease.promise;
        }).then(() => undefined, error => { writerStarted.reject(error); writerInserted.reject(error); return error; });
        const waiterPid = await writerStarted.promise;
        expect(waiterPid).not.toBe(blockerPid);
        await waitForNativeLock(db, waiterPid, blockerPid);
        expect(await db.query("select locktype from pg_locks where pid=$1 and locktype='advisory' and not granted", [waiterPid]))
          .toEqual([{ locktype: "advisory" }]);
        release.resolve();
        expect(await result).toMatchObject({ error: { code: "conflict", details: { reason: "field_ownership_conflict" } } });
        expect(await insertedOutcome).toBeUndefined();
        expect(await repos.resources.getByAddress(db, owned.workspaceId, owned.environmentId, "native/injected-autoscaler")).toBeNull();
        expect(await repos.resources.getByAddress(db, owned.workspaceId, owned.environmentId, "native/web-autoscaler")).toBeNull();
      } finally { release.resolve(); writerRelease.resolve(); await result; expect(await writer).toBeUndefined(); }
      expect(finalStatements).toBe(1);
      expect(await repos.resources.getByAddress(db, owned.workspaceId, owned.environmentId, "native/web-autoscaler")).not.toBeNull();
      expect(await repos.resources.getByAddress(db, owned.workspaceId, owned.environmentId, "native/injected-autoscaler")).toBeNull();
      expect(await stateOf(db, owned)).toEqual({ status: "running", grants: 0, consumed: 1 });
    });
  }, 60_000);

  it("admits an unchanged inventory without rounding PostgreSQL JSONB numeric facts", async () => {
    await withNative(async db => {
      const owned = await manifestAdmission(db);
      await asService(db, tx => tx.query("update platform.resources set spec=jsonb_set(spec,'{exact}',to_jsonb(9007199254740993::bigint)) where workspace_id=$1 and id=$2",
        [owned.workspaceId, owned.resourceId]));
      expect(await db.query("select spec->>'exact' as exact from platform.resources where workspace_id=$1 and id=$2",
        [owned.workspaceId, owned.resourceId])).toEqual([{ exact: "9007199254740993" }]);
      await asService(db, tx => repos.operations.claimForExecution(tx, owned.claim));
      expect(await asService(db, tx => repos.grants.insert(tx, owned.grant))).toMatchObject({ jti: owned.grant.jti });
      expect(await stateOf(db, owned)).toEqual({ status: "running", grants: 1, consumed: 1 });
    });
  }, 60_000);

  it("keeps unrelated workspace and environment ownership inventories outside grant admission", async () => {
    await withNative(async (db, independent) => {
      const owned = await manifestAdmission(db);
      await asService(db, tx => repos.operations.claimForExecution(tx, owned.claim));
      await asService(independent, async tx => {
        await addAutoscaler(tx, { ...owned, environmentId: uid("other-env") });
        await addAutoscaler(tx, { ...owned, workspaceId: newWorkspace(), environmentId: uid("foreign-env") });
      });
      expect(await asService(db, tx => repos.grants.insert(tx, owned.grant))).toMatchObject({ jti: owned.grant.jti });
      expect(await stateOf(db, owned)).toEqual({ status: "running", grants: 1, consumed: 1 });
    });
  }, 60_000);

  it("refuses grant admission when its scoped resource target is missing", async () => {
    await withNative(async db => {
      const owned = await manifestAdmission(db);
      await asService(db, tx => repos.operations.claimForExecution(tx, owned.claim));
      await asService(db, tx => tx.query("delete from platform.resources where workspace_id=$1 and id=$2", [owned.workspaceId, owned.resourceId]));
      await expect(asService(db, tx => repos.grants.insert(tx, owned.grant)))
        .rejects.toMatchObject({ code: "conflict", details: { reason: "field_ownership_conflict" } });
      expect(await stateOf(db, owned)).toEqual({ status: "running", grants: 0, consumed: 1 });
    });
  }, 60_000);

  it("refuses grant admission when the complete ownership inventory exceeds 2000 nodes", async () => {
    await withNative(async db => {
      const owned = await manifestAdmission(db);
      await asService(db, tx => repos.operations.claimForExecution(tx, owned.claim));
      await asService(db, tx => tx.query(`insert into platform.resources
        (id,workspace_id,environment_id,address,kind,provider,native_type,ownership,spec_digest,spec)
        select $1||n::text,$2,$3,'native/bound-'||n::text,'provider_native','aws','aws:fixture','managed',$4,'{}'::jsonb
        from generate_series(1,2000) n`, [uid("bound"), owned.workspaceId, owned.environmentId, digest({})]));
      expect(await db.query("select count(*)::integer as count from platform.resources where workspace_id=$1 and environment_id=$2",
        [owned.workspaceId, owned.environmentId])).toEqual([{ count: 2001 }]);
      await expect(asService(db, tx => repos.grants.insert(tx, owned.grant)))
        .rejects.toMatchObject({ code: "conflict", details: { reason: "field_ownership_conflict" } });
      expect(await stateOf(db, owned)).toEqual({ status: "running", grants: 0, consumed: 1 });
    });
  }, 60_000);
});
