/** tofuFailureCode: a fixed `<command>:<cause>` for a failed OpenTofu command, never its output text. */
import { describe, expect, it } from "vitest";
import { TofuCommandError } from "@/lib/tofu/runner";
import { tofuFailureCode, tofuOutputCause } from "@/lib/tofu/failure-code";

const failed = (command: string, output: string) =>
  new TofuCommandError("tofu_command_failed", "failed", { command, exitCode: 1, output, truncated: false, durationMs: 1 } as unknown as ConstructorParameters<typeof TofuCommandError>[2]);

describe("tofuFailureCode", () => {
  it.each([
    ["apply", "Error: Failed to save state\n\nError saving state: arn:aws:s3:::secret-bucket", "apply:state_save"],
    ["apply", "Error: Error acquiring the state lock", "apply:state_lock"],
    ["apply", "Error: Provider produced inconsistent result after apply\n\nWhen applying changes to aws_lambda_function.x", "apply:inconsistent_result"],
    ["apply", "Error: Saved plan is stale", "apply:stale_plan"],
    ["apply", "operation error Lambda: CreateFunction, https response error StatusCode: 400, RequestID: abc, api error InvalidParameterValueException: The role arn:aws:iam::1:role/x", "apply:api_InvalidParameterValueException"],
    ["apply", "https response error StatusCode: 403, RequestID: abc", "apply:http_403"],
    ["output", "something nobody planned for arn:aws:secret", "output:unknown"],
  ])("%s with %j is %s", (command, output, code) => {
    const result = tofuFailureCode(failed(command, output));
    expect(result).toBe(code);
    expect(result).toMatch(/^[A-Za-z0-9_.:-]{1,64}$/);
  });

  it("names the fixed cause of raw output for the live harness's own OpenTofu runs", () => {
    expect(tofuOutputCause("Error: creating Secrets Manager Secret: operation error: api error AccessDeniedException: User arn:aws:sts::1:x is not authorized")).toBe("api_AccessDeniedException");
    expect(tofuOutputCause("Error: Error acquiring the state lock\nLock Info: ID 1")).toBe("state_lock");
    expect(tofuOutputCause("some other failure /tmp/x")).toBe("unknown");
  });

  it("is undefined for anything that is not an OpenTofu command failure", () => {
    expect(tofuFailureCode(new Error("Failed to save state"))).toBeUndefined();
  });
});
