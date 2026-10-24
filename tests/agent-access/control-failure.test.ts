import { describe, expect, it } from "vitest";
import { failure } from "@/lib/agent-access/control/boundary";
import { HostedError } from "@/lib/hosted/contracts/errors";

describe("agent control error boundary", () => {
  it("keeps a hosted identity refusal's code and status instead of a generic 400", async () => {
    const outage = failure(new HostedError("policy_unavailable", "The identity provider did not answer, so this request was refused rather than allowed on an unverified session."));
    expect(outage.status).toBe(503);
    expect((await outage.json()).error.code).toBe("policy_unavailable");
    const ended = failure(new HostedError("sign_in_required", "You are not signed in, or your session has ended."));
    expect(ended.status).toBe(401);
    expect((await ended.json()).error.code).toBe("sign_in_required");
  });
  it("still answers an unexpected error as request_failed without its message", async () => {
    const response = failure(new Error("internal detail"));
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error.code).toBe("request_failed");
    expect(JSON.stringify(body)).not.toContain("internal detail");
  });
});
