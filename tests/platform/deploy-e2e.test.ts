/** Contract evidence: real Temporal/native authority, explicit file-to-PGlite product projection, isolated plan bytes and modeled AWS/hosted association. */
import { beforeAll, afterAll, beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { Context } from "@temporalio/activity";
import { defaultPayloadConverter } from "@temporalio/common";
import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { World } from "../execution/fakes/world";
import type { WorkflowResult, WorkerActivities, StepName } from "@/lib/workflows/types";
import type { Sql } from "@/lib/controlplane/types";
import type { MigrationsPort } from "@/lib/execution/ports";
import { tempDataDir } from "../_support/data-dir";

vi.mock("@/lib/controlplane/db/repos/workflow-start-deploy-authority", async original => ({
  ...await original<typeof import("@/lib/controlplane/db/repos/workflow-start-deploy-authority")>(),
  // Only hosted REST/SQL association is modeled. The actual owning SQL
  // transaction and every product/source/member/approval predicate remain real.
  assertFinalMcpProductTopology: async (owner: Sql, tx: Sql) => {
    if (owner === tx) throw new Error("Modeled hosted association requires the owning transaction.");
    const rows = await tx.query<{ role: string }>("select current_user as role");
    if (rows.length !== 1 || !rows[0].role) throw new Error("Modeled hosted association is unavailable.");
  },
}));

tempDataDir("zenith-compose-e2e-", { fast: true });
const { db: productFixture, resetDb, save, q } = await import("@/lib/db/store");
const { openPlatformDb, repos } = await import("@/lib/controlplane/db");
const { operationPlanReview } = await import("@/lib/controlplane/db/repos/operation-review");
const { createBroker } = await import("@/lib/capabilities/platform");
const { PlatformBrokerStore } = await import("@/lib/capabilities/platform-store");
const { productRoleResolver, productScopeResolver } = await import("@/lib/capabilities/product-adapters");
const { CredentialGrantSigner } = await import("@/lib/capabilities/credential-signer");
const { loadPolicyEngine } = await import("@/lib/policy");
const { generateSigningJwk, serializePrivateJwk, resetSignerCache } = await import("@/lib/credentials/signing");
const { composeExecutionActivities } = await import("@/lib/platform/execution");
const { createExecutionBroker } = await import("@/lib/platform/broker");
const { approvalRoundOf } = await import("@/lib/controlplane/db/repos/operation-review");
const { createProductPort, executionHolder, CLAIM_LEASE_MS } = await import("@/lib/execution");
const { createSafeProber } = await import("@/lib/execution/prober");
const { buildDesiredState } = await import("@/lib/execution/graph");
const { startDeploy } = await import("@/lib/workflows/client");
const { createExecutionWorker } = await import("../../workers/execution/run");
const { executionWorkerConfigFromEnv } = await import("../../workers/execution/config");
const { startTestServer, workflowBundlePath, uniqueId, findTemporalCli, waitFor } = await import("../workflows/support");
const { LeaseLostError } = await import("@/lib/execution/errors");
const { createWorld,createSqlPlanArtifactFixture } = await import("../execution/fakes/world");
const { webDbManifest, migratingManifest, makePlan, change, connectionConfig, WS, PROJECT, ENV, REVISION, DEPLOYMENT, PRODUCT_CONNECTION, PLATFORM_CONNECTION } = await import("../execution/fakes/fixtures");
const { mockAwsCloud, SESSION_CANARY } = await import("./aws-cloud");

const author = { type: "user" as const, id: "local", name: "Requester" };
const requester = { kind: "user" as const, id: "local", name: "Requester" };
const approver = { kind: "user" as const, id: "approver", name: "Reviewer" };
const image = `ghcr.io/acme/web@sha256:${"a".repeat(64)}`;
let db: Awaited<ReturnType<typeof openPlatformDb>>;
let server: Awaited<ReturnType<typeof startTestServer>>["server"];
let skipReason: string | undefined;
let bundle: string, planDir: string;
let cloud: ReturnType<typeof mockAwsCloud>;
let tofu: World["tofu"];
let custodyWorld:World;
let broker: ReturnType<typeof createBroker>;
let activities: WorkerActivities;
const reviewedPlan = makePlan({ changes: [change({ address: "aws_db_instance.postgres_db", nodeAddress: "postgres/db", type: "aws_db_instance", action: "create", changes: [{ path: "publicly_accessible", before: false, after: false, sensitive: false, forcesReplacement: false }] })] });

// The file product store and native PGlite are separate fixture stores. These
// explicit setup boundaries project only the known owning fixture into the
// canonical public collections; they never repair authority before dispatch.
async function seedOwningProductProjection() {
  const migration = await readFile(new URL("../../supabase/migrations/0001_system_of_record.sql", import.meta.url), "utf8");
  for (const name of ["workspaces", "members", "projects", "environments", "revisions", "revision_manifests", "deployments", "connections"] as const) {
    const ddl = new RegExp(`create table if not exists public\\.${name} \\([\\s\\S]*?\\n\\);`).exec(migration)?.[0];
    if (!ddl) throw new Error("Canonical product collection DDL is unavailable.");
    await db.exec(ddl);
  }
  const workspace = productFixture().workspaces.find(row => row.id === WS)!;
  const project = q.project(PROJECT)!, environment = q.environment(ENV)!, revision = q.revision(REVISION)!, connection = q.connection(PRODUCT_CONNECTION)!;
  expect(project.workspaceId).toBe(WS); expect(environment.projectId).toBe(project.id);
  expect(revision.projectId).toBe(project.id); expect(connection.workspaceId).toBe(WS);
  await db.query("insert into public.workspaces(id,workspace_id,slug,name,data) values($1,$1,$2,$3,$4::text::jsonb)", [workspace.id, workspace.slug, workspace.name, JSON.stringify(workspace)]);
  await db.query("insert into public.projects(id,workspace_id,slug,name,data) values($1,$2,$3,$4,$5::text::jsonb)", [project.id, project.workspaceId, project.slug, project.name, JSON.stringify(project)]);
  await db.query("insert into public.environments(id,workspace_id,project_id,class,connection_id,deployed_revision_id,active_deployment_id,data) values($1,$2,$3,$4,$5,$6,$7,$8::text::jsonb)",
    [environment.id, project.workspaceId, environment.projectId, environment.class, environment.connectionId, environment.deployedRevisionId ?? null, environment.activeDeploymentId ?? null, JSON.stringify(environment)]);
  await db.query("insert into public.connections(id,workspace_id,provider,status,data) values($1,$2,$3,$4,$5::text::jsonb)", [connection.id, connection.workspaceId, connection.provider, connection.status, JSON.stringify(connection)]);
  await db.query("insert into public.revisions(id,workspace_id,project_id,number,data) values($1,$2,$3,$4,$5::text::jsonb)", [revision.id, project.workspaceId, revision.projectId, revision.number, JSON.stringify(revision)]);
  await db.query("insert into public.revision_manifests(revision_id,workspace_id,manifest) values($1,$2,$3::text::jsonb)", [revision.id, project.workspaceId, JSON.stringify(revision.manifest)]);
  for (const id of [requester.id, approver.id]) {
    const member = productFixture().members.find(row => row.workspaceId === WS && row.id === id)!;
    await db.query("insert into public.members(id,workspace_id,email,role,data) values($1,$2,$3,$4,$5::text::jsonb)", [member.id, member.workspaceId, member.email, member.role, JSON.stringify(member)]);
  }
}
async function projectOwningDeployment(deploymentId: string) {
  const deployment = q.deployment(deploymentId)!;
  expect(deployment.projectId).toBe(PROJECT); expect(deployment.environmentId).toBe(ENV); expect(deployment.revisionId).toBe(REVISION);
  expect(deployment.executor).toBe("workflow"); expect(deployment.operationId).toBeTruthy();
  const operation = (await repos.operations.get(db, WS, deployment.operationId!))!;
  expect(operation.projectId).toBe(PROJECT); expect(operation.environmentId).toBe(ENV);
  expect(operation.proposal.input).toMatchObject({ revisionId: REVISION, deploymentId: deployment.id });
  await db.query("insert into public.deployments(id,workspace_id,project_id,environment_id,revision_id,status,data) values($1,$2,$3,$4,$5,$6,$7::text::jsonb) on conflict(id) do update set status=excluded.status,data=excluded.data",
    [deployment.id, WS, deployment.projectId, deployment.environmentId, deployment.revisionId, deployment.status, JSON.stringify(deployment)]);
}

beforeAll(async () => {
  // Network-dependent downloads are opt-in. Installed CLI always uses its own random port.
  const timeSkipping = process.env.ZENITH_COMPOSE_TEMPORAL_MODE === "time-skipping";
  if (timeSkipping || findTemporalCli() || process.env.ZENITH_TEST_TEMPORAL_DOWNLOAD === "1") {
    const started = await startTestServer(timeSkipping ? "time-skipping" : "local"); server = started.server; skipReason = started.skipReason;
  } else skipReason = "Temporal CLI unavailable. Set ZENITH_TEST_TEMPORAL_CLI to the installed binary; downloads require ZENITH_TEST_TEMPORAL_DOWNLOAD=1.";
  if (server) bundle = await workflowBundlePath();
  planDir = await mkdtemp(path.join(os.tmpdir(), "zenith-compose-plan-"));
  vi.stubEnv("ZENITH_CONTROL_SIGNING_JWK", serializePrivateJwk(await generateSigningJwk("EdDSA")));
  resetSignerCache();
}, 180_000);
beforeEach(async () => {
  db = await openPlatformDb({ kind: "pglite" });
  const manifest = webDbManifest(); manifest.services[0].source = { type: "image", image };
  const at = new Date().toISOString();
  resetDb({
    workspaces: [{ id: WS, name: "Atlas", slug: "atlas", createdAt: at }],
    members: [{ id: "local", workspaceId: WS, name: "Requester", email: "requester@example.test", role: "admin" }, { id: "approver", workspaceId: WS, name: "Reviewer", email: "reviewer@example.test", role: "admin" }],
    connections: [{ id: PRODUCT_CONNECTION, workspaceId: WS, provider: "aws", label: "AWS contract", region: "us-east-1", status: "healthy", grantedPermissions: [], createdAt: at }],
    projects: [{ id: PROJECT, workspaceId: WS, name: "Atlas", slug: "atlas", workingManifest: manifest, createdAt: at, origin: { type: "blank" } }],
    environments: [{ id: ENV, projectId: PROJECT, name: "production", class: "production", connectionId: PRODUCT_CONNECTION, region: "us-east-1", policies: { approvalRequired: true, allowStatefulDeletion: false }, baseDomain: "atlas.zenith.test", createdAt: at }],
    revisions: [{ id: REVISION, projectId: PROJECT, number: 1, manifest, message: "contract deployment", author, createdAt: at }],
    deployments: [{ id: DEPLOYMENT, projectId: PROJECT, environmentId: ENV, revisionId: REVISION, status: "planning", steps: [], outputs: [], changeSummary: "deploy", estCostDeltaUsd: 0, actor: author, createdAt: at }],
  }); save();
  await repos.connections.create(db, { id: PLATFORM_CONNECTION, workspaceId: WS, legacyConnectionId: PRODUCT_CONNECTION, createdBy: "local", config: { ...connectionConfig, mode: "aws_assume_role", externalId: "zenith-contract-external-id" } });
  await repos.connections.recordVerification(db, { workspaceId: WS, id: PLATFORM_CONNECTION, ok: true, detail: "Contract fixture; no cloud identity was checked." });
  const nativeConnection = (await repos.connections.get(db, WS, PLATFORM_CONNECTION))!;
  expect(nativeConnection.legacyConnectionId).toBe(PRODUCT_CONNECTION);
  q.connection(PRODUCT_CONNECTION)!.platformConnectionId = nativeConnection.id; save();
  await seedOwningProductProjection();
  broker = createBroker({ store: new PlatformBrokerStore(db), scopes: productScopeResolver(), roles: productRoleResolver(), signer: new CredentialGrantSigner(), clock: { now: () => new Date() }, policy: () => loadPolicyEngine() });
  const product = await createProductPort().loadContext({ workspaceId: WS, environmentId: ENV, revisionId: REVISION, deploymentId: DEPLOYMENT });
  const desired = buildDesiredState(product); expect(desired.problems).toEqual([]); expect(desired.graph).toBeDefined();
  cloud = mockAwsCloud(desired.graph!, WS, ENV, image);
  custodyWorld=createWorld();tofu=custodyWorld.tofu; tofu.planFactory = () => reviewedPlan;
  activities = composed();
}, 60_000);
afterEach(async () => { cloud?.restore(); custodyWorld?.dispose(); await db?.close(); });
afterAll(async () => { await server?.env.teardown(); vi.unstubAllEnvs(); resetSignerCache(); });
function composed(temporal = true, overrides: { migrations?: MigrationsPort } = {}) {
  const prober = createSafeProber({ resolve: async () => [{ address: "8.8.8.8", family: 4 }], transport: async (req) => {
    expect(req.host).toBe("app.atlas.zenith.test"); expect(req.path).toBe("/healthz");
    return { status: 200, latencyMs: 5, bytes: 2, truncated: false, bodyDigest: "0".repeat(64), tlsExpiresAt: new Date(Date.now() + 365 * 86400_000).toISOString() };
  } });
  const executionBroker=createExecutionBroker(db,async()=>broker);
  return composeExecutionActivities({ db, workerIdentity: "compose-contract", planDir, secretKey: "1".repeat(64), ports: { tofu, planArtifacts:createSqlPlanArtifactFixture(custodyWorld,db,executionBroker), prober, broker: executionBroker, heartbeat: temporal ? (d) => Context.current().heartbeat(d) : () => undefined, activitySignal: temporal ? () => Context.current().cancellationSignal : () => undefined, ...overrides } });
}

// Same approval and rollout as the rollout test, but on a revision that declares a release migration. The one-off
// migration runner is an injected fake (the AWS task itself is not modeled); the broker and policy are the real ones.
async function migratingReleaseThroughRollout(runOneOffTask: MigrationsPort["runOneOffTask"]) {
  const manifest = migratingManifest();
  manifest.services[0].source = { type: "image", image };
  manifest.release = { migrate: { ...manifest.release!.migrate!, class: "expand" } };
  q.revision(REVISION)!.manifest = manifest; save();
  await db.query("update public.revision_manifests set manifest=$2::text::jsonb where revision_id=$1", [REVISION, JSON.stringify(manifest)]);
  activities = composed(false, { migrations: { runOneOffTask } });
  const operationId = await approvedOperation();
  await activities.validateDesiredState({ operationId });
  let lease = await activities.acquireLease({ operationId, scope: `env:${ENV}`, ttlMs: 180_000 });
  const plan = await activities.planInfrastructure({ operationId, lease });
  await activities.evaluatePolicy({ operationId, planDigest: plan.planDigest });
  lease = await planRound(operationId, lease);
  await activities.finalPlan({ operationId, approvedPlanDigest: plan.planDigest, lease });
  await activities.applyInfrastructure({ operationId, planDigest: plan.planDigest, lease });
  const built = await activities.buildArtifacts({ operationId, lease });
  await activities.deployWorkloads({ operationId, lease, images: built.images });
  return { operationId, lease };
}

async function approvedOperation() {
  const proposal = await broker.propose({ capability: "deployment.deploy", scope: { workspaceId: WS, projectId: PROJECT, environmentId: ENV }, input: { revisionId: REVISION, deploymentId: DEPLOYMENT }, idempotencyKey: uniqueId("deploy") }, requester, { via: "workflow" });
  expect(proposal.decision.outcome).toBe("require_approval");
  expect(proposal.operation.status).toBe("awaiting_approval");
  const deployment = q.deployment(DEPLOYMENT)!;
  deployment.executor = "workflow"; deployment.operationId = proposal.operation.id; save();
  await projectOwningDeployment(deployment.id);
  await expect(broker.approve({ workspaceId: WS, operationId: proposal.operation.id, proposalDigest: proposal.operation.proposalDigest, approver: { kind: "navigator", id: "model", name: "Model", onBehalfOf: "approver" }, session: { method: "browser_session", subject: "approver", verifiedAtMs: Date.now() } })).rejects.toThrow();
  await broker.approve({ workspaceId: WS, operationId: proposal.operation.id, proposalDigest: proposal.operation.proposalDigest, approver, session: { method: "browser_session", subject: "approver", verifiedAtMs: Date.now() } });
  await broker.beginExecution({ workspaceId: WS, operationId: proposal.operation.id, holder: executionHolder(proposal.operation.id), leaseMs: CLAIM_LEASE_MS, audience: "worker" });
  return proposal.operation.id;
}
async function approvePlan(operationId: string) {
  const op = (await repos.operations.get(db, WS, operationId))!;
  await broker.approve({ workspaceId: WS, operationId, proposalDigest: op.proposalDigest, planDigest: op.planDigest, semanticsDigest: operationPlanReview(op)?.semantics?.digest, approver, session: { method: "browser_session", subject: approver.id, verifiedAtMs: Date.now() } });
}
async function planRound(operationId: string, lease: Awaited<ReturnType<WorkerActivities["acquireLease"]>>) {
  expect(await activities.checkApproval({ operationId })).toMatchObject({ approved: false, rejected: false });
  await activities.releaseLease({ lease });
  await activities.markOperation({ operationId, status: "awaiting_approval" });
  await approvePlan(operationId);
  await activities.markOperation({ operationId, status: "running" });
  const resumed = await activities.acquireLease({ operationId, scope: `env:${ENV}`, ttlMs: 180_000 });
  expect(resumed.fenceToken).toBeGreaterThan(lease.fenceToken);
  return resumed;
}
async function runDeploy(operationId: string, during?: () => Promise<void>, review: (id: string) => Promise<void> = approvePlan) {
  const taskQueue = uniqueId("compose-queue");
  const config = executionWorkerConfigFromEnv({ ZENITH_TEMPORAL_ADDRESS: server!.env.address, ZENITH_WORKER_TASK_QUEUE: taskQueue, ZENITH_WORKER_SHUTDOWN_GRACE_MS: "2000" });
  const worker = await createExecutionWorker({ config, connection: server!.env.nativeConnection, activities, workflows: { workflowBundle: { codePath: bundle }, origin: "prebuilt-bundle" } });
  return worker.runUntil(async () => {
    const started = await startDeploy({ operationId, workspaceId: WS, projectId: PROJECT, environmentId: ENV, connectionId: PLATFORM_CONNECTION, revisionId: REVISION, deploymentId: DEPLOYMENT, build: true, preApproved: false }, { client: server!.env.client, taskQueue });
    const handle = server!.env.client.workflow.getHandle(started.workflowId);
    const pending: Promise<WorkflowResult> = handle.result();
    // The production proposal was approved without a plan. A separate round
    // must now approve the concrete plan, even for a pre-approved workflow.
    await (async () => {
      const { waitFor } = await import("../workflows/support");
      const op = await waitFor("plan gate", async () => {
        const current = await repos.operations.get(db, WS, operationId);
        return current && ["awaiting_approval", "failed", "denied", "cancelled", "uncertain", "expired"].includes(current.status) ? current : false;
      });
      if (op.status !== "awaiting_approval") return;
      expect((op as typeof op & { approvalRound: number }).approvalRound).toBe(1);
      await review(operationId);
      const { signalApproval } = await import("@/lib/workflows/client");
      await signalApproval(operationId, { client: server!.env.client });
    })();
    if (during) await Promise.race([during(), pending.then((r) => { throw new Error(`Workflow ended before the held apply: ${r.status}`); })]);
    const result = await pending;
    return { result, history: await handle.fetchHistory() };
  });
}

describe("composed deploy workflow (contract evidence)", () => {
  it("proposes through the bridge without a plan, records two browser rounds, signals, and resumes with a new fence", async (ctx) => {
    if (!server) { console.warn(skipReason); ctx.skip(); }
    const { setBridgeDepsForTests } = await import("@/lib/bridge/deps");
    const { startWorkflowDeployment } = await import("@/lib/bridge/deploy");
    const { approveWorkflowDeployment } = await import("@/lib/bridge/lifecycle");
    const { signalApproval, cancelOperation } = await import("@/lib/workflows/client");
    const { waitFor } = await import("../workflows/support");
    const taskQueue = uniqueId("approval-queue");
    const config = executionWorkerConfigFromEnv({ ZENITH_TEMPORAL_ADDRESS: server!.env.address, ZENITH_WORKER_TASK_QUEUE: taskQueue, ZENITH_WORKER_SHUTDOWN_GRACE_MS: "2000" });
    const worker = await createExecutionWorker({ config, connection: server!.env.nativeConnection, activities, workflows: { workflowBundle: { codePath: bundle }, origin: "prebuilt-bundle" } });
    const requesterContext = { workspaceId: WS, projectId: PROJECT, environmentId: ENV, actor: author };
    const reviewerContext = { ...requesterContext, actor: { type: "user" as const, id: approver.id, name: approver.name } };
    const signal = vi.fn((id: string) => signalApproval(id, { client: server!.env.client }));
    setBridgeDepsForTests({ broker: async () => broker, browserSession: async (c) => ({ method: "browser_session", subject: c.actor.id, verifiedAtMs: Date.now() }), workflows: {
      startDeploy: (input) => startDeploy(input, { client: server!.env.client, taskQueue }), signalApproval: signal, cancelOperation: (id) => cancelOperation(id, { client: server!.env.client }),
    } });
    try {
      await worker.runUntil(async () => {
        const proposed = await startWorkflowDeployment({ ctx: requesterContext, env: q.environment(ENV)!, revision: q.revision(REVISION)!, changeset: { items: [], warnings: [], totalCostDeltaUsd: 0, projectedMonthlyUsd: 0 }, changeSummary: "Contract bridge deploy" });
        expect(proposed.ok).toBe(true);
        const d = q.deployment((proposed.data as { deploymentId: string }).deploymentId)!;
        await projectOwningDeployment(d.id);
        const initial = (await broker.getOperationDetail({ workspaceId: WS, operationId: d.operationId!, principal: requester })).operation;
        expect(initial.proposal.planDigest).toBeUndefined(); expect(initial.status).toBe("awaiting_approval"); expect(initial.approvalRound).toBe(0);
        expect((await approveWorkflowDeployment(reviewerContext, d)).ok).toBe(true);
        const { WORKFLOW_ID } = await import("@/lib/workflows/types");
        const actual = server!.env.client.workflow.getHandle(WORKFLOW_ID(d.operationId!));
        const waiting = await waitFor("bridge plan round", async () => {
          const op = await repos.operations.get(db, WS, d.operationId!); return op?.status === "awaiting_approval" ? op : false;
        });
        expect(waiting).toMatchObject({ approvalRound: 1, planDigest: reviewedPlan.planDigest });
        expect((await activities.checkApproval({ operationId: waiting.id })).approved).toBe(false);
        const detail = await broker.getOperationDetail({ workspaceId: WS, operationId: waiting.id, principal: approver });
        expect(detail.planReview?.view.planDigest).toBe(reviewedPlan.planDigest);
        expect(detail.planReview?.decision?.outcome).toBe("require_approval");
        const reviewed = detail.planReview!;
        await expect(approveWorkflowDeployment(reviewerContext, d, reviewed.planDigest)).resolves.toMatchObject({ ok: false });
        await expect(approveWorkflowDeployment(reviewerContext, d, reviewed.planDigest, "f".repeat(64))).resolves.toMatchObject({ ok: false });
        expect(signal).not.toHaveBeenCalled();
        expect((await approveWorkflowDeployment(reviewerContext, d, reviewed.planDigest, reviewed.semantics!.digest)).ok).toBe(true);
        expect(signal).toHaveBeenCalledExactlyOnceWith(waiting.id, WS);
        const result = await actual.result() as WorkflowResult;
        expect(result.status).toBe("succeeded");
        expect((await repos.operations.get(db, WS, waiting.id))?.status).toBe("succeeded");
        expect(tofu.applyCalls).toHaveLength(1);
        const approvals = await db.query<{ approval_round: number; consumed_at: string }>("select approval_round, consumed_at from platform.approvals where workspace_id=$1 and operation_id=$2 order by approval_round", [WS, waiting.id]);
        expect(approvals.map((a) => a.approval_round)).toEqual([0, 1]); expect(approvals.every((a) => a.consumed_at)).toBe(true);
        const events = await repos.events.list(db, WS, { operationId: waiting.id, limit: 500 });
        const fences = events.filter((e) => e.type === "lease.acquired").map((e) => e.data.fenceToken);
        expect(fences).toHaveLength(2); expect(fences[1]).toBeGreaterThan(fences[0] as number);
        expect(events.filter((e) => e.type === "operation.approved")).toHaveLength(2);
        expect(events.some((e) => e.type === "operation.succeeded")).toBe(true);
        const evidence = await repos.evidence.list(db, WS, { operationId: waiting.id, limit: 200 });
        expect(evidence.some((e) => e.summary.stage === "final_plan" && e.summary.matchesApproved === true)).toBe(true);
      });
    } finally { setBridgeDepsForTests(null); }
  }, 120_000);
  it("approves the plan as a browser human, deploys every step, and reads actual mocked steady state/health", async (ctx) => {
    if (!server) { console.warn(skipReason); ctx.skip(); }
    expect(server!.env.address).not.toMatch(/:7233$/);
    const op = await approvedOperation();
    const { result, history } = await runDeploy(op);
    expect(result.status).toBe("succeeded");
    const operation = await repos.operations.get(db, WS, op);
    expect(operation?.status).toBe("succeeded");
    expect(tofu.applyCalls).toHaveLength(1);
    expect(tofu.applyCalls[0].fingerprintKey).toMatch(/^[a-f0-9]{64}$/);
    expect(tofu.planCalls.length).toBeGreaterThanOrEqual(2);
    expect(q.deployment(DEPLOYMENT)?.status).toBe("succeeded");
    expect(q.deployment(DEPLOYMENT)?.steps.map((s) => s.id.replace(/^step-/, ""))).toEqual(["validate", "lease", "plan", "policy", "approval", "final_plan", "apply_infrastructure", "build", "deploy", "migrate", "verify_infrastructure", "verify_application", "observe", "finalize", "release"]);
    const evidence = await repos.evidence.list(db, WS, { operationId: op, limit: 200 });
    expect(evidence.some((e) => e.kind === "tofu_plan")).toBe(true);
    expect(evidence.some((e) => e.kind === "verification")).toBe(true);
    expect(await broker.deps.store.listApprovals(WS, op)).toHaveLength(2);
    expect((await db.query("select id from platform.policy_decisions where workspace_id=$1 and operation_id=$2", [WS, op])).length).toBeGreaterThan(1);
    expect((await db.query("select jti from platform.capability_grants where workspace_id=$1 and operation_id=$2", [WS, op])).length).toBeGreaterThan(1);
    const events = await repos.events.list(db, WS, { operationId: op, limit: 500 });
    expect(events.some((e) => e.type === "credential.assumed")).toBe(true);
    expect(cloud.ecs.commandCalls((await import("@aws-sdk/client-ecs")).DescribeServicesCommand).length).toBeGreaterThan(0);
    expect(cloud.elb.commandCalls((await import("@aws-sdk/client-elastic-load-balancing-v2")).DescribeTargetHealthCommand).length).toBeGreaterThan(0);
    expect(cloud.rds.calls().length).toBeGreaterThan(0);
    const historyPayloads = (history.events ?? []).flatMap((event) => Object.values(event).filter((value) => value && typeof value === "object").flatMap((attrs) => Object.values(attrs).filter((value) => value && typeof value === "object" && "payloads" in value).flatMap((value) => (value as { payloads: Parameters<typeof defaultPayloadConverter.fromPayload>[0][] }).payloads.map((p) => defaultPayloadConverter.fromPayload(p)))));
    const serialized = JSON.stringify({ events, evidence, projection: q.deployment(DEPLOYMENT), historyPayloads });
    expect(serialized).not.toContain(SESSION_CANARY);
    expect(serialized).not.toContain(process.env.ZENITH_CONTROL_SIGNING_JWK);
    expect(serialized).not.toContain("FAKE-BINARY-PLAN-FILE");
  }, 120_000);
  it("denies a discovered public database before apply", async (ctx) => {
    if (!server) { console.warn(skipReason); ctx.skip(); }
    const op = await approvedOperation();
    const publicPlan = makePlan({ changes: [change({ address: "aws_db_instance.postgres_db", nodeAddress: "postgres/db", type: "aws_db_instance", action: "create", changes: [{ path: "publicly_accessible", before: false, after: true, sensitive: false, forcesReplacement: false }] })] });
    tofu.planFactory = () => publicPlan;
    const { result } = await runDeploy(op);
    expect(result.status).toBe("failed");
    expect(tofu.applyCalls).toHaveLength(0);
    const decisions = await db.query<{ outcome: string; reasons: unknown }>("select outcome, reasons from platform.policy_decisions where workspace_id=$1 and operation_id=$2", [WS, op]);
    expect(decisions.some((d) => d.outcome === "deny" && JSON.stringify(d.reasons).includes("public_database"))).toBe(true);
  }, 120_000);
  it("a reject in the plan round halts without applying", async (ctx) => {
    if (!server) { console.warn(skipReason); ctx.skip(); }
    const op = await approvedOperation();
    const { result } = await runDeploy(op, undefined, async (id) => {
      const current = (await repos.operations.get(db, WS, id))!;
      await broker.reject({ workspaceId: WS, operationId: id, proposalDigest: current.proposalDigest, approver, session: { method: "browser_session", subject: approver.id, verifiedAtMs: Date.now() } });
    });
    expect(result.status).toBe("failed"); expect((await repos.operations.get(db, WS, op))?.status).toBe("rejected"); expect(tofu.applyCalls).toHaveLength(0);
  }, 120_000);
  it("a plan changed after plan approval fails before apply", async (ctx) => {
    if (!server) { console.warn(skipReason); ctx.skip(); }
    const op = await approvedOperation();
    const { result } = await runDeploy(op, undefined, async (id) => { await approvePlan(id); tofu.planFactory = () => makePlan({ seed: "changed-after-review" }); });
    expect(result.status).toBe("failed"); expect(result.error).toMatch(/plan.changed|PlanChanged|plan changed/i); expect(tofu.applyCalls).toHaveLength(0);
  }, 120_000);
  it("loses its lease while apply is in flight and ends uncertain without retrying apply", async (ctx) => {
    if (!server) { console.warn(skipReason); ctx.skip(); }
    const op = await approvedOperation();
    let finish!: () => void;
    tofu.applyGate = new Promise<void>((resolve) => { finish = resolve; });
    const { result } = await runDeploy(op, async () => {
      await tofu.applyStarted;
      try { await db.query("update platform.leases set expires_at=clock_timestamp()-interval '1 second' where workspace_id=$1 and scope=$2", [WS, `env:${ENV}`]); }
      finally { finish(); }
    });
    expect(result.status).toBe("uncertain");
    expect((await repos.operations.get(db, WS, op))?.status).toBe("uncertain");
    expect(tofu.applyCalls).toHaveLength(1);
  }, 120_000);
});

describe("composed activities against local stores (no Temporal fallback)", () => {
  it("requires a distinct human-approved proposal when repeated planning observes a different digest",async()=>{
    activities=composed(false);
    const firstId=await approvedOperation();await activities.validateDesiredState({operationId:firstId});
    let firstLease=await activities.acquireLease({operationId:firstId,scope:`env:${ENV}`,ttlMs:180000});
    const first=await activities.planInfrastructure({operationId:firstId,lease:firstLease});
    await activities.evaluatePolicy({operationId:firstId,planDigest:first.planDigest});
    firstLease=await planRound(firstId,firstLease);
    const original=await db.query("select manifest_digest,md5(ciphertext) as ciphertext_digest from platform.plan_artifacts where workspace_id=$1 and operation_id=$2",[WS,firstId]);
    const moved=makePlan({changes:[change({address:"aws_db_instance.postgres_db",nodeAddress:"postgres/db",type:"aws_db_instance",action:"update",changes:[{path:"allocated_storage",before:20,after:40,sensitive:false,forcesReplacement:false}]})]});
    tofu.planFactory=()=>moved;
    try {
      await expect(activities.planInfrastructure({operationId:firstId,lease:firstLease})).rejects.toMatchObject({type:"plan_changed",nonRetryable:true});
      expect((await repos.operations.get(db,WS,firstId))?.planDigest).toBe(first.planDigest);
      expect(await db.query("select manifest_digest,md5(ciphertext) as ciphertext_digest from platform.plan_artifacts where workspace_id=$1 and operation_id=$2",[WS,firstId])).toEqual(original);
      expect(tofu.applyCalls).toHaveLength(0);
    } finally {await activities.releaseLease({lease:firstLease});}
    const nextId=await approvedOperation();expect(nextId).not.toBe(firstId);
    await activities.validateDesiredState({operationId:nextId});
    let nextLease=await activities.acquireLease({operationId:nextId,scope:`env:${ENV}`,ttlMs:180000});
    try {
      const next=await activities.planInfrastructure({operationId:nextId,lease:nextLease});expect(next.planDigest).toBe(moved.planDigest);
      expect((await activities.evaluatePolicy({operationId:nextId,planDigest:next.planDigest})).outcome).toBe("require_approval");
      expect((await activities.checkApproval({operationId:nextId})).approved).toBe(false);
      nextLease=await planRound(nextId,nextLease);
      expect((await activities.checkApproval({operationId:nextId})).approved).toBe(true);
      expect((await repos.approvals.listForOperation(db,WS,nextId)).map(a=>approvalRoundOf(a))).toEqual([0,1]);
      expect(tofu.applyCalls).toHaveLength(0);
      expect((await repos.operations.get(db,WS,firstId))?.planDigest).toBe(first.planDigest);
    } finally {await activities.releaseLease({lease:nextLease});}
  });

  it.each(["ZenithWorkloadBoundary", "ZenithBuildBoundary"])("refuses infrastructure verification when an application identity carries %s", async (boundaryName) => {
    activities = composed(false);
    const operationId = await approvedOperation();
    await activities.validateDesiredState({ operationId });
    let lease = await activities.acquireLease({ operationId, scope: `env:${ENV}`, ttlMs: 180_000 });
    const plan = await activities.planInfrastructure({ operationId, lease });
    expect((await activities.evaluatePolicy({ operationId, planDigest: plan.planDigest })).outcome).toBe("require_approval");
    lease = await planRound(operationId, lease);
    try {
      await activities.finalPlan({ operationId, approvedPlanDigest: plan.planDigest, lease });
      await activities.applyInfrastructure({ operationId, planDigest: plan.planDigest, lease });
      expect(await activities.verifyInfrastructure({ operationId })).toMatchObject({ status: "passed", failed: 0 });

      cloud.setIdentityBoundary(`arn:aws:iam::123456789012:policy/${boundaryName}`);
      const verified = await activities.verifyInfrastructure({ operationId });
      expect(verified.status).toBe("failed");
      expect(verified.failed).toBeGreaterThan(0);
      expect(verified.evidenceId).toBeTruthy();
      const evidence = await repos.evidence.get(db, WS, verified.evidenceId!);
      expect(evidence?.summary.nodes).toEqual(expect.arrayContaining([
        expect.objectContaining({ address: "identity/web", status: "failed", failed: expect.arrayContaining(["boundary_attached"]) }),
      ]));
      expect(await broker.deps.store.listApprovals(WS, operationId)).toHaveLength(2);
      expect(tofu.applyCalls).toHaveLength(1);
    } finally { await activities.releaseLease({ lease }); }
  }, 60_000);
  it("runs a real bridge proposal and two browser rounds through the complete activity chain (gateway is fake)", async () => {
    activities = composed(false);
    const { setBridgeDepsForTests } = await import("@/lib/bridge/deps");
    const { startWorkflowDeployment } = await import("@/lib/bridge/deploy");
    const { approveWorkflowDeployment } = await import("@/lib/bridge/lifecycle");
    const requesterContext = { workspaceId: WS, projectId: PROJECT, environmentId: ENV, actor: author };
    const reviewerContext = { ...requesterContext, actor: { type: "user" as const, id: approver.id, name: approver.name } };
    const start = vi.fn(async () => ({})), signal = vi.fn(async (_id: string) => ({ delivered: true as const }));
    setBridgeDepsForTests({ broker: async () => broker, browserSession: async (c) => ({ method: "browser_session", subject: c.actor.id, verifiedAtMs: Date.now() }), workflows: { startDeploy: start, signalApproval: signal, cancelOperation: signal } });
    try {
      const proposal = await startWorkflowDeployment({ ctx: requesterContext, env: q.environment(ENV)!, revision: q.revision(REVISION)!, changeset: { items: [], warnings: [], totalCostDeltaUsd: 0, projectedMonthlyUsd: 0 }, changeSummary: "Contract bridge activity chain" });
      expect(proposal.ok).toBe(true);
      const d = q.deployment((proposal.data as { deploymentId: string }).deploymentId)!;
      await projectOwningDeployment(d.id);
      const operationId = d.operationId!;
      expect((await broker.deps.store.getOperation(WS, operationId))?.planDigest).toBeUndefined();
      expect((await approveWorkflowDeployment(reviewerContext, d)).ok).toBe(true); expect(start).toHaveBeenCalledOnce();
      await activities.validateDesiredState({ operationId });
      const first = await activities.acquireLease({ operationId, scope: `env:${ENV}`, ttlMs: 180_000 });
      const plan = await activities.planInfrastructure({ operationId, lease: first });
      expect((await activities.evaluatePolicy({ operationId, planDigest: plan.planDigest })).outcome).toBe("require_approval");
      expect(await activities.checkApproval({ operationId })).toMatchObject({ approved: false, rejected: false });
      await activities.releaseLease({ lease: first }); await activities.markOperation({ operationId, status: "awaiting_approval" });
      const detail = await broker.getOperationDetail({ workspaceId: WS, operationId, principal: approver });
      expect(detail.operation.approvalRound).toBe(1); expect(detail.planReview?.view.resources.length).toBeGreaterThan(0);
      await expect(approveWorkflowDeployment(reviewerContext, d)).resolves.toMatchObject({ ok: false });
      d.status = "planning"; // Best-effort projection can lag; the ledger owns the gate.
      const reviewed = detail.planReview!;
      await expect(approveWorkflowDeployment(reviewerContext, d, reviewed.planDigest)).resolves.toMatchObject({ ok: false });
      await expect(approveWorkflowDeployment(reviewerContext, d, reviewed.planDigest, "f".repeat(64))).resolves.toMatchObject({ ok: false });
      expect(signal).not.toHaveBeenCalled();
      expect((await approveWorkflowDeployment(reviewerContext, d, reviewed.planDigest, reviewed.semantics!.digest)).ok).toBe(true);
      expect(signal).toHaveBeenCalledExactlyOnceWith(operationId, WS); expect(start).toHaveBeenCalledOnce();
      await activities.markOperation({ operationId, status: "running" });
      const lease = await activities.acquireLease({ operationId, scope: `env:${ENV}`, ttlMs: 180_000 });
      expect(lease.fenceToken).toBeGreaterThan(first.fenceToken);
      try {
        await activities.finalPlan({ operationId, approvedPlanDigest: plan.planDigest, lease });
        await activities.applyInfrastructure({ operationId, planDigest: plan.planDigest, lease });
        await activities.deployWorkloads({ operationId, lease, images: [] }); await activities.runMigrations({ operationId, lease });
        expect((await activities.verifyInfrastructure({ operationId })).status).toBe("passed"); expect((await activities.verifyApplication({ operationId })).status).toBe("passed");
        await activities.observeEnvironment({ operationId }); await activities.markOperation({ operationId, status: "succeeded" });
      } finally { await activities.releaseLease({ lease }); }
      expect((await repos.operations.get(db, WS, operationId))?.status).toBe("succeeded"); expect(q.deployment(d.id)?.status).toBe("succeeded"); expect(tofu.applyCalls).toHaveLength(1);
      expect((await broker.deps.store.listApprovals(WS, operationId)).map((a) => (a as typeof a & { approvalRound: number }).approvalRound)).toEqual([0, 1]);
    } finally { setBridgeDepsForTests(null); }
  }, 60_000);
  it("refuses a changed final plan after the second browser approval and never applies", async () => {
    activities = composed(false);
    const operationId = await approvedOperation(); await activities.validateDesiredState({ operationId });
    let lease = await activities.acquireLease({ operationId, scope: `env:${ENV}`, ttlMs: 180_000 });
    const plan = await activities.planInfrastructure({ operationId, lease }); await activities.evaluatePolicy({ operationId, planDigest: plan.planDigest });
    lease = await planRound(operationId, lease);
    try {
      tofu.planFactory = () => makePlan({ seed: "changed-after-review" });
      await expect(activities.finalPlan({ operationId, approvedPlanDigest: plan.planDigest, lease })).rejects.toMatchObject({ type: "plan_changed", nonRetryable: true });
      expect(tofu.applyCalls).toHaveLength(0);
      await activities.markOperation({ operationId, status: "failed", error: "Plan changed after approval; nothing applied." });
      expect((await repos.operations.get(db, WS, operationId))?.status).toBe("failed");
    } finally { await activities.releaseLease({ lease }); }
  }, 60_000);
  it("runs the complete deploy activity chain with real policy, credentials and driver reads", async () => {
    activities = composed(false);
    const operationId = await approvedOperation();
    await activities.markOperation({ operationId, status: "running" });
    const step = async <T>(name: StepName, fn: () => Promise<T>): Promise<T> => {
      await activities.recordStep({ operationId, deploymentId: DEPLOYMENT, step: name, status: "running" });
      const result = await fn();
      await activities.recordStep({ operationId, deploymentId: DEPLOYMENT, step: name, status: "done" });
      return result;
    };
    expect((await step("validate", () => activities.validateDesiredState({ operationId }))).problems).toEqual([]);
    let lease = await step("lease", () => activities.acquireLease({ operationId, scope: `env:${ENV}`, ttlMs: 180_000 }));
    try {
      const plan = await step("plan", () => activities.planInfrastructure({ operationId, lease }));
      expect((await step("policy", () => activities.evaluatePolicy({ operationId, planDigest: plan.planDigest }))).outcome).toBe("require_approval");
      lease = await planRound(operationId, lease);
      expect((await step("approval", () => activities.checkApproval({ operationId }))).approved).toBe(true);
      await step("final_plan", () => activities.finalPlan({ operationId, approvedPlanDigest: plan.planDigest, lease }));
      await step("apply_infrastructure", () => activities.applyInfrastructure({ operationId, planDigest: plan.planDigest, lease }));
      const built = await step("build", () => activities.buildArtifacts({ operationId, lease }));
      expect((await step("deploy", () => activities.deployWorkloads({ operationId, lease, images: built.images }))).services).toBe(1);
      expect((await step("migrate", () => activities.runMigrations({ operationId, lease }))).ran).toBe(false);
      const verified = await step("verify_infrastructure", () => activities.verifyInfrastructure({ operationId }));
      expect(verified).toMatchObject({ status: "passed", failed: 0 });
      expect(await step("verify_application", () => activities.verifyApplication({ operationId }))).toMatchObject({ status: "passed", failed: 0 });
      await step("observe", () => activities.observeEnvironment({ operationId }));
      await step("finalize", () => activities.markOperation({ operationId, status: "succeeded" }));
      await step("release", () => activities.releaseLease({ lease }));
      expect((await repos.operations.get(db, WS, operationId))?.status).toBe("succeeded");
      expect(q.deployment(DEPLOYMENT)?.status).toBe("succeeded");
      expect(tofu.applyCalls).toHaveLength(1);
      const main = JSON.parse(tofu.planCalls[0].ws.files.find((f) => f.path === "main.tf.json")!.content) as { locals: Record<string, unknown> };
      const references = [...JSON.stringify(main).matchAll(/local\.(ref_[a-z0-9_]+)/g)].map((m) => m[1]);
      expect(references.length).toBeGreaterThan(0);
      for (const reference of references) expect(main.locals).toHaveProperty(reference);
      expect((await db.query("select environment_id from platform.reconcile_state where workspace_id=$1 and environment_id=$2", [WS, ENV])).length).toBe(1);
      const evidence = await repos.evidence.list(db, WS, { operationId, limit: 200 });
      const events = await repos.events.list(db, WS, { operationId, limit: 500 });
      expect(JSON.stringify({ evidence, events, deployment: q.deployment(DEPLOYMENT) })).not.toContain(SESSION_CANARY);
      expect(cloud.ecs.calls().length).toBeGreaterThan(0);
      expect(cloud.elb.commandCalls((await import("@aws-sdk/client-elastic-load-balancing-v2")).DescribeTargetHealthCommand).length).toBeGreaterThan(0);
    } finally { await activities.releaseLease({ lease }); }
  }, 60_000);
  it("refuses rollout dispatch when policy is tightened to deny after approval, through the real broker and policy", async () => {
    activities = composed(false);
    const operationId = await approvedOperation();
    await activities.validateDesiredState({ operationId });
    let lease = await activities.acquireLease({ operationId, scope: `env:${ENV}`, ttlMs: 180_000 });
    try {
      const plan = await activities.planInfrastructure({ operationId, lease });
      await activities.evaluatePolicy({ operationId, planDigest: plan.planDigest });
      lease = await planRound(operationId, lease);
      await activities.finalPlan({ operationId, approvedPlanDigest: plan.planDigest, lease });
      await activities.applyInfrastructure({ operationId, planDigest: plan.planDigest, lease });
      const built = await activities.buildArtifacts({ operationId, lease });
      // the human approval is still genuine; only the current policy changes
      const tightened = await loadPolicyEngine();
      broker.deps.policy = async () => ({
        version: "tightened-after-approval",
        evaluate: async (input) => ({ ...(await tightened.evaluate(input)), decision: { outcome: "deny", reasons: [{ code: "tightened_after_approval", message: "Policy was tightened after approval.", rule: "test" }] } }),
      });
      const ecsCalls = cloud.ecs.calls().length;
      await expect(activities.deployWorkloads({ operationId, lease, images: built.images })).rejects.toThrow(/Current policy or human approval changed before rollout dispatch/);
      expect(cloud.ecs.calls()).toHaveLength(ecsCalls);
    } finally { await activities.releaseLease({ lease }); }
  }, 60_000);
  it("refuses migration dispatch when policy is tightened to deny after approval, through the real broker and policy", async () => {
    const runOneOffTask = vi.fn<MigrationsPort["runOneOffTask"]>(async () => ({ exitCode: 0 }));
    const { operationId, lease } = await migratingReleaseThroughRollout(runOneOffTask);
    try {
      // the human approval is still genuine; only the current policy changes
      const tightened = await loadPolicyEngine();
      broker.deps.policy = async () => ({
        version: "tightened-after-approval",
        evaluate: async (input) => ({ ...(await tightened.evaluate(input)), decision: { outcome: "deny", reasons: [{ code: "tightened_after_approval", message: "Policy was tightened after approval.", rule: "test" }] } }),
      });
      await expect(activities.runMigrations({ operationId, lease })).rejects.toThrow(/Current policy or human approval changed before migration dispatch/);
      expect(runOneOffTask).toHaveBeenCalledTimes(0);
    } finally { await activities.releaseLease({ lease }); }
  }, 60_000);
  it("runs the declared migration once when policy is unchanged, so the refusal above is not vacuous", async () => {
    const runOneOffTask = vi.fn<MigrationsPort["runOneOffTask"]>(async () => ({ exitCode: 0 }));
    const { operationId, lease } = await migratingReleaseThroughRollout(runOneOffTask);
    try {
      expect(await activities.runMigrations({ operationId, lease })).toMatchObject({ ran: true });
      expect(runOneOffTask).toHaveBeenCalledTimes(1);
    } finally { await activities.releaseLease({ lease }); }
  }, 60_000);
  it("evaluates a public database plan as deny without any apply call", async () => {
    activities = composed(false);
    const operationId = await approvedOperation();
    tofu.planFactory = () => makePlan({ changes: [change({ address: "aws_db_instance.db", type: "aws_db_instance", action: "create", changes: [{ path: "publicly_accessible", before: false, after: true, sensitive: false, forcesReplacement: false }] })] });
    await activities.validateDesiredState({ operationId });
    const lease = await activities.acquireLease({ operationId, scope: `env:${ENV}`, ttlMs: 180_000 });
    try {
      const plan = await activities.planInfrastructure({ operationId, lease });
      const decision = await activities.evaluatePolicy({ operationId, planDigest: plan.planDigest });
      expect(decision.outcome).toBe("deny"); expect(decision.reasons).toContain("public_database");
      expect(tofu.applyCalls).toHaveLength(0);
      await expect(createExecutionBroker(db, async () => broker).issueGrant(operationId, "worker", lease)).rejects.toThrow();
    } finally { await activities.releaseLease({ lease }); }
  }, 60_000);
  it("maps a lost apply fence to a non-retryable LeaseLost and permits only uncertain finalization", async () => {
    activities = composed(false);
    const operationId = await approvedOperation();
    await activities.validateDesiredState({ operationId });
    let lease = await activities.acquireLease({ operationId, scope: `env:${ENV}`, ttlMs: 180_000 });
    const plan = await activities.planInfrastructure({ operationId, lease });
    await activities.evaluatePolicy({ operationId, planDigest: plan.planDigest });
    lease = await planRound(operationId, lease);
    let finish!: () => void; tofu.applyGate = new Promise<void>((resolve) => { finish = resolve; });
    let applySignal:AbortSignal|undefined;
    const scriptedApply=tofu.applyVerifiedPlan.bind(tofu);
    tofu.applyVerifiedPlan=(ws,args)=>{applySignal=args.signal;return scriptedApply(ws,args);};
    const pending = activities.applyInfrastructure({ operationId, planDigest: plan.planDigest, lease });
    const assertion = expect(pending).rejects.toMatchObject({ type: "LeaseLost", nonRetryable: true });
    await tofu.applyStarted;
    await db.query("update platform.leases set expires_at=clock_timestamp()-interval '1 second' where workspace_id=$1 and scope=$2", [WS, lease.scope]);
    try {
      // Keep the write held until the real keepalive observes loss, rather than racing SQL completion.
      await waitFor("apply lease-loss signal",()=>applySignal?.aborted ? true : false,20_000);
      expect(applySignal?.reason).toBeInstanceOf(LeaseLostError);
    } finally {finish();await assertion;}
    await activities.markOperation({ operationId, status: "uncertain", error: "Apply lease lost; external outcome unknown." });
    expect((await repos.operations.get(db, WS, operationId))?.status).toBe("uncertain");
    expect(tofu.applyCalls).toHaveLength(1);
    const artifactUse=await db.query<{phase:string}>("select phase from platform.plan_artifact_uses where workspace_id=$1 and operation_id=$2",[WS,operationId]);
    expect(artifactUse.map(row=>row.phase)).toEqual(["uncertain"]);
    await expect(activities.applyInfrastructure({operationId,planDigest:plan.planDigest,lease})).rejects.toThrow();
    expect(tofu.applyCalls).toHaveLength(1);
  }, 60_000);
  it("refuses SQL completion after an unobserved apply fence expiry and never replays the dispatched original",async()=>{
    activities=composed(false);
    const operationId=await approvedOperation();
    await activities.validateDesiredState({operationId});
    let lease=await activities.acquireLease({operationId,scope:`env:${ENV}`,ttlMs:180_000});
    const plan=await activities.planInfrastructure({operationId,lease});
    await activities.evaluatePolicy({operationId,planDigest:plan.planDigest});
    lease=await planRound(operationId,lease);
    let finish!:()=>void;tofu.applyGate=new Promise<void>(resolve=>{finish=resolve;});
    let applySignal:AbortSignal|undefined;
    const scriptedApply=tofu.applyVerifiedPlan.bind(tofu);
    tofu.applyVerifiedPlan=(ws,args)=>{applySignal=args.signal;return scriptedApply(ws,args);};
    // Isolate SQL's last-clock refusal: pause only interval callbacks, never Date or PostgreSQL's clock.
    vi.useFakeTimers({toFake:["setInterval","clearInterval"]});
    try {
      const pending=activities.applyInfrastructure({operationId,planDigest:plan.planDigest,lease});
      const assertion=expect(pending).rejects.toThrow("Isolated original plan dispatch outcome is unconfirmed.");
      await tofu.applyStarted;
      await db.query("update platform.leases set expires_at=clock_timestamp()-interval '1 second' where workspace_id=$1 and scope=$2",[WS,lease.scope]);
      expect(applySignal?.aborted).toBe(false);
      finish();await assertion;
      expect((await repos.operations.get(db,WS,operationId))?.status).toBe("uncertain");
      const artifactUse=await db.query<{phase:string}>("select phase from platform.plan_artifact_uses where workspace_id=$1 and operation_id=$2",[WS,operationId]);
      expect(artifactUse.map(row=>row.phase)).toEqual(["uncertain"]);
      expect((await repos.evidence.list(db,WS,{operationId})).filter(row=>row.kind==="tofu_apply")).toHaveLength(0);
      await expect(activities.applyInfrastructure({operationId,planDigest:plan.planDigest,lease})).rejects.toThrow();
      expect(tofu.applyCalls).toHaveLength(1);
    } finally {finish();vi.useRealTimers();}
  },60_000);
  it("atomically reaps runner and machine jobs, marks owning operations uncertain, and audits once", async () => {
    const { ensurePlatformApp, platformRunnerReaperPass, resetPlatformAppForTests } = await import("@/lib/platform/app");
    const { resetPlatformBrokerForTests } = await import("@/lib/capabilities/platform");
    const { resetRunnerRuntime } = await import("@/lib/runners/runtime");
    const { wireReconcilePorts } = await import("@/lib/reconcile/ports");
    const { createMachineRequestQueue } = await import("@/lib/runners/db/machine-requests");
    const operationId = await approvedOperation();
    const second = await approvedOperation();
    const runnerHash = "a".repeat(64), machineHash = "b".repeat(64);
    await repos.runners.createRegistrationToken(db, { tokenHash: runnerHash, workspaceId: WS, kind: "runner", binding: {}, createdBy: "local" });
    await repos.runners.createRegistrationToken(db, { tokenHash: machineHash, workspaceId: WS, kind: "machine", binding: {}, createdBy: "local" });
    const runner = await repos.runners.registerRunner(db, { tokenHash: runnerHash, name: "Contract runner", publicKey: "a".repeat(43) });
    const machine = await repos.machines.registerMachine(db, { tokenHash: machineHash, name: "Contract machine", publicKey: "b".repeat(43) });
    await repos.jobs.enqueue(db, { id: "runner-expired", workspaceId: WS, runnerId: runner.id, operationId, kind: "aws-sdk.call", capability: "deployment.deploy", envelope: "contract-opaque-envelope" });
    await createMachineRequestQueue(db).enqueue({ id: "machine-expired", workspaceId: WS, agentId: machine.id, operationId: second, kind: "machine.inspect", capability: "deployment.deploy", envelope: "contract-opaque-envelope" });
    await db.query("update platform.runner_jobs set expires_at=clock_timestamp()-interval '1 second' where workspace_id=$1", [WS]);
    await db.query("update platform.machine_requests set expires_at=clock_timestamp()-interval '1 second' where workspace_id=$1", [WS]);
    resetPlatformAppForTests();
    try {
      expect(await ensurePlatformApp(db)).toBe(true);
      expect(await platformRunnerReaperPass()).toEqual({ ran: true, jobs: 2 });
      expect((await repos.operations.get(db, WS, operationId))?.status).toBe("uncertain");
      expect((await repos.operations.get(db, WS, second))?.status).toBe("uncertain");
      expect(await platformRunnerReaperPass()).toEqual({ ran: true, jobs: 0 });
      const events = await repos.events.list(db, WS, { limit: 500 });
      expect(events.filter((e) => e.type === "runner.job.completed")).toHaveLength(1);
      expect(events.filter((e) => e.type === "machine.request.completed")).toHaveLength(1);
      expect(JSON.stringify(events)).not.toContain("contract-opaque-envelope");
    } finally { resetPlatformAppForTests(); resetPlatformBrokerForTests(); resetRunnerRuntime(); wireReconcilePorts(null); }
  }, 60_000);
  it("resolves platform repair resource ids only through the owning workspace/environment chain", async () => {
    const { platformScopeResolver } = await import("@/lib/platform/scopes");
    activities = composed(false); const operationId = await approvedOperation();
    await activities.validateDesiredState({ operationId });
    const nodes = await repos.resources.listByEnvironment(db, WS, ENV);
    const resource = nodes.find((n) => n.kind === "postgres")!;
    const scopes = platformScopeResolver(db);
    expect(await scopes.resolve({ workspaceId: WS, projectId: PROJECT, environmentId: ENV, resourceId: resource.id })).toMatchObject({ resource: { address: "postgres/db", ownership: "managed", stateful: true } });
    expect(await scopes.resolve({ workspaceId: "foreign", projectId: PROJECT, environmentId: ENV, resourceId: resource.id })).toBeNull();
    expect(await scopes.resolve({ workspaceId: WS, projectId: PROJECT, environmentId: "foreign", resourceId: resource.id })).toBeNull();
  }, 60_000);
  it("refuses grants after a human approver loses their required role", async () => {
    activities = composed(false); const operationId = await approvedOperation();
    await activities.validateDesiredState({ operationId });
    const lease = await activities.acquireLease({ operationId, scope: `env:${ENV}`, ttlMs: 180_000 });
    try {
      await activities.planInfrastructure({ operationId, lease });
      const store = (await import("@/lib/db/store")).db();
      store.members.find((m) => m.id === approver.id)!.role = "viewer"; save();
      await db.query("update public.members set role=$1 where workspace_id=$2 and id=$3", [store.members.find(member => member.workspaceId === WS && member.id === approver.id)!.role, WS, approver.id]);
      await expect(createExecutionBroker(db, async () => broker).issueGrant(operationId, "worker", lease)).rejects.toThrow("human approval");
      expect(await activities.checkApproval({ operationId })).toMatchObject({ approved: false });
    } finally { await activities.releaseLease({ lease }); }
  }, 60_000);
  it.each(["missing owning environment", "foreign owning project", "changed target region"] as const)("refuses %s after concrete approval without repairing the product projection", async fault => {
    activities = composed(false);
    const operationId = await approvedOperation();
    await activities.validateDesiredState({ operationId });
    let lease = await activities.acquireLease({ operationId, scope: `env:${ENV}`, ttlMs: 180_000 });
    try {
      const plan = await activities.planInfrastructure({ operationId, lease });
      await activities.evaluatePolicy({ operationId, planDigest: plan.planDigest });
      lease = await planRound(operationId, lease);
      expect((await activities.checkApproval({ operationId })).approved).toBe(true);
      expect(await db.query("select phase from platform.plan_artifact_uses where workspace_id=$1 and operation_id=$2", [WS, operationId])).toEqual([{ phase: "ready" }]);
      const original = await db.query("select manifest_digest,md5(ciphertext) as ciphertext_digest from platform.plan_artifacts where workspace_id=$1 and operation_id=$2", [WS, operationId]);
      expect(original).toHaveLength(1);
      if (fault === "missing owning environment") await db.query("delete from public.environments where workspace_id=$1 and id=$2", [WS, ENV]);
      else if (fault === "foreign owning project") await db.query("update public.projects set workspace_id='foreign' where workspace_id=$1 and id=$2", [WS, PROJECT]);
      else await db.query("update public.environments set data=jsonb_set(data,'{region}','\"us-west-2\"'::jsonb) where workspace_id=$1 and id=$2", [WS, ENV]);
      await expect(activities.applyInfrastructure({ operationId, planDigest: plan.planDigest, lease })).rejects.toThrow();
      expect(tofu.applyCalls).toHaveLength(0);
      expect((await repos.evidence.list(db, WS, { operationId })).filter(row => row.kind === "tofu_apply")).toHaveLength(0);
      expect(await db.query("select manifest_digest,md5(ciphertext) as ciphertext_digest from platform.plan_artifacts where workspace_id=$1 and operation_id=$2", [WS, operationId])).toEqual(original);
    } finally { await activities.releaseLease({ lease }); }
  }, 60_000);
});
