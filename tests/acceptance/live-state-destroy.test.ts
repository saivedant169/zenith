import { describe, expect, it } from "vitest";
import { destroyFromState, providerBlocks, type Exec } from "../../scripts/acceptance/live/product/state-destroy";

const credentials = { accessKeyId: "ASIAEXAMPLE", secretAccessKey: "secret-value", sessionToken: "token-value" };
const backend = { kind: "s3" as const, bucket: "zenith-state-123456789012-ap-south-1-live", region: "ap-south-1" };
const state = (providers: string[]) => JSON.stringify({ version: 4, resources: providers.map((provider, i) => ({ type: "aws_s3_bucket", name: `b${i}`, provider })) });
const AWS = 'provider["registry.opentofu.org/hashicorp/aws"]';

function fake(stateJson: string, left = "") {
  const calls: { args: string[]; env: Record<string, string | undefined> }[] = [];
  let pulls = 0;
  const exec: Exec = async (_file, args, options) => {
    calls.push({ args, env: options.env });
    // First pull: the recorded state. Second pull: what is left after the destroy (empty output = no state at all).
    if (args[0] === "state" && args[1] === "pull") return { code: 0, stdout: pulls++ === 0 ? stateJson : left };
    return { code: 0, stdout: "" };
  };
  return { exec, calls };
}

describe("live state-destroy cleanup", () => {
  it("destroys the recorded state with the session credentials only in the child environment, then proves it empty", async () => {
    const { exec, calls } = fake(state([AWS, AWS]));
    await expect(destroyFromState({ tofu: "tofu", region: "ap-south-1", backend, stateKey: "zenith/ws/env/terraform.tfstate", credentials, exec })).resolves.toEqual({ destroyed: 2, destroyedArns: [], destroyedIds: [] });
    expect(calls.map(c => c.args[0] + " " + (c.args[1] ?? ""))).toEqual(["init -input=false", "state pull", "apply -auto-approve", "state pull"]);
    expect(calls[2]!.env.AWS_SESSION_TOKEN).toBe("token-value");
    expect(Object.keys(calls[0]!.env).filter(k => k.startsWith("AWS_")).sort()).toEqual(["AWS_ACCESS_KEY_ID", "AWS_EC2_METADATA_DISABLED", "AWS_REGION", "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN"]);
  });
  it("returns the destroyed ARNs (some linger in the tag inventory after deletion)", async () => {
    const arn = "arn:aws:ecs:ap-south-1:123456789012:cluster/zenith-x-web";
    const { exec } = fake(JSON.stringify({ version: 4, resources: [{ type: "aws_ecs_cluster", name: "c", provider: AWS, instances: [{ attributes: { arn } }] }, { type: "aws_lb", name: "l", provider: AWS, instances: [{ attributes: { arn: "arn:aws:elasticloadbalancing:x" } }] }] }));
    await expect(destroyFromState({ tofu: "tofu", region: "ap-south-1", backend, stateKey: "zenith/ws/env/terraform.tfstate", credentials, exec })).resolves.toEqual({ destroyed: 2, destroyedArns: [arn, "arn:aws:elasticloadbalancing:x"], destroyedIds: [] });
  });
  it("skips apply for an empty state and still re-reads it", async () => {
    const { exec, calls } = fake(JSON.stringify({ version: 4, resources: [] }));
    await expect(destroyFromState({ tofu: "tofu", region: "ap-south-1", backend, stateKey: "zenith/ws/env/terraform.tfstate", credentials, exec })).resolves.toEqual({ destroyed: 0, destroyedArns: [], destroyedIds: [] });
    expect(calls.some(c => c.args[0] === "apply")).toBe(false);
  });
  it("fails closed when resources remain or a command fails, without echoing output", async () => {
    const left = fake(state([AWS]), state([AWS]));
    await expect(destroyFromState({ tofu: "tofu", region: "ap-south-1", backend, stateKey: "zenith/ws/env/terraform.tfstate", credentials, exec: left.exec })).rejects.toThrow("1 resource(s) remain");
    const failing: Exec = async (_file, args) => ({ code: args[0] === "apply" ? 1 : 0, stdout: args[1] === "pull" ? state([AWS]) : "secret-value" });
    // An absent state (empty pull output) before and after is an empty, successful cleanup.
    await expect(destroyFromState({ tofu: "tofu", region: "ap-south-1", backend, stateKey: "zenith/ws/env/terraform.tfstate", credentials, exec: async () => ({ code: 0, stdout: "" }) })).resolves.toEqual({ destroyed: 0, destroyedArns: [], destroyedIds: [] });
    await expect(destroyFromState({ tofu: "tofu", region: "ap-south-1", backend, stateKey: "zenith/ws/env/terraform.tfstate", credentials, exec: failing })).rejects.toThrow(/^OpenTofu destroy failed during cleanup/);
    // The fixed cause from stderr names the failure; the output itself never leaves.
    const denied: Exec = async (_file, args) => ({ code: args[0] === "apply" ? 1 : 0, stdout: args[1] === "pull" ? state([AWS]) : "", stderr: args[0] === "apply" ? "Error: deleting secret: api error AccessDeniedException: secret-value" : "" });
    const refusal = destroyFromState({ tofu: "tofu", region: "ap-south-1", backend, stateKey: "zenith/ws/env/terraform.tfstate", credentials, exec: denied });
    await expect(refusal).rejects.toThrow("OpenTofu destroy failed during cleanup (api_AccessDeniedException); resources may remain.");
    await expect(refusal).rejects.not.toThrow(/secret-value/);
  });
  it("configures region-named aliases and refuses any other alias or provider form", () => {
    expect(providerBlocks(JSON.parse(state([AWS, `${AWS}.us_east_1`])), "ap-south-1")).toEqual([{ region: "ap-south-1" }, { alias: "us_east_1", region: "us-east-1" }]);
    expect(() => providerBlocks(JSON.parse(state([`${AWS}.edge`])), "ap-south-1")).toThrow(/not a region name/);
    expect(() => providerBlocks(JSON.parse(state(['provider["example.com/hashicorp/aws"]'])), "ap-south-1")).toThrow(/does not accept/);
    expect(providerBlocks(JSON.parse(state(['provider["registry.opentofu.org/hashicorp/random"]'])), "ap-south-1")).toEqual([{ region: "ap-south-1" }]);
  });
});
