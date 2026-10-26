/**
 * Backpressure vocabulary (PROD-OPS-02).
 *
 * Every refusal the fairness layer makes is a `BackpressureError`: a stable
 * machine code, an HTTP status (429 when the CALLER exceeded its own share,
 * 503 when the platform or an operator is shedding load), and a `Retry-After`
 * in whole seconds. Nothing here ever buffers: a full queue is a refusal.
 *
 * Leaf module: no imports, safe in the edge runtime, Node and the worker.
 */

export type BackpressureCode =
  | "rate_limited"
  | "concurrency_exceeded"
  | "queue_full"
  | "overloaded"
  | "maintenance_read_only"
  | "maintenance_dispatch_paused"
  // PROD-MAN-06: only ever raised in `billing: managed` mode; BYOC and self-hosted installs never see them.
  | "billing_unavailable"
  | "billing_suspended"
  | "plan_quota_exceeded"
  // The workspace's plan does not include the feature (deploy, organizational policies). Not retryable; carries `feature`.
  | "plan_feature_unavailable"
  // Dispatch could not read its quota or active-operation count, so it refuses rather than admit unchecked (fail closed).
  | "admission_unavailable";

export type BackpressureLayer = "edge" | "api" | "dispatch" | "runner_queue" | "worker" | "maintenance" | "billing";

/** 429: the caller's own quota. 503: platform/operator load shedding. 402: billing state refuses NEW work (never reads or export). */
export const BACKPRESSURE_STATUS: Readonly<Record<BackpressureCode, 402 | 429 | 503>> = {
  rate_limited: 429,
  concurrency_exceeded: 429,
  queue_full: 429,
  overloaded: 503,
  maintenance_read_only: 503,
  maintenance_dispatch_paused: 503,
  billing_unavailable: 503,
  billing_suspended: 402,
  plan_quota_exceeded: 429,
  plan_feature_unavailable: 402,
  admission_unavailable: 503,
};

export const MIN_RETRY_AFTER_SEC = 1;
export const MAX_RETRY_AFTER_SEC = 3600;

export const clampRetryAfter = (seconds: number): number =>
  !Number.isFinite(seconds) ? MIN_RETRY_AFTER_SEC : Math.min(MAX_RETRY_AFTER_SEC, Math.max(MIN_RETRY_AFTER_SEC, Math.ceil(seconds)));

export class BackpressureError extends Error {
  readonly name = "BackpressureError";
  readonly status: 402 | 429 | 503;
  readonly retryAfterSec: number;
  constructor(
    readonly code: BackpressureCode,
    readonly layer: BackpressureLayer,
    message: string,
    retryAfterSec: number,
    /** workspace id when the refusal is tenant-scoped; never a credential */
    readonly tenant?: string,
    /** machine-readable extras: the gated `feature` and a `fix` that replaces the generic retry hint (a refusal retrying cannot cure) */
    readonly detail?: { feature?: string; fix?: string }
  ) {
    super(message);
    this.status = BACKPRESSURE_STATUS[code];
    this.retryAfterSec = clampRetryAfter(retryAfterSec);
  }
}

export const isBackpressureError = (value: unknown): value is BackpressureError =>
  value instanceof BackpressureError
  || (typeof value === "object" && value !== null && (value as { name?: unknown }).name === "BackpressureError"
    && typeof (value as { retryAfterSec?: unknown }).retryAfterSec === "number");

/** `{ error: { code, message, fix, retryAfterSec } }` - the platform error shape plus the retry hint. */
export function backpressureBody(error: BackpressureError): { error: { code: string; message: string; fix: string; retryAfterSec: number; feature?: string } } {
  return {
    error: {
      code: error.code,
      message: error.message,
      fix: error.detail?.fix ?? `Wait ${error.retryAfterSec} second${error.retryAfterSec === 1 ? "" : "s"} and retry the same request.`,
      retryAfterSec: error.retryAfterSec,
      ...(error.detail?.feature ? { feature: error.detail.feature } : {}),
    },
  };
}

/** The response every HTTP surface answers with. Works in the edge runtime. */
export function backpressureResponse(error: BackpressureError): Response {
  return new Response(JSON.stringify(backpressureBody(error)), {
    status: error.status,
    headers: { "content-type": "application/json", "cache-control": "no-store", "retry-after": String(error.retryAfterSec) },
  });
}
