/**
 * PROD-MIX-03 ProductScenarioPort (typed outputs, live sandbox), offline. The browser driver is a fake, the AWS side is an
 * in-memory world answered only for planned calls, and the real Guard admits or refuses every call. No cloud or stack is used.
 * Live evidence comes only from scripts/acceptance/aws-live.ts with ZENITH_LIVE_PRODUCT=1 and a passing approved run.
 */
import { describe, expect, it, vi } from "vitest";
import { allCalls, buildPlan, scopedRequirementIds } from "../../scripts/acceptance/live/plan";
import { grantsFor, Guard } from "../../scripts/acceptance/live/guard";
import type { Call, Json, Plan } from "../../scripts/acceptance/live/contracts";
import {
  consumerPackage, fill, mix03Port, templateExternalId, trustDocument, unwiredProduct, type Mix03Child, type Mix03Product, type MixedReadback,
} from "../../scripts/acceptance/live/product/mix-03";
import { buildReceipt } from "@/lib/execution/mixed/receipt";

const ACCOUNT = "123456789012", REGION = "ap-south-1", RUN = "zlive-202610260000-ab01", ENV = "envlive1";
const FN = "zenith-envlive1-consumer", BUCKET = "zenith-envlive1-producer";
const PRINCIPAL = `arn:aws:iam::${ACCOUNT}:role/ZenithLiveAcceptance`;
const OLD_EXT = "old-live-external-id", NEW_EXT = `zenith-${"b".repeat(32)}`;
const OWNED = [{ Key: "zenith:managed", Value: "true" }, { Key: "zenith:environment", Value: ENV }];
const settings = { accountId: ACCOUNT, region: REGION, runId: RUN, durationMinutes: 15, dbSubnetGroup: "zenith-live-sandbox", dbSecurityGroup: "sg-12345678", workloadBoundaryArn: `arn:aws:iam::${ACCOUNT}:policy/ZenithLiveWorkloadBoundary`, scenario: "mix-03" as const };
const VERSION = "3HL4kqtJlcpXroDTDmJ";
const env = { ZENITH_LIVE_PRODUCT: "1", AWS_ACCESS_KEY_ID: "test-access", AWS_SECRET_ACCESS_KEY: "test-secret", AWS_SESSION_TOKEN: "test-token" };
const STATE_BUCKET = `zenith-state-${ACCOUNT}-${REGION}-live`;
const requirement = { id: "PROD-MIX-03", acceptance: [], fixtures: [], join: "" };
const COMMIT = "a".repeat(40);
const fast = { upload: async () => VERSION, sleep: async () => undefined, propagation: { attempts: 3, intervalMs: 0 }, polls: { attempts: 3, intervalMs: 0 } };

/** The AWS side: the sandbox trust documents, the tagged product resources and what has been deleted. */
interface World { trustDocs: Record<"observe" | "deploy", string>; deleted: Set<string>; extra: { ResourceARN: string; Tags: { Key: string; Value: string }[] }[]; failDelete: boolean; envArn?: string; inline?: string[]; fnState?: Record<string, string> }
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
    case "mix03-sts-assume": expect(input.ExternalId).toBe(NEW_EXT); return { Credentials: { AccessKeyId: "A", SecretAccessKey: "S", SessionToken: "T" } };
    // One answer per child environment, as the tag API filters by one tag value: only the producer and consumer ENV have resources here.
    case "mix03-tag-read": return { ResourceTagMappingList: (input.TagFilters as { Values: string[] }[])[0]!.Values[0] === ENV ? resources(state) : [] };
    case "mix03-lambda-read": return { ...state.fnState, Role: `arn:aws:iam::${ACCOUNT}:role/${FN}-fn`, Environment: { Variables: { PRODUCER_BUCKET_ARN: state.envArn ?? `arn:aws:s3:::${BUCKET}` } } };
    case "mix03-bucket-head": return {};
    case "mix03-bucket-tags": return { TagSet: OWNED };
    case "mix03-lambda-delete": if (state.failDelete) throw Object.assign(new Error("denied"), { name: "AccessDenied" }); state.deleted.add(`arn:aws:lambda:${REGION}:${ACCOUNT}:function:${FN}`); return {};
    case "mix03-logs-delete": for (const suffix of ["", ":*"]) state.deleted.add(`arn:aws:logs:${REGION}:${ACCOUNT}:log-group:${String(input.logGroupName)}${suffix}`); return {};
    case "mix03-role-read": return { Role: { Tags: OWNED } };
    case "mix03-role-attached-list": return { AttachedPolicies: [] };
    case "mix03-role-inline-list": return { PolicyNames: state.inline ?? [] };
    case "mix03-role-inline-delete": return {};
    case "mix03-role-delete": return {};
    case "mix03-bucket-delete": state.deleted.add(`arn:aws:s3:::${BUCKET}`); return {};
    default: throw new Error(`unexpected planned call in the fake: ${c.id}`);
  }
}

/**
 * The stored plan behind the fake driver (PROD-MIX-02). Stage 0: the producer is done and the consumer waits for its review;
 * starting the worker again moves it to stage 1, where both children succeeded with durable receipts.
 */
function mixedPlan() {
  const h = (c: string) => c.repeat(64), at = "2026-10-30T00:00:00.000Z";
  const state = { stage: 0, changeOnRestart: undefined as undefined | ((plan: MixedReadback) => void) };
  const receipt = (partitionId: string, ordinal: number, childOperationId: string, semantics: string) =>
    buildReceipt({ workspaceId: "ws-1", parentPlanId: "plan-1", partitionId, ordinal, childOperationId, outcome: "succeeded", childStatus: "succeeded", executableSemanticsDigest: semantics, planDigest: h("f") }, at);
  const readback = async (): Promise<MixedReadback> => {
    const done = state.stage > 0;
    const plan: MixedReadback = {
      status: done ? "succeeded" : "running", parentOperationId: "op-parent", parentDigest: h("1"), desiredDigest: h("2"), childSetDigest: h("3"), executionOrder: ["p-producer", "p-consumer"],
      children: [
        { partitionId: "p-producer", dependsOn: [], subplanDigest: h("4"), semanticsDigest: h("5"), effectDigest: h("6"), nodes: [{ stableAddress: `aws:${ACCOUNT}:${REGION}::aws_s3_bucket.producer`, address: "aws_s3_bucket.producer", specDigest: h("7") }],
          state: "succeeded", childOperationId: "op-producer", executableSemanticsDigest: h("d"), receipt: receipt("p-producer", 0, "op-producer", h("d")) },
        { partitionId: "p-consumer", dependsOn: ["p-producer"], subplanDigest: h("8"), semanticsDigest: h("9"), effectDigest: h("a"), nodes: [{ stableAddress: `aws:${ACCOUNT}:${REGION}::aws_lambda_function.consumer`, address: "aws_lambda_function.consumer", specDigest: h("b") }],
          state: done ? "succeeded" : "pending", childOperationId: done ? "op-consumer" : null, executableSemanticsDigest: done ? h("e") : null, receipt: done ? receipt("p-consumer", 1, "op-consumer", h("e")) : null },
      ],
    };
    if (done) state.changeOnRestart?.(plan);
    return plan;
  };
  const children = async (): Promise<Mix03Child[]> => state.stage > 0
    ? [{ role: "producer", status: "succeeded", childOperationId: "op-producer", receiptOperationId: "op-producer" }, { role: "consumer", status: "succeeded", childOperationId: "op-consumer", receiptOperationId: "op-consumer" }]
    : [{ role: "producer", status: "succeeded", childOperationId: "op-producer", receiptOperationId: "op-producer" }, { role: "consumer", status: "pending", awaitingOperationId: "op-review" }];
  const events: string[] = [];
  const worker = { stop: async () => { events.push("stop"); }, start: async () => { events.push("start"); state.stage = 1; } };
  return { state, readback, children, worker, events };
}

/** A driver where the whole browser flow succeeds; each test overrides the step it exercises. */
function happy(overrides: Partial<Mix03Product> = {}): Mix03Product {
  const finished = mixedPlan();
  finished.state.stage = 1;
  let uses = 0;
  return {
    createTenant: async () => ({ workspaceId: "ws-1", approverId: "approver-1" }),
    createAwsConnection: async () => ({ connectionId: "conn-1", externalId: NEW_EXT }),
    verifyAws: async () => ({ ok: true, reason: "" }),
    proposeMixed: async () => ({ environmentIds: [ENV, "envlive2"], planId: "plan-1", parentOperationId: "op-parent" }),
    approve: async () => undefined,
    startMixed: async () => ({ started: true }),
    children: async () => [
      { role: "producer", status: "succeeded", childOperationId: "op-producer", receiptOperationId: "op-producer" },
      { role: "consumer", status: "succeeded", childOperationId: "op-consumer", receiptOperationId: "op-consumer" },
    ],
    changeProducer: async () => ({ consumerState: "review_required" }),
    issueOutputPreauthorization: async () => undefined,
    useOutputOnce: async () => ({ ok: uses++ === 0 }),
    planReadback: finished.readback,
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
  return { plan, sent, run: () => port.verify(requirement, { plan, commit: COMMIT, call }), run02: () => port.verify({ ...requirement, id: "PROD-MIX-02" }, { plan, commit: COMMIT, call }) };
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

  it("refuses before the mixed proposal when the state bucket returns no object version", async () => {
    const state = world();
    const proposeMixed = vi.fn();
    const { run } = harness(state, happy({ proposeMixed }), { upload: async () => undefined });
    const result = await run();
    expect(result.reason).toContain("did not return an object version for the consumer's package");
    expect(proposeMixed).not.toHaveBeenCalled();
    expect(state.trustDocs.deploy).toBe(trustDocument(PRINCIPAL, OLD_EXT));
  });

  it("builds a stable one-file zip whose digests match its bytes", () => {
    const a = consumerPackage(), b = consumerPackage();
    expect(a.zip.equals(b.zip)).toBe(true);
    expect(a.zip.subarray(0, 4).toString("hex")).toBe("504b0304");
    expect(a.zip.toString()).toContain("exports.handler");
    expect(a.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(a.sourceDigest).not.toBe(a.sha256);
  });

  it("passes the state bucket to the connection and the uploaded package to the mixed proposal", async () => {
    const state = world();
    const createAwsConnection = vi.fn(async () => ({ connectionId: "conn-1", externalId: NEW_EXT }));
    const proposeMixed = vi.fn(async () => ({ environmentIds: [ENV, "envlive2"], planId: "plan-1", parentOperationId: "op-parent" }));
    const upload = vi.fn(async () => VERSION);
    const { run } = harness(state, happy({ createAwsConnection, proposeMixed }), { upload });
    expect((await run()).reason).toMatch(/^PROD-MIX-03 partly proven/);
    const pkg = consumerPackage();
    expect(upload).toHaveBeenCalledWith({ region: REGION, credentials: { accessKeyId: "A", secretAccessKey: "S", sessionToken: "T" }, bucket: STATE_BUCKET, key: `zenith-live/${RUN}/consumer.zip`, body: pkg.zip });
    expect(createAwsConnection).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ stateBucket: STATE_BUCKET, accountId: ACCOUNT, region: REGION }));
    expect(proposeMixed).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      connectionId: "conn-1", accountId: ACCOUNT, region: REGION,
      artifact: { bucket: STATE_BUCKET, key: `zenith-live/${RUN}/consumer.zip`, versionId: VERSION, sha256: pkg.sha256, sourceDigest: pkg.sourceDigest },
    }));
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
    expect(result.reason).toMatch(/^PROD-MIX-03 partly proven/);
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
    expect(result.reason).toMatch(/^PROD-MIX-03 partly proven/);
    expect(approved).toEqual(["op-parent", "op-p-round"]);
  });

  it("stops polling children before the run window closes, names their states, and still tears down", async () => {
    const state = world();
    // 15-minute window, 5 reserved for teardown: each poll advances the clock 4 minutes, so the third poll is past the deadline.
    let clock = 0;
    const { run, sent } = harness(state, happy({ children: async () => { clock += 4 * 60_000; return [
      { role: "producer", status: "running", childOperationId: "op-p", operationStatus: "queued" }, { role: "consumer", status: "pending" },
    ]; } }), { now: () => clock, polls: { attempts: 120, intervalMs: 0 } });
    const result = await run();
    expect(result.complete).toBe(false);
    expect(result.reason).toContain("did not finish within the bound (producer running/queued, consumer pending)");
    expect(state.trustDocs.deploy).toBe(trustDocument(PRINCIPAL, OLD_EXT));
    expect(sent.some(s => s.id === "mix03-bucket-delete")).toBe(true);
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

  it("a run names the automated test approver and makes no unplanned call", async () => {
    const state = world();
    const { run, sent } = harness(state, happy());
    const result = await run();
    expect(result.reason).toMatch(/^PROD-MIX-03 partly proven/);
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

  it("deletes the Lambda role's \"logs\" inline policy, the role and the tagged log group, with no leak", async () => {
    const state = world();
    state.inline = ["logs"];
    state.extra.push(
      { ResourceARN: `arn:aws:logs:${REGION}:${ACCOUNT}:log-group:/aws/lambda/${FN}`, Tags: OWNED },
      { ResourceARN: `arn:aws:logs:${REGION}:${ACCOUNT}:log-group:/aws/lambda/zenith-envlive1-orphan:*`, Tags: OWNED },
    );
    const { run, sent } = harness(state, happy());
    const result = await run();
    expect(result.leaks ?? []).toEqual([]);
    expect(sent.filter(s => s.id === "mix03-role-inline-delete").map(s => s.input.PolicyName)).toEqual(["logs"]);
    expect(sent.some(s => s.id === "mix03-role-delete")).toBe(true);
    expect(sent.filter(s => s.id === "mix03-logs-delete").map(s => s.input.logGroupName)).toEqual([`/aws/lambda/${FN}`, "/aws/lambda/zenith-envlive1-orphan"]);
  });

  it("keeps the role when an inline policy is neither \"logs\" nor zenith-*", async () => {
    const state = world();
    state.inline = ["admin"];
    const { run, sent } = harness(state, happy());
    const result = await run();
    expect(result.leaks).toContain("an inline role policy outside the exact pattern; role not deleted");
    expect(sent.some(s => s.id === "mix03-role-delete")).toBe(false);
  });

  it("stops at once when a child ends uncertain, names how, and still tears down", async () => {
    const state = world();
    const { run, sent } = harness(state, happy({ children: async () => [
      { role: "producer", status: "succeeded", childOperationId: "op-p", receiptOperationId: "op-p", operationStatus: "succeeded" },
      { role: "consumer", status: "uncertain", childOperationId: "op-c", operationStatus: "uncertain", halt: "verify_inconclusive" },
    ] }), { polls: { attempts: 120, intervalMs: 0 } });
    const result = await run();
    expect(result.reason).toContain("a child operation did not succeed (producer succeeded/succeeded, consumer uncertain/uncertain:verify_inconclusive)");
    expect(sent.filter(s => s.id === "mix03-lambda-delete")).toHaveLength(1);
  });

  it("names the consumer function's Lambda state codes, never its reason text, when a child did not succeed", async () => {
    const state = world();
    state.fnState = { State: "Failed", StateReasonCode: "InvalidZipFileException", StateReason: "secret text arn:aws:x", LastUpdateStatus: "Failed" };
    const { run } = harness(state, happy({ children: async () => [
      { role: "producer", status: "succeeded", childOperationId: "op-p", receiptOperationId: "op-p" },
      { role: "consumer", status: "uncertain", childOperationId: "op-c", operationStatus: "uncertain" },
    ] }));
    const result = await run();
    expect(result.reason).toContain("consumer function before teardown: State=Failed StateReasonCode=InvalidZipFileException LastUpdateStatus=Failed");
    expect(result.reason).not.toContain("secret text");
  });

  it("a passing run does not append the function state", async () => {
    const state = world();
    state.fnState = { State: "Active" };
    const { run } = harness(state, happy());
    expect((await run()).reason).not.toContain("consumer function before teardown");
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
    expect(scopedRequirementIds(plan.settings, ["PROD-MIX-03", "PROD-OPS-07"])).toEqual(["PROD-MIX-03", "PROD-MIX-02"]);
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

describe("PROD-MIX-02 from the same run (immutable child plans, resume across a worker restart)", () => {
  const staged = (change?: (plan: MixedReadback) => void) => {
    const plan = mixedPlan();
    plan.state.changeOnRestart = change;
    const approve = vi.fn(async (_tenant: unknown, operationId: string) => { plan.events.push(`approve:${operationId}`); });
    return { plan, product: happy({ children: plan.children, planReadback: plan.readback, approve }) };
  };

  it("stops the worker with the consumer waiting, approves while it is down, resumes and proves both from one run", async () => {
    const { plan, product } = staged();
    const { run, run02, sent } = harness(world(), product, { worker: plan.worker });
    const second = await run02();
    expect(second.reason).toMatch(/^PROD-MIX-02 proven on the live sandbox/);
    expect(second.complete).toBe(true);
    expect(plan.events).toEqual(["approve:op-parent", "stop", "approve:op-review", "start"]);
    const calls = sent.length;
    const first = await run();
    expect(first.reason).toMatch(/^PROD-MIX-03 partly proven/);
    expect(sent.length).toBe(calls);
    expect(first.leaks).toEqual([]);
  });

  it.each([
    ["a changed subplan digest", (p: MixedReadback) => { p.children[1]!.subplanDigest = "c".repeat(64); }, "digests, order or stable addresses changed"],
    ["a moved stable address", (p: MixedReadback) => { p.children[0]!.nodes[0]!.address = "aws_s3_bucket.other"; }, "digests, order or stable addresses changed"],
    ["a receipt that does not re-derive", (p: MixedReadback) => { p.children[1]!.receipt!.childStatus = "succeeded_without_reviewed_semantics"; }, "consumer receipt does not record a success"],
    ["a forged receipt digest", (p: MixedReadback) => { p.children[1]!.receipt!.receiptDigest = "0".repeat(64); }, "consumer receipt does not re-derive"],
    ["a rewritten producer receipt", (p: MixedReadback) => { p.children[0]!.receipt = { ...p.children[0]!.receipt!, recordedAt: "2026-10-31T00:00:00.000Z" }; }, "producer receipt changed across the worker restart"],
  ] as const)("refuses %s, leaves PROD-MIX-03 standing and still cleans up", async (_name, change, reason) => {
    const { plan, product } = staged(change);
    const state = world();
    const { run, run02 } = harness(state, product, { worker: plan.worker });
    const second = await run02();
    expect(second.complete).toBe(false);
    expect(second.reason).toContain("PROD-MIX-02 not proven at PROD-MIX-02 readback");
    expect(second.reason).toContain(reason);
    expect((await run()).reason).toMatch(/^PROD-MIX-03 partly proven/);
    expect(state.deleted.size).toBeGreaterThan(0);
  });

  it("names the downtime and why the parent stopped when the consumer does not come back after the restart", async () => {
    const plan = mixedPlan();
    let clock = 0;
    const children = async (): Promise<Mix03Child[]> => plan.state.stage > 0
      ? [{ role: "producer", status: "succeeded", childOperationId: "op-producer", receiptOperationId: "op-producer" }, { role: "consumer", status: "blocked", childOperationId: "op-consumer", operationStatus: "approved" }]
      : plan.children();
    const operationHalt = vi.fn(async () => ({ status: "uncertain", halt: "other", detail: "activity timed out (heartbeat)" }));
    const worker = { stop: plan.worker.stop, start: async () => { clock += 312_000; await plan.worker.start(); } };
    const { run, run02 } = harness(world(), happy({ children, planReadback: plan.readback, operationHalt }), { worker, now: () => clock });
    const reason = "a child operation did not succeed (producer succeeded, consumer blocked/approved); the worker was down 312 s; parent operation uncertain:other (product: activity timed out (heartbeat))";
    expect((await run02()).reason).toBe(`PROD-MIX-02 not proven at child rounds: ${reason}`);
    expect((await run()).reason).toContain(`PROD-MIX-03 not proven at child rounds: ${reason}`);
    expect(operationHalt).toHaveBeenCalledWith(expect.anything(), "op-parent");
  });

  it("refuses PROD-MIX-02 when the consumer never waited, so the worker was never stopped", async () => {
    const { run02 } = harness(world(), happy(), { worker: { stop: async () => { throw new Error("not expected"); }, start: async () => undefined } });
    expect((await run02()).reason).toContain("the worker was never stopped");
  });

  it("fails both when the worker cannot be restarted, and still tears down", async () => {
    const plan = mixedPlan();
    const state = world();
    const { run, run02 } = harness(state, happy({ children: plan.children, planReadback: plan.readback }), { worker: { stop: async () => undefined, start: async () => { throw Object.assign(new Error("x"), {}); } } });
    expect((await run02()).reason).toContain("PROD-MIX-02 not proven at worker restart");
    expect((await run()).reason).toContain("PROD-MIX-03 not proven at worker restart");
    expect(state.trustDocs.deploy).toBe(trustDocument(PRINCIPAL, OLD_EXT));
  });
});
