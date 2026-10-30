/**
 * DEPLOY-01 ProductScenarioPort, offline: fake browser driver, in-memory AWS answered only for planned calls through the real
 * Guard, fake recorded state and HTTP probe. No cloud, stack or OpenTofu is used.
 */
import { describe, expect, it } from "vitest";
import { buildPlan } from "../../scripts/acceptance/live/plan";
import { grantsFor, Guard } from "../../scripts/acceptance/live/guard";
import type { Call, Json, Plan } from "../../scripts/acceptance/live/contracts";
import { trustDocument } from "../../scripts/acceptance/live/product/mix-03";
import { DEPLOY01_IMAGES, deploy01Port } from "../../scripts/acceptance/live/product/deploy-01";
import { browserDeploy01Product, failedCheckRefs, sanitizedError, type Deploy01Product } from "../../scripts/acceptance/live/product/deploy-01-driver";
import type { Ops02Stack } from "../../scripts/acceptance/live/product/ops-02-stack";
import { dispatchRequirementGap } from "@/lib/platform/broker";

const ACCOUNT = "123456789012", REGION = "ap-south-1", RUN = "zlive-202610260000-ab01";
const PRINCIPAL = `arn:aws:iam::${ACCOUNT}:role/ZenithLiveAcceptance`;
const OLD_EXT = "old-live-external-id", NEW_EXT = `zenith-${"c".repeat(32)}`;
const settings = { accountId: ACCOUNT, region: REGION, runId: RUN, durationMinutes: 60, dbSubnetGroup: "zenith-live-sandbox", dbSecurityGroup: "sg-12345678", workloadBoundaryArn: `arn:aws:iam::${ACCOUNT}:policy/ZenithLiveWorkloadBoundary`, scenario: "deploy-01" as const };
const env = { ZENITH_LIVE_PRODUCT: "1" };
const requirement = { id: "PROD-REL-01", acceptance: [], fixtures: [], join: "" };
const COMMIT = "a".repeat(40);
const DNS = "zenith-web-123.ap-south-1.elb.amazonaws.com";

interface Ops02Opts { quietRefused?: boolean; neverFires?: boolean; servesDuringOutage?: boolean; noFloodRefusal?: boolean }
function harness(opts: { deployStatus?: string; leftAfterDestroy?: number; keepVpc?: boolean; image?: (n: number) => string; ops02?: Ops02Opts } = {}) {
  const o2 = opts.ops02;
  const events: string[] = [];
  let tenants = 0, down = false, closed = false;
  const ops02: Ops02Stack = {
    observe: async () => { events.push("observe"); },
    query: async (expr) => expr.includes("zenith_control_store_up") ? [{ metric: {}, value: 1 }]
      : expr.includes('tenant=~"ws1"') ? [{ metric: { tenant: "ws1" }, value: 400 }] : expr.includes('tenant=~"ws2"') && o2?.quietRefused ? [{ metric: { tenant: "ws2" }, value: 3 }] : [],
    firing: async () => (o2?.neverFires ? [] : ["ZenithControlStoreDown"]),
    stopControlStore: async () => { events.push("store:stop"); down = true; },
    startControlStore: async () => { events.push("store:start"); down = false; },
    stop: async (s) => { events.push(`stop:${s.join("+")}`); },
    start: async (s) => { events.push(`start:${s}`); },
    close: async () => { closed = true; },
  };
  const trust = { observe: trustDocument(PRINCIPAL, OLD_EXT), deploy: trustDocument(PRINCIPAL, OLD_EXT) };
  const images: string[] = [];
  let destroyed = false;
  const connections: Record<string, unknown>[] = [];
  const CLUSTER = `arn:aws:ecs:${REGION}:${ACCOUNT}:cluster/zenith-x-web`;
  const product: Deploy01Product = {
    createTenant: async () => (++tenants === 1 ? { workspaceId: "ws1", projectId: "p1" } : { workspaceId: "ws2", projectId: "p2" }),
    burst: async (t, count) => ({ statuses: (t.workspaceId === "ws1" && count > 1 && !o2?.noFloodRefusal ? { "200": 200, "429": count - 200 } : { "200": count }) as Record<string, number>, durationsMs: new Array(count).fill(12) }),
    createAwsConnection: async (_t, input) => { connections.push(input); return { connectionId: "c1", externalId: NEW_EXT }; },
    verifyAws: async () => ({ ok: true }),
    createEnvironment: async () => ({ environmentId: "env1" }),
    setManifest: async (_t, m) => { images.push(((m.services as { source: { image: string } }[])[0]!).source.image); },
    deploy: async (_t, _e, kind) => { if (kind === "rollback") images.push(images[images.length - 2]!); return { operationId: "op", status: opts.deployStatus ?? "succeeded", ...(opts.deployStatus ? { detail: "the plan failed" } : {}) }; },
  };
  const plan: Plan = buildPlan(o2 ? { ...settings, scenario: "ops-02" } : settings);
  const permission = {
    schema: 1 as const, decision: "DEC-CLOUD" as const, approvedBy: "owner-test", approvedAt: "2020-01-01T00:00:00.000Z", expiresAt: "2099-01-01T00:00:00.000Z",
    accountId: ACCOUNT, region: REGION, runId: RUN, planSha256: plan.sha256, sourceCommit: COMMIT, maxUsd: plan.estimate.usd, maxMinutes: plan.settings.durationMinutes, grants: grantsFor(plan),
  };
  const guard = new Guard(plan, permission, plan.estimate.usd);
  const sent: string[] = [];
  const call = async (c: Call, input?: Record<string, Json>) => {
    guard.consume(c); sent.push(c.id);
    const i = input ?? c.input;
    switch (c.id) {
      case "deploy01-iam-read-observe": return { Role: { AssumeRolePolicyDocument: encodeURIComponent(trust.observe) } };
      case "deploy01-iam-read-deploy": return { Role: { AssumeRolePolicyDocument: encodeURIComponent(trust.deploy) } };
      case "deploy01-iam-trust-observe": trust.observe = String(i.PolicyDocument); return {};
      case "deploy01-iam-trust-deploy": trust.deploy = String(i.PolicyDocument); return {};
      case "deploy01-sts-assume": expect(i.ExternalId).toBe(NEW_EXT); return { Credentials: { AccessKeyId: "A", SecretAccessKey: "S", SessionToken: "T" } };
      case "deploy01-tag-read": return { ResourceTagMappingList: destroyed ? [{ ResourceARN: CLUSTER }, ...new Array(opts.leftAfterDestroy ?? 0).fill({ ResourceARN: `arn:aws:elasticloadbalancing:${REGION}:${ACCOUNT}:loadbalancer/app/zenith-x/1` }), { ResourceARN: `arn:aws:ec2:${REGION}:${ACCOUNT}:natgateway/nat-0abc` }, { ResourceARN: `arn:aws:ecs:${REGION}:${ACCOUNT}:task/zenith-x-web/${"a".repeat(32)}` }, { ResourceARN: `arn:aws:ecs:${REGION}:${ACCOUNT}:task-definition/zenith-x-web:1` }, { ResourceARN: `arn:aws:ec2:${REGION}:${ACCOUNT}:subnet/subnet-0def` }] : [] };
      default: throw new Error(`unexpected ${c.id}`);
    }
  };
  const state = {
    read: async () => ({ resources: [
      { type: "aws_ecs_task_definition", instances: [{ attributes: { container_definitions: JSON.stringify([{ image: (opts.image ?? (() => images[images.length - 1]!))(images.length) }]) } }] },
      { type: "aws_lb", instances: [{ attributes: { dns_name: DNS } }] },
    ] }),
    destroy: async (input: { stateKey: string }) => { expect(input.stateKey).toBe("zenith/ws1/env1/terraform.tfstate"); destroyed = true; return { destroyed: 20, destroyedArns: [CLUSTER, `arn:aws:ecs:${REGION}:${ACCOUNT}:task-definition/zenith-x-web:3`, ...(opts.keepVpc ? [] : [`arn:aws:ec2:${REGION}:${ACCOUNT}:vpc/vpc-0abc`])], destroyedIds: ["nat-0abc"] }; },
  };
  const port = deploy01Port(env, { product, sleep: () => new Promise<void>(resolve => setImmediate(resolve)), propagation: { attempts: 2, intervalMs: 0 },
    probe: async (dns, host) => (dns === DNS && host.startsWith("web-") && !(down && o2?.servesDuringOutage === false) ? 200 : 503), state, ...(o2 ? { ops02 } : {}) });
  return { trust, images, sent, connections, events, closed: () => closed, run: () => port.verify(o2 ? { ...requirement, id: "PROD-OPS-02" } : requirement, { plan, commit: COMMIT, call }) };
}

describe("DEPLOY-01 driver error detail", () => {
  it("elides ARNs, key=value pairs, URLs, paths and long tokens and bounds the length", () => {
    expect(sanitizedError("AccessDenied for arn:aws:iam::123456789012:role/x when key=secret at https://x.example/a in /tmp/a/b token AKIAABCDEFGHIJKLMNOPQRSTUV")).toBe("AccessDenied for …arn when …=… at …url in …path token …");
    expect(sanitizedError("x".repeat(500))!.length).toBeLessThanOrEqual(240);
    expect(sanitizedError(undefined)).toBeUndefined();
    // The apply's full cause: class, code and the OpenTofu failure code (src/lib/execution/apply.ts).
    expect(sanitizedError("The apply ended with an unclassified error (Error: Original plan dispatch outcome is unconfirmed; inspect this operation before another write.; cause TofuCommandError/tofu_failed/apply:api_AccessDeniedException).")).toBe("The apply ended with an unclassified error (Error: Original plan dispatch outcome is unconfirmed; inspect this operation before another write.). [cause TofuCommandError/tofu_failed/apply:api_AccessDeniedException]");
    expect(sanitizedError("The apply ended with an unclassified error (Error: Reviewed plan artifact is unavailable or changed; a new review is required.; cause Gate/requirement:plan-facts).")).toBe("The apply ended with an unclassified error (Error: Reviewed plan artifact is unavailable or changed; a new review is required.). [cause Gate/requirement:plan-facts]");
  });
});

describe("DEPLOY-01 driver deploy approval", () => {
  it("retries deploy.approve on HTTP 409 while the operation changes state, then waits for the terminal status", async () => {
    const owner = {} as never, approver = {} as never;
    const tenant = { workspaceId: "ws1", projectId: "p1", owner, approver, stack: {}, ownerSecret: "o", approverSecret: "a" };
    let conflicts = 2;
    const request = async (_page: unknown, endpoint: string) => {
      if (endpoint === "/api/actions/deploy.apply") return { status: 200, data: { result: { ok: true, data: { operationId: "op1", deploymentId: "d1" } } } };
      if (endpoint === "/api/actions/deploy.approve") return conflicts-- > 0 ? { status: 409, data: { error: { code: "conflict" } } } : { status: 200, data: { result: { ok: true } } };
      if (endpoint.startsWith("/api/platform/v1/operations/")) return { status: 200, data: { operation: { status: "succeeded", approvalRound: 1 } } };
      throw new Error(endpoint);
    };
    const product = browserDeploy01Product({}, { request: request as never, approve: async () => undefined, session: async () => ({ tenant: tenant as never, close: async () => undefined }), sleep: async () => undefined });
    const t = await product.createTenant();
    await expect(product.deploy(t, "env1", "apply")).resolves.toEqual({ operationId: "op1", status: "succeeded" });
    expect(conflicts).toBe(-1);
  });

  it("names the product's sanitized reason when deploy.approve is refused", async () => {
    const tenant = { workspaceId: "ws1", projectId: "p1", owner: {}, approver: {}, stack: {}, ownerSecret: "o", approverSecret: "a" };
    const request = async (_page: unknown, endpoint: string) => {
      if (endpoint === "/api/actions/deploy.apply") return { status: 200, data: { result: { ok: true, data: { operationId: "op1", deploymentId: "d1" } } } };
      if (endpoint === "/api/actions/deploy.approve") return { status: 200, data: { result: { ok: false, error: "Approval is not open for this deployment at https://x.example/y" } } };
      throw new Error(endpoint);
    };
    const product = browserDeploy01Product({}, { request: request as never, approve: async () => undefined, session: async () => ({ tenant: tenant as never, close: async () => undefined }), sleep: async () => undefined });
    const t = await product.createTenant();
    await expect(product.deploy(t, "env1", "apply")).rejects.toThrow("deploy.approve was refused by the product (Approval is not open for this deployment at …url)");
  });
});

describe("DEPLOY-01 failed infrastructure checks", () => {
  it("lists only address:check references from the verification evidence", () => {
    expect(failedCheckRefs({ nodes: [
      { address: "container_service/web", status: "failed", failed: ["service_steady", "secret=abc"] },
      { address: "network/main", status: "passed", failed: [] },
      { address: "lb/public", status: "failed", failed: ["listener_80"] },
    ] })).toEqual(["container_service/web:service_steady", "lb/public:listener_80"]);
    expect(failedCheckRefs(undefined)).toEqual([]);
  });
});

describe("dispatch requirement gap (the product cause code DEPLOY-01 reports)", () => {
  it("names a missing or unregistered snapshot with a fixed code", async () => {
    const sql = {} as never;
    expect(await dispatchRequirementGap(undefined, sql, "ws", "op")).toBe("no-snapshot");
    expect(await dispatchRequirementGap({ approvalIds: [] }, sql, "ws", "op")).toBe("not-registered");
  });
});

describe("DEPLOY-01 port", () => {
  it("deploys, updates and rolls back with readback, then destroys the recorded state and restores trust", async () => {
    const h = harness();
    const result = await h.run();
    expect(result.complete).toBe(true);
    expect(h.images).toEqual([DEPLOY01_IMAGES.v1, DEPLOY01_IMAGES.v2, DEPLOY01_IMAGES.v1]);
    expect(h.trust).toEqual({ observe: trustDocument(PRINCIPAL, OLD_EXT), deploy: trustDocument(PRINCIPAL, OLD_EXT) });
    expect(h.sent.filter(id => id === "deploy01-tag-read")).toHaveLength(1);
    // The sandbox stack's roles and boundaries carry NameSuffix "-live"; without it the product names the wrong boundary.
    expect(h.connections).toEqual([expect.objectContaining({ bootstrapNameSuffix: "-live", stateBucket: `zenith-state-${ACCOUNT}-${REGION}-live` })]);
  });
  it("refuses when a deploy does not succeed, and still cleans up", async () => {
    const h = harness({ deployStatus: "failed" });
    const result = await h.run();
    expect(result.complete).toBe(false);
    expect(result.reason).toMatch(/at first deploy: the first deploy ended failed, not succeeded \(product: the plan failed\)/);
    expect(h.trust.deploy).toBe(trustDocument(PRINCIPAL, OLD_EXT));
  });
  it("refuses when the recorded image does not match the deployed revision", async () => {
    const result = await harness({ image: () => "public.ecr.aws/nginx/nginx:9.9" }).run();
    expect(result.complete).toBe(false);
    expect(result.reason).toMatch(/does not run public\.ecr\.aws\/nginx\/nginx@sha256:df80ece7/);
  });
  it("reports leaks when tagged resources remain after the destroy, excusing only ECS clusters the destroy removed", async () => {
    const h = harness({ leftAfterDestroy: 2 });
    const result = await h.run();
    // The tagging index lags deletes: it is re-listed before anything is called a leak.
    expect(h.sent.filter(id => id === "deploy01-tag-read")).toHaveLength(4);
    expect(result.complete).toBe(false);
    expect(result.leaks).toEqual(["2 tagged resource(s) still present after cleanup (elasticloadbalancing:loadbalancer)"]);
  });
  it("reports a listed subnet when the destroy did not remove the VPC", async () => {
    const result = await harness({ keepVpc: true }).run();
    expect(result.leaks).toEqual(["1 tagged resource(s) still present after cleanup (ec2:subnet)"]);
  });
  it("is only for PROD-REL-01 and refuses without the live product flag", async () => {
    const plan = buildPlan(settings);
    const port = deploy01Port({}, { product: {} as Deploy01Product });
    expect((await port.verify({ ...requirement, id: "PROD-MIX-03" }, { plan, commit: COMMIT, call: async () => ({}) })).reason).toMatch(/not implemented/);
    expect((await port.verify(requirement, { plan, commit: COMMIT, call: async () => ({}) })).reason).toMatch(/ZENITH_LIVE_PRODUCT=1 is not set/);
  });
});

describe("OPS-02 on the DEPLOY-01 port", () => {
  it("compares two tenants on real metrics, then keeps the workload serving through a control-plane outage", async () => {
    const h = harness({ ops02: {} });
    const result = await h.run();
    expect(result.reason).toMatch(/^OPS-02 proven on AWS: .* refused 400 times \(HTTP 429\) while a second tenant's 20 concurrent requests were all served/);
    expect(result.complete).toBe(true);
    expect(h.events).toEqual(["observe", "store:stop", "stop:api+execution-worker", "store:start", "start:api", "start:execution-worker"]);
    expect(h.images).toEqual([DEPLOY01_IMAGES.v1]);
    expect(h.closed()).toBe(true);
    expect(h.trust.deploy).toBe(trustDocument(PRINCIPAL, OLD_EXT));
  });
  it.each([
    [{ noFloodRefusal: true }, "tenant fairness: the flooding tenant was never refused (200: 600)"],
    [{ quietRefused: true }, "tenant metrics: Prometheus shows refusals for the quiet tenant"],
    [{ neverFires: true }, "control-plane restart: ZenithControlStoreDown did not fire within 5 minutes of the control store stopping"],
    [{ servesDuringOutage: false }, "control-plane restart: the workload did not serve every probe during the outage"],
  ] as [Ops02Opts, string][])("refuses %o, restarts the control plane and still cleans up", async (ops02, reason) => {
    const h = harness({ ops02 });
    const result = await h.run();
    expect(result.complete).toBe(false);
    expect(result.reason.startsWith(`OPS-02 not proven at ${reason}`)).toBe(true);
    expect(h.closed()).toBe(true);
    if (h.events.includes("store:stop")) expect(h.events.slice(-3)).toEqual(["store:start", "start:api", "start:execution-worker"]);
  });
});
