/**
 * PROD-MIX-03 browser driver (`browserMix03Product`), offline. Every product call goes through a fake request layer that
 * records the page, endpoint, method, body and workspace header; approvals, step-up, the signed-in session and the wait between
 * deployment readbacks are fakes. No browser, stack, AWS call or network access happens here.
 */
import type { Page } from "@playwright/test";
import { describe, expect, it, vi } from "vitest";
import { buildPlan } from "../../scripts/acceptance/live/plan";
import { mix03Port } from "../../scripts/acceptance/live/product/mix-03";
import { expandManifest } from "@/lib/resources";
import { parseManifest } from "@/lib/resources/manifest-v2";
import { buildParentPlan } from "@/lib/execution/mixed/parent-plan";
import { connection, PARENT_ENV, PROJECT, WS } from "../execution/mixed/_fixtures";
import {
  browserMix03Product, MIX03_REFERENCE, mix03Manifests, runnerStack, type ProductRequest, type RunnerStack, type TenantSession,
} from "../../scripts/acceptance/live/product/mix-03-driver";

const STACK: RunnerStack = { apiUrl: "http://127.0.0.1:36400", supabaseUrl: "http://127.0.0.1:54321", adminKey: "admin-test", mailpitUrl: "http://127.0.0.1:8025" };
const OWNER = { name: "owner" } as unknown as Page, APPROVER = { name: "approver" } as unknown as Page;
const TENANT = { workspaceId: "ws-1", approverId: "u-approver" };
const ENV = { ZENITH_DEFAULT_STACK_DIRECTORY: "/unused-in-tests", ZENITH_DEFAULT_MAILPIT_URL: "http://127.0.0.1:8025" };
const EXTERNAL_ID = `zenith-${"a".repeat(32)}`;
// Partition ids as the planner makes them: "partition/<digest>".
const P_PRODUCER = `partition/${"1".repeat(64)}`, P_CONSUMER = `partition/${"2".repeat(64)}`;
const STATE_BUCKET = "zenith-state-123456789012-ap-south-1-live";
const ARTIFACT = { bucket: STATE_BUCKET, key: "mix03/consumer.zip", versionId: "3HL4kqtJlcpXroDTDmJ", sha256: "c".repeat(64), sourceDigest: "d".repeat(64) };
const CONNECTION = { accountId: "123456789012", region: "ap-south-1", stateBucket: STATE_BUCKET, bootstrapNameSuffix: "-live", observeRoleArn: "arn:aws:iam::123456789012:role/Observe", deployRoleArn: "arn:aws:iam::123456789012:role/Deploy" };

interface Sent { page: Page; endpoint: string; method: string; body: unknown; workspaceId?: string }
type Reply = { status: number; data: unknown };
const ok = (data: unknown): Reply => ({ status: 200, data });
const action = (result: unknown): Reply => ({ status: 200, data: { ok: true, result } });
const inputOf = (sent: Sent) => (sent.body as { input: Record<string, unknown> }).input;

/** A fake request layer: records each product call and answers from `route`. */
function transport(route: (sent: Sent) => Reply) {
  const sent: Sent[] = [];
  const request: ProductRequest = async (page, endpoint, body, method, workspaceId) => {
    const call = { page, endpoint, body, method: method ?? (body === undefined ? "GET" : "POST"), workspaceId };
    sent.push(call);
    return route(call);
  };
  return { request, sent };
}

function session(): TenantSession {
  return {
    stack: STACK, owner: OWNER, approver: APPROVER, workspaceId: "ws-1", ownerId: "u-owner", approverId: "u-approver",
    ownerSecret: "OWNER-TOTP-KEY", approverSecret: "APPROVER-TOTP-KEY", projectId: "proj-1",
  };
}
/** A driver whose tenant session already exists, so no browser is started. */
async function driverWithTenant(overrides: Parameters<typeof browserMix03Product>[1] = {}) {
  const product = browserMix03Product(ENV, { session: async () => ({ tenant: session(), close: async () => undefined }), sleep: async () => undefined, ...overrides });
  await product.createTenant();
  return product;
}

/**
 * The product's answers for the whole proposal and start: the sandbox parent deploys, the children are created and deployed, the
 * plan is proposed and read back, and the children are adopted and the parent started. Each test changes the step it exercises.
 */
function proposeRoute(options: { deployStatuses?: string[]; planStatus?: number; planCode?: string } = {}) {
  const statuses = [...(options.deployStatuses ?? ["succeeded"])];
  return (sent: Sent): Reply => {
    const { endpoint } = sent;
    if (endpoint === "/api/actions/project.updateManifest") return action({ ok: true, data: {} });
    if (endpoint === "/api/actions/env.create") return action({ ok: true, data: { environmentId: `env-${inputOf(sent).name}` } });
    if (endpoint === "/api/actions/deploy.apply") {
      const environmentId = String(inputOf(sent).environmentId);
      return action({ ok: true, data: environmentId === "env-parent" ? { deploymentId: "dep-parent" } : { deploymentId: "dep-child", operationId: `op-${environmentId}` } });
    }
    if (endpoint === "/api/environments/env-parent/deployments?limit=1") return ok({ deployments: [{ status: statuses.length > 1 ? statuses.shift() : statuses[0] }] });
    if (endpoint === "/api/platform/v1/mixed/plans") {
      return options.planStatus ? { status: options.planStatus, data: { error: { code: options.planCode ?? "plan_refused" } } }
        : { status: 201, data: { plan: { parentPlanId: "plan-1" }, operationId: "op-parent" } };
    }
    if (endpoint === "/api/platform/v1/mixed/plans/plan-1") return ok({ children: [
      { partitionId: P_PRODUCER, childEnvironmentId: "env-producer", dependsOn: [], childOperationId: null },
      { partitionId: P_CONSUMER, childEnvironmentId: "env-consumer", dependsOn: [P_PRODUCER], childOperationId: null },
    ] });
    if (endpoint.endsWith("/children")) return { status: 201, data: { child: { partitionId: "p" } } };
    if (endpoint === "/api/platform/v1/mixed/plans/plan-1/start") return ok({ operationId: "op-parent", parentPlanId: "plan-1", status: "running" });
    throw new Error(`unexpected ${endpoint}`);
  };
}

describe("runnerStack and the browser session", () => {
  it("refuses without the exported runner stack, before any browser starts", async () => {
    expect(() => runnerStack({})).toThrow(/runner stack is not exported/);
    await expect(browserMix03Product({}).createTenant()).rejects.toThrow("the runner stack is not exported");
  });

  it("createTenant returns the workspace and approver ids, and close releases the session's browser once", async () => {
    const close = vi.fn(async () => undefined);
    const product = browserMix03Product(ENV, { session: async () => ({ tenant: session(), close }) });
    await expect(product.createTenant()).resolves.toEqual(TENANT);
    await product.close();
    await product.close();
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("a failed session start releases nothing and refuses with the fixed step name", async () => {
    const product = browserMix03Product(ENV, { session: async () => { throw new Error("journey:auth-user"); } });
    await expect(product.createTenant()).rejects.toThrow("tenant setup refused by the product path (auth-user)");
  });
});

describe("connection", () => {
  it("createAwsConnection runs connection.createAws as the owner, in aws_assume_role mode with the state bucket, and returns the ExternalId", async () => {
    const t = transport(() => action({ ok: true, data: { connectionId: "conn-1", externalId: EXTERNAL_ID } }));
    const product = await driverWithTenant({ request: t.request });
    const result = await product.createAwsConnection(TENANT, CONNECTION);
    expect(result).toEqual({ connectionId: "conn-1", externalId: EXTERNAL_ID });
    expect(t.sent).toEqual([{
      page: OWNER, endpoint: "/api/actions/connection.createAws", method: "POST", workspaceId: "ws-1",
      body: expect.objectContaining({
        mode: "execute", scope: {},
        input: { label: "PROD-MIX-03 live", region: "ap-south-1", accountId: "123456789012", stateBucket: STATE_BUCKET, bootstrapNameSuffix: "-live", observeRoleArn: "arn:aws:iam::123456789012:role/Observe", deployRoleArn: "arn:aws:iam::123456789012:role/Deploy", mode: "aws_assume_role" },
      }),
    }]);
  });

  it("createAwsConnection refuses without echoing the product's own error text", async () => {
    const t = transport(() => action({ ok: false, summary: "no", error: "secret-looking text here" }));
    const product = await driverWithTenant({ request: t.request });
    const failure = product.createAwsConnection(TENANT, CONNECTION);
    await expect(failure).rejects.toThrow("connection.createAws was refused by the product");
    await expect(failure).rejects.not.toThrow("secret-looking");
  });

  it("createAwsConnection refuses a product answer without a connection id or ExternalId", async () => {
    const t = transport(() => action({ ok: true, data: { connectionId: "conn-1" } }));
    const product = await driverWithTenant({ request: t.request });
    await expect(product.createAwsConnection(TENANT, CONNECTION)).rejects.toThrow("connection.createAws was refused by the product");
  });

  it("verifyAws reports a pass, and a product refusal as a failed check instead of an error", async () => {
    const pass = transport(() => action({ ok: true, data: {} }));
    expect(await (await driverWithTenant({ request: pass.request })).verifyAws(TENANT, "conn-1")).toEqual({ ok: true, reason: "" });
    expect(pass.sent[0]).toMatchObject({ endpoint: "/api/actions/connection.verifyAws", body: expect.objectContaining({ input: { connectionId: "conn-1" } }) });

    const refused = transport(() => action({ ok: false, summary: "not yet", error: "sts said no" }));
    expect(await (await driverWithTenant({ request: refused.request })).verifyAws(TENANT, "conn-1")).toEqual({ ok: false, reason: "connection.verifyAws did not pass" });
  });

  it("verifyAws refuses an HTTP failure with the fixed reason", async () => {
    const t = transport(() => ({ status: 500, data: { ok: false } }));
    await expect((await driverWithTenant({ request: t.request })).verifyAws(TENANT, "conn-1"))
      .rejects.toThrow("connection verification refused by the product path (http-refused)");
  });
});

describe("step-up", () => {
  it("answers mfa_required with one TOTP step-up by the owner's key, then retries once", async () => {
    let calls = 0;
    const t = transport(() => (calls++ === 0 ? { status: 403, data: { error: { code: "mfa_required" } } } : action({ ok: true, data: {} })));
    const stepUp = vi.fn(async () => undefined);
    const product = await driverWithTenant({ request: t.request, stepUp });
    expect(await product.verifyAws(TENANT, "conn-1")).toEqual({ ok: true, reason: "" });
    expect(stepUp).toHaveBeenCalledTimes(1);
    expect(stepUp).toHaveBeenCalledWith(OWNER, STACK, "OWNER-TOTP-KEY");
    expect(t.sent).toHaveLength(2);
  });

  it("does not loop: a second mfa_required is returned as the refusal", async () => {
    const t = transport(() => ({ status: 403, data: { error: { code: "mfa_required" } } }));
    const stepUp = vi.fn(async () => undefined);
    const product = await driverWithTenant({ request: t.request, stepUp });
    await expect(product.verifyAws(TENANT, "conn-1")).rejects.toThrow("connection verification refused by the product path (http-refused)");
    expect(stepUp).toHaveBeenCalledTimes(1);
    expect(t.sent).toHaveLength(2);
  });
});

describe("mixed proposal: the sandbox parent, two AWS children and the plan", () => {
  it("sets the whole graph on the parent, deploys the parent first, then proposes the plan and returns both children", async () => {
    const t = transport(proposeRoute());
    const product = await driverWithTenant({ request: t.request });
    expect(await product.proposeMixed(TENANT, { connectionId: "conn-1", accountId: "123456789012", region: "ap-south-1", artifact: ARTIFACT }))
      .toEqual({ environmentIds: ["env-producer", "env-consumer"], planId: "plan-1", parentOperationId: "op-parent" });

    const creates = t.sent.filter(c => c.endpoint === "/api/actions/env.create").map(inputOf);
    expect(creates).toEqual([
      { projectId: "proj-1", name: "parent", class: "sandbox", approvalRequired: false },
      { projectId: "proj-1", name: "producer", class: "sandbox", connectionId: "conn-1", region: "ap-south-1", approvalRequired: true },
      { projectId: "proj-1", name: "consumer", class: "sandbox", connectionId: "conn-1", region: "ap-south-1", approvalRequired: true },
    ]);
    const { producer, consumer, graph } = mix03Manifests("ap-south-1", ARTIFACT);
    const manifests = t.sent.filter(c => c.endpoint === "/api/actions/project.updateManifest").map(c => inputOf(c).manifest);
    expect(manifests).toEqual([graph, producer, consumer]);
    expect(graph.functions[0]).toMatchObject({ source: { type: "s3", bucket: STATE_BUCKET, version: ARTIFACT.versionId }, env: [{ key: "PRODUCER_BUCKET_ARN", value: "{{zenith.input.bucket_arn}}" }] });

    const deployed = t.sent.filter(c => c.endpoint === "/api/actions/deploy.apply").map(c => inputOf(c).environmentId);
    expect(deployed).toEqual(["env-parent", "env-producer", "env-consumer"]);
  });

  it("proposes the plan with exact pins and the one declared reference, after the parent deployment succeeded", async () => {
    const t = transport(proposeRoute());
    await (await driverWithTenant({ request: t.request })).proposeMixed(TENANT, { connectionId: "conn-1", accountId: "123456789012", region: "ap-south-1", artifact: ARTIFACT });
    const plan = t.sent.find(c => c.endpoint === "/api/platform/v1/mixed/plans");
    expect(plan).toMatchObject({ page: OWNER, method: "POST", workspaceId: "ws-1", body: {
      parentEnvironmentId: "env-parent",
      childEnvironmentIds: ["env-producer", "env-consumer"],
      pins: [{ address: "object_store/bucket", childEnvironmentId: "env-producer" }, { address: "function/consumer", childEnvironmentId: "env-consumer" }],
      references: [MIX03_REFERENCE],
    } });
    const order = t.sent.map(c => c.endpoint);
    expect(order.indexOf("/api/environments/env-parent/deployments?limit=1")).toBeLessThan(order.indexOf("/api/platform/v1/mixed/plans"));
  });

  it("waits on a running parent deployment and succeeds when it finishes", async () => {
    const t = transport(proposeRoute({ deployStatuses: ["running", "succeeded"] }));
    const sleep = vi.fn(async () => undefined);
    const product = await driverWithTenant({ request: t.request, sleep });
    await expect(product.proposeMixed(TENANT, { connectionId: "conn-1", accountId: "123456789012", region: "ap-south-1", artifact: ARTIFACT })).resolves.toMatchObject({ planId: "plan-1" });
    expect(sleep).toHaveBeenCalledTimes(1);
  });

  it("refuses when the parent deployment fails, before any child is created", async () => {
    const t = transport(proposeRoute({ deployStatuses: ["failed"] }));
    const product = await driverWithTenant({ request: t.request });
    await expect(product.proposeMixed(TENANT, { connectionId: "conn-1", accountId: "123456789012", region: "ap-south-1", artifact: ARTIFACT }))
      .rejects.toThrow("the parent environment's deployment did not succeed");
    expect(t.sent.some(c => c.endpoint === "/api/actions/env.create" && inputOf(c).name === "producer")).toBe(false);
  });

  it("refuses with the product's plan refusal code and deploys no child", async () => {
    const t = transport(proposeRoute({ planStatus: 409, planCode: "missing_connectivity" }));
    const product = await driverWithTenant({ request: t.request });
    await expect(product.proposeMixed(TENANT, { connectionId: "conn-1", accountId: "123456789012", region: "ap-south-1", artifact: ARTIFACT }))
      .rejects.toThrow("the product refused the mixed plan (missing connectivity)");
    expect(t.sent.some(c => c.endpoint === "/api/actions/deploy.apply" && inputOf(c).environmentId === "env-producer")).toBe(false);
  });

  it("a refused child deploy names the product's reason, with identifiers elided", async () => {
    const base = proposeRoute();
    const t = transport(sent => sent.endpoint === "/api/actions/deploy.apply" && inputOf(sent).environmentId === "env-producer"
      ? action({ ok: false, summary: "no", error: "Platform policy denied this deployment for arn:aws:iam::123456789012:role/Deploy." })
      : base(sent));
    const product = await driverWithTenant({ request: t.request });
    const failure = product.proposeMixed(TENANT, { connectionId: "conn-1", accountId: "123456789012", region: "ap-south-1", artifact: ARTIFACT });
    await expect(failure).rejects.toThrow("deploy.apply was refused by the product (Platform policy denied this deployment for …arn)");
    await expect(failure).rejects.not.toThrow("123456789012");
  });
});

describe("mixed start: adoption of both children, then the start", () => {
  it("adopts the producer then the consumer with their partitions and operations, then starts the parent", async () => {
    const t = transport(proposeRoute());
    const product = await driverWithTenant({ request: t.request });
    await product.proposeMixed(TENANT, { connectionId: "conn-1", accountId: "123456789012", region: "ap-south-1", artifact: ARTIFACT });
    t.sent.length = 0;
    expect(await product.startMixed(TENANT, "plan-1", "op-parent")).toEqual({ started: true });
    expect(t.sent.map(c => [c.method, c.endpoint, c.body])).toEqual([
      ["POST", "/api/platform/v1/mixed/plans/plan-1/children", { partitionId: P_PRODUCER, operationId: "op-env-producer" }],
      ["POST", "/api/platform/v1/mixed/plans/plan-1/children", { partitionId: P_CONSUMER, operationId: "op-env-consumer" }],
      ["POST", "/api/platform/v1/mixed/plans/plan-1/start", {}],
    ]);
  });

  it("refuses to start a plan whose children were never proposed through this driver", async () => {
    const product = await driverWithTenant({ request: transport(proposeRoute()).request });
    await expect(product.startMixed(TENANT, "plan-unknown", "op-parent")).rejects.toThrow("no child operations were recorded for this plan");
  });

  it("reports a refused child adoption as a fixed reason and does not start the parent", async () => {
    const t = transport((sent) => (sent.endpoint.endsWith("/children") ? { status: 409, data: { error: { code: "child_mismatch" } } } : proposeRoute()(sent)));
    const product = await driverWithTenant({ request: t.request });
    await product.proposeMixed(TENANT, { connectionId: "conn-1", accountId: "123456789012", region: "ap-south-1", artifact: ARTIFACT });
    t.sent.length = 0;
    expect(await product.startMixed(TENANT, "plan-1", "op-parent")).toEqual({ started: false, reason: "the product refused a child adoption (child mismatch)" });
    expect(t.sent.some(c => c.endpoint.endsWith("/start"))).toBe(false);
  });

  it("startMixed reports the product's refusal code as a fixed reason, and withholds an unsafe code", async () => {
    const plain = transport((sent) => (sent.endpoint.endsWith("/start") ? { status: 409, data: { error: { code: "invalid_state" } } } : proposeRoute()(sent)));
    const prodA = await driverWithTenant({ request: plain.request });
    await prodA.proposeMixed(TENANT, { connectionId: "conn-1", accountId: "123456789012", region: "ap-south-1", artifact: ARTIFACT });
    expect(await prodA.startMixed(TENANT, "plan-1", "op-parent")).toEqual({ started: false, reason: "the product refused the start (invalid state)" });

    const unsafe = transport((sent) => (sent.endpoint.endsWith("/start") ? { status: 409, data: { error: { code: "Bad Code/with:symbols" } } } : proposeRoute()(sent)));
    const prodB = await driverWithTenant({ request: unsafe.request });
    await prodB.proposeMixed(TENANT, { connectionId: "conn-1", accountId: "123456789012", region: "ap-south-1", artifact: ARTIFACT });
    expect(await prodB.startMixed(TENANT, "plan-1", "op-parent")).toEqual({ started: false, reason: "the product refused the start (no code)" });
  });

  it("children maps the plan to producer and consumer, with receipts and the child awaiting approval", async () => {
    const t = transport((sent) => {
      if (sent.endpoint === "/api/platform/v1/mixed/plans/plan-1") return ok({ children: [
        { partitionId: P_PRODUCER, dependsOn: [], state: "succeeded", childOperationId: "op-p", receipt: { childOperationId: "op-p" } },
        { partitionId: P_CONSUMER, dependsOn: [P_PRODUCER], state: "adopted", childOperationId: "op-c", receipt: null },
      ] });
      if (sent.endpoint === "/api/platform/v1/operations/op-c") return ok({ operation: { id: "op-c", status: "awaiting_approval" } });
      throw new Error(`unexpected ${sent.endpoint}`);
    });
    const product = await driverWithTenant({ request: t.request });
    expect(await product.children(TENANT, "plan-1")).toEqual([
      { role: "producer", status: "succeeded", childOperationId: "op-p", receiptOperationId: "op-p" },
      { role: "consumer", status: "pending", childOperationId: "op-c", awaitingOperationId: "op-c" },
    ]);
    expect(t.sent.every(call => call.method === "GET")).toBe(true);
  });

  it("children reports a started child as running and does not mark it awaiting when its operation is not awaiting", async () => {
    const t = transport((sent) => {
      if (sent.endpoint === "/api/platform/v1/mixed/plans/plan-1") return ok({ children: [
        { partitionId: P_PRODUCER, dependsOn: [], state: "started", childOperationId: "op-p", receipt: null },
        { partitionId: P_CONSUMER, dependsOn: [P_PRODUCER], state: "blocked", childOperationId: null, receipt: null },
      ] });
      return ok({ operation: { id: "op-p", status: "running" } });
    });
    const product = await driverWithTenant({ request: t.request });
    expect(await product.children(TENANT, "plan-1")).toEqual([
      { role: "producer", status: "running", childOperationId: "op-p" },
      { role: "consumer", status: "blocked" },
    ]);
  });

  it("children refuses with a fixed reason when the readback is refused", async () => {
    const t = transport(() => ({ status: 404, data: { error: { code: "not_found" } } }));
    await expect((await driverWithTenant({ request: t.request })).children(TENANT, "plan-1"))
      .rejects.toThrow("children readback refused by the product path (http-refused)");
  });
});

describe("browser approval", () => {
  it("approve hands the approver's session and the operation id to the browser approval", async () => {
    const approve = vi.fn(async () => undefined);
    const product = await driverWithTenant({ approve, request: transport(() => ok({})).request });
    await product.approve(TENANT, "op-parent");
    expect(approve).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: "ws-1", approverId: "u-approver", approver: APPROVER }), "op-parent");
  });

  it("approve keeps the product's own journey code and withholds anything else", async () => {
    const coded = await driverWithTenant({ approve: async () => { throw new Error("journey:human-approval-required"); }, request: transport(() => ok({})).request });
    await expect(coded.approve(TENANT, "op-parent")).rejects.toThrow("browser approval refused by the product path (human-approval-required)");
    const other = await driverWithTenant({ approve: async () => { throw new Error("token sk-live-123 leaked"); }, request: transport(() => ok({})).request });
    const failure = other.approve(TENANT, "op-parent");
    await expect(failure).rejects.toThrow("browser approval refused by the product path (unexpected)");
    await expect(failure).rejects.not.toThrow("sk-live");
  });
});

describe("output preauthorization: one precise use for the consumer, from the plan's own digests", () => {
  const DIGEST = { desired: "e".repeat(64), contract: "1".repeat(64), producer: "2".repeat(64), consumer: "3".repeat(64) };
  const planReadback = (references: unknown[] = [{
    referenceId: "bucket-arn", producerPartitionId: P_PRODUCER, consumerPartitionId: P_CONSUMER, producerAddress: "object_store/bucket", producerOutput: "arn",
    consumerAddress: "function/consumer", consumerInput: "bucket_arn", valueType: "resource_id", contractDigest: DIGEST.contract,
    producerSubplanDigest: DIGEST.producer, consumerSubplanDigest: DIGEST.consumer, state: "unavailable", unavailableReason: "not_produced",
  }]) => ({
    parentOperationId: "op-parent", desiredDigest: DIGEST.desired, references,
    children: [
      { partitionId: P_PRODUCER, childEnvironmentId: "env-producer", dependsOn: [] },
      { partitionId: P_CONSUMER, childEnvironmentId: "env-consumer", dependsOn: [P_PRODUCER] },
    ],
  });

  it("issues one use for the consumer environment, with the plan's digests and a fifteen minute lifetime", async () => {
    const t = transport((sent) => {
      if (sent.endpoint === "/api/platform/v1/mixed/plans/plan-1") return ok(planReadback());
      if (sent.endpoint === "/api/platform/v1/mixed-output-preauthorizations") return { status: 201, data: { preauthorization: { id: "mop-1" } } };
      throw new Error(`unexpected ${sent.endpoint}`);
    });
    const product = await driverWithTenant({ request: t.request });
    await expect(product.issueOutputPreauthorization(TENANT, "plan-1")).resolves.toBeUndefined();
    const issued = t.sent.find(c => c.endpoint === "/api/platform/v1/mixed-output-preauthorizations");
    expect(issued).toMatchObject({ page: OWNER, method: "POST", workspaceId: "ws-1", body: {
      parentOperationId: "op-parent", environmentId: "env-consumer", desiredDigest: DIGEST.desired, referenceId: "bucket-arn",
      contractDigest: DIGEST.contract, consumerSubplanDigest: DIGEST.consumer, producerSubplanDigest: DIGEST.producer,
      valueType: "resource_id", maxUses: 1, lifetimeMs: 15 * 60_000, reason: "PROD-MIX-03 one-use output preauthorization",
    } });
  });

  it("refuses a plan that does not have exactly one reference, and sends nothing", async () => {
    const t = transport((sent) => (sent.endpoint === "/api/platform/v1/mixed/plans/plan-1" ? ok(planReadback([])) : ok({})));
    const product = await driverWithTenant({ request: t.request });
    await expect(product.issueOutputPreauthorization(TENANT, "plan-1")).rejects.toThrow("the plan does not have exactly one reference");
    expect(t.sent.some(c => c.endpoint === "/api/platform/v1/mixed-output-preauthorizations")).toBe(false);
  });

  it("refuses a digest the readback does not carry, before the preauthorization is sent", async () => {
    const readback = planReadback();
    (readback.references[0] as { contractDigest: string }).contractDigest = "not-a-digest";
    const t = transport((sent) => (sent.endpoint === "/api/platform/v1/mixed/plans/plan-1" ? ok(readback) : ok({})));
    const product = await driverWithTenant({ request: t.request });
    await expect(product.issueOutputPreauthorization(TENANT, "plan-1")).rejects.toThrow("the reference contract digest is not a digest in the plan readback");
    expect(t.sent.some(c => c.endpoint === "/api/platform/v1/mixed-output-preauthorizations")).toBe(false);
  });

  it("reports the product's refusal as a fixed reason", async () => {
    const t = transport((sent) => (sent.endpoint === "/api/platform/v1/mixed/plans/plan-1" ? ok(planReadback())
      : { status: 403, data: { error: { code: "admin_required" } } }));
    const product = await driverWithTenant({ request: t.request });
    await expect(product.issueOutputPreauthorization(TENANT, "plan-1")).rejects.toThrow("the product refused the output preauthorization (admin required)");
  });

  it("adds the service's reason code and the sanitized message", async () => {
    const t = transport((sent) => (sent.endpoint === "/api/platform/v1/mixed/plans/plan-1" ? ok(planReadback())
      : { status: 409, data: { error: { code: "invalid_state", message: "A child environment has no usable platform connection for arn:aws:iam::1:role/x.", details: { reason: "connection_unverified" } } } }));
    const product = await driverWithTenant({ request: t.request });
    await expect(product.issueOutputPreauthorization(TENANT, "plan-1")).rejects.toThrow("the product refused the output preauthorization (invalid state, connection_unverified: A child environment has no usable platform connection for …arn)");
  });
});

describe("steps with no product route: refused before any request", () => {
  const cases: [string, (p: Awaited<ReturnType<typeof driverWithTenant>>) => Promise<unknown>, string][] = [
    ["changeProducer", p => p.changeProducer(TENANT, "plan-1"), "a changed producer's consumer state is decided only inside the consumer's own run"],
    ["useOutputOnce", p => p.useOutputOnce(TENANT, "plan-1"), "no browser or REST route spends a preauthorization use"],
  ];
  for (const [name, call, reason] of cases) {
    it(`${name} refuses with a clear reason and sends nothing`, async () => {
      const t = transport(() => ok({}));
      const product = await driverWithTenant({ request: t.request });
      await expect(call(product)).rejects.toThrow(reason);
      expect(t.sent).toEqual([]);
    });
  }
});

describe("tenant isolation", () => {
  it("refuses a tenant this driver did not create, without sending anything", async () => {
    const t = transport(() => ok({}));
    const product = await driverWithTenant({ request: t.request });
    await expect(product.verifyAws({ workspaceId: "ws-other", approverId: "u-x" }, "conn-1")).rejects.toThrow("no signed-in session exists for this tenant");
    expect(t.sent).toEqual([]);
  });
});

describe("the port releases the driver after teardown", () => {
  const settings = { accountId: "123456789012", region: "ap-south-1", runId: "zlive-202610260000-ab01", durationMinutes: 15, dbSubnetGroup: "zenith-live-sandbox", dbSecurityGroup: "sg-12345678", workloadBoundaryArn: "arn:aws:iam::123456789012:policy/ZenithLiveWorkloadBoundary", scenario: "mix-03" as const };
  it("closes the browser even when the run refuses before its first AWS call", async () => {
    const close = vi.fn(async () => undefined);
    const plan = buildPlan(settings);
    const port = mix03Port({}, { product: { ...browserMix03Product(ENV, { request: transport(() => ok({})).request }), close } });
    const outcome = await port.verify({ id: "PROD-MIX-03", acceptance: [], fixtures: [], join: "" }, { plan, commit: "a".repeat(40), call: async () => { throw new Error("no AWS call expected"); } });
    expect(outcome.complete).toBe(false);
    expect(outcome.reason).toContain("ZENITH_LIVE_PRODUCT=1");
    expect(close).toHaveBeenCalledTimes(1);
  });
});

describe("PROD-MIX-03 manifests against the real planner", () => {
  it("plan into one AWS producer and one AWS consumer child with the reference, producer first", () => {
    const { graph, consumer } = mix03Manifests("us-east-1", ARTIFACT);
    const expand = (m: unknown, provider: "sandbox" | "aws") => {
      const parsed = parseManifest(m);
      if (!parsed.ok) throw new Error("manifest refused");
      return expandManifest(parsed.manifest, { id: PARENT_ENV, name: "x", class: "sandbox", provider, region: "us-east-1", baseDomain: "example.com" });
    };
    expect(expand(consumer, "aws").nodes.find(n => n.address === "function/consumer")?.dependsOn).toEqual([]);
    const aws = connection("aws");
    const plan = buildParentPlan({
      workspaceId: WS, projectId: PROJECT, parentEnvironmentId: PARENT_ENV, graph: expand(graph, "sandbox"),
      candidates: [{ childEnvironmentId: "env-p", connection: aws }, { childEnvironmentId: "env-c", connection: aws }],
      pins: [{ address: "object_store/bucket", childEnvironmentId: "env-p" }, { address: "function/consumer", childEnvironmentId: "env-c" }],
      references: [MIX03_REFERENCE],
    });
    expect(plan.children.map(c => c.childEnvironmentId)).toEqual(["env-p", "env-c"]);
    expect(plan.references).toHaveLength(1);
  });
});
