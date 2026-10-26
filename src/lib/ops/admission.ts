/**
 * Admission control for the control plane (PROD-OPS-02). Node runtime only.
 *
 * Two entry points, both wired into the real callers:
 *
 *  - `beginRequest` is called by `route()` (src/lib/server/request.ts), the one
 *    wrapper under every product and platform API route. It applies, in order:
 *      1. maintenance (read-only refuses mutating calls with 503),
 *      2. the process-wide in-flight ceiling (503 overloaded),
 *      3. after the workspace is resolved (`bindWorkspace`): the workspace's
 *         token bucket (429 rate_limited) and its in-flight ceiling
 *         (429 concurrency_exceeded).
 *    Control lanes (runner/machine poll and result, cron ticks, the operator
 *    maintenance route, the hosted data plane) skip 2 and 3 and are never
 *    refused by 1, so overload and maintenance cannot block draining.
 *    It also opens the request's trace span and records the request metrics.
 *
 *  - `assertDispatchAdmitted` is called BEFORE an approved operation is claimed
 *    and its workflow started (bridge deploy/destroy, MCP execute, portability
 *    start). Refusing here changes nothing: the operation stays approved and
 *    the caller retries. It applies maintenance (pause), the workspace's
 *    dispatch token bucket and its active-operation quota.
 *
 * Admission is protection, never a dependency: when the control store cannot
 * be read, quotas fall back to the last known value or the defaults, and the
 * maintenance state to the last known value (see runtime.ts). The only
 * absolute refusals are the ones an operator asked for.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { log } from "@/lib/log";
import { BackpressureError, isBackpressureError } from "./errors";
import { assertApiWritable, assertDispatchAllowed, isControlLane } from "./maintenance";
import { apiSpecFor, currentMaintenance, opsRuntime, platformConfigured } from "./runtime";
import { activeOperationCount, type TenantQuota } from "./store";
import { noteAdmission, noteRefusal, opsMetrics, routeClassOf, statusClassOf } from "./telemetry/catalog";
import { tenantLabeler } from "./telemetry/metrics";
import { formatTraceparent, tracer, type Span } from "./telemetry/tracing";

export interface RequestScope {
  /** W3C traceparent for the response */
  readonly traceparent: string;
  /** Apply the workspace's rate and concurrency quota once the workspace is known. Throws BackpressureError. */
  bindWorkspace(workspaceId: string | undefined): Promise<void>;
  /** Run the handler with this request's span active (log/trace correlation). */
  run<T>(fn: () => Promise<T>): Promise<T>;
  /** Release leases, record metrics, end the span. Idempotent. */
  finish(status: number, error?: unknown): void;
}

const scopes = new AsyncLocalStorage<RequestScope>();

/**
 * Apply the current request's workspace quota from code that learns the workspace later than route() does
 * (the platform API resolves it from the bearer credential or an `x-zenith-workspace` header). A no-op outside
 * a request, for control lanes, and once a workspace is already bound. Throws BackpressureError.
 */
export async function bindRequestWorkspace(workspaceId: string | undefined): Promise<void> {
  await scopes.getStore()?.bindWorkspace(workspaceId);
}

const OPERATION_IN_PATH = /\/operations\/([A-Za-z0-9_.:-]{1,128})(?:\/|$)/;

export interface BeginRequestInput {
  method: string;
  pathname: string;
  headers: Headers;
  requestId: string;
}

export async function beginRequest(input: BeginRequestInput): Promise<RequestScope> {
  const rt = opsRuntime();
  const m = opsMetrics();
  const routeClass = routeClassOf(input.pathname);
  const method = input.method.toUpperCase();
  const lane = isControlLane(input.pathname);
  const startedAt = performance.now();
  const span: Span = tracer().startSpan(`${method} ${routeClass}`, {
    kind: "server",
    parent: input.headers.get("traceparent") ?? undefined,
    attributes: { "http.request.method": method, "http.route": routeClass, "zenith.request.id": input.requestId, "zenith.operation.class": "api", "zenith.lane": lane ? "control" : "tenant", "zenith.operation.id": OPERATION_IN_PATH.exec(input.pathname)?.[1] },
  });
  let globalRelease: (() => void) | undefined;
  let tenantRelease: (() => void) | undefined;
  let tenant: string | undefined;
  let bound = false;
  let finished = false;

  const finish = (status: number, error?: unknown): void => {
    if (finished) return;
    finished = true;
    globalRelease?.();
    tenantRelease?.();
    globalRelease = tenantRelease = undefined;
    m.apiInflight.set({ scope: "global" }, rt.globalGate.inFlight);
    const labels = { tenant: tenantLabeler().label(tenant), route_class: routeClass, method, status_class: statusClassOf(status) };
    m.apiRequests.inc(labels);
    m.apiDuration.observe({ route_class: routeClass, method }, (performance.now() - startedAt) / 1000);
    span.setAttribute("http.response.status_code", status);
    if (isBackpressureError(error)) span.setAttribute("zenith.admission.decision", error.code);
    span.setStatus(status >= 500 || error ? "error" : "ok", isBackpressureError(error) ? error.code : undefined);
    span.end();
  };

  try {
    assertApiWritable(await currentMaintenance(rt), input.pathname, method);
    if (!lane) {
      const g = rt.globalGate.tryAcquire("*", rt.limits.api.maxInFlight);
      if (!g.ok) throw new BackpressureError("overloaded", "api", "The control plane is at its request concurrency limit. Retry shortly.", rt.limits.retryAfterSec);
      globalRelease = g.release;
      m.apiInflight.set({ scope: "global" }, rt.globalGate.inFlight);
    }
  } catch (error) {
    if (isBackpressureError(error)) { noteRefusal(error); finish(error.status, error); }
    else finish(500, error);
    throw error;
  }

  const scope: RequestScope = {
    traceparent: formatTraceparent(span.context),
    run: (fn) => scopes.run(scope, () => tracer().withActive(span, fn)),
    finish,
    async bindWorkspace(workspaceId) {
      // The first workspace wins: route() binds the resolved one, later callers of the same request are no-ops.
      if (!workspaceId || bound || finished) return;
      bound = true;
      tenant = workspaceId;
      span.setAttribute("zenith.tenant.id", workspaceId);
      if (lane) return;
      try {
        const { spec, maxConcurrent } = apiSpecFor(rt.limits, await rt.quotas.get(workspaceId));
        const taken = rt.apiLimiter.take(workspaceId, 1, spec);
        if (!taken.ok) {
          throw new BackpressureError("rate_limited", "api", "This workspace is sending requests faster than its limit. Slow down and retry.", taken.retryAfterMs / 1000, workspaceId);
        }
        const lease = rt.tenantGate.tryAcquire(workspaceId, maxConcurrent);
        if (!lease.ok) {
          throw new BackpressureError("concurrency_exceeded", "api", "This workspace has too many requests in flight. Retry when some finish.", rt.limits.retryAfterSec, workspaceId);
        }
        tenantRelease = lease.release;
        noteAdmission("api", "allowed", workspaceId);
      } catch (error) {
        if (isBackpressureError(error)) noteRefusal(error);
        throw error;
      }
    },
  };
  return scope;
}

/* -------------------------------- dispatch -------------------------------- */

export type DispatchKind = "deploy" | "destroy" | "dayTwo" | "remediation" | "runner_job" | "export";

export interface DispatchAdmissionInput {
  workspaceId: string;
  kind: DispatchKind;
  /** the operation about to start; excluded from the active count so a retry does not count against itself */
  operationId?: string;
}

/** The refusal for an unreadable quota: the client gets a fixed message, the cause only goes to the operator log. */
function admissionUnavailable(input: DispatchAdmissionInput, cause: unknown): BackpressureError {
  log.warn("dispatch refused: quota check unavailable", { scope: "ops", workspaceId: input.workspaceId, cause: cause instanceof Error ? cause.name : "unknown" });
  return new BackpressureError("admission_unavailable", "dispatch", "This workspace's dispatch quota could not be checked, so the operation was not started. Retry shortly.", 5, input.workspaceId);
}

/**
 * Admit (or refuse) the START of new work. Throws only BackpressureError. Fails closed: when the
 * platform store is configured and the tenant quota or active-operation count cannot be read, the
 * dispatch is refused with `admission_unavailable` and nothing is claimed. Unconfigured installs keep
 * the platform defaults and no active-operation count, as before.
 */
export async function assertDispatchAdmitted(input: DispatchAdmissionInput): Promise<void> {
  const rt = opsRuntime();
  const m = opsMetrics();
  const tenant = tenantLabeler().label(input.workspaceId);
  const span = tracer().startSpan(`dispatch ${input.kind}`, {
    attributes: { "zenith.tenant.id": input.workspaceId, "zenith.operation.id": input.operationId, "zenith.operation.class": "dispatch", "zenith.dispatch.kind": input.kind },
  });
  try {
    assertDispatchAllowed(await currentMaintenance(rt), input.workspaceId);
    const configured = platformConfigured();
    let quota: TenantQuota | null = null;
    try { quota = await rt.quotas.get(input.workspaceId, { failClosed: configured }); } catch (error) { throw admissionUnavailable(input, error); }
    const weight = quota?.weight ?? 1;
    const taken = rt.dispatchLimiter.take(input.workspaceId, 1, {
      ratePerSec: rt.limits.dispatch.ratePerSec * weight,
      burst: Math.min(10_000, rt.limits.dispatch.burst * weight),
    });
    if (!taken.ok) throw new BackpressureError("rate_limited", "dispatch", "This workspace is starting operations faster than its limit. Retry shortly.", taken.retryAfterMs / 1000, input.workspaceId);
    if (configured) {
      let active: number;
      try {
        active = await activeOperationCount(await rt.store(), input.workspaceId, input.operationId);
      } catch (error) {
        throw admissionUnavailable(input, error);
      }
      const limit = quota?.maxActiveOperations ?? Math.min(100_000, rt.limits.dispatch.maxActiveOperations * weight);
      m.activeOperations.set({ tenant }, active);
      if (active >= limit) {
        throw new BackpressureError("concurrency_exceeded", "dispatch", `This workspace already has ${active} operations running or queued (limit ${limit}). The operation was not claimed; retry when some finish.`, 30, input.workspaceId);
      }
    }
    // PROD-MAN-06: billing can refuse NEW work (suspension, plan quota) but never export or destroy; `billing: disabled` returns before any I/O.
    await (await import("@/lib/billing/admission")).assertBillingAdmitted({ workspaceId: input.workspaceId, kind: input.kind, operationId: input.operationId });
    noteAdmission("dispatch", "allowed", input.workspaceId);
    m.dispatch.inc({ tenant, kind: input.kind, outcome: "admitted" });
    span.setStatus("ok");
  } catch (error) {
    if (isBackpressureError(error)) {
      noteRefusal(error);
      m.dispatch.inc({ tenant, kind: input.kind, outcome: error.code });
      span.setAttribute("zenith.admission.decision", error.code);
    }
    span.setStatus("error", isBackpressureError(error) ? error.code : "error");
    throw error;
  } finally {
    span.end();
  }
}
