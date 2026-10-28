/**
 * `aws:lambda_function` — EXPERIMENTAL. Kind `function`.
 *
 * V2 functions[] expands into runnable function nodes with immutable artifact
 * and source digests. The shared FunctionSpec is also enforced on hand-built graphs. It is a
 * minimal, honest version: a zip from S3, its own execution role and log
 * group, nothing else. Evidence for every operation is `contract`, and the
 * driver marks itself experimental with `capabilities.experimental`.
 *
 * Compile: `aws_lambda_function` (Zip package from an S3 object), its own
 * role (trust lambda.amazonaws.com, `ZenithAppBoundary`, permission to
 * write streams of ITS log group only), its log group `/aws/lambda/<name>`
 * (30 days). No VPC, no layers, no public URL. Environment values are plain:
 * Lambda has no `valueFrom`, so a `secretRef` is a compile error (read the
 * secret at runtime with the SDK instead). IAM grants from an `identity` node
 * are not wired into function roles yet.
 *
 * Operation `function.invoke`: synchronous Invoke with a bounded payload
 * (≤ 64 KiB) and a bounded, redacted response (≤ 16 KiB, secret-looking keys
 * replaced). Invoking runs the customer's code, so the operation first
 * checks the function carries THIS node's Zenith tags. Invoke has no
 * idempotency token: after a successful call the operation id is recorded on
 * the function (`zenith:operation`), and a retry of the same operation then
 * reports `alreadyInvoked` instead of invoking again; a crash between the
 * invocation and that tag write can still invoke twice.
 */
import { GetFunctionCommand, GetFunctionConfigurationCommand, InvokeCommand, LambdaClient, ListFunctionsCommand, ListTagsCommand, TagResourceCommand, type FunctionConfiguration } from "@aws-sdk/client-lambda";
import type { AwsSession } from "@/lib/credentials/types";
import type { CompileContext, DiscoveredResource, NativeOperation, ResourceDriver } from "@/lib/drivers/types";
import type { HealthState, Observation, ResourceNode, RuntimeState } from "@/lib/resources/types";
import { attributesOf, boundNative, cloudName, failedObservation, hasZenithManagedTag, nodeName, paginate, parseArn, runtimeState, standardVerification, tfLabel } from "@/lib/providers/aws/drivers/shared";
import { compileNode, intField, specOf } from "./support/driver-util";
import { ComputeCompileError, Frag, arnOf, assumeRoleJson, attr, boundaryArn, environmentData, policyJson, tagsFor } from "./support/tf";
import { OperationRefused, assertNodeTags, failureOf, findByTags, type AwsCtx } from "./support/sdk";
import type { FunctionSpec } from "./types";
import { DRIVER_IDS } from "./types";

const ID = DRIVER_IDS.lambdaFunction;
const RUNTIME = /^[a-z][a-z0-9.]{1,30}$/;
const HANDLER = /^[A-Za-z0-9._/:-]{1,128}$/;
const BUCKET = /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/;
const KEY = /^[A-Za-z0-9!_.*'()/=+@:-]{1,900}$/;
const ENV_KEY = /^[A-Za-z][A-Za-z0-9_]{0,254}$/;

export const MAX_PAYLOAD_BYTES = 64 * 1024;
export const MAX_RESPONSE_BYTES = 16 * 1024;

/* --------------------------------- compile -------------------------------- */

function normalized(node: ResourceNode) {
  const spec = specOf<FunctionSpec>(node);
  if (!RUNTIME.test(spec.runtime ?? "")) throw new ComputeCompileError("invalid_spec", "runtime must be a Lambda runtime identifier such as nodejs22.x.");
  if (!HANDLER.test(spec.handler ?? "")) throw new ComputeCompileError("invalid_spec", "handler is not valid.");
  const a = spec.artifact;
  if (!a || a.type !== "s3" || !BUCKET.test(a.bucket ?? "") || !KEY.test(a.key ?? "") || a.key.includes("..")) throw new ComputeCompileError("invalid_spec", "artifact must be an S3 object { type: 's3', bucket, key }.");
  if (!a.version || a.version === "null" || !/^[A-Za-z0-9._-]{1,1024}$/.test(a.version)) throw new ComputeCompileError("invalid_spec", "artifact.version must pin an immutable S3 object version.");
  if (!/^[a-f0-9]{64}$/.test(a.sha256 ?? "") || !/^[a-f0-9]{64}$/.test(a.sourceDigest ?? "")) throw new ComputeCompileError("invalid_spec", "artifact requires package sha256 and bound sourceDigest.");
  const variables: Record<string, string> = {};
  for (const e of spec.env ?? []) {
    if (!("value" in e)) throw new ComputeCompileError("unsupported", `environment variable ${e.key} is a secret reference; Lambda cannot inject secrets — read it at runtime with the SDK.`);
    if (!ENV_KEY.test(e.key) || typeof e.value !== "string" || e.value.length > 4096) throw new ComputeCompileError("invalid_spec", `environment variable ${String(e.key).slice(0, 40)} is not valid.`);
    if (e.key in variables) throw new ComputeCompileError("invalid_spec", `environment variable ${e.key} is declared twice.`);
    variables[e.key] = e.value;
  }
  const architecture = spec.architecture ?? "x86_64";
  if (architecture !== "x86_64" && architecture !== "arm64") throw new ComputeCompileError("invalid_spec", "architecture must be x86_64 or arm64.");
  return {
    spec,
    variables,
    memoryMb: intField(node, spec.memoryMb, "memoryMb", 256, 128, 10240),
    timeoutSec: intField(node, spec.timeoutSec, "timeoutSec", 30, 1, 900),
    architecture,
  };
}

const compile = (node: ResourceNode, ctx: CompileContext) =>
  compileNode(node, () => {
    const { spec, variables, memoryMb, timeoutSec, architecture } = normalized(node);
    const label = tfLabel(node.address);
    const name = nodeName(node.address);
    const b = new Frag(node.address);
    const env = environmentData(b, label, ctx.region);
    const fname = cloudName(ctx.namePrefix, name, 64);
    const logs = b.resource("aws_cloudwatch_log_group", `${label}_logs`, { name: `/aws/lambda/${fname}`, retention_in_days: 30, tags: tagsFor(ctx, node) });
    const roleName = `${cloudName(ctx.namePrefix, name, 64 - "-fn".length)}-fn`;
    const role = b.resource("aws_iam_role", label, {
      name: roleName,
      assume_role_policy: assumeRoleJson("lambda.amazonaws.com", ctx),
      permissions_boundary: boundaryArn(env, "app", ctx),
      tags: tagsFor(ctx, node, roleName),
    });
    const policy = b.resource("aws_iam_role_policy", label, {
      name: "logs",
      role: attr(role, "name"),
      policy: policyJson(
        [{ Sid: "WriteOwnLogs", Effect: "Allow", Action: ["logs:CreateLogStream", "logs:PutLogEvents"], Resource: [arnOf(env, "logs", ["log-group:", attr(logs, "name"), ":log-stream:*"])], wildcard: "log_stream" }],
        `${node.address} function role`
      ),
    });
    const fn = b.resource("aws_lambda_function", label, {
      function_name: fname,
      role: attr(role, "arn"),
      package_type: "Zip",
      runtime: spec.runtime,
      handler: spec.handler,
      memory_size: memoryMb,
      timeout: timeoutSec,
      architectures: [architecture],
      s3_bucket: spec.artifact.bucket,
      s3_key: spec.artifact.key,
      ...(spec.artifact.version ? { s3_object_version: spec.artifact.version } : {}),
      source_code_hash: Buffer.from(spec.artifact.sha256, "hex").toString("base64"),
      publish: true,
      ...(Object.keys(variables).length ? { environment: [{ variables }] } : {}),
      logging_config: [{ log_format: "Text", log_group: attr(logs, "name") }],
      tags: tagsFor(ctx, node, fname),
      depends_on: [policy.expr],
    });
    b.expose("arn", attr(fn, "arn"));
    b.expose("name", attr(fn, "function_name"));
    b.expose("qualified_arn", attr(fn, "qualified_arn"));
    b.expose("version", attr(fn, "version"));
    return b.build(fn);
  });

/* --------------------------------- expected ------------------------------- */

function expected(node: ResourceNode): Record<string, unknown> {
  const n = normalized(node);
  return { runtime: n.spec.runtime, handler: n.spec.handler, memoryMb: n.memoryMb, timeoutSec: n.timeoutSec, architecture: n.architecture, codeSha256: Buffer.from(n.spec.artifact.sha256, "hex").toString("base64") };
}

/* --------------------------------- observe -------------------------------- */

async function locate(ctx: AwsCtx, node: ResourceNode, externalId?: string): Promise<{ arn?: string; failure?: { kind: "missing" | "error"; code: string; summary: string } }> {
  if (externalId) {
    const a = parseArn(externalId);
    return a?.service === "lambda" && a.resource.startsWith("function:") ? { arn: externalId } : { failure: { kind: "error", code: "InvalidExternalId", summary: "externalId is not a Lambda function ARN." } };
  }
  const found = await findByTags(ctx, node, "lambda:function");
  if (found.length > 1) return { failure: { kind: "error", code: "Ambiguous", summary: `${found.length} functions carry the tags of ${node.address}.` } };
  if (found.length === 0) return { failure: { kind: "missing", code: "NotFoundByTags", summary: "No Lambda function carries this node's Zenith tags (the tag index is eventually consistent)." } };
  return { arn: found[0].arn };
}

const observe: NonNullable<ResourceDriver<AwsSession>["observe"]> = async (ctx, node, externalId): Promise<Observation> => {
  const names = Object.keys(expected(node));
  let located: Awaited<ReturnType<typeof locate>>;
  try {
    located = await locate(ctx, node, externalId);
  } catch (e) {
    return failedObservation(ctx, node, ID, names, failureOf(ctx, e), externalId);
  }
  if (!located.arn) return failedObservation(ctx, node, ID, names, located.failure!, externalId);
  const lambda = ctx.session.client(LambdaClient);
  let cfg: FunctionConfiguration | undefined;
  let tags: Record<string, string> | undefined;
  try {
    // Observe reads stay within the observe role (lambda:GetFunctionConfiguration + lambda:ListTags), not GetFunction.
    const [config, tagged] = await Promise.all([
      lambda.send(new GetFunctionConfigurationCommand({ FunctionName: located.arn }), { abortSignal: ctx.signal }),
      lambda.send(new ListTagsCommand({ Resource: located.arn }), { abortSignal: ctx.signal }),
    ]);
    cfg = config;
    tags = tagged.Tags;
  } catch (e) {
    return failedObservation(ctx, node, ID, names, failureOf(ctx, e), located.arn);
  }
  if (!cfg) return failedObservation(ctx, node, ID, names, { kind: "missing", code: "FunctionNotFound", summary: "GetFunctionConfiguration returned no configuration." }, located.arn);
  const attributes = attributesOf(ctx, names, {
    ...(cfg.CodeSha256 ? { codeSha256: cfg.CodeSha256 } : {}),
    ...(cfg.Runtime ? { runtime: cfg.Runtime } : {}),
    ...(cfg.Handler ? { handler: cfg.Handler } : {}),
    ...(cfg.MemorySize !== undefined ? { memoryMb: cfg.MemorySize } : {}),
    ...(cfg.Timeout !== undefined ? { timeoutSec: cfg.Timeout } : {}),
    ...(cfg.Architectures?.[0] ? { architecture: cfg.Architectures[0] } : {}),
  });
  return {
    address: node.address,
    externalId: cfg.FunctionArn ?? located.arn,
    presence: "present",
    attributes,
    native: boundNative({ functionName: cfg.FunctionName, role: cfg.Role, state: cfg.State, lastUpdateStatus: cfg.LastUpdateStatus, codeSha256: cfg.CodeSha256, ...(cfg.LoggingConfig?.LogGroup ? { logGroupName: cfg.LoggingConfig.LogGroup } : {}), tags: tags ?? {} }, { priority: ["functionName", "state", "tags"] }),
    observedAt: ctx.now().toISOString(),
    source: ID,
    simulated: false,
  };
};

const runtime: NonNullable<ResourceDriver<AwsSession>["runtime"]> = async (ctx, node, externalId): Promise<RuntimeState> => {
  let located: Awaited<ReturnType<typeof locate>>;
  try {
    located = await locate(ctx, node, externalId);
  } catch (e) {
    return runtimeState(ctx, node, ID, "unknown", {}, [`read_failed:${failureOf(ctx, e).code}`]);
  }
  if (!located.arn) return runtimeState(ctx, node, ID, located.failure?.kind === "missing" ? "unhealthy" : "unknown", {}, [located.failure?.kind === "missing" ? "function_missing" : `read_failed:${located.failure?.code}`]);
  try {
    const c = await ctx.session.client(LambdaClient).send(new GetFunctionConfigurationCommand({ FunctionName: located.arn }), { abortSignal: ctx.signal });
    const signals: string[] = [];
    if (c?.State) signals.push(`state:${c.State}`);
    if (c?.LastUpdateStatus && c.LastUpdateStatus !== "Successful") signals.push(`last_update:${c.LastUpdateStatus}`);
    if (c?.StateReasonCode && c.State !== "Active") signals.push(`state_reason:${c.StateReasonCode}`);
    const health: HealthState = c?.State === "Active" && (c.LastUpdateStatus === undefined || c.LastUpdateStatus === "Successful") ? "healthy" : c?.State === "Failed" || c?.LastUpdateStatus === "Failed" ? "unhealthy" : c?.State ? "degraded" : "unknown";
    return runtimeState(ctx, node, ID, health, {}, signals);
  } catch (e) {
    const f = failureOf(ctx, e);
    return runtimeState(ctx, node, ID, f.kind === "missing" ? "unhealthy" : "unknown", {}, [f.kind === "missing" ? "function_missing" : f.kind === "inaccessible" ? "access_denied" : `read_failed:${f.code}`]);
  }
};

const discover: NonNullable<ResourceDriver<AwsSession>["discover"]> = async (ctx): Promise<DiscoveredResource[]> => {
  const lambda = ctx.session.client(LambdaClient);
  const { items } = await paginate<FunctionConfiguration>(
    async (token) => {
      const res = await lambda.send(new ListFunctionsCommand({ MaxItems: 50, ...(token ? { Marker: token } : {}) }), { abortSignal: ctx.signal });
      return { items: res.Functions ?? [], next: res.NextMarker };
    },
    { maxPages: 3, signal: ctx.signal }
  );
  const out: DiscoveredResource[] = [];
  for (const f of items.slice(0, 50)) {
    if (!f.FunctionArn || !f.FunctionName) continue;
    let tags: Record<string, string> = {};
    try {
      tags = (await lambda.send(new ListTagsCommand({ Resource: f.FunctionArn }), { abortSignal: ctx.signal })).Tags ?? {};
    } catch (e) {
      failureOf(ctx, e);
    }
    out.push({
      provider: "aws",
      kind: "function",
      nativeType: "aws:lambda_function",
      externalId: f.FunctionArn,
      name: f.FunctionName,
      region: ctx.region,
      zenithTagged: hasZenithManagedTag(tags),
      attributes: { runtime: f.Runtime ?? "unknown", memoryMb: f.MemorySize ?? 0, timeoutSec: f.Timeout ?? 0 },
    });
  }
  return out.sort((a, b) => (a.externalId < b.externalId ? -1 : 1));
};

/* ---------------------------------- invoke --------------------------------- */

const SECRET_KEY = /(pass(word)?|secret|token|api[_-]?key|authorization|credential|private[_-]?key)/i;

function redactDeep(value: unknown, depth = 0): unknown {
  if (depth > 6) return "[depth-limit]";
  if (Array.isArray(value)) return value.slice(0, 100).map((v) => redactDeep(v, depth + 1));
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, SECRET_KEY.test(k) ? "[redacted]" : redactDeep(v, depth + 1)]));
  }
  if (typeof value === "string") return value.replace(/\b(AKIA|ASIA)[0-9A-Z]{16}\b/g, "[redacted-key-id]");
  return value;
}

/** A function's response, redacted and cut to `MAX_RESPONSE_BYTES`. */
export function boundResponse(bytes: Uint8Array | undefined): { response?: string; truncated: boolean; bytes: number } {
  if (!bytes || bytes.length === 0) return { truncated: false, bytes: 0 };
  const text = Buffer.from(bytes).toString("utf8");
  let shown: string;
  try {
    shown = JSON.stringify(redactDeep(JSON.parse(text)));
  } catch {
    shown = text.replace(/\b(AKIA|ASIA)[0-9A-Z]{16}\b/g, "[redacted-key-id]");
  }
  const cut = Buffer.byteLength(shown) > MAX_RESPONSE_BYTES;
  return { response: cut ? Buffer.from(shown).subarray(0, MAX_RESPONSE_BYTES).toString("utf8") : shown, truncated: cut, bytes: bytes.length };
}

export const invokeFunction: NativeOperation<AwsSession> = async (ctx, node, input) => {
  try {
    const dryRun = input.dryRun === true;
    const payloadText = input.payload === undefined ? "{}" : JSON.stringify(input.payload);
    if (payloadText === undefined) throw new OperationRefused("payload is not JSON-serializable.");
    const payload = Buffer.from(payloadText, "utf8");
    if (payload.length > MAX_PAYLOAD_BYTES) throw new OperationRefused(`payload is ${payload.length} bytes; the limit is ${MAX_PAYLOAD_BYTES}.`);

    const located = await locate(ctx, node, typeof input.externalId === "string" ? input.externalId : undefined);
    if (!located.arn) throw new OperationRefused(`cannot find the function of ${node.address}: ${located.failure?.summary ?? "unknown"}`);
    const lambda = ctx.session.client(LambdaClient);
    const requestedVersion = input.version ?? /:([1-9][0-9]*)$/.exec(located.arn)?.[1];
    if (requestedVersion !== undefined && (typeof requestedVersion !== "string" || !/^[1-9][0-9]*$/.test(requestedVersion))) throw new OperationRefused("Invoke requires an exact published numeric version, never an alias or $LATEST.");
    const fn = await lambda.send(new GetFunctionCommand({ FunctionName: located.arn, ...(requestedVersion ? { Qualifier: requestedVersion } : {}) }), { abortSignal: ctx.signal });
    const version = fn.Configuration?.Version;
    if (!version || !/^[1-9][0-9]*$/.test(version) || (requestedVersion && version !== requestedVersion)) throw new OperationRefused("Invoke requires a published version ARN or input.version; mutable $LATEST and aliases are refused.");
    const tags = fn.Tags ?? {};
    assertNodeTags(ctx, node, tags, "the Lambda function");
    const reviewed = normalized(node);
    if (fn.Configuration?.CodeSha256 !== Buffer.from(reviewed.spec.artifact.sha256, "hex").toString("base64")) throw new OperationRefused("Lambda code digest differs from the reviewed artifact; invocation refused.");
    if (ctx.operationId && !dryRun && tags["zenith:operation"] === ctx.operationId) {
      return { ok: true, summary: `${node.address} was already invoked for this operation; not invoking again (the earlier response was not retained).`, data: { alreadyInvoked: true }, simulated: false };
    }
    const res = await lambda.send(new InvokeCommand({ FunctionName: located.arn, Qualifier: version, InvocationType: dryRun ? "DryRun" : "RequestResponse", LogType: "None", Payload: payload }), { abortSignal: ctx.signal });
    const failed = Boolean(res.FunctionError) || (res.StatusCode ?? 500) >= 300 || (!dryRun && res.ExecutedVersion !== version);
    const bounded = boundResponse(res.Payload);
    if (!dryRun && ctx.operationId) {
      try {
        await lambda.send(new TagResourceCommand({ Resource: located.arn.replace(/:([1-9][0-9]*)$/, ""), Tags: { "zenith:operation": ctx.operationId } }), { abortSignal: ctx.signal });
      } catch (e) {
        failureOf(ctx, e);
        ctx.log("function.invoke: could not record the operation marker; a retry may invoke again.", "warn");
      }
    }
    return {
      ok: !failed,
      summary: failed ? `${node.address} ${res.FunctionError ? `returned ${res.FunctionError}` : `answered HTTP ${res.StatusCode}`}.` : `Invoked ${node.address}${dryRun ? " (dry run)" : ""}.`,
      data: { statusCode: res.StatusCode, ...(res.FunctionError ? { functionError: res.FunctionError } : {}), ...(res.ExecutedVersion ? { executedVersion: res.ExecutedVersion } : {}), dryRun, responseBytes: bounded.bytes, ...(bounded.response !== undefined ? { response: bounded.response } : {}), truncated: bounded.truncated },
      ...(res.$metadata?.requestId ? { requestIds: [res.$metadata?.requestId] } : {}),
      simulated: false,
    };
  } catch (e) {
    if (e instanceof OperationRefused) return { ok: false, summary: e.message, data: { refused: true }, simulated: false };
    const f = failureOf(ctx, e);
    return { ok: false, summary: `${f.code}: ${f.summary}`, data: { failure: f.kind, code: f.code }, ...(f.requestId ? { requestIds: [f.requestId] } : {}), simulated: false };
  }
};

export const lambdaFunctionDriver: ResourceDriver<AwsSession> = {
  id: ID,
  provider: "aws",
  kind: "function",
  nativeType: "aws:lambda_function",
  capabilities: {
    experimental: true,
    compile: true,
    observe: true,
    runtime: true,
    verify: true,
    discover: true,
    operations: ["function.invoke"],
    evidence: { compile: "contract", observe: "contract", runtime: "contract", verify: "contract", discover: "contract", "function.invoke": "contract" },
  },
  compile,
  observe,
  runtime,
  discover,
  expectedAttributes: expected,
  verify: async (ctx, node, observation, rt) => {
    const base = standardVerification(ctx, node, observation, expected(node), "The Lambda function");
    if (observation.presence !== "present") return base;
    const state = rt ?? (await runtime(ctx, node, observation.externalId));
    const checks = [...base.checks, { id: "active", description: "The function is Active and its last update succeeded", passed: state.health === "unknown" ? ("unknown" as const) : state.health === "healthy", ...(state.health === "healthy" ? {} : { detail: `signals: ${state.signals.join(", ") || "none"}` }) }];
    return { ...base, checks, status: checks.some((c) => c.passed === false) ? "failed" : checks.some((c) => c.passed === "unknown") ? "unknown" : "passed" };
  },
  operations: { "function.invoke": invokeFunction },
};
