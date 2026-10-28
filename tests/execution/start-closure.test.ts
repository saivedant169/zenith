import { describe, expect, it } from "vitest";
import type { Client } from "@temporalio/client";
import { temporal } from "@temporalio/proto";
import { startClosure } from "@/lib/workflows/start-closure";

const S = temporal.api.enums.v1.WorkflowExecutionStatus;
const RUN = "0f8fad5b-d9cb-469f-a165-70867728950e";
const EP = "endpoint-digest-1";
const binding = { namespace: "zenith", workflowId: "deploy:op_1", endpointDigest: EP };
function client(describe: (input: unknown) => Promise<unknown>, namespace = "zenith"): Client {
  return { options: { namespace }, withDeadline: (_d: number, fn: () => Promise<unknown>) => fn(),
    workflowService: { describeWorkflowExecution: describe } } as unknown as Client;
}
const described = (status: number, runId = RUN, workflowId = binding.workflowId) => async () => ({ workflowExecutionInfo: { status, execution: { workflowId, runId } } });

describe("startClosure (teardown settlement)", () => {
  it("reports a terminal run as closed and a running or continued-as-new run as open", async () => {
    for (const status of [S.WORKFLOW_EXECUTION_STATUS_COMPLETED, S.WORKFLOW_EXECUTION_STATUS_FAILED, S.WORKFLOW_EXECUTION_STATUS_CANCELED,
      S.WORKFLOW_EXECUTION_STATUS_TERMINATED, S.WORKFLOW_EXECUTION_STATUS_TIMED_OUT]) expect(await startClosure(client(described(status)), EP, binding, RUN)).toBe("closed");
    expect(await startClosure(client(described(S.WORKFLOW_EXECUTION_STATUS_RUNNING)), EP, binding, RUN)).toBe("open");
    expect(await startClosure(client(described(S.WORKFLOW_EXECUTION_STATUS_CONTINUED_AS_NEW)), EP, binding, RUN)).toBe("open");
  });
  it("is unknown for another namespace, a mismatched run or workflow, an unspecified status or a failed read", async () => {
    let calls = 0;
    expect(await startClosure(client(async () => { calls++; return {}; }, "other"), EP, binding, RUN)).toBe("unknown");
    expect(calls).toBe(0);
    expect(await startClosure(client(described(S.WORKFLOW_EXECUTION_STATUS_COMPLETED, "1b4e28ba-2fa1-41d2-883f-0016d3cca427")), EP, binding, RUN)).toBe("unknown");
    expect(await startClosure(client(described(S.WORKFLOW_EXECUTION_STATUS_COMPLETED, RUN, "deploy:other")), EP, binding, RUN)).toBe("unknown");
    expect(await startClosure(client(described(S.WORKFLOW_EXECUTION_STATUS_UNSPECIFIED)), EP, binding, RUN)).toBe("unknown");
    expect(await startClosure(client(async () => { throw Object.assign(new Error("unavailable"), { code: 14 }); }), EP, binding, RUN)).toBe("unknown");
    expect(await startClosure(client(described(S.WORKFLOW_EXECUTION_STATUS_COMPLETED)), EP, binding, "not-a-uuid")).toBe("unknown");
  });
  it("is unknown when the worker's Temporal endpoint differs from the one the start recorded", async () => {
    let calls = 0;
    expect(await startClosure(client(async () => { calls++; return {}; }), "endpoint-digest-2", binding, RUN)).toBe("unknown");
    expect(calls).toBe(0);
  });
  it("reports NotFound as such, leaving the database horizon to decide", async () => {
    expect(await startClosure(client(async () => { throw Object.assign(new Error("missing"), { code: 5 }); }), EP, binding, null)).toBe("not_found");
  });
});
