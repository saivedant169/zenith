/**
 * TEARDOWN-01 ProductScenarioPort, offline: fake browser driver, in-memory AWS answered only for planned calls through the real
 * Guard, fake recorded state, fake clock and session refresh. No cloud, stack or OpenTofu is used.
 */
import { describe, expect, it } from "vitest";
import { buildPlan } from "../../scripts/acceptance/live/plan";
import { grantsFor, Guard } from "../../scripts/acceptance/live/guard";
import type { Call, Json, Plan } from "../../scripts/acceptance/live/contracts";
import { trustDocument } from "../../scripts/acceptance/live/product/mix-03";
import { SETTLING, stateResources, teardown01Manifest, teardown01Port } from "../../scripts/acceptance/live/product/teardown-01";
import { browserDeploy01Product, type Deploy01Product } from "../../scripts/acceptance/live/product/deploy-01-driver";

const ACCOUNT = "123456789012", REGION = "ap-south-1", RUN = "zlive-202610280000-ab01";
const PRINCIPAL = `arn:aws:iam::${ACCOUNT}:role/ZenithLiveAcceptance`;
const OLD_EXT = "old-live-external-id", NEW_EXT = `zenith-${"c".repeat(32)}`;
const settings = { accountId: ACCOUNT, region: REGION, runId: RUN, durationMinutes: 140, dbSubnetGroup: "zenith-live-sandbox", dbSecurityGroup: "sg-12345678", workloadBoundaryArn: `arn:aws:iam::${ACCOUNT}:policy/ZenithLiveWorkloadBoundary`, scenario: "teardown-01" as const };
const env = { ZENITH_LIVE_PRODUCT: "1" };
const requirement = { id: "PROD-MIX-04", acceptance: [], fixtures: [], join: "" };
const COMMIT = "a".repeat(40);
const BUCKET = "arn:aws:s3:::zenith-life07-bucket";
const SETTLING_SENTENCE = `${SETTLING} Teardown can start once every earlier deploy credential and workflow has provably stopped.`;

function harness(opts: { settlePolls?: number; firstRefusal?: string | null; teardownStatus?: string; leftInState?: number; leftTagged?: number; afterSettle?: string } = {}) {
  const trust = { observe: trustDocument(PRINCIPAL, OLD_EXT), deploy: trustDocument(PRINCIPAL, OLD_EXT) };
  const events: string[] = [];
  let clock = 0, polls = 0, tornDown = false, destroyed = false;
  const product: Deploy01Product = {
    createTenant: async () => ({ workspaceId: "ws1", projectId: "p1" }),
    createAwsConnection: async () => ({ connectionId: "c1", externalId: NEW_EXT }),
    verifyAws: async () => ({ ok: true }),
    createEnvironment: async () => ({ environmentId: "env1" }),
    setManifest: async (_t, m) => { events.push(`manifest:${(m.resources as { kind: string }[])[0]!.kind}`); },
    deploy: async () => { events.push("deploy"); return { operationId: "op1", status: "succeeded" }; },
    teardownBlocked: async () => {
      polls++;
      if (polls === 1 && opts.firstRefusal !== undefined) return opts.firstRefusal ?? undefined;
      return polls <= (opts.settlePolls ?? 3) ? SETTLING_SENTENCE : opts.afterSettle;
    },
    teardown: async () => { events.push("teardown"); tornDown = opts.teardownStatus === undefined; return { operationId: "op2", status: opts.teardownStatus ?? "succeeded" }; },
  };
  const plan: Plan = buildPlan(settings);
  const permission = {
    schema: 1 as const, decision: "DEC-CLOUD" as const, approvedBy: "owner-test", approvedAt: "2020-01-01T00:00:00.000Z", expiresAt: "2099-01-01T00:00:00.000Z",
    accountId: ACCOUNT, region: REGION, runId: RUN, planSha256: plan.sha256, sourceCommit: COMMIT, maxUsd: plan.estimate.usd, maxMinutes: plan.settings.durationMinutes, grants: grantsFor(plan),
  };
  const guard = new Guard(plan, permission, plan.estimate.usd);
  const call = async (c: Call, input?: Record<string, Json>) => {
    guard.consume(c); events.push(c.id);
    const i = input ?? c.input;
    switch (c.id) {
      case "teardown01-iam-read-observe": return { Role: { AssumeRolePolicyDocument: encodeURIComponent(trust.observe) } };
      case "teardown01-iam-read-deploy": return { Role: { AssumeRolePolicyDocument: encodeURIComponent(trust.deploy) } };
      case "teardown01-iam-trust-observe": trust.observe = String(i.PolicyDocument); return {};
      case "teardown01-iam-trust-deploy": trust.deploy = String(i.PolicyDocument); return {};
      case "teardown01-sts-assume": expect(i.ExternalId).toBe(NEW_EXT); return { Credentials: { AccessKeyId: "A", SecretAccessKey: "S", SessionToken: "T" } };
      case "teardown01-tag-read": return { ResourceTagMappingList: tornDown || destroyed ? new Array(opts.leftTagged ?? 0).fill({ ResourceARN: BUCKET }) : [{ ResourceARN: BUCKET }] };
      default: throw new Error(`unexpected ${c.id}`);
    }
  };
  const bucket = { mode: "managed", type: "aws_s3_bucket", instances: [{ attributes: {} }] };
  const state = {
    read: async () => ({ resources: tornDown ? new Array(opts.leftInState ?? 0).fill(bucket) : [bucket, { mode: "data", type: "aws_caller_identity", instances: [{}] }] }),
    destroy: async (input: { stateKey: string }) => { expect(input.stateKey).toBe("zenith/ws1/env1/terraform.tfstate"); events.push("state-destroy"); destroyed = true; return { destroyed: 1 }; },
  };
  const port = teardown01Port(env, {
    product, state, propagation: { attempts: 2, intervalMs: 0 }, settle: { intervalMs: 120_000, boundMs: 110 * 60_000 },
    sleep: async ms => { clock += ms; }, now: () => clock, refresh: async () => { events.push("refresh"); },
  });
  return { trust, events, run: () => port.verify(requirement, { plan, commit: COMMIT, call }) };
}

describe("TEARDOWN-01 port", () => {
  it("proves the refusal while settling, the wait, one session refresh before the teardown, and an independent empty readback", async () => {
    const h = harness();
    const result = await h.run();
    expect(result).toMatchObject({ complete: true, leaks: [] });
    expect(result.reason).toContain("became available 6 minutes after it");
    expect(h.events.filter(e => e === "refresh")).toHaveLength(1);
    expect(h.events.indexOf("refresh")).toBeLessThan(h.events.indexOf("teardown"));
    expect(h.events).not.toContain("state-destroy");
    expect(h.events).toContain("manifest:object_store");
    expect(h.trust.observe).toBe(trustDocument(PRINCIPAL, OLD_EXT));
    expect(h.trust.deploy).toBe(trustDocument(PRINCIPAL, OLD_EXT));
  });

  it("does not claim the refusal when the review was not refused right after the deploy", async () => {
    const result = await harness({ firstRefusal: null }).run();
    expect(result.complete).toBe(false);
    expect(result.reason).toContain("teardown refused while settling: the teardown review was not refused");
  });

  it("stops at the settlement bound, refreshes the session once and destroys from the recorded state", async () => {
    const h = harness({ settlePolls: 1000 });
    const result = await h.run();
    expect(result.complete).toBe(false);
    expect(result.reason).toContain("did not settle within 110 minutes");
    expect(h.events.filter(e => e === "refresh")).toHaveLength(1);
    expect(h.events).toContain("state-destroy");
    expect(h.events).not.toContain("teardown");
    expect(h.trust.deploy).toBe(trustDocument(PRINCIPAL, OLD_EXT));
  });

  it("refuses a different refusal after settlement instead of tearing down", async () => {
    const result = await harness({ afterSettle: "Wait for the environment's active deployment to finish." }).run();
    expect(result.reason).toContain("refused for another reason");
  });

  it("falls back to the recorded state when the product teardown fails", async () => {
    const h = harness({ teardownStatus: "uncertain" });
    const result = await h.run();
    expect(result.reason).toContain("the teardown ended uncertain");
    expect(h.events).toContain("state-destroy");
  });

  it("fails when the recorded state or the tagging inventory still holds the bucket after the teardown", async () => {
    expect((await harness({ leftInState: 1 }).run()).reason).toContain("recorded state still holds 1 resource");
    expect((await harness({ leftTagged: 1 }).run()).reason).toContain("1 resource(s) tagged with the environment remain");
  });

  it("counts only managed resources with instances and deploys a bucket-only manifest", () => {
    expect(stateResources({ resources: [{ mode: "managed", instances: [{}] }, { mode: "data", instances: [{}] }, { mode: "managed", instances: [] }] })).toBe(1);
    expect(stateResources(undefined)).toBe(0);
    expect(teardown01Manifest(RUN)).toMatchObject({ services: [], resources: [{ kind: "object_store", ownership: "managed", name: "teardown01-000-ab01" }] });
  });

  it("plans the duration up to 150 minutes and only the six product calls", () => {
    expect(buildPlan({ ...settings, durationMinutes: 150 }).productCalls!.map(c => c.id)).toEqual([
      "teardown01-iam-read-observe", "teardown01-iam-read-deploy", "teardown01-iam-trust-observe", "teardown01-iam-trust-deploy", "teardown01-sts-assume", "teardown01-tag-read"]);
    expect(() => buildPlan({ ...settings, durationMinutes: 151 })).toThrow("5..150");
    expect(() => buildPlan({ ...settings, scenario: "deploy-01", durationMinutes: 61 })).toThrow("5..60");
  });
});

describe("TEARDOWN-01 driver teardown", () => {
  const tenantSession = { workspaceId: "ws1", projectId: "p1", owner: {} as never, approver: {} as never, stack: {}, ownerSecret: "o", approverSecret: "a" };
  const session = async () => ({ tenant: tenantSession as never, close: async () => undefined });

  it("reads the review's plan refusal in plan mode", async () => {
    const seen: unknown[] = [];
    const request = async (_p: unknown, endpoint: string, body: unknown) => { seen.push([endpoint, body]); return { status: 200, data: { plan: { blocked: SETTLING_SENTENCE } } }; };
    const product = browserDeploy01Product({}, { request: request as never, session, sleep: async () => undefined });
    const t = await product.createTenant();
    await expect(product.teardownBlocked!(t, "env1")).resolves.toContain(SETTLING);
    expect(seen[0]).toMatchObject(["/api/actions/env.reviewTeardown", { mode: "plan", input: { environmentId: "env1" }, scope: { projectId: "p1", environmentId: "env1" } }]);
  });

  it("requests the review, waits for its destroy proposal, approves each round and waits for the terminal destroy", async () => {
    let reviewPolls = 0, opPolls = 0;
    const approvals: string[] = [];
    const request = async (_p: unknown, endpoint: string) => {
      if (endpoint === "/api/actions/env.reviewTeardown") return { status: 200, data: { result: { ok: true, data: { reviewOperationId: "rev1", status: "queued" } } } };
      if (endpoint.startsWith("/api/platform/v1/environments/env1/teardown-review?reviewId=rev1")) return { status: 200, data: { review: ++reviewPolls < 2 ? { status: "running" } : { operationId: "op9", status: "awaiting_approval" } } };
      if (endpoint === "/api/platform/v1/operations/op9") {
        opPolls++;
        const status = approvals.length === 0 ? "awaiting_approval" : approvals.length === 1 && opPolls < 4 ? "awaiting_approval" : approvals.length >= 2 ? "succeeded" : "running";
        return { status: 200, data: { operation: { status, approvalRound: approvals.length } } };
      }
      throw new Error(endpoint);
    };
    const product = browserDeploy01Product({}, { request: request as never, session, sleep: async () => undefined, approve: async (_s, id) => { approvals.push(id); } });
    const t = await product.createTenant();
    await expect(product.teardown!(t, "env1")).resolves.toEqual({ operationId: "op9", status: "succeeded" });
    expect(approvals).toEqual(["op9", "op9"]);
  });

  it("refuses a review that ends without a destroy proposal", async () => {
    const request = async (_p: unknown, endpoint: string) => endpoint === "/api/actions/env.reviewTeardown"
      ? { status: 200, data: { result: { ok: true, data: { reviewOperationId: "rev1" } } } }
      : { status: 200, data: { review: { status: "failed" } } };
    const product = browserDeploy01Product({}, { request: request as never, session, sleep: async () => undefined });
    const t = await product.createTenant();
    await expect(product.teardown!(t, "env1")).rejects.toThrow("ended failed without a destroy proposal");
  });
});
