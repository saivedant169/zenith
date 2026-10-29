/** Actual native SQL/default broker/paired codec. Product REST/topology and policy are explicit models; no provider, raw apply or settlement proof. */
import { randomBytes, randomUUID, createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { readFile,writeFile,mkdir,chmod,lstat,readdir } from "node:fs/promises";
import path from "node:path";
import { openNativePlanFixtureDatabase,type NativePlanFixtureDatabase,standaloneProductScope,reviewedStandalonePlan,associatedStandaloneDestroy,consumeSavedNativePlan,type StandaloneProductScope } from "./_support/saved-native-plan";
import { createPlanEngineAuthority } from "@/lib/tofu/engine";
import { TofuRun,TofuRunner,isCleanedTofuRun,isCanonicalStandaloneRun } from "@/lib/tofu/runner";
import { configDigestOf } from "@/lib/tofu/workspace";
import { tofuOnPath } from "../tofu/_helpers";
import { z } from "zod/v4";
import { afterAll,afterEach,beforeAll,beforeEach,describe,expect,it,onTestFailed,vi } from "vitest";
import { openPlatformDb,platformDb,resetPlatformDbForTests,repos,json,bindRepos,type PlatformDbHandle } from "@/lib/controlplane/db";
import { PLATFORM_SCHEMA_VERSION } from "@/lib/controlplane/db/migrations";
import type { Sql } from "@/lib/controlplane/types";
import { digest } from "@/lib/controlplane/digest";
import { Manifest,ManifestPolicies } from "@/lib/domain/types";
import { buildDesiredState } from "@/lib/execution/graph";
import { planCustody,scopeOf } from "@/lib/execution/runtime";
import { executionHolder,createOperationsPort } from "@/lib/execution/platform";
import { createExecutionBroker,isDefaultCurrentDispatchRequirement } from "@/lib/platform/broker";
import { platformBroker,resetPlatformBrokerForTests,isDefaultPlatformBrokerFor } from "@/lib/capabilities/platform";
import { generateSigningJwk,serializePrivateJwk } from "@/lib/credentials";
import { CredentialGrantSigner } from "@/lib/capabilities/credential-signer";
import { planArtifactCipherFromEnv,createPlanArtifactRuntime,createIsolatedPlanArtifactRuntimeForTests,readNativeCleanupOwnerGrantOrigin } from "@/lib/platform/plan-artifacts";
import { vaultCipherFromEnv, type Sealed } from "@/lib/secrets";
import * as artifacts from "@/lib/controlplane/db/repos/plan-artifacts";
import * as cleanup from "@/lib/controlplane/db/repos/cleanup-writer-barriers";
import * as intents from "@/lib/controlplane/db/repos/workflow-start-intents";
import * as connections from "@/lib/controlplane/db/repos/connections";
import { planEvidence } from "@/lib/execution/plan-evidence";
import { normalizePlan } from "@/lib/tofu/plan";
import { extractPlanFacts } from "@/lib/policy/plan-facts";
import { stableJson } from "@/lib/tofu/stable";
import { TOFU_VERSION } from "@/lib/tofu/types";
import type { PlanArtifactManifest } from "@/lib/tofu/engine";
import { seedApprovedOperation } from "./_support/harness";
import { scriptedEngine,requireApproval,user,sessionFor } from "../capabilities/support";
const state=vi.hoisted(()=>({snapshot:{workspaces:[] as {id:string}[],projects:[] as {id:string;workspaceId:string}[],environments:[] as {id:string;projectId:string;connectionId:string;class:string;region:string}[],connections:[] as {id:string;provider:string}[]},
  member:async(_ws:string,_id:string):Promise<{id:string;workspace_id:string;role:string}|null>=>null}));
vi.mock("@/lib/db/store",async original=>({...await original<typeof import("@/lib/db/store")>(),isPostgres:()=>true,db:()=>state.snapshot,q:{connection:(id:string)=>state.snapshot.connections.find(c=>c.id===id)}}));
vi.mock("@/lib/db/postgres-store",async original=>({...await original<typeof import("@/lib/db/postgres-store")>(),pgClient:()=>({from:(table:string)=>{
  if(table!=="members")throw new Error("Unexpected modeled REST collection.");const filters=new Map<string,string>();
  const query={select:()=>query,eq:(k:string,v:string)=>{filters.set(k,v);return query;},abortSignal:()=>query,
    maybeSingle:async()=>({data:await state.member(filters.get("workspace_id")!,filters.get("id")!),error:null})};return query;}})}));
vi.mock("@/lib/policy",async original=>({...await original<typeof import("@/lib/policy")>(),loadPolicyEngine:async()=>scriptedEngine("cleanup-writer-policy",input=>input.request.mutates?requireApproval(1,"admin",true):{outcome:"allow",reasons:[]})}));
vi.mock("@/lib/execution/product-port",async original=>({...await original<typeof import("@/lib/execution/product-port")>(),workerStoreScope:async<T>(body:()=>Promise<T>)=>body()}));
vi.mock("@/lib/controlplane/db/repos/workflow-start-deploy-authority",async original=>({...await original<typeof import("@/lib/controlplane/db/repos/workflow-start-deploy-authority")>(),
  // Only hosted association is modeled: genuine opened owner, transaction and physical SQL stay real.
  assertDefaultMcpProductTopology:async(owner:Sql)=>{const rows=await owner.query("select current_user as role");if(rows.length!==1)throw new Error("Modeled hosted association unavailable.");},
  assertFinalMcpProductTopology:async(owner:Sql,tx:Sql)=>{if(owner===tx)throw new Error("Owning transaction required.");const rows=await tx.query("select current_user as role");if(rows.length!==1)throw new Error("Modeled hosted association unavailable.");}}));
if(process.env.ZENITH_TEST_SAVED_PLAN_SETTLEMENT_REQUIRED==="1"&&(!process.env.ZENITH_TEST_PLATFORM_PG_URL?.trim()||PLATFORM_SCHEMA_VERSION<16||process.env.ZENITH_TEST_TOFU_NETWORK!=="1"||!tofuOnPath()))throw new Error("Saved builtin settlement requires actual PostgreSQL schema16 and pinned OpenTofu admission.");
const PG_URL=process.env.ZENITH_TEST_PLATFORM_PG_URL?.trim();
function configuredNativeUrl():boolean {try{if(!PG_URL)return false;const url=new URL(PG_URL);return ["postgres:","postgresql:"].includes(url.protocol)&&!!url.port;}catch{return false;}}
if(process.env.ZENITH_TEST_CLEANUP_WRITER_BARRIER_REQUIRED==="1"&&(!configuredNativeUrl()||PLATFORM_SCHEMA_VERSION<15))throw new Error("Cleanup writer admission requires owned PostgreSQL with explicit port and schema15.");
const sha=(value:string)=>createHash("sha256").update(value).digest("hex");
function barrier(){let release!:()=>void;const promise=new Promise<void>(resolve=>{release=resolve;});return {promise,release};}
const tables=["workspaces","members","projects","environments","revisions","revision_manifests","deployments","connections"] as const;
const NATIVE_PLAN_BASE_URL=PG_URL;
describe.skipIf(!PG_URL)("native cleanup writer barrier [postgres; modeled hosted association and policy]",()=>{
  let db:PlatformDbHandle,peer:PlatformDbHandle,observer:PlatformDbHandle;
  let native:NativePlanFixtureDatabase|undefined, PG_URL=NATIVE_PLAN_BASE_URL!, nativeCaseFailed=false;
  const standaloneScopes:StandaloneProductScope[]=[];
  beforeAll(async()=>{
    native=await openNativePlanFixtureDatabase(PG_URL);PG_URL=native.url;
    peer=await native.open();observer=await native.open();
    const roles=await peer.query<{n:number}>("select count(*)::integer as n from pg_roles where rolname in ('anon','authenticated','service_role')");
    if(roles[0]?.n!==3)throw new Error("Cleanup writer acceptance requires canonical fixed roles before platform migration.");
    const migration=readFileSync(new URL("../../supabase/migrations/0001_system_of_record.sql",import.meta.url),"utf8");
    for(const name of tables){const ddl=new RegExp(`create table if not exists public\\.${name} \\([\\s\\S]*?\\n\\);`).exec(migration)?.[0];if(!ddl)throw new Error("Canonical product DDL unavailable.");await peer.exec(ddl);}
    state.member=async(ws,id)=>(await observer.query<{id:string;workspace_id:string;role:string}>("select id,workspace_id,role from public.members where workspace_id=$1 and id=$2",[ws,id]))[0]??null;
  },60000);
  beforeEach(async()=>{onTestFailed(()=>{nativeCaseFailed=true;});await resetPlatformDbForTests();resetPlatformBrokerForTests();vi.stubEnv("ZENITH_PLATFORM_BROKER_MEMORY","");vi.stubEnv("ZENITH_PLATFORM_DB","postgres");vi.stubEnv("ZENITH_PLATFORM_DB_URL",PG_URL!);vi.stubEnv("ZENITH_PLATFORM_DB_MAX","1");vi.stubEnv("SUPABASE_DB_URL",PG_URL!);vi.stubEnv("ZENITH_STORE","postgres");
    const signing=await generateSigningJwk("EdDSA");vi.stubEnv("ZENITH_CONTROL_SIGNING_JWK",serializePrivateJwk(signing));db=await native!.remember(await platformDb());});
  afterEach(async()=>{resetPlatformBrokerForTests();await resetPlatformDbForTests();vi.restoreAllMocks();vi.unstubAllEnvs();});
  afterAll(async()=>{
    const ended=await Promise.allSettled([resetPlatformDbForTests()]);
    const removed=await Promise.allSettled([native?.close()]);
    if(nativeCaseFailed||[...ended,...removed].some(result=>result.status==="rejected"))throw new Error("Native plan fixture teardown is unconfirmed; retaining backend roots.");
    const roots=await Promise.allSettled(standaloneScopes.splice(0).map(scope=>scope.close()));
    if(roots.some(result=>result.status==="rejected"))throw new Error("Native plan fixture backend root removal is unconfirmed.");
  },60_000);
  async function defaultHarness(){
    const id=()=>randomUUID();const ids={wsA:`ws_${id()}`,wsB:`ws_${id()}`,projA:`proj_${id()}`,projB:`proj_${id()}`,envAProd:`env_${id()}`};
    const broker=await platformBroker();expect(isDefaultPlatformBrokerFor(broker,db)).toBe(true);return {ids,broker};
  }
  async function fixture(destroy = true, publicationFault?: "removed current human" | "foreign current human", retainHistorical = false) {
    const h = await defaultHarness();
    const workspaceId = h.ids.wsA, projectId = h.ids.projA, environmentId = h.ids.envAProd;
    const revisionId = `rev_${randomUUID()}`, deploymentId = `dep_${randomUUID()}`, connectionId = `public_${randomUUID()}`, nativeId = `conn_${randomUUID()}`;
    const manifest = Manifest.parse({ version: 1, services: [{ id: "web", name: "web", kind: "web", port: 3000,
      source: destroy ? { type: "git", repo: "acme/app", ref: "main", dockerfile: "Dockerfile" } : { type: "image", image: "example/web:v1" } }], resources: [], routes: [], bindings: [] });
    const policies = ManifestPolicies.parse({ approvalRequired: true, allowStatefulDeletion: false });
    const environment = { id: environmentId, name: "production", class: "production" as const, provider: "aws" as const,
      region: "us-east-1", baseDomain: "owning.example.test", connectionId, policies, deployedRevisionId: revisionId };
    const product = { workspace: { id: workspaceId, name: "Owning", slug: "owning" }, project: { id: projectId, name: "Owning", slug: "owning" },
      environment, revision: { id: revisionId, number: 1, manifest }, deploymentId };
    const desired = buildDesiredState(product);
    if (!desired.graph) throw new Error("Canonical worker graph fixture is unavailable.");
    let graph = desired.graph;
    const retained = destroy && retainHistorical ? { ...graph.nodes.find(node => node.kind === "container_service")!, address: "container_service/oldWeb" } : undefined;
    if (destroy) {
      if (retained) await repos.resources.upsertDesired(db, { workspaceId, projectId, environmentId, node: retained, status: "active" });
      const nodes = [...graph.nodes, ...(retained ? [retained] : [])].sort((a,b) => a.address < b.address ? -1 : a.address > b.address ? 1 : 0);
      graph = { ...graph, nodes, graphDigest: digest({ graphDigest: graph.graphDigest, nodes }) };
    }
    await connections.create(db, { id: nativeId, workspaceId, createdBy: "alice", config: { provider: "aws", mode: "aws_assume_role", accountId: "123456789012",
      region: environment.region, externalId: "modeled-product-authority", observeRoleArn: "arn:aws:iam::123456789012:role/zenith_observe_fixture",
      deployRoleArn: "arn:aws:iam::123456789012:role/zenith_deploy_fixture" } });
    await connections.recordVerification(db, { workspaceId, id: nativeId, ok: true });
    await db.query("insert into public.workspaces(id,workspace_id,slug,name,data) values($1,$1,$2,'Owning','{}'::jsonb)", [workspaceId, `owning-${randomUUID()}`]);
    await db.query("insert into public.members(id,workspace_id,email,role,data) values('alice',$1,'alice@example.test',$2,'{}'::jsonb),('erin',$1,'erin@example.test','admin','{}'::jsonb)", [workspaceId, "admin"]);
    await db.query("insert into public.projects(id,workspace_id,slug,name,data) values($1,$2,'owning','Owning',$3::text::jsonb)", [projectId, workspaceId, json({ workingManifest: manifest })]);
    await db.query("insert into public.workspaces(id,workspace_id,slug,name,data) values($1,$1,$2,'Foreign','{}'::jsonb)", [h.ids.wsB, `foreign-${randomUUID()}`]);
    await db.query("insert into public.projects(id,workspace_id,slug,name,data) values($1,$2,'foreign','Foreign','{}'::jsonb)", [h.ids.projB, h.ids.wsB]);
    await db.query("insert into public.environments(id,workspace_id,project_id,class,connection_id,data,deployed_revision_id,created_at) values($1,$2,$3,'production',$4,$5::text::jsonb,$6,clock_timestamp())",
      [environmentId, workspaceId, projectId, connectionId, json({ name: environment.name, region: environment.region, baseDomain: environment.baseDomain, policies }), revisionId]);
    await db.query("insert into public.connections(id,workspace_id,provider,status,data) values($1,$2,'aws','healthy',$3::text::jsonb)", [connectionId, workspaceId, json({ region: environment.region, platformConnectionId: nativeId })]);
    await db.query("insert into public.revisions(id,workspace_id,project_id,number,data) values($1,$2,$3,1,$4::text::jsonb)", [revisionId, workspaceId, projectId, json({ message: "approved original" })]);
    await db.query("insert into public.revision_manifests(revision_id,workspace_id,manifest) values($1,$2,$3::text::jsonb)", [revisionId, workspaceId, json(manifest)]);
    state.snapshot = { workspaces: [{ id: workspaceId }], projects: [{ id: projectId, workspaceId }],
      environments: [{ ...environment, projectId }], connections: [{ id: connectionId, provider: "aws" }] };
    const principal = user("alice");
    await repos.settings.putEnvironmentSettings(db, { workspaceId, environmentId, autonomyLevel: 5, updatedBy: "fixture" });
    const proposed = (await h.broker.propose({ capability: destroy ? "infrastructure.plan" : "deployment.deploy", scope: { workspaceId, projectId, environmentId },
      input: { revisionId, deploymentId, ...(destroy ? { environmentId, teardownReview: true } : {}) } }, principal)).operation;
    const op = await repos.operations.get(db, workspaceId, proposed.id);
    if (!op) throw new Error("Native original operation is unavailable.");
    await db.query("insert into public.deployments(id,workspace_id,project_id,environment_id,revision_id,status,data) values($1,$2,$3,$4,$5,'planning',$6::text::jsonb)",
      [deploymentId, workspaceId, projectId, environmentId, revisionId, json({ executor: "workflow", operationId: op.id })]);
    if (!destroy) await h.broker.approve({ workspaceId, operationId: op.id, proposalDigest: op.proposalDigest, approver: user("erin"), session: sessionFor("erin") });
    const lease = await repos.leases.acquire(db, { workspaceId, scope: `env:${environmentId}`, holder: `worker:${op.id}`, ttlMs: 120_000 });
    if (!lease) throw new Error("Native original lease is unavailable.");
    await h.broker.beginExecution({ workspaceId, operationId: op.id, holder: executionHolder(op.id), audience: "worker", lease, leaseMs: 120_000 });
    const snapshots: never[] = [];
    const plan = normalizePlan({ format_version: "1.2", terraform_version: TOFU_VERSION, resource_changes: [], output_changes: {} },
      { configDigest: digest("synthetic original config"), lockDigest: digest("synthetic original lock"), addressMap: {} });
    const facts = extractPlanFacts(plan), summary = { ...planEvidence({ plan, facts, cost: {}, graphDigest: graph.graphDigest, stage: "plan" }).summary,
      ...(destroy ? { destroy: true, destroyAddresses: [], statefulDeletes: [] } : {}) };
    const worker = createExecutionBroker(db), ports = createOperationsPort(db);
    await repos.evidence.insert(db, { workspaceId, operationId: op.id, kind: "tofu_plan", digest: plan.planDigest, summary, simulated: false });
    await ports.setPlanDigest({ workspaceId, operationId: op.id, planDigest: plan.planDigest });
    const decision = await worker.reevaluate(op.id, facts); await ports.setPolicyDecision({ workspaceId, operationId: op.id, decisionId: decision.decisionId });
    if (!destroy) {
    await ports.transition({ workspaceId, operationId: op.id, to: "awaiting_approval" });
    await h.broker.approve({ workspaceId, operationId: op.id, proposalDigest: op.proposalDigest, planDigest: plan.planDigest, approver: user("erin"), session: sessionFor("erin") });
    await repos.operations.claimForExecution(db, { workspaceId, id: op.id, expectedDigest: op.proposalDigest, holder: executionHolder(op.id), leaseMs: 120_000, lease, expectedPolicyVersion: "cleanup-writer-policy" });
    }
    const native = await connections.get(db, workspaceId, nativeId);
    if (!native) throw new Error("Native original provider is unavailable.");
    const custody = planCustody({ op, workspaceId, environmentId, scope: scopeOf(op), product, deploymentId }, graph.graphDigest, native);
    const payload = "synthetic original OAuth target-bound SQL payload", key = randomBytes(32).toString("hex"), cipher = planArtifactCipherFromEnv({ ZENITH_PLAN_ARTIFACT_KEY: key });
    const manifestArtifact: PlanArtifactManifest = { ...custody, format: "zenith.plan-artifact.v1", purpose: destroy ? "destroy" : "deploy", planDigest: plan.planDigest,
      configDigest: plan.configDigest, lockDigest: plan.lockDigest, backendDigest: digest("synthetic backend"), addressMapDigest: digest("synthetic address map"),
      rawSha256: sha(payload), bytes: Buffer.byteLength(payload), executable: { version: "fixture", platform: "fixture", sha256: digest("fixture binary"), archiveSha256: null } };
    const sealed = cipher.seal(workspaceId, `zenith.tofu.plan-artifact.v1:${sha(stableJson(manifestArtifact))}`, Buffer.from(payload).toString("base64"));
    if (publicationFault === "removed current human") await observer.query("delete from public.members where workspace_id=$1 and id='alice'", [workspaceId]);
    if (publicationFault === "foreign current human") await observer.query("update public.members set workspace_id=$2 where workspace_id=$1 and id='alice'", [workspaceId, h.ids.wsB]);
    await artifacts.publish(db, { manifest: manifestArtifact, sealed, lease, evidence: { workspaceId, operationId: op.id, kind: "tofu_plan", digest: plan.planDigest, summary, simulated: false } });
    return { h, op, principal, worker, retained, manifest: manifestArtifact, graph, snapshots, lease, revisionId, deploymentId, connectionId, nativeId,
      access: { custody, planDigest: plan.planDigest, lease }, payload, cipher, plan, key };
  }
  type Fixture=Awaited<ReturnType<typeof fixture>>;
  async function destination(f:Fixture){
    const ws=f.op.workspaceId,proposed=await f.h.broker.propose({capability:"infrastructure.destroy",scope:{workspaceId:ws,projectId:f.op.projectId,environmentId:f.op.environmentId},input:{environmentId:f.op.environmentId}},
      f.principal,{via:"workflow",teardownReview:true,destroyPlan:{operationId:f.op.id,planDigest:f.access.planDigest}});
    const op=await repos.operations.get(db,ws,proposed.operation.id);if(!op)throw new Error("Native destroy destination unavailable.");
    const ref=z.object({broker:z.object({destroyPlan:z.object({operationId:z.string(),evidenceId:z.string()})})}).parse(op.proposal).broker.destroyPlan;
    const evidence=await repos.evidence.get(db,ws,ref.evidenceId);if(!evidence)throw new Error("Native original review unavailable.");
    await repos.evidence.insert(db,{workspaceId:ws,operationId:op.id,kind:"tofu_plan",digest:f.access.planDigest,summary:evidence.summary,simulated:false});
    await artifacts.associate(db,{workspaceId:ws,sourceOperationId:f.op.id,destinationOperationId:op.id,sourceEvidenceId:ref.evidenceId,planDigest:f.access.planDigest,lease:f.lease});
    await repos.operations.transition(db,{workspaceId:ws,id:f.op.id,from:["running"],to:"succeeded",fence:f.lease,patch:{result:{operationId:op.id,planDigest:f.access.planDigest}}});await repos.leases.release(db,f.lease);
    await f.h.broker.approve({workspaceId:ws,operationId:op.id,proposalDigest:op.proposalDigest,planDigest:f.access.planDigest,approver:user("erin"),session:sessionFor("erin")});
    await repos.operations.claimForExecution(db,{workspaceId:ws,id:op.id,expectedDigest:op.proposalDigest,holder:executionHolder(op.id),leaseMs:120000});
    const lease=await repos.operations.acquireExecutionLease(db,{workspaceId:ws,scope:f.lease.scope,holder:`worker:destination:${op.id}`,ttlMs:120000,operation:{id:op.id,proposalDigest:op.proposalDigest}});if(!lease)throw new Error("Native destination fence unavailable.");
    return {op,access:{custody:{...f.access.custody,operationId:op.id,proposalDigest:op.proposalDigest,inputDigest:op.inputDigest,expiresAt:op.expiresAt},planDigest:f.access.planDigest,lease}};
  }

  const stop=new Error("Owned callback deliberately ended before raw apply.");
  async function owning(destroy=true){const f=await fixture(destroy);const d=await destination(f);return {f,d,runtime:createPlanArtifactRuntime(db,{ZENITH_PLAN_ARTIFACT_KEY:f.key})};}
  type Owning=Awaited<ReturnType<typeof owning>>;
  async function holdRows(o:Owning){return observer.query("select operation_id,attempt_id,generation,authority_digest from platform.cleanup_writer_holds where workspace_id=$1 and environment_id=$2",[o.f.op.workspaceId,o.f.op.environmentId]);}
  async function consume(o:Owning,body:(o:Owning)=>Promise<void>=async()=>undefined){
    let entered=0;const error=await o.runtime.planArtifacts.consume(o.d.access,async original=>{
      entered++;expect(original.manifest.rawSha256).toBe(o.f.manifest.rawSha256);await body(o);throw stop;
    }).catch((error:unknown)=>error);return {entered,error};
  }
  async function sibling(o:Owning,environmentId=o.f.op.environmentId,projectId=o.f.op.projectId){
    return (await seedApprovedOperation(peer,o.f.op.workspaceId,{proposal:{capability:"infrastructure.apply",scope:{workspaceId:o.f.op.workspaceId,projectId,environmentId}}})).operation;
  }
  const recordGrant=(o:Owning,id:string,capability="infrastructure.apply")=>repos.grants.insert(peer,{jti:randomUUID(),workspaceId:o.f.op.workspaceId,operationId:id,capability,audience:"worker",issuedAt:new Date().toISOString(),expiresAt:new Date(Date.now()+60000).toISOString()});
  async function verifiedHold(o:Owning){const result=await consume(o);expect(result.entered).toBe(1);expect(result.error).toBe(stop);expect(await holdRows(o)).toHaveLength(1);return result;}
  async function blocked(o:Owning){const result=await consume(o);expect(result.entered).toBe(0);expect(result.error).toBeInstanceOf(cleanup.CleanupWriterBarrierError);return result;}
  async function waitForBackend(pid:number){
    const deadline=Date.now()+10000;
    while(Date.now()<deadline){const rows=await observer.query<{waiting:boolean}>("select exists(select 1 from pg_stat_activity where pid=$1 and wait_event_type='Lock') as waiting",[pid]);if(rows[0]?.waiting)return;await new Promise(resolve=>setTimeout(resolve,10));}
    throw new Error("The actual independent backend did not reach its owned lock wait.");
  }
  async function waitForFinalInventory(pid:number,blockingPid:number){
    const deadline=Date.now()+10000;
    while(Date.now()<deadline){
      const rows=await observer.query<{waiting:boolean}>(`select exists(
        select 1 from pg_locks waiter join pg_stat_activity activity on activity.pid=waiter.pid
        where waiter.pid=$1::integer and waiter.locktype='relation'
          and waiter.database=(select oid from pg_database where datname=current_database())
          and waiter.relation='platform.cleanup_writer_deliveries'::regclass
          and waiter.mode='AccessShareLock' and waiter.granted=false and activity.wait_event_type='Lock'
          and $2::integer=any(pg_blocking_pids($1::integer))
          and exists(select 1 from pg_locks holder where holder.pid=$2::integer
            and holder.locktype='relation' and holder.database=waiter.database and holder.relation=waiter.relation
            and holder.mode='AccessExclusiveLock' and holder.granted=true)
      ) as waiting`,[pid,blockingPid]);
      if(rows[0]?.waiting)return;
      await new Promise(resolve=>setTimeout(resolve,10));
    }
    throw new Error("The actual owning backend did not reach its final native history inventory wait.");
  }
  // Three physical backends: the owner waits on real history, the peer owns the relation lock,
  // and the independent observer commits a current authority change. Signing stays local.
  async function finalInventoryWait(o:Owning,stage:"reservation"|"grant",change:()=>Promise<void>,expireBeforeCapture=false){
    const entered=barrier(),release=barrier();let holding:Promise<void>|undefined,blockingPid:number|undefined,returned=0,signs=0;
    const pid=(await db.query<{pid:number}>("select pg_backend_pid() as pid"))[0].pid;
    const lock=async()=>{
      holding=peer.tx(async tx=>{
        blockingPid=(await tx.query<{pid:number}>("select pg_backend_pid() as pid"))[0]?.pid;
        if(typeof blockingPid!=="number"||!Number.isSafeInteger(blockingPid)||blockingPid<=0||blockingPid===pid)
          throw new Error("The actual independent history-lock backend PID is unavailable.");
        await tx.query("lock table platform.cleanup_writer_deliveries in access exclusive mode");entered.release();await release.promise;
      });
      await entered.promise;
    };
    const original=CredentialGrantSigner.prototype.sign;
    vi.spyOn(CredentialGrantSigner.prototype,"sign").mockImplementation(async function(this:CredentialGrantSigner,claims){
      const signed=await original.call(this,claims);signs++;
      if(stage==="grant"){
        if(expireBeforeCapture)await observer.query("update platform.leases set expires_at=clock_timestamp()+interval '5 seconds' where workspace_id=$1 and scope=$2",[o.f.op.workspaceId,o.d.access.lease.scope]);
        await lock();
      }
      return signed;
    });
    const pending=consume(o,async()=>{
      if(stage==="reservation")await lock();
      await createExecutionBroker(db).issueGrant(o.d.op.id,"worker",o.d.access.lease,{capability:"infrastructure.destroy"});returned++;
    });
    let entryTimer:ReturnType<typeof setTimeout>|undefined;
    try{
      await Promise.race([entered.promise,new Promise<never>((_resolve,reject)=>{entryTimer=setTimeout(()=>reject(new Error("The owned final history lock was not reached.")),10000);})]);
      if(typeof blockingPid!=="number")throw new Error("The owned history-lock backend PID was not captured.");
      await waitForFinalInventory(pid,blockingPid);await change();
    }finally{if(entryTimer)clearTimeout(entryTimer);release.release();await holding?.catch(()=>undefined);}
    const result=await pending;
    expect(result.entered).toBe(1);
    expect(await holdRows(o)).toHaveLength(1);
    expect(await observer.query("select count(*)::integer as n from platform.cleanup_owner_grants where workspace_id=$1 and operation_id=$2",[o.f.op.workspaceId,o.d.op.id])).toEqual([{n:stage==="grant"?1:0}]);
    expect(await observer.query("select count(*)::integer as n from platform.capability_grants where workspace_id=$1 and operation_id=$2",[o.f.op.workspaceId,o.d.op.id])).toEqual([{n:returned}]);
    expect(signs).toBe(stage==="grant"?1:0);
    return {result,returned};
  }
  // Direct native rows below isolate the shared SQL transition only. Their synthetic binding/envelope is never Start or provider authority.
  type Family="workflow"|"plan"|"build"|"runner"|"machine";
  async function handoff(o:Owning,family:Family,id:string,phase="attempted") {
    const ws=o.f.op.workspaceId,attempt=randomUUID();
    if(family==="workflow") {
      const binding={format:"zenith.workflow-start.v1",arguments:{workspaceId:ws,operationId:id},endpointDigest:sha(id),namespace:"fixture",workflowId:`fixture:${id}`};
      await peer.query("insert into platform.workflow_start_intents(workspace_id,operation_id,binding,binding_digest,phase,attempt_id,attempted_at) values($1,$2,$3::text::jsonb,$4,$5,$6,case when $5='attempted' then clock_timestamp() else null end)",
        [ws,id,json(binding),digest(binding),phase,phase==="attempted"?attempt:null]);return {attempt,id};
    }
    if(family==="plan") {
      await peer.query("insert into platform.plan_artifact_uses(workspace_id,operation_id,phase,attempt_id,holder,fence_token) values($1,$2,'dispatched',$3,'diagnostic',1)",[ws,id,attempt]);return {attempt,id};
    }
    if(family==="build") {
      const binding={workspaceId:ws,operationId:id,environmentId:o.f.op.environmentId,serviceAddress:"container_service/diagnostic"};
      await peer.query("insert into platform.build_launches(workspace_id,operation_id,service_address,environment_id,attempt_id,binding,binding_digest,proposal_digest,input_digest,plan_digest,fence_token) values($1,$2,'container_service/diagnostic',$3,$4,$5::text::jsonb,$6,$6,$6,$6,1)",
        [ws,id,o.f.op.environmentId,attempt,json(binding),digest(binding)]);return {attempt,id};
    }
    const target=`diagnostic_${randomUUID()}`,request=`diagnostic_${randomUUID()}`;
    if(family==="runner") {
      await peer.query("insert into platform.runners(id,workspace_id,name,public_key) values($1,$2,'diagnostic','fixture-public-key')",[target,ws]);
      await peer.query("insert into platform.runner_jobs(id,runner_id,workspace_id,operation_id,kind,capability,envelope,status,expires_at,started_at) values($1,$2,$3,$4,'diagnostic','infrastructure.apply','synthetic-no-authority',$5,clock_timestamp()+interval '1 minute',case when $5='running' then clock_timestamp() else null end)",[request,target,ws,id,phase]);
    } else {
      await peer.query("insert into platform.machines(id,workspace_id,name,transport,target_id) values($1,$2,'diagnostic','zenithd',$1)",[target,ws]);
      await peer.query("insert into platform.machine_requests(id,machine_id,workspace_id,operation_id,operation,capability,envelope,status,expires_at,started_at) values($1,$2,$3,$4,'diagnostic','infrastructure.apply','synthetic-no-authority',$5,clock_timestamp()+interval '1 minute',case when $5='running' then clock_timestamp() else null end)",[request,target,ws,id,phase]);
    }
    return {attempt,id:request};
  }
  it("genuine default paired codec commits an exact scoped native hold before entering the callback",async()=>{
    // The teardown's own acknowledged destroy start never blocks its hold, though the operation records no workflow id.
    const o=await owning(),c=o.d.access.custody,ws=o.f.op.workspaceId;
    const args={workspaceId:ws,operationId:c.operationId,environmentId:c.environmentId};
    const request={kind:"destroy",arguments:args,namespace:"fixture",endpointDigest:sha(c.operationId),taskQueue:"fixture"};
    const binding={...request,format:"zenith.workflow-start.v1",workflowType:intents.WORKFLOW_START_TYPES.destroy,workflowId:`op-${c.operationId}`,
      argumentsDigest:digest(args),proposalDigest:c.proposalDigest,inputDigest:c.inputDigest,
      sourceDigest:digest({proposalDigest:c.proposalDigest,inputDigest:c.inputDigest,argumentsDigest:digest(args)}),configDigest:digest(intents.START_CONFIG)};
    await peer.query("insert into platform.workflow_start_intents(workspace_id,operation_id,binding,binding_digest,phase,attempt_id,attempted_at) values($1,$2,$3::text::jsonb,$4,'attempted',$5,clock_timestamp())",
      [ws,c.operationId,json(binding),digest(binding),randomUUID()]);
    await peer.query("update platform.workflow_start_intents set phase='acknowledged',run_id=$3,observed_start_at=clock_timestamp(),evidence_digest=$4,acknowledged_at=clock_timestamp() where workspace_id=$1 and operation_id=$2",[ws,c.operationId,randomUUID(),sha("own start")]);
    // The bridge starts the destroy workflow without writing operations.workflow_id; only the start intent names it.
    expect(await observer.query("select workflow_id from platform.operations where workspace_id=$1 and id=$2",[ws,c.operationId])).toEqual([{workflow_id:null}]);
    expect((await cleanup.preview(observer,ws,o.f.op.projectId!,o.f.op.environmentId!)).handoffs).toBe(2);
    await verifiedHold(o);const bound=bindRepos(db);
    expect(Object.keys(bound.cleanupWriterBarriers)).toEqual(["preview"]);
    expect((await holdRows(o))[0]).toMatchObject({operation_id:o.d.op.id});
    expect(await observer.query("select jti from platform.cleanup_owner_grants where workspace_id=$1",[o.f.op.workspaceId])).toEqual([]);
  });
  it("direct repository and copied DTO calls cannot create a native hold",async()=>{
    const o=await owning();let getters=0;const forged=Object.defineProperty({},"access",{get(){getters++;return o.d.access;}});
    await expect(cleanup.retain(db,forged)).rejects.toBeInstanceOf(cleanup.CleanupWriterBarrierError);
    await expect(artifacts.retainCleanupWriterHold(db,{access:o.d.access,attempt:randomUUID()})).rejects.toBeInstanceOf(cleanup.CleanupWriterBarrierError);
    const grant={jti:randomUUID(),workspaceId:o.f.op.workspaceId,operationId:o.d.op.id,capability:"infrastructure.destroy",audience:"worker",issuedAt:new Date().toISOString(),expiresAt:new Date(Date.now()+60000).toISOString()};
    await expect(cleanup.reserveOwnerGrant(db,forged,grant.jti)).rejects.toBeInstanceOf(cleanup.CleanupWriterBarrierError);
    await expect(cleanup.insertOwnerGrant(db,forged,grant)).rejects.toBeInstanceOf(cleanup.CleanupWriterBarrierError);
    await expect(artifacts.reserveCleanupOwnerGrant(db,forged,grant.jti)).rejects.toBeInstanceOf(cleanup.CleanupWriterBarrierError);
    await expect(artifacts.insertCleanupOwnerGrant(db,forged,grant)).rejects.toBeInstanceOf(cleanup.CleanupWriterBarrierError);
    expect(getters).toBe(0);expect(await holdRows(o)).toEqual([]);
  });
  it("isolated custody never issues native cleanup authority or a destructive grant",async()=>{
    const o=await owning(),isolated=createIsolatedPlanArtifactRuntimeForTests(db,{ZENITH_PLAN_ARTIFACT_KEY:o.f.key},o.f.worker);let entered=0;
    await isolated.planArtifacts.consume(o.d.access,async()=>{entered++;await createExecutionBroker(db).issueGrant(o.d.op.id,"worker",o.d.access.lease,{capability:"infrastructure.destroy"});}).catch(()=>undefined);
    expect(entered).toBe(1);expect(await holdRows(o)).toEqual([]);expect(await observer.query("select jti from platform.capability_grants where workspace_id=$1 and operation_id=$2",[o.f.op.workspaceId,o.d.op.id])).toEqual([]);
  });
  it("wrong authenticated bytes refuse before retaining any native hold",async()=>{
    const o=await owning(),wrong=createPlanArtifactRuntime(db,{ZENITH_PLAN_ARTIFACT_KEY:randomBytes(32).toString("hex")});let entered=0;
    await expect(wrong.planArtifacts.consume(o.d.access,async()=>{entered++;})).rejects.toThrow();expect(entered).toBe(0);expect(await holdRows(o)).toEqual([]);
  });
  it("a copied owning SQL handle cannot originate a hold even with authentic bytes",async()=>{
    const o=await owning(),copy={...db};let entered=0;
    await createPlanArtifactRuntime(copy,{ZENITH_PLAN_ARTIFACT_KEY:o.f.key}).planArtifacts.consume(o.d.access,async()=>{entered++;}).catch(()=>undefined);
    expect(entered).toBe(0);expect(await holdRows(o)).toEqual([]);
  });
  it("one active authenticated held attempt reserves and inserts exactly one native owner JTI",async()=>{
    const o=await owning();let issued=0;
    const result=await consume(o,async()=>{const worker=createExecutionBroker(db);const grant=await worker.issueGrant(o.d.op.id,"worker",o.d.access.lease,{capability:"infrastructure.destroy"});issued++;
      expect(grant.claims.cap).toBe("infrastructure.destroy");expect(grant.claims.op).toBe(o.d.op.id);
      await expect(worker.issueGrant(o.d.op.id,"worker",o.d.access.lease,{capability:"infrastructure.destroy"})).rejects.toBeInstanceOf(cleanup.CleanupWriterBarrierError);
    });
    expect(result.error).toBe(stop);expect(issued).toBe(1);
    expect(await observer.query("select count(*)::integer as n from platform.cleanup_owner_grants where workspace_id=$1",[o.f.op.workspaceId])).toEqual([{n:1}]);
    expect(await observer.query("select count(*)::integer as n from platform.capability_grants where workspace_id=$1 and operation_id=$2",[o.f.op.workspaceId,o.d.op.id])).toEqual([{n:1}]);
  });
  it("a prior same-operation issued grant is retained as a blocker after claimed use returns ready",async()=>{
    const o=await owning();await consume(o,async()=>{await createExecutionBroker(db).issueGrant(o.d.op.id,"worker",o.d.access.lease,{capability:"infrastructure.destroy"});});const before=await holdRows(o);
    // WP5: the refused attempt commits its own generation; the earlier generation is unchanged and still freezes nothing new.
    await blocked(o);const after=await holdRows(o);expect(after).toHaveLength(before.length+1);expect(after).toEqual(expect.arrayContaining(before));
    expect(await observer.query("select count(*)::integer as n from platform.cleanup_owner_grants where workspace_id=$1",[o.f.op.workspaceId])).toEqual([{n:1}]);
  });
  it("an earlier unconsumed mutation grant blocks callback entry while the new hold still commits",async()=>{
    const o=await owning(),other=await sibling(o);await recordGrant(o,other.id);await blocked(o);expect(await holdRows(o)).toHaveLength(1);
    expect((await cleanup.preview(observer,o.f.op.workspaceId,o.f.op.projectId!,o.f.op.environmentId!)).grants).toBe(1);
  });
  it("expiry or revocation of an issued grant never supplies provider nondelivery proof",async()=>{
    const o=await owning(),other=await sibling(o),grant=await recordGrant(o,other.id);
    await repos.grants.revoke(peer,o.f.op.workspaceId,grant.jti);await peer.query("update platform.capability_grants set expires_at=clock_timestamp()-interval '1 second' where workspace_id=$1 and jti=$2",[o.f.op.workspaceId,grant.jti]);
    await blocked(o);expect(await holdRows(o)).toHaveLength(1);
  });
  it("a pre-epoch operation remains unknown even when terminal projections and handoffs are empty",async()=>{
    const o=await owning(),other=await sibling(o);await peer.query("update platform.operations set created_at=(select installed_at-interval '1 second' from platform.cleanup_writer_epoch where singleton),status='succeeded' where workspace_id=$1 and id=$2",[o.f.op.workspaceId,other.id]);
    await blocked(o);expect((await cleanup.preview(observer,o.f.op.workspaceId,o.f.op.projectId!,o.f.op.environmentId!)).unknownHistory).toBeGreaterThan(0);
  });
  it("an unknown product scope creation time cannot be inferred fresh from zero native writers",async()=>{
    const o=await owning();await peer.query("update public.environments set created_at=null where workspace_id=$1 and id=$2",[o.f.op.workspaceId,o.f.op.environmentId]);await blocked(o);expect(await holdRows(o)).toHaveLength(1);
  });
  // Schema 61 hold lifecycle. An unknown scope creation time is the one blocker a native fixture can clear to zero:
  // every delivery stays in the immutable possible-delivery ledger, so a real drain needs settlement (WP3).
  const clearScope=(o:Owning)=>peer.query("update public.environments set created_at=null where workspace_id=$1 and id=$2",[o.f.op.workspaceId,o.f.op.environmentId]);
  const restoreScope=(o:Owning)=>peer.query("update public.environments set created_at=clock_timestamp() where workspace_id=$1 and id=$2",[o.f.op.workspaceId,o.f.op.environmentId]);
  async function holdSeqs(o:Owning){return observer.query<{hold_seq:string;attempt_id:string;released:boolean}>(`select h.hold_seq::text as hold_seq,h.attempt_id,
    exists(select 1 from platform.cleanup_writer_hold_releases r where r.workspace_id=h.workspace_id and r.hold_seq=h.hold_seq) as released
    from platform.cleanup_writer_holds h where h.workspace_id=$1 and h.environment_id=$2 order by h.hold_seq`,[o.f.op.workspaceId,o.f.op.environmentId]);}
  async function releasesOf(o:Owning){return observer.query<{hold_seq:string;released_by:string}>(`select r.hold_seq::text as hold_seq,r.released_by
    from platform.cleanup_writer_hold_releases r where r.workspace_id=$1 and r.environment_id=$2 order by r.hold_seq`,[o.f.op.workspaceId,o.f.op.environmentId]);}
  it("a refused teardown releases its own generation in the same commit, so a later writer is allowed",async()=>{
    const o=await owning();await clearScope(o);await blocked(o);
    const [hold]=await holdSeqs(o);expect(hold.released).toBe(true);
    expect(await releasesOf(o)).toEqual([{hold_seq:hold.hold_seq,released_by:`refused:${hold.attempt_id}`}]);
    const other=await sibling(o);
    await expect(recordGrant(o,other.id)).resolves.toBeDefined();
  });
  it("an entered attempt's hold freezes the environment until the janitor releases it drained",async()=>{
    const o=await owning();const result=await consume(o);expect(result.entered).toBe(1);expect(result.error).toBe(stop);
    const other=await sibling(o);
    await expect(recordGrant(o,other.id)).rejects.toThrow(/refuses a new possible delivery/);
    // The sweep is global across fixtures; this environment's own release is what is asserted.
    await artifacts.releaseDrainedHolds(db);
    const [first]=await holdSeqs(o);expect(first.released).toBe(true);
    expect(await releasesOf(o)).toEqual([{hold_seq:first.hold_seq,released_by:"janitor"}]);
    await expect(recordGrant(o,other.id)).resolves.toBeDefined();
  });
  it("the retain path releases a drained superseded generation first, and only then inserts the new one",async()=>{
    const o=await owning();expect((await consume(o)).entered).toBe(1);
    const result=await consume(o);expect(result.entered).toBe(1);expect(result.error).toBe(stop);
    const [first,second]=await holdSeqs(o);
    expect(BigInt(second.hold_seq)>BigInt(first.hold_seq)).toBe(true);
    expect(first.released).toBe(true);expect(second.released).toBe(false);
    expect(await releasesOf(o)).toEqual([{hold_seq:first.hold_seq,released_by:expect.stringMatching(/^retain:/)}]);
  });
  it("a janitor sweep does not release a hold while the counted inventory is nonzero",async()=>{
    const o=await owning();expect((await consume(o)).entered).toBe(1);
    await clearScope(o);
    await artifacts.releaseDrainedHolds(db);
    expect(await releasesOf(o)).toEqual([]);
    expect(await holdSeqs(o)).toEqual([expect.objectContaining({released:false})]);
    await restoreScope(o);
  });
  it("a janitor sweep never releases the hold of a live claimed attempt, even at zero inventory",async()=>{
    const o=await owning();
    const result=await consume(o,async()=>{await artifacts.releaseDrainedHolds(db);});
    expect(result.entered).toBe(1);
    expect(await holdSeqs(o)).toHaveLength(1);expect(await releasesOf(o)).toEqual([]);
  });
  it("hold release rows are append-only",async()=>{
    const o=await owning();await clearScope(o);await blocked(o);
    await expect(peer.query("update platform.cleanup_writer_hold_releases set released_by='changed' where workspace_id=$1",[o.f.op.workspaceId])).rejects.toThrow(/cannot be changed or cleared/);
    await expect(peer.query("delete from platform.cleanup_writer_hold_releases where workspace_id=$1",[o.f.op.workspaceId])).rejects.toThrow(/cannot be changed or cleared/);
    expect(await releasesOf(o)).toHaveLength(1);
  });
  it("a new scoped mutation grant waits on the actual final coordinator then refuses the committed hold",async()=>{
    const o=await owning(),other=await sibling(o);await verifiedHold(o);const entered=barrier(),release=barrier();let pid=0;
    const held=peer.tx(async tx=>{await tx.query("select id from platform.operations where workspace_id=$1 and id=$2 for key share",[o.f.op.workspaceId,other.id]);await tx.query("select workspace_id from platform.cleanup_writer_scopes where workspace_id=$1 for update",[o.f.op.workspaceId]);entered.release();await release.promise;});
    await entered.promise;const writer=openPlatformDb({kind:"postgres",url:PG_URL!,max:1});const sql=await writer;
    try{pid=(await sql.query<{pid:number}>("select pg_backend_pid() as pid"))[0].pid;
      const pending=repos.grants.insert(sql,{jti:randomUUID(),workspaceId:o.f.op.workspaceId,operationId:other.id,capability:"infrastructure.apply",audience:"worker",issuedAt:new Date().toISOString(),expiresAt:new Date(Date.now()+60000).toISOString()}).catch((error:unknown)=>error);
      await waitForBackend(pid);release.release();await held;expect(await pending).toBeInstanceOf(Error);
      expect(await sql.query("select jti from platform.capability_grants where workspace_id=$1 and operation_id=$2",[o.f.op.workspaceId,other.id])).toEqual([]);
    }finally{release.release();await held.catch(()=>undefined);await sql.close();}
  });
  it("scope inventory sees an independently committed grant after the real hold coordinator wait",async()=>{
    const o=await owning(),other=await sibling(o);await peer.query("insert into platform.cleanup_writer_scopes(workspace_id) values($1) on conflict do nothing",[o.f.op.workspaceId]);const entered=barrier(),release=barrier();
    const holding=peer.tx(async tx=>{await tx.query("select id from platform.operations where workspace_id=$1 and id=$2 for key share",[o.f.op.workspaceId,other.id]);await tx.query("select workspace_id from platform.cleanup_writer_scopes where workspace_id=$1 for update",[o.f.op.workspaceId]);entered.release();await release.promise;
      await repos.grants.insert(tx,{jti:randomUUID(),workspaceId:o.f.op.workspaceId,operationId:other.id,capability:"infrastructure.apply",audience:"worker",issuedAt:new Date().toISOString(),expiresAt:new Date(Date.now()+60000).toISOString()});});
    await entered.promise;const pid=(await db.query<{pid:number}>("select pg_backend_pid() as pid"))[0].pid;const pending=consume(o);
    try{await waitForBackend(pid);}finally{release.release();}await holding;expect((await pending).entered).toBe(0);expect(await holdRows(o)).toHaveLength(1);
  });
  it("current human demotion committed during the actual coordinator wait refuses hold insertion",async()=>{
    const o=await owning();await peer.query("insert into platform.cleanup_writer_scopes(workspace_id) values($1) on conflict do nothing",[o.f.op.workspaceId]);const entered=barrier(),release=barrier();
    const holding=peer.tx(async tx=>{await tx.query("select workspace_id from platform.cleanup_writer_scopes where workspace_id=$1 for update",[o.f.op.workspaceId]);entered.release();await release.promise;});
    await entered.promise;const pid=(await db.query<{pid:number}>("select pg_backend_pid() as pid"))[0].pid;const pending=consume(o);
    try{await waitForBackend(pid);await observer.query("update public.members set role='viewer' where workspace_id=$1 and id='alice'",[o.f.op.workspaceId]);}finally{release.release();}await holding;
    expect((await pending).entered).toBe(0);expect(await holdRows(o)).toEqual([]);
  });
  it("fresh post-signing current human refusal never inserts or returns a bearer and retains its JTI reservation",async()=>{
    const o=await owning();let returned=0;const original=CredentialGrantSigner.prototype.sign;
    // Each genuine default broker constructs its own signer. Intercept only the real signing await, then use an independent native commit.
    vi.spyOn(CredentialGrantSigner.prototype,"sign").mockImplementation(async function(this:CredentialGrantSigner,claims){const result=await original.call(this,claims);await observer.query("update public.members set role='viewer' where workspace_id=$1 and id='alice'",[o.f.op.workspaceId]);return result;});
    await consume(o,async()=>{await createExecutionBroker(db).issueGrant(o.d.op.id,"worker",o.d.access.lease,{capability:"infrastructure.destroy"});returned++;});
    expect(returned).toBe(0);expect(await observer.query("select count(*)::integer as n from platform.cleanup_owner_grants where workspace_id=$1",[o.f.op.workspaceId])).toEqual([{n:1}]);
    expect(await observer.query("select jti from platform.capability_grants where workspace_id=$1 and operation_id=$2",[o.f.op.workspaceId,o.d.op.id])).toEqual([]);
  });
  it("a detached async child cannot retain the active paired issuance context after callback disposal",async()=>{
    const o=await owning(),release=barrier();let pending:Promise<unknown>|undefined;
    await consume(o,async()=>{pending=release.promise.then(()=>createExecutionBroker(db).issueGrant(o.d.op.id,"worker",o.d.access.lease,{capability:"infrastructure.destroy"})).catch((error:unknown)=>error);});release.release();
    expect(await pending).toBeInstanceOf(cleanup.CleanupWriterBarrierError);expect(await observer.query("select jti from platform.cleanup_owner_grants where workspace_id=$1",[o.f.op.workspaceId])).toEqual([]);
  });
  it("direct Kubernetes or Zenith-style destroy issuance refuses without any private held context",async()=>{
    const o=await owning();await expect(createExecutionBroker(db).issueGrant(o.d.op.id,"worker",o.d.access.lease,{capability:"infrastructure.destroy"})).rejects.toBeInstanceOf(cleanup.CleanupWriterBarrierError);
    await expect(readNativeCleanupOwnerGrantOrigin(db,o.d.op.id,"infrastructure.destroy","worker",o.d.access.lease)).rejects.toBeInstanceOf(cleanup.CleanupWriterBarrierError);
    expect(await observer.query("select jti from platform.capability_grants where workspace_id=$1 and operation_id=$2",[o.f.op.workspaceId,o.d.op.id])).toEqual([]);
  });
  it("read attenuation remains available under a retained hold and does not imply write authority",async()=>{
    const o=await owning();const result=await consume(o,async()=>{const grant=await createExecutionBroker(db).issueGrant(o.d.op.id,"worker",o.d.access.lease,{capability:"infrastructure.plan"});expect(grant.claims.cap).toBe("infrastructure.plan");});expect(result.error).toBe(stop);
    expect(await observer.query("select jti from platform.cleanup_owner_grants where workspace_id=$1",[o.f.op.workspaceId])).toEqual([]);
  });
  it("an actual unrelated immutable environment scope remains writable while an unscoped writer refuses",async()=>{
    const o=await owning();await verifiedHold(o);const other=await sibling(o,`env_${randomUUID()}`),unknown=(await seedApprovedOperation(peer,o.f.op.workspaceId,{proposal:{capability:"infrastructure.apply",scope:{workspaceId:o.f.op.workspaceId}}})).operation;
    await expect(recordGrant(o,other.id)).resolves.toMatchObject({operationId:other.id});await expect(recordGrant(o,unknown.id)).rejects.toThrow();
  });
  it("changed promoted scope cannot hide a writer behind another environment",async()=>{
    const o=await owning(),other=await sibling(o);await verifiedHold(o);await peer.query("update platform.operations set environment_id=$3 where workspace_id=$1 and id=$2",[o.f.op.workspaceId,other.id,`env_${randomUUID()}`]);await expect(recordGrant(o,other.id)).rejects.toThrow();
  });
  it("foreign workspace inventory never sees the owning held operation or its grants",async()=>{
    const o=await owning(),other=await sibling(o);await recordGrant(o,other.id);await blocked(o);
    const foreign=await cleanup.preview(observer,o.f.h.ids.wsB,o.f.op.projectId!,o.f.op.environmentId!);expect(foreign.grants).toBe(0);expect(foreign.handoffs).toBe(0);expect(foreign.reservations).toBe(0);
    await expect(cleanup.retain(peer,{workspaceId:o.f.h.ids.wsB,operationId:o.d.op.id})).rejects.toBeInstanceOf(cleanup.CleanupWriterBarrierError);
  });
  it("raw native dispatch without authenticated paired origin cannot use a seeded hold as approval",async()=>{
    const o=await owning();await artifacts.claim(db,o.d.access,"direct-untrusted-attempt");const proof=(await createExecutionBroker(db).approvalStatus(o.d.op.id)).dispatchApproval;
    expect(await isDefaultCurrentDispatchRequirement(proof,db,o.f.op.workspaceId,o.d.op.id)).toBe(true);
    await expect(artifacts.dispatch(db,o.d.access,"direct-untrusted-attempt",proof)).rejects.toBeInstanceOf(cleanup.CleanupWriterBarrierError);
    expect(await holdRows(o)).toEqual([]);
  });
  it("held epoch and possible-delivery records cannot be cleared by native UPDATE DELETE or TRUNCATE grants",async()=>{
    const o=await owning(),other=await sibling(o);await recordGrant(o,other.id);await blocked(o);
    await expect(peer.query("delete from platform.cleanup_writer_holds where workspace_id=$1",[o.f.op.workspaceId])).rejects.toThrow();
    await expect(peer.query("update platform.cleanup_writer_epoch set installed_at=clock_timestamp() where singleton")).rejects.toThrow();
    await expect(peer.query("delete from platform.cleanup_writer_deliveries where workspace_id=$1",[o.f.op.workspaceId])).rejects.toThrow();
    const roles=await peer.query<{allowed:boolean}>("select exists(select 1 from pg_roles where rolname='service_role') as allowed");if(!roles[0].allowed)throw new Error("Canonical service role prerequisite unavailable.");
    const rights=await peer.query<{insert:boolean;clear:boolean;rls:boolean}>("select has_table_privilege('service_role','platform.cleanup_writer_holds','INSERT') as insert,has_table_privilege('service_role','platform.cleanup_writer_holds','DELETE,TRUNCATE') as clear,(select relrowsecurity from pg_class where oid='platform.cleanup_writer_holds'::regclass) as rls");expect(rights).toEqual([{insert:true,clear:false,rls:true}]);
  });
  it("every native mutation writer family records possible delivery before any hold",async()=>{
    const o=await owning();
    for(const family of ["workflow","plan","build","runner","machine"] as const){const other=await sibling(o);await handoff(o,family,other.id,family==="runner"||family==="machine"?"running":"attempted");}
    expect(await peer.query("select family from platform.cleanup_writer_deliveries where workspace_id=$1 order by family",[o.f.op.workspaceId])).toEqual([
      {family:"build"},{family:"machine"},{family:"plan"},{family:"runner"},{family:"workflow"}]);
    await blocked(o);expect(await holdRows(o)).toHaveLength(1);
  });
  it("a held scope refuses a new native workflow handoff before possible delivery",async()=>{
    const o=await owning(),other=await sibling(o);await verifiedHold(o);
    await expect(handoff(o,"workflow",other.id,"attempted")).rejects.toThrow();
    expect(await peer.query("select identity from platform.cleanup_writer_deliveries where workspace_id=$1 and family=$2",[o.f.op.workspaceId,"workflow"])).toEqual([]);
  });
  it("a held scope refuses a new native plan handoff before possible delivery",async()=>{
    const o=await owning(),other=await sibling(o);await verifiedHold(o);
    await expect(handoff(o,"plan",other.id,"attempted")).rejects.toThrow();
    expect(await peer.query("select identity from platform.cleanup_writer_deliveries where workspace_id=$1 and family=$2",[o.f.op.workspaceId,"plan"])).toEqual([]);
  });
  it("a held scope refuses a new native build handoff before possible delivery",async()=>{
    const o=await owning(),other=await sibling(o);await verifiedHold(o);
    await expect(handoff(o,"build",other.id,"attempted")).rejects.toThrow();
    expect(await peer.query("select identity from platform.cleanup_writer_deliveries where workspace_id=$1 and family=$2",[o.f.op.workspaceId,"build"])).toEqual([]);
  });
  it("a held scope refuses a new native runner handoff before possible delivery",async()=>{
    const o=await owning(),other=await sibling(o);await verifiedHold(o);
    await expect(handoff(o,"runner",other.id,"running")).rejects.toThrow();
    expect(await peer.query("select identity from platform.cleanup_writer_deliveries where workspace_id=$1 and family=$2",[o.f.op.workspaceId,"runner"])).toEqual([]);
  });
  it("a held scope refuses a new native machine handoff before possible delivery",async()=>{
    const o=await owning(),other=await sibling(o);await verifiedHold(o);
    await expect(handoff(o,"machine",other.id,"running")).rejects.toThrow();
    expect(await peer.query("select identity from platform.cleanup_writer_deliveries where workspace_id=$1 and family=$2",[o.f.op.workspaceId,"machine"])).toEqual([]);
  });
  it("late workflow acknowledgement and build terminal receipts remain immutable history under a diagnostic hold",async()=>{
    const o=await owning(),workflow=await sibling(o),build=await sibling(o);
    await handoff(o,"workflow",workflow.id);await handoff(o,"build",build.id);
    // Diagnostic INSERT is not a codec origin. Its sole purpose is testing retained late-history writes.
    await peer.query("insert into platform.cleanup_writer_holds(workspace_id,project_id,environment_id,operation_id,attempt_id,generation,manifest_digest,authority_digest,holder,fence_token) values($1,$2,$3,$4,$5,$6,$7,$7,'diagnostic',1)",
      [o.f.op.workspaceId,o.f.op.projectId,o.f.op.environmentId,o.d.op.id,randomUUID(),randomUUID(),sha("diagnostic")]);
    const prior=await peer.query("select * from platform.cleanup_writer_deliveries where workspace_id=$1 order by family,identity",[o.f.op.workspaceId]);
    await peer.query("update platform.workflow_start_intents set phase='acknowledged',run_id=$3,observed_start_at=clock_timestamp(),evidence_digest=$4,acknowledged_at=clock_timestamp() where workspace_id=$1 and operation_id=$2",[o.f.op.workspaceId,workflow.id,randomUUID(),sha("late workflow")]);
    await peer.query("update platform.build_launches set phase='accepted',build_id=$3,request_ids='[\"diagnostic-request\"]'::jsonb,accepted_at=clock_timestamp() where workspace_id=$1 and operation_id=$2",[o.f.op.workspaceId,build.id,`diagnostic:${randomUUID()}`]);
    await peer.query("update platform.build_launches set phase='terminal',terminal_status='FAILED',provider_finished_at=clock_timestamp(),terminal_request_id='diagnostic-terminal',observed_at=clock_timestamp() where workspace_id=$1 and operation_id=$2",[o.f.op.workspaceId,build.id]);
    expect(await peer.query("select * from platform.cleanup_writer_deliveries where workspace_id=$1 order by family,identity",[o.f.op.workspaceId])).toEqual(prior);
    expect((await cleanup.preview(peer,o.f.op.workspaceId,o.f.op.projectId!,o.f.op.environmentId!)).handoffs).toBeGreaterThan(0);
    await expect(peer.query("delete from platform.workflow_start_intents where workspace_id=$1 and operation_id=$2",[o.f.op.workspaceId,workflow.id])).rejects.toThrow();
    await expect(peer.query("delete from platform.build_launches where workspace_id=$1 and operation_id=$2",[o.f.op.workspaceId,build.id])).rejects.toThrow();
    await expect(createExecutionBroker(db).issueGrant(o.d.op.id,"worker",o.d.access.lease,{capability:"infrastructure.destroy"})).rejects.toBeInstanceOf(cleanup.CleanupWriterBarrierError);
  });
  it("queued runner and machine work cannot cross into running after a native hold commits",async()=>{
    const o=await owning(),runner=await sibling(o),machine=await sibling(o),r=await handoff(o,"runner",runner.id,"queued"),m=await handoff(o,"machine",machine.id,"queued");await verifiedHold(o);
    await expect(peer.query("update platform.runner_jobs set status='running',started_at=clock_timestamp() where workspace_id=$1 and id=$2",[o.f.op.workspaceId,r.id])).rejects.toThrow();
    await expect(peer.query("update platform.machine_requests set status='running',started_at=clock_timestamp() where workspace_id=$1 and id=$2",[o.f.op.workspaceId,m.id])).rejects.toThrow();
    expect(await peer.query("select status from platform.runner_jobs where workspace_id=$1 and id=$2",[o.f.op.workspaceId,r.id])).toEqual([{status:"queued"}]);
    expect(await peer.query("select status from platform.machine_requests where workspace_id=$1 and id=$2",[o.f.op.workspaceId,m.id])).toEqual([{status:"queued"}]);
  });
  it("discarding an acknowledged hold result never authorizes a destructive grant; the next attempt supersedes its drained generation",async()=>{
    const o=await owning();await consume(o);const prior=await holdRows(o);
    // A completed native hold is deliberately discarded locally; actual network acknowledgement loss remains a root fault gate.
    // WP5: the completed attempt issued no grant and is no longer claimed, so its drained generation is superseded by the next attempt.
    const next=await consume(o);expect(next.entered).toBe(1);expect(await holdRows(o)).toHaveLength(prior.length+1);expect(await holdRows(o)).toEqual(expect.arrayContaining(prior));
    await expect(createExecutionBroker(db).issueGrant(o.d.op.id,"worker",o.d.access.lease,{capability:"infrastructure.destroy"})).rejects.toBeInstanceOf(cleanup.CleanupWriterBarrierError);
  });

  it("every cleanup authority table retains exact RLS and client denial without DELETE TRUNCATE or TRIGGER rights",async()=>{
    const o=await owning();await verifiedHold(o);
    const tables=["cleanup_writer_epoch","cleanup_writer_scopes","cleanup_writer_holds","cleanup_writer_deliveries","cleanup_owner_grants"] as const;
    for(const table of tables){
      const rows=await peer.query<{rls:boolean;client:boolean;serviceClear:boolean}>("select (select relrowsecurity from pg_class where oid=$1::regclass) as rls,has_table_privilege('anon',$1,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') or has_table_privilege('authenticated',$1,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') as client,has_table_privilege('service_role',$1,'DELETE,TRUNCATE,REFERENCES,TRIGGER') as \"serviceClear\"",[`platform.${table}`]);
      expect(rows).toEqual([{rls:true,client:false,serviceClear:false}]);
    }
    await peer.tx(async tx=>{await tx.query("set local role service_role");await expect(tx.query("select operation_id from platform.cleanup_writer_holds where workspace_id=$1",[o.f.op.workspaceId])).resolves.toHaveLength(1);});
    await expect(peer.tx(async tx=>{await tx.query("set local role service_role");await tx.query("delete from platform.cleanup_writer_holds where workspace_id=$1",[o.f.op.workspaceId]);})).rejects.toThrow();
    await expect(peer.tx(async tx=>{await tx.query("set local role service_role");await tx.query("truncate platform.cleanup_writer_holds");})).rejects.toThrow();
  });
  it("a workspace foreign key mismatch never reaches any possible-delivery ledger",async()=>{
    const o=await owning(),other=await sibling(o);await verifiedHold(o);
    await expect(repos.grants.insert(peer,{jti:randomUUID(),workspaceId:o.f.h.ids.wsB,operationId:other.id,capability:"infrastructure.apply",audience:"worker",issuedAt:new Date().toISOString(),expiresAt:new Date(Date.now()+60000).toISOString()})).rejects.toThrow();
    expect(await peer.query("select identity from platform.cleanup_writer_deliveries where workspace_id=$1",[o.f.h.ids.wsB])).toEqual([]);
  });

  it("current consumed human approver demotion during the real coordinator wait refuses hold insertion",async()=>{
    const o=await owning();await peer.query("insert into platform.cleanup_writer_scopes(workspace_id) values($1) on conflict do nothing",[o.f.op.workspaceId]);const entered=barrier(),release=barrier();
    const holding=peer.tx(async tx=>{await tx.query("select workspace_id from platform.cleanup_writer_scopes where workspace_id=$1 for update",[o.f.op.workspaceId]);entered.release();await release.promise;});
    await entered.promise;const pid=(await db.query<{pid:number}>("select pg_backend_pid() as pid"))[0].pid;const pending=consume(o);
    try{await waitForBackend(pid);await observer.query("update public.members set role='viewer' where workspace_id=$1 and id='erin'",[o.f.op.workspaceId]);}finally{release.release();}await holding;
    expect((await pending).entered).toBe(0);expect(await holdRows(o)).toEqual([]);
    expect(await peer.query("select jti from platform.cleanup_owner_grants where workspace_id=$1",[o.f.op.workspaceId])).toEqual([]);
  });
  it("a current human rejection committed during the actual coordinator wait refuses hold insertion",async()=>{
    const o=await owning();await peer.query("insert into platform.cleanup_writer_scopes(workspace_id) values($1) on conflict do nothing",[o.f.op.workspaceId]);const entered=barrier(),release=barrier();
    const holding=peer.tx(async tx=>{await tx.query("select workspace_id from platform.cleanup_writer_scopes where workspace_id=$1 for update",[o.f.op.workspaceId]);entered.release();await release.promise;});
    await entered.promise;const pid=(await db.query<{pid:number}>("select pg_backend_pid() as pid"))[0].pid;const pending=consume(o);
    try{await waitForBackend(pid);await observer.query("update platform.approvals set decision='reject' where workspace_id=$1 and operation_id=$2",[o.f.op.workspaceId,o.d.op.id]);}finally{release.release();}await holding;
    expect((await pending).entered).toBe(0);expect(await holdRows(o)).toEqual([]);
  });
  it("expiration during the actual coordinator wait refuses the still-owned fence and hold",async()=>{
    const o=await owning();await peer.query("update platform.leases set expires_at=clock_timestamp()+interval '2 seconds' where workspace_id=$1 and scope=$2",[o.f.op.workspaceId,o.d.access.lease.scope]);
    await peer.query("insert into platform.cleanup_writer_scopes(workspace_id) values($1) on conflict do nothing",[o.f.op.workspaceId]);const entered=barrier(),release=barrier();
    const holding=peer.tx(async tx=>{await tx.query("select workspace_id from platform.cleanup_writer_scopes where workspace_id=$1 for update",[o.f.op.workspaceId]);entered.release();await release.promise;});
    await entered.promise;const pid=(await db.query<{pid:number}>("select pg_backend_pid() as pid"))[0].pid;const pending=consume(o);
    try{await waitForBackend(pid);await observer.query("select pg_sleep(2.1)");}finally{release.release();}await holding;
    expect((await pending).entered).toBe(0);expect(await holdRows(o)).toEqual([]);
  });

  it("requester demotion during the final native grant inventory wait refuses the bearer and retains its JTI",async()=>{
    const o=await owning(),outcome=await finalInventoryWait(o,"grant",async()=>{await observer.query("update public.members set role='viewer' where workspace_id=$1 and id='alice'",[o.f.op.workspaceId]);});
    expect(outcome.returned).toBe(0);expect(outcome.result.error).toBeInstanceOf(cleanup.CleanupWriterBarrierError);
  });
  it("consumed approver demotion during the final native grant inventory wait refuses the bearer and retains its JTI",async()=>{
    const o=await owning(),outcome=await finalInventoryWait(o,"grant",async()=>{await observer.query("update public.members set role='editor' where workspace_id=$1 and id='erin'",[o.f.op.workspaceId]);});
    expect(outcome.returned).toBe(0);expect(outcome.result.error).toBeInstanceOf(cleanup.CleanupWriterBarrierError);
  });
  it("native source connection revocation during the final grant inventory wait refuses the bearer and retains its JTI",async()=>{
    const o=await owning(),outcome=await finalInventoryWait(o,"grant",async()=>{await connections.revoke(observer,o.f.op.workspaceId,o.f.nativeId);});
    expect(outcome.returned).toBe(0);expect(outcome.result.error).toBeInstanceOf(cleanup.CleanupWriterBarrierError);
  });
  it("reviewed revision source replacement during the final grant inventory wait refuses the bearer and retains its JTI",async()=>{
    const o=await owning(),outcome=await finalInventoryWait(o,"grant",async()=>{await observer.query("update public.revision_manifests set manifest=jsonb_set(manifest,'{services,0,source,ref}','\"unreviewed-replacement\"'::jsonb) where workspace_id=$1 and revision_id=$2",[o.f.op.workspaceId,o.f.revisionId]);});
    expect(outcome.returned).toBe(0);expect(outcome.result.error).toBeInstanceOf(cleanup.CleanupWriterBarrierError);
  });
  it("current target replacement during the final grant inventory wait refuses the bearer and retains its JTI",async()=>{
    const o=await owning(),outcome=await finalInventoryWait(o,"grant",async()=>{await observer.query("update public.environments set connection_id=$3 where workspace_id=$1 and id=$2",[o.f.op.workspaceId,o.f.op.environmentId,`foreign_${randomUUID()}`]);});
    expect(outcome.returned).toBe(0);expect(outcome.result.error).toBeInstanceOf(cleanup.CleanupWriterBarrierError);
  });
  it("lease expiry during the final grant inventory wait refuses the bearer and retains its JTI",async()=>{
    const o=await owning(),outcome=await finalInventoryWait(o,"grant",async()=>{await observer.query("select pg_sleep(5.1)");},true);
    expect(outcome.returned).toBe(0);expect(outcome.result.error).toBeInstanceOf(cleanup.CleanupWriterBarrierError);
  });
  it("unchanged current authority after the final native grant inventory wait returns exactly its one retained JTI",async()=>{
    const o=await owning(),outcome=await finalInventoryWait(o,"grant",async()=>{});
    expect(outcome.returned).toBe(1);expect(outcome.result.error).toBe(stop);
  });
  it("requester demotion during final native reservation inventory refuses before signing and preserves the hold",async()=>{
    const o=await owning(),outcome=await finalInventoryWait(o,"reservation",async()=>{await observer.query("update public.members set role='viewer' where workspace_id=$1 and id='alice'",[o.f.op.workspaceId]);});
    expect(outcome.returned).toBe(0);expect(outcome.result.error).toBeInstanceOf(cleanup.CleanupWriterBarrierError);
  });
  it("consumed approver demotion during final native reservation inventory refuses before signing and preserves the hold",async()=>{
    const o=await owning(),outcome=await finalInventoryWait(o,"reservation",async()=>{await observer.query("update public.members set role='editor' where workspace_id=$1 and id='erin'",[o.f.op.workspaceId]);});
    expect(outcome.returned).toBe(0);expect(outcome.result.error).toBeInstanceOf(cleanup.CleanupWriterBarrierError);
  });

  // These additive cases execute the actual pinned builtin tool; REST and policy remain the models above.
  async function standalone(){const scope=await standaloneProductScope(db);standaloneScopes.push(scope);state.snapshot=scope.snapshot;const original=await reviewedStandalonePlan(db,scope);return {scope,original};}
  async function releaseOriginal(s:Awaited<ReturnType<typeof standalone>>){await repos.operations.transition(db,{workspaceId:s.scope.workspaceId,id:s.original.op.id,from:["running"],to:"succeeded",fence:s.original.lease});await repos.leases.release(db,s.original.lease);}
  async function continuation(s:Awaited<ReturnType<typeof standalone>>,key=s.scope.key){
    const source=await reviewedStandalonePlan(db,s.scope,true),destination=await associatedStandaloneDestroy(db,s.scope,source);
    source.saved.runtime=createPlanArtifactRuntime(db,{...process.env,ZENITH_PLAN_ARTIFACT_KEY:key,ZENITH_WORKER_PLAN_DIR:s.scope.root,
      ...(key!==s.scope.key?{ZENITH_PLAN_ARTIFACT_PREVIOUS_KEYS:JSON.stringify([s.scope.key])}:{})});return {source,destination};
  }
  const settled=(s:Awaited<ReturnType<typeof standalone>>)=>artifacts.readStandaloneSettlements(db,s.original.access.custody,s.original.saved.row.manifest.backendDigest);
  it("real original builtin apply retains one authenticated immutable settlement and refuses replay",async()=>{
    const s=await standalone(),result=await consumeSavedNativePlan(db,s.original.saved,s.original.access);
    expect(result.result.apply.exitCode).toBe(0);expect(result.originalSha).toBe(s.original.saved.row.manifest.rawSha256);
    const rows=await settled(s);expect(rows).toHaveLength(1);expect(rows[0].receipt.binding.rawSha256).toBe(s.original.saved.row.manifest.rawSha256);
    expect(rows[0].receipt.binding.manifestDigest).toBe(s.original.saved.row.manifest_digest);
    expect(rows[0].receipt.sealed.ciphertext).not.toContain(s.scope.root);expect(rows[0].receipt).not.toHaveProperty("targetPath");
    await expect(observer.query("update platform.standalone_plan_settlements set settlement_digest=$3 where workspace_id=$1 and operation_id=$2",[s.scope.workspaceId,s.original.op.id,digest("altered")])).rejects.toThrow();
    await expect(consumeSavedNativePlan(db,s.original.saved,s.original.access)).rejects.toThrow();
  },300000);
  it("new default paired codec reconciles only completed builtin plan history before exact same-scope destroy",async()=>{
    const s=await standalone();await consumeSavedNativePlan(db,s.original.saved,s.original.access);await releaseOriginal(s);
    const next=await continuation(s),result=await consumeSavedNativePlan(db,next.source.saved,next.destination.access);
    expect(result.result.apply.exitCode).toBe(0);expect(result.result.plan.summary.delete).toBe(1);expect(result.originalSha).toBe(next.source.saved.row.manifest.rawSha256);
    expect(JSON.parse(await readFile(path.join(s.scope.root,"terraform.tfstate"),"utf8")).resources).toHaveLength(0);
    expect(await observer.query("select count(*)::integer as n from platform.standalone_plan_settlements where workspace_id=$1",[s.scope.workspaceId])).toEqual([{n:2}]);
  },300000);
  it("lost completion acknowledgement stays unconfirmed while independently retained proof permits a newly approved destroy",async()=>{
    const s=await standalone(),finish=artifacts.finishStandalone;
    const spy=vi.spyOn(artifacts,"finishStandalone").mockImplementationOnce(async(...args)=>{await finish(...args);throw new Error("Modeled native completion acknowledgement lost.");});
    try{await expect(consumeSavedNativePlan(db,s.original.saved,s.original.access)).rejects.toThrow("unconfirmed");}finally{spy.mockRestore();}
    expect(await settled(s)).toHaveLength(1);await expect(consumeSavedNativePlan(db,s.original.saved,s.original.access)).rejects.toThrow();await releaseOriginal(s);
    const next=await continuation(s);expect((await consumeSavedNativePlan(db,next.source.saved,next.destination.access)).result.apply.exitCode).toBe(0);
  },300000);
  it("accepted builtin apply without a committed settlement remains uncertain and blocks later destroy",async()=>{
    const s=await standalone(),spy=vi.spyOn(artifacts,"finishStandalone").mockImplementationOnce(async()=>{throw new Error("Modeled native completion unavailable before commit.");});
    try{await expect(consumeSavedNativePlan(db,s.original.saved,s.original.access)).rejects.toThrow("unconfirmed");}finally{spy.mockRestore();}
    expect(await settled(s)).toHaveLength(0);expect(await observer.query("select phase from platform.plan_artifact_uses where workspace_id=$1 and operation_id=$2",[s.scope.workspaceId,s.original.op.id])).toEqual([{phase:"uncertain"}]);
    await expect(consumeSavedNativePlan(db,s.original.saved,s.original.access)).rejects.toThrow();await releaseOriginal(s);
    const next=await continuation(s);await expect(consumeSavedNativePlan(db,next.source.saved,next.destination.access)).rejects.toThrow();
    expect(JSON.parse(await readFile(path.join(s.scope.root,"terraform.tfstate"),"utf8")).resources).toHaveLength(1);
  },300000);
  it("status-only terminal use and invented SQL settlement never remove unresolved plan history",async()=>{
    const s=await standalone(),spy=vi.spyOn(artifacts,"finishStandalone").mockImplementationOnce(async()=>{throw new Error("Modeled receipt write unavailable.");});
    try{await expect(consumeSavedNativePlan(db,s.original.saved,s.original.access)).rejects.toThrow();}finally{spy.mockRestore();}
    await observer.query("update platform.plan_artifact_uses set phase='succeeded' where workspace_id=$1 and operation_id=$2",[s.scope.workspaceId,s.original.op.id]);
    await observer.query(`insert into platform.standalone_plan_settlements(workspace_id,project_id,environment_id,operation_id,attempt_id,manifest_digest,raw_sha256,backend_digest,target_digest,holder,fence_token,settlement_digest,iv,auth_tag,ciphertext)
      select u.workspace_id,backend.project_id,backend.environment_id,u.operation_id,u.attempt_id,artifact.manifest_digest,artifact.manifest->>'rawSha256',backend.backend_digest,backend.target_digest,u.holder,u.fence_token,$3,$4,$5,$6
      from platform.plan_artifact_uses u join platform.plan_artifacts artifact on artifact.workspace_id=u.workspace_id and artifact.operation_id=u.operation_id
      join platform.standalone_plan_backends backend on backend.workspace_id=u.workspace_id and backend.backend_digest=artifact.manifest->>'backendDigest'
      where u.workspace_id=$1 and u.operation_id=$2 and u.phase='succeeded' returning operation_id`,
      [s.scope.workspaceId,s.original.op.id,digest("invented native completion"),randomBytes(12).toString("base64"),randomBytes(16).toString("base64"),Buffer.from("invented ciphertext").toString("base64")]);
    expect(await settled(s)).toHaveLength(1);const before=await readFile(path.join(s.scope.root,"terraform.tfstate"));
    await releaseOriginal(s);const next=await continuation(s);await expect(consumeSavedNativePlan(db,next.source.saved,next.destination.access)).rejects.toThrow();
    expect(await settled(s)).toHaveLength(1);expect(await readFile(path.join(s.scope.root,"terraform.tfstate"))).toEqual(before);
  },300000);
  it.each(["workspaceId","projectId","environmentId","operationId","attemptId","manifestDigest","rawSha256","backendDigest","targetDigest","holder","fenceToken"] as const)("authenticated settlement refuses copied %s tuple",async field=>{
    const s=await standalone();await consumeSavedNativePlan(db,s.original.saved,s.original.access);const rows=await settled(s);expect(rows).toHaveLength(1);
    const engine=createPlanEngineAuthority(planArtifactCipherFromEnv({ZENITH_PLAN_ARTIFACT_KEY:s.scope.key}),()=>undefined,{...process.env});
    const binding={...rows[0].receipt.binding,[field]:field==="fenceToken"?rows[0].receipt.binding.fenceToken+1:`foreign-${rows[0].receipt.binding[field]}`};
    await expect(engine.authenticateStandaloneSettlement({...rows[0].receipt,binding},rows[0].artifact.manifest)).rejects.toThrow();
  },300000);
  it("corrupt settlement ciphertext and wrong purpose-separated key refuse independently",async()=>{
    const s=await standalone();await consumeSavedNativePlan(db,s.original.saved,s.original.access);const [row]=await settled(s);expect(row).toBeDefined();
    const engine=createPlanEngineAuthority(planArtifactCipherFromEnv({ZENITH_PLAN_ARTIFACT_KEY:s.scope.key}),()=>undefined,{...process.env});
    await expect(engine.authenticateStandaloneSettlement({...row.receipt,sealed:{...row.receipt.sealed,ciphertext:Buffer.from("corrupt").toString("base64")}},row.artifact.manifest)).rejects.toThrow();
    await expect(engine.authenticateStandaloneSettlement({...row.receipt,sealed:{iv:row.artifact.iv,authTag:row.artifact.auth_tag,ciphertext:row.artifact.ciphertext}},row.artifact.manifest)).rejects.toThrow();
    const wrong=createPlanEngineAuthority(planArtifactCipherFromEnv({ZENITH_PLAN_ARTIFACT_KEY:randomBytes(32).toString("hex")}),()=>undefined,{...process.env});
    await expect(wrong.authenticateStandaloneSettlement(row.receipt,row.artifact.manifest)).rejects.toThrow();
  },300000);
  it("fresh engine accepts retained old settlement key only during explicit overlap and refuses retirement",async()=>{
    const s=await standalone();await consumeSavedNativePlan(db,s.original.saved,s.original.access);const [row]=await settled(s),next=randomBytes(32).toString("hex");
    const overlap=createPlanEngineAuthority(planArtifactCipherFromEnv({ZENITH_PLAN_ARTIFACT_KEY:next,ZENITH_PLAN_ARTIFACT_PREVIOUS_KEYS:JSON.stringify([s.scope.key])}),()=>undefined,{...process.env});
    await expect(overlap.authenticateStandaloneSettlement(row.receipt,row.artifact.manifest)).resolves.toBeUndefined();
    const retired=createPlanEngineAuthority(planArtifactCipherFromEnv({ZENITH_PLAN_ARTIFACT_KEY:next}),()=>undefined,{...process.env});
    await expect(retired.authenticateStandaloneSettlement(row.receipt,row.artifact.manifest)).rejects.toThrow();
    await releaseOriginal(s);const nextPlan=await continuation(s,next);expect((await consumeSavedNativePlan(db,nextPlan.source.saved,nextPlan.destination.access)).result.apply.exitCode).toBe(0);
  },300000);
  it("current completion readback refuses changed state while immutable earlier settlement remains historical",async()=>{
    const s=await standalone();await consumeSavedNativePlan(db,s.original.saved,s.original.access);const [row]=await settled(s);
    const file=path.join(s.scope.root,"terraform.tfstate"),bytes=await readFile(file),value=JSON.parse(bytes.toString());value.serial+=1;await writeFile(file,JSON.stringify(value),{mode:0o600});
    const engine=createPlanEngineAuthority(planArtifactCipherFromEnv({ZENITH_PLAN_ARTIFACT_KEY:s.scope.key}),()=>undefined,{...process.env});
    await expect(engine.authenticateCurrentStandaloneCompletion(row.receipt,row.artifact.manifest)).rejects.toThrow();
    await expect(engine.authenticateStandaloneSettlement(row.receipt,row.artifact.manifest)).resolves.toBeUndefined();await writeFile(file,bytes,{mode:0o600});
  },300000);
  it("different logical product scopes cannot bind the same actual local backend",async()=>{
    const first=await standalone();await consumeSavedNativePlan(db,first.original.saved,first.original.access);await releaseOriginal(first);
    const second=await standaloneProductScope(db);standaloneScopes.push(second);state.snapshot=second.snapshot;
    second.workspace={...first.scope.workspace};second.root=first.scope.root;
    const original=await reviewedStandalonePlan(db,second);await expect(consumeSavedNativePlan(db,original.saved,original.access)).rejects.toThrow("unconfirmed");
    expect(await observer.query("select workspace_id from platform.standalone_plan_backends where target_digest=(select target_digest from platform.standalone_plan_settlements where workspace_id=$1 limit 1)",[first.scope.workspaceId])).toEqual([{workspace_id:first.scope.workspaceId}]);
    expect(await observer.query("select count(*)::integer as n from platform.standalone_plan_settlements where workspace_id=$1",[second.workspaceId])).toEqual([{n:0}]);
  },300000);
  it("mutable nonsticky grandparent refuses standalone admission before tool execution",async()=>{
    const scope=await standaloneProductScope(db);standaloneScopes.push(scope);state.snapshot=scope.snapshot;
    const grand=path.join(scope.root,"mutable"),leaf=path.join(grand,"protected");await mkdir(leaf,{recursive:true,mode:0o700});await chmod(grand,0o700);await chmod(leaf,0o700);
    const files=scope.workspace.files.map(file=>file.path==="backend.tf.json"?{...file,content:JSON.stringify({terraform:{backend:{local:{path:path.join(leaf,"terraform.tfstate")}}}})}:file);
    scope.workspace={...scope.workspace,files,configDigest:configDigestOf(files)};
    const original=await reviewedStandalonePlan(db,scope);await chmod(grand,0o777);let beforeDispatch=0;
    try{await expect(original.saved.runtime.planArtifacts.consume(original.access,approved=>original.saved.runtime.tofu.applyVerifiedPlan(original.saved.workspace,{original:approved,custody:original.access.custody,approvedDigest:original.access.planDigest,beforeDispatch:async()=>{beforeDispatch++;}}))).rejects.toThrow();}
    finally{await chmod(grand,0o700);}
    expect(beforeDispatch).toBe(0);expect(await readFile(path.join(leaf,"terraform.tfstate")).catch(()=>null)).toBeNull();
    expect(await observer.query("select phase from platform.plan_artifact_uses where workspace_id=$1 and operation_id=$2",[scope.workspaceId,original.op.id])).toEqual([{phase:"ready"}]);
    expect(await observer.query("select count(*)::integer as n from platform.standalone_plan_settlements where workspace_id=$1",[scope.workspaceId])).toEqual([{n:0}]);
  },300000);
  it("fabricated readback with restored prototypes and genuine cleanup cannot mint settlement",async()=>{
    const s=await standalone(),runnerDescriptor=Object.getOwnPropertyDescriptor(TofuRunner.prototype,"run")!,planDescriptor=Object.getOwnPropertyDescriptor(TofuRun.prototype,"plan")!;
    const actual=TofuRunner.prototype.run;let fabricated=0;
    Object.defineProperty(TofuRunner.prototype,"run",{...runnerDescriptor,value:async function(this:TofuRunner,...args:Parameters<TofuRunner["run"]>){
      Object.defineProperty(TofuRunner.prototype,"run",runnerDescriptor);const result=await actual.apply(this,args);
      Object.defineProperty(TofuRun.prototype,"plan",{...planDescriptor,value:async()=>{fabricated++;Object.defineProperty(TofuRun.prototype,"plan",planDescriptor);return {hasChanges:false,exitCode:0};}});return result;
    }});
    try{await expect(consumeSavedNativePlan(db,s.original.saved,s.original.access)).rejects.toThrow("unconfirmed");}
    finally{Object.defineProperty(TofuRunner.prototype,"run",runnerDescriptor);Object.defineProperty(TofuRun.prototype,"plan",planDescriptor);}
    expect(fabricated).toBe(0);expect(JSON.parse(await readFile(path.join(s.scope.root,"terraform.tfstate"),"utf8")).resources).toHaveLength(1);
    expect(await observer.query("select count(*)::integer as n from platform.standalone_plan_settlements where workspace_id=$1",[s.scope.workspaceId])).toEqual([{n:0}]);
  },300000);
  it("incomplete actual checked cleanup cannot mint settlement or replay accepted apply",async()=>{
    const s=await standalone(),descriptor=Object.getOwnPropertyDescriptor(TofuRunner.prototype,"run")!,actual=TofuRunner.prototype.run;let omitted=0;
    Object.defineProperty(TofuRunner.prototype,"run",{...descriptor,value:async function(this:TofuRunner,workspace:Parameters<TofuRunner["run"]>[0],context:Parameters<TofuRunner["run"]>[1],body:Parameters<TofuRunner["run"]>[2]){
      Object.defineProperty(TofuRunner.prototype,"run",descriptor);return actual.call(this,workspace,context,async run=>{const result=await body(run);Object.defineProperty(run,"dispose",{value:async()=>{omitted++;},configurable:true});return result;});
    }});
    try{await expect(consumeSavedNativePlan(db,s.original.saved,s.original.access)).rejects.toThrow("unconfirmed");}finally{Object.defineProperty(TofuRunner.prototype,"run",descriptor);}
    expect(omitted).toBe(0);expect(JSON.parse(await readFile(path.join(s.scope.root,"terraform.tfstate"),"utf8")).resources).toHaveLength(1);
    expect(await observer.query("select count(*)::integer as n from platform.standalone_plan_settlements where workspace_id=$1",[s.scope.workspaceId])).toEqual([{n:0}]);
    await expect(consumeSavedNativePlan(db,s.original.saved,s.original.access)).rejects.toThrow();
  },300000);
  it("prior issued grant remains unresolved despite builtin settlement",async()=>{
    for(const history of ["current","restored legacy"] as const){
      const s=await standalone();await consumeSavedNativePlan(db,s.original.saved,s.original.access);
      expect(await repos.operations.get(peer,s.scope.workspaceId,s.original.op.id)).toMatchObject({capability:"deployment.deploy",status:"running"});
      const grant={jti:randomUUID(),workspaceId:s.scope.workspaceId,operationId:s.original.op.id,capability:history==="current"?"deployment.deploy":"infrastructure.apply",audience:"worker",issuedAt:new Date().toISOString(),expiresAt:new Date(Date.now()+60000).toISOString()};
      if(history==="current"){
        expect(await repos.grants.insert(peer,grant)).toMatchObject({jti:grant.jti,capability:"deployment.deploy"});
      }else{
        await expect(repos.grants.insert(peer,grant)).rejects.toMatchObject({code:"conflict",details:{reason:"field_ownership_conflict"}});
        expect(await observer.query("select jti from platform.capability_grants where workspace_id=$1 and operation_id=$2",[s.scope.workspaceId,s.original.op.id])).toEqual([]);
        // Historical ledger restoration only: no signer, bearer or current admission authority is fabricated.
        // The actual scoped SQL handle and canonical table constraints/triggers remain in force.
        await peer.query("insert into platform.capability_grants(jti,workspace_id,operation_id,capability,audience,issued_at,expires_at) values($1,$2,$3,$4,$5,$6::timestamptz,$7::timestamptz)",[grant.jti,grant.workspaceId,grant.operationId,grant.capability,grant.audience,grant.issuedAt,grant.expiresAt]);
      }
      expect(await observer.query("select capability from platform.capability_grants where workspace_id=$1 and jti=$2",[s.scope.workspaceId,grant.jti])).toEqual([{capability:grant.capability}]);
      await releaseOriginal(s);
      const next=await continuation(s);await expect(consumeSavedNativePlan(db,next.source.saved,next.destination.access)).rejects.toThrow();
      expect(await observer.query("select count(*)::integer as n from platform.cleanup_writer_holds where workspace_id=$1",[s.scope.workspaceId])).toEqual([{n:1}]);
      expect(JSON.parse(await readFile(path.join(s.scope.root,"terraform.tfstate"),"utf8")).resources).toHaveLength(1);
    }
  },300000);

  it.each(["requester demotion","approver removal","approval expiry","provider revocation","unchanged current authority"] as const)("final builtin receipt fences %s during post-readback current-role wait",async change=>{
    const s=await standalone(),entered=barrier(),resumed=barrier(),member=state.member;let inspections=0;
    const pending=s.original.saved.runtime.planArtifacts.consume(s.original.access,original=>s.original.saved.runtime.tofu.applyVerifiedPlan(s.original.saved.workspace,{
      original,custody:s.original.access.custody,approvedDigest:s.original.access.planDigest,normalize:{fingerprintKey:s.original.saved.fingerprint},inspectPlan:async()=>{
        inspections++;if(inspections===3)state.member=async(ws,id)=>{const data=await member(ws,id);if(id==="erin"){entered.release();await resumed.promise;}return data;};
      }})).then(value=>({value,error:undefined}),error=>({value:undefined,error}));
    try{
      await Promise.race([entered.promise,pending.then(()=>{throw new Error("The actual post-readback role wait was not reached.");})]);
      expect(inspections).toBe(3);expect((await readdir(s.scope.root)).filter(name=>name.startsWith("zenith-tofu-run-"))).toHaveLength(0);expect(JSON.parse(await readFile(path.join(s.scope.root,"terraform.tfstate"),"utf8")).resources).toHaveLength(1);
      if(change==="requester demotion")await observer.query("update public.members set role='viewer' where workspace_id=$1 and id='planner'",[s.scope.workspaceId]);
      if(change==="approver removal")await observer.query("delete from public.members where workspace_id=$1 and id='erin'",[s.scope.workspaceId]);
      if(change==="approval expiry")await observer.query("update platform.approvals set expires_at=clock_timestamp()-interval '1 second' where workspace_id=$1 and operation_id=$2",[s.scope.workspaceId,s.original.op.id]);
      if(change==="provider revocation")await repos.connections.revoke(observer,s.scope.workspaceId,s.scope.nativeId);
    }finally{state.member=member;resumed.release();}
    const result=await pending,allowed=change==="unchanged current authority";if(allowed)expect(result.error).toBeUndefined();else expect(result.error).toMatchObject({message:"Original plan dispatch outcome is unconfirmed; inspect this operation before another write."});
    expect(await observer.query("select count(*)::integer as n from platform.standalone_plan_settlements where workspace_id=$1",[s.scope.workspaceId])).toEqual([{n:allowed?1:0}]);
    expect(await observer.query("select phase from platform.plan_artifact_uses where workspace_id=$1 and operation_id=$2",[s.scope.workspaceId,s.original.op.id])).toEqual([{phase:allowed?"succeeded":"uncertain"}]);
    await expect(consumeSavedNativePlan(db,s.original.saved,s.original.access)).rejects.toThrow();
  },300000);
  it("foreign provider resources in protected local state refuse before standalone tool admission",async()=>{
    const s=await standalone();await consumeSavedNativePlan(db,s.original.saved,s.original.access);await releaseOriginal(s);
    const next=await reviewedStandalonePlan(db,s.scope),file=path.join(s.scope.root,"terraform.tfstate"),bytes=await readFile(file),value=JSON.parse(bytes.toString());
    value.resources[0].provider='provider["registry.opentofu.org/hashicorp/aws"]';await writeFile(file,JSON.stringify(value),{mode:0o600});let admitted=0;
    try{await expect(next.saved.runtime.tofu.planWorkspace(next.saved.workspace,undefined,{custody:next.access.custody})).rejects.toThrow("settlement");await expect(next.saved.runtime.planArtifacts.consume(next.access,original=>next.saved.runtime.tofu.applyVerifiedPlan(next.saved.workspace,{original,custody:next.access.custody,approvedDigest:next.access.planDigest,beforeDispatch:async()=>{admitted++;}}))).rejects.toThrow();}
    finally{await writeFile(file,bytes,{mode:0o600});}
    expect(admitted).toBe(0);expect(await observer.query("select count(*)::integer as n from platform.standalone_plan_settlements where workspace_id=$1 and operation_id=$2",[s.scope.workspaceId,next.op.id])).toEqual([{n:0}]);
  },300000);

  it.each(["region replacement","approver demotion","lease expiry","state replacement","unchanged final tuple"] as const)("observed native completion coordinator wait fences %s before terminal receipt insert",async change=>{
    const s=await standalone(),entered=barrier(),release=barrier(),actual=artifacts.finishStandalone;
    const ownerPid=(await db.query<{pid:number}>("select pg_backend_pid() as pid"))[0].pid;let blockerPid=0,holding:Promise<void>|undefined;
    const spy=vi.spyOn(artifacts,"finishStandalone").mockImplementationOnce(async(...args)=>{
      if(change==="lease expiry")await observer.query("update platform.leases set expires_at=clock_timestamp()+interval '5 seconds' where workspace_id=$1 and scope=$2",[s.scope.workspaceId,s.original.lease.scope]);
      holding=peer.tx(async tx=>{blockerPid=(await tx.query<{pid:number}>("select pg_backend_pid() as pid"))[0].pid;
        await tx.query("select workspace_id from platform.cleanup_writer_scopes where workspace_id=$1 for update",[s.scope.workspaceId]);entered.release();await release.promise;});
      await entered.promise;return actual(...args);
    });
    const pending=consumeSavedNativePlan(db,s.original.saved,s.original.access).then(value=>({value,error:undefined}),error=>({value:undefined,error}));
    try{
      await Promise.race([entered.promise,pending.then(()=>{throw new Error("Actual completion coordinator boundary was not reached.");})]);
      let observed=false;const deadline=Date.now()+10000;
      while(Date.now()<deadline){const row=(await observer.query<{waiting:boolean}>("select exists(select 1 from pg_stat_activity where pid=$1 and wait_event_type='Lock' and $2=any(pg_blocking_pids(pid))) as waiting",[ownerPid,blockerPid]))[0];if(row?.waiting){observed=true;break;}await new Promise(resolve=>setTimeout(resolve,10));}
      expect(observed).toBe(true);
      if(change==="region replacement")await observer.query("update public.environments set data=jsonb_set(data,'{region}',to_jsonb('eu-west-1'::text)) where id=$1",[s.scope.environmentId]);
      if(change==="approver demotion")await observer.query("update public.members set role='editor' where workspace_id=$1 and id='erin'",[s.scope.workspaceId]);
      if(change==="lease expiry"){let expired=false;const cutoff=Date.now()+8000;while(Date.now()<cutoff){expired=(await observer.query<{expired:boolean}>("select expires_at<=clock_timestamp() as expired from platform.leases where workspace_id=$1 and scope=$2",[s.scope.workspaceId,s.original.lease.scope]))[0]?.expired===true;if(expired)break;await new Promise(resolve=>setTimeout(resolve,10));}expect(expired).toBe(true);}
      if(change==="state replacement"){const file=path.join(s.scope.root,"terraform.tfstate"),value=JSON.parse(await readFile(file,"utf8"));value.serial+=1;await writeFile(file,JSON.stringify(value),{mode:0o600});}
    }finally{release.release();await holding?.catch(()=>undefined);spy.mockRestore();}
    const result=await pending,allowed=change==="unchanged final tuple";if(allowed)expect(result.error).toBeUndefined();else expect(result.error).toMatchObject({message:"Original plan dispatch outcome is unconfirmed; inspect this operation before another write."});
    expect(await observer.query("select count(*)::integer as n from platform.standalone_plan_settlements where workspace_id=$1",[s.scope.workspaceId])).toEqual([{n:allowed?1:0}]);
    expect(await observer.query("select phase from platform.plan_artifact_uses where workspace_id=$1 and operation_id=$2",[s.scope.workspaceId,s.original.op.id])).toEqual([{phase:allowed?"succeeded":"uncertain"}]);
    await expect(consumeSavedNativePlan(db,s.original.saved,s.original.access)).rejects.toThrow();
  },300000);

  it("structural fake producer run cannot seal chosen bytes as a finite builtin original",async()=>{
    const s=await standalone(),bytes=Buffer.from("invented executable original"),descriptor=Object.getOwnPropertyDescriptor(TofuRunner.prototype,"run")!;let fakeInit=0;
    const fake=Object.create(TofuRun.prototype);for(const [name,value] of Object.entries({init:async()=>{fakeInit++;},plan:async()=>({hasChanges:true}),planFileSha:async()=>createHash("sha256").update(bytes).digest("hex"),readPlanFile:async()=>Buffer.from(bytes),normalizedPlan:async()=>s.original.saved.plan}))Object.defineProperty(fake,name,{value});
    Object.defineProperty(TofuRunner.prototype,"run",{...descriptor,value:async(_workspace:Parameters<TofuRunner["run"]>[0],_context:Parameters<TofuRunner["run"]>[1],body:Parameters<TofuRunner["run"]>[2])=>body(fake)});
    try{await expect(s.original.saved.runtime.tofu.planWorkspace(s.original.saved.workspace,undefined,{custody:s.original.access.custody,normalize:{fingerprintKey:s.original.saved.fingerprint}})).rejects.toThrow("settlement");}
    finally{Object.defineProperty(TofuRunner.prototype,"run",descriptor);bytes.fill(0);}
    const stored=(await observer.query<{manifest_digest:string}>("select manifest_digest from platform.plan_artifacts where workspace_id=$1 and operation_id=$2",[s.scope.workspaceId,s.original.op.id]))[0];
    expect(stored.manifest_digest).toBe(s.original.saved.row.manifest_digest);expect(fakeInit).toBe(0);expect(await settled(s)).toHaveLength(0);
  },300000);

  it.each(["init","plan"] as const)("registered finite producer refuses own %s method with backend override before command launch",async method=>{
    const s=await standalone(),descriptor=Object.getOwnPropertyDescriptor(TofuRunner.prototype,"run")!,actual=TofuRunner.prototype.run,command=Object.getOwnPropertyDescriptor(TofuRun.prototype,"command")!.value;
    let shadowCalls=0;
    Object.defineProperty(TofuRunner.prototype,"run",{...descriptor,value:async function(this:TofuRunner,workspace:Parameters<TofuRunner["run"]>[0],context:Parameters<TofuRunner["run"]>[1],body:Parameters<TofuRunner["run"]>[2]){
      Object.defineProperty(TofuRunner.prototype,"run",descriptor);return actual.call(this,workspace,context,async run=>{
        Object.defineProperty(run,method,{value:async()=>{shadowCalls++;return command.call(run,method,[method,"-backend-config=path=/foreign/terraform.tfstate"]);},configurable:true});return body(run);
      });
    }});
    try{await expect(s.original.saved.runtime.tofu.planWorkspace(s.original.saved.workspace,undefined,{custody:s.original.access.custody,normalize:{fingerprintKey:s.original.saved.fingerprint}})).rejects.toMatchObject({name:"Error",message:"Canonical standalone run origin changed."});}
    finally{Object.defineProperty(TofuRunner.prototype,"run",descriptor);}
    expect(shadowCalls).toBe(0);expect(await readFile(path.join(s.scope.root,"terraform.tfstate")).catch(()=>null)).toBeNull();expect(await settled(s)).toHaveLength(0);
    const stored=(await observer.query<artifacts.ArtifactRow>("select * from platform.plan_artifacts where workspace_id=$1 and operation_id=$2",[s.scope.workspaceId,s.original.op.id]))[0];
    expect(stored).toEqual(s.original.saved.row);
  },300000);

  it.each(["accessor","replacement target"] as const)("registered finite producer refuses %s init fields changed during the prelaunch filesystem wait",async change=>{
    const s=await standalone(),descriptor=Object.getOwnPropertyDescriptor(TofuRunner.prototype,"run")!,actual=TofuRunner.prototype.run;let getterCalls=0;
    Object.defineProperty(TofuRunner.prototype,"run",{...descriptor,value:async function(this:TofuRunner,workspace:Parameters<TofuRunner["run"]>[0],context:Parameters<TofuRunner["run"]>[1],body:Parameters<TofuRunner["run"]>[2]){
      Object.defineProperty(TofuRunner.prototype,"run",descriptor);return actual.call(this,workspace,context,async run=>{
        const before=Object.getOwnPropertyDescriptor(run,"i")!;
        const pending=body(run);
        if(change==="accessor")Object.defineProperty(run,"i",{configurable:true,get:()=>{getterCalls++;return before.value;}});
        else Object.defineProperty(run,"i",{...before,value:{...before.value,bin:"/foreign/tofu",work:"/foreign/work"}});
        try{return await pending;}finally{Object.defineProperty(run,"i",before);}
      });
    }});
    try{await expect(s.original.saved.runtime.tofu.planWorkspace(s.original.saved.workspace,undefined,{custody:s.original.access.custody,normalize:{fingerprintKey:s.original.saved.fingerprint}})).rejects.toThrow("origin changed before launch");}
    finally{Object.defineProperty(TofuRunner.prototype,"run",descriptor);}
    expect(getterCalls).toBe(0);expect(await readFile(path.join(s.scope.root,"terraform.tfstate")).catch(()=>null)).toBeNull();expect(await settled(s)).toHaveLength(0);
  },300000);

  it("registered cleanup refuses a substituted absent root and then permits actual original cleanup",async()=>{
    const s=await standalone(),descriptor=Object.getOwnPropertyDescriptor(TofuRunner.prototype,"run")!,actual=TofuRunner.prototype.run,dispose=TofuRun.prototype.dispose;let checked=0;
    Object.defineProperty(TofuRunner.prototype,"run",{...descriptor,value:async function(this:TofuRunner,workspace:Parameters<TofuRunner["run"]>[0],context:Parameters<TofuRunner["run"]>[1],body:Parameters<TofuRunner["run"]>[2]){
      Object.defineProperty(TofuRunner.prototype,"run",descriptor);return actual.call(this,workspace,context,async run=>{
        const result=await body(run),before=Object.getOwnPropertyDescriptor(run,"i")!;
        Object.defineProperty(run,"i",{...before,value:{...before.value,root:path.join(s.scope.root,"absent-substituted-run")}});
        try{await expect(dispose.call(run)).rejects.toThrow("cleanup origin changed");expect(isCleanedTofuRun(run)).toBe(false);expect((await lstat(before.value.root)).isDirectory()).toBe(true);checked++;}
        finally{Object.defineProperty(run,"i",before);}
        return result;
      });
    }});
    try{expect((await consumeSavedNativePlan(db,s.original.saved,s.original.access)).result.apply.exitCode).toBe(0);}
    finally{Object.defineProperty(TofuRunner.prototype,"run",descriptor);}
    expect(checked).toBe(1);expect(await settled(s)).toHaveLength(1);
  },300000);

  it("registered cleanup field accessor during removal cannot mark a run cleaned or mint settlement",async()=>{
    const s=await standalone(),descriptor=Object.getOwnPropertyDescriptor(TofuRunner.prototype,"run")!,actual=TofuRunner.prototype.run,dispose=TofuRun.prototype.dispose;let getterCalls=0,checked=0;
    Object.defineProperty(TofuRunner.prototype,"run",{...descriptor,value:async function(this:TofuRunner,workspace:Parameters<TofuRunner["run"]>[0],context:Parameters<TofuRunner["run"]>[1],body:Parameters<TofuRunner["run"]>[2]){
      Object.defineProperty(TofuRunner.prototype,"run",descriptor);return actual.call(this,workspace,context,async run=>{
        const result=await body(run),before=Object.getOwnPropertyDescriptor(run,"i")!,pending=dispose.call(run);
        Object.defineProperty(run,"i",{configurable:true,get:()=>{getterCalls++;return before.value;}});
        try{await pending;expect(isCleanedTofuRun(run)).toBe(false);checked++;}
        finally{Object.defineProperty(run,"i",before);}
        return result;
      });
    }});
    try{await expect(consumeSavedNativePlan(db,s.original.saved,s.original.access)).rejects.toThrow("unconfirmed");}
    finally{Object.defineProperty(TofuRunner.prototype,"run",descriptor);}
    expect(getterCalls).toBe(0);expect(checked).toBe(1);expect(await settled(s)).toHaveLength(0);
    expect(JSON.parse(await readFile(path.join(s.scope.root,"terraform.tfstate"),"utf8")).resources).toHaveLength(1);
    await expect(consumeSavedNativePlan(db,s.original.saved,s.original.access)).rejects.toThrow();
  },300000);

  it.each(["init","plan"] as const)("registered finite producer refuses altered %s command arguments before tool launch",async method=>{
    const s=await standalone(),descriptor=Object.getOwnPropertyDescriptor(TofuRunner.prototype,"run")!,actual=TofuRunner.prototype.run,command=Object.getOwnPropertyDescriptor(TofuRun.prototype,"command")!.value;
    Object.defineProperty(TofuRunner.prototype,"run",{...descriptor,value:async function(this:TofuRunner,workspace:Parameters<TofuRunner["run"]>[0],context:Parameters<TofuRunner["run"]>[1],body:Parameters<TofuRunner["run"]>[2]){
      Object.defineProperty(TofuRunner.prototype,"run",descriptor);return actual.call(this,workspace,context,async run=>{
        await command.call(run,method,[method,"-backend-config=path=/foreign/terraform.tfstate"]);return body(run);
      });
    }});
    try{await expect(s.original.saved.runtime.tofu.planWorkspace(s.original.saved.workspace,undefined,{custody:s.original.access.custody,normalize:{fingerprintKey:s.original.saved.fingerprint}})).rejects.toThrow("origin changed");}
    finally{Object.defineProperty(TofuRunner.prototype,"run",descriptor);}
    expect(await readFile(path.join(s.scope.root,"terraform.tfstate")).catch(()=>null)).toBeNull();expect(await settled(s)).toHaveLength(0);
  },300000);

  it("genuine registered producer with a foreign workspace refuses before its first init",async()=>{
    const s=await standalone(),descriptor=Object.getOwnPropertyDescriptor(TofuRunner.prototype,"run")!,actual=TofuRunner.prototype.run;let checked=0;
    Object.defineProperty(TofuRunner.prototype,"run",{...descriptor,value:async function(this:TofuRunner,workspace:Parameters<TofuRunner["run"]>[0],context:Parameters<TofuRunner["run"]>[1],body:Parameters<TofuRunner["run"]>[2]){
      Object.defineProperty(TofuRunner.prototype,"run",descriptor);
      const files=workspace.files.map(file=>file.path==="backend.tf.json"?{...file,content:JSON.stringify({terraform:{backend:{local:{path:"/foreign/terraform.tfstate"}}}})}:file),foreign={...workspace,files,configDigest:configDigestOf(files)};
      return actual.call(this,foreign,context,async run=>{expect(isCanonicalStandaloneRun(this,run,foreign)).toBe(true);expect(isCanonicalStandaloneRun(this,run,workspace)).toBe(false);checked++;return body(run);});
    }});
    try{await expect(s.original.saved.runtime.tofu.planWorkspace(s.original.saved.workspace,undefined,{custody:s.original.access.custody,normalize:{fingerprintKey:s.original.saved.fingerprint}})).rejects.toThrow("settlement");}
    finally{Object.defineProperty(TofuRunner.prototype,"run",descriptor);}
    expect(checked).toBe(1);expect(await readFile(path.join(s.scope.root,"terraform.tfstate")).catch(()=>null)).toBeNull();expect(await settled(s)).toHaveLength(0);
  },300000);

  it.each(["producer own","producer prototype","apply own","apply prototype","readback prototype"] as const)("post-inspection %s method accessor refuses before the next finite engine member read",async scenario=>{
    const s=await standalone(),descriptor=Object.getOwnPropertyDescriptor(TofuRunner.prototype,"run")!,actual=TofuRunner.prototype.run;
    const stage=scenario.split(" ")[0],prototype=scenario.endsWith("prototype");let currentRun:TofuRun|undefined,getterCalls=0,inspections=0,installed:{target:object;key:string;before?:PropertyDescriptor}|undefined;
    if(stage!=="readback")Object.defineProperty(TofuRunner.prototype,"run",{...descriptor,value:async function(this:TofuRunner,workspace:Parameters<TofuRunner["run"]>[0],context:Parameters<TofuRunner["run"]>[1],body:Parameters<TofuRunner["run"]>[2]){
      Object.defineProperty(TofuRunner.prototype,"run",descriptor);return actual.call(this,workspace,context,async run=>{currentRun=run;return body(run);});
    }});
    const inspect=async()=>{
      inspections++;if(installed||stage==="readback"&&inspections!==3)return;
      if(!currentRun&&!prototype)throw new Error("Actual registered inspector run was not reached.");
      const key=stage==="producer"?"readPlanFile":stage==="apply"?"installReviewedPlan":"currentStateDigest",target=prototype?TofuRun.prototype:currentRun;
      if(!target)throw new Error("Actual registered inspector target was not reached.");
      const original=Object.getOwnPropertyDescriptor(TofuRun.prototype,key)!;installed={target,key,before:Object.getOwnPropertyDescriptor(target,key)};
      Object.defineProperty(target,key,{configurable:true,get:()=>{getterCalls++;return original.value;}});
    };
    try{
      if(stage==="producer")await expect(s.original.saved.runtime.tofu.planWorkspace(s.original.saved.workspace,undefined,{custody:s.original.access.custody,normalize:{fingerprintKey:s.original.saved.fingerprint},inspectPlan:inspect})).rejects.toThrow();
      else await expect(s.original.saved.runtime.planArtifacts.consume(s.original.access,original=>s.original.saved.runtime.tofu.applyVerifiedPlan(s.original.saved.workspace,{original,custody:s.original.access.custody,approvedDigest:s.original.access.planDigest,normalize:{fingerprintKey:s.original.saved.fingerprint},inspectPlan:inspect}))).rejects.toThrow();
    }finally{
      Object.defineProperty(TofuRunner.prototype,"run",descriptor);
      if(installed){if(installed.before)Object.defineProperty(installed.target,installed.key,installed.before);else Reflect.deleteProperty(installed.target,installed.key);}
    }
    expect(installed).toBeDefined();expect(getterCalls).toBe(0);expect(await settled(s)).toHaveLength(0);
    if(stage==="readback"){
      expect(inspections).toBe(3);expect(JSON.parse(await readFile(path.join(s.scope.root,"terraform.tfstate"),"utf8")).resources).toHaveLength(1);
      expect(await observer.query("select phase from platform.plan_artifact_uses where workspace_id=$1 and operation_id=$2",[s.scope.workspaceId,s.original.op.id])).toEqual([{phase:"uncertain"}]);
      await expect(consumeSavedNativePlan(db,s.original.saved,s.original.access)).rejects.toThrow();
    }else expect(await readFile(path.join(s.scope.root,"terraform.tfstate")).catch(()=>null)).toBeNull();
  },300000);

  it("registered apply refuses a plan-file method accessor installed during its awaited admission callback",async()=>{
    const s=await standalone(),runner=new TofuRunner({workRoot:s.scope.root});let getterCalls=0,reached=0;
    await runner.run(s.scope.workspace,{},async run=>{
      await run.init();await run.plan();const plan=await run.normalizedPlan({fingerprintKey:s.original.saved.fingerprint});
      try{await expect(run.apply({expectedPlanDigest:plan.planDigest,normalize:{fingerprintKey:s.original.saved.fingerprint},beforeDispatch:async()=>{
        reached++;Object.defineProperty(run,"planFileSha",{configurable:true,get:()=>{getterCalls++;return TofuRun.prototype.planFileSha;}});
      }})).rejects.toThrow("origin changed");}
      finally{Reflect.deleteProperty(run,"planFileSha");}
    });
    expect(reached).toBe(1);expect(getterCalls).toBe(0);expect(await readFile(path.join(s.scope.root,"terraform.tfstate")).catch(()=>null)).toBeNull();expect(await settled(s)).toHaveLength(0);
  },300000);

  it("registered runner finally refuses a dispose accessor after actual apply without invoking it or replaying",async()=>{
    const s=await standalone(),descriptor=Object.getOwnPropertyDescriptor(TofuRunner.prototype,"run")!,actual=TofuRunner.prototype.run;let getterCalls=0,reached=0;
    Object.defineProperty(TofuRunner.prototype,"run",{...descriptor,value:async function(this:TofuRunner,workspace:Parameters<TofuRunner["run"]>[0],context:Parameters<TofuRunner["run"]>[1],body:Parameters<TofuRunner["run"]>[2]){
      Object.defineProperty(TofuRunner.prototype,"run",descriptor);return actual.call(this,workspace,context,async run=>{const result=await body(run);reached++;Object.defineProperty(run,"dispose",{configurable:true,get:()=>{getterCalls++;return TofuRun.prototype.dispose;}});return result;});
    }});
    try{await expect(consumeSavedNativePlan(db,s.original.saved,s.original.access)).rejects.toThrow("unconfirmed");}
    finally{Object.defineProperty(TofuRunner.prototype,"run",descriptor);}
    expect(reached).toBe(1);expect(getterCalls).toBe(0);expect(await settled(s)).toHaveLength(0);expect(JSON.parse(await readFile(path.join(s.scope.root,"terraform.tfstate"),"utf8")).resources).toHaveLength(1);
    await expect(consumeSavedNativePlan(db,s.original.saved,s.original.access)).rejects.toThrow();
  },300000);

  it("registered apply refuses an init-field accessor installed during its awaited admission callback",async()=>{
    const s=await standalone(),runner=new TofuRunner({workRoot:s.scope.root});let getterCalls=0,reached=0;
    await runner.run(s.scope.workspace,{},async run=>{
      await run.init();await run.plan();const plan=await run.normalizedPlan({fingerprintKey:s.original.saved.fingerprint}),before=Object.getOwnPropertyDescriptor(run,"i")!;
      try{await expect(run.apply({expectedPlanDigest:plan.planDigest,normalize:{fingerprintKey:s.original.saved.fingerprint},beforeDispatch:async()=>{
        reached++;Object.defineProperty(run,"i",{configurable:true,get:()=>{getterCalls++;return before.value;}});
      }})).rejects.toThrow("origin changed");}
      finally{Object.defineProperty(run,"i",before);}
    });
    expect(reached).toBe(1);expect(getterCalls).toBe(0);expect(await readFile(path.join(s.scope.root,"terraform.tfstate")).catch(()=>null)).toBeNull();expect(await settled(s)).toHaveLength(0);
  },300000);

  it("unknown proxy producer origin refuses before any descriptor or method trap",async()=>{
    const s=await standalone(),descriptor=Object.getOwnPropertyDescriptor(TofuRunner.prototype,"run")!;let traps=0;
    const fake=new Proxy({},{get:()=>{traps++;throw new Error("Hostile method trap.");},ownKeys:()=>{traps++;throw new Error("Hostile key trap.");},getOwnPropertyDescriptor:()=>{traps++;throw new Error("Hostile descriptor trap.");},getPrototypeOf:()=>{traps++;throw new Error("Hostile prototype trap.");}});
    Object.defineProperty(TofuRunner.prototype,"run",{...descriptor,value:async(_workspace:Parameters<TofuRunner["run"]>[0],_context:Parameters<TofuRunner["run"]>[1],body:Parameters<TofuRunner["run"]>[2])=>Reflect.apply(body,undefined,[fake])});
    try{await expect(s.original.saved.runtime.tofu.planWorkspace(s.original.saved.workspace,undefined,{custody:s.original.access.custody,normalize:{fingerprintKey:s.original.saved.fingerprint}})).rejects.toThrow("settlement");}
    finally{Object.defineProperty(TofuRunner.prototype,"run",descriptor);}
    expect(traps).toBe(0);expect(await readFile(path.join(s.scope.root,"terraform.tfstate")).catch(()=>null)).toBeNull();expect(await settled(s)).toHaveLength(0);
  },300000);

  // WP2 settlement rules. The fixture writes settlement rows directly because the sealing writer is WP3.
  // Every horizon is read on the database clock, and the insert trigger is what refuses an early row.
  const settlementKey = randomBytes(32).toString("hex");
  const settlementCipher = () => vaultCipherFromEnv({ ZENITH_SECRET_KEY: settlementKey });
  type SettlementScope = { ws: string; id: string; project: string; environment: string };
  async function settlementScope(terminal = false): Promise<SettlementScope> {
    const seeded = await seedApprovedOperation(db);
    const ws = seeded.workspaceId, id = seeded.operation.id;
    if (terminal) await peer.query("update platform.operations set status='failed' where workspace_id=$1 and id=$2", [ws, id]);
    const [row] = await observer.query<{ project_id: string; environment_id: string }>("select project_id,environment_id from platform.operations where workspace_id=$1 and id=$2", [ws, id]);
    return { ws, id, project: row.project_id, environment: row.environment_id };
  }
  async function settlementRow(s: SettlementScope, family: string, source: string, identity: string, sealed?: Sealed, scopeProject = s.project) {
    return peer.query(`insert into platform.cleanup_writer_settlements(workspace_id,project_id,environment_id,operation_id,family,delivery_source,delivery_identity,horizon_at,sealed)
      values($1,$2,$3,$4,$5,$6,$7,clock_timestamp(),$8::text::jsonb)`,
      [s.ws, scopeProject, s.environment, s.id, family, source, identity,
        json(sealed ?? cleanup.sealDeliverySettlement(settlementCipher(), { workspaceId: s.ws, family, source, identity, operationId: s.id }))]);
  }
  async function settlementGrant(s: SettlementScope, offset: string, revoked = false): Promise<string> {
    const jti = randomUUID();
    await peer.query(`insert into platform.capability_grants(jti,workspace_id,operation_id,capability,audience,issued_at,expires_at,revoked_at)
      values($1,$2,$3,'infrastructure.apply','worker',clock_timestamp()-interval '1 day',clock_timestamp()+$4::interval,case when $5::boolean then clock_timestamp() else null end)`,
      [jti, s.ws, s.id, offset, revoked]);
    return jti;
  }
  async function settlementIntent(s: SettlementScope, offset: string): Promise<string> {
    const attempt = randomUUID();
    const binding = { format: "zenith.workflow-start.v1", arguments: { workspaceId: s.ws, operationId: s.id }, endpointDigest: sha(s.id), namespace: "fixture", workflowId: `fixture:${s.id}` };
    await peer.query(`insert into platform.workflow_start_intents(workspace_id,operation_id,binding,binding_digest,phase,attempt_id,attempted_at)
      values($1,$2,$3::text::jsonb,$4,'attempted',$5,clock_timestamp()+$6::interval)`, [s.ws, s.id, json(binding), digest(binding), attempt, offset]);
    return `${s.id}:${attempt}`;
  }
  it("a grant settles only past its expiry, its longest session and the skew margin on the database clock",async()=>{
    const s=await settlementScope();
    // 60 minutes past expiry leaves the horizon five minutes ahead (3600 s session plus 300 s skew); 66 minutes is past it.
    const inside=await settlementGrant(s,"-60 minutes"), past=await settlementGrant(s,"-66 minutes");
    await expect(settlementRow(s,"grant","capability_grants",inside)).rejects.toThrow(/refused before its horizon/);
    await settlementRow(s,"grant","capability_grants",past);
    expect(await observer.query("select count(*)::integer as n from platform.cleanup_writer_settlements where workspace_id=$1 and delivery_identity=$2",[s.ws,past])).toEqual([{n:1}]);
  });
  it("revocation never settles a grant on its own, but an expired and revoked grant settles by its horizon",async()=>{
    const s=await settlementScope();
    const revokedLive=await settlementGrant(s,"1 hour",true), revokedPast=await settlementGrant(s,"-2 hours",true);
    await expect(settlementRow(s,"grant","capability_grants",revokedLive)).rejects.toThrow(/refused before its horizon/);
    await settlementRow(s,"grant","capability_grants",revokedPast);
  });
  it("a workflow start settles only after its operation is terminal and its start recovery horizon has passed",async()=>{
    // One start intent per operation: each case has its own operation.
    const open = await settlementScope(), early = await settlementScope(true), old = await settlementScope(true);
    const running = await settlementIntent(open, "-2 hours"), tooSoon = await settlementIntent(early, "-5 minutes"), settled = await settlementIntent(old, "-2 hours");
    await expect(settlementRow(open, "workflow", "workflow_start_intents", running)).rejects.toThrow(/refused before its horizon/);
    await expect(settlementRow(early, "workflow", "workflow_start_intents", tooSoon)).rejects.toThrow(/refused before its horizon/);
    await settlementRow(old, "workflow", "workflow_start_intents", settled);
  });
  it("a runner job settles only from a terminal status and never while its lease is still open",async()=>{
    const s=await settlementScope();
    const target=`diagnostic_${randomUUID()}`;
    await peer.query("insert into platform.runners(id,workspace_id,name,public_key) values($1,$2,'diagnostic','fixture-public-key')",[target,s.ws]);
    const open=`job_${randomUUID()}`, done=`job_${randomUUID()}`;
    await peer.query(`insert into platform.runner_jobs(id,runner_id,workspace_id,operation_id,kind,capability,envelope,status,expires_at,started_at)
      values($1,$2,$3,$4,'diagnostic','infrastructure.apply','synthetic-no-authority','running',clock_timestamp()-interval '1 hour',clock_timestamp()-interval '2 hours')`,[open,target,s.ws,s.id]);
    await peer.query(`insert into platform.runner_jobs(id,runner_id,workspace_id,operation_id,kind,capability,envelope,status,expires_at,started_at,settled_at)
      values($1,$2,$3,$4,'diagnostic','infrastructure.apply','synthetic-no-authority','succeeded',clock_timestamp()-interval '3 hours',clock_timestamp()-interval '2 hours',clock_timestamp()-interval '2 hours')`,[done,target,s.ws,s.id]);
    await expect(settlementRow(s,"runner","runner_jobs",open)).rejects.toThrow(/refused before its horizon/);
    await settlementRow(s,"runner","runner_jobs",done);
  });
  it("a revoked runner's cancelled job never settles at its revocation time, only after its envelope horizon passes",async()=>{
    const s=await settlementScope();
    const target=`diagnostic_${randomUUID()}`;
    await peer.query("insert into platform.runners(id,workspace_id,name,public_key) values($1,$2,'diagnostic','fixture-public-key')",[target,s.ws]);
    const live=`job_${randomUUID()}`, old=`job_${randomUUID()}`;
    // Revocation stamps settled_at now while the envelope is still live: the revoked runner may still be executing.
    await peer.query(`insert into platform.runner_jobs(id,runner_id,workspace_id,operation_id,kind,capability,envelope,status,expires_at,started_at,settled_at)
      values($1,$2,$3,$4,'diagnostic','infrastructure.apply','synthetic-no-authority','cancelled',clock_timestamp()+interval '1 hour',clock_timestamp()-interval '2 hours',clock_timestamp())`,[live,target,s.ws,s.id]);
    await expect(settlementRow(s,"runner","runner_jobs",live)).rejects.toThrow(/refused before its horizon/);
    // The same revocation with the envelope and its session long past: both timestamps move into the past.
    await peer.query(`insert into platform.runner_jobs(id,runner_id,workspace_id,operation_id,kind,capability,envelope,status,expires_at,started_at,settled_at)
      values($1,$2,$3,$4,'diagnostic','infrastructure.apply','synthetic-no-authority','cancelled',clock_timestamp()-interval '3 hours',clock_timestamp()-interval '4 hours',clock_timestamp()-interval '2 hours')`,[old,target,s.ws,s.id]);
    vi.stubEnv("ZENITH_SECRET_KEY",settlementKey);
    expect(await cleanup.inventory(db,s.ws,s.project,s.environment)).toMatchObject({handoffs:2});
    await expect(settlementRow(s,"runner","runner_jobs",old)).resolves.toBeDefined();
    expect(await cleanup.inventory(db,s.ws,s.project,s.environment)).toMatchObject({handoffs:1});
  });
  it("a revoked machine's cancelled request never settles at its revocation time, only after its envelope horizon passes",async()=>{
    const s=await settlementScope();
    const target=`diagnostic_${randomUUID()}`;
    await peer.query("insert into platform.machines(id,workspace_id,name,transport,target_id) values($1,$2,'diagnostic','zenithd',$1)",[target,s.ws]);
    const live=`mreq_${randomUUID()}`, old=`mreq_${randomUUID()}`;
    await peer.query(`insert into platform.machine_requests(id,machine_id,workspace_id,operation_id,operation,capability,envelope,status,expires_at,started_at,settled_at)
      values($1,$2,$3,$4,'diagnostic','infrastructure.apply','synthetic-no-authority','cancelled',clock_timestamp()+interval '1 hour',clock_timestamp()-interval '2 hours',clock_timestamp())`,[live,target,s.ws,s.id]);
    await expect(settlementRow(s,"runner","machine_requests",live)).rejects.toThrow(/refused before its horizon/);
    await peer.query(`insert into platform.machine_requests(id,machine_id,workspace_id,operation_id,operation,capability,envelope,status,expires_at,started_at,settled_at)
      values($1,$2,$3,$4,'diagnostic','infrastructure.apply','synthetic-no-authority','cancelled',clock_timestamp()-interval '3 hours',clock_timestamp()-interval '4 hours',clock_timestamp()-interval '2 hours')`,[old,target,s.ws,s.id]);
    vi.stubEnv("ZENITH_SECRET_KEY",settlementKey);
    expect(await cleanup.inventory(db,s.ws,s.project,s.environment)).toMatchObject({handoffs:2});
    await settlementRow(s,"runner","machine_requests",old);
    expect(await cleanup.inventory(db,s.ws,s.project,s.environment)).toMatchObject({handoffs:1});
  });
  it("a build launch settles only after its provider finished and never while it is still dispatched",async()=>{
    const s=await settlementScope();
    // One launch per (operation, service): the dispatched and terminal launches use two services of the same operation.
    const pending="container_service/pending", finished="container_service/finished";
    const launch=(service:string,attempt:string,phase:"dispatched"|"terminal")=>peer.query(`insert into platform.build_launches(workspace_id,operation_id,service_address,environment_id,attempt_id,binding,binding_digest,proposal_digest,input_digest,plan_digest,fence_token,phase,build_id,request_ids,accepted_at,terminal_status,provider_finished_at,terminal_request_id,observed_at)
      values($1,$2,$3,$4,$5,$6::text::jsonb,$7,$7,$7,$7,1,$8,$9,case when $8='terminal' then '["req-1"]'::jsonb else null end,case when $8='terminal' then clock_timestamp()-interval '2 hours' else null end,
        case when $8='terminal' then 'SUCCEEDED' else null end,case when $8='terminal' then clock_timestamp()-interval '2 hours' else null end,case when $8='terminal' then 'req-1' else null end,case when $8='terminal' then clock_timestamp()-interval '2 hours' else null end)`,
      [s.ws,s.id,service,s.environment,attempt,json({workspaceId:s.ws,operationId:s.id,environmentId:s.environment,serviceAddress:service}),digest(service),phase,phase==="terminal"?randomUUID():null]);
    const dispatched=randomUUID(), done=randomUUID();
    await launch(pending,dispatched,"dispatched");
    await launch(finished,done,"terminal");
    await expect(settlementRow(s,"build","build_launches",`${s.id}:${pending}:${dispatched}`)).rejects.toThrow(/refused before its horizon/);
    await settlementRow(s,"build","build_launches",`${s.id}:${finished}:${done}`);
  });
  it("a plan use, a mismatched family or source, an unknown delivery and a foreign scope never settle anything",async()=>{
    const s=await settlementScope(), other=await settlementScope();
    const jti=await settlementGrant(s,"-2 hours");
    await expect(settlementRow(s,"plan","plan_artifact_uses",`${s.id}:${randomUUID()}`)).rejects.toThrow(/refused before its horizon or for an unmatched delivery/);
    await expect(settlementRow(s,"plan","capability_grants",jti)).rejects.toThrow(/does not settle this delivery source/);
    await expect(settlementRow(s,"grant","runner_jobs",jti)).rejects.toThrow(/does not settle this delivery source/);
    await expect(settlementRow(s,"grant","capability_grants",randomUUID())).rejects.toThrow(/refused before its horizon or for an unmatched delivery/);
    await expect(settlementRow(other,"grant","capability_grants",jti)).rejects.toThrow(/refused before its horizon or for an unmatched delivery/);
    await expect(settlementRow(s,"grant","capability_grants",jti,undefined,"proj_foreign")).rejects.toThrow(/scope does not match its operation/);
  });
  it("a settlement row is append-only history that cannot be updated or deleted",async()=>{
    const s=await settlementScope();
    const jti=await settlementGrant(s,"-2 hours");
    await settlementRow(s,"grant","capability_grants",jti);
    await expect(peer.query("update platform.cleanup_writer_settlements set horizon_at=clock_timestamp() where workspace_id=$1 and delivery_identity=$2",[s.ws,jti])).rejects.toThrow(/cannot be changed or cleared/);
    await expect(peer.query("delete from platform.cleanup_writer_settlements where workspace_id=$1 and delivery_identity=$2",[s.ws,jti])).rejects.toThrow(/cannot be changed or cleared/);
  });
  it("only an authenticated settlement removes its delivery from the counted inventory; forged, replayed and unkeyed rows remove nothing",async()=>{
    const s=await settlementScope();
    const settled=await settlementGrant(s,"-2 hours"), forged=await settlementGrant(s,"-2 hours"), replayed=await settlementGrant(s,"-2 hours");
    // Sealed under another key: the row exists and is past its horizon, but it does not authenticate.
    const foreignKey=vaultCipherFromEnv({ ZENITH_SECRET_KEY: randomBytes(32).toString("hex") });
    await settlementRow(s,"grant","capability_grants",forged,cleanup.sealDeliverySettlement(foreignKey,{workspaceId:s.ws,family:"grant",source:"capability_grants",identity:forged,operationId:s.id}));
    // A payload authenticated for one grant, copied onto another row, fails the per-delivery AAD ref.
    await settlementRow(s,"grant","capability_grants",replayed,cleanup.sealDeliverySettlement(settlementCipher(),{workspaceId:s.ws,family:"grant",source:"capability_grants",identity:settled,operationId:s.id}));
    vi.stubEnv("ZENITH_PLAN_ARTIFACT_KEY",""); vi.stubEnv("ZENITH_SECRET_KEY",settlementKey); // the API holds only the vault key
    expect(await cleanup.inventory(db,s.ws,s.project,s.environment)).toMatchObject({grants:3,handoffs:3});
    await settlementRow(s,"grant","capability_grants",settled);
    expect(await cleanup.inventory(db,s.ws,s.project,s.environment)).toMatchObject({grants:2,handoffs:2});
    vi.stubEnv("ZENITH_SECRET_KEY","");
    expect(await cleanup.inventory(db,s.ws,s.project,s.environment)).toMatchObject({grants:3,handoffs:3});
  });
  it("a verified workflow settlement removes its start from the counted inventory only past the recovery horizon",async()=>{
    const s=await settlementScope(true);
    const attempted=await settlementIntent(s,"-2 hours");
    vi.stubEnv("ZENITH_SECRET_KEY",settlementKey);
    expect(await cleanup.inventory(db,s.ws,s.project,s.environment)).toMatchObject({handoffs:2});
    await settlementRow(s,"workflow","workflow_start_intents",attempted);
    expect(await cleanup.inventory(db,s.ws,s.project,s.environment)).toMatchObject({handoffs:0});
  });
  // WP3: non-builtin plan uses (schema 63) and the sealing writer. A plan use settles only on a short-lived AWS connection
  // recorded for its environment before the operation, after the operation is terminal and past its latest grant horizon.
  async function planUse(s: SettlementScope, mode = "aws_assume_role", connectionAge = "-1 day"): Promise<string> {
    const attempt = randomUUID(), connection = `conn_${randomUUID()}`;
    await peer.query(`insert into platform.provider_connections(id,workspace_id,provider,mode,config,status,created_by,created_at)
      values($1,$2,'aws',$3,'{}'::jsonb,'verified','fixture',clock_timestamp()+$4::interval)`, [connection, s.ws, mode, connectionAge]);
    await peer.query(`insert into platform.reconcile_state(environment_id,workspace_id,project_id,env_class,provider,region,connection_id,next_run_at,registered_at,updated_at)
      values($1,$2,$3,'sandbox','aws','ap-south-1',$4,clock_timestamp(),clock_timestamp(),clock_timestamp())
      on conflict (environment_id) do update set connection_id=excluded.connection_id`, [s.environment, s.ws, s.project, connection]);
    await peer.query("insert into platform.plan_artifact_uses(workspace_id,operation_id,phase,attempt_id) values($1,$2,'succeeded',$3)", [s.ws, s.id, attempt]);
    return `${s.id}:${attempt}`;
  }
  it("a non-builtin plan use settles only on a terminal operation past its latest grant horizon on a short-lived AWS connection",async()=>{
    const open=await settlementScope(), recent=await settlementScope(true), done=await settlementScope(true);
    const openUse=await planUse(open), recentUse=await planUse(recent), doneUse=await planUse(done);
    await settlementGrant(open,"-2 hours");
    await settlementGrant(recent,"-2 hours"); await settlementGrant(recent,"-60 minutes");
    await settlementGrant(done,"-2 hours"); await settlementGrant(done,"-66 minutes");
    await expect(settlementRow(open,"plan","plan_artifact_uses",openUse)).rejects.toThrow(/refused before its horizon/);
    // The latest grant decides: one grant past its horizon does not settle a use whose other grant is still inside it.
    await expect(settlementRow(recent,"plan","plan_artifact_uses",recentUse)).rejects.toThrow(/refused before its horizon/);
    await settlementRow(done,"plan","plan_artifact_uses",doneUse);
  });
  it("a plan use on a static or runner connection, a connection newer than the operation, or no grant never settles",async()=>{
    const staticKeys=await settlementScope(true), runner=await settlementScope(true), newer=await settlementScope(true), ungranted=await settlementScope(true);
    const a=await planUse(staticKeys,"static_dev"), b=await planUse(runner,"runner"), c=await planUse(newer,"aws_assume_role","1 minute"), d=await planUse(ungranted);
    for (const s of [staticKeys,runner,newer]) await settlementGrant(s,"-2 hours");
    await expect(settlementRow(staticKeys,"plan","plan_artifact_uses",a)).rejects.toThrow(/refused before its horizon/);
    await expect(settlementRow(runner,"plan","plan_artifact_uses",b)).rejects.toThrow(/refused before its horizon/);
    await expect(settlementRow(newer,"plan","plan_artifact_uses",c)).rejects.toThrow(/refused before its horizon/);
    await expect(settlementRow(ungranted,"plan","plan_artifact_uses",d)).rejects.toThrow(/refused before its horizon/);
  });
  it("a plan use never settles by time while the workspace held a static AWS connection when the operation was created",async()=>{
    const s=await settlementScope(true);
    const use=await planUse(s); await settlementGrant(s,"-2 hours");
    await peer.query(`insert into platform.provider_connections(id,workspace_id,provider,mode,config,status,created_by,created_at)
      values($1,$2,'aws','static_dev','{}'::jsonb,'revoked','fixture',clock_timestamp()-interval '2 days')`, [`conn_${randomUUID()}`, s.ws]);
    await expect(settlementRow(s,"plan","plan_artifact_uses",use)).rejects.toThrow(/refused before its horizon/);
  });
  it("the writer seals grants and plan uses past their horizons, and the counted inventory drains to zero",async()=>{
    const s=await settlementScope(true);
    await planUse(s); const jti=await settlementGrant(s,"-2 hours");
    vi.stubEnv("ZENITH_SECRET_KEY",settlementKey);
    const before=await cleanup.inventory(db,s.ws,s.project,s.environment);
    expect(before.grants).toBe(1); expect(before.handoffs).toBeGreaterThan(0);
    // Without the platform key nothing is written.
    expect(await cleanup.writeDeliverySettlements(peer,{},{cipher:undefined,limit:10000})).toBeDefined();
    let pass;
    do pass=await cleanup.writeDeliverySettlements(peer,{},{cipher:settlementCipher(),limit:10000}); while(pass.written>0);
    const rows=await observer.query<{family:string}>("select family from platform.cleanup_writer_settlements where workspace_id=$1 order by family",[s.ws]);
    expect(rows.map(r=>r.family)).toEqual(expect.arrayContaining(["grant","plan"]));
    expect(await cleanup.inventory(db,s.ws,s.project,s.environment)).toMatchObject({grants:0,handoffs:0});
    expect(rows.some(r=>r.family==="grant")).toBe(true); expect(jti).toBeTruthy();
  });
  it("the writer settles a workflow start only when an authenticated Describe reports it closed or not found",async()=>{
    const closed=await settlementScope(true), missing=await settlementScope(true), running=await settlementScope(true), unread=await settlementScope(true), unported=await settlementScope(true);
    const ids=new Map<string,string>();
    for (const [name,s] of Object.entries({closed,missing,running,unread,unported})) { ids.set(`fixture:${s.id}`,name); await settlementIntent(s,"-2 hours"); }
    const answer:Record<string,"closed"|"not_found"|"open"|"unknown">={closed:"closed",missing:"not_found",running:"open",unread:"unknown"};
    const startClosure=async(binding:{namespace:string;workflowId:string})=>{
      const name=ids.get(binding.workflowId); if(name==="unported")throw new Error("Describe unavailable."); return name?answer[name]:"unknown";};
    let pass; do pass=await cleanup.writeDeliverySettlements(peer,{startClosure},{cipher:settlementCipher(),limit:10000}); while(pass.written>0);
    const settledOps=new Set((await observer.query<{op:string}>("select operation_id as op from platform.cleanup_writer_settlements where family='workflow' and operation_id in (select jsonb_array_elements_text($1::text::jsonb))",
      [JSON.stringify([closed,missing,running,unread,unported].map(s=>s.id))])).map(r=>r.op));
    expect([...settledOps].sort()).toEqual([closed.id,missing.id].sort());
    // No Describe port at all: a workflow start is never settled.
    const bare=await settlementScope(true); await settlementIntent(bare,"-2 hours");
    do pass=await cleanup.writeDeliverySettlements(peer,{},{cipher:settlementCipher(),limit:10000}); while(pass.written>0);
    expect(await observer.query("select count(*)::integer as n from platform.cleanup_writer_settlements where operation_id=$1",[bare.id])).toEqual([{n:0}]);
  });
});
