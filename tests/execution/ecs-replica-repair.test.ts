/** Adapter contract with real SDK command serialization and scripted cloud/Tofu ports. */
import { DescribeServicesCommand, ECSClient } from "@aws-sdk/client-ecs";
import { ApplicationAutoScalingClient, DescribeScalableTargetsCommand } from "@aws-sdk/client-application-auto-scaling";
import { GetResourcesCommand, ResourceGroupsTaggingAPIClient } from "@aws-sdk/client-resource-groups-tagging-api";
import { mockClient } from "aws-sdk-client-mock";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { ApplicationFailure } from "@temporalio/common";
import { digest } from "@/lib/controlplane/digest";
import { approvalRoundOf } from "@/lib/controlplane/db/repos/operation-review";
import { buildDesiredState } from "@/lib/execution/graph";
import { loadExecContext } from "@/lib/execution/context";
import { createRuntime } from "@/lib/execution/runtime";
import { assertEcsReplicaRepairPlan, prepareEcsReplicaRepair } from "@/lib/execution/ecs-replica-repair";
import { repairBindingDigest, repairBindingEvidenceId } from "@/lib/execution/ecs-replica-repair-binding";
import { supportsDeclarativeRepair } from "@/lib/resources";
import type { DriftFinding } from "@/lib/resources/types";
import { findDriver, getDriver } from "@/lib/drivers/types";
import { registerAwsDrivers } from "@/lib/providers/aws/drivers";
import { buildDeployWorkspace } from "@/lib/execution/plan";
import { normalizePlan, type ShowJson } from "@/lib/tofu/plan";
import { TofuCommandError } from "@/lib/tofu/runner";
import { configDigestOf } from "@/lib/tofu/config-digest";
import { TOFU_VERSION, type TofuWorkspace } from "@/lib/tofu/types";
import { classifyFailure } from "@/lib/workflows/definitions/failures";
import { ACTIVITY_OPTIONS } from "@/lib/workflows/definitions/policies";
import { createWorld, type World } from "./fakes/world";
import { ENV, OP, PROJECT, REVISION, WS, webDbManifest } from "./fakes/fixtures";

const ecs = mockClient(ECSClient); const scaling = mockClient(ApplicationAutoScalingClient); const tagging = mockClient(ResourceGroupsTaggingAPIClient);
afterAll(() => { ecs.restore(); scaling.restore(); tagging.restore(); });
const worlds: World[] = [];
afterEach(() => { for (const w of worlds.splice(0)) w.dispose(); });
const arn = "arn:aws:ecs:us-east-1:123456789012:service/cluster/web";
const cluster = "arn:aws:ecs:us-east-1:123456789012:cluster/cluster";
const task = "arn:aws:ecs:us-east-1:123456789012:task-definition/web:7";
const tofuAddress = "aws_ecs_service.container_service_web";
let replicas = 1;
let denyRead = false;
const ownedTags = { "zenith:managed": "true", "zenith:workspace": WS, "zenith:environment": ENV, "zenith:project": PROJECT, "zenith:resource": "container_service/web" };
beforeEach(() => {
  replicas = 1; denyRead = false; ecs.reset(); scaling.reset(); tagging.reset();
  tagging.on(GetResourcesCommand).resolves({ $metadata: { httpStatusCode: 200 }, ResourceTagMappingList: [{ ResourceARN: arn,
    Tags: Object.entries(ownedTags).map(([Key, Value]) => ({ Key, Value })) }] });
  ecs.on(DescribeServicesCommand).callsFake(() => {
    if (denyRead) throw new Error("Private cloud payload");
    return { $metadata: { httpStatusCode: 200 }, services: [{ serviceArn: arn, clusterArn: cluster, serviceName: "web", status: "ACTIVE",
      launchType: "FARGATE", schedulingStrategy: "REPLICA", desiredCount: replicas, taskDefinition: task, createdAt: new Date("2026-09-01T00:00:00Z"),
      tags: Object.entries(ownedTags).map(([key, value]) => ({ key, value })),
    }], failures: [] };
  });
  scaling.on(DescribeScalableTargetsCommand).resolves({ $metadata: { httpStatusCode: 200 }, ScalableTargets: [] });
});

function raw(after = 3): ShowJson {
  const values = { id: arn, cluster, task_definition: task, desired_count: 1, name: "web" };
  return { format_version: "1.2", terraform_version: TOFU_VERSION, resource_changes: [{ address: tofuAddress,
    mode: "managed", type: "aws_ecs_service", provider_name: "registry.opentofu.org/hashicorp/aws",
    change: { actions: ["update"], before: values, after: { ...values, desired_count: after }, after_unknown: {}, before_sensitive: {}, after_sensitive: {}, replace_paths: [] } }], output_changes: {} };
}
async function fixture() {
  const w = createWorld({ op: { capability: "drift.repair", status: "running" } }); worlds.push(w);
  w.product.base.environment.deployedRevisionId = REVISION;
  const manifest = webDbManifest(); manifest.services[0].source = { type: "image", image: `ghcr.io/acme/web@sha256:${"d".repeat(64)}` }; manifest.services[0].replicas = 3;
  w.product.setManifest(manifest);
  const product = await w.product.loadContext({ workspaceId: WS, environmentId: ENV });
  const graph = buildDesiredState(product).graph!;
  const node = graph.nodes.find((n) => n.address === "container_service/web")!;
  const row = await w.resources.upsertDesired({ workspaceId: WS, projectId: PROJECT, environmentId: ENV, node, revisionId: REVISION });
  const op = w.ops.ops.get(OP)!; op.resourceId = row.id;
  op.proposal = { ...op.proposal, input: { action: "reapply_desired_state", address: node.address, kind: "container_service", findingClass: "changed",
    severity: "medium", attributes: ["replicas"], graphDigest: graph.graphDigest, reportComputedAt: "2026-09-30T00:00:00.000Z" } };
  const driver = w.drivers("aws", "aws:ecs_service")!;
  driver.compile = (n) => ({ addresses: [tofuAddress], resource: { aws_ecs_service: { container_service_web: {
    name: "web", cluster, task_definition: task, desired_count: n.spec.replicas,
  } } } });
  const originalSession = w.credentials.withSession.bind(w.credentials);
  w.credentials.withSession = (request, callback) => originalSession(request, (session) => callback(session.provider === "aws" ? { ...session, transport: "direct" } : session));
  const originalGrant = w.broker.issueGrant.bind(w.broker);
  w.broker.issueGrant = async (...args) => {
    const grant = await originalGrant(...args);
    const binding = w.evidence.rows.find((r) => r.id === repairBindingEvidenceId(OP));
    if (grant.claims.cap === "drift.repair") grant.claims.constraints = { repairPlanDigest: w.ops.ops.get(OP)!.planDigest!, repairBindingDigest: binding!.digest };
    return grant;
  };
  const rt = createRuntime(w.deps);
  const ec = await loadExecContext(rt, OP); const lease = await w.lease(); const connection = w.connections.connections[0];
  const files = [{ path: "backend.tf.json", content: JSON.stringify({ terraform: { backend: { s3: { bucket: "owned-state", key: "env/state" } } } }) }];
  const ws: TofuWorkspace = { files, backend: "s3", lockfile: "lock", lockDigest: digest("lock"), configDigest: configDigestOf(files), addressMap: { [node.address]: [tofuAddress] } };
  const prepare = (runtime = rt, workspace = ws) => w.credentials.withSession({ connectionId: connection.id, grant: {
    jti: "read", iss: "zenith", aud: "worker", sub: "user-1", iat: 1, exp: 9999999999, cap: "infrastructure.plan", op: OP, digest: op.proposalDigest, ws: WS, env: ENV,
  }, purpose: "observe" }, (session) => prepareEcsReplicaRepair(runtime, ec, graph, workspace, connection, session, new AbortController().signal, lease));
  return { w, rt, ec, graph, node, row, ws, prepare, lease };
}

describe("immutable ECS replica materialization", () => {
  it("materializes a normal managed row without a stored ARN using the registered ECS driver and real-shaped owned tag lookup", async () => {
    const f = await fixture(); expect(f.row.externalId).toBeUndefined(); registerAwsDrivers();
    const driver = getDriver("aws", "aws:ecs_service");
    expect(driver.capabilities.compile).toBe(true); expect(driver.operations?.["drift.repair"]).toBeUndefined();
    const rt = createRuntime({ ...f.w.deps, drivers: (provider, nativeType) => provider === "aws" ? findDriver(provider, nativeType) : f.w.drivers(provider, nativeType) });
    const { ws } = await buildDeployWorkspace(rt, f.ec, f.graph, f.w.connections.connections[0]);
    expect(ws.addressMap[f.node.address]).toContain(tofuAddress); expect(ws.lockDigest).not.toBe(f.ws.lockDigest);
    expect(ws.files.map((file) => file.content).join("\n")).toContain("deployment_circuit_breaker");
    const prepared = await f.prepare(rt, ws);
    expect(prepared.binding.serviceArn).toBe(arn); expect(f.row.externalId).toBeUndefined();
    expect(prepared.binding.backendDigest).toBe(digest(ws.files.filter((file) => file.path === "backend.tf.json")));
    expect(tagging.commandCalls(GetResourcesCommand)).toHaveLength(1); expect(f.w.tofu.applyCalls).toHaveLength(0);
  });
  it("does not retarget the original binding when a later tag lookup resolves a different service", async () => {
    const f = await fixture(); await f.prepare(); const moved = arn.replace("/web", "/moved");
    tagging.on(GetResourcesCommand).resolves({ $metadata: { httpStatusCode: 200 }, ResourceTagMappingList: [{ ResourceARN: moved,
      Tags: Object.entries(ownedTags).map(([Key, Value]) => ({ Key, Value })) }] });
    ecs.on(DescribeServicesCommand).callsFake(() => ({ $metadata: { httpStatusCode: 200 }, services: [{ serviceArn: moved, clusterArn: cluster,
      serviceName: "moved", status: "ACTIVE", launchType: "FARGATE", schedulingStrategy: "REPLICA", desiredCount: 1, taskDefinition: task,
      createdAt: new Date("2026-09-01T00:00:00Z"), tags: Object.entries(ownedTags).map(([key, value]) => ({ key, value })) }] }));
    await expect(f.prepare()).rejects.toThrow("immutable ECS replica-only recipe");
    expect(f.w.evidence.ofKind("observation")).toHaveLength(1); expect(f.w.tofu.applyCalls).toHaveLength(0);
  });
  it.each(["missing", "ambiguous", "foreign", "denied"])("keeps a normal managed row unbound when initial tag authority is unconfirmed (%s)", async (failure) => {
    const f = await fixture(); const mapping = { ResourceARN: failure === "foreign" ? arn.replace("123456789012", "999999999999") : arn,
      Tags: Object.entries(ownedTags).map(([Key, Value]) => ({ Key, Value })) };
    if (failure === "denied") tagging.on(GetResourcesCommand).rejects(new Error("private tag API failure"));
    else tagging.on(GetResourcesCommand).resolves({ $metadata: { httpStatusCode: 200 },
      ResourceTagMappingList: failure === "missing" ? [] : failure === "ambiguous" ? [mapping, mapping] : [mapping] });
    await expect(f.prepare()).rejects.toThrow("complete real ownership");
    expect(f.w.evidence.ofKind("observation")).toHaveLength(0); expect(f.w.tofu.applyCalls).toHaveLength(0);
    expect(f.row.externalId).toBeUndefined();
  });
  it("advertises the declarative recipe without requiring a dummy native handler or prederived repair flags", async () => {
    const f = await fixture();
    const finding: DriftFinding = { address: f.node.address, class: "changed", severity: "medium", fields: [{ attribute: "replicas", desired: 3, observed: 1 }],
      repairable: false, autoRepairEligible: false, explanation: "replica drift" };
    expect(supportsDeclarativeRepair(f.node, finding)).toBe(true);
    expect(f.w.tofu.applyCalls).toHaveLength(0); expect(ecs.calls()).toHaveLength(0);
  });
  it.each(["provider", "native-type", "kind", "ownership", "address", "missing", "severity", "zero", "over-limit", "fraction",
    "other-field", "multiple-fields", "desired-mismatch", "unknown-observed", "unchanged", "mutable-image"])("does not advertise an unsupported declarative recipe (%s)", async (failure) => {
    const f = await fixture();
    const finding: DriftFinding = { address: f.node.address, class: "changed", severity: "medium", fields: [{ attribute: "replicas", desired: 3, observed: 1 }],
      repairable: true, autoRepairEligible: true, explanation: "candidate" };
    if (failure === "provider") f.node.provider = "gcp";
    if (failure === "native-type") f.node.nativeType = "aws:other";
    if (failure === "kind") f.node.kind = "compute_instance";
    if (failure === "ownership") f.node.ownership = "referenced";
    if (failure === "address") finding.address = "container_service/foreign";
    if (failure === "missing") finding.class = "missing";
    if (failure === "severity") finding.severity = "high";
    if (failure === "zero") f.node.spec.replicas = 0;
    if (failure === "over-limit") f.node.spec.replicas = 21;
    if (failure === "fraction") f.node.spec.replicas = 1.5;
    if (failure === "other-field") finding.fields![0].attribute = "image";
    if (failure === "multiple-fields") finding.fields!.push({ attribute: "cpu", desired: 512, observed: 256 });
    if (failure === "desired-mismatch") finding.fields![0].desired = 4;
    if (failure === "unknown-observed") finding.fields![0].observed = "unknown";
    if (failure === "unchanged") finding.fields![0].observed = 3;
    if (failure === "mutable-image") f.node.spec.artifact = { type: "image", ref: "nginx:latest" };
    expect(supportsDeclarativeRepair(f.node, finding)).toBe(false);
  });
  it("pins the binding once, includes its digest in configuration and returns the original binding on retry", async () => {
    const f = await fixture(); const first = await f.prepare(); const second = await f.prepare();
    expect(first.binding).toEqual(second.binding); expect(first.ws.configDigest).not.toBe(f.ws.configDigest);
    expect(f.w.evidence.ofKind("observation")).toHaveLength(1);
    expect(first.ws.files.at(-1)?.content).toContain(repairBindingDigest(first.binding));
  });
  it.each(["graph", "ownership", "revision", "connection", "arn", "replicas", "mutable-image", "legacy-input"])("refuses moved or unsupported materialization before any apply (%s)", async (failure) => {
    const f = await fixture(); await f.prepare();
    if (failure === "graph") f.graph.graphDigest = "f".repeat(64);
    if (failure === "ownership") f.row.ownership = "external";
    if (failure === "revision") f.w.product.base.environment.deployedRevisionId = "missing";
    if (failure === "connection") f.w.connections.connections[0].id = "changed";
    if (failure === "arn") f.row.externalId = arn.replace("/web", "/other");
    if (failure === "replicas") replicas = 2;
    if (failure === "mutable-image") f.node.spec.artifact = { type: "image", ref: "nginx:latest" };
    if (failure === "legacy-input") f.ec.op.proposal.input = { repair: "reapply_desired", via: "opentofu" };
    await expect(f.prepare()).rejects.toThrow(); expect(f.w.tofu.applyCalls).toHaveLength(0);
    expect(f.w.evidence.ofKind("observation")).toHaveLength(1);
  });
  it("refuses unknown SDK read results without persisting a binding", async () => {
    const f = await fixture(); denyRead = true;
    await expect(f.prepare()).rejects.toThrow("complete real ownership"); expect(f.w.evidence.ofKind("observation")).toHaveLength(0);
  });
});

describe("raw full-environment repair plan", () => {
  it("permits exactly one known desired_count update on the bound service", async () => {
    const f = await fixture(); const prepared = await f.prepare();
    const document = raw(); const plan = normalizePlan(document, { configDigest: prepared.ws.configDigest, lockDigest: prepared.ws.lockDigest, addressMap: prepared.ws.addressMap });
    expect(() => assertEcsReplicaRepairPlan(plan, document, prepared.binding, prepared.ws)).not.toThrow();
  });
  it.each(["extra-field", "extra-resource", "replace", "unknown", "sensitive", "foreign-id", "foreign-cluster", "task-definition", "provider", "output"])("rejects changes outside the reviewed field (%s)", async (failure) => {
    const f = await fixture(); const prepared = await f.prepare(); const document = raw(); const change = document.resource_changes![0].change!;
    if (failure === "extra-field") change.after = { ...(change.after as object), name: "other" };
    if (failure === "extra-resource") document.resource_changes!.push({ address: "aws_s3_bucket.extra", mode: "managed", type: "aws_s3_bucket", change: { actions: ["create"], before: null, after: { bucket: "extra" } } });
    if (failure === "replace") change.actions = ["delete", "create"];
    if (failure === "unknown") change.after_unknown = { desired_count: true };
    if (failure === "sensitive") change.after_sensitive = { desired_count: true };
    if (failure === "foreign-id") { change.before = { ...(change.before as object), id: "foreign-arn" }; change.after = { ...(change.after as object), id: "foreign-arn" }; }
    if (failure === "foreign-cluster") { change.before = { ...(change.before as object), cluster: "foreign" }; change.after = { ...(change.after as object), cluster: "foreign" }; }
    if (failure === "task-definition") { change.before = { ...(change.before as object), task_definition: "foreign" }; change.after = { ...(change.after as object), task_definition: "foreign" }; }
    if (failure === "provider") document.resource_changes![0].provider_name = "registry.example.invalid/foreign/aws";
    if (failure === "output") document.output_changes = { out: { actions: ["update"], before: 1, after: 3 } };
    const plan = normalizePlan(document, { configDigest: prepared.ws.configDigest, lockDigest: prepared.ws.lockDigest, addressMap: prepared.ws.addressMap });
    expect(() => assertEcsReplicaRepairPlan(plan, document, prepared.binding, prepared.ws)).toThrow("nothing was applied");
  });
});

describe("existing plan/apply activity integration", () => {
  async function reviewed() {
    const f = await fixture();
    const scriptedPlan=f.w.tofu.planWorkspace.bind(f.w.tofu);
    f.w.tofu.planFactory=ws=>normalizePlan(raw(),{configDigest:ws.configDigest,lockDigest:ws.lockDigest,addressMap:ws.addressMap});
    f.w.tofu.planWorkspace = async (ws, session, opts = {}) => {
      const result=await scriptedPlan(ws,session,opts);
      await opts.inspectPlan?.(result.plan,raw());
      return result; // Retain this isolated engine's produced handle and private bytes.
    };
    const planned = await f.w.activities.planInfrastructure({ operationId: OP, lease: f.lease });
    Object.assign(f.w.ops.ops.get(OP)!, { approvalRound: 1 });
    expect(approvalRoundOf(f.w.ops.ops.get(OP)!)).toBe(1);
    f.w.broker.approval = { approved: true, rejected: false, approvalId: "browser-approval" };
    let applies = 0;
    f.w.tofu.applyVerifiedPlan = async (ws, args) => {
      const document = raw(); const plan = normalizePlan(document, { configDigest: ws.configDigest, lockDigest: ws.lockDigest, addressMap: ws.addressMap });
      expect(plan.planDigest).toBe(args.approvedDigest); await args.inspectPlan?.(plan, document); await args.beforeDispatch?.(); applies++;
      replicas = 3;
      return { plan, apply: { command: "apply", exitCode: 0, output: "", truncated: false, durationMs: 1 }, outputs: {} };
    };
    return { ...f, planned, applies: () => applies };
  }
  async function expectUncertainReadback(f: Awaited<ReturnType<typeof reviewed>>) {
    const error = await f.w.activities.applyInfrastructure({ operationId: OP, planDigest: f.planned.planDigest, lease: f.lease })
      .catch((err: unknown) => err);
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(ApplicationFailure);
    expect(error).toHaveProperty("message", "The apply ended with an unclassified error (ECS replica repair may have applied, but readback authority or evidence is unavailable. Inspect this operation before any further write.); partial apply; reconcile will observe the environment.");
    expect(classifyFailure({ step: "apply_infrastructure", err: error, mutationStarted: true }).status).toBe("uncertain");
    expect(ACTIVITY_OPTIONS.applyInfrastructure.retry?.maximumAttempts).toBe(1);
    expect(f.applies()).toBe(1);
    expect(f.w.ops.ops.get(OP)!.status).toBe("uncertain");
    expect(f.w.ops.uncertain).toEqual([{ operationId: OP, reason: expect.stringMatching(/^The apply ended with an unclassified error \(Error: ECS replica repair may have applied/) }]);
    expect(f.w.ops.transitions.some((transition) => transition.to === "succeeded")).toBe(false);
    expect(f.w.events.events.some((event) => event.type === "operation.succeeded")).toBe(false);
  }
  it("uses saved-plan apply and exact readback, with no generic native dispatch or zero-probe clearance", async () => {
    const f = await reviewed();
    await f.w.activities.applyInfrastructure({ operationId: OP, planDigest: f.planned.planDigest, lease: f.lease });
    expect(f.applies()).toBe(1); expect(f.w.evidence.ofKind("verification")[0].summary).toMatchObject({ status: "passed", checks: 1, observedReplicas: 3 });
    expect(f.w.broker.grants.filter((g) => !g.capability)).toHaveLength(1);
  });
  it("refuses missing human approval before invoking saved-plan apply", async () => {
    const f = await reviewed(); f.w.broker.approval = { approved: false, rejected: false };
    await expect(f.w.activities.applyInfrastructure({ operationId: OP, planDigest: f.planned.planDigest, lease: f.lease })).rejects.toThrow("human approval");
    expect(f.applies()).toBe(0);
  });
  it("retains uncertainty after one apply when all three verification appends fail", async () => {
    const f = await reviewed(); const append = f.w.evidence.append.bind(f.w.evidence);
    let verificationAttempts = 0;
    f.w.evidence.append = async (input) => {
      if (input.kind === "verification") { verificationAttempts++; throw new Error("private ledger failure"); }
      return append(input);
    };
    await expectUncertainReadback(f);
    expect(f.applies()).toBe(1); expect(verificationAttempts).toBe(3);
    expect(f.w.evidence.ofKind("verification")).toHaveLength(0);
    expect(f.w.ops.ops.get(OP)!.status).toBe("uncertain");
    expect(f.w.ops.transitions.some((transition) => transition.to === "succeeded")).toBe(false);
    expect(f.w.events.events.some((event) => event.type === "operation.succeeded")).toBe(false);
  });
  it.each(["workspace", "operation", "kind", "digest", "simulated", "summary"])("refuses a mismatched verification receipt after apply (%s)", async (failure) => {
    const f = await reviewed(); const append = f.w.evidence.append.bind(f.w.evidence);
    f.w.evidence.append = async (input) => {
      const receipt = await append(input);
      if (input.kind !== "verification") return receipt;
      return { ...receipt, ...(failure === "workspace" ? { workspaceId: "foreign" } : {}),
        ...(failure === "operation" ? { operationId: "foreign" } : {}), ...(failure === "kind" ? { kind: "observation" as const } : {}),
        ...(failure === "digest" ? { digest: "f".repeat(64) } : {}), ...(failure === "simulated" ? { simulated: true } : {}),
        ...(failure === "summary" ? { summary: { ...receipt.summary, checks: 0 } } : {}) };
    };
    await expectUncertainReadback(f);
    expect(f.applies()).toBe(1); expect(f.w.ops.ops.get(OP)!.status).toBe("uncertain");
  });
  it.each(["readback", "lost-response", "nonzero-exit", "fence"])("preserves uncertainty after an attempted apply (%s)", async (failure) => {
    const f = await reviewed(); const apply = f.w.tofu.applyVerifiedPlan.bind(f.w.tofu);
    f.w.tofu.applyVerifiedPlan = async (...args) => {
      const result = await apply(...args);
      if (failure === "readback") denyRead = true;
      if (failure === "lost-response") throw new Error("Accepted then lost response");
      if (failure === "nonzero-exit") throw new TofuCommandError("tofu_command_failed", "private provider error", { ...result.apply, exitCode: 1 });
      if (failure === "fence") f.w.leases.steal(f.lease.scope);
      return result;
    };
    await expect(f.w.activities.applyInfrastructure({ operationId: OP, planDigest: f.planned.planDigest, lease: f.lease })).rejects.toThrow();
    expect(f.applies()).toBe(1); expect(f.w.ops.ops.get(OP)!.status).toBe("uncertain");
    expect(f.w.evidence.ofKind("verification")).toHaveLength(0);
  });
});
