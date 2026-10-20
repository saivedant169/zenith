/**
 * Runner HTTP proxies (`aws.http`, `oci.http`, `k8s.http`) in the effect ledger (PROD-DUR-07 / PROD-DUR-08).
 *
 * A proxied request is one signed job a customer runner executes against the provider. The job kinds do not say
 * whether a request mutates (read polls are POSTs for AWS RPC and OCI search). This module decides by an explicit
 * per-provider allowlist of READ actions, never by HTTP method alone; anything not on a list is mutating
 * (fail closed). Every mutating request is recorded in the ledger BEFORE it is enqueued, carries the provider's
 * client token or idempotency header wherever the API has one, and, if the reply is lost, becomes an uncertain
 * effect with a readback hint. Reads are never recorded.
 *
 * Only sessions whose capability mutates are guarded: read sessions (`authorizeRead`) have no operation row and
 * only read jobs.
 */
import { createHash } from "node:crypto";
import type { AwaitedStatus } from "@/lib/runners/dispatch";
import { digest } from "@/lib/controlplane/digest";
import { isAllowed as isOciReadAllowed } from "@/lib/providers/oci/allowlist";
import { EffectTombstonedError, EffectUnresolvedError, type EffectLedger } from "./ledger";
import type { EffectRecord } from "./types";

export type ProxyKind = "aws.http" | "oci.http" | "k8s.http";

export interface ProxyClassification {
  mutating: boolean;
  provider: "aws" | "oci" | "kubernetes";
  /** provider action or `METHOD path-shape`; bounded, non-secret */
  action: string;
  resource: string;
  /** the client token / idempotency header (or body field) the request carries, when the API has one */
  token?: { where: string; value: string };
  readbackHint: string;
}

/* ----------------------------------- AWS ------------------------------------ */

/** Read verbs of AWS RPC/query actions. An action is read only if it starts with one of these; unknown means mutating. */
export const AWS_READ_ACTION_VERBS = ["Describe", "List", "Get", "BatchGet", "Head", "Lookup", "Search"] as const;
/** Services whose REST protocols read with GET/HEAD on a resource path (no action name exists). Others are mutating. */
export const AWS_REST_READ_SERVICES = ["s3", "route53", "lambda", "apigateway", "cloudfront", "eks", "elasticfilesystem"] as const;

/**
 * Actions whose APIs take a client token, and where it goes. Injected (deterministically) when the caller did not
 * set one, so a repeat of the same request is deduplicated by the provider as well as by the ledger.
 */
export const AWS_TOKEN_FIELDS: Readonly<Record<string, { protocol: "json" | "query"; field: string }>> = {
  "CodeBuild_20161006.StartBuild": { protocol: "json", field: "idempotencyToken" },
  "AmazonEC2ContainerServiceV20141113.RunTask": { protocol: "json", field: "clientToken" },
  "AmazonEC2ContainerServiceV20141113.CreateService": { protocol: "json", field: "clientToken" },
  "AmazonEC2ContainerServiceV20141113.CreateTaskSet": { protocol: "json", field: "clientToken" },
  RunInstances: { protocol: "query", field: "ClientToken" },
  CreateNatGateway: { protocol: "query", field: "ClientToken" },
  CreateFleet: { protocol: "query", field: "ClientToken" },
};
const AWS_TOKEN_NAMES = new Set(["clienttoken", "idempotencytoken", "clientrequesttoken", "x-amz-client-token", "x-amzn-idempotency-token"]);

export interface AwsRequestParts {
  service: string;
  method: string;
  url: string;
  headers: Record<string, string>;
  body: Buffer;
}

function awsAction(r: AwsRequestParts): { action: string; protocol: "json" | "query" | "rest"; form?: URLSearchParams; json?: Record<string, unknown> } {
  const target = r.headers["x-amz-target"];
  if (typeof target === "string" && target.length > 0) {
    let json: Record<string, unknown> | undefined;
    try { const v: unknown = JSON.parse(r.body.toString("utf8") || "{}"); if (v && typeof v === "object" && !Array.isArray(v)) json = v as Record<string, unknown>; } catch { /* opaque body */ }
    return { action: target, protocol: "json", json };
  }
  if (r.method === "POST" && /x-www-form-urlencoded/i.test(r.headers["content-type"] ?? "")) {
    const form = new URLSearchParams(r.body.toString("utf8"));
    const action = form.get("Action");
    if (action) return { action, protocol: "query", form };
  }
  let path = "/";
  try { path = new URL(r.url).pathname; } catch { /* keep default */ }
  return { action: `${r.method} ${path.replace(/[0-9a-f]{8,}/gi, "{}")}`, protocol: "rest" };
}

const shortAction = (action: string): string => action.slice(action.lastIndexOf(".") + 1);

export function classifyAws(r: AwsRequestParts): ProxyClassification {
  const a = awsAction(r);
  const name = shortAction(a.action);
  const readRpc = a.protocol !== "rest" && AWS_READ_ACTION_VERBS.some((v) => name.startsWith(v) && /^[A-Za-z0-9]+$/.test(name));
  const readRest = a.protocol === "rest" && (r.method === "GET" || r.method === "HEAD") && (AWS_REST_READ_SERVICES as readonly string[]).includes(r.service);
  let tokenValue: string | undefined, where = "";
  for (const [k, v] of Object.entries(r.headers)) if (AWS_TOKEN_NAMES.has(k.toLowerCase()) && v) { tokenValue = v; where = `header ${k.toLowerCase()}`; }
  if (a.json) for (const [k, v] of Object.entries(a.json)) if (AWS_TOKEN_NAMES.has(k.toLowerCase()) && typeof v === "string" && v) { tokenValue = v; where = `body ${k}`; }
  if (a.form) for (const [k, v] of a.form.entries()) if (AWS_TOKEN_NAMES.has(k.toLowerCase()) && v) { tokenValue = v; where = `body ${k}`; }
  let path = "";
  try { path = new URL(r.url).pathname.slice(0, 200); } catch { /* none */ }
  return {
    mutating: !(readRpc || readRest), provider: "aws", action: a.action.slice(0, 120), resource: `${r.service} ${path}`.slice(0, 260),
    ...(tokenValue ? { token: { where, value: tokenValue.slice(0, 200) } } : {}),
    readbackHint: `Read back with the ${r.service} Describe or List call that names the resource of ${shortAction(a.action)}${path && path !== "/" ? ` (${path})` : ""}.`,
  };
}

/**
 * Add a deterministic client token to a request whose API supports one and which has none. The token is derived
 * from the operation and the exact request, so the same request always carries the same token.
 */
export function keyAwsRequest(r: AwsRequestParts, operationId: string): { body: Buffer; headers: Record<string, string> } {
  const a = awsAction(r);
  const spec = AWS_TOKEN_FIELDS[a.action] ?? AWS_TOKEN_FIELDS[shortAction(a.action)];
  if (!spec || classifyAws(r).token) return { body: r.body, headers: r.headers };
  const token = `zn-${createHash("sha256").update(`${operationId}\0${a.action}\0`).update(r.body).digest("hex").slice(0, 48)}`;
  if (spec.protocol === "json" && a.protocol === "json" && a.json) {
    return { body: Buffer.from(JSON.stringify({ ...a.json, [spec.field]: token }), "utf8"), headers: r.headers };
  }
  if (spec.protocol === "query" && a.protocol === "query" && a.form) {
    const form = new URLSearchParams(a.form);
    form.set(spec.field, token);
    return { body: Buffer.from(form.toString(), "utf8"), headers: r.headers };
  }
  return { body: r.body, headers: r.headers };
}

/* ----------------------------------- OCI ------------------------------------ */

export interface OciRequestParts { service: string; method: string; path: string; headers: Record<string, string> }

/** Read = a request in the OCI observe allowlist (explicit service/method/path rules). Everything else mutates. */
export function classifyOci(r: OciRequestParts): ProxyClassification {
  const read = isOciReadAllowed("infrastructure.observe", { service: r.service as never, method: r.method as never, path: r.path });
  const token = Object.entries(r.headers).find(([k, v]) => k.toLowerCase() === "opc-retry-token" && v);
  return {
    mutating: !read, provider: "oci", action: `${r.method} ${r.service}`.slice(0, 120), resource: `${r.service} ${r.path}`.slice(0, 260),
    ...(token ? { token: { where: "header opc-retry-token", value: token[1].slice(0, 200) } } : {}),
    readbackHint: `Read back with the OCI ${r.service} GET for the resource at ${r.path.slice(0, 120)}; opc-retry-token makes a repeat of the same request idempotent for the provider.`,
  };
}

/* -------------------------------- Kubernetes -------------------------------- */

/** POSTs that only ask a question. Every other non-GET is mutating; GET is read. */
export const K8S_READ_POSTS: readonly string[] = [
  "/apis/authorization.k8s.io/v1/selfsubjectaccessreviews",
  "/apis/authorization.k8s.io/v1/selfsubjectrulesreviews",
  "/apis/authentication.k8s.io/v1/selfsubjectreviews",
];

export function classifyK8s(r: { method: string; path: string }): ProxyClassification {
  const path = r.path.split("?")[0] ?? r.path;
  const read = r.method === "GET" || (r.method === "POST" && K8S_READ_POSTS.includes(path));
  return {
    mutating: !read, provider: "kubernetes", action: `${r.method} ${path.replace(/\/[^/]+$/, "/{}")}`.slice(0, 120), resource: path.slice(0, 260),
    // The Kubernetes API has no client token; a create is idempotent by object name (409 AlreadyExists) and an update by resourceVersion.
    readbackHint: `Read back with GET ${path.slice(0, 160)} (the named object, its resourceVersion and generation).`,
  };
}

/* --------------------------- classify a validated job --------------------------- */

interface JobPayload { service?: string; method: string; url?: string; path?: string; headers?: Record<string, string>; bodyB64?: string; query?: [string, string][] }

export function classifyProxyJob(kind: ProxyKind, payload: unknown): ProxyClassification {
  const p = payload as JobPayload;
  const body = p.bodyB64 ? Buffer.from(p.bodyB64, "base64") : Buffer.alloc(0);
  const headers = Object.fromEntries(Object.entries(p.headers ?? {}).map(([k, v]) => [k.toLowerCase(), String(v)]));
  if (kind === "aws.http") return classifyAws({ service: p.service ?? "", method: p.method, url: p.url ?? "", headers, body });
  if (kind === "oci.http") return classifyOci({ service: p.service ?? "", method: p.method, path: p.path ?? "/", headers });
  return classifyK8s({ method: p.method, path: p.path ?? "/" });
}

/* ----------------------------------- guard ------------------------------------ */

export interface ProxyHttpResult { status: number; headers?: Record<string, string>; bodyB64?: string; truncated?: boolean }
export interface ProxyAwaited<R> { jobId: string; status: AwaitedStatus; uncertain: boolean; result?: R; error?: string; exitCode?: number; startedAt?: string; finishedAt?: string;
  /** Set when this exact mutating request was already accepted in this operation and is answered from its durable receipt, not sent again. */
  replayedFromReceipt?: true }

export interface ProxyScope {
  workspaceId: string;
  operationId: string;
  capability: string;
  /** false for read-only capabilities (no operation row, only read jobs): the guard is skipped */
  mutates: boolean;
  environmentId?: string;
}

const SAVED_MAX = 6000;
const RESPONSE_REQUEST_ID = ["x-amzn-requestid", "x-amz-request-id", "opc-request-id", "x-request-id", "audit-id", "x-kubernetes-pf-flowschema-uid"];

function requestIdOf(result: ProxyHttpResult): string | undefined {
  for (const [k, v] of Object.entries(result.headers ?? {})) if (RESPONSE_REQUEST_ID.includes(k.toLowerCase()) && v) return String(v).slice(0, 200);
  return undefined;
}
/** A provider answer that proves the request was NOT applied (validation, authorization, conflict, throttling). */
const notApplied = (status: number): boolean => (status >= 400 && status < 500 && status !== 408) || status === 503;

/**
 * Run one proxied request. Mutating requests are recorded before they are enqueued, answered from the saved reply
 * on a repeat, refused while an earlier identical request is unresolved, and marked uncertain on a lost reply.
 * `enqueue` and `settle` are the transport's own job calls, unchanged.
 */
export async function runProxyJob<R extends ProxyHttpResult>(args: {
  ledger?: EffectLedger;
  scope: ProxyScope;
  kind: ProxyKind;
  payload: unknown;
  enqueue: () => Promise<string>;
  settle: (jobId: string) => Promise<ProxyAwaited<R>>;
}): Promise<ProxyAwaited<R>> {
  const { ledger, scope, kind, payload } = args;
  const c = scope.mutates && ledger ? classifyProxyJob(kind, payload) : undefined;
  if (!ledger || !c || !c.mutating) return args.settle(await args.enqueue());

  const p = payload as JobPayload;
  const requestDigest = digest({ kind, op: scope.operationId, method: p.method, url: p.url ?? null, path: p.path ?? null, query: p.query ?? null, body: p.bodyB64 ?? null,
    target: p.headers?.["x-amz-target"] ?? p.headers?.["X-Amz-Target"] ?? null, token: c.token?.value ?? null });
  const base = `proxy:${kind}:${requestDigest}`;
  const input = {
    workspaceId: scope.workspaceId, family: "proxy_request" as const, operationId: scope.operationId,
    ...(scope.environmentId ? { environmentId: scope.environmentId } : {}), provider: c.provider, requestDigest,
    target: { kind, action: c.action, resource: c.resource, capability: scope.capability, ...(c.token ? { tokenAt: c.token.where } : {}), readbackHint: c.readbackHint },
    ...(c.token ? { idempotencyToken: c.token.value.replace(/[^A-Za-z0-9_.:-]/g, "_").slice(0, 200) } : {}),
    idempotencySupported: c.token !== undefined,
  };
  // An earlier attempt the provider proved it refused (tombstoned) does not block a new one; anything else does.
  let effect: EffectRecord | undefined, created = false;
  for (let attempt = 0; attempt < 25; attempt++) {
    const r = await ledger.begin({ ...input, dedupKey: `${base}:a${attempt}`, actor: "system:proxy" });
    if (r.created) { effect = r.effect; created = true; break; }
    if (r.effect.state === "tombstoned" && r.effect.tombstoneReason === "provider_rejected") continue;
    effect = r.effect;
    break;
  }
  if (!effect) throw new EffectTombstonedError("proxy_attempts_exhausted");
  if (!created) {
    if (effect.state === "accepted" || effect.state === "confirmed") {
      const saved = effect.providerReceipt?.identity?.response;
      if (saved) {
        try {
          const result = JSON.parse(saved) as R;
          // Exactly once per operation: a resumed or retried identical request must never re-send a mutation
          // (a per-call nonce would let a resumed apply replay it). The answer is marked, never silent.
          return { jobId: effect.providerReceipt?.resourceId ?? "saved", status: "succeeded", uncertain: false, result, replayedFromReceipt: true };
        } catch { /* fall through */ }
      }
      throw new EffectUnresolvedError(effect.effectId, effect.state, "This exact request was already accepted by the provider and its reply was not retained. It will not be sent again; read the result back.");
    }
    if (effect.state === "tombstoned") throw new EffectTombstonedError(effect.effectId);
    throw new EffectUnresolvedError(effect.effectId, effect.state);
  }

  let jobId: string;
  try {
    jobId = await args.enqueue();
  } catch (error) {
    // Nothing was queued: the request never reached a runner.
    await ledger.recordRejected(scope.workspaceId, effect.effectId, "The request was refused before it was queued.", "system:proxy").catch(() => undefined);
    throw error;
  }
  let awaited: ProxyAwaited<R>;
  try {
    awaited = await args.settle(jobId);
  } catch (error) {
    await ledger.markUncertain(scope.workspaceId, effect.effectId, `The reply to the proxied request was lost. ${c.readbackHint}`, "system:proxy").catch(() => undefined);
    throw error;
  }
  const result = awaited.result;
  if (awaited.status === "succeeded" && result && Number.isInteger(result.status)) {
    if (notApplied(result.status)) {
      await ledger.recordRejected(scope.workspaceId, effect.effectId, `The provider answered HTTP ${result.status} and did not apply the request.`, "system:proxy").catch(() => undefined);
      return awaited;
    }
    if (result.status >= 200 && result.status < 300) {
      const compact = JSON.stringify({ status: result.status, headers: result.headers ?? {}, ...(result.bodyB64 ? { bodyB64: result.bodyB64 } : {}) });
      const requestId = requestIdOf(result);
      await ledger.recordAccepted(scope.workspaceId, effect.effectId, {
        resourceId: jobId, requestIds: requestId ? [requestId] : [],
        ...(compact.length <= SAVED_MAX ? { identity: { response: compact } } : {}),
      }, "system:proxy").catch(() => undefined);
      return awaited;
    }
    // 3xx and 5xx other than 503: the provider may or may not have applied it.
    await ledger.markUncertain(scope.workspaceId, effect.effectId, `The provider answered HTTP ${result.status}; it may have applied the request. ${c.readbackHint}`, "system:proxy").catch(() => undefined);
    return awaited;
  }
  // Rejected by the runner, or cancelled/expired before delivery: it was not executed.
  if (awaited.status === "rejected" || ((awaited.status === "expired" || awaited.status === "cancelled") && !awaited.uncertain)) {
    await ledger.recordRejected(scope.workspaceId, effect.effectId, "The runner did not execute the request.", "system:proxy").catch(() => undefined);
    return awaited;
  }
  await ledger.markUncertain(scope.workspaceId, effect.effectId, `The proxied request ended ${awaited.status} without a usable reply. ${c.readbackHint}`, "system:proxy").catch(() => undefined);
  return awaited;
}

/** Resolver for `proxy_request`: there is no generic independent read, so the readback says exactly what to read. */
export function proxyRequestHintResolver(): import("./readback").EffectResolver {
  return {
    family: "proxy_request",
    provider: "*",
    async read({ effect }) {
      const hint = typeof effect.target.readbackHint === "string" ? effect.target.readbackHint : "Read the provider resource this request named.";
      return { outcome: "unavailable", source: "none", facts: { action: String(effect.target.action ?? ""), resource: String(effect.target.resource ?? "") }, reason: `No automatic independent readback exists for this request. ${hint}` };
    },
  };
}
