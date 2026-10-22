/** Actual SQL and canonical Broker. PGlite is a semantic lane; only PostgreSQL has independent backends/lock waits. */
import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it, vi } from "vitest";
import { digest } from "@/lib/controlplane/digest";
import { createBroker } from "@/lib/capabilities/platform";
import { openPlatformDb, PLATFORM_MIGRATIONS, migratePlatformDb, assertPlatformSchemaCurrent, type PlatformDbHandle } from "@/lib/controlplane/db";
import { renderSupabaseMigration } from "@/lib/controlplane/db/migrations/emit";
import { PlatformBrokerStore } from "@/lib/capabilities/platform-store";
import { withScratchDatabase } from "./_support/harness";
import { migration0012WorkflowStartIntents } from "@/lib/controlplane/db/migrations/0012_workflow_start_intents";
import * as intents from "@/lib/controlplane/db/repos/workflow-start-intents";
import * as operations from "@/lib/controlplane/db/repos/operations";
import { allowDecision, approveAs, closeSharedPgliteAfterAll, makeHarness, PG_URL, proposeOk, requestFor,
  requireApproval, scriptedEngine, user } from "../capabilities/support";

if (process.env.ZENITH_TEST_WORKFLOW_START_REQUIRED === "1" && !PG_URL) throw new Error("Workflow start acceptance requires an owned PostgreSQL database.");
closeSharedPgliteAfterAll();
const kinds = ["pglite",...(PG_URL ? ["postgres"] : [])] as ("pglite"|"postgres")[];
let independentPg: Promise<PlatformDbHandle>|undefined;
let observerPg: Promise<PlatformDbHandle>|undefined;
afterAll(async()=>{await (await independentPg)?.close();await (await observerPg)?.close();});
const wait=(ms:number)=>new Promise<void>(resolve=>setTimeout(resolve,ms));
function barrier() { let release!:()=>void; const promise=new Promise<void>(resolve=>{release=resolve;}); return {promise,release}; }

async function fixture(kind:"pglite"|"postgres", approved=true, lease=false) {
  const h=await makeHarness({kind,engine:scriptedEngine("start-one",()=>approved ? requireApproval(1,"admin") : allowDecision())});
  const db=h.db!; await db.exec(migration0012WorkflowStartIntents.sql);
  const db2=kind === "postgres" ? await (independentPg ??= openPlatformDb({kind:"postgres",url:PG_URL!,max:2,migrate:false})) : db;
  const op=await proposeOk(h,requestFor(h,"service.restart","prod"),user("bob"));
  if(approved) await approveAs(h,op.operation,"erin");
  const fence=lease ? await h.acquireLease(h.ids.envAProd) : undefined;
  await h.broker.beginExecution({workspaceId:h.ids.wsA,operationId:op.id,holder:`workflow:${op.id}`,audience:"worker",leaseMs:60_000,...(fence ? {lease:fence} : {})});
  const request:intents.StartRequest={kind:"dayTwo",arguments:{workspaceId:h.ids.wsA,operationId:op.id,environmentId:h.ids.envAProd,capability:"service.restart"},
    namespace:"default",endpointDigest:digest("isolated frontend"),taskQueue:"isolated-start-contract"};
  const store=intents.createIsolatedStartIntentStoreForTests(h.broker);
  return {h,db,db2,op,request,store,fence};
}

describe.each(kinds)("workflow start intents [%s]",kind=>{
  it("commits typed immutable intent before a sole claim; competing workers retain one permanent attempt",async()=>{
    const f=await fixture(kind);
    const prepared=await f.store.prepare(f.db,f.request);
    expect(prepared.phase).toBe("prepared");
    expect((await intents.get(f.db2,f.h.ids.wsA,f.op.id))?.binding_digest).toBe(prepared.binding_digest);
    const claims=await Promise.all([f.store.claim(f.db,f.request),f.store.claim(f.db2,f.request)]);
    expect(claims.filter(c=>c.dispatch)).toHaveLength(1);
    expect(new Set(claims.map(c=>c.intent.attempt_id)).size).toBe(1);
    await f.db.query("update platform.operations set lease_until=clock_timestamp()-interval '1 second' where workspace_id=$1 and id=$2",[f.h.ids.wsA,f.op.id]);
    expect((await f.store.claim(f.db2,f.request)).dispatch).toBe(false);
    expect(await f.db.query("select phase from platform.workflow_start_intents where workspace_id=$1 and operation_id=$2",[f.h.ids.wsA,f.op.id])).toEqual([{phase:"attempted"}]);
  });
  it("an operation reopened after a restore binds a new epoch-scoped workflow id; epoch 0 keeps the historical id",async()=>{
    const f=await fixture(kind);
    await f.db.query("update platform.operations set recovery_epoch=3 where workspace_id=$1 and id=$2",[f.h.ids.wsA,f.op.id]);
    const prepared=await f.store.prepare(f.db,f.request);
    expect(prepared.binding.workflowId).toBe(`op-${f.op.id}-e3`);
    expect(prepared.binding.recoveryEpoch).toBe(3);
    expect((await intents.get(f.db2,f.h.ids.wsA,f.op.id))?.binding.workflowId).toBe(`op-${f.op.id}-e3`);
    const plain=await fixture(kind);
    // The column defaults to the database-wide current epoch, which concurrent recovery suites may advance.
    await plain.db.query("update platform.operations set recovery_epoch=0 where workspace_id=$1 and id=$2",[plain.h.ids.wsA,plain.op.id]);
    expect((await plain.store.prepare(plain.db,plain.request)).binding.workflowId).toBe(`op-${plain.op.id}`);
  });
  it("rebinds an alternative broker store to the actual locked SQL authority rather than trusting another approval ledger",async()=>{
    const f=await fixture(kind),other=await makeHarness({kind:"memory"});
    const actual=createBroker({...f.h.deps,store:other.store});
    const store=intents.createIsolatedStartIntentStoreForTests(actual);
    expect(await other.store.listApprovals(f.h.ids.wsA,f.op.id)).toHaveLength(0);
    await store.prepare(f.db,f.request);expect((await store.claim(f.db2,f.request)).dispatch).toBe(true);
    expect((await intents.get(f.db,f.h.ids.wsA,f.op.id))?.phase).toBe("attempted");
  });
  it("rollback leaves no prepared intent or attempt; commit acknowledgement loss preserves the attempted tombstone",async()=>{
    const f=await fixture(kind);
    await expect(f.db.tx(async tx=>{await f.store.prepare(tx,f.request);throw new Error("precommit interruption");})).rejects.toThrow("precommit");
    expect(await intents.get(f.db2,f.h.ids.wsA,f.op.id)).toBeNull();
    await f.store.prepare(f.db,f.request);
    await expect(f.db.tx(async tx=>{await f.store.claim(tx,f.request);throw new Error("precommit interruption");})).rejects.toThrow("precommit");
    expect((await intents.get(f.db2,f.h.ids.wsA,f.op.id))?.phase).toBe("prepared");
    const committed=await f.store.claim(f.db,f.request);
    // Lose the return value after an actual commit. This is an injected ACK loss, not a process-kill test.
    await expect(Promise.resolve(committed).then(()=>{throw new Error("postcommit acknowledgement lost");})).rejects.toThrow("postcommit");
    expect((await f.store.claim(f.db2,f.request)).dispatch).toBe(false);
  });
  it("different arguments, kind, destination, queue and foreign tenant cannot replace the first binding",async()=>{
    const f=await fixture(kind);await f.store.prepare(f.db,f.request);
    const variants:intents.StartRequest[]=[
      {...f.request,arguments:{...f.request.arguments,capability:"service.scale"}},
      {...f.request,kind:"destroy",arguments:{workspaceId:f.h.ids.wsA,operationId:f.op.id,environmentId:f.h.ids.envAProd}},
      {...f.request,namespace:"another"},{...f.request,endpointDigest:digest("another frontend")},{...f.request,taskQueue:"another-queue"},
      {...f.request,arguments:{...f.request.arguments,workspaceId:f.h.ids.wsB}},
    ];
    for(const request of variants) await expect(f.store.prepare(f.db2,request)).rejects.toBeInstanceOf(intents.WorkflowStartIntentError);
    await expect(f.db.query("update platform.workflow_start_intents set binding_digest=$3 where workspace_id=$1 and operation_id=$2",[f.h.ids.wsA,f.op.id,digest("changed")])).rejects.toThrow();
    await expect(f.db.query("delete from platform.workflow_start_intents where workspace_id=$1 and operation_id=$2",[f.h.ids.wsA,f.op.id])).rejects.toThrow();
    expect((await intents.get(f.db2,f.h.ids.wsA,f.op.id))?.phase).toBe("prepared");
  });
  it.each(["expired approval","revoked role","raised count","policy deny","expired operation","cancelled","lost fence"])("refuses new dispatch under %s",async(change)=>{
    const f=await fixture(kind,true,true);await f.store.prepare(f.db,f.request);
    if(change === "expired approval") await f.h.expireApprovals(f.op.id);
    if(change === "revoked role") f.h.world.members.set(`${f.h.ids.wsA}|erin`,"viewer");
    if(change === "raised count") f.h.setEngine(scriptedEngine("start-two",()=>requireApproval(2,"admin")));
    if(change === "policy deny") f.h.setEngine(scriptedEngine("start-deny",()=>({outcome:"deny",reasons:[]})));
    if(change === "expired operation") await f.h.expireOperation(f.op.id);
    if(change === "cancelled") await operations.transition(f.db,{workspaceId:f.h.ids.wsA,id:f.op.id,from:["running"],to:"cancelled"});
    if(change === "lost fence") await f.h.loseLease(f.fence!.scope);
    await expect(f.store.claim(f.db2,f.request)).rejects.toThrow();
    expect((await intents.get(f.db2,f.h.ids.wsA,f.op.id))?.phase).toBe("prepared");
  });
  it("late matching acknowledgement survives cancellation and reaper; first receipt wins and queue never reopens",async()=>{
    const f=await fixture(kind);await f.store.prepare(f.db,f.request);
    const attempted=(await f.store.claim(f.db,f.request)).intent;
    await operations.transition(f.db,{workspaceId:f.h.ids.wsA,id:f.op.id,from:["running"],to:"cancelled"});
    await operations.markUncertainExpired(f.db2);
    const observed={runId:randomUUID(),startedAt:new Date().toISOString(),evidenceDigest:digest("trusted exact reader fixture")};
    const records=await Promise.all([intents.acknowledge(f.db,attempted,observed),intents.acknowledge(f.db2,attempted,observed)]);
    expect(records.every(r=>r.phase === "acknowledged" && r.run_id === observed.runId)).toBe(true);
    await expect(intents.acknowledge(f.db2,attempted,{...observed,runId:randomUUID()})).rejects.toThrow();
    await expect(intents.acknowledge(f.db2,attempted,{...observed,evidenceDigest:digest("different")})).rejects.toThrow();
    expect((await f.store.claim(f.db2,f.request)).dispatch).toBe(false);
    expect((await operations.get(f.db2,f.h.ids.wsA,f.op.id))?.status).toBe("cancelled");
  });
  it("proposal-approved deploy starts before executable plan approval; preApproved cannot supply missing authority",async()=>{
    const h=await makeHarness({kind,engine:scriptedEngine("proposal-human",()=>requireApproval(1,"admin"))});
    await h.db!.exec(migration0012WorkflowStartIntents.sql);
    const p=await proposeOk(h,requestFor(h,"deployment.deploy","prod",{input:{revisionId:"rev-start",deploymentId:"dep-start"}}),user("bob"));
    await approveAs(h,p.operation,"erin");
    await h.broker.beginExecution({workspaceId:h.ids.wsA,operationId:p.id,holder:`workflow:${p.id}`,audience:"worker",leaseMs:60_000});
    const request:intents.StartRequest={kind:"deploy",arguments:{workspaceId:h.ids.wsA,operationId:p.id,projectId:h.ids.projA,environmentId:h.ids.envAProd,
      revisionId:"rev-start",deploymentId:"dep-start",connectionId:"product-connection",preApproved:true,build:true},namespace:"default",endpointDigest:digest("frontend"),taskQueue:"proposal-plan-contract"};
    const store=intents.createIsolatedStartIntentStoreForTests(h.broker);
    expect((await operations.get(h.db!,h.ids.wsA,p.id))?.planDigest).toBeUndefined();
    await store.prepare(h.db!,request);expect((await store.claim(h.db!,request)).dispatch).toBe(true);
    const missing=await proposeOk(h,requestFor(h,"deployment.deploy","prod",{input:{revisionId:"rev-other",deploymentId:"dep-other"}}),user("bob"));
    await expect(store.prepare(h.db!,{...request,arguments:{...request.arguments,operationId:missing.id,revisionId:"rev-other",deploymentId:"dep-other",preApproved:true}})).rejects.toThrow();
  });
  it("approved read-only teardown review may be admitted before its worker claims the operation",async()=>{
    const h=await makeHarness({kind,engine:scriptedEngine("plan-read",()=>allowDecision())});await h.db!.exec(migration0012WorkflowStartIntents.sql);
    const p=await proposeOk(h,requestFor(h,"infrastructure.plan","prod",{input:{environmentId:h.ids.envAProd,teardownReview:true,refresh:false}}),user("bob"));
    const store=intents.createIsolatedStartIntentStoreForTests(h.broker);
    const request:intents.StartRequest={kind:"teardownReview",arguments:{workspaceId:h.ids.wsA,operationId:p.id},namespace:"default",endpointDigest:digest("frontend"),taskQueue:"read-only-planner"};
    await store.prepare(h.db!,request);expect((await store.claim(h.db!,request)).dispatch).toBe(true);
    expect((await operations.get(h.db!,h.ids.wsA,p.id))?.status).toBe("approved");
  });
  it.each([["system.metrics",true],["logs.read",false]] as const)("day-two admission of read-only %s is %s (machine health reads only)",async(cap,admitted)=>{
    const h=await makeHarness({kind,engine:scriptedEngine("read-only",()=>allowDecision())});await h.db!.exec(migration0012WorkflowStartIntents.sql);
    const p=await proposeOk(h,requestFor(h,cap,"prod"),user("bob"));
    await h.broker.beginExecution({workspaceId:h.ids.wsA,operationId:p.id,holder:`workflow:${p.id}`,audience:"worker",leaseMs:60_000});
    const store=intents.createIsolatedStartIntentStoreForTests(h.broker);
    const prepared=store.prepare(h.db!,{kind:"dayTwo",arguments:{workspaceId:h.ids.wsA,operationId:p.id,environmentId:h.ids.envAProd,capability:cap},
      namespace:"default",endpointDigest:digest("frontend"),taskQueue:"health-read"});
    if(admitted) expect((await prepared).phase).toBe("prepared"); else await expect(prepared).rejects.toThrow();
  });
  it("an approved but unclaimed mutation operation cannot use workflow admission to consume or bypass its execution claim",async()=>{
    const h=await makeHarness({kind,engine:scriptedEngine("allow-proposal",()=>allowDecision())});await h.db!.exec(migration0012WorkflowStartIntents.sql);
    const p=await proposeOk(h,requestFor(h,"service.restart","prod"),user("bob"));
    const store=intents.createIsolatedStartIntentStoreForTests(h.broker);
    await expect(store.prepare(h.db!,{kind:"dayTwo",arguments:{workspaceId:h.ids.wsA,operationId:p.id,environmentId:h.ids.envAProd,capability:"service.restart"},
      namespace:"default",endpointDigest:digest("frontend"),taskQueue:"unclaimed-mutation"})).rejects.toThrow();
    expect(await intents.get(h.db!,h.ids.wsA,p.id)).toBeNull();
    expect((await operations.get(h.db!,h.ids.wsA,p.id))?.status).toBe("approved");
  });
  if(kind === "postgres") it.each(["unchanged","demoted approver","raised count","current deny","approval expiry"])("after an observed final intent-row lock wait, %s is evaluated freshly",async(change)=>{
    const f=await fixture(kind);await f.store.prepare(f.db,f.request);
    const observer=await (observerPg ??= openPlatformDb({kind:"postgres",url:PG_URL!,max:1,migrate:false}));
    // Commit TTL setup before the claimant can lock the operation.
    await observer.query("update platform.operations set expires_at=clock_timestamp()+interval '60 seconds',lease_until=clock_timestamp()+interval '60 seconds' where workspace_id=$1 and id=$2",[f.h.ids.wsA,f.op.id]);
    await observer.query("update platform.approvals set expires_at=clock_timestamp()+interval '60 seconds' where workspace_id=$1 and operation_id=$2",[f.h.ids.wsA,f.op.id]);
    const locked=barrier(),release=barrier(),backendReady=barrier();let blockerPid=0,claimantPid=0;
    const blocking=f.db.tx(async tx=>{
      blockerPid=(await tx.query<{pid:number}>("select pg_backend_pid() as pid"))[0].pid;
      await tx.query("select operation_id from platform.workflow_start_intents where workspace_id=$1 and operation_id=$2 for update",[f.h.ids.wsA,f.op.id]);
      locked.release();await release.promise;
    });
    await Promise.race([locked.promise,blocking.then(()=>{throw new Error("Blocker exited before acquiring the owned intent-row lock.");})]);
    let settled=false;const claiming=f.db2.tx(async tx=>{
      claimantPid=(await tx.query<{pid:number}>("select pg_backend_pid() as pid"))[0].pid;
      backendReady.release();return f.store.claim(tx,f.request);
    }).then(value=>{settled=true;return value;},error=>{settled=true;throw error;});
    // Attach immediately so a failed assertion cannot produce an unhandled rejection.
    const result=claiming.then(value=>({value}),error=>({error}));
    let observationFailure:unknown;
    try {
      await Promise.race([backendReady.promise,result.then(()=>{throw new Error("Claim completed before its PostgreSQL backend was observed.");})]);
      expect(claimantPid).toBeGreaterThan(0);expect(claimantPid).not.toBe(blockerPid);
      const deadline=Date.now()+5000;let observed=false;
      while(Date.now()<deadline) {
        const state=await observer.tx(async fresh=>{
          await fresh.query("select pg_stat_clear_snapshot()");
          return (await fresh.query<{blocked:boolean;observer_pid:number}>(`select pg_backend_pid() as observer_pid,
            exists (select 1 from pg_stat_activity where pid=$1 and wait_event_type='Lock'
              and query=$3 and $2::integer=any(pg_blocking_pids(pid))) as blocked`,[claimantPid,blockerPid,
              "select * from platform.workflow_start_intents where workspace_id=$1 and operation_id=$2 for update"]))[0];
        });
        expect(state.observer_pid).not.toBe(claimantPid);expect(state.observer_pid).not.toBe(blockerPid);
        if(state.blocked){observed=true;break;}await wait(10);
      }
      expect(observed).toBe(true);expect(settled).toBe(false);
      expect((await intents.get(observer,f.h.ids.wsA,f.op.id))?.phase).toBe("prepared");
      if(change === "demoted approver") f.h.world.members.set(`${f.h.ids.wsA}|erin`,"viewer");
      if(change === "raised count") f.h.setEngine(scriptedEngine("after-wait-two",()=>requireApproval(2,"admin")));
      if(change === "current deny") f.h.setEngine(scriptedEngine("after-wait-deny",()=>({outcome:"deny",reasons:[]})));
      if(change === "approval expiry") await observer.query("update platform.approvals set expires_at=clock_timestamp()-interval '1 second' where workspace_id=$1 and operation_id=$2",[f.h.ids.wsA,f.op.id]);
      expect(await observer.query("select id from platform.operations where workspace_id=$1 and id=$2 and lease_until>clock_timestamp() and expires_at>clock_timestamp()",[f.h.ids.wsA,f.op.id])).toHaveLength(1);
    } catch(error) {observationFailure=error;} finally {release.release();await blocking;}
    const completed=await result;
    if(observationFailure)throw observationFailure;
    if(change === "unchanged") {expect(completed).toHaveProperty("value.dispatch",true);expect((await intents.get(f.db,f.h.ids.wsA,f.op.id))?.phase).toBe("attempted");}
    else {expect(completed).toHaveProperty("error");expect((await intents.get(f.db,f.h.ids.wsA,f.op.id))?.phase).toBe("prepared");}
  });
});

it("test-only captured broker authority is unavailable in production at creation and invocation",async()=>{
  const h=await makeHarness({kind:"pglite"});const store=intents.createIsolatedStartIntentStoreForTests(h.broker);
  const old=process.env.NODE_ENV;
  try {
    vi.stubEnv("NODE_ENV","production");
    expect(()=>intents.createIsolatedStartIntentStoreForTests(h.broker)).toThrow();
    expect(()=>store.prepare(h.db!,{} as intents.StartRequest)).toThrow();
  } finally {vi.stubEnv("NODE_ENV",old);}
});


// Actual creator defaults and SQL role checks, isolated in owned scratch DBs.
// The outer rollback removes test-only role DDL and the complete fixture; this
// proves privileges/CAS retention, not a crash/committed-transport experiment.
describe.skipIf(!PG_URL)("workflow start tombstone privileges [postgres]",()=>{
  it.each(["fresh","same-owner schema6"] as const)("%s migration12 refuses inherited TRUNCATE and retains the attempted tombstone",async mode=>{
    await withScratchDatabase(async url=>{
      const db=await openPlatformDb({kind:"postgres",url,migrate:false,max:1});
      const rollback=new Error("Deliberate owned workflow tombstone privilege rollback.");
      try {
        const result=await db.tx(async tx=>{
          await db.exec("do $$ begin if not exists (select 1 from pg_roles where rolname='service_role') then create role service_role nologin noinherit bypassrls; end if; end $$;");
          const owner=(await tx.query<{name:string}>("select current_user as name"))[0].name;
          if(mode==="same-owner schema6") {
            const emitted=renderSupabaseMigration(),seventh=emitted.indexOf("-- ============================ migration 7: plan_artifacts"),
              hardening=emitted.indexOf("-- ============================ hardening (Supabase roles)");
            if(seventh<0 || hardening<seventh)throw new Error("Canonical legacy fixture boundaries are unavailable.");
            await db.exec(emitted.slice(0,seventh)+emitted.slice(hardening));
            // Existing same-creator ALL defaults are a supported upgrade
            // counterexample, not a claim about the emitted hardening's bytes.
            await tx.query("alter default privileges in schema platform grant all on tables to service_role");
            await tx.query("create table platform.workflow_start_acl_probe(id integer)");
            for(const privilege of ["SELECT","INSERT","UPDATE","DELETE","TRUNCATE","REFERENCES","TRIGGER"])
              expect((await tx.query<{inherited:boolean}>("select has_table_privilege('service_role','platform.workflow_start_acl_probe',$1) as inherited",[privilege]))[0].inherited,
                `existing same-creator ${privilege}`).toBe(true);
            await tx.query("drop table platform.workflow_start_acl_probe");
            expect((await tx.query<{version:number}>("select max(version) as version from platform.schema_migrations"))[0].version).toBe(6);
            // Construct the historical pre12 fixture from canonical emitted
            // bytes, retaining same-owner schema6 defaults through its history.
            // This is fixture setup, not current migrator approval of old DDL.
            const twelfth=emitted.indexOf("-- ============================ migration 12: workflow_start_intents");
            if(twelfth<seventh)throw new Error("Canonical historical schema11 boundary is unavailable.");
            await db.exec(emitted.slice(seventh,twelfth));
            expect((await tx.query<{version:number}>("select max(version) as version from platform.schema_migrations"))[0].version).toBe(11);
          }
          // The production migrator applies canonical12 to the historical fixture.
          const migrations=[...PLATFORM_MIGRATIONS.filter(m=>m.version<12),migration0012WorkflowStartIntents];
          await migratePlatformDb(db,migrations);await assertPlatformSchemaCurrent(db,migrations);
          expect((await tx.query<{owner:string}>("select pg_get_userbyid(relowner) as owner from pg_class where oid='platform.workflow_start_intents'::regclass"))[0].owner).toBe(owner);
          for(const privilege of ["SELECT","INSERT","UPDATE","DELETE","TRUNCATE","REFERENCES","TRIGGER"])
            expect((await tx.query<{allowed:boolean}>("select has_table_privilege('service_role','platform.workflow_start_intents',$1) as allowed",[privilege]))[0].allowed,
              `${mode}: ${privilege}`).toBe(["SELECT","INSERT","UPDATE"].includes(privilege));
          // This fixture declares historical schema12, before standing grants.
          // Only that optional port is absent; approvals, claims and tombstones
          // continue through the actual historical SQL authority.
          expect((await tx.query<{table_name:string|null}>("select to_regclass('platform.standing_grant_uses')::text as table_name"))[0].table_name).toBeNull();
          const h=await makeHarness({kind:"memory",engine:scriptedEngine("tombstone-privilege-one",()=>requireApproval(1,"admin"))});
          const legacyStore = new PlatformBrokerStore(tx);
          Object.defineProperty(legacyStore, "standingGrants", { value: undefined });
          const deps={...h.deps,store:legacyStore,clock:{now:()=>new Date()}};
          const broker=createBroker(deps),bound={...h,broker,deps,store:deps.store};
          const proposed=await proposeOk(bound,requestFor(bound,"service.restart","prod"),user("bob"));
          // Schema12 has no recovery authority. Current approvals/claims must refuse,
          // not manufacture a current epoch for this historical ACL fixture.
          expect((await tx.query<{column_name:string}>("select column_name from information_schema.columns where table_schema='platform' and table_name='operations' and column_name='recovery_epoch'"))).toEqual([]);
          expect((await tx.query<{fn:string|null}>("select to_regprocedure('platform.current_recovery_epoch()')::text as fn"))[0].fn).toBeNull();
          const historicalRows=async()=>({ operation:await tx.query("select * from platform.operations where workspace_id=$1 and id=$2",[h.ids.wsA,proposed.id]),
            approvals:await tx.query("select * from platform.approvals where workspace_id=$1 and operation_id=$2 order by id",[h.ids.wsA,proposed.id]) });
          const proposedRows=await historicalRows();
          await expect(db.tx(async()=>{await approveAs(bound,proposed.operation,"erin");})).rejects.toMatchObject({sqlstate:"42703"});
          expect(await historicalRows()).toEqual(proposedRows);
          // Historical SQL construction only: these fixture rows are NOT current
          // broker approval or execution authorization. Actual schema12 SQL binds
          // the human reviewer and live approval to the original operation/round.
          expect((await deps.roles.resolve(user("erin"),h.ids.wsA)).role).toBe("admin");
          // The public operation view omits inputDigest; bind the actual SQL row.
          const [historicalDigests]=await tx.query<{proposal_digest:string;input_digest:string}>(
            "select proposal_digest,input_digest from platform.operations where workspace_id=$1 and id=$2",[h.ids.wsA,proposed.id]);
          expect(historicalDigests.proposal_digest).toBe(proposed.operation.proposalDigest);
          expect(historicalDigests.input_digest).toMatch(/^[0-9a-f]{64}$/);
          const historicalApprovalFixture=()=>tx.query(`insert into platform.approvals
            (id,workspace_id,operation_id,proposal_digest,decision,approver,approver_id,approver_role,policy_version,approval_round,expires_at)
            select $3,o.workspace_id,o.id,o.proposal_digest,'approve',$4::text::jsonb,'erin','admin',d.policy_version,o.approval_round,
              least(o.expires_at,clock_timestamp()+interval '1 hour')
            from platform.operations o join platform.policy_decisions d on d.workspace_id=o.workspace_id and d.id=o.policy_decision_id
            where o.workspace_id=$1 and o.id=$2 and o.status='awaiting_approval' and o.expires_at>clock_timestamp()
              and o.approval_required and o.approval_round=0 and o.plan_digest is null and o.principal->>'id'='bob'
              and o.proposal_digest=$5 and o.input_digest=$6
              and d.outcome='require_approval' and d.approval->>'count'='1' and d.approval->>'minRole'='admin'
              and not exists(select 1 from platform.approvals a where a.workspace_id=o.workspace_id and a.operation_id=o.id)
            returning id`,[h.ids.wsA,proposed.id,randomUUID(),JSON.stringify(user("erin")),historicalDigests.proposal_digest,historicalDigests.input_digest]);
          expect(await historicalApprovalFixture()).toHaveLength(1);
          expect(await historicalApprovalFixture()).toHaveLength(0);
          expect(await tx.query(`update platform.operations o set status='approved'
            where o.workspace_id=$1 and o.id=$2 and o.status='awaiting_approval'
              and exists(select 1 from platform.approvals a where a.workspace_id=o.workspace_id and a.operation_id=o.id
                and a.approval_round=o.approval_round and a.proposal_digest=o.proposal_digest
                and a.approver_id='erin' and a.decision='approve' and a.consumed_at is null and a.expires_at>clock_timestamp())
            returning id`,[h.ids.wsA,proposed.id])).toHaveLength(1);
          const approvedRows=await historicalRows();
          await expect(db.tx(async()=>{await broker.beginExecution({workspaceId:h.ids.wsA,operationId:proposed.id,holder:`workflow:${proposed.id}`,audience:"worker",leaseMs:60_000});})).rejects.toMatchObject({sqlstate:"42703"});
          expect(await historicalRows()).toEqual(approvedRows);
          const historicalRunningFixture=()=>tx.query(`with consumed as (
            update platform.approvals a set consumed_at=clock_timestamp() from platform.operations o
            where o.workspace_id=$1 and o.id=$2 and o.status='approved' and o.expires_at>clock_timestamp()
              and a.workspace_id=o.workspace_id and a.operation_id=o.id and a.approval_round=o.approval_round
              and a.proposal_digest=o.proposal_digest and a.approver_id='erin' and a.decision='approve'
              and a.consumed_at is null and a.expires_at>clock_timestamp() returning a.operation_id)
            update platform.operations o set status='running',lease_holder=$3,lease_until=clock_timestamp()+interval '1 minute'
            where o.workspace_id=$1 and o.id=$2 and o.status='approved' and exists(select 1 from consumed c where c.operation_id=o.id)
            returning id`,[h.ids.wsA,proposed.id,`workflow:${proposed.id}`]);
          expect(await historicalRunningFixture()).toHaveLength(1);
          expect(await historicalRunningFixture()).toHaveLength(0);
          const request:intents.StartRequest={kind:"dayTwo",arguments:{workspaceId:h.ids.wsA,operationId:proposed.id,environmentId:h.ids.envAProd,capability:"service.restart"},
            namespace:"default",endpointDigest:digest("owned tombstone privilege frontend"),taskQueue:"owned-tombstone-privileges"};
          const store=intents.createIsolatedStartIntentStoreForTests(broker);
          // Current start authority deliberately rebinds to the locked SQL
          // store: it cannot authorize a new start against historical schema12.
          await expect(store.prepare(tx,request)).rejects.toBeInstanceOf(intents.WorkflowStartIntentError);
          expect(await intents.get(tx,h.ids.wsA,proposed.id)).toBeNull();
          const operation=(await tx.query<{proposal_digest:string;input_digest:string}>(
            "select proposal_digest,input_digest from platform.operations where workspace_id=$1 and id=$2",[h.ids.wsA,proposed.id]))[0];
          const argumentsDigest=digest(request.arguments);
          const binding:intents.StartBinding={...request,format:"zenith.workflow-start.v1",
            workflowType:intents.WORKFLOW_START_TYPES.dayTwo,workflowId:`op-${proposed.id}`,argumentsDigest,
            proposalDigest:operation.proposal_digest,inputDigest:operation.input_digest,
            sourceDigest:digest({proposalDigest:operation.proposal_digest,inputDigest:operation.input_digest,argumentsDigest}),
            configDigest:digest(intents.START_CONFIG)};
          // Historical fixture construction only, not current start authorization.
          // The real SQL operation, lease and consumed human approval guard this
          // schema12 phase CAS; no transport or modern authority is simulated.
          await tx.query("insert into platform.workflow_start_intents(workspace_id,operation_id,binding,binding_digest) values($1,$2,$3::text::jsonb,$4)",
            [h.ids.wsA,proposed.id,JSON.stringify(binding),digest(binding)]);
          await expect(store.claim(tx,request)).rejects.toBeInstanceOf(intents.WorkflowStartIntentError);
          expect((await intents.get(tx,h.ids.wsA,proposed.id))?.phase).toBe("prepared");
          const historicalFixtureAttempt=()=>tx.query<intents.WorkflowStartIntent>(`update platform.workflow_start_intents i
            set phase='attempted',attempt_id=$3,attempted_at=clock_timestamp()
            from platform.operations o where i.workspace_id=$1 and i.operation_id=$2 and i.phase='prepared'
              and o.workspace_id=i.workspace_id and o.id=i.operation_id and o.status='running'
              and o.expires_at>clock_timestamp() and o.lease_holder=$4 and o.lease_until>clock_timestamp()
              and o.proposal_digest=$5 and o.input_digest=$6 and o.approval_required
              and exists(select 1 from platform.approvals a where a.workspace_id=o.workspace_id and a.operation_id=o.id
                and a.approval_round=o.approval_round and a.proposal_digest=o.proposal_digest
                and a.approver_id='erin' and a.approver->>'kind'='user' and a.decision='approve'
                and a.consumed_at is not null and a.expires_at>clock_timestamp()) returning i.*`,
            [h.ids.wsA,proposed.id,randomUUID(),`workflow:${proposed.id}`,operation.proposal_digest,operation.input_digest]);
          expect(await historicalFixtureAttempt()).toHaveLength(1);
          const attempted=(await intents.get(tx,h.ids.wsA,proposed.id))!;
          expect(attempted.phase).toBe("attempted");
          // Real PostgreSQL permission denial, not a mocked row-delete trigger.
          await expect(db.tx(async denied=>{await denied.query("set local role service_role");
            await denied.query("truncate table platform.workflow_start_intents");})).rejects.toMatchObject({sqlstate:"42501"});
          expect((await tx.query<{name:string}>("select current_user as name"))[0].name).toBe(owner);
          expect(await intents.get(tx,h.ids.wsA,proposed.id)).toEqual(attempted);
          expect(await tx.query("select id from platform.operations where workspace_id=$1 and id=$2 and status='running' and expires_at>clock_timestamp() and lease_until>clock_timestamp()",[h.ids.wsA,proposed.id])).toHaveLength(1);
          expect(await historicalFixtureAttempt()).toHaveLength(0);
          const second=await store.claim(tx,request);
          expect(second.dispatch).toBe(false);expect(second.intent.attempt_id).toBe(attempted.attempt_id);
          throw rollback;
        }).catch((error:unknown)=>error);
        if(result !== rollback) throw result;
        expect(result).toBe(rollback);
      } finally {await db.close();}
    });
  },60_000);
});
