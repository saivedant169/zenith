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
 * Seams: `product` (browser driver), `sleep` and the bounds for propagation and child polling. Tests inject all of them.
 */
import { createHash } from "node:crypto";
import { crc32 } from "node:zlib";
import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import type { EnvLike } from "../../config";
import type { Call, Json, Plan, ProductScenarioPort } from "../contracts";
import { MIX03_ROLE_NAMES } from "../plan";

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
  /** Releases the browser. Called once the run is over, after teardown. */
  close?(): Promise<void>;
}

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
}

/** The product's error sentence with ARNs, key=value pairs, URLs, paths and long tokens elided (as scripts/release/drivers/operated.ts). */
export function sanitizedError(raw: unknown): string | undefined {
  if (typeof raw !== "string" || !raw.trim()) return undefined;
  // The product's own fixed cause code ("; cause <class>/<code>") is kept verbatim; only its exact safe shape passes.
  const cause = /; cause ([A-Za-z0-9_.:-]{1,64}(?:\/[A-Za-z0-9_.:-]{1,64})?)\)/.exec(raw)?.[1];
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
const STATE_WORD = /^[a-z_]{1,40}$/, HALT_WORD = /^[a-z0-9_]{1,60}$/;
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

interface RunState { attempted: boolean; environmentIds: string[]; trust: { role: "observe" | "deploy"; original: string; write: Call }[] }

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

/** PROD-MIX-03 only. Every other requirement is reported not implemented. Never throws. */
export function mix03Port(env: EnvLike = process.env, seams: Mix03Seams = {}): ProductScenarioPort {
  const product = seams.product ?? unwiredProduct;
  const upload = seams.upload ?? s3Upload;
  const sleep = seams.sleep ?? ((ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)));
  const propagation = seams.propagation ?? { attempts: 12, intervalMs: 15_000 };
  const polls = seams.polls ?? { attempts: 120, intervalMs: 15_000 };
  const now = seams.now ?? Date.now;
  return {
    async verify(requirement, { plan, call }) {
      if (requirement.id !== "PROD-MIX-03") return { complete: false, reason: `${requirement.id}: not implemented by this port` };
      const run: RunState = { attempted: false, environmentIds: [], trust: [] };
      // The harness refuses every AWS call once the run window closes, teardown included: stop polling with room left for it.
      const pollDeadline = now() + plan.settings.durationMinutes * 60_000 - TEARDOWN_RESERVE_MS;
      const invoke: Invoke = (c, values = {}, extra = {}) => call(c, { ...fill(c.input, values), ...extra });
      const planned = (id: string): Call => plan.productCalls?.find(c => c.id === id) ?? refuse(`the plan has no call ${id}`);
      const account = plan.settings.accountId, region = plan.settings.region;
      // The connection stack's state bucket: zenith-state-<account>-<region><NameSuffix>, NameSuffix "-live" (deploy/aws/zenith-connection.cfn.yaml).
      // The sandbox connection stack is installed with NameSuffix "-live": its roles, boundaries and state bucket all carry it.
      const bootstrapNameSuffix = "-live";
      const stateBucket = `zenith-state-${account}-${region}${bootstrapNameSuffix}`;
      const principal = `arn:aws:iam::${account}:role/${MIX03_ROLE_NAMES.principal}`;
      const roleArns = { observe: `arn:aws:iam::${account}:role/${MIX03_ROLE_NAMES.observe}`, deploy: `arn:aws:iam::${account}:role/${MIX03_ROLE_NAMES.deploy}` };
      let step = "preconditions";
      let outcome: { complete: boolean; reason: string };
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
      } catch (error) {
        outcome = error instanceof Refusal
          ? { complete: false, reason: `PROD-MIX-03 not proven at ${step}: ${error.message}` }
          : { complete: false, reason: `PROD-MIX-03 not proven at ${step}: unexpected failure (details withheld; no completion claim)` };
      }
      // Trust is restored and product resources deleted even after a refusal. Leaks make the requirement fail closed.
      const leaks = await teardown(run, plan, invoke, planned, principal).catch(() => ["cleanup did not complete; resources may remain"]);
      try { await product.close?.(); } catch { /* the browser is released best-effort; the outcome above stands */ }
      if (leaks.length) return { complete: false, reason: `${outcome.reason}; cleanup leaks: ${leaks.length} (see the cleanup checks)`, leaks };
      return { ...outcome, leaks };
    },
  };
}
