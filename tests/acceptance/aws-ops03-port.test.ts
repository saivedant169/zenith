/**
 * OPS-03 offline: the rolling-upgrade port with a fake browser driver, a fake runner stack, in-memory AWS answered only for
 * planned calls through the real Guard, and a fake recorded state. No cloud, stack, Docker or Temporal is used.
 */
import { describe, expect, it } from "vitest";
import { buildPlan } from "../../scripts/acceptance/live/plan";
import { grantsFor, Guard } from "../../scripts/acceptance/live/guard";
import type { Call, Json, Plan } from "../../scripts/acceptance/live/contracts";
import { trustDocument } from "../../scripts/acceptance/live/product/mix-03";
import { ops03Manifest, ops03Port } from "../../scripts/acceptance/live/product/ops-03";
import type { Deploy01Product } from "../../scripts/acceptance/live/product/deploy-01-driver";
import type { Ops03Images, Ops03Stack } from "../../scripts/acceptance/live/product/ops-03-stack";

const ACCOUNT = "123456789012", REGION = "ap-south-1", RUN = "zlive-202610310000-ab03";
const PRINCIPAL = `arn:aws:iam::${ACCOUNT}:role/ZenithLiveAcceptance`;
const OLD_EXT = "old-live-external-id", NEW_EXT = `zenith-${"c".repeat(32)}`;
const settings = { accountId: ACCOUNT, region: REGION, runId: RUN, durationMinutes: 50, dbSubnetGroup: "zenith-live-sandbox", dbSecurityGroup: "sg-12345678", workloadBoundaryArn: `arn:aws:iam::${ACCOUNT}:policy/ZenithLiveWorkloadBoundary`, scenario: "ops-03" as const };
const requirement = { id: "PROD-OPS-03", acceptance: [], fixtures: [], join: "" };
const COMMIT = "a".repeat(40);
const bucket = (n: number) => `arn:aws:s3:::ops03-0000ab03-${n}`;
const image = (role: string, d: string) => `localhost:5000/zenith-i1/${role}@sha256:${d.repeat(64)}`;
const PREVIOUS: Ops03Images = { api: image("api", "1"), worker: image("worker", "1"), migration: image("migration", "1") };
const CANDIDATE: Ops03Images = { api: image("api", "2"), worker: image("worker", "2"), migration: image("migration", "2") };

interface Opts { newRun?: boolean; reviewLost?: boolean; earlyBucket?: boolean; secondStatus?: string; upgradeFails?: boolean }

function harness(opts: Opts = {}) {
  const trust = { observe: trustDocument(PRINCIPAL, OLD_EXT), deploy: trustDocument(PRINCIPAL, OLD_EXT) };
  const events: string[] = [];
  let aws: string[] = [], destroyed = false, closed = false, release = "previous", runId = "run1", wfStatus: "none" | "running" | "completed" = "none";
  const op = { status: "proposed", round: 0 };
  const product: Deploy01Product = {
    createTenant: async () => ({ workspaceId: "ws1", projectId: "p1" }),
    createAwsConnection: async () => ({ connectionId: "c1", externalId: NEW_EXT }),
    verifyAws: async () => ({ ok: true }),
    createEnvironment: async () => ({ environmentId: "env1" }),
    setManifest: async (_t, m) => { events.push(`manifest:${(m.resources as unknown[]).length}`); },
    proposeDeploy: async () => { events.push("propose"); return { operationId: "op1", deploymentId: "dep1" }; },
    reviewDeploy: async () => {
      events.push(`review:${release}`); op.status = "awaiting_approval"; op.round = 1; wfStatus = "running";
      if (opts.earlyBucket) aws = [bucket(1)];
      return { round: 1 };
    },
    operationStatus: async () => ({ ...op }),
    completeDeploy: async () => { events.push(`complete:${release}`); aws = [bucket(1)]; wfStatus = "completed"; op.status = "succeeded"; return { operationId: "op1", status: "succeeded" }; },
    deploy: async () => {
      events.push(`deploy:${release}`);
      const status = opts.secondStatus ?? "succeeded";
      if (status === "succeeded") aws = [bucket(1), bucket(2)];
      return { operationId: "op2", status };
    },
  };
  const stack: Ops03Stack = {
    candidates: async () => { events.push("candidates"); return { previous: PREVIOUS, candidate: CANDIDATE }; },
    upgrade: async (images) => {
      events.push(`upgrade:${images.worker === CANDIDATE.worker}`);
      if (opts.upgradeFails) { const { refuse } = await import("../../scripts/acceptance/live/product/mix-03"); refuse("the rolling upgrade failed (Error)"); }
      release = "candidate";
      if (opts.newRun) runId = "run2";
      if (opts.reviewLost) op.status = "failed";
    },
    rollback: async (images) => { events.push(`rollback:${images.api === PREVIOUS.api}`); release = "previous"; },
    history: async () => ({ runId: wfStatus === "none" ? "" : runId, running: wfStatus === "running", completed: wfStatus === "completed" }),
    close: async () => { closed = true; },
  };
  const plan: Plan = buildPlan(settings);
  const permission = {
    schema: 1 as const, decision: "DEC-CLOUD" as const, approvedBy: "owner-test", approvedAt: "2020-01-01T00:00:00.000Z", expiresAt: "2099-01-01T00:00:00.000Z",
    accountId: ACCOUNT, region: REGION, runId: RUN, planSha256: plan.sha256, sourceCommit: COMMIT, maxUsd: plan.estimate.usd, maxMinutes: plan.settings.durationMinutes, grants: grantsFor(plan),
  };
  const guard = new Guard(plan, permission, plan.estimate.usd);
  const call = async (c: Call, input?: Record<string, Json>) => {
    guard.consume(c);
    const i = input ?? c.input;
    switch (c.id) {
      case "teardown01-iam-read-observe": return { Role: { AssumeRolePolicyDocument: encodeURIComponent(trust.observe) } };
      case "teardown01-iam-read-deploy": return { Role: { AssumeRolePolicyDocument: encodeURIComponent(trust.deploy) } };
      case "teardown01-iam-trust-observe": trust.observe = String(i.PolicyDocument); return {};
      case "teardown01-iam-trust-deploy": trust.deploy = String(i.PolicyDocument); return {};
      case "teardown01-sts-assume": return { Credentials: { AccessKeyId: "A", SecretAccessKey: "S", SessionToken: "T" } };
      case "teardown01-tag-read": return { ResourceTagMappingList: (destroyed ? [] : aws).map(ResourceARN => ({ ResourceARN })) };
      default: throw new Error(`unexpected ${c.id}`);
    }
  };
  const state = { destroy: async () => { destroyed = true; aws = []; return { destroyed: 2 }; } };
  const port = ops03Port({ ZENITH_LIVE_PRODUCT: "1" }, { product, stack, sleep: async () => undefined, propagation: { attempts: 2, intervalMs: 0 }, state });
  return { events, trust, destroyed: () => destroyed, closed: () => closed, run: () => port.verify(requirement, { plan, commit: COMMIT, call }) };
}

describe("OPS-03 plan", () => {
  it("scopes ops-03 to PROD-OPS-03 with the bucket-only sandbox calls and the OPS-04 ceiling, on either lane", () => {
    const plan = buildPlan(settings);
    expect(plan.settings.scenario).toBe("ops-03");
    expect(plan.productCalls!.map(c => c.id)).toEqual(buildPlan({ ...settings, scenario: "ops-04" }).productCalls!.map(c => c.id));
    expect(plan.estimate.usd).toBe(0.75);
    expect(buildPlan({ ...settings, lane: "live2" }).settings.lane).toBe("live2");
    expect(() => buildPlan({ ...settings, durationMinutes: 61 })).toThrow("5..60");
    expect((ops03Manifest(RUN, 2).resources as { name: string }[]).map(r => r.name)).toEqual(["ops03-000-ab03-1", "ops03-000-ab03-2"]);
  });
});

describe("OPS-03 port", () => {
  it("upgrades with the deploy in flight, applies it on the candidate, rolls back, deploys again, then cleans up", async () => {
    const h = harness();
    const result = await h.run();
    expect(result.reason).toContain("OPS-03 rolling upgrade and rollback proven on AWS");
    expect(result.complete).toBe(true);
    expect(h.events).toEqual(["candidates", "manifest:1", "propose", "review:previous", "upgrade:true", "complete:candidate", "rollback:true", "manifest:2", "deploy:previous"]);
    expect(h.destroyed()).toBe(true);
    expect(h.closed()).toBe(true);
    expect(h.trust.observe).toBe(trustDocument(PRINCIPAL, OLD_EXT));
  });

  it.each([
    [{ newRun: true }, "after the upgrade: the upgrade did not keep the same running workflow history"],
    [{ reviewLost: true }, "after the upgrade: the review did not survive the upgrade (operation failed, round 1 of 1)"],
    [{ earlyBucket: true }, "deploy in flight: a bucket exists before the apply was approved"],
    [{ upgradeFails: true }, "rolling upgrade: the rolling upgrade failed (Error)"],
    [{ secondStatus: "failed" }, "deploy on the rolled-back release: the second deploy ended failed, not succeeded"],
  ] as [Opts, string][])("refuses %o and still cleans up", async (opts, reason) => {
    const h = harness(opts);
    const result = await h.run();
    expect(result.complete).toBe(false);
    expect(result.reason).toBe(`OPS-03 not proven at ${reason}`);
    expect(h.destroyed()).toBe(true);
    expect(h.closed()).toBe(true);
    expect(h.trust.deploy).toBe(trustDocument(PRINCIPAL, OLD_EXT));
  });
});
