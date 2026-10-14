/** Actual PG claims, human approval rows, real activity acquisition and native source custody. HTTP is modeled; no Temporal/provider write proof. */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { gzipSync } from "node:zlib";
import { openPlatformDb, repos, PLATFORM_SCHEMA_VERSION, type PlatformDbHandle } from "@/lib/controlplane/db";
import type { Sql } from "@/lib/controlplane/types";
import { createLeasesPort, createPlatformPorts } from "@/lib/execution/platform";
import { createStepActivities } from "@/lib/execution/steps";
import { createRuntime } from "@/lib/execution/runtime";
import type { ExecutionDeps } from "@/lib/execution/ports";
import { StepFailedError, LeaseBusyError } from "@/lib/execution/errors";
import { createApprovedSourceRuntime } from "@/lib/platform/approved-source-runtime";
import { sourceRecipe, sourceSnapshotDigest, sourceSnapshotSetDigest } from "@/lib/execution/source-snapshot";
import { cancelRunningOperation } from "@/lib/controlplane/operations";
import { digest } from "@/lib/controlplane/digest";
import { planEvidence } from "@/lib/execution/plan-evidence";
import { normalizePlan } from "@/lib/tofu/plan";
import { TOFU_VERSION } from "@/lib/tofu/types";
import { extractPlanFacts } from "@/lib/policy/plan-facts";
import { mkNode } from "../providers/aws/drivers/compute/fixtures";
import { writeTar } from "../_support/tar";
import { approve, newWorkspace, PG_URL, seedAwaitingApproval, user } from "./_support/harness";

if(process.env.ZENITH_TEST_FIRST_SOURCE_LEASE_REQUIRED==="1") {
  if(!PG_URL)throw new Error("First source lease binding acceptance requires owned PostgreSQL.");
  if(PLATFORM_SCHEMA_VERSION<13)throw new Error("First source lease binding requires the canonical registered schema13.");
}

describe.skipIf(!PG_URL)("first source worker lease binding [postgres]",()=>{
  let db:PlatformDbHandle,peer:PlatformDbHandle,observer:PlatformDbHandle;
  beforeAll(async()=>{
    db=await openPlatformDb({kind:"postgres",url:PG_URL!,migrate:true,max:1});
    peer=await openPlatformDb({kind:"postgres",url:PG_URL!,max:1});
    observer=await openPlatformDb({kind:"postgres",url:PG_URL!,max:1});
  },60_000);
  afterEach(()=>{vi.unstubAllGlobals();vi.unstubAllEnvs();vi.restoreAllMocks();});
  afterAll(async()=>{await observer?.close();await peer?.close();await db?.close();});
  const workerId="first-source-native";
  function unused<T>(name:string):T {
    return new Proxy(Object.create(null) as object,{get(){throw new Error(`Unused ${name} port was accessed.`);}}) as T;
  }
  function activities(sql:Sql=db) {
    // Every store port is native. Non-store ports are inaccessible because
    // acquiring an existing operation's lease performs no product/credential IO.
    return createStepActivities(createRuntime({...createPlatformPorts(sql),product:unused<ExecutionDeps["product"]>("product"),
      broker:unused<ExecutionDeps["broker"]>("broker"),credentials:unused<ExecutionDeps["credentials"]>("credentials"),prober:unused<ExecutionDeps["prober"]>("prober"),
      workerId,fingerprintKey:"first-source-fixture-key-0123456789",planDir:"unused-first-source-fixture"}));
  }
  async function fixture(claimHolder?:(id:string)=>string) {
    const workspaceId=newWorkspace(),projectId=`proj_${workspaceId}`,environmentId=`env_${workspaceId}`;
    const seeded=await seedAwaitingApproval(db,{workspaceId,minRole:"admin",separationOfDuties:true,
      proposal:{capability:"deployment.deploy",scope:{workspaceId,projectId,environmentId}}});
    await approve(db,seeded,user(),{role:"admin"});
    const op=await repos.operations.claimForExecution(db,{workspaceId,id:seeded.operation.id,expectedDigest:seeded.operation.proposalDigest,
      holder:claimHolder?.(seeded.operation.id)??`workflow:${seeded.operation.id}`,leaseMs:120_000,expectedPolicyVersion:seeded.decision.policyVersion});
    const scope=`env:${environmentId}`,holder=`worker:${workerId}:${op.id}`;
    const request={workspaceId,scope,holder,ttlMs:120_000,operation:{id:op.id,proposalDigest:op.proposalDigest}};
    const steps=activities();
    const acquisition=()=>steps.acquireLease({operationId:op.id,scope,ttlMs:120_000});
    const approvalRows=await repos.approvals.listForOperation(peer,workspaceId,op.id);
    expect(op.status).toBe("running");expect(op.leaseScope).toBeUndefined();expect(op.fenceToken).toBeUndefined();
    expect(approvalRows).toHaveLength(1);expect(approvalRows[0].consumedAt).toBeDefined();
    return {workspaceId,projectId,environmentId,op,scope,holder,request,steps,acquisition,approvalRows,seeded};
  }
  type Fixture=Awaited<ReturnType<typeof fixture>>;
  const pair=(f:Fixture)=>peer.query<{lease_scope:string|null;fence_token:number|null}>("select lease_scope,fence_token from platform.operations where workspace_id=$1 and id=$2",[f.workspaceId,f.op.id]);
  const leaseRows=(f:Fixture)=>peer.query("select workspace_id,holder,fence_token,expires_at,released_at from platform.leases where scope=$1",[f.scope]);
  async function unchangedApprovals(f:Fixture) {expect(await repos.approvals.listForOperation(peer,f.workspaceId,f.op.id)).toEqual(f.approvalRows);}
  async function refused(f:Fixture,request=f.request) {
    const before=await pair(f);
    const error=await createLeasesPort(db).acquire(request).catch((e:unknown)=>e);
    expect(error).toBeInstanceOf(StepFailedError);expect((error as StepFailedError).nonRetryable).toBe(true);
    expect(await pair(f)).toEqual(before);await unchangedApprovals(f);
  }
  async function sourceFixture(f:Fixture) {
    vi.stubEnv("ZENITH_GITHUB_APP_ID",undefined);vi.stubEnv("ZENITH_GITHUB_APP_PRIVATE_KEY_FILE",undefined);
    const fetchImpl=vi.fn<typeof fetch>(async raw=>{
      const url=String(raw);
      if(url==="https://api.github.com/repos/acme/app")return Response.json({id:99,name:"app",owner:{login:"acme"},private:false});
      if(url.startsWith("https://api.github.com/repos/acme/app/commits/"))return new Response("d".repeat(40));
      if(url===`https://codeload.github.com/acme/app/tar.gz/${"d".repeat(40)}`)
        return new Response(new Uint8Array(gzipSync(writeTar([{path:"root/Dockerfile",bytes:Buffer.from("FROM scratch\n")}]))));
      throw new Error("Unexpected modeled source request.");
    });vi.stubGlobal("fetch",fetchImpl);
    const region="eu-west-1";
    const pipeline=mkNode("build_pipeline/web","build_pipeline","aws:codebuild_project",{location:"customer_account",source:{repo:"acme/app",ref:"main",dockerfile:"Dockerfile"}},{region,specDigest:"b".repeat(64)});
    const service=mkNode("container_service/web","container_service","aws:ecs_service",{artifact:{type:"built",pipeline:pipeline.address}},{region,specDigest:"a".repeat(64)});
    for(const node of [service,pipeline])await repos.resources.upsertDesired(db,{workspaceId:f.workspaceId,projectId:f.projectId,environmentId:f.environmentId,node,status:"planned"});
    const native=createApprovedSourceRuntime(db,{resources:createPlatformPorts(db).resources});
    const input={workspaceId:f.workspaceId,operationId:f.op.id,projectId:f.projectId,environmentId:f.environmentId,
      serviceAddress:service.address,serviceSpecDigest:service.specDigest,pipelineAddress:pipeline.address,pipelineSpecDigest:pipeline.specDigest,
      provider:"aws" as const,region,repository:"acme/app",requestedRef:"main",dockerfile:"Dockerfile",recipeDigest:sourceRecipe(service,pipeline),archiveFormat:"zip" as const};
    return {native,input,fetchImpl};
  }
  it("binds the first real worker lease before default source capture and native retain after a claim without a lease",async()=>{
    const f=await fixture(),s=await sourceFixture(f);
    expect(await pair(f)).toEqual([{lease_scope:null,fence_token:null}]);expect(s.fetchImpl).not.toHaveBeenCalled();
    const lease=await f.acquisition();
    expect(await pair(f)).toEqual([{lease_scope:f.scope,fence_token:lease.fenceToken}]);expect(s.fetchImpl).not.toHaveBeenCalled();
    const captured=await s.native.sourceBundle.capture!(s.input),retained=await s.native.sourceSnapshots!.retain(captured,lease);
    const independent=createApprovedSourceRuntime(peer);
    expect(db.kind).toBe("postgres");expect(peer.kind).toBe("postgres");expect(db).not.toBe(peer);
    expect((await independent.sourceSnapshots!.list({workspaceId:f.workspaceId,operationId:f.op.id,projectId:f.projectId,environmentId:f.environmentId})).map(sourceSnapshotDigest)).toEqual([sourceSnapshotDigest(retained)]);
    await independent.sourceSnapshots!.assertCurrent(retained);await unchangedApprovals(f);
  },30_000);
  it("reuses the same live native fence after an acquisition acknowledgement is lost without consuming approval twice",async()=>{
    const f=await fixture();
    // Model only the lost caller result: the real first activity commits, and
    // its returned lease is discarded before invoking the same body again.
    await f.acquisition();const recorded=await pair(f),before=await leaseRows(f);
    const replay=await f.acquisition();
    expect(replay.fenceToken).toBe(recorded[0].fence_token);expect(await pair(f)).toEqual(recorded);
    expect((await leaseRows(f))[0]).toMatchObject({holder:f.holder,fence_token:before[0].fence_token});await unchangedApprovals(f);
    expect(await peer.query("select count(*)::integer as n from platform.events where workspace_id=$1 and operation_id=$2 and type='lease.acquired'",[f.workspaceId,f.op.id])).toEqual([{n:1}]);
  });
  it("keeps plain and reconcile lease reacquisition incrementing fences",async()=>{
    const port=createLeasesPort(db);
    for(const prefix of ["env","reconcile"]) {
      const scope=`${prefix}:${newWorkspace()}`,input={workspaceId:newWorkspace(),scope,holder:"worker:plain:fixture",ttlMs:120_000};
      const a=await port.acquire(input),b=await port.acquire(input);expect(a).not.toBeNull();expect(b!.fenceToken).toBe(a!.fenceToken+1);
    }
  });
  it("binds a new fence only after genuine plan review approval and a separate claim resets the recorded pair",async()=>{
    const f=await fixture(),s=await sourceFixture(f),first=await f.acquisition();
    const retained=await s.native.sourceSnapshots!.retain(await s.native.sourceBundle.capture!(s.input),first);
    const plan=normalizePlan({format_version:"1.2",terraform_version:TOFU_VERSION,resource_changes:[],output_changes:{}},
      {configDigest:digest("config"),lockDigest:digest("lock"),addressMap:{},executableSourceDigest:sourceSnapshotSetDigest([retained])});
    await repos.evidence.insert(db,{workspaceId:f.workspaceId,operationId:f.op.id,kind:"tofu_plan",digest:plan.planDigest,
      summary:planEvidence({plan,facts:extractPlanFacts(plan),cost:{},graphDigest:digest("graph"),stage:"plan",approvedSources:[retained]}).summary,simulated:false});
    const ports=createPlatformPorts(db);
    await ports.ops.setPlanDigest({workspaceId:f.workspaceId,operationId:f.op.id,planDigest:plan.planDigest});
    await f.steps.releaseLease({lease:first});
    expect((await ports.ops.transition({workspaceId:f.workspaceId,operationId:f.op.id,to:"awaiting_approval"}))?.status).toBe("awaiting_approval");
    await repos.approvals.record(db,{workspaceId:f.workspaceId,operationId:f.op.id,approver:user(),approverRole:"admin",decision:"approve",
      proposalDigest:f.op.proposalDigest,planDigest:plan.planDigest,policyVersion:f.seeded.decision.policyVersion,expectedApprovalRound:1});
    expect((await ports.ops.transition({workspaceId:f.workspaceId,operationId:f.op.id,to:"running"}))?.status).toBe("running");
    expect(await pair(f)).toEqual([{lease_scope:null,fence_token:null}]);
    const second=await f.acquisition();expect(second.fenceToken).toBe(first.fenceToken+1);
    await s.native.sourceSnapshots!.assertReviewed(retained);
    const approvals=await repos.approvals.listForOperation(peer,f.workspaceId,f.op.id);
    expect(approvals).toHaveLength(2);expect(approvals.find(a=>a.id===f.approvalRows[0].id)).toEqual(f.approvalRows[0]);expect(approvals.every(a=>a.consumedAt!==undefined)).toBe(true);
  },30_000);
  it("refuses a changed proposal digest and rolls back the newly acquired lease",async()=>{
    const f=await fixture();await refused(f,{...f.request,operation:{...f.request.operation,proposalDigest:digest("foreign proposal")}});expect(await leaseRows(f)).toEqual([]);
  });
  it("refuses a foreign workspace at native binding and rolls back the newly acquired lease",async()=>{
    const f=await fixture();await refused(f,{...f.request,workspaceId:newWorkspace()});expect(await leaseRows(f)).toEqual([]);
  });
  it("refuses a foreign environment scope at native binding and rolls back the newly acquired lease",async()=>{
    const f=await fixture(),scope=`env:${newWorkspace()}`;await refused(f,{...f.request,scope});expect(await peer.query("select scope from platform.leases where scope=$1",[scope])).toEqual([]);
  });
  it("refuses a live MCP execution holder at native binding and rolls back the newly acquired lease",async()=>{
    const f=await fixture(id=>`mcp:${id}`);await refused(f);expect(await leaseRows(f)).toEqual([]);
  });
  it("refuses a replaced workflow execution holder at native binding and rolls back the newly acquired lease",async()=>{
    const f=await fixture();await peer.query("update platform.operations set lease_holder='workflow:another-operation' where workspace_id=$1 and id=$2",[f.workspaceId,f.op.id]);await refused(f);expect(await leaseRows(f)).toEqual([]);
  });
  it.each(["uncertain","cancelled"] as const)("refuses %s operations without creating a lease",async status=>{
    const f=await fixture();
    if(status==="cancelled")await cancelRunningOperation(peer,{workspaceId:f.workspaceId,id:f.op.id,reason:"Owned native cancellation fixture."});
    else await createPlatformPorts(peer).ops.markUncertain({workspaceId:f.workspaceId,operationId:f.op.id,reason:"Owned native uncertainty fixture."});
    await refused(f);expect(await leaseRows(f)).toEqual([]);
  });
  it.each(["operation","execution claim"] as const)("refuses an expired %s without creating a lease",async kind=>{
    const f=await fixture(),column=kind==="operation"?"expires_at":"lease_until";
    await peer.query(`update platform.operations set ${column}=clock_timestamp()-interval '1 second' where workspace_id=$1 and id=$2`,[f.workspaceId,f.op.id]);
    await refused(f);expect(await leaseRows(f)).toEqual([]);
  });
  it.each(["scope only","token only"] as const)("refuses a partially recorded fence pair with %s and leaves both columns unchanged",async kind=>{
    const f=await fixture();await peer.query("update platform.operations set lease_scope=$3,fence_token=$4 where workspace_id=$1 and id=$2",[f.workspaceId,f.op.id,kind==="scope only"?f.scope:null,kind==="token only"?1:null]);
    await refused(f);expect(await leaseRows(f)).toEqual([]);
  });
  it.each(["NULL","foreign"] as const)("refuses a %s lease workspace before binding",async kind=>{
    const f=await fixture();await repos.leases.acquire(peer,{scope:f.scope,holder:f.holder,ttlMs:120_000,...(kind==="foreign"?{workspaceId:newWorkspace()}:{})});
    const before=await leaseRows(f);await refused(f);expect(await leaseRows(f)).toEqual(before);
  });
  it("refuses a mismatched recorded fence without replacing it",async()=>{
    const f=await fixture(),lease=await f.acquisition();await peer.query("update platform.operations set fence_token=$3 where workspace_id=$1 and id=$2",[f.workspaceId,f.op.id,lease.fenceToken+1]);
    const before=await leaseRows(f);await refused(f);expect(await leaseRows(f)).toEqual(before);
  });
  it("refuses a released recorded fence after reacquisition without replacing it",async()=>{
    const f=await fixture(),lease=await f.acquisition();await f.steps.releaseLease({lease});const before=await leaseRows(f);
    await refused(f);expect(await leaseRows(f)).toEqual(before);
  });
  it("refuses a taken-over recorded fence after expiry without replacing it",async()=>{
    const f=await fixture();await f.acquisition();
    await peer.query("update platform.leases set expires_at=clock_timestamp()-interval '1 second' where scope=$1",[f.scope]);
    const takeover=await repos.leases.acquire(peer,{workspaceId:f.workspaceId,scope:f.scope,holder:"worker:other:other-operation",ttlMs:120_000});expect(takeover).not.toBeNull();
    await expect(f.acquisition()).rejects.toBeInstanceOf(LeaseBusyError);
    await peer.query("update platform.leases set expires_at=clock_timestamp()-interval '1 second' where scope=$1",[f.scope]);
    const before=await leaseRows(f);await refused(f);expect(await leaseRows(f)).toEqual(before);
  });
  it("refuses a stale native binding after the acquired lease is released",async()=>{
    const f=await fixture(),lease=await repos.leases.acquire(db,{workspaceId:f.workspaceId,scope:f.scope,holder:f.holder,ttlMs:120_000});expect(lease).not.toBeNull();
    await repos.leases.release(peer,lease!);
    await expect(repos.operations.bindExecutionLease(db,{workspaceId:f.workspaceId,id:f.op.id,expectedDigest:f.op.proposalDigest,lease:lease!})).rejects.toMatchObject({code:"lease_lost"});
    expect(await pair(f)).toEqual([{lease_scope:null,fence_token:null}]);await unchangedApprovals(f);
  });
  it("refuses a worker holder naming another operation even when the environment lease is live",async()=>{
    const f=await fixture();await refused(f,{...f.request,holder:`worker:${workerId}:another-operation`});expect(await leaseRows(f)).toEqual([]);
  });
  it.each(["cancellation","execution expiry"] as const)("refuses %s committed during an observed native operation lock wait",async kind=>{
    const f=await fixture();let claimantPid=0,ready!:()=>void;
    const entered=new Promise<void>(resolve=>{ready=resolve;});
    const claimant:Sql={query:db.query.bind(db),tx:body=>db.tx(async tx=>{
      claimantPid=(await tx.query<{pid:number}>("select pg_backend_pid() as pid"))[0].pid;ready();return body(tx);
    })};
    let outcome!:Promise<unknown>;
    await peer.tx(async blocker=>{
      await blocker.query("select id from platform.operations where workspace_id=$1 and id=$2 for update",[f.workspaceId,f.op.id]);
      const blockerPid=(await blocker.query<{pid:number}>("select pg_backend_pid() as pid"))[0].pid;
      outcome=createLeasesPort(claimant).acquire(f.request).then(value=>value,error=>error);
      await Promise.race([entered,outcome.then(()=>{throw new Error("Acquisition ended before its native transaction entered.");})]);
      let observed=false;const deadline=Date.now()+3_000;
      while(Date.now()<deadline) {
        const state=await observer.tx(async fresh=>{
          await fresh.query("select pg_stat_clear_snapshot()");
          return (await fresh.query<{blocked:boolean;pid:number}>(`select pg_backend_pid() as pid,exists(select 1 from pg_stat_activity where pid=$1
            and wait_event_type='Lock' and query like '%select id from platform.operations where workspace_id=$1 and id=$2 for update%'
            and $2=any(pg_blocking_pids(pid))) as blocked`,[claimantPid,blockerPid]))[0];
        });
        expect(state.pid).not.toBe(claimantPid);expect(state.pid).not.toBe(blockerPid);expect(claimantPid).not.toBe(blockerPid);
        if(state.blocked){observed=true;break;}await new Promise(resolve=>setTimeout(resolve,10));
      }
      expect(observed).toBe(true);
      if(kind==="cancellation")await cancelRunningOperation(blocker,{workspaceId:f.workspaceId,id:f.op.id,reason:"Owned lock-wait cancellation fixture."});
      else await blocker.query("update platform.operations set lease_until=clock_timestamp()-interval '1 second' where workspace_id=$1 and id=$2",[f.workspaceId,f.op.id]);
    });
    const result=await outcome;expect(result).toBeInstanceOf(StepFailedError);expect((result as StepFailedError).nonRetryable).toBe(true);
    expect(await leaseRows(f)).toEqual([]);expect(await pair(f)).toEqual([{lease_scope:null,fence_token:null}]);await unchangedApprovals(f);
  },10_000);
  it("refuses a missing execution lease workspace before native acquisition and retains the current binding",async()=>{
    const f=await fixture(),before=await pair(f);
    await expect(repos.operations.acquireExecutionLease(db,{...f.request,workspaceId:undefined})).rejects.toMatchObject({code:"invalid_input"});
    const error=await createLeasesPort(db).acquire({...f.request,workspaceId:undefined}).catch((value:unknown)=>value);
    expect(error).toBeInstanceOf(StepFailedError);expect((error as StepFailedError).nonRetryable).toBe(true);
    expect(await pair(f)).toEqual(before);expect(await leaseRows(f)).toEqual([]);await unchangedApprovals(f);
  });
  it.each(["live foreign","expired foreign","released foreign","expired NULL"] as const)("refuses %s scope collisions before acquisition without changing any retained lease or binding",async kind=>{
    const f=await fixture(),foreign=newWorkspace();
    const lease=await repos.leases.acquire(peer,{workspaceId:kind==="expired NULL"?undefined:foreign,scope:f.scope,holder:f.holder,ttlMs:120_000});
    if(!lease)throw new Error("Native collision fixture did not create its lease.");
    if(kind.startsWith("expired"))await peer.query("update platform.leases set expires_at=clock_timestamp()-interval '1 second' where scope=$1",[f.scope]);
    if(kind==="released foreign")await repos.leases.release(peer,lease);
    const retained=await observer.query("select * from platform.leases where scope=$1",[f.scope]),binding=await pair(f);
    await expect(repos.operations.acquireExecutionLease(db,f.request)).rejects.toMatchObject({code:"tenant_mismatch"});
    await refused(f);
    expect(await observer.query("select * from platform.leases where scope=$1",[f.scope])).toEqual(retained);
    expect(await pair(f)).toEqual(binding);await unchangedApprovals(f);
  });
  function heldMissingLeaseLock(sql:Sql,entered:()=>void,released:Promise<void>):Sql {
    return {query:sql.query.bind(sql),tx:body=>sql.tx(async tx=>{
      let held=false;
      const wrapped:Sql={tx:tx.tx.bind(tx),query:async<T>(text:string,params?:readonly unknown[])=>{
        const rows=await tx.query<T>(text,params);
        // Hold only after the actual owning first SELECT confirmed absence.
        // The query still uses the native independent PostgreSQL connection.
        if(!held && text.startsWith("select scope from platform.leases where workspace_id=")) {
          held=true;expect(rows).toEqual([]);entered();await released;
        }
        return rows;
      }};
      return body(wrapped);
    })};
  }
  it("refuses a foreign scope inserted after the owning lock found no row without adopting or renewing it",async()=>{
    const f=await fixture();let entered!:()=>void,released!:()=>void;
    const reached=new Promise<void>(resolve=>{entered=resolve;}),release=new Promise<void>(resolve=>{released=resolve;});
    const controlled=heldMissingLeaseLock(db,entered,release);
    const pending=createLeasesPort(controlled).acquire(f.request).then(value=>value,error=>error);
    let retained:unknown;
    try {
      await Promise.race([reached,pending.then(()=>{throw new Error("Acquisition ended before its observed absent lease barrier.");})]);
      const lease=await repos.leases.acquire(peer,{workspaceId:newWorkspace(),scope:f.scope,holder:f.holder,ttlMs:120_000});
      expect(lease).not.toBeNull();retained=await observer.query("select * from platform.leases where scope=$1",[f.scope]);
    } finally {released();}
    const result=await pending;expect(result).toBeInstanceOf(StepFailedError);expect((result as StepFailedError).nonRetryable).toBe(true);
    expect(await observer.query("select * from platform.leases where scope=$1",[f.scope])).toEqual(retained);
    expect(await pair(f)).toEqual([{lease_scope:null,fence_token:null}]);await unchangedApprovals(f);
  },10_000);
  it("two genuine owning acquisitions crossing an absent-row collision retain one same-holder fence and one consumed approval",async()=>{
    const f=await fixture();let count=0,entered!:()=>void,released!:()=>void;
    const [floor]=await observer.query<{fence_token:number}>("select platform.recovery_fence_floor() as fence_token");
    expect(Number.isSafeInteger(floor.fence_token)).toBe(true);
    const reached=new Promise<void>(resolve=>{entered=resolve;}),release=new Promise<void>(resolve=>{released=resolve;});
    const arrive=()=>{if(++count===2)entered();};
    const first=createLeasesPort(heldMissingLeaseLock(db,arrive,release)).acquire(f.request);
    const second=createLeasesPort(heldMissingLeaseLock(peer,arrive,release)).acquire(f.request);
    try {
      await Promise.race([reached,Promise.all([first,second]).then(()=>{throw new Error("Owning acquisitions ended before both native absence barriers.");})]);
      expect(count).toBe(2);expect(await observer.query("select scope from platform.leases where workspace_id=$1 and scope=$2",[f.workspaceId,f.scope])).toEqual([]);
    } finally {released();}
    const leases=await Promise.all([first,second]);expect(leases[0]).not.toBeNull();expect(leases[1]).not.toBeNull();
    expect(leases[0]!.fenceToken).toBe(floor.fence_token);expect(leases[1]!.fenceToken).toBe(leases[0]!.fenceToken);
    expect(await pair(f)).toEqual([{lease_scope:f.scope,fence_token:floor.fence_token}]);
    expect(await observer.query("select workspace_id,holder,fence_token from platform.leases where scope=$1",[f.scope]))
      .toEqual([{workspace_id:f.workspaceId,holder:f.holder,fence_token:floor.fence_token}]);await unchangedApprovals(f);
  },10_000);
});
