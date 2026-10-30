/**
 * ProductScenarioPort for PROD-MIX-03 (typed outputs between two AWS children on one connection), live sandbox.
 *
 * Zenith does the product work through the paths a person uses: connection.createAws and connection.verifyAws, the mixed
 * parent plan with explicit pins and one declared reference, the approvals, child starts, the producer change and the
 * one-use preauthorization. The browser work is `Mix03Product`. This port only (a) changes the sandbox trust for the run's
 * ExternalId through planned IAM calls, restoring it afterwards, and (b) reads the result back from AWS and checks it.
 * Product receipts and AWS readbacks decide; child output is never evidence.
 *
 * The driver is `browserMix03Product` (mix-03-driver.ts), which aws-live.ts wires when ZENITH_LIVE_PRODUCT=1. Callers that pass no
 * driver get `unwiredProduct`, which refuses before its first AWS call, so nothing is changed.
 * Cleanup is planned and runs in `finally`: it deletes only tagged resources that match exact name patterns, then re-lists
 * by tag. Anything left is returned as a leak, which the harness records as a failed check.
 *
 * The same run proves PROD-MIX-02 (parent and immutable child plans): the stored parent plan is read back after the proposal,
 * just before the execution worker is stopped (producer done, consumer waiting for its review) and at the end. The review is
 * approved while the worker is down, the worker is restarted and the parent resumes. Its digests, dependency order and stable
 * addresses must not change, every receipt must re-derive from its own fields, the producer's receipt must survive the restart
 * unchanged and AWS must still hold the same one producer bucket.
 *
 * Seams: `product` (browser driver), `worker`, `sleep` and the bounds for propagation and child polling. Tests inject all of them.
 */
import { createHash } from "node:crypto";
import { crc32 } from "node:zlib";
import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { receiptDigestOf } from "@/lib/execution/mixed/receipt";
import type { EnvLike } from "../../config";
import type { Call, Json, Plan, ProductScenarioPort } from "../contracts";
import { laneSuffix, liveRoleNames } from "../plan";

type Values = Record<string, string>;
type Response = Record<string, unknown>;
type Invoke = (call: Call, values?: Values, extra?: Record<string, Json>) => Promise<Response>;

/** Opaque, non-secret product identifiers. The approver is an automated test approver created by CI (decision D1). */
export interface Mix03Tenant { workspaceId: string; approverId: string }
export interface Mix03Child { role: "producer" | "consumer"; status: string; childOperationId?: string; receiptOperationId?: string; awaitingOperationId?: string; operationStatus?: string; halt?: string }
/** The consumer's Lambda package in S3: the object version and both immutable digests the function source must carry. */
export interface Mix03Artifact { bucket: string; key: string; versionId: string; sha256: string; sourceDigest: string }
export interface Mix03Product {
  createTenant(): Promise<Mix03Tenant>;
  createAwsConnection(tenant: Mix03Tenant, input: { accountId: string; region: string; stateBucket: string; bootstrapNameSuffix: string; observeRoleArn: string; deployRoleArn: string }): Promise<{ connectionId: string; externalId: string }>;
  verifyAws(tenant: Mix03Tenant, connectionId: string): Promise<{ ok: boolean; reason: string }>;
  /**
   * Sets the producer and consumer manifests, creates the sandbox parent and the two AWS children, proposes the parent plan and
   * queues one deploy operation per child. Returns the child environments (producer first) and the parent operation to approve.
   */
  proposeMixed(tenant: Mix03Tenant, input: { connectionId: string; accountId: string; region: string; artifact: Mix03Artifact }): Promise<{ environmentIds: string[]; planId: string; parentOperationId: string }>;
  /** A person's approval, performed by the CI test approver through the browser path. */
  approve(tenant: Mix03Tenant, operationId: string): Promise<void>;
  /** Adopts every child operation and starts the parent through the browser-only routes. */
  startMixed(tenant: Mix03Tenant, planId: string, parentOperationId: string): Promise<{ started: true } | { started: false; reason: string }>;
  children(tenant: Mix03Tenant, planId: string): Promise<Mix03Child[]>;
  /** Changes the producer's output value and reports what the consumer now needs. */
  changeProducer(tenant: Mix03Tenant, planId: string): Promise<{ consumerState: "unchanged" | "review_required" | "preauthorized" }>;
  issueOutputPreauthorization(tenant: Mix03Tenant, planId: string): Promise<void>;
  useOutputOnce(tenant: Mix03Tenant, planId: string): Promise<{ ok: boolean }>;
  /** An operation's status and, when it stopped, a fixed category of why (never its text). */
  operationHalt?(tenant: Mix03Tenant, operationId: string): Promise<{ status: string; halt?: string }>;
  /** PROD-MIX-02: the stored parent plan, as GET /api/platform/v1/mixed/plans/:id returns it. */
  planReadback?(tenant: Mix03Tenant, planId: string): Promise<MixedReadback>;
  /** Releases the browser. Called once the run is over, after teardown. */
  close?(): Promise<void>;
}

/** A durable child receipt as read back (src/lib/execution/mixed/receipt.ts): digests, ids and fixed words, never outputs. */
export interface MixedReceipt {
  format: string; receiptId: string; workspaceId: string; parentPlanId: string; partitionId: string; ordinal: number; childOperationId: string;
  outcome: string; childStatus: string; executableSemanticsDigest?: string; planDigest?: string; outputsDigest?: string; receiptDigest: string; recordedAt: string;
}
export interface MixedChildReadback {
  partitionId: string; dependsOn: string[]; subplanDigest: string; semanticsDigest: string; effectDigest: string;
  nodes: { stableAddress: string; address: string; specDigest: string }[];
  state: string; childOperationId: string | null; executableSemanticsDigest: string | null; receipt: MixedReceipt | null;
}
export interface MixedReadback {
  status: string; parentOperationId: string | null; parentDigest: string; desiredDigest: string; childSetDigest: string; executionOrder: string[];
  children: MixedChildReadback[];
}
/** The stack's execution worker: stopped and started again so the parent workflow has to resume (PROD-MIX-02). */
export interface Mix02Worker { stop(): Promise<void>; start(): Promise<void> }

export interface Mix03Credentials { accessKeyId: string; secretAccessKey: string; sessionToken: string }
/** Puts one object with the deploy role session and returns its S3 version id. */
export type Mix03Upload = (input: { region: string; credentials: Mix03Credentials; bucket: string; key: string; body: Buffer }) => Promise<string | undefined>;
export interface Mix03Seams {
  product?: Mix03Product;
  upload?: Mix03Upload;
  sleep?: (ms: number) => Promise<void>;
  propagation?: { attempts: number; intervalMs: number };
  polls?: { attempts: number; intervalMs: number };
  now?: () => number;
  worker?: Mix02Worker;
  /** How long the worker stays down after the review is approved. */
  quietMs?: number;
}

/** The product's error sentence with ARNs, key=value pairs, URLs, paths and long tokens elided (as scripts/release/drivers/operated.ts). */
export function sanitizedError(raw: unknown): string | undefined {
  if (typeof raw !== "string" || !raw.trim()) return undefined;
  // The product's own fixed cause code ("; cause <class>/<code>") is kept verbatim; only its exact safe shape passes.
  // Up to three segments: class, code and the OpenTofu failure code (src/lib/execution/apply.ts).
  const cause = /; cause ([A-Za-z0-9_.:-]{1,64}(?:\/[A-Za-z0-9_.:-]{1,64}){0,2})\)/.exec(raw)?.[1];
  return elide(cause ? raw.replace(`; cause ${cause}`, "") : raw) + (cause ? ` [cause ${cause}]` : "");
}
function elide(raw: string): string {
  return raw.replace(/\barn:\S+/g, "…arn").replace(/\b\w+=\S+/g, "…=…").replace(/[a-z]+:\/\/\S+/gi, "…url").replace(/(?:\/[^\s/]+){2,}/g, "…path")
    .replace(/[A-Za-z0-9_+/=-]{24,}/g, "…").replace(/[\u0000-\u001f]/g, " ").slice(0, 240);
}
/** A fail-closed stop. Its message is ours and fixed; anything else is withheld. */
export class Refusal extends Error {}
export function refuse(message: string): never { throw new Refusal(message); }

const NOT_WIRED = "the browser product driver is not wired to a running Zenith stack in this build; nothing was changed";
const refuseUnwired = async (): Promise<never> => refuse(NOT_WIRED);
/** Default driver: every product step refuses, so no AWS call is made. */
export const unwiredProduct: Mix03Product = {
  createTenant: refuseUnwired, createAwsConnection: refuseUnwired, verifyAws: refuseUnwired, proposeMixed: refuseUnwired,
  approve: refuseUnwired, startMixed: refuseUnwired, children: refuseUnwired, changeProducer: refuseUnwired,
  issueOutputPreauthorization: refuseUnwired, useOutputOnce: refuseUnwired,
};

const EXTERNAL_ID_NEW = /^zenith-[0-9a-f]{32}$/;
const EXTERNAL_ID_TEMPLATE = /^[A-Za-z0-9+=,.@:/_-]{2,1224}$/;
const FIXED_TEXT = /^[A-Za-z0-9 ,.'()-]{1,200}$/;
/** Teardown makes about twenty planned calls; five minutes covers them and the tagging index re-list. */
export const TEARDOWN_RESERVE_MS = 5 * 60_000;
const STATE_WORD = /^[a-z_]{1,40}$/, HALT_WORD = /^[a-z0-9_]{1,80}$/;
/** "producer running/queued": the plan child's state and, when read, its operation's status. Fixed words only. */
const childState = (child: Mix03Child): string => {
  const word = (value: string | undefined) => (value && STATE_WORD.test(value) ? value : "unknown");
  return `${child.role} ${word(child.status)}${child.operationStatus ? `/${word(child.operationStatus)}` : ""}${child.halt ? `:${HALT_WORD.test(child.halt) ? child.halt : "unknown"}` : ""}`;
};

/** The sandbox trust document exactly as deploy/aws/zenith-connection.cfn.yaml renders it (AssumeRole mode, no OIDC). */
export function trustDocument(principalArn: string, externalId: string): string {
  return JSON.stringify({ Version: "2012-10-17", Statement: [
    { Sid: "ZenithAssumeRole", Effect: "Allow", Principal: { AWS: principalArn }, Action: "sts:AssumeRole", Condition: { StringEquals: { "sts:ExternalId": externalId }, StringLike: { "sts:RoleSessionName": "zenith-*" } } },
    { Sid: "ZenithTagSession", Effect: "Allow", Principal: { AWS: principalArn }, Action: "sts:TagSession" },
  ] });
}
const sorted = (value: unknown): unknown => Array.isArray(value) ? value.map(sorted)
  : value && typeof value === "object" ? Object.fromEntries(Object.keys(value).sort().map(key => [key, sorted((value as Record<string, unknown>)[key])])) : value;
const canonical = (value: unknown): string => JSON.stringify(sorted(value));
const field = (value: unknown, key: string): unknown => value && typeof value === "object" ? (value as Record<string, unknown>)[key] : undefined;

/** IAM returns the trust document URL-encoded; decode only that form. */
export function parsePolicy(raw: unknown): unknown {
  if (typeof raw !== "string" || raw.length > 8192) refuse("the sandbox role's trust document could not be read");
  try { return JSON.parse(raw.trimStart().startsWith("{") ? raw : decodeURIComponent(raw)) as unknown; }
  catch { return refuse("the sandbox role's trust document could not be read"); }
}

/** The current ExternalId, only if the document is exactly the template shape with that value; anything else refuses. */
export function templateExternalId(document: unknown, principalArn: string): string {
  const statement = field(document, "Statement");
  const externalId = Array.isArray(statement) ? field(field(field(statement[0], "Condition"), "StringEquals"), "sts:ExternalId") : undefined;
  if (typeof externalId !== "string" || !EXTERNAL_ID_TEMPLATE.test(externalId)) refuse("the sandbox trust document is not the expected template shape; nothing was changed");
  if (canonical(document) !== canonical(JSON.parse(trustDocument(principalArn, externalId)) as unknown)) refuse("the sandbox trust document is not the expected template shape; nothing was changed");
  return externalId;
}

/** Replaces `{ "$runtime": name }` markers in a planned template; a missing value refuses. */
export function fill(input: Record<string, Json>, values: Values): Record<string, Json> {
  const walk = (value: Json): Json => {
    if (Array.isArray(value)) return value.map(walk);
    if (value && typeof value === "object") {
      const entries = Object.entries(value);
      if (entries.length === 1 && entries[0]![0] === "$runtime") {
        const name = entries[0]![1];
        if (typeof name !== "string" || !Object.hasOwn(values, name)) refuse("a planned call has an unresolved runtime value");
        return values[name]!;
      }
      return Object.fromEntries(entries.map(([key, item]) => [key, walk(item)]));
    }
    return value;
  };
  return walk(input) as Record<string, Json>;
}

interface Mapping { arn: string; tags: Record<string, string> }
const tagMap = (list: unknown): Record<string, string> => Object.fromEntries((Array.isArray(list) ? list : []).flatMap(item => {
  const key = field(item, "Key"), value = field(item, "Value");
  return typeof key === "string" && typeof value === "string" ? [[key, value]] : [];
}));
/** Owned by this run: managed by Zenith and tagged with one of the run's child environments (the producer and the consumer). */
const owned = (tags: Record<string, string>, environmentIds: string[]): boolean => tags["zenith:managed"] === "true" && environmentIds.includes(tags["zenith:environment"] ?? "");
const errorName = (error: unknown): string => typeof field(error, "name") === "string" ? String(field(error, "name")) : "";
/** Exact shapes of the exported Lambda package inputs (S3 key, object version, sha256 and the source digest). */
const ARTIFACT_VERSION = /^[A-Za-z0-9._-]{1,1024}$/;

interface RunState { attempted: boolean; environmentIds: string[]; trust: { role: "observe" | "deploy"; original: string; write: Call }[]; functionState?: string }
const AWS_CODE = /^[A-Za-z]{1,40}$/;
/** The consumer function's lifecycle as Lambda reports it: fixed AWS enum values only, never StateReason text. */
const functionStateOf = (config: unknown): string | undefined => {
  const codes = ["State", "StateReasonCode", "LastUpdateStatus", "LastUpdateStatusReasonCode"].map(key => {
    const value = field(config, key);
    return typeof value === "string" && AWS_CODE.test(value) ? `${key}=${value}` : undefined;
  }).filter(Boolean);
  return codes.length ? codes.join(" ") : undefined;
};

function preconditions(env: EnvLike, plan: Plan): void {
  if (env.ZENITH_LIVE_PRODUCT !== "1") refuse("ZENITH_LIVE_PRODUCT=1 is not set; no product scenario ran");
  if (!env.AWS_ACCESS_KEY_ID || !env.AWS_SECRET_ACCESS_KEY || !env.AWS_SESSION_TOKEN) refuse("the AWS session must be in the process environment (OIDC path)");
  if (plan.settings.scenario !== "mix-03") refuse("the plan is not the mix-03 scenario");
  if (!plan.productCalls?.length) refuse("the plan has no PROD-MIX-03 product calls");
}

/** The consumer's handler: it only reports the producer bucket ARN it was given. */
const CONSUMER_SOURCE = "exports.handler = async () => ({ producerBucketArn: process.env.PRODUCER_BUCKET_ARN });\n";
/**
 * The consumer's Lambda package: index.js in a stored (uncompressed) zip with a fixed timestamp, so its sha256 is stable.
 * sourceDigest is the sha256 of the source file.
 */
export function consumerPackage(): { zip: Buffer; sha256: string; sourceDigest: string } {
  const name = Buffer.from("index.js"), data = Buffer.from(CONSUMER_SOURCE), crc = crc32(data);
  const dosTime = 0, dosDate = (1 << 5) | 1; // 1980-01-01 00:00
  const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(dosTime, 10); local.writeUInt16LE(dosDate, 12);
  local.writeUInt32LE(crc, 14); local.writeUInt32LE(data.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(name.length, 26);
  const central = Buffer.alloc(46); central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(0x0314, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(dosTime, 12); central.writeUInt16LE(dosDate, 14);
  central.writeUInt32LE(crc, 16); central.writeUInt32LE(data.length, 20); central.writeUInt32LE(data.length, 24); central.writeUInt16LE(name.length, 28); central.writeUInt32LE((0o100644 << 16) >>> 0, 38);
  const centralOffset = local.length + name.length + data.length, centralSize = central.length + name.length;
  const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(1, 8); end.writeUInt16LE(1, 10); end.writeUInt32LE(centralSize, 12); end.writeUInt32LE(centralOffset, 16);
  const zip = Buffer.concat([local, name, data, central, name, end]);
  const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");
  return { zip, sha256: sha(zip), sourceDigest: sha(data) };
}

const s3Upload: Mix03Upload = async ({ region, credentials, bucket, key, body }) =>
  (await new S3Client({ region, credentials }).send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: body, ContentType: "application/zip" }))).VersionId;

/** Only the children's own tagged resources, found through the tag API and matched against exact patterns, one tag value per child. */
async function inventoryOf(invoke: Invoke, call: Call, environmentIds: string[]): Promise<Mapping[]> {
  const out: Mapping[] = [];
  for (const environmentId of environmentIds) {
    let token: string | undefined;
    for (let page = 0; ; page++) {
      if (page === 8) refuse("the tag inventory did not finish within the page bound");
      const response = await invoke(call, { environmentId }, token ? { PaginationToken: token } : {});
      const list = Array.isArray(response.ResourceTagMappingList) ? response.ResourceTagMappingList : [];
      for (const item of list) {
        const arn = field(item, "ResourceARN");
        if (typeof arn === "string") out.push({ arn, tags: tagMap(field(item, "Tags")) });
      }
      token = typeof response.PaginationToken === "string" && response.PaginationToken ? response.PaginationToken : undefined;
      if (!token) break;
    }
  }
  return out;
}

async function teardown(run: RunState, plan: Plan, invoke: Invoke, planned: (id: string) => Call, principal: string): Promise<string[]> {
  const leaks: string[] = [];
  // `tolerated`: an error that means the resource is already absent, which is the goal of the delete.
  const attempt = async (what: string, action: () => Promise<unknown>, tolerated: string[] = []): Promise<boolean> => {
    try { await action(); return true; }
    catch (error) {
      if (tolerated.includes(errorName(error))) return true;
      leaks.push(`${what} failed; resources may remain`);
      return false;
    }
  };
  for (const trust of [...run.trust].reverse()) {
    await attempt(`restoring the ${trust.role} sandbox trust`, () => invoke(trust.write, { trustDocument: trustDocument(principal, trust.original) }));
  }
  if (!run.environmentIds.length) {
    if (run.attempted) leaks.push("product resources could not be discovered: no environment id was recorded");
    return leaks;
  }
  const envIds = run.environmentIds, account = plan.settings.accountId, region = plan.settings.region;
  const fnPattern = new RegExp(`^arn:aws:lambda:${region}:${account}:function:(zenith-[A-Za-z0-9_-]{1,64})$`);
  const bucketPattern = /^arn:aws:s3:::(zenith-[a-z0-9.-]{3,58})$/;
  const rolePattern = new RegExp(`^arn:aws:iam::${account}:role/(zenith-[A-Za-z0-9+=,.@_-]{1,63})$`);
  const policyPattern = new RegExp(`^arn:aws:iam::${account}:policy/zenith-[A-Za-z0-9+=,.@_-]{1,120}$`);
  const logGroupPattern = new RegExp(`^arn:aws:logs:${region}:${account}:log-group:(/aws/lambda/zenith-[A-Za-z0-9_-]{1,64})(?::\\*)?$`);
  // The Lambda driver names its role's one inline policy "logs" (src/lib/providers/aws/drivers/compute/lambda-function.ts).
  const inlinePolicyName = /^(?:logs|zenith-[A-Za-z0-9+=,.@_-]{1,120})$/;
  const scan = () => inventoryOf(invoke, planned("mix03-tag-read"), envIds);
  let mappings: Mapping[];
  try { mappings = await scan(); } catch { leaks.push("tag inventory failed; resources may remain"); return leaks; }
  const functions: { name: string; arn: string }[] = [], buckets: { name: string; arn: string }[] = [], logGroups = new Set<string>();
  for (const mapping of mappings) {
    const fn = fnPattern.exec(mapping.arn), bucket = bucketPattern.exec(mapping.arn), logGroup = logGroupPattern.exec(mapping.arn);
    if (fn && owned(mapping.tags, envIds)) functions.push({ name: fn[1]!, arn: mapping.arn });
    else if (bucket && owned(mapping.tags, envIds)) buckets.push({ name: bucket[1]!, arn: mapping.arn });
    else if (logGroup && owned(mapping.tags, envIds)) logGroups.add(logGroup[1]!);
    else leaks.push("a tagged resource outside the exact patterns or without the run's ownership tags was not deleted");
  }
  for (const fn of functions) {
    const config = await invoke(planned("mix03-lambda-read"), { functionName: fn.name }).catch(() => undefined);
    const roleArn = config ? field(config, "Role") : undefined;
    run.functionState ??= functionStateOf(config);
    const roleMatch = typeof roleArn === "string" ? rolePattern.exec(roleArn) : null;
    const deleted = await attempt("deleting the consumer function", () => invoke(planned("mix03-lambda-delete"), { functionName: fn.name }));
    await attempt("deleting the function log group", () => invoke(planned("mix03-logs-delete"), { logGroupName: `/aws/lambda/${fn.name}` }), ["ResourceNotFoundException"]);
    logGroups.delete(`/aws/lambda/${fn.name}`);
    if (!deleted || !roleMatch) { if (!roleMatch) leaks.push("the function's role does not match the exact pattern; role not deleted"); continue; }
    const roleName = roleMatch[1]!;
    const role = await invoke(planned("mix03-role-read"), { roleName }).catch(() => undefined);
    if (!role || !owned(tagMap(field(field(role, "Role"), "Tags")), envIds)) { leaks.push("the function's role lacks the run's ownership tags; role not deleted"); continue; }
    const attached = await invoke(planned("mix03-role-attached-list"), { roleName }).catch(() => undefined);
    const policies = Array.isArray(field(attached, "AttachedPolicies")) ? (field(attached, "AttachedPolicies") as unknown[]) : [];
    let roleReady = !!attached;
    for (const policy of policies) {
      const policyArn = field(policy, "PolicyArn");
      if (typeof policyArn !== "string" || !policyPattern.test(policyArn)) { roleReady = false; leaks.push("an attached policy outside the exact pattern; role not deleted"); break; }
      roleReady = await attempt("detaching a role policy", () => invoke(planned("mix03-role-detach"), { roleName, policyArn })) && roleReady;
    }
    const inline = await invoke(planned("mix03-role-inline-list"), { roleName }).catch(() => undefined);
    for (const name of (Array.isArray(field(inline, "PolicyNames")) ? (field(inline, "PolicyNames") as unknown[]) : [])) {
      if (typeof name !== "string" || !inlinePolicyName.test(name)) { roleReady = false; leaks.push("an inline role policy outside the exact pattern; role not deleted"); break; }
      roleReady = await attempt("deleting an inline role policy", () => invoke(planned("mix03-role-inline-delete"), { roleName, policyName: name })) && roleReady;
    }
    if (roleReady) await attempt("deleting the function role", () => invoke(planned("mix03-role-delete"), { roleName }));
  }
  // A log group whose function is already gone (or never came up) is deleted on its own.
  for (const logGroupName of logGroups) await attempt("deleting a function log group", () => invoke(planned("mix03-logs-delete"), { logGroupName }), ["ResourceNotFoundException"]);
  for (const bucket of buckets) await attempt("deleting the producer bucket", () => invoke(planned("mix03-bucket-delete"), { bucketName: bucket.name }), ["NoSuchBucket"]);
  try {
    const remaining = await scan();
    if (remaining.length) leaks.push(`${remaining.length} tagged resource(s) still present after cleanup`);
  } catch { leaks.push("cleanup re-list failed; resources may remain"); }
  return leaks;
}

/** What the approval bound: digests, dependency order and stable addresses. None of it may change once proposed. */
const pinned = (plan: MixedReadback) => canonical({
  parentDigest: plan.parentDigest, desiredDigest: plan.desiredDigest, childSetDigest: plan.childSetDigest, executionOrder: plan.executionOrder,
  children: plan.children.map(({ partitionId, dependsOn, subplanDigest, semanticsDigest, effectDigest, nodes }) => ({ partitionId, dependsOn, subplanDigest, semanticsDigest, effectDigest, nodes })),
});

/** The producer is the child nothing depends on; the consumer depends on exactly it and runs after it. */
export function mix02Order(plan: MixedReadback): { producer: MixedChildReadback; consumer: MixedChildReadback } {
  if (plan.children.length !== 2) refuse("the stored plan does not have exactly two children");
  const producer = plan.children.find(child => !child.dependsOn.length), consumer = plan.children.find(child => child.dependsOn.length);
  if (!producer || !consumer) refuse("the stored plan has no producer and consumer");
  if (consumer.dependsOn.join() !== producer.partitionId) refuse("the consumer does not depend on exactly the producer");
  if (plan.executionOrder.join() !== [producer.partitionId, consumer.partitionId].join()) refuse("the stored execution order does not run the producer first");
  if (!producer.nodes.length || !consumer.nodes.length) refuse("a child has no stable resource addresses");
  return { producer, consumer };
}

/** A succeeded child's receipt: it links the child operation and re-derives from its own fields (src/lib/execution/mixed/receipt.ts). */
function receiptOf(plan: MixedReadback, child: MixedChildReadback, role: string, planId: string): MixedReceipt {
  const receipt = child.receipt ?? refuse(`the ${role} has no durable receipt`);
  if (child.state !== "succeeded" || receipt.outcome !== "succeeded" || receipt.childStatus !== "succeeded") refuse(`the ${role} receipt does not record a success`);
  if (!child.childOperationId || receipt.childOperationId !== child.childOperationId || receipt.partitionId !== child.partitionId || receipt.parentPlanId !== planId) refuse(`the ${role} receipt does not link its child operation`);
  if (!child.executableSemanticsDigest || receipt.executableSemanticsDigest !== child.executableSemanticsDigest || !receipt.planDigest) refuse(`the ${role} receipt does not bind the semantics its child ran`);
  const { workspaceId, parentPlanId, partitionId, ordinal, childOperationId, outcome, childStatus, executableSemanticsDigest, planDigest, outputsDigest } = receipt;
  const derived = receiptDigestOf({ workspaceId, parentPlanId, partitionId, ordinal, childOperationId, outcome: outcome as "succeeded", childStatus,
    ...(executableSemanticsDigest ? { executableSemanticsDigest } : {}), ...(planDigest ? { planDigest } : {}), ...(outputsDigest ? { outputsDigest } : {}) });
  if (derived !== receipt.receiptDigest || receipt.receiptId !== `mrc_${derived.slice(0, 32)}`) refuse(`the ${role} receipt does not re-derive from its own fields`);
  if (plan.parentOperationId === null) refuse("the stored plan has no parent operation");
  return receipt;
}

/**
 * PROD-MIX-02 over three readbacks of one plan: after the proposal, just before the worker stopped and at the end. Returns the
 * evidence sentence; refuses at the first clause that does not hold.
 */
export function mix02Verdict(input: { planId: string; parentOperationId: string; proposed: MixedReadback; beforeStop: MixedReadback; final: MixedReadback; bucketBeforeStop: string; bucketFinal: string; downMs: number }): string {
  const { planId, parentOperationId, proposed, beforeStop, final } = input;
  const { producer, consumer } = mix02Order(proposed);
  for (const plan of [beforeStop, final]) if (pinned(plan) !== pinned(proposed)) refuse("the stored plan's digests, order or stable addresses changed after the proposal");
  if ([proposed, beforeStop, final].some(plan => plan.parentOperationId !== parentOperationId)) refuse("the stored plan is not bound to the approved parent operation");
  const at = (plan: MixedReadback, partitionId: string) => plan.children.find(child => child.partitionId === partitionId)!;
  const producerBefore = receiptOf(beforeStop, at(beforeStop, producer.partitionId), "producer", planId);
  if (at(beforeStop, consumer.partitionId).receipt) refuse("the consumer already had a receipt when the worker stopped");
  const producerFinal = receiptOf(final, at(final, producer.partitionId), "producer", planId);
  receiptOf(final, at(final, consumer.partitionId), "consumer", planId);
  if (canonical(producerFinal) !== canonical(producerBefore)) refuse("the producer receipt changed across the worker restart");
  if (input.bucketFinal !== input.bucketBeforeStop) refuse("the producer bucket is not the same resource after the resume");
  const addresses = proposed.children.reduce((n, child) => n + child.nodes.length, 0);
  return `PROD-MIX-02 proven on the live sandbox: the stored parent plan put the producer (S3 bucket) before the consumer (Lambda function) that depends on it, with one approved parent operation; its parent, desired and child-set digests, each child's subplan, semantics and effect digests and all ${addresses} stable resource addresses were identical after the proposal, before the execution worker was stopped and at the end; the worker was stopped with the producer done and the consumer waiting for its review, the review was approved while it was down (${Math.round(input.downMs / 1000)} s from stop to healthy) and the parent resumed after the restart; both durable receipts link their child operations, bind the semantics each child ran and re-derive from their own fields; the producer receipt was unchanged across the restart and AWS held the same one producer bucket before and after`;
}

/** PROD-MIX-03 and PROD-MIX-02 from one run. Every other requirement is reported not implemented. Never throws. */
export function mix03Port(env: EnvLike = process.env, seams: Mix03Seams = {}): ProductScenarioPort {
  const product = seams.product ?? unwiredProduct;
  const upload = seams.upload ?? s3Upload;
  const sleep = seams.sleep ?? ((ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)));
  const propagation = seams.propagation ?? { attempts: 12, intervalMs: 15_000 };
  const polls = seams.polls ?? { attempts: 120, intervalMs: 15_000 };
  const now = seams.now ?? Date.now;
  const quietMs = seams.quietMs ?? 10_000;
  type Result = Awaited<ReturnType<ProductScenarioPort["verify"]>>;
  // One run answers both requirements: the harness asks for PROD-MIX-02 first (ledger order), then PROD-MIX-03.
  let flow: Promise<Record<"PROD-MIX-03" | "PROD-MIX-02", Result>> | undefined;
  return {
    async verify(requirement, context) {
      if (requirement.id !== "PROD-MIX-03" && requirement.id !== "PROD-MIX-02") return { complete: false, reason: `${requirement.id}: not implemented by this port` };
      flow ??= runFlow(context);
      return (await flow)[requirement.id];
    },
  };

  async function runFlow({ plan, call }: Parameters<ProductScenarioPort["verify"]>[1]): Promise<Record<"PROD-MIX-03" | "PROD-MIX-02", Result>> {
      const run: RunState = { attempted: false, environmentIds: [], trust: [] };
      // The harness refuses every AWS call once the run window closes, teardown included: stop polling with room left for it.
      const pollDeadline = now() + plan.settings.durationMinutes * 60_000 - TEARDOWN_RESERVE_MS;
      const invoke: Invoke = (c, values = {}, extra = {}) => call(c, { ...fill(c.input, values), ...extra });
      const planned = (id: string): Call => plan.productCalls?.find(c => c.id === id) ?? refuse(`the plan has no call ${id}`);
      const account = plan.settings.accountId, region = plan.settings.region;
      // The lane's connection stack (NameSuffix "-live" or "-live2"): its roles, boundaries and state bucket all carry the suffix.
      const bootstrapNameSuffix = laneSuffix(plan.settings), names = liveRoleNames(bootstrapNameSuffix);
      const stateBucket = `zenith-state-${account}-${region}${bootstrapNameSuffix}`;
      const principal = `arn:aws:iam::${account}:role/${names.principal}`;
      const roleArns = { observe: `arn:aws:iam::${account}:role/${names.observe}`, deploy: `arn:aws:iam::${account}:role/${names.deploy}` };
      let step = "preconditions";
      let outcome: { complete: boolean; reason: string };
      let mix02: { complete: boolean; reason: string } | undefined;
      // After a worker restart: how long it was down and, if the run stops, why the parent stopped.
      let restart: { downMs: number; parent: () => Promise<string> } | undefined;
      try {
        preconditions(env, plan);
        step = "tenant";
        const tenant = await product.createTenant();
        step = "connection";
        const connection = await product.createAwsConnection(tenant, { accountId: account, region, stateBucket, bootstrapNameSuffix, observeRoleArn: roleArns.observe, deployRoleArn: roleArns.deploy });
        if (!EXTERNAL_ID_NEW.test(connection.externalId)) refuse("the generated ExternalId has an unexpected shape");
        step = "sandbox trust";
        for (const role of ["observe", "deploy"] as const) {
          const current = await invoke(planned(`mix03-iam-read-${role}`));
          const original = templateExternalId(parsePolicy(field(field(current, "Role"), "AssumeRolePolicyDocument")), principal);
          const write = planned(`mix03-iam-trust-${role}`);
          run.trust.push({ role, original, write });
          await invoke(write, { trustDocument: trustDocument(principal, connection.externalId) });
        }
        step = "connection verification";
        for (let attempt = 1; ; attempt++) {
          if ((await product.verifyAws(tenant, connection.connectionId)).ok) break;
          if (attempt >= propagation.attempts) refuse("connection.verifyAws did not pass after the trust update within the propagation bound");
          await sleep(propagation.intervalMs);
        }
        step = "consumer package";
        const assumed = field(await invoke(planned("mix03-sts-assume"), { externalId: connection.externalId }), "Credentials");
        const accessKeyId = field(assumed, "AccessKeyId"), secretAccessKey = field(assumed, "SecretAccessKey"), sessionToken = field(assumed, "SessionToken");
        if (typeof accessKeyId !== "string" || typeof secretAccessKey !== "string" || typeof sessionToken !== "string") refuse("the deploy role session could not be read");
        const pkg = consumerPackage(), key = `zenith-live/${plan.settings.runId}/consumer.zip`;
        const versionId = await upload({ region, credentials: { accessKeyId, secretAccessKey, sessionToken }, bucket: stateBucket, key, body: pkg.zip });
        if (!versionId || versionId === "null" || !ARTIFACT_VERSION.test(versionId)) refuse("the state bucket did not return an object version for the consumer's package");
        const artifact: Mix03Artifact = { bucket: stateBucket, key, versionId, sha256: pkg.sha256, sourceDigest: pkg.sourceDigest };
        step = "mixed plan";
        run.attempted = true;
        const proposal = await product.proposeMixed(tenant, { connectionId: connection.connectionId, accountId: account, region, artifact });
        if (proposal.environmentIds.length !== 2) refuse("the mixed proposal did not name exactly the producer and consumer environments");
        run.environmentIds = proposal.environmentIds;
        step = "stored plan";
        const readback = (): Promise<MixedReadback> => product.planReadback ? product.planReadback(tenant, proposal.planId) : refuse("the product driver cannot read the stored plan back");
        const proposed = await readback();
        mix02Order(proposed);
        const producerBucket = async (): Promise<string> => {
          const arns = (await inventoryOf(invoke, planned("mix03-tag-read"), run.environmentIds)).filter(m => /^arn:aws:s3:::zenith-/.test(m.arn) && owned(m.tags, run.environmentIds));
          if (arns.length !== 1) refuse("AWS does not hold exactly one tagged producer bucket");
          return arns[0]!.arn;
        };
        let beforeStop: { plan: MixedReadback; bucket: string } | undefined;
        step = "mixed plan";
        await product.approve(tenant, proposal.parentOperationId);
        const started = await product.startMixed(tenant, proposal.planId, proposal.parentOperationId);
        if (!started.started) refuse(`the mixed parent did not start: ${FIXED_TEXT.test(started.reason) ? started.reason : "reason withheld"}`);
        step = "child rounds";
        let producer: Mix03Child | undefined, consumer: Mix03Child | undefined;
        for (let poll = 1; ; poll++) {
          const children = await product.children(tenant, proposal.planId);
          producer = children.find(child => child.role === "producer");
          consumer = children.find(child => child.role === "consumer");
          if (!producer || !consumer) refuse("the plan does not have one producer and one consumer child");
          if (producer.status !== "succeeded" && (consumer.status === "running" || consumer.status === "succeeded")) refuse("the consumer started before the producer receipt");
          // A child that ended any other way than success will not succeed later: stop now and name how it ended.
          if ([producer, consumer].some(child => ["failed", "uncertain", "cancelled", "blocked"].includes(child.status))) refuse(`a child operation did not succeed (${[producer, consumer].map(childState).join(", ")})`);
          // PROD-MIX-02: the producer is done and the consumer waits for a person. Stop the worker, approve while it is down and
          // restart it, so the parent can only go on by resuming.
          if (!beforeStop && producer.status === "succeeded" && consumer.status !== "succeeded" && consumer.awaitingOperationId) {
            step = "worker stop";
            const worker = seams.worker ?? refuse("the stack's execution worker is not wired");
            beforeStop = { plan: await readback(), bucket: await producerBucket() };
            const stoppedAt = now();
            await worker.stop();
            await product.approve(tenant, consumer.awaitingOperationId);
            await sleep(quietMs);
            step = "worker restart";
            await worker.start();
            restart = { downMs: now() - stoppedAt, parent: async () => {
              const op = await product.operationHalt?.(tenant, proposal.parentOperationId).catch(() => undefined);
              return op ? `${STATE_WORD.test(op.status) ? op.status : "unknown"}${op.halt && HALT_WORD.test(op.halt) ? `:${op.halt}` : ""}` : "unread";
            } };
            step = "child rounds";
            continue;
          }
          for (const child of children) if (child.awaitingOperationId) await product.approve(tenant, child.awaitingOperationId);
          if (producer.status === "succeeded" && consumer.status === "succeeded") break;
          if (poll >= polls.attempts || now() >= pollDeadline) refuse(`the child operations did not finish within the bound (${[producer, consumer].map(childState).join(", ")})`);
          await sleep(polls.intervalMs);
        }
        step = "receipts";
        if (!producer!.childOperationId || producer!.receiptOperationId !== producer!.childOperationId) refuse("the producer receipt does not link its child operation");
        if (!consumer!.childOperationId || consumer!.receiptOperationId !== consumer!.childOperationId) refuse("the consumer receipt does not link its child operation");
        step = "AWS readback";
        const mappings = await inventoryOf(invoke, planned("mix03-tag-read"), run.environmentIds);
        const fnArns = mappings.filter(m => new RegExp(`^arn:aws:lambda:${region}:${account}:function:zenith-`).test(m.arn) && owned(m.tags, run.environmentIds));
        const bucketArns = mappings.filter(m => /^arn:aws:s3:::zenith-/.test(m.arn) && owned(m.tags, run.environmentIds));
        if (fnArns.length !== 1 || bucketArns.length !== 1) refuse("the run did not leave exactly one tagged consumer function and one tagged producer bucket");
        const functionName = fnArns[0]!.arn.split(":function:")[1]!, bucketName = bucketArns[0]!.arn.split(":::")[1]!;
        const fnConfig = await invoke(planned("mix03-lambda-read"), { functionName });
        const variables = field(field(fnConfig, "Environment"), "Variables");
        if (field(variables, "PRODUCER_BUCKET_ARN") !== `arn:aws:s3:::${bucketName}`) refuse("the consumer's deployed PRODUCER_BUCKET_ARN does not equal the producer bucket ARN");
        await invoke(planned("mix03-bucket-head"), { bucketName });
        const bucketTags = tagMap(field(await invoke(planned("mix03-bucket-tags"), { bucketName }), "TagSet"));
        if (!owned(bucketTags, run.environmentIds)) refuse("the producer bucket lacks the run's ownership tags");
        // Not provable through product routes: the producer-change review and the one-use preauthorization are decided by
        // consumeOutputs inside the parent workflow, which no route re-runs (tests/execution/mixed-orchestration*.test.ts cover them).
        outcome = {
          complete: false,
          reason: "PROD-MIX-03 partly proven: the trust change touched only the ExternalId of both sandbox roles and was restored; connection.verifyAws passed; the producer finished before the consumer started; both receipts link their child operations; the consumer's deployed PRODUCER_BUCKET_ARN equals the producer bucket ARN by independent readback. Approvals by an automated test approver through the browser path. Pending: the producer-change review and the one-use preauthorization refusal, which no product route can trigger.",
        };
        // Its own try: a PROD-MIX-02 refusal here leaves the PROD-MIX-03 result above as it is.
        step = "PROD-MIX-02 readback";
        try {
          if (!beforeStop) refuse("the consumer never waited for an approval, so the worker was never stopped");
          mix02 = { complete: true, reason: mix02Verdict({ planId: proposal.planId, parentOperationId: proposal.parentOperationId, proposed, beforeStop: beforeStop.plan, final: await readback(), bucketBeforeStop: beforeStop.bucket, bucketFinal: bucketArns[0]!.arn, downMs: restart?.downMs ?? 0 }) };
        } catch (error) {
          mix02 = { complete: false, reason: `PROD-MIX-02 not proven at ${step}: ${error instanceof Refusal ? error.message : "unexpected failure (details withheld; no completion claim)"}` };
        }
      } catch (error) {
        let why = error instanceof Refusal ? error.message : "unexpected failure (details withheld; no completion claim)";
        if (restart) why += `; the worker was down ${Math.round(restart.downMs / 1000)} s; parent operation ${await restart.parent()}`;
        outcome = { complete: false, reason: `PROD-MIX-03 not proven at ${step}: ${why}` };
        mix02 = { complete: false, reason: `PROD-MIX-02 not proven at ${step}: ${why}` };
      }
      // Trust is restored and product resources deleted even after a refusal. Leaks make the requirement fail closed.
      const leaks = await teardown(run, plan, invoke, planned, principal).catch(() => ["cleanup did not complete; resources may remain"]);
      try { await product.close?.(); } catch { /* the browser is released best-effort; the outcome above stands */ }
      // A consumer that did not succeed: what Lambda itself reported before teardown deleted it.
      if (!outcome.reason.includes("partly proven") && run.functionState) outcome = { ...outcome, reason: `${outcome.reason}; consumer function before teardown: ${run.functionState}` };
      const second = mix02 ?? { complete: false, reason: `PROD-MIX-02 not proven at ${step}` };
      // Leaks are reported once, on PROD-MIX-03, and fail both.
      if (leaks.length) return {
        "PROD-MIX-03": { complete: false, reason: `${outcome.reason}; cleanup leaks: ${leaks.length} (see the cleanup checks)`, leaks },
        "PROD-MIX-02": { complete: false, reason: `${second.reason}; cleanup leaks: ${leaks.length} (reported on PROD-MIX-03)` },
      };
      return { "PROD-MIX-03": { ...outcome, leaks }, "PROD-MIX-02": second };
  }
}
