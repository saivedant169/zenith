/**
 * applyInfrastructure: the one step that changes declarative infrastructure.
 * Covers the happy path and every way it can end, because the workflow's final
 * status depends on which KIND of error leaves this activity.
 */
import { existsSync } from "node:fs";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { ApplicationFailure } from "@temporalio/activity";
import { LeaseLostError, StepFailedError, TofuPlanChangedError } from "@/lib/execution/errors";
import { CANARY_GRANT, CANARY_SECRET, CANARY_SESSION_KEY, ENV, OP, bucketManifest, change, makePlan } from "./fakes/fixtures";
import { PLAN_FILE_CANARY } from "./fakes/tofu";
import { createWorld, type World, type WorldOptions } from "./fakes/world";

const worlds: World[] = [];
const world = (opts: WorldOptions = {}): World => {
  const w = createWorld(opts);
  w.product.setManifest(bucketManifest());
  // Explicit isolated human-authority fixture; real canonical expiry/revocation tests below use the actual broker.
  w.broker.approval={approved:true,rejected:false,approvalId:"isolated-reviewed-human-fixture"};
  worlds.push(w);
  return w;
};
afterEach(() => {
  while (worlds.length) worlds.pop()!.dispose();
});

/** validate → lease → plan: the state the workflow is in when it calls apply. */
async function planned(w: World) {
  await w.activities.markOperation({ operationId: OP, status: "running" });
  await w.activities.validateDesiredState({ operationId: OP });
  const lease = await w.lease();
  const plan = await w.activities.planInfrastructure({ operationId: OP, lease });
  return { lease, plan };
}

describe("applyInfrastructure", () => {
  it("applies the approved plan under a deploy session, then records evidence, statuses and events — without a single value", async () => {
    const w = world();
    w.tofu.outputs = {
      alb_dns_name: { sensitive: false, type: "string", value: `lb.example.com/${CANARY_SECRET}` },
      db_master_password: { sensitive: true, type: "string" },
    };
    const { lease, plan } = await planned(w);

    const result = await w.activities.applyInfrastructure({ operationId: OP, planDigest: plan.planDigest, lease });
    expect(result.applied).toBe(1);
    expect(result.outputsDigest).toMatch(/^[0-9a-f]{64}$/);

    // engine call: the approved digest, under the brokered session, with the server fingerprint key
    expect(w.tofu.applyCalls).toHaveLength(1);
    expect(w.tofu.applyCalls[0]).toMatchObject({ approvedDigest: plan.planDigest, fingerprintKey: expect.any(String) });
    expect(w.tofu.applyCalls[0].envKeys).toContain("AWS_SESSION_TOKEN");

    // the apply used the operation's OWN capability (mutating) on the deploy role, bound to the fence
    const grant = w.broker.grants.at(-1)!;
    expect(grant).toMatchObject({ audience: "worker", durationSec: 3600, fence: { scope: `env:${ENV}`, fenceToken: lease.fenceToken } });
    expect(grant.capability).toBeUndefined();
    expect(w.credentials.sessions.at(-1)).toMatchObject({ purpose: "deploy", capability: "deployment.deploy", fence: lease.fenceToken, revoked: true });

    // fence asserted before and after the external call
    const asserts = w.leases.assertCalls.filter((c) => c.fenceToken === lease.fenceToken);
    expect(asserts.length).toBeGreaterThanOrEqual(4); // plan before/after + apply before/after

    // evidence: counts, digests, output NAMES and sensitivity
    const [row] = w.evidence.ofKind("tofu_apply");
    expect(row.summary).toMatchObject({ planDigest: plan.planDigest, applied: { create: 1, update: 0, delete: 0, replace: 0 }, exitCode: 0, outputsDigest: result.outputsDigest });
    expect(row.summary.outputs).toEqual([
      { name: "alb_dns_name", sensitive: false },
      { name: "db_master_password", sensitive: true },
    ]);
    expect(w.events.ofType("resource.applying")).toHaveLength(1);
    expect(w.events.ofType("resource.applied")).toHaveLength(1);
    expect(w.events.events.map((e) => e.type).filter((t) => t.startsWith("resource.")).slice(-2)).toEqual(["resource.applying", "resource.applied"]);

    // the touched resource is active in the store
    expect(w.resources.byAddress("object_store/assets")?.status).toBe("active");

    // nothing sensitive anywhere, and the plan file is gone
    const everything = `${w.stored()}${JSON.stringify(result)}${JSON.stringify(w.logs)}`;
    for (const secret of [CANARY_SECRET, CANARY_SESSION_KEY, CANARY_GRANT, PLAN_FILE_CANARY, "session-token-canary"]) expect(everything).not.toContain(secret);
    expect(existsSync(path.join(w.planDir, `${plan.planDigest}.tfplan`))).toBe(false);
  });

  it.each([{approved:false,rejected:false},{approved:true,rejected:true}])("refuses changed current authority before an external write ($approved/$rejected)",async authority=>{
    const w=world();const {lease,plan}=await planned(w);
    let dispatched=false;void w.tofu.applyStarted.then(()=>{dispatched=true;});
    w.broker.approval=authority;
    await expect(w.activities.applyInfrastructure({operationId:OP,planDigest:plan.planDigest,lease})).rejects.toThrow("Current policy or human approval changed");
    expect(dispatched).toBe(false);expect(w.evidence.ofKind("tofu_apply")).toHaveLength(0);
    expect(w.ops.ops.get(OP)?.status).toBe("running");
  });

  it("marks deleted nodes deleted when the plan deleted them", async () => {
    const w = world();
    w.tofu.planFactory = () => makePlan({ changes: [change({ address: "aws_s3_bucket.assets", nodeAddress: "object_store/assets", type: "aws_s3_bucket", action: "delete", destroysData: true })] });
    const { lease, plan } = await planned(w);
    await w.activities.applyInfrastructure({ operationId: OP, planDigest: plan.planDigest, lease });
    expect(w.resources.byAddress("object_store/assets")?.status).toBe("deleted");
  });

  it("heartbeats, renews the environment lease and extends the operation's execution lease while tofu runs", async () => {
    const w = world();
    const { lease, plan } = await planned(w);
    let release!: () => void;
    w.tofu.applyGate = new Promise<void>((resolve) => (release = resolve));
    const before = { renewals: w.leases.renewCalls, beats: w.heartbeats.length, opBeats: w.ops.heartbeats };
    const running = w.activities.applyInfrastructure({ operationId: OP, planDigest: plan.planDigest, lease });
    await new Promise((r) => setTimeout(r, 60));
    release();
    await running;
    expect(w.leases.renewCalls - before.renewals).toBeGreaterThanOrEqual(3);
    expect(w.heartbeats.length - before.beats).toBeGreaterThanOrEqual(3);
    expect(w.ops.heartbeats - before.opBeats).toBeGreaterThanOrEqual(3);
  });

  it("raises LeaseLost, aborts tofu and marks the operation uncertain when the lease is lost DURING the apply", async () => {
    const w = world();
    const { lease, plan } = await planned(w);
    w.tofu.apply = "hang";
    w.leases.lostAfterRenewals = w.leases.renewCalls; // the next renewal reports the lease gone
    const err = await w.activities.applyInfrastructure({ operationId: OP, planDigest: plan.planDigest, lease }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(LeaseLostError);
    expect((err as LeaseLostError).code).toBe("lease_lost");
    expect(w.ops.uncertain).toHaveLength(1);
    expect(w.ops.ops.get(OP)!.status).toBe("uncertain");
    expect(w.evidence.ofKind("tofu_apply")).toHaveLength(0); // it never finished: no claim that it did
    expect(w.events.ofType("resource.applied")).toHaveLength(0);
    expect(existsSync(path.join(w.planDir, `${plan.planDigest}.tfplan`))).toBe(false);
  });

  it("still records the apply when tofu finished but the lease was lost meanwhile, and raises LeaseLost", async () => {
    const w = world();
    const { lease, plan } = await planned(w);
    let release!: () => void;
    w.tofu.applyGate = new Promise<void>((resolve) => (release = resolve));
    const running = w.activities.applyInfrastructure({ operationId: OP, planDigest: plan.planDigest, lease });
    await w.tofu.applyStarted;
    w.leases.steal(lease.scope); // another writer takes the environment
    await new Promise((r) => setTimeout(r, 30));
    release();
    await expect(running).rejects.toBeInstanceOf(LeaseLostError);
    expect(w.evidence.ofKind("tofu_apply")).toHaveLength(1); // what really happened is on the record
  });

  it("raises LeaseLost when the operation is no longer running in the ledger (the reconciler gave up on it)", async () => {
    const w = world();
    const { lease, plan } = await planned(w);
    w.tofu.apply = "hang";
    w.ops.heartbeatResult = false;
    await expect(w.activities.applyInfrastructure({ operationId: OP, planDigest: plan.planDigest, lease })).rejects.toBeInstanceOf(LeaseLostError);
  });

  it("gives up before the lease can lapse when the store stays unreachable for two thirds of its ttl", async () => {
    const w = world({ limits: { leaseTtlMs: 40, heartbeatIntervalMs: 5 } });
    const { lease, plan } = await planned(w);
    w.tofu.apply = "hang";
    w.leases.renewMode = "throw";
    await expect(w.activities.applyInfrastructure({ operationId: OP, planDigest: plan.planDigest, lease })).rejects.toBeInstanceOf(LeaseLostError);
    expect(w.logs.some((l) => l.message === "lease renewal failed")).toBe(true);
  });

  it("stops tofu when Temporal cancels the activity and reports an unproven outcome, never a clean one", async () => {
    const controller = new AbortController();
    const w = world({ signal: controller.signal });
    const { lease, plan } = await planned(w);
    w.tofu.apply = "hang";
    const running = w.activities.applyInfrastructure({ operationId: OP, planDigest: plan.planDigest, lease }).catch((e: unknown) => e);
    await w.tofu.applyStarted;
    controller.abort(new Error("cancelled by the workflow"));
    const err = await running;
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(ApplicationFailure); // plain: the workflow finalizes uncertain
    expect((err as Error).message).toMatch(/partial apply; reconcile will observe the environment/);
    expect(w.ops.uncertain).toHaveLength(1);
  });

  it("says 'partial apply; reconcile will observe' and stays a clean StepFailed when tofu apply exits non-zero", async () => {
    const w = world();
    const { lease, plan } = await planned(w);
    w.tofu.apply = "fail_apply";
    const err = await w.activities.applyInfrastructure({ operationId: OP, planDigest: plan.planDigest, lease }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(StepFailedError);
    expect((err as ApplicationFailure).type).toBe("StepFailed");
    expect((err as ApplicationFailure).nonRetryable).toBe(true);
    expect((err as Error).message).toMatch(/partial apply; reconcile will observe the environment/);
    expect(w.ops.uncertain).toHaveLength(0); // it ended definitively; the workflow finalizes it failed
    expect(w.evidence.ofKind("tofu_apply")).toHaveLength(0);
    expect(w.resources.byAddress("object_store/assets")?.status).toBe("planned"); // nothing is claimed active
    expect(existsSync(path.join(w.planDir, `${plan.planDigest}.tfplan`))).toBe(false);
  });

  it("treats a failed `tofu output` after the apply as a partial apply too", async () => {
    const w = world();
    const { lease, plan } = await planned(w);
    w.tofu.apply = "fail_output";
    await expect(w.activities.applyInfrastructure({ operationId: OP, planDigest: plan.planDigest, lease })).rejects.toThrow(/partial apply; reconcile will observe/);
  });

  it("does not claim 'partial' when tofu failed before it applied anything", async () => {
    const w = world();
    const { lease, plan } = await planned(w);
    w.tofu.apply = "fail_plan_before_apply";
    let providerStarted = false;
    void w.tofu.applyStarted.then(() => { providerStarted = true; });
    const err = await w.activities.applyInfrastructure({ operationId: OP, planDigest: plan.planDigest, lease }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(StepFailedError);
    expect((err as Error).message).toMatch(/The apply did not start; nothing was changed/);
    expect((err as Error).message).not.toMatch(/partial/);
    expect(providerStarted).toBe(false);
    expect(w.evidence.ofKind("tofu_apply")).toHaveLength(0);
    expect(w.ops.uncertain).toHaveLength(0);
    expect(w.ops.ops.get(OP)?.status).toBe("running");
  });

  it("leaves a timeout or an unclassified error PLAIN (unknown outcome → uncertain) and marks the operation uncertain", async () => {
    for (const behaviour of ["timeout", "unclassified"] as const) {
      const w = world();
      const { lease, plan } = await planned(w);
      w.tofu.apply = behaviour;
      const err = await w.activities.applyInfrastructure({ operationId: OP, planDigest: plan.planDigest, lease }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(Error);
      expect(err).not.toBeInstanceOf(ApplicationFailure);
      expect((err as Error).message).toMatch(/partial apply; reconcile will observe the environment/);
      expect(w.ops.uncertain).toHaveLength(1);
      expect(w.ops.ops.get(OP)!.status).toBe("uncertain");
      // An unclassified error keeps its class and scrubbed cause on the operation, not just a generic sentence.
      if (behaviour === "unclassified") expect(w.ops.uncertain[0]!.reason).toMatch(/^The apply ended with an unclassified error \([A-Za-z]+: .+\)\.$/);
    }
  });

  it("keeps the OpenTofu failure code behind an unconfirmed plan dispatch on the uncertain operation", async () => {
    const w = world();
    const { lease, plan } = await planned(w);
    w.tofu.apply = "dispatch_unconfirmed";
    await w.activities.applyInfrastructure({ operationId: OP, planDigest: plan.planDigest, lease }).catch(() => undefined);
    expect(w.ops.ops.get(OP)!.status).toBe("uncertain");
    expect(w.ops.uncertain[0]!.reason).toContain("; cause TofuCommandError/tofu_command_failed/apply:api_AccessDeniedException).");
  });

  it("rethrows plan_changed untouched: nothing was applied, re-approval is required", async () => {
    const w = world();
    const { lease, plan } = await planned(w);
    w.tofu.apply = "plan_changed";
    const err = await w.activities.applyInfrastructure({ operationId: OP, planDigest: plan.planDigest, lease }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TofuPlanChangedError);
    expect(w.ops.uncertain).toHaveLength(0);
    expect(w.evidence.ofKind("tofu_apply")).toHaveLength(0);
  });

  it("does not start when the fence is already dead: no tofu, no credentials, no applying event", async () => {
    const w = world();
    const { lease, plan } = await planned(w);
    w.leases.steal(lease.scope);
    const sessions = w.credentials.sessions.length;
    await expect(w.activities.applyInfrastructure({ operationId: OP, planDigest: plan.planDigest, lease })).rejects.toBeInstanceOf(LeaseLostError);
    expect(w.tofu.applyCalls).toHaveLength(0);
    expect(w.credentials.sessions).toHaveLength(sessions);
    expect(w.events.ofType("resource.applying")).toHaveLength(0);
    expect(w.ops.uncertain).toHaveLength(0); // nothing acted
  });

  it("reports a refused credential or grant as 'did not start; nothing was changed', a clean failure", async () => {
    const denied = world();
    const a = await planned(denied);
    denied.credentials.denyNext = 1;
    const err = await denied.activities.applyInfrastructure({ operationId: OP, planDigest: a.plan.planDigest, lease: a.lease }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(StepFailedError);
    expect((err as Error).message).toMatch(/did not start; nothing was changed/);
    expect(denied.tofu.applyCalls).toHaveLength(0);
    expect(denied.ops.uncertain).toHaveLength(0);

    const refused = world();
    const b = await planned(refused);
    refused.broker.refuseGrants = true;
    await expect(refused.activities.applyInfrastructure({ operationId: OP, planDigest: b.plan.planDigest, lease: b.lease })).rejects.toThrow(/did not start; nothing was changed/);
  });

  it("refuses a malformed plan digest and a lease that is not this operation's", async () => {
    const w = world();
    const { lease, plan } = await planned(w);
    await expect(w.activities.applyInfrastructure({ operationId: OP, planDigest: "../../etc/passwd", lease })).rejects.toBeInstanceOf(StepFailedError);
    await expect(w.activities.applyInfrastructure({ operationId: OP, planDigest: plan.planDigest, lease: { ...lease, scope: "env:other" } })).rejects.toBeInstanceOf(StepFailedError);
    expect(w.tofu.applyCalls).toHaveLength(0);
  });

  it("does not turn a real apply into an error because the evidence ledger hiccuped: it retries, then logs", async () => {
    const w = world();
    const { lease, plan } = await planned(w);
    w.evidence.failNext = 2; // the first two writes fail; the third lands
    const result = await w.activities.applyInfrastructure({ operationId: OP, planDigest: plan.planDigest, lease });
    expect(result.applied).toBe(1);
    expect(w.evidence.ofKind("tofu_apply")).toHaveLength(1);

    const w2 = world();
    const p2 = await planned(w2);
    w2.evidence.failNext = 10; // the ledger is down for good
    const out = await w2.activities.applyInfrastructure({ operationId: OP, planDigest: p2.plan.planDigest, lease: p2.lease });
    expect(out.applied).toBe(1);
    expect(w2.logs.some((l) => l.level === "error" && l.message.includes("evidence append failed after the action"))).toBe(true);
  });

  it("is idempotent on its evidence and events when the activity is retried", async () => {
    const w = world();
    const { lease, plan } = await planned(w);
    await w.activities.applyInfrastructure({ operationId: OP, planDigest: plan.planDigest, lease });
    await w.activities.applyInfrastructure({ operationId: OP, planDigest: plan.planDigest, lease });
    expect(w.evidence.ofKind("tofu_apply")).toHaveLength(1);
    expect(w.events.ofType("resource.applied")).toHaveLength(1);
    expect(w.events.ofType("resource.applying")).toHaveLength(1);
  });
});

/** Real PostgreSQL authority and pinned OpenTofu; hosted association, scope, credentials and drivers are explicit fixtures. */
import { randomBytes, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { vi } from "vitest";
import { createExecutionActivities } from "@/lib/execution/activities";
import { createPlatformPorts, executionHolder } from "@/lib/execution/platform";
import { createExecutionBroker } from "@/lib/platform/broker";
import { createIsolatedPlanArtifactRuntimeForTests } from "@/lib/platform/plan-artifacts";
import { PG_URL, makeHarness, closeSharedPgliteAfterAll, scriptedEngine, requireApproval, allowDecision, sessionFor, user } from "../capabilities/support";
import { tofuOnPath } from "../tofu/_helpers";
import { connectionConfig } from "./fakes/fixtures";
import * as repos from "@/lib/controlplane/db/repos";
import { openPlatformDb, json, type PlatformDbHandle } from "@/lib/controlplane/db";
import { createApprovedSourceSnapshotStore } from "@/lib/controlplane/db/repos/approved-source-snapshots";
import { operationPlanReview } from "@/lib/controlplane/db/repos/operation-review";
import { createPlatformSemanticsStore } from "@/lib/controlplane/db/repos/executable-semantics";
import type { Sql } from "@/lib/controlplane/types";
closeSharedPgliteAfterAll();

vi.mock("@/lib/controlplane/db/repos/workflow-start-deploy-authority", async original => ({
  ...await original<typeof import("@/lib/controlplane/db/repos/workflow-start-deploy-authority")>(),
  // Hosted association is modeled exactly as in the native product-authority
  // fixture. Native product/source/member/approval predicates remain real.
  assertFinalMcpProductTopology: async (owner: Sql, tx: Sql) => {
    if (owner === tx) throw new Error("Modeled hosted association requires the owning transaction.");
    const rows = await tx.query<{ role: string }>("select current_user as role");
    if (rows.length !== 1 || !rows[0].role) throw new Error("Modeled hosted association is unavailable.");
  },
}));

function dispatchBarrier() {let release!:()=>void;const promise=new Promise<void>(resolve=>{release=resolve;});return {release,promise};}
if (process.env.ZENITH_TEST_PLAN_PRODUCT_AUTHORITY_REQUIRED === "1" && (!PG_URL || !tofuOnPath() || process.env.ZENITH_TEST_TOFU_NETWORK !== "1")) {
  throw new Error("Dispatch authority requires owning PostgreSQL and the pinned OpenTofu lane.");
}
describe.skipIf(!PG_URL || !tofuOnPath() || process.env.ZENITH_TEST_TOFU_NETWORK!=="1")("dispatch current authority [postgres]",()=>{
  let peer: PlatformDbHandle;
  beforeAll(async () => {
    peer = await openPlatformDb({ kind: "postgres", url: PG_URL!, migrate: true, max: 1 });
    const migration = await readFile(new URL("../../supabase/migrations/0001_system_of_record.sql", import.meta.url), "utf8");
    for (const name of ["workspaces", "members", "projects", "environments", "revisions", "revision_manifests", "deployments", "connections"]) {
      const ddl = new RegExp(`create table if not exists public\\.${name} \\([\\s\\S]*?\\n\\);`).exec(migration)?.[0];
      if (!ddl) throw new Error("Canonical product collection DDL is unavailable.");
      await peer.exec(ddl);
    }
  }, 60000);
  afterAll(async () => { await peer?.close(); });
  async function currentAuthorityCase(mode: string) {
    const h=await makeHarness({kind:"postgres",engine:scriptedEngine("original-dispatch-policy",input=>input.plan?requireApproval(1,"admin"):allowDecision())});
    h.deps.clock={now:()=>new Date()};
    const w=world();const scope={workspaceId:h.ids.wsA,projectId:h.ids.projA,environmentId:h.ids.envASbx};
    const revisionId = `rev_${randomUUID()}`, deploymentId = `dep_${randomUUID()}`, publicConnectionId = `public_${randomUUID()}`;
    w.product.revisions.clear(); w.product.setManifest(bucketManifest(), revisionId);
    w.product.base.workspace.id=scope.workspaceId;w.product.base.project.id=scope.projectId;w.product.base.environment.id=scope.environmentId;w.product.base.environment.class="sandbox";
    h.world.environments.set(scope.environmentId, { projectId: scope.projectId, class: "sandbox", provider: "aws", region: connectionConfig.region });
    vi.spyOn(w.product,"loadContext").mockImplementation(async input=>({...structuredClone(w.product.base),revision:structuredClone(w.product.revisions.get(revisionId)!),...(input.deploymentId?{deploymentId:input.deploymentId}:{})}));
    const connection=await repos.connections.create(h.db!,{workspaceId:scope.workspaceId,createdBy:"dispatch-authority-fixture",legacyConnectionId:publicConnectionId,config:connectionConfig});
    const verified=await repos.connections.recordVerification(h.db!,{workspaceId:scope.workspaceId,id:connection.id,ok:true});
    if(!verified || verified.status!=="verified")throw new Error("Dispatch fixture connection was not verified.");
    w.product.base.environment.connectionId=publicConnectionId;
    const environment = w.product.base.environment, manifest = w.product.revisions.get(revisionId)!.manifest;
    await peer.query("insert into public.workspaces(id,workspace_id,slug,name,data) values($1,$1,$2,'Owning dispatch','{}'::jsonb)", [scope.workspaceId, `dispatch-${randomUUID()}`]);
    await peer.query("insert into public.members(id,workspace_id,email,role,data) values('alice',$1,'alice@example.test','admin','{}'::jsonb),('erin',$1,'erin@example.test','admin','{}'::jsonb)", [scope.workspaceId]);
    await peer.query("insert into public.projects(id,workspace_id,slug,name,data) values($1,$2,'dispatch','Owning dispatch',$3::text::jsonb)", [scope.projectId, scope.workspaceId, json({ workingManifest: manifest })]);
    await peer.query("insert into public.connections(id,workspace_id,provider,status,data) values($1,$2,'aws','healthy',$3::text::jsonb)", [publicConnectionId, scope.workspaceId, json({ region: environment.region, platformConnectionId: verified.id })]);
    await peer.query("insert into public.environments(id,workspace_id,project_id,class,connection_id,data) values($1,$2,$3,'sandbox',$4,$5::text::jsonb)",
      [scope.environmentId, scope.workspaceId, scope.projectId, publicConnectionId, json({ name: environment.name, region: environment.region, baseDomain: environment.baseDomain, policies: environment.policies })]);
    await peer.query("insert into public.revisions(id,workspace_id,project_id,number,data) values($1,$2,$3,1,'{}'::jsonb)", [revisionId, scope.workspaceId, scope.projectId]);
    await peer.query("insert into public.revision_manifests(revision_id,workspace_id,manifest) values($1,$2,$3::text::jsonb)", [revisionId, scope.workspaceId, json(manifest)]);
    const roleEntered = dispatchBarrier(), roleRelease = dispatchBarrier();
    let armed=false,postPlanAuthorityChecks=0,expiredAfterApprovedAuthority=false,approvalId: string | undefined;
    h.deps.roles={resolve:async(principal,workspaceId)=>{
      const rows = principal.kind === "user" ? await h.db!.query<{ role: "viewer" | "editor" | "admin" }>("select role from public.members where workspace_id=$1 and id=$2", [workspaceId, principal.id]) : [];
      const role = rows.length === 1 && ["viewer", "editor", "admin"].includes(rows[0].role) ? rows[0].role : "none";
      if(armed && mode==="expiry during role lookup" && principal.id==="erin") { roleEntered.release(); await roleRelease.promise; }
      return { role };
    }};
    const proposed=await h.broker.propose({capability:"deployment.deploy",scope,input:{revisionId,deploymentId}},user("alice"));
    const operationId=proposed.operation.id;
    await peer.query("insert into public.deployments(id,workspace_id,project_id,environment_id,revision_id,status,data) values($1,$2,$3,$4,$5,'planning',$6::text::jsonb)",
      [deploymentId, scope.workspaceId, scope.projectId, scope.environmentId, revisionId, json({ executor: "workflow", operationId })]);
    await h.broker.beginExecution({workspaceId:scope.workspaceId,operationId,holder:`workflow:${operationId}`,audience:"worker",leaseMs:120000});
    const ports=createPlatformPorts(h.db!);const canonicalBroker=createExecutionBroker(h.db!,async()=>h.broker);
    const broker={...canonicalBroker,approvalStatus:async(id:string)=>{
      const result=await canonicalBroker.approvalStatus(id);
      if(armed)postPlanAuthorityChecks++;
      if(armed && postPlanAuthorityChecks===2 && mode==="expiry after authority check") {
        if (!approvalId) throw new Error("Exact approved native row is unavailable.");
        expect(result.approved).toBe(true); expect(result.dispatchApproval?.approvalIds).toEqual([approvalId]);
        expect(await peer.query("update platform.approvals set expires_at=clock_timestamp()-interval '1 second' where workspace_id=$1 and operation_id=$2 and id=$3 returning id", [scope.workspaceId, id, approvalId])).toEqual([{ id: approvalId }]);
        expiredAfterApprovedAuthority = true;
      }
      return result;
    }};
    const runtime=createIsolatedPlanArtifactRuntimeForTests(h.db!,{...process.env,ZENITH_PLAN_ARTIFACT_KEY:randomBytes(32).toString("hex"),ZENITH_WORKER_PLAN_DIR:w.planDir},broker);
    const entered=dispatchBarrier(),release=dispatchBarrier();const state=path.join(w.planDir,"customer-state.tfstate");
    const tofu={planWorkspace:runtime.tofu.planWorkspace,applyVerifiedPlan:(ws:Parameters<typeof runtime.tofu.applyVerifiedPlan>[0],args:Parameters<typeof runtime.tofu.applyVerifiedPlan>[1])=>
      runtime.tofu.applyVerifiedPlan(ws,{...args,beforeDispatch:async()=>{entered.release();await release.promise;await args.beforeDispatch?.();}})};
    const activities=createExecutionActivities({...w.deps,...ports,broker,tofu,planArtifacts:runtime.planArtifacts,sourceSnapshots:createApprovedSourceSnapshotStore(h.db!),semantics:createPlatformSemanticsStore(h.db!),
      tofuWorkspace:{providerSet:()=>"builtin",backend:()=>({backend:{kind:"local",path:state}})},clock:()=>new Date(),limits:{heartbeatIntervalMs:1000}});
    await activities.validateDesiredState({operationId});const lease=await activities.acquireLease({operationId,scope:`env:${scope.environmentId}`,ttlMs:120000});
    try {
      const plan=await activities.planInfrastructure({operationId,lease});
      expect(await peer.query("select phase from platform.plan_artifact_uses where workspace_id=$1 and operation_id=$2", [scope.workspaceId, operationId])).toEqual([{ phase: "ready" }]);
      const published = await peer.query<{ summary: { kind: string; phase: string } }>("select summary from platform.evidence where workspace_id=$1 and operation_id=$2 and kind='observation' and summary->>'stage'='original_plan_product_authority'", [scope.workspaceId, operationId]);
      expect(published).toHaveLength(1); expect(published[0].summary).toMatchObject({ kind: "product", phase: "published" });
      expect(await peer.query("select service_address from platform.approved_source_snapshots where workspace_id=$1 and operation_id=$2", [scope.workspaceId, operationId])).toEqual([]);
      expect((await activities.evaluatePolicy({operationId,planDigest:plan.planDigest})).outcome).toBe("require_approval");
      await ports.ops.transition({workspaceId:scope.workspaceId,operationId,to:"awaiting_approval"});
      const operation = await h.store.getOperation(scope.workspaceId, operationId);
      if (!operation) throw new Error("The human approval fixture cannot read the reviewed operation.");
      const review = operationPlanReview(operation);
      if (!review?.semantics) throw new Error("The human approval fixture cannot read the reviewed executable semantics.");
      expect(review.planDigest).toBe(plan.planDigest);
      expect(await peer.query("select semantics_digest from platform.approved_semantics where workspace_id=$1 and operation_id=$2 and plan_digest=$3", [scope.workspaceId, operationId, plan.planDigest]))
        .toEqual([{ semantics_digest: review.semantics.digest }]);
      const auditWrites = vi.spyOn(h.store, "appendEvent");
      const approval = await h.broker.approve({workspaceId:scope.workspaceId,operationId,proposalDigest:proposed.operation.proposalDigest,planDigest:plan.planDigest,semanticsDigest:review.semantics.digest,approver:user("erin"),session:sessionFor("erin")});
      const bindingIndexes = auditWrites.mock.calls.flatMap(([input], index) => input.data?.kind === "approval_semantics_bound" ? [index] : []);
      expect(bindingIndexes, "the real broker attempts exactly one reviewed-semantics audit write").toHaveLength(1);
      await expect(auditWrites.mock.results[bindingIndexes[0]].value, "the actual audit writer promise must succeed even if the broker catches its error").resolves.toEqual(expect.any(Number));
      expect(await peer.query("select data from platform.events where workspace_id=$1 and operation_id=$2 and type='policy.evaluated' and data->>'kind'='approval_semantics_bound'", [scope.workspaceId, operationId]))
        .toEqual([{ data: { kind: "approval_semantics_bound", approvalId: approval.approval.id, semanticsDigest: review.semantics.digest, planDigest: plan.planDigest } }]);
      const approved = await peer.query<{ id: string; proposal_digest: string; approval_round: number }>("select id,proposal_digest,approval_round from platform.approvals where workspace_id=$1 and operation_id=$2 and id=$3 and decision='approve' and approver->>'id'='erin'", [scope.workspaceId, operationId, approval.approval.id]);
      expect(approved).toHaveLength(1); expect(approved[0].proposal_digest).toBe(proposed.operation.proposalDigest); expect(approved[0].approval_round).toBeGreaterThan(0); approvalId = approved[0].id;
      await repos.operations.claimForExecution(h.db!, { workspaceId: scope.workspaceId, id: operationId,
        expectedDigest: proposed.operation.proposalDigest, holder: executionHolder(operationId), leaseMs: 120000,
        lease, expectedPolicyVersion: "original-dispatch-policy" });
      expect(await peer.query("select status,lease_scope,fence_token from platform.operations where workspace_id=$1 and id=$2", [scope.workspaceId, operationId]))
        .toEqual([{ status: "running", lease_scope: lease.scope, fence_token: lease.fenceToken }]);
      const applying=activities.applyInfrastructure({operationId,planDigest:plan.planDigest,lease});
      const completed = mode === "unchanged authority" ? applying : expect(applying).rejects.toThrow();
      await Promise.race([entered.promise, applying.then(() => { throw new Error("Apply completed before its dispatch barrier."); }, () => { throw new Error("Apply refused before its dispatch barrier."); })]);
      expect(await peer.query("select phase from platform.plan_artifact_uses where workspace_id=$1 and operation_id=$2", [scope.workspaceId, operationId])).toEqual([{ phase: "claimed" }]);
      const consumed = await peer.query<{ id: string; consumed_at: string | null }>("select id,consumed_at from platform.approvals where workspace_id=$1 and operation_id=$2 and id=$3", [scope.workspaceId, operationId, approvalId]);
      expect(consumed).toHaveLength(1); expect(consumed[0].consumed_at).not.toBeNull();
      // A grant was already issued, and the actual original/fresh inspections finished before this barrier.
      if(mode==="expired approval")expect(await peer.query("update platform.approvals set expires_at=clock_timestamp()-interval '1 second' where workspace_id=$1 and operation_id=$2 and id=$3 returning id", [scope.workspaceId, operationId, approvalId])).toEqual([{ id: approvalId }]);
      if(mode==="revoked approver role")expect(await peer.query("update public.members set role='viewer' where workspace_id=$1 and id='erin' returning id,role", [scope.workspaceId])).toEqual([{ id: "erin", role: "viewer" }]);
      if(mode==="new policy denial")h.setEngine(scriptedEngine("denied-before-dispatch",()=>({outcome:"deny",reasons:[{code:"changed",message:"Policy changed."}]})));
      armed=true;release.release();
      if(mode==="expiry during role lookup") {
        await Promise.race([roleEntered.promise, applying.then(() => { throw new Error("Apply completed before its held approver lookup."); }, () => { throw new Error("Apply refused before its held approver lookup."); })]);
        expect(await peer.query("update platform.approvals set expires_at=clock_timestamp()-interval '1 second' where workspace_id=$1 and operation_id=$2 and id=$3 returning id", [scope.workspaceId, operationId, approvalId])).toEqual([{ id: approvalId }]);
        roleRelease.release();
      }
      const outcome = await completed;
      if (mode === "expiry after authority check") expect(expiredAfterApprovedAuthority).toBe(true);
      if (mode === "unchanged authority") {
        expect(postPlanAuthorityChecks).toBeGreaterThanOrEqual(2);
        expect(outcome).toMatchObject({ applied: 1 });
        expect(await readFile(state).catch(()=>null)).not.toBeNull();
        expect(await peer.query("select phase from platform.plan_artifact_uses where workspace_id=$1 and operation_id=$2", [scope.workspaceId, operationId])).toEqual([{ phase: "succeeded" }]);
        expect(await peer.query("select id from platform.evidence where workspace_id=$1 and operation_id=$2 and kind='tofu_apply'", [scope.workspaceId, operationId])).toHaveLength(1);
      } else {
        expect(await readFile(state).catch(()=>null)).toBeNull();
        expect(await peer.query("select phase from platform.plan_artifact_uses where workspace_id=$1 and operation_id=$2",[scope.workspaceId,operationId])).toEqual([{phase:"ready"}]);
        expect(await peer.query("select id from platform.evidence where workspace_id=$1 and operation_id=$2 and kind='tofu_apply'",[scope.workspaceId,operationId])).toHaveLength(0);
      }
    } finally {release.release();roleRelease.release();await activities.releaseLease({lease});}
  }
  it.each(["expired approval","revoked approver role","new policy denial","expiry after authority check","expiry during role lookup"])("refuses %s after fresh replan and before durable dispatch",currentAuthorityCase,240000);
  it("continues unchanged native product authority after fresh replan through the exact approved original plan", () => currentAuthorityCase("unchanged authority"), 240000);
});
