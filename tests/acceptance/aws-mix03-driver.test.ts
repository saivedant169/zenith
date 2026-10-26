/**
 * PROD-MIX-03 browser driver (`browserMix03Product`), offline. Every product call goes through a fake request layer that
 * records the page, endpoint, method, body and workspace header; approvals, step-up and the signed-in session are fakes.
 * No browser, stack, AWS call or network access happens here.
 */
import type { Page } from "@playwright/test";
import { describe, expect, it, vi } from "vitest";
import { buildPlan } from "../../scripts/acceptance/live/plan";
import { mix03Port } from "../../scripts/acceptance/live/product/mix-03";
import {
  browserMix03Product, runnerStack, type ProductRequest, type RunnerStack, type TenantSession,
} from "../../scripts/acceptance/live/product/mix-03-driver";

const STACK: RunnerStack = { apiUrl: "http://127.0.0.1:36400", supabaseUrl: "http://127.0.0.1:54321", adminKey: "admin-test", mailpitUrl: "http://127.0.0.1:8025" };
const OWNER = { name: "owner" } as unknown as Page, APPROVER = { name: "approver" } as unknown as Page;
const TENANT = { workspaceId: "ws-1", approverId: "u-approver" };
const ENV = { ZENITH_DEFAULT_STACK_DIRECTORY: "/unused-in-tests", ZENITH_DEFAULT_MAILPIT_URL: "http://127.0.0.1:8025" };
const EXTERNAL_ID = `zenith-${"a".repeat(32)}`;

interface Sent { page: Page; endpoint: string; method: string; body: unknown; workspaceId?: string }
type Reply = { status: number; data: unknown };
const ok = (data: unknown): Reply => ({ status: 200, data });
const action = (result: unknown): Reply => ({ status: 200, data: { ok: true, result } });

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
  const product = browserMix03Product(ENV, { session: async () => ({ tenant: session(), close: async () => undefined }), ...overrides });
  await product.createTenant();
  return product;
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
  it("createAwsConnection runs connection.createAws as the owner, in aws_assume_role mode, and returns the ExternalId", async () => {
    const t = transport(() => action({ ok: true, data: { connectionId: "conn-1", externalId: EXTERNAL_ID } }));
    const product = await driverWithTenant({ request: t.request });
    const result = await product.createAwsConnection(TENANT, {
      accountId: "123456789012", region: "ap-south-1", observeRoleArn: "arn:aws:iam::123456789012:role/Observe", deployRoleArn: "arn:aws:iam::123456789012:role/Deploy",
    });
    expect(result).toEqual({ connectionId: "conn-1", externalId: EXTERNAL_ID });
    expect(t.sent).toEqual([{
      page: OWNER, endpoint: "/api/actions/connection.createAws", method: "POST", workspaceId: "ws-1",
      body: expect.objectContaining({
        mode: "execute", scope: {},
        input: { label: "PROD-MIX-03 live", region: "ap-south-1", accountId: "123456789012", observeRoleArn: "arn:aws:iam::123456789012:role/Observe", deployRoleArn: "arn:aws:iam::123456789012:role/Deploy", mode: "aws_assume_role" },
      }),
    }]);
  });

  it("createAwsConnection refuses without echoing the product's own error text", async () => {
    const t = transport(() => action({ ok: false, summary: "no", error: "secret-looking text here" }));
    const product = await driverWithTenant({ request: t.request });
    const failure = product.createAwsConnection(TENANT, { accountId: "123456789012", region: "ap-south-1", observeRoleArn: "arn:aws:iam::123456789012:role/Observe", deployRoleArn: "arn:aws:iam::123456789012:role/Deploy" });
    await expect(failure).rejects.toThrow("connection.createAws was refused by the product");
    await expect(failure).rejects.not.toThrow("secret-looking");
  });

  it("createAwsConnection refuses a product answer without a connection id or ExternalId", async () => {
    const t = transport(() => action({ ok: true, data: { connectionId: "conn-1" } }));
    const product = await driverWithTenant({ request: t.request });
    await expect(product.createAwsConnection(TENANT, { accountId: "123456789012", region: "ap-south-1", observeRoleArn: "arn:aws:iam::123456789012:role/Observe", deployRoleArn: "arn:aws:iam::123456789012:role/Deploy" }))
      .rejects.toThrow("connection.createAws was refused by the product");
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

describe("mixed start and children readback", () => {
  it("startMixed posts to the browser-only start route as the owner and reports success", async () => {
    const t = transport(() => ok({ operationId: "op-parent", parentPlanId: "plan-1", status: "running" }));
    const product = await driverWithTenant({ request: t.request });
    expect(await product.startMixed(TENANT, "plan-1", "op-parent")).toEqual({ started: true });
    expect(t.sent[0]).toMatchObject({ page: OWNER, endpoint: "/api/platform/v1/mixed/plans/plan-1/start", method: "POST", body: {}, workspaceId: "ws-1" });
  });

  it("startMixed reports the product's refusal code as a fixed reason, and withholds an unsafe code", async () => {
    const plain = transport(() => ({ status: 409, data: { error: { code: "invalid_state" } } }));
    expect(await (await driverWithTenant({ request: plain.request })).startMixed(TENANT, "plan-1", "op-parent"))
      .toEqual({ started: false, reason: "the product refused the start (invalid state)" });
    const unsafe = transport(() => ({ status: 409, data: { error: { code: "Bad Code/with:symbols" } } }));
    expect(await (await driverWithTenant({ request: unsafe.request })).startMixed(TENANT, "plan-1", "op-parent"))
      .toEqual({ started: false, reason: "the product refused the start (no code)" });
  });

  it("children maps the plan to producer and consumer, with receipts and the child awaiting approval", async () => {
    const t = transport((sent) => {
      if (sent.endpoint === "/api/platform/v1/mixed/plans/plan-1") return ok({ children: [
        { partitionId: "p-producer", dependsOn: [], state: "succeeded", childOperationId: "op-p", receipt: { childOperationId: "op-p" } },
        { partitionId: "p-consumer", dependsOn: ["p-producer"], state: "adopted", childOperationId: "op-c", receipt: null },
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
        { partitionId: "p-producer", dependsOn: [], state: "started", childOperationId: "op-p", receipt: null },
        { partitionId: "p-consumer", dependsOn: ["p-producer"], state: "blocked", childOperationId: null, receipt: null },
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

describe("steps with no product route: refused before any request", () => {
  const cases: [string, (p: Awaited<ReturnType<typeof driverWithTenant>>) => Promise<unknown>, string][] = [
    ["proposeMixed", p => p.proposeMixed(TENANT, { connectionId: "conn-1", accountId: "123456789012", region: "ap-south-1", runId: "run-1" }), "planMixed refuses the producer-to-consumer reference"],
    ["changeProducer", p => p.changeProducer(TENANT, "plan-1"), "a changed producer needs a new parent revision"],
    ["issueOutputPreauthorization", p => p.issueOutputPreauthorization(TENANT, "plan-1"), "no precise preauthorization can be named"],
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
