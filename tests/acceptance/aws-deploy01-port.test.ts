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
import { sanitizedError, type Deploy01Product } from "../../scripts/acceptance/live/product/deploy-01-driver";
import { dispatchRequirementGap } from "@/lib/platform/broker";

const ACCOUNT = "123456789012", REGION = "ap-south-1", RUN = "zlive-202610260000-ab01";
const PRINCIPAL = `arn:aws:iam::${ACCOUNT}:role/ZenithLiveAcceptance`;
const OLD_EXT = "old-live-external-id", NEW_EXT = `zenith-${"c".repeat(32)}`;
const settings = { accountId: ACCOUNT, region: REGION, runId: RUN, durationMinutes: 60, dbSubnetGroup: "zenith-live-sandbox", dbSecurityGroup: "sg-12345678", workloadBoundaryArn: `arn:aws:iam::${ACCOUNT}:policy/ZenithLiveWorkloadBoundary`, scenario: "deploy-01" as const };
const env = { ZENITH_LIVE_PRODUCT: "1" };
const requirement = { id: "PROD-REL-01", acceptance: [], fixtures: [], join: "" };
const COMMIT = "a".repeat(40);
const DNS = "zenith-web-123.ap-south-1.elb.amazonaws.com";

function harness(opts: { deployStatus?: string; leftAfterDestroy?: number; image?: (n: number) => string } = {}) {
  const trust = { observe: trustDocument(PRINCIPAL, OLD_EXT), deploy: trustDocument(PRINCIPAL, OLD_EXT) };
  const images: string[] = [];
  let destroyed = false;
  const product: Deploy01Product = {
    createTenant: async () => ({ workspaceId: "ws1", projectId: "p1" }),
    createAwsConnection: async () => ({ connectionId: "c1", externalId: NEW_EXT }),
    verifyAws: async () => ({ ok: true }),
    createEnvironment: async () => ({ environmentId: "env1" }),
    setManifest: async (_t, m) => { images.push(((m.services as { source: { image: string } }[])[0]!).source.image); },
    deploy: async (_t, _e, kind) => { if (kind === "rollback") images.push(images[images.length - 2]!); return { operationId: "op", status: opts.deployStatus ?? "succeeded", ...(opts.deployStatus ? { detail: "the plan failed" } : {}) }; },
  };
  const plan: Plan = buildPlan(settings);
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
      case "deploy01-tag-read": return { ResourceTagMappingList: destroyed ? new Array(opts.leftAfterDestroy ?? 0).fill({ ResourceARN: "arn:x" }) : [] };
      default: throw new Error(`unexpected ${c.id}`);
    }
  };
  const state = {
    read: async () => ({ resources: [
      { type: "aws_ecs_task_definition", instances: [{ attributes: { container_definitions: JSON.stringify([{ image: (opts.image ?? (() => images[images.length - 1]!))(images.length) }]) } }] },
      { type: "aws_lb", instances: [{ attributes: { dns_name: DNS } }] },
    ] }),
    destroy: async (input: { stateKey: string }) => { expect(input.stateKey).toBe("zenith/ws1/env1/terraform.tfstate"); destroyed = true; return { destroyed: 20 }; },
  };
  const port = deploy01Port(env, { product, sleep: async () => undefined, propagation: { attempts: 2, intervalMs: 0 }, probe: async (dns, host) => (dns === DNS && host.startsWith("web-") ? 200 : 503), state });
  return { trust, images, sent, run: () => port.verify(requirement, { plan, commit: COMMIT, call }) };
}

describe("DEPLOY-01 driver error detail", () => {
  it("elides ARNs, key=value pairs, URLs, paths and long tokens and bounds the length", () => {
    expect(sanitizedError("AccessDenied for arn:aws:iam::123456789012:role/x when key=secret at https://x.example/a in /tmp/a/b token AKIAABCDEFGHIJKLMNOPQRSTUV")).toBe("AccessDenied for …arn when …=… at …url in …path token …");
    expect(sanitizedError("x".repeat(500))!.length).toBeLessThanOrEqual(240);
    expect(sanitizedError(undefined)).toBeUndefined();
    expect(sanitizedError("The apply ended with an unclassified error (Error: Reviewed plan artifact is unavailable or changed; a new review is required.; cause Gate/requirement:plan-facts).")).toBe("The apply ended with an unclassified error (Error: Reviewed plan artifact is unavailable or changed; a new review is required.). [cause Gate/requirement:plan-facts]");
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
    expect(result.reason).toMatch(/does not run public\.ecr\.aws\/nginx\/nginx:1\.27/);
  });
  it("reports leaks when tagged resources remain after the destroy", async () => {
    const result = await harness({ leftAfterDestroy: 2 }).run();
    expect(result.complete).toBe(false);
    expect(result.leaks).toEqual(["2 tagged resource(s) still present after cleanup"]);
  });
  it("is only for PROD-REL-01 and refuses without the live product flag", async () => {
    const plan = buildPlan(settings);
    const port = deploy01Port({}, { product: {} as Deploy01Product });
    expect((await port.verify({ ...requirement, id: "PROD-MIX-03" }, { plan, commit: COMMIT, call: async () => ({}) })).reason).toMatch(/not implemented/);
    expect((await port.verify(requirement, { plan, commit: COMMIT, call: async () => ({}) })).reason).toMatch(/ZENITH_LIVE_PRODUCT=1 is not set/);
  });
});
