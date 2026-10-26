/**
 * PROD-MIX-03 ProductScenarioPort (typed outputs, live sandbox), offline. The browser driver is a fake, the AWS side is an
 * in-memory world answered only for planned calls, and the real Guard admits or refuses every call. No cloud or stack is used.
 * Live evidence comes only from scripts/acceptance/aws-live.ts with ZENITH_LIVE_PRODUCT=1 and a passing approved run.
 */
import { describe, expect, it } from "vitest";
import { allCalls, buildPlan, scopedRequirementIds } from "../../scripts/acceptance/live/plan";
import { grantsFor, Guard } from "../../scripts/acceptance/live/guard";
import type { Call, Json, Plan } from "../../scripts/acceptance/live/contracts";
import {
  fill, mix03Port, templateExternalId, trustDocument, unwiredProduct, type Mix03Product,
} from "../../scripts/acceptance/live/product/mix-03";

const ACCOUNT = "123456789012", REGION = "ap-south-1", RUN = "zlive-202610260000-ab01", ENV = "envlive1";
const FN = "zenith-envlive1-consumer", BUCKET = "zenith-envlive1-producer";
const PRINCIPAL = `arn:aws:iam::${ACCOUNT}:role/ZenithLiveAcceptance`;
const OLD_EXT = "old-live-external-id", NEW_EXT = `zenith-${"b".repeat(32)}`;
const OWNED = [{ Key: "zenith:managed", Value: "true" }, { Key: "zenith:environment", Value: ENV }];
const settings = { accountId: ACCOUNT, region: REGION, runId: RUN, durationMinutes: 15, dbSubnetGroup: "zenith-live-sandbox", dbSecurityGroup: "sg-12345678", workloadBoundaryArn: `arn:aws:iam::${ACCOUNT}:policy/ZenithLiveWorkloadBoundary`, scenario: "mix-03" as const };
const env = { ZENITH_LIVE_PRODUCT: "1", AWS_ACCESS_KEY_ID: "test-access", AWS_SECRET_ACCESS_KEY: "test-secret", AWS_SESSION_TOKEN: "test-token" };
const requirement = { id: "PROD-MIX-03", acceptance: [], fixtures: [], join: "" };
const COMMIT = "a".repeat(40);
const fast = { sleep: async () => undefined, propagation: { attempts: 3, intervalMs: 0 }, polls: { attempts: 3, intervalMs: 0 } };

/** The AWS side: the sandbox trust documents, the tagged product resources and what has been deleted. */
interface World { trustDocs: Record<"observe" | "deploy", string>; deleted: Set<string>; extra: { ResourceARN: string; Tags: { Key: string; Value: string }[] }[]; failDelete: boolean; envArn?: string }
function world(): World {
  return {
    trustDocs: { observe: trustDocument(PRINCIPAL, OLD_EXT), deploy: trustDocument(PRINCIPAL, OLD_EXT) },
    deleted: new Set(), extra: [], failDelete: false,
  };
}
const resources = (state: World) => [
  { ResourceARN: `arn:aws:lambda:${REGION}:${ACCOUNT}:function:${FN}`, Tags: OWNED },
  { ResourceARN: `arn:aws:s3:::${BUCKET}`, Tags: OWNED },
  ...state.extra,
].filter(r => !state.deleted.has(r.ResourceARN));

function respond(state: World, c: Call, input: Record<string, Json>): Record<string, unknown> {
  switch (c.id) {
    case "mix03-iam-read-observe": return { Role: { AssumeRolePolicyDocument: encodeURIComponent(state.trustDocs.observe) } };
    case "mix03-iam-read-deploy": return { Role: { AssumeRolePolicyDocument: encodeURIComponent(state.trustDocs.deploy) } };
    case "mix03-iam-trust-observe": state.trustDocs.observe = String(input.PolicyDocument); return {};
    case "mix03-iam-trust-deploy": state.trustDocs.deploy = String(input.PolicyDocument); return {};
    case "mix03-tag-read": return { ResourceTagMappingList: resources(state) };
    case "mix03-lambda-read": return { Role: `arn:aws:iam::${ACCOUNT}:role/${FN}-fn`, Environment: { Variables: { PRODUCER_BUCKET_ARN: state.envArn ?? `arn:aws:s3:::${BUCKET}` } } };
    case "mix03-bucket-head": return {};
    case "mix03-bucket-tags": return { TagSet: OWNED };
    case "mix03-lambda-delete": if (state.failDelete) throw Object.assign(new Error("denied"), { name: "AccessDenied" }); state.deleted.add(`arn:aws:lambda:${REGION}:${ACCOUNT}:function:${FN}`); return {};
    case "mix03-logs-delete": return {};
    case "mix03-role-read": return { Role: { Tags: OWNED } };
    case "mix03-role-attached-list": return { AttachedPolicies: [] };
    case "mix03-role-inline-list": return { PolicyNames: [] };
    case "mix03-role-delete": return {};
    case "mix03-bucket-delete": state.deleted.add(`arn:aws:s3:::${BUCKET}`); return {};
    default: throw new Error(`unexpected planned call in the fake: ${c.id}`);
  }
}

/** A driver where the whole browser flow succeeds; each test overrides the step it exercises. */
function happy(overrides: Partial<Mix03Product> = {}): Mix03Product {
  let uses = 0;
  return {
    createTenant: async () => ({ workspaceId: "ws-1", approverId: "approver-1" }),
    createAwsConnection: async () => ({ connectionId: "conn-1", externalId: NEW_EXT }),
    verifyAws: async () => ({ ok: true, reason: "" }),
    proposeMixed: async () => ({ environmentId: ENV, planId: "plan-1", parentOperationId: "op-parent" }),
    approve: async () => undefined,
    startMixed: async () => ({ started: true }),
    children: async () => [
      { role: "producer", status: "succeeded", childOperationId: "op-producer", receiptOperationId: "op-producer" },
      { role: "consumer", status: "succeeded", childOperationId: "op-consumer", receiptOperationId: "op-consumer" },
    ],
    changeProducer: async () => ({ consumerState: "review_required" }),
    issueOutputPreauthorization: async () => undefined,
    useOutputOnce: async () => ({ ok: uses++ === 0 }),
    ...overrides,
  };
}

/** Plan, real guard, and a `call` that admits only planned calls and records what was sent. */
function harness(state: World, product: Mix03Product, seamOverrides: Partial<Parameters<typeof mix03Port>[1]> = {}, environment: Record<string, string | undefined> = env) {
  const plan: Plan = buildPlan(settings);
  const permission = {
    schema: 1 as const, decision: "DEC-CLOUD" as const, approvedBy: "owner-test", approvedAt: "2020-01-01T00:00:00.000Z", expiresAt: "2099-01-01T00:00:00.000Z",
    accountId: ACCOUNT, region: REGION, runId: RUN, planSha256: plan.sha256, sourceCommit: COMMIT, maxUsd: plan.estimate.usd, maxMinutes: plan.settings.durationMinutes, grants: grantsFor(plan),
  };
  const guard = new Guard(plan, permission, plan.estimate.usd);
  const sent: { id: string; input: Record<string, Json> }[] = [];
  const call = async (c: Call, input?: Record<string, Json>) => {
    guard.consume(c);
    const resolved = input ?? c.input;
    sent.push({ id: c.id, input: resolved });
    return respond(state, c, resolved);
  };
  const port = mix03Port(environment, { product, ...fast, ...seamOverrides });
  return { plan, sent, run: () => port.verify(requirement, { plan, commit: COMMIT, call }) };
}

describe("PROD-MIX-03 preconditions and the default driver", () => {
  it("refuses without ZENITH_LIVE_PRODUCT=1 and makes no call", async () => {
    const state = world();
    const { run, sent } = harness(state, happy(), {}, { ...env, ZENITH_LIVE_PRODUCT: undefined });
    const result = await run();
    expect(result.complete).toBe(false);
    expect(result.reason).toContain("ZENITH_LIVE_PRODUCT=1");
    expect(sent).toEqual([]);
  });

  it("refuses without the AWS session in the process environment", async () => {
    const state = world();
    const { run, sent } = harness(state, happy(), {}, { ZENITH_LIVE_PRODUCT: "1" });
    const result = await run();
    expect(result.complete).toBe(false);
    expect(result.reason).toContain("AWS session");
    expect(sent).toEqual([]);
  });

  it("refuses a plan that is not the mix-03 scenario", async () => {
    const plan = buildPlan({ ...settings, scenario: "retention-s3" });
    const port = mix03Port(env, { product: happy(), ...fast });
    const result = await port.verify(requirement, { plan, commit: COMMIT, call: async () => { throw new Error("no call expected"); } });
    expect(result.complete).toBe(false);
    expect(result.reason).toContain("not the mix-03 scenario");
  });

  it("the default driver refuses before the first AWS call, so nothing is changed", async () => {
    const state = world();
    const { run, sent } = harness(state, unwiredProduct);
    const result = await run();
    expect(result.complete).toBe(false);
    expect(result.reason).toContain("not wired");
    expect(sent).toEqual([]);
    expect(state.trustDocs.observe).toBe(trustDocument(PRINCIPAL, OLD_EXT));
  });

  it("only another scenario's requirement is out of scope for this port", async () => {
    const plan = buildPlan(settings);
    const port = mix03Port(env, { product: happy(), ...fast });
    const result = await port.verify({ id: "PROD-OPS-07", acceptance: [], fixtures: [], join: "" }, { plan, commit: COMMIT, call: async () => { throw new Error("no call expected"); } });
    expect(result.complete).toBe(false);
    expect(result.reason).toContain("not implemented by this port");
  });
});

describe("PROD-MIX-03 trust update (ExternalId only, restored afterwards)", () => {
  it("changes only the ExternalId of both sandbox roles and restores the original trust", async () => {
    const state = world();
    const { run, sent } = harness(state, happy());
    const result = await run();
    expect(result.complete).toBe(true);
    expect(result.leaks).toEqual([]);
    const writes = sent.filter(s => s.id === "mix03-iam-trust-observe" || s.id === "mix03-iam-trust-deploy");
    expect(writes.map(w => w.input.PolicyDocument)).toEqual([
      trustDocument(PRINCIPAL, NEW_EXT), trustDocument(PRINCIPAL, NEW_EXT), trustDocument(PRINCIPAL, OLD_EXT), trustDocument(PRINCIPAL, OLD_EXT),
    ]);
    expect(state.trustDocs).toEqual({ observe: trustDocument(PRINCIPAL, OLD_EXT), deploy: trustDocument(PRINCIPAL, OLD_EXT) });
  });

  it("refuses a trust document with an extra statement and writes nothing", async () => {
    const state = world();
    const drifted = JSON.parse(trustDocument(PRINCIPAL, OLD_EXT)) as { Statement: unknown[] };
    drifted.Statement.push({ Sid: "Extra", Effect: "Allow", Principal: { AWS: "*" }, Action: "sts:AssumeRole" });
    state.trustDocs.observe = JSON.stringify(drifted);
    const { run, sent } = harness(state, happy());
    const result = await run();
    expect(result.complete).toBe(false);
    expect(result.reason).toContain("not the expected template shape");
    expect(sent.some(s => s.id.startsWith("mix03-iam-trust"))).toBe(false);
  });

  it("refuses an ExternalId whose shape the template does not allow", () => {
    const bad = JSON.parse(trustDocument(PRINCIPAL, "bad value with spaces")) as unknown;
    expect(() => templateExternalId(bad, PRINCIPAL)).toThrow("not the expected template shape");
  });

  it("refuses when connection.verifyAws never passes within the propagation bound, and still restores trust", async () => {
    const state = world();
    const { run, sent } = harness(state, happy({ verifyAws: async () => ({ ok: false, reason: "AssumeRole denied" }) }));
    const result = await run();
    expect(result.complete).toBe(false);
    expect(result.reason).toContain("propagation bound");
    expect(state.trustDocs.observe).toBe(trustDocument(PRINCIPAL, OLD_EXT));
    expect(sent.filter(s => s.id === "mix03-iam-trust-deploy")).toHaveLength(2);
  });

  it("the trust template rendering is the one the verifier accepts", () => {
    expect(templateExternalId(JSON.parse(trustDocument(PRINCIPAL, NEW_EXT)) as unknown, PRINCIPAL)).toBe(NEW_EXT);
  });
});

describe("PROD-MIX-03 children, receipts and independent readback", () => {
  it("refuses a consumer that starts before the producer receipt", async () => {
    const state = world();
    const { run } = harness(state, happy({ children: async () => [
      { role: "producer", status: "running" }, { role: "consumer", status: "running" },
    ] }));
    const result = await run();
    expect(result.complete).toBe(false);
    expect(result.reason).toContain("consumer started before the producer receipt");
  });

  it("refuses a receipt that does not link its child operation", async () => {
    const state = world();
    const { run } = harness(state, happy({ children: async () => [
      { role: "producer", status: "succeeded", childOperationId: "op-a", receiptOperationId: "op-b" },
      { role: "consumer", status: "succeeded", childOperationId: "op-c", receiptOperationId: "op-c" },
    ] }));
    const result = await run();
    expect(result.reason).toContain("producer receipt does not link");
  });

  it("approves every awaiting child round through the driver", async () => {
    const state = world();
    const approved: string[] = [];
    let polls = 0;
    const { run } = harness(state, happy({
      approve: async (_t, op) => { approved.push(op); },
      children: async () => polls++ === 0
        ? [{ role: "producer", status: "awaiting_approval", awaitingOperationId: "op-p-round" }, { role: "consumer", status: "queued" }]
        : [{ role: "producer", status: "succeeded", childOperationId: "op-p", receiptOperationId: "op-p" }, { role: "consumer", status: "succeeded", childOperationId: "op-c", receiptOperationId: "op-c" }],
    }));
    const result = await run();
    expect(result.complete).toBe(true);
    expect(approved).toEqual(["op-parent", "op-p-round"]);
  });

  it("refuses when the consumer's deployed PRODUCER_BUCKET_ARN differs from the producer bucket", async () => {
    const state = world();
    state.envArn = "arn:aws:s3:::zenith-envlive1-other";
    const { run } = harness(state, happy());
    const result = await run();
    expect(result.complete).toBe(false);
    expect(result.reason).toContain("PRODUCER_BUCKET_ARN does not equal the producer bucket ARN");
  });

  it("refuses unless the run left exactly one tagged producer bucket", async () => {
    const state = world();
    state.extra.push({ ResourceARN: "arn:aws:s3:::zenith-envlive1-other", Tags: OWNED });
    const { run } = harness(state, happy());
    const result = await run();
    expect(result.complete).toBe(false);
    expect(result.reason).toContain("exactly one tagged consumer function and one tagged producer bucket");
  });

  it("refuses when a producer change does not make the consumer require review", async () => {
    const state = world();
    const { run } = harness(state, happy({ changeProducer: async () => ({ consumerState: "unchanged" }) }));
    const result = await run();
    expect(result.complete).toBe(false);
    expect(result.reason).toContain("did not make the consumer require review");
  });

  it("refuses when the single-use preauthorization is accepted a second time", async () => {
    const state = world();
    const { run } = harness(state, happy({ useOutputOnce: async () => ({ ok: true }) }));
    const result = await run();
    expect(result.complete).toBe(false);
    expect(result.reason).toContain("second use of the one-use preauthorization was not refused");
  });

  it("refuses when the first use of the preauthorization is refused", async () => {
    const state = world();
    const { run } = harness(state, happy({ useOutputOnce: async () => ({ ok: false }) }));
    const result = await run();
    expect(result.reason).toContain("first use of the one-use preauthorization was refused");
  });

  it("a full pass names the automated test approver and makes no unplanned call", async () => {
    const state = world();
    const { run, sent } = harness(state, happy());
    const result = await run();
    expect(result.complete).toBe(true);
    expect(result.reason).toContain("automated test approver");
    expect(sent.map(s => s.id)).toContain("mix03-lambda-read");
  });
});

describe("PROD-MIX-03 cleanup", () => {
  it("deletes only tagged exact-pattern resources and reports what it could not delete", async () => {
    const state = world();
    state.extra.push(
      { ResourceARN: `arn:aws:s3:::zenith-envlive1-stray`, Tags: [{ Key: "zenith:managed", Value: "true" }] },
      { ResourceARN: `arn:aws:s3:::someone-else-bucket`, Tags: OWNED },
    );
    const { run, sent } = harness(state, happy());
    const result = await run();
    expect(result.complete).toBe(false);
    const deletes = sent.filter(s => s.id.endsWith("-delete")).map(s => s.id);
    expect(deletes).toEqual(["mix03-lambda-delete", "mix03-logs-delete", "mix03-role-delete", "mix03-bucket-delete"]);
    expect(state.deleted.has("arn:aws:s3:::someone-else-bucket")).toBe(false);
    expect(state.deleted.has("arn:aws:s3:::zenith-envlive1-stray")).toBe(false);
    expect(result.leaks?.some(l => l.includes("outside the exact patterns"))).toBe(true);
    expect(result.leaks?.some(l => l.includes("still present after cleanup"))).toBe(true);
  });

  it("a failed delete is a leak, not a pass", async () => {
    const state = world();
    state.failDelete = true;
    const { run } = harness(state, happy());
    const result = await run();
    expect(result.complete).toBe(false);
    expect(result.leaks).toContain("deleting the consumer function failed; resources may remain");
  });

  it("a refusal after the proposal still restores the trust and deletes the run's resources", async () => {
    const state = world();
    const { run } = harness(state, happy({ startMixed: async () => ({ started: false, reason: "The parent is not approved yet" }) }));
    const result = await run();
    expect(result.complete).toBe(false);
    expect(result.reason).toContain("did not start");
    expect(state.trustDocs.deploy).toBe(trustDocument(PRINCIPAL, OLD_EXT));
    expect(state.trustDocs.observe).toBe(trustDocument(PRINCIPAL, OLD_EXT));
  });
});

describe("PROD-MIX-03 plan shape and guard", () => {
  it("has no harness fixtures and only mix-03 product calls, all unique and planned", () => {
    const plan = buildPlan(settings);
    expect(plan.fixtures).toEqual([]);
    const ids = allCalls(plan).map(c => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect((plan.productCalls ?? []).every(c => c.id.startsWith("mix03-"))).toBe(true);
    expect(scopedRequirementIds(plan.settings, ["PROD-MIX-03", "PROD-OPS-07"])).toEqual(["PROD-MIX-03"]);
  });

  it("the requested IAM calls target exactly the two sandbox roles", () => {
    const plan = buildPlan(settings);
    const trust = (plan.productCalls ?? []).filter(c => c.command === "UpdateAssumeRolePolicy" || c.command === "GetRole" && c.id.startsWith("mix03-iam-read"));
    expect(trust.map(c => c.resource).sort()).toEqual([
      `arn:aws:iam::${ACCOUNT}:role/ZenithDeployRole-live`, `arn:aws:iam::${ACCOUNT}:role/ZenithDeployRole-live`,
      `arn:aws:iam::${ACCOUNT}:role/ZenithObserveRole-live`, `arn:aws:iam::${ACCOUNT}:role/ZenithObserveRole-live`,
    ]);
  });

  it("no grant contains a wildcard action, and every planned action is an exact service:operation", () => {
    const plan = buildPlan(settings);
    for (const grant of grantsFor(plan)) {
      expect(grant.action).not.toContain("*");
      expect(grant.action).toMatch(/^[a-z0-9]+:[A-Za-z0-9]+$/);
    }
  });

  it("the guard refuses a call that is not in the plan", () => {
    const plan = buildPlan(settings);
    const permission = {
      schema: 1 as const, decision: "DEC-CLOUD" as const, approvedBy: "owner-test", approvedAt: "2020-01-01T00:00:00.000Z", expiresAt: "2099-01-01T00:00:00.000Z",
      accountId: ACCOUNT, region: REGION, runId: RUN, planSha256: plan.sha256, sourceCommit: COMMIT, maxUsd: plan.estimate.usd, maxMinutes: plan.settings.durationMinutes, grants: grantsFor(plan),
    };
    const guard = new Guard(plan, permission, plan.estimate.usd);
    const planned = (plan.productCalls ?? [])[0]!;
    expect(() => guard.consume({ ...planned, input: { ...planned.input, Extra: "x" } })).toThrow("Unplanned AWS call refused");
    expect(() => guard.consume({ ...planned, id: "mix03-not-planned" })).toThrow("Unplanned AWS call refused");
  });

  it("fill refuses an unresolved runtime value and never sends the marker", () => {
    expect(() => fill({ Name: { $runtime: "missing" } }, {})).toThrow("unresolved runtime value");
    expect(fill({ Name: { $runtime: "environmentId" } }, { environmentId: ENV })).toEqual({ Name: ENV });
  });

  it("the other scenarios carry no product calls, so their digests are unchanged by this scenario", () => {
    expect(buildPlan({ ...settings, scenario: "retention-s3" }).productCalls).toBeUndefined();
    expect(buildPlan({ ...settings, scenario: "rel-04" }).productCalls).toBeUndefined();
    expect(buildPlan({ ...settings, scenario: "mix-03" }).sha256).not.toBe(buildPlan({ ...settings, scenario: "rel-04" }).sha256);
    expect(Object.keys(buildPlan({ ...settings, scenario: "retention-s3" }))).not.toContain("productCalls");
  });
});
