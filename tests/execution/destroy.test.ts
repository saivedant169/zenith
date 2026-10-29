/** Scripted tofu and driver contracts; SDK DNS calls are mocked, no cloud execution. */
import { afterEach, describe, expect, it, vi } from "vitest";
import { createWorld, type World } from "./fakes/world";
import { bucketManifest, change, makePlan, CANARY_SECRET, CANARY_SESSION_KEY, ENV, OP, REVISION, webDbManifest } from "./fakes/fixtures";
import { baseTags, executionExtraTags } from "@/lib/execution/session";
import { LeaseLostError } from "@/lib/execution/errors";
import type { EngineOptions } from "@/lib/tofu/engine";
import type { Observation } from "@/lib/resources/types";
import { mockClient } from "aws-sdk-client-mock";
import { Route53Client, ListHostedZonesByNameCommand, ListResourceRecordSetsCommand } from "@aws-sdk/client-route-53";
import { ElasticLoadBalancingV2Client, DescribeLoadBalancersCommand, DescribeTagsCommand } from "@aws-sdk/client-elastic-load-balancing-v2";
import { assessRecordDeletion } from "@/lib/providers/aws/drivers/network/route53-record";
import { driverContext } from "@/lib/execution/session";
import { createRuntime } from "@/lib/execution/runtime";
import { loadExecContext } from "@/lib/execution/context";
import { requireExecutable } from "@/lib/execution/desired";

const worlds: World[] = [];
const dns = mockClient(Route53Client);
const elb = mockClient(ElasticLoadBalancingV2Client);
afterEach(() => { worlds.splice(0).forEach((w) => w.dispose()); dns.reset(); elb.reset(); });

function world() {
  const w = createWorld({ op: { capability: "infrastructure.destroy" } }); worlds.push(w);
  w.product.setManifest(bucketManifest());
  w.product.base.environment.deployedRevisionId = REVISION;
  w.tofu.planFactory = (ws) => makePlan({ configDigest: ws.configDigest, lockDigest: ws.lockDigest, changes: [change({ address: "aws_s3_bucket.object_store_assets", nodeAddress: "object_store/assets", type: "aws_s3_bucket", action: "delete", destroysData: true })] });
  return w;
}

async function allow(w: World) {
  // V1 upgrade defaults stateful deletion to retain; set explicit allow in V2.
  const { upgradeManifest } = await import("@/lib/resources/upgrade");
  const v2 = upgradeManifest(bucketManifest(), { provider: "aws", region: "us-east-1" });
  v2.policies = { backup: "daily", ...v2.policies, deletion: "allow" };
  w.product.setManifest(v2);
}

async function reviewed(w: World) {
  await allow(w);
  await w.activities.markOperation({ operationId: OP, status: "running" });
  const lease = await w.lease();
  const plan = await w.activities.planDestroyInfrastructure({ operationId: OP, lease });
  w.broker.approval = { approved: true, rejected: false, approvalId: "app-1" };
  return { lease, planDigest: plan.planDigest, operationId: OP };
}

describe("destroy execution activities", () => {
  it("refuses the default stateful retention policy", async () => {
    const w = world(); const lease = await w.lease();
    await expect(w.activities.planDestroyInfrastructure({ operationId: OP, lease })).rejects.toThrow(/deletionPolicy/);
    expect(w.tofu.applyCalls).toHaveLength(0);
  });
  it("records derived facts for policy and plans with weaker observe credentials", async () => {
    const w = world(); const args = await reviewed(w);
    expect(w.tofu.planCalls[0].opts).toMatchObject({ destroy: true, lock: false });
    expect(w.credentials.sessions[0]).toMatchObject({ purpose: "observe", capability: "infrastructure.plan", revoked: true });
    await w.activities.evaluatePolicy({ operationId: OP, planDigest: args.planDigest });
    expect(w.evidence.ofKind("tofu_plan")[0].summary).toMatchObject({ destroy: true, destroyAddresses: ["object_store/assets"] });
    expect(w.broker.reevaluations).toHaveLength(1);
    expect(w.broker.reevaluations[0].plan).toMatchObject({ destroysData: true, destroyedStatefulAddresses: ["aws_s3_bucket.object_store_assets"] });
    expect(w.stored()).not.toContain(CANARY_SECRET);
    expect(w.stored()).not.toContain(CANARY_SESSION_KEY);
  });
  it("rejects a wrong scope and a non-destroy capability", async () => {
    const w = world(); const lease = await w.lease();
    await expect(w.activities.planDestroyInfrastructure({ operationId: OP, lease: { ...lease, scope: "env:another" } })).rejects.toThrow(/environment/);
    w.ops.ops.get(OP)!.capability = "deployment.deploy";
    await expect(w.activities.planDestroyInfrastructure({ operationId: OP, lease })).rejects.toThrow(/infrastructure.destroy/);
    expect(w.tofu.planCalls).toHaveLength(0);
  });
  it("supports an infrastructure.plan operation for review before proposing destroy", async () => {
    const w = world(); await allow(w); w.ops.ops.get(OP)!.capability = "infrastructure.plan";
    const lease = await w.lease();
    expect((await w.activities.planDestroyInfrastructure({ operationId: OP, lease })).delete).toBe(1);
    expect(w.tofu.applyCalls).toHaveLength(0);
  });
  it("refuses unmapped state", async () => {
    const w = world(); await allow(w);
    w.tofu.planFactory = () => makePlan({ changes: [change({ address: "terraform_data.foreign", type: "terraform_data", action: "delete" })] });
    await expect(w.activities.planDestroyInfrastructure({ operationId: OP, lease: await w.lease() })).rejects.toThrow(/unmapped/);
  });
  it("requires current human approval before applying", async () => {
    const w = world(); const args = await reviewed(w); w.broker.approval.approved = false;
    await expect(w.activities.applyDestroyInfrastructure(args)).rejects.toThrow(/approval/);
    expect(w.tofu.applyCalls).toHaveLength(0);
  });
  it("never treats policy auto-approval as a human approval", async () => {
    const w = world(); const args = await reviewed(w);
    w.broker.approval = { approved: true, rejected: false };
    expect(await w.activities.checkApproval({ operationId: OP })).toEqual({ approved: false, rejected: false });
    await expect(w.activities.applyDestroyInfrastructure(args)).rejects.toThrow(/approval/);
    expect(w.tofu.applyCalls).toHaveLength(0);
  });
  it("uses a destroy re-plan and guards the verified apply", async () => {
    const w = world(); const args = await reviewed(w);
    const original = w.tofu.applyVerifiedPlan.bind(w.tofu);
    const call = vi.spyOn(w.tofu, "applyVerifiedPlan").mockImplementation(async (ws, options) => {
      const fresh = w.tofu.planFactory(ws, 2);
      await options.inspectPlan?.(fresh, {});
      return original(ws, options);
    });
    await expect(w.activities.applyDestroyInfrastructure(args)).resolves.toEqual({ deleted: 1 });
    expect((call.mock.calls[0][1] as EngineOptions).destroy).toBe(true);
    expect(w.credentials.sessions.at(-1)).toMatchObject({ purpose: "deploy", capability: "infrastructure.destroy", revoked: true });
  });
  it("refuses a final plan change", async () => {
    const w = world(); const args = await reviewed(w);
    const original = w.tofu.planFactory;
    w.tofu.planFactory = (ws, n) => ({ ...original(ws, n), planDigest: "b".repeat(64) });
    await expect(w.activities.finalDestroyPlan({ ...args, approvedPlanDigest: args.planDigest })).rejects.toMatchObject({ code: "plan_changed" });
    expect(w.tofu.applyCalls).toHaveLength(0);
  });
  it("reports lease loss without retrying or claiming absence", async () => {
    const w = world(); const args = await reviewed(w);
    vi.spyOn(w.tofu, "applyVerifiedPlan").mockImplementation(async (_ws,options)=>{
      await options.beforeDispatch?.(); // The engine accepted the dispatch boundary before losing its lease.
      throw new LeaseLostError(`env:${ENV}`,args.lease.fenceToken);
    });
    await expect(w.activities.applyDestroyInfrastructure(args)).rejects.toBeInstanceOf(LeaseLostError);
    expect(w.ops.ops.get(OP)!.status).toBe("uncertain");
  });
  it("lease loss before the engine reaches dispatch does not claim a provider write or uncertainty",async()=>{
    const w=world();const args=await reviewed(w);
    vi.spyOn(w.tofu,"applyVerifiedPlan").mockRejectedValue(new LeaseLostError(`env:${ENV}`,args.lease.fenceToken));
    await expect(w.activities.applyDestroyInfrastructure(args)).rejects.toBeInstanceOf(LeaseLostError);
    expect(w.ops.ops.get(OP)!.status).toBe("running");
    expect(w.evidence.ofKind("tofu_apply")).toHaveLength(0);
  });
  it("names the scrubbed cause when the teardown fails before dispatch", async () => {
    const w = world(); const args = await reviewed(w);
    vi.spyOn(w.tofu, "applyVerifiedPlan").mockRejectedValue(new Error("tofu init could not reach the state backend"));
    await expect(w.activities.applyDestroyInfrastructure(args)).rejects.toThrow("Teardown did not start; nothing was applied: tofu init could not reach the state backend");
    expect(w.ops.ops.get(OP)!.status).toBe("running");
  });
  it.each(["missing", "present", "unknown", "inaccessible"] as const)("observes %s with honest absence semantics", async (presence) => {
    const w = world(); const args = await reviewed(w);
    w.drivers("aws", "aws:s3_bucket")!.observe = async (_ctx, node) => ({ address: node.address, presence, attributes: {}, source: "contract-test", observedAt: "2026-10-01T00:00:00Z", simulated: false } satisfies Observation);
    const verified = await w.activities.verifyDestroyedInfrastructure(args);
    expect(verified.status).toBe(presence === "missing" ? "passed" : presence === "present" ? "failed" : "unknown");
  });
  it("does not count simulated missing observations as confirmed absence", async () => {
    const w = world(); const args = await reviewed(w);
    w.drivers("aws", "aws:s3_bucket")!.observe = async (_ctx, node) => ({ address: node.address, presence: "missing", attributes: {}, source: "simulated-test", observedAt: "2026-10-01T00:00:00Z", simulated: true });
    expect((await w.activities.verifyDestroyedInfrastructure(args)).status).toBe("unknown");
    expect(w.evidence.ofKind("verification")[0].simulated).toBe(true);
  });
  it("refuses a dangling DNS target before invoking tofu", async () => {
    const w = world(); w.product.setManifest(webDbManifest());
    dns.on(ListHostedZonesByNameCommand).resolves({ HostedZones: [{ Id: "Z123", Name: "atlas.zenith.test.", CallerReference: "test" }] });
    dns.on(ListResourceRecordSetsCommand).resolves({ ResourceRecordSets: [{ Name: "app.atlas.zenith.test.", Type: "A", AliasTarget: { DNSName: "foreign.example.com", HostedZoneId: "ZELB", EvaluateTargetHealth: false } }] });
    const arn = "arn:aws:elasticloadbalancing:us-east-1:123456789012:loadbalancer/app/owned/123";
    elb.on(DescribeLoadBalancersCommand).resolves({ LoadBalancers: [{ LoadBalancerArn: arn, Type: "application", DNSName: "owned.example.com" }] });
    const rt = createRuntime(w.deps); const ec = await loadExecContext(rt, OP);
    const graph = requireExecutable(rt, ec).graph;
    const lb = graph.nodes.find((n) => n.kind === "load_balancer")!;
    elb.on(DescribeTagsCommand).resolves({ TagDescriptions: [{ ResourceArn: arn, Tags: Object.entries({ ...baseTags(ec), "zenith:resource": lb.address }).map(([Key, Value]) => ({ Key, Value })) }] });
    // Prove this is the re-pointed target path, not an unreadable SDK mock.
    await w.credentials.withSession({ connectionId: "test", purpose: "observe", grant: (await w.broker.issueGrant(OP, "worker", undefined, { capability: "infrastructure.plan" })).claims }, async (session) => {
      if (session.provider !== "aws") throw new Error("expected AWS");
      const node = graph.nodes.find((n) => n.kind === "dns_record")!;
      const result = await assessRecordDeletion({ ...driverContext(rt, ec, session, new AbortController().signal, { node }), session }, node);
      expect(result).toMatchObject({ safe: false, reason: expect.stringContaining("foreign.example.com") });
    });
    await expect(w.activities.planDestroyInfrastructure({ operationId: OP, lease: await w.lease() })).rejects.toThrow(/DNS/);
    expect(w.tofu.planCalls).toHaveLength(0);
  });
  it("rechecks AWS DNS after the final approval lookup before accepting original destroy dispatch", async () => {
    const w = world(); w.product.setManifest(webDbManifest());
    await w.activities.markOperation({ operationId: OP, status: "running" });
    const rt = createRuntime(w.deps), ec = await loadExecContext(rt, OP);
    const graph = requireExecutable(rt, ec).graph;
    const node = graph.nodes.find(n => n.kind === "dns_record")!;
    const lb = graph.nodes.find(n => n.kind === "load_balancer")!;
    const arn = "arn:aws:elasticloadbalancing:us-east-1:123456789012:loadbalancer/app/owned/123";
    dns.on(ListHostedZonesByNameCommand).resolves({ HostedZones: [{ Id: "Z123", Name: "atlas.zenith.test.", CallerReference: "test" }] });
    dns.on(ListResourceRecordSetsCommand).resolves({ ResourceRecordSets: [{ Name: "app.atlas.zenith.test.", Type: "A", AliasTarget: { DNSName: "owned.example.com", HostedZoneId: "ZELB", EvaluateTargetHealth: false } }] });
    elb.on(DescribeLoadBalancersCommand).resolves({ LoadBalancers: [{ LoadBalancerArn: arn, Type: "application", DNSName: "owned.example.com" }] });
    elb.on(DescribeTagsCommand).resolves({ TagDescriptions: [{ ResourceArn: arn, Tags: Object.entries({ ...baseTags(ec), "zenith:resource": lb.address }).map(([Key, Value]) => ({ Key, Value })) }] });
    w.tofu.planFactory = ws => makePlan({ configDigest: ws.configDigest, lockDigest: ws.lockDigest, changes: [change({ address: "terraform_data.dns", nodeAddress: node.address, type: "terraform_data", action: "delete" })] });
    const lease = await w.lease();
    const planned = await w.activities.planDestroyInfrastructure({ operationId: OP, lease });
    w.broker.approval = { approved: true, rejected: false, approvalId: "human-browser-contract" };
    let approvalReads = 0, acceptedDispatch = false;
    vi.spyOn(w.broker, "approvalStatus").mockImplementation(async () => {
      if (++approvalReads === 2) dns.on(ListResourceRecordSetsCommand).resolves({ ResourceRecordSets: [{ Name: "app.atlas.zenith.test.", Type: "A", AliasTarget: { DNSName: "foreign-dispatch-canary.example.com", HostedZoneId: "ZELB", EvaluateTargetHealth: false } }] });
      return w.broker.approval;
    });
    const original = w.tofu.applyVerifiedPlan.bind(w.tofu);
    vi.spyOn(w.tofu, "applyVerifiedPlan").mockImplementation((ws, args) => original(ws, { ...args,
      beforeDispatch: async () => { await args.beforeDispatch?.(); acceptedDispatch = true; },
    }));
    await expect(w.activities.applyDestroyInfrastructure({ operationId: OP, planDigest: planned.planDigest, lease })).rejects.toThrow(/target ownership/);
    expect(acceptedDispatch).toBe(false);
    expect(w.evidence.ofKind("tofu_apply")).toHaveLength(0);
    expect(w.ops.uncertain).toHaveLength(0);
    expect(w.stored() + JSON.stringify(w.logs)).not.toContain("foreign-dispatch-canary");
  });
});

describe("allowlisted execution tags", () => {
  it("adds a creation-time live-run tag without changing reserved tags", () => {
    const w = world(); const ec = { workspaceId: "ws-1", environmentId: "env-1", product: w.product.base, op: { id: OP, proposal: { ...w.ops.ops.get(OP)!.proposal, input: { executionTags: { "zenith:live-run": "zlive-202610010900-ab12" } } } } };
    expect(baseTags(ec)).toMatchObject({ "zenith:live-run": "zlive-202610010900-ab12", "zenith:managed": "true", "zenith:environment": "env-1" });
  });
  it.each([{ "zenith:environment": "foreign" }, { "zenith:live-run": "bad\nvalue" }, { password: "canary" }, []])("refuses unallowlisted or invalid tags %j", (tags) => {
    expect(() => executionExtraTags(tags)).toThrow();
  });
});
