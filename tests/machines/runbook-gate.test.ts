import { describe, expect, it } from "vitest";
import { evaluateRunbookGate } from "@/lib/machines/runbooks/policy";

const now = new Date("2026-10-20T00:00:00.000Z");
const mutating = { requiresApproval: true, escapeHatchSteps: ["exec"] } as never;
const approval = (over: Record<string, string> = {}) => ({ id: "rba_1", workspaceId: "ws", bindingDigest: "d".repeat(64), requestedBy: "user:alice",
  approverId: "user:bob", expiresAt: "2026-10-20T01:00:00.000Z", createdAt: "2026-10-19T23:00:00.000Z", ...over });

describe("runbook run gate", () => {
  it("allows only an unexpired approval by someone else for this requester's run", () => {
    expect(evaluateRunbookGate({ classification: mutating, approval: approval(), requestedBy: "user:alice", now }).outcome).toBe("allow");
    expect(evaluateRunbookGate({ classification: mutating, approval: null, requestedBy: "user:alice", now }).reason).toBe("approval_missing");
    expect(evaluateRunbookGate({ classification: mutating, approval: approval({ expiresAt: "2026-10-19T23:59:59.000Z" }), requestedBy: "user:alice", now }).outcome).toBe("require_approval");
    expect(evaluateRunbookGate({ classification: mutating, approval: approval({ approverId: "user:alice" }), requestedBy: "user:alice", now }).reason).toBe("self_approval");
  });

  it("does not let one requester's approval cover another requester's identical run", () => {
    expect(evaluateRunbookGate({ classification: mutating, approval: approval(), requestedBy: "user:carol", now }).outcome).toBe("require_approval");
  });
});
