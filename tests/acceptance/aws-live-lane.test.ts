/** Second sandbox lane: the -live2 connection stack carries its own roles; the default lane's plan digest is unchanged. */
import { describe, expect, it } from "vitest";
import { buildPlan, laneSuffix, liveRoleNames, parseLane } from "../../scripts/acceptance/live/plan";

const ACCOUNT = "123456789012";
const base = { accountId: ACCOUNT, region: "ap-south-1", runId: "zlive-202610290000-abcd", durationMinutes: 140, dbSubnetGroup: "zenith-live-sandbox", dbSecurityGroup: "sg-12345678", workloadBoundaryArn: `arn:aws:iam::${ACCOUNT}:policy/ZenithLiveWorkloadBoundary`, scenario: "teardown-01" as const };

describe("sandbox lanes", () => {
  it("keeps the default lane's settings and digest byte-identical", () => {
    const plain = buildPlan(base);
    expect(buildPlan({ ...base, lane: undefined }).sha256).toBe(plain.sha256);
    expect(plain.settings).not.toHaveProperty("lane");
    expect(plain.productCalls!.find(c => c.id === "teardown01-iam-trust-deploy")!.resource).toBe(`arn:aws:iam::${ACCOUNT}:role/ZenithDeployRole-live`);
  });

  it("binds lane live2 into the plan and rewrites only the -live2 connection roles", () => {
    const plan = buildPlan({ ...base, lane: "live2" });
    expect(plan.settings.lane).toBe("live2");
    expect(plan.sha256).not.toBe(buildPlan(base).sha256);
    const iam = plan.productCalls!.filter(c => c.service === "iam" || c.service === "sts").map(c => c.resource);
    expect(new Set(iam)).toEqual(new Set([`arn:aws:iam::${ACCOUNT}:role/ZenithObserveRole-live2`, `arn:aws:iam::${ACCOUNT}:role/ZenithDeployRole-live2`]));
    expect(buildPlan(plan.settings).sha256).toBe(plan.sha256);
  });

  it("refuses the second lane for harness fixture scenarios and unknown lanes", () => {
    for (const scenario of ["fixtures", "retention-s3", "rel-04"] as const) expect(() => buildPlan({ ...base, scenario, durationMinutes: 15, lane: "live2" })).toThrow("only product scenarios");
    expect(() => parseLane("live3")).toThrow("Unknown sandbox lane");
    expect([parseLane(undefined), parseLane("live"), parseLane("live2")]).toEqual([undefined, undefined, "live2"]);
    expect([laneSuffix({}), laneSuffix({ lane: "live2" })]).toEqual(["-live", "-live2"]);
    expect(liveRoleNames("-live2")).toEqual({ observe: "ZenithObserveRole-live2", deploy: "ZenithDeployRole-live2", writer: "ZenithSecretWriterRole-live2", principal: "ZenithLiveAcceptance" });
  });
});
