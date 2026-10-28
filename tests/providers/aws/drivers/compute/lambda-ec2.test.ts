/**
 * The two experimental drivers: `aws:lambda_function` and `aws:ec2_instance`.
 * Expansion does not produce these kinds yet; the tests use hand-built nodes.
 */
import { DescribeInstanceStatusCommand, DescribeInstancesCommand, EC2Client } from "@aws-sdk/client-ec2";
import { GetFunctionCommand, GetFunctionConfigurationCommand, InvokeCommand, LambdaClient, ListFunctionsCommand, ListTagsCommand, TagResourceCommand } from "@aws-sdk/client-lambda";
import { DescribeInstanceInformationCommand, SSMClient } from "@aws-sdk/client-ssm";
import { GetResourcesCommand, ResourceGroupsTaggingAPIClient } from "@aws-sdk/client-resource-groups-tagging-api";
import { mockClient } from "aws-sdk-client-mock";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { TofuFragment } from "@/lib/drivers/types";
import { MAX_PAYLOAD_BYTES, MAX_RESPONSE_BYTES, boundResponse, lambdaFunctionDriver as lambda } from "@/lib/providers/aws/drivers/compute/lambda-function";
import { AL2023_PARAMETER, ec2InstanceDriver as ec2 } from "@/lib/providers/aws/drivers/compute/ec2-instance";
import { DriverCompileError, refLocalName } from "@/lib/providers/aws/drivers/shared";
import { SECRET_CANARY, buildFullFixture, mkCompileContext, mkDriverContext, zenithTagList, zenithTagMap } from "./fixtures";

const lambdaMock = mockClient(LambdaClient);
const ec2Mock = mockClient(EC2Client);
const ssmMock = mockClient(SSMClient);
const tagging = mockClient(ResourceGroupsTaggingAPIClient);
afterAll(() => [lambdaMock, ec2Mock, ssmMock, tagging].forEach((m) => m.restore()));
beforeEach(() => [lambdaMock, ec2Mock, ssmMock, tagging].forEach((m) => m.reset()));

type Body = Record<string, unknown>;
const res = (f: TofuFragment, type: string, label: string): Body => (f.resource as Record<string, Record<string, Body>>)[type][label];
const fx = buildFullFixture();
const ctx = () => mkCompileContext(fx.byAddress);
const asList = (v: unknown): string[] => (Array.isArray(v) ? (v as string[]) : [v as string]);

describe("aws:lambda_function compile", () => {
  const f = lambda.compile!(fx.fn, ctx());

  it("is a Zip function from an S3 object with its own role and log group", () => {
    expect(f.addresses[0]).toBe("aws_lambda_function.function_resize");
    expect(res(f, "aws_lambda_function", "function_resize")).toMatchObject({
      function_name: "zn-acme-resize",
      package_type: "Zip",
      runtime: "nodejs22.x",
      handler: "index.handler",
      memory_size: 512,
      timeout: 20,
      architectures: ["x86_64"],
      s3_bucket: "acme-artifacts",
      s3_key: "fn/resize.zip",
      publish: true,
      s3_object_version: "fixture-version-1",
      source_code_hash: Buffer.from("a".repeat(64), "hex").toString("base64"),
      environment: [{ variables: { MODE: "fast" } }],
      logging_config: [{ log_format: "Text", log_group: "${aws_cloudwatch_log_group.function_resize_logs.name}" }],
    });
    expect(res(f, "aws_lambda_function", "function_resize")).not.toHaveProperty("vpc_config");
    expect(res(f, "aws_cloudwatch_log_group", "function_resize_logs")).toMatchObject({ name: "/aws/lambda/zn-acme-resize", retention_in_days: 30 });
    const role = res(f, "aws_iam_role", "function_resize");
    expect(JSON.parse(role.assume_role_policy as string).Statement[0].Principal).toEqual({ Service: "lambda.amazonaws.com" });
    expect(role.permissions_boundary).toMatch(/ZenithAppBoundary$/);
  });

  it("the role can write only its own log group's streams: no wildcard action, one trailing stream wildcard", () => {
    const statements = JSON.parse(res(f, "aws_iam_role_policy", "function_resize").policy as string).Statement;
    expect(statements).toHaveLength(1);
    expect(asList(statements[0].Action)).toEqual(["logs:CreateLogStream", "logs:PutLogEvents"]);
    expect(statements[0].Resource).toMatch(/:log-group:\$\{aws_cloudwatch_log_group\.function_resize_logs\.name\}:log-stream:\*$/);
  });

  it("refuses secret references (Lambda has no valueFrom), bad runtimes and bad artifacts", () => {
    const n = (spec: Body) => ({ ...fx.fn, spec: { ...fx.fn.spec, ...spec } });
    expect(() => lambda.compile!(n({ env: [{ key: "DB", secretRef: "vault:db" }] }), ctx())).toThrow(/Lambda cannot inject secrets/);
    expect(() => lambda.compile!(n({ runtime: "node;rm" }), ctx())).toThrow(DriverCompileError);
    expect(() => lambda.compile!(n({ handler: "a b" }), ctx())).toThrow(/handler is not valid/);
    expect(() => lambda.compile!(n({ artifact: { type: "s3", bucket: "Bad_Bucket", key: "k" } }), ctx())).toThrow(/artifact must be an S3 object/);
    expect(() => lambda.compile!(n({ artifact: { type: "s3", bucket: "acme-artifacts", key: "../k" } }), ctx())).toThrow(/artifact must be an S3 object/);
    expect(() => lambda.compile!(n({ artifact: { type: "image" } }), ctx())).toThrow(/artifact must be an S3 object/);
    expect(() => lambda.compile!(n({ memoryMb: 64 }), ctx())).toThrow(/memoryMb must be an integer from 128 to 10240/);
    expect(() => lambda.compile!(n({ timeoutSec: 901 }), ctx())).toThrow(/timeoutSec/);
    expect(() => lambda.compile!(n({ architecture: "mips" }), ctx())).toThrow(/architecture/);
  });

  it("refuses unversioned packages or absent source/package digests", () => {
    for (const patch of [{ version: undefined }, { version: "null" }, { sha256: undefined }, { sourceDigest: undefined }]) {
      expect(() => lambda.compile!({ ...fx.fn, spec: { ...fx.fn.spec, artifact: { ...(fx.fn.spec.artifact as Body), ...patch } } }, ctx())).toThrow(DriverCompileError);
    }
  });

  it("escapes template text in environment values and never reads secret values", () => {
    const evil = { ...fx.fn, spec: { ...fx.fn.spec, env: [{ key: "NOTE", value: '${file("/etc/passwd")}' }] } };
    const out = JSON.stringify(lambda.compile!(evil, ctx()));
    expect(out).toContain('$${file(\\"/etc/passwd\\")}');
    expect(out).not.toContain(SECRET_CANARY);
  });

  it("is deterministic, marks itself experimental, and declares contract evidence", () => {
    expect(JSON.stringify(lambda.compile!(fx.fn, ctx()))).toBe(JSON.stringify(f));
    expect(lambda.capabilities.experimental).toBe(true);
    expect(Object.values(lambda.capabilities.evidence).every((v) => v === "contract")).toBe(true);
    expect(lambda.capabilities.operations).toEqual(["function.invoke"]);
  });
});

const FN_ARN = "arn:aws:lambda:eu-west-1:123456789012:function:zn-acme-resize";
const fnNode = fx.fn;
const fnCfg = (over: Body = {}) => ({ Version: "1", CodeSha256: Buffer.from("a".repeat(64), "hex").toString("base64"), FunctionName: "zn-acme-resize", FunctionArn: FN_ARN, Runtime: "nodejs22.x" as const, Handler: "index.handler", MemorySize: 512, Timeout: 20, Architectures: ["x86_64" as const], State: "Active" as const, LastUpdateStatus: "Successful" as const, Role: "arn:aws:iam::123456789012:role/zn-acme-resize-fn", LoggingConfig: { LogGroup: "/aws/lambda/zn-acme-resize" }, ...over });
const fnGet = (cfg: Body = {}, tags: Record<string, string> = zenithTagMap("function/resize")) => ({ Configuration: fnCfg(cfg), Tags: tags });

const readMock = (cfg: Body = {}, tags: Record<string, string> = zenithTagMap("function/resize")) => {
  lambdaMock.on(GetFunctionConfigurationCommand).resolves(fnCfg(cfg));
  lambdaMock.on(ListTagsCommand).resolves({ Tags: tags });
};

describe("aws:lambda_function read side", () => {
  it("observes configuration by ARN, then verifies it is Active", async () => {
    readMock();
    const obs = await lambda.observe!(mkDriverContext(), fnNode, FN_ARN);
    expect(obs).toMatchObject({ presence: "present", externalId: FN_ARN });
    expect(Object.fromEntries(Object.entries(obs.attributes).map(([k, v]) => [k, (v as { value: unknown }).value]))).toEqual({ runtime: "nodejs22.x", handler: "index.handler", memoryMb: 512, timeoutSec: 20, architecture: "x86_64", codeSha256: Buffer.from("a".repeat(64), "hex").toString("base64") });
    expect(obs.native).toMatchObject({ functionName: "zn-acme-resize", state: "Active", logGroupName: "/aws/lambda/zn-acme-resize", tags: zenithTagMap("function/resize") });
    expect(Object.keys(obs.attributes).sort()).toEqual(Object.keys(lambda.expectedAttributes!(fnNode)).sort());
    const v = await lambda.verify!(mkDriverContext(), fnNode, obs);
    expect(v.status).toBe("passed");
    expect(v.checks.at(-1)).toMatchObject({ id: "active", passed: true });
    // The observe role allows GetFunctionConfiguration and ListTags, not GetFunction.
    expect(lambdaMock.commandCalls(GetFunctionCommand)).toHaveLength(0);
  });

  it("finds the function by tags; missing / inaccessible / unknown are classified", async () => {
    tagging.on(GetResourcesCommand).resolves({ ResourceTagMappingList: [{ ResourceARN: FN_ARN, Tags: zenithTagList("function/resize") }] });
    readMock();
    expect((await lambda.observe!(mkDriverContext(), fnNode)).presence).toBe("present");
    expect(tagging.commandCalls(GetResourcesCommand)[0].args[0].input.ResourceTypeFilters).toEqual(["lambda:function"]);
    lambdaMock.reset();
    lambdaMock.on(GetFunctionConfigurationCommand).rejects(Object.assign(new Error("nf"), { name: "ResourceNotFoundException" }));
    expect((await lambda.observe!(mkDriverContext(), fnNode, FN_ARN)).presence).toBe("missing");
    lambdaMock.reset();
    lambdaMock.on(GetFunctionConfigurationCommand).rejects(Object.assign(new Error("denied"), { name: "AccessDeniedException" }));
    expect((await lambda.observe!(mkDriverContext(), fnNode, FN_ARN)).presence).toBe("inaccessible");
    lambdaMock.reset();
    lambdaMock.on(GetFunctionConfigurationCommand).rejects(Object.assign(new Error("slow"), { name: "TooManyRequestsException" }));
    expect((await lambda.observe!(mkDriverContext(), fnNode, FN_ARN)).presence).toBe("unknown");
    expect((await lambda.observe!(mkDriverContext(), fnNode, "zn-acme-resize")).presence).toBe("unknown");
    tagging.reset();
    tagging.on(GetResourcesCommand).resolves({ ResourceTagMappingList: [] });
    expect((await lambda.observe!(mkDriverContext(), fnNode)).presence).toBe("missing");
  });

  it("reports drift: different memory and runtime fail verification", async () => {
    readMock({ MemorySize: 128, Runtime: "nodejs20.x" });
    const obs = await lambda.observe!(mkDriverContext(), fnNode, FN_ARN);
    const v = await lambda.verify!(mkDriverContext(), fnNode, obs);
    expect(v.status).toBe("failed");
    expect(v.checks.filter((c) => c.passed === false).map((c) => c.id).sort()).toEqual(["attr:memoryMb", "attr:runtime"]);
  });

  it("runtime: Active is healthy, Failed/Pending are not, with bounded signals", async () => {
    readMock();
    expect(await lambda.runtime!(mkDriverContext(), fnNode, FN_ARN)).toMatchObject({ health: "healthy", signals: ["state:Active"] });
    readMock({ State: "Failed", StateReasonCode: "InsufficientRolePermissions", LastUpdateStatus: "Failed" });
    expect(await lambda.runtime!(mkDriverContext(), fnNode, FN_ARN)).toMatchObject({ health: "unhealthy", signals: ["state:Failed", "last_update:Failed", "state_reason:InsufficientRolePermissions"] });
    readMock({ State: "Pending" });
    expect((await lambda.runtime!(mkDriverContext(), fnNode, FN_ARN)).health).toBe("degraded");
    lambdaMock.on(GetFunctionConfigurationCommand).rejects(Object.assign(new Error("nf"), { name: "ResourceNotFoundException" }));
    expect(await lambda.runtime!(mkDriverContext(), fnNode, FN_ARN)).toMatchObject({ health: "unhealthy", signals: ["function_missing"] });
  });

  it("discovers functions, tagging those Zenith created", async () => {
    lambdaMock.on(ListFunctionsCommand).resolves({ Functions: [fnCfg(), fnCfg({ FunctionName: "legacy", FunctionArn: `${FN_ARN}-legacy` })] });
    lambdaMock.on(ListTagsCommand).callsFake((i: { Resource: string }) => ({ Tags: i.Resource === FN_ARN ? zenithTagMap("function/resize") : { team: "x" } }));
    const found = await lambda.discover!(mkDriverContext());
    expect(found.map((f) => [f.name, f.zenithTagged]).sort()).toEqual([["legacy", false], ["zn-acme-resize", true]]);
  });
});

describe("function.invoke", () => {
  const invoke = lambda.operations!["function.invoke"];
  const ctxOp = (op = "op_inv_1") => mkDriverContext({ operationId: op });
  const installFn = (tags: Record<string, string> = zenithTagMap("function/resize")) => {
    tagging.on(GetResourcesCommand).resolves({ ResourceTagMappingList: [{ ResourceARN: FN_ARN, Tags: zenithTagList("function/resize") }] });
    lambdaMock.on(GetFunctionCommand).resolves(fnGet({}, tags));
    lambdaMock.on(TagResourceCommand).resolves({});
  };
  // the SDK types Payload as a blob adapter; the driver only reads it as bytes
  const payloadOf = (bytes: Uint8Array | string): never => (typeof bytes === "string" ? Buffer.from(bytes) : bytes) as never;

  it("invokes synchronously with the JSON payload and returns a bounded response", async () => {
    installFn();
    lambdaMock.on(InvokeCommand).resolves({ StatusCode: 200, ExecutedVersion: "1", Payload: payloadOf('{"ok":true,"n":3}'), $metadata: { requestId: "req-inv" } });
    const r = await invoke(ctxOp(), fnNode, { payload: { width: 100 } });
    expect(r).toMatchObject({ ok: true, requestIds: ["req-inv"], data: { statusCode: 200, executedVersion: "1", dryRun: false, response: '{"ok":true,"n":3}', truncated: false } });
    const call = lambdaMock.commandCalls(InvokeCommand)[0].args[0].input;
    expect(call).toMatchObject({ FunctionName: FN_ARN, Qualifier: "1", InvocationType: "RequestResponse", LogType: "None" });
    expect(Buffer.from(call.Payload as Uint8Array).toString()).toBe('{"width":100}');
  });

  it("refuses mutable versions and mismatched code before invoking", async () => {
    installFn();
    lambdaMock.on(GetFunctionCommand).resolves(fnGet({ Version: "$LATEST" }));
    expect(await invoke(ctxOp(), fnNode, {})).toMatchObject({ ok: false, data: { refused: true } });
    expect(lambdaMock.commandCalls(InvokeCommand)).toHaveLength(0);
    lambdaMock.on(GetFunctionCommand).resolves(fnGet({ CodeSha256: Buffer.from("c".repeat(64), "hex").toString("base64") }));
    expect(await invoke(ctxOp(), fnNode, { version: "1" })).toMatchObject({ ok: false, data: { refused: true } });
    expect(lambdaMock.commandCalls(InvokeCommand)).toHaveLength(0);
  });

  it("records the operation after a successful call and does not invoke twice for the same operation", async () => {
    installFn();
    lambdaMock.on(InvokeCommand).resolves({ StatusCode: 200, ExecutedVersion: "1", Payload: payloadOf("{}") });
    await invoke(ctxOp("op_a"), fnNode, {});
    expect(lambdaMock.commandCalls(TagResourceCommand)[0].args[0].input).toEqual({ Resource: FN_ARN, Tags: { "zenith:operation": "op_a" } });
    lambdaMock.reset();
    installFn({ ...zenithTagMap("function/resize"), "zenith:operation": "op_a" });
    const again = await invoke(ctxOp("op_a"), fnNode, {});
    expect(again).toMatchObject({ ok: true, data: { alreadyInvoked: true } });
    expect(lambdaMock.commandCalls(InvokeCommand)).toHaveLength(0);
    // a different operation does invoke
    lambdaMock.on(InvokeCommand).resolves({ StatusCode: 200, ExecutedVersion: "1", Payload: payloadOf("{}") });
    await invoke(ctxOp("op_b"), fnNode, {});
    expect(lambdaMock.commandCalls(InvokeCommand)).toHaveLength(1);
  });

  it("a dry run validates without executing and records nothing", async () => {
    installFn();
    lambdaMock.on(InvokeCommand).resolves({ StatusCode: 204 });
    const r = await invoke(ctxOp(), fnNode, { dryRun: true });
    expect(r).toMatchObject({ ok: true, data: { dryRun: true } });
    expect(lambdaMock.commandCalls(InvokeCommand)[0].args[0].input.InvocationType).toBe("DryRun");
    expect(lambdaMock.commandCalls(TagResourceCommand)).toHaveLength(0);
  });

  it("reports a function error as ok:false with the error type but no free text from the function", async () => {
    installFn();
    lambdaMock.on(InvokeCommand).resolves({ StatusCode: 200, ExecutedVersion: "1", FunctionError: "Unhandled", Payload: payloadOf('{"errorMessage":"boom","errorType":"Error"}') });
    const r = await invoke(ctxOp(), fnNode, {});
    expect(r).toMatchObject({ ok: false, data: { functionError: "Unhandled", statusCode: 200 } });
    expect(r.summary).toBe("function/resize returned Unhandled.");
  });

  it("refuses an oversized or unserializable payload before touching AWS", async () => {
    installFn();
    const r = await invoke(ctxOp(), fnNode, { payload: { blob: "x".repeat(MAX_PAYLOAD_BYTES) } });
    expect(r).toMatchObject({ ok: false, data: { refused: true } });
    expect(r.summary).toMatch(/limit is 65536/);
    const cyc: Body = {};
    cyc.self = cyc;
    await expect(invoke(ctxOp(), fnNode, { payload: cyc })).resolves.toMatchObject({ ok: false });
    expect(lambdaMock.commandCalls(InvokeCommand)).toHaveLength(0);
    expect(lambdaMock.commandCalls(GetFunctionCommand)).toHaveLength(0);
  });

  it("refuses a function that does not carry this node's tags", async () => {
    installFn({ ...zenithTagMap("function/other") });
    const r = await invoke(ctxOp(), fnNode, {});
    expect(r).toMatchObject({ ok: false, data: { refused: true } });
    expect(lambdaMock.commandCalls(InvokeCommand)).toHaveLength(0);
  });

  it("returns a classified failure for provider errors and lets an abort through", async () => {
    installFn();
    lambdaMock.on(InvokeCommand).rejects(Object.assign(new Error("Rate exceeded"), { name: "TooManyRequestsException", $metadata: { requestId: "r1" } }));
    expect(await invoke(ctxOp(), fnNode, {})).toMatchObject({ ok: false, data: { failure: "throttled" }, requestIds: ["r1"] });
    const ac = new AbortController();
    lambdaMock.on(InvokeCommand).callsFake(() => {
      ac.abort();
      throw Object.assign(new Error("aborted"), { name: "AbortError" });
    });
    await expect(invoke(mkDriverContext({ signal: ac.signal, operationId: "op_z" }), fnNode, {})).rejects.toMatchObject({ name: "AbortError" });
  });

  describe("boundResponse", () => {
    it("redacts secret-looking keys and AWS key ids, at any depth", () => {
      const r = boundResponse(Buffer.from(JSON.stringify({ user: "a", password: SECRET_CANARY, nested: { apiKey: SECRET_CANARY, list: [{ token: SECRET_CANARY }], note: "AKIAABCDEFGHIJKLMNOP" } })));
      expect(r.response).not.toContain(SECRET_CANARY);
      expect(r.response).not.toContain("AKIAABCDEFGHIJKLMNOP");
      expect(JSON.parse(r.response!)).toMatchObject({ user: "a", password: "[redacted]", nested: { apiKey: "[redacted]", note: "[redacted-key-id]" } });
    });

    it("cuts a large response to 16 KiB and says so", () => {
      const r = boundResponse(Buffer.from(JSON.stringify({ rows: "y".repeat(40_000) })));
      expect(Buffer.byteLength(r.response!)).toBeLessThanOrEqual(MAX_RESPONSE_BYTES);
      expect(r).toMatchObject({ truncated: true });
      expect(r.bytes).toBeGreaterThan(40_000);
    });

    it("handles empty and non-JSON output", () => {
      expect(boundResponse(undefined)).toEqual({ truncated: false, bytes: 0 });
      expect(boundResponse(Buffer.from("plain text AKIAABCDEFGHIJKLMNOP")).response).toBe("plain text [redacted-key-id]");
    });
  });
});

/* ----------------------------------- EC2 ------------------------------------ */

describe("aws:ec2_instance compile", () => {
  const f = ec2.compile!(fx.box, ctx());
  const inst = res(f, "aws_instance", "compute_instance_bastion");

  it("is reachable only through SSM: no key pair, no public IP, IMDSv2 required, encrypted root volume", () => {
    expect(f.addresses[0]).toBe("aws_instance.compute_instance_bastion");
    expect(inst).toMatchObject({
      instance_type: "t3.micro",
      associate_public_ip_address: false,
      metadata_options: [{ http_endpoint: "enabled", http_tokens: "required", http_put_response_hop_limit: 1, instance_metadata_tags: "disabled" }],
      root_block_device: [{ volume_type: "gp3", volume_size: 30, encrypted: true, delete_on_termination: true }],
      subnet_id: `\${local.${refLocalName("subnet/private-a", "id")}}`,
      vpc_security_group_ids: ["${aws_security_group.compute_instance_bastion_sg.id}"],
      iam_instance_profile: "${aws_iam_instance_profile.compute_instance_bastion.name}",
    });
    expect(inst).not.toHaveProperty("key_name");
    expect(inst).not.toHaveProperty("user_data");
  });

  it("resolves the AL2023 AMI at plan time through the public SSM parameter and never replaces the instance for a newer image", () => {
    const data = (f.data as Record<string, Record<string, Body>>).aws_ssm_parameter.compute_instance_bastion_ami;
    expect(data).toEqual({ name: AL2023_PARAMETER("x86_64") });
    expect(AL2023_PARAMETER("arm64")).toBe("/aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-arm64");
    expect(inst.ami).toBe("${data.aws_ssm_parameter.compute_instance_bastion_ami.insecure_value}");
    expect(inst.lifecycle).toEqual({ ignore_changes: ["ami"] });
  });

  it("its role trusts EC2, carries the boundary and gets the managed SSM core policy, nothing else", () => {
    const role = res(f, "aws_iam_role", "compute_instance_bastion");
    expect(JSON.parse(role.assume_role_policy as string).Statement[0].Principal).toEqual({ Service: "ec2.amazonaws.com" });
    expect(role.permissions_boundary).toMatch(/ZenithMachineBoundary$/);
    expect(res(f, "aws_iam_role_policy_attachment", "compute_instance_bastion_ssm").policy_arn).toBe("arn:${data.aws_partition.compute_instance_bastion.partition}:iam::aws:policy/AmazonSSMManagedInstanceCore");
    expect(f.resource).not.toHaveProperty("aws_iam_role_policy");
  });

  it("owns its security group through the shared contract: outbound HTTPS only, no inbound rule", () => {
    expect(res(f, "aws_vpc_security_group_egress_rule", "compute_instance_bastion_sg_https")).toMatchObject({ from_port: 443, to_port: 443 });
    expect(f.resource).not.toHaveProperty("aws_vpc_security_group_ingress_rule");
    expect(f.locals).toHaveProperty(refLocalName("compute_instance/bastion", "security_group_id"));
  });

  it("supports arm64 and refuses an architecture that contradicts the instance type", () => {
    const arm = { ...fx.box, spec: { instanceType: "t4g.small", architecture: "arm64" } };
    const a = ec2.compile!(arm, ctx());
    expect((a.data as Record<string, Record<string, Body>>).aws_ssm_parameter.compute_instance_bastion_ami.name).toBe(AL2023_PARAMETER("arm64"));
    expect(() => ec2.compile!({ ...fx.box, spec: { instanceType: "t4g.small" } }, ctx())).toThrow(/is arm64 but architecture is x86_64/);
    expect(() => ec2.compile!({ ...fx.box, spec: { instanceType: "t3.small", architecture: "arm64" } }, ctx())).toThrow(/is x86_64 but architecture is arm64/);
  });

  it("refuses bad input: instance type, volume size, missing subnet", () => {
    expect(() => ec2.compile!({ ...fx.box, spec: { instanceType: "t3 small; rm" } }, ctx())).toThrow(/not an EC2 instance type/);
    expect(() => ec2.compile!({ ...fx.box, spec: { rootVolumeGb: 2 } }, ctx())).toThrow(/rootVolumeGb/);
    expect(() => ec2.compile!({ ...fx.box, dependsOn: ["network/main"] }, ctx())).toThrow(/needs a private subnet/);
  });

  it("is deterministic, marks itself experimental and declares contract evidence", () => {
    expect(JSON.stringify(ec2.compile!(fx.box, ctx()))).toBe(JSON.stringify(f));
    expect(ec2.capabilities.experimental).toBe(true);
    expect(Object.values(ec2.capabilities.evidence).every((v) => v === "contract")).toBe(true);
  });
});

const INSTANCE_ID = "i-0abc123def4567890";
const instance = (over: Body = {}) => ({
  InstanceId: INSTANCE_ID,
  InstanceType: "t3.micro" as const,
  State: { Name: "running" as const, Code: 16 },
  SubnetId: "subnet-a",
  VpcId: "vpc-1",
  ImageId: "ami-1",
  MetadataOptions: { HttpTokens: "required" as const },
  IamInstanceProfile: { Arn: "arn:aws:iam::123456789012:instance-profile/zn-acme-bastion-ec2" },
  Placement: { AvailabilityZone: "eu-west-1a" },
  Tags: zenithTagList("compute_instance/bastion"),
  ...over,
});
const boxNode = fx.box;
const installInstance = (over: Body = {}) => ec2Mock.on(DescribeInstancesCommand).resolves({ Reservations: [{ Instances: [instance(over)] }] });

describe("aws:ec2_instance read side", () => {
  it("finds the instance by its tags through EC2 filters and reads the security-relevant settings", async () => {
    installInstance();
    const obs = await ec2.observe!(mkDriverContext(), boxNode);
    expect(obs).toMatchObject({ presence: "present", externalId: INSTANCE_ID });
    expect(Object.fromEntries(Object.entries(obs.attributes).map(([k, v]) => [k, (v as { value: unknown }).value]))).toEqual({ instanceType: "t3.micro", imdsV2Required: true, publicIpAssigned: false, instanceProfileAttached: true });
    expect(obs.native).toMatchObject({ instanceId: INSTANCE_ID, state: "running", availabilityZone: "eu-west-1a", tags: zenithTagMap("compute_instance/bastion") });
    const filters = ec2Mock.commandCalls(DescribeInstancesCommand)[0].args[0].input.Filters!;
    expect(filters).toEqual(expect.arrayContaining([{ Name: "tag:zenith:resource", Values: ["compute_instance/bastion"] }, { Name: "tag:zenith:environment", Values: ["env_1"] }]));
    expect(filters.find((f) => f.Name === "instance-state-name")!.Values).not.toContain("terminated");
    expect(Object.keys(obs.attributes).sort()).toEqual(Object.keys(ec2.expectedAttributes!(boxNode)).sort());
  });

  it("flags drift: IMDSv1 allowed, a public IP, no instance profile, another type", async () => {
    installInstance({ MetadataOptions: { HttpTokens: "optional" }, PublicIpAddress: "203.0.113.9", IamInstanceProfile: undefined, InstanceType: "t3.large" });
    const obs = await ec2.observe!(mkDriverContext(), boxNode, INSTANCE_ID);
    const v = await ec2.verify!(mkDriverContext(), boxNode, obs, { address: boxNode.address, health: "healthy", counts: {}, signals: ["state:running", "ssm:Online"], observedAt: "", source: "x", simulated: false });
    expect(v.status).toBe("failed");
    expect(v.checks.filter((c) => c.passed === false).map((c) => c.id).sort()).toEqual(["attr:imdsV2Required", "attr:instanceProfileAttached", "attr:instanceType", "attr:publicIpAssigned"]);
  });

  it("missing for no instance or only a terminated one; ambiguous for two; classified errors; bad externalId", async () => {
    ec2Mock.on(DescribeInstancesCommand).resolves({ Reservations: [] });
    expect((await ec2.observe!(mkDriverContext(), boxNode)).presence).toBe("missing");
    ec2Mock.on(DescribeInstancesCommand).resolves({ Reservations: [{ Instances: [instance({ State: { Name: "terminated" } })] }] });
    expect((await ec2.observe!(mkDriverContext(), boxNode)).presence).toBe("missing");
    ec2Mock.on(DescribeInstancesCommand).resolves({ Reservations: [{ Instances: [instance(), instance({ InstanceId: "i-0abc123def4567891" })] }] });
    expect((await ec2.observe!(mkDriverContext(), boxNode)).presence).toBe("unknown");
    ec2Mock.on(DescribeInstancesCommand).rejects(Object.assign(new Error("UnauthorizedOperation"), { name: "UnauthorizedOperation" }));
    expect((await ec2.observe!(mkDriverContext(), boxNode)).presence).toBe("inaccessible");
    ec2Mock.on(DescribeInstancesCommand).rejects(Object.assign(new Error("gone"), { name: "InvalidInstanceID.NotFound" }));
    expect((await ec2.observe!(mkDriverContext(), boxNode, INSTANCE_ID)).presence).toBe("missing");
    ec2Mock.on(DescribeInstancesCommand).rejects(Object.assign(new Error("RequestLimitExceeded"), { name: "RequestLimitExceeded" }));
    expect((await ec2.observe!(mkDriverContext(), boxNode)).presence).toBe("unknown");
    expect((await ec2.observe!(mkDriverContext(), boxNode, "not-an-instance")).presence).toBe("unknown");
  });

  describe("runtime", () => {
    const status = (inst: string, sys = inst) => ({ InstanceStatuses: [{ InstanceId: INSTANCE_ID, InstanceStatus: { Status: inst as "ok" }, SystemStatus: { Status: sys as "ok" } }] });
    const ping = (p?: string) => ({ InstanceInformationList: p ? [{ InstanceId: INSTANCE_ID, PingStatus: p as "Online" }] : [] });

    it("healthy only when running, both status checks ok and the SSM agent is Online", async () => {
      installInstance();
      ec2Mock.on(DescribeInstanceStatusCommand).resolves(status("ok"));
      ssmMock.on(DescribeInstanceInformationCommand).resolves(ping("Online"));
      const r = await ec2.runtime!(mkDriverContext(), boxNode);
      expect(r).toMatchObject({ health: "healthy", signals: ["state:running", "instance_status:ok", "system_status:ok", "ssm:Online"] });
      expect(ssmMock.commandCalls(DescribeInstanceInformationCommand)[0].args[0].input).toEqual({ Filters: [{ Key: "InstanceIds", Values: [INSTANCE_ID] }] });
    });

    it("degraded when SSM is unreachable (the machine plane cannot operate it), unhealthy when a status check is impaired", async () => {
      installInstance();
      ec2Mock.on(DescribeInstanceStatusCommand).resolves(status("ok"));
      ssmMock.on(DescribeInstanceInformationCommand).resolves(ping("ConnectionLost"));
      expect(await ec2.runtime!(mkDriverContext(), boxNode)).toMatchObject({ health: "degraded", signals: expect.arrayContaining(["ssm:ConnectionLost"]) });
      ssmMock.on(DescribeInstanceInformationCommand).resolves(ping());
      expect((await ec2.runtime!(mkDriverContext(), boxNode)).signals).toContain("ssm:NotRegistered");
      ssmMock.on(DescribeInstanceInformationCommand).resolves(ping("Online"));
      ec2Mock.on(DescribeInstanceStatusCommand).resolves(status("impaired"));
      expect(await ec2.runtime!(mkDriverContext(), boxNode)).toMatchObject({ health: "unhealthy", signals: expect.arrayContaining(["instance_status:impaired"]) });
    });

    it("stopped is unhealthy and pending is degraded, without asking for status checks", async () => {
      installInstance({ State: { Name: "stopped" } });
      expect(await ec2.runtime!(mkDriverContext(), boxNode)).toMatchObject({ health: "unhealthy", signals: ["state:stopped"] });
      ec2Mock.on(DescribeInstancesCommand).resolves({ Reservations: [{ Instances: [instance({ State: { Name: "pending" } })] }] });
      expect((await ec2.runtime!(mkDriverContext(), boxNode)).health).toBe("degraded");
      expect(ec2Mock.commandCalls(DescribeInstanceStatusCommand)).toHaveLength(0);
    });

    it("keeps the state verdict when status or SSM reads are denied, and says so", async () => {
      installInstance();
      ec2Mock.on(DescribeInstanceStatusCommand).rejects(Object.assign(new Error("denied"), { name: "UnauthorizedOperation" }));
      ssmMock.on(DescribeInstanceInformationCommand).rejects(Object.assign(new Error("denied"), { name: "AccessDeniedException" }));
      const r = await ec2.runtime!(mkDriverContext(), boxNode);
      expect(r.signals).toEqual(["state:running", "status_checks_unreadable", "ssm_unreadable"]);
      expect(r.health).toBe("healthy");
    });

    it("missing instance: unhealthy with instance_missing", async () => {
      ec2Mock.on(DescribeInstancesCommand).resolves({ Reservations: [] });
      expect(await ec2.runtime!(mkDriverContext(), boxNode)).toMatchObject({ health: "unhealthy", signals: ["instance_missing"] });
    });
  });

  it("verify fails the ssm_online check for a running instance the machine plane cannot reach", async () => {
    installInstance();
    const obs = await ec2.observe!(mkDriverContext(), boxNode);
    const rt = { address: boxNode.address, health: "degraded" as const, counts: {}, signals: ["state:running", "ssm:ConnectionLost"], observedAt: "", source: "x", simulated: false };
    const v = await ec2.verify!(mkDriverContext(), boxNode, obs, rt);
    expect(v.status).toBe("failed");
    expect(v.checks.find((c) => c.id === "ssm_online")).toMatchObject({ passed: false });
    const ok = await ec2.verify!(mkDriverContext(), boxNode, obs, { ...rt, health: "healthy", signals: ["state:running", "ssm:Online"] });
    expect(ok.status).toBe("passed");
  });

  it("discovers live instances and marks Zenith-created ones", async () => {
    ec2Mock.on(DescribeInstancesCommand).resolves({ Reservations: [{ Instances: [instance(), instance({ InstanceId: "i-0legacy000000001", Tags: [{ Key: "Name", Value: "old" }] })] }] });
    const found = await ec2.discover!(mkDriverContext());
    expect(found.map((f) => [f.externalId, f.zenithTagged, f.name])).toEqual([[INSTANCE_ID, true, INSTANCE_ID], ["i-0legacy000000001", false, "old"]]);
    expect(found[0]).toMatchObject({ kind: "compute_instance", nativeType: "aws:ec2_instance", attributes: { instanceType: "t3.micro", state: "running" } });
  });
});
