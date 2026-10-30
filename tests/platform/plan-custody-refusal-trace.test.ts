import { describe, expect, it } from "vitest";
import { refusalTrace } from "@/lib/platform/plan-artifacts";

describe("plan custody refusal trace", () => {
  it("keeps class, code and frames but never the message", () => {
    const e = Object.assign(new Error("value-abc-123"), { name: "PlanArtifactError", code: "plan_artifact_unavailable" });
    e.stack = "PlanArtifactError: value-abc-123\n    at refuse (/app/dist/execution/worker.cjs:1234:11)\n    at lockOwner (/app/dist/execution/worker.cjs:1300:5)";
    const trace = refusalTrace("publish", e);
    expect(trace).toBe("[zenith-diagnostic] plan custody publish refused: PlanArtifactError/plan_artifact_unavailable refuse @worker.cjs:1234 < lockOwner @worker.cjs:1300");
    expect(trace).not.toContain("value-abc-123");
    expect(refusalTrace("publish", "not an error")).toBe("[zenith-diagnostic] plan custody publish refused: ?/? ");
  });
});
