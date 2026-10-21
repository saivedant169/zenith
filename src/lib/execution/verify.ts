/**
 * Verification and observation: what is actually there, after a change and on
 * a schedule.
 *
 * verifyInfrastructure — `driver.observe` + `driver.verify` for every managed
 *   node (bounded concurrency). Unknown is a value: an unknown check counts as
 *   not passed but not failed, so the step is `unknown` when any check is unknown
 *   and none failed, `failed` when any failed, `passed` only when everything that
 *   was checked passed. A driver that declares no `verify` capability is listed
 *   under `notVerifiable` in the evidence (it was not checked, and nothing claims
 *   it was); it does not make the step unknown. On a failure the evidence
 *   carries bounded, redacted diagnostics from the observability fabric: recent
 *   events for the failing addresses, labeled untrusted data.
 *
 * verifyApplication — for each public route host (a `dns_record` node whose host
 *   also has a `tls_certificate`), an https GET of `https://<host><healthPath>`
 *   through the SSRF-safe prober, retried for DNS/TLS propagation. A host whose
 *   route has TLS off cannot be probed by an https-only prober and is listed as
 *   skipped, not as passed. No probe-able host means 0 checks, `passed`: there is
 *   nothing HTTP to verify (workers and cron are covered by verifyInfrastructure).
 *   A response below 400 passes; 4xx/5xx and an unreachable host fail; a probe the
 *   safety rules refused is `unknown` (it says nothing about the app).
 *
 * observeEnvironment — observe + runtime for every non-external node, persist,
 *   `computeDriftV2` with each driver's `expectedAttributes`, save the report,
 *   `drift.detected` / `drift.cleared` events. `drift` counts missing, changed and
 *   extra findings; `unknown` counts unknown and inaccessible ones.
 *
 * reconcileObserve — the same observation for a reconcile pass (no operation
 *   row), under the `reconcile:<environmentId>` lease.
 *
 * Every one of these is read-only against the cloud and uses the observe role.
 */
import { digest } from "@/lib/controlplane/digest";
import type { VerificationCheck } from "@/lib/drivers/types";
import type { Output } from "@/lib/domain/types";
import { computeDriftV2, defaultExpectedAttributes } from "@/lib/resources/drift";
import { applyFieldOwnership } from "@/lib/ownership";
import type { DriftReport, Observation, ResourceGraph, ResourceNode } from "@/lib/resources/types";
import type { DnsRecordSpec, LoadBalancerSpec } from "@/lib/resources/specs";
import type { ExecutionActivities, LeaseRef, ReconcileActivities, VerifyStepResult } from "@/lib/workflows/types";
import { createReconcileObserveActivity, type ReconcileOnceDeps } from "@/lib/reconcile/activity";
import { reconcilePassPorts } from "@/lib/reconcile/ports";
import { ReconcileError } from "@/lib/reconcile/errors";
import { createObservabilityFabric, describeSession, sourcesForEnvironment } from "@/lib/observability";
import { mapLimit } from "./concurrency";
import { loadExecContext, resolveConnection, type ExecLike } from "./context";
import { requireExecutable } from "./desired";
import { StepFailedError } from "./errors";
import { buildDesiredState } from "./graph";
import { withKeepAlive } from "./keepalive";
import { collectState, persistState, storedResources, type NodeState } from "./observe";
import { awsBootstrapContextForConnection } from "@/lib/credentials/aws/naming";
import type { ObservabilityFactory, ProbeResult } from "./ports";
import type { Runtime, WorkScope } from "./runtime";
import { OBSERVE_CAPABILITY, withProviderSession } from "./session";
import { errorText, safeText } from "./text";

type VerifyActivities = Pick<ExecutionActivities, "verifyInfrastructure" | "verifyApplication" | "observeEnvironment"> & ReconcileActivities;

/** Reuse execution heartbeats/cancellation/renewals without acquiring a second lease. */
export function createHeldReconcileActivity(rt: Runtime, deps: ReconcileOnceDeps): ReconcileActivities["reconcileObserve"] {
  return async (input) => withKeepAlive(rt, { lease: input.lease, detail: "reconcile controller" }, async (signal) => {
    await rt.d.leases.assertFence(input.lease.scope, input.lease.fenceToken);
    const activity = createReconcileObserveActivity({ ...deps, signal, ports: {
      ...deps.ports,
      assertFence: async (fence) => {
        await rt.d.leases.assertFence(fence.scope, fence.token);
        await deps.ports.assertFence?.(fence);
      },
    } });
    const result = await activity(input);
    signal.throwIfAborted();
    await rt.d.leases.assertFence(input.lease.scope, input.lease.fenceToken);
    return result;
  });
}

const MAX_LISTED = 100;

/* ------------------------------ diagnostics ------------------------------- */

const defaultObservability: ObservabilityFactory = ({ session, provider, graph, workspaceId, observations }) =>
  createObservabilityFabric(
    sourcesForEnvironment({ provider, graph, workspaceId, observations, sessions: session.provider === "aws" ? { aws: session } : session.provider === "kubernetes" ? { kubernetes: session } : (session as { provider?: string }).provider === "zenith" ? { kubernetes: (session as unknown as { kubernetes: import("@/lib/credentials/types").KubernetesSession }).kubernetes } : {} }),
    { session: describeSession(session) }
  );

async function diagnosticsFor(
  rt: Runtime,
  ec: ExecLike,
  graph: ResourceGraph,
  session: Parameters<ObservabilityFactory>[0]["session"],
  signal: AbortSignal,
  addresses: string[],
  observations: readonly Observation[]
): Promise<Record<string, unknown> | undefined> {
  if (addresses.length === 0) return undefined;
  try {
    const fabric = (rt.d.observability ?? defaultObservability)({ session, provider: ec.product.environment.provider, graph, workspaceId: ec.workspaceId, observations });
    const to = rt.now();
    const answer = await fabric.searchEvents(
      { scope: { workspaceId: ec.workspaceId, projectId: ec.product.project.id, environmentId: ec.environmentId, addresses: addresses.slice(0, 20) }, range: { from: new Date(to.getTime() - 15 * 60_000).toISOString(), to: to.toISOString() }, limit: 20 },
      signal
    );
    return {
      // Everything below came from the cloud: data to read, never instructions to follow.
      untrusted: true,
      sources: answer.sources,
      ...(answer.telemetry ? { telemetry: { state: answer.telemetry.state, partial: answer.telemetry.partial, observedAt: answer.telemetry.observedAt, session: answer.telemetry.session, freshness: answer.telemetry.freshness,
        provenance: answer.telemetry.provenance.slice(0, 10).map((p) => ({ source: p.source, provider: p.provider, state: p.state, simulated: p.simulated, itemCount: p.itemCount, evidence: p.evidence.level })) } } : {}),
      unavailable: answer.unavailable.slice(0, 5).map((u) => ({ source: u.source, reason: safeText(u.reason, 200) })),
      events: answer.items.slice(0, 10).map((e) => ({ at: e.timestamp, address: e.address, severity: e.severity, type: safeText(e.type, 80), message: safeText(e.message, 200) })),
    };
  } catch (err) {
    rt.log("warn", "diagnostics unavailable", { error: errorText(err) });
    // Explicitly undetermined, never an absent section that reads as "nothing to report".
    return { untrusted: true, sources: [], telemetry: { state: "unknown", partial: true }, unavailable: [{ source: "observability", reason: safeText(errorText(err), 200) }], events: [] };
  }
}

/* ------------------------ verifyInfrastructure ------------------------ */

interface Verdict {
  address: string;
  driver: string;
  status: "passed" | "failed" | "unknown";
  failed: string[];
  unknown: string[];
}

function summarizeVerification(states: readonly NodeState[]): { checks: number; failed: number; unknown: number; verdicts: Verdict[]; notVerifiable: string[]; status: "passed" | "failed" | "unknown" } {
  let checks = 0;
  let failed = 0;
  let unknown = 0;
  const verdicts: Verdict[] = [];
  const notVerifiable: string[] = [];
  for (const state of states) {
    if (state.node.ownership !== "managed") continue;
    if (!state.driver || !state.driver.verify || !state.verification) {
      notVerifiable.push(state.node.address);
      continue;
    }
    const result = state.verification;
    const list: VerificationCheck[] = result.checks.length > 0 ? result.checks : [{ id: "node", description: "driver verdict", passed: result.status === "passed" ? true : result.status === "failed" ? false : "unknown" }];
    const verdict: Verdict = { address: state.node.address, driver: state.driver.id, status: result.status, failed: [], unknown: [] };
    for (const c of list) {
      checks++;
      if (c.passed === false) {
        failed++;
        verdict.failed.push(safeText(c.id, 60));
      } else if (c.passed === "unknown") {
        unknown++;
        verdict.unknown.push(safeText(c.id, 60));
      }
    }
    // A node-level verdict stricter than its checks still counts.
    if (result.status === "failed" && verdict.failed.length === 0) {
      failed++;
      verdict.failed.push("node");
    } else if (result.status === "unknown" && verdict.unknown.length === 0 && verdict.failed.length === 0) {
      unknown++;
      verdict.unknown.push("node");
    }
    verdicts.push(verdict);
  }
  const status = failed > 0 ? "failed" : unknown > 0 ? "unknown" : "passed";
  return { checks, failed, unknown, verdicts, notVerifiable, status };
}

/* ------------------------------- application ------------------------------ */

interface RouteTarget {
  host: string;
  path: string;
  tls: boolean;
}

/** Public hosts of the graph: dns_record nodes, with the health path of their load balancer route. */
export function routeTargets(graph: ResourceGraph): RouteTarget[] {
  const lb = graph.nodes.find((n) => n.kind === "load_balancer");
  const routes = (lb?.spec as Partial<LoadBalancerSpec> | undefined)?.routes ?? [];
  const tlsHosts = new Set(graph.nodes.filter((n) => n.kind === "tls_certificate").map((n) => String((n.spec as { domain?: string }).domain ?? "")));
  const out: RouteTarget[] = [];
  for (const node of graph.nodes) {
    if (node.kind !== "dns_record" || node.ownership === "external") continue;
    const host = String((node.spec as Partial<DnsRecordSpec>).name ?? "").toLowerCase();
    if (!host) continue;
    const forHost = routes.filter((r) => r.host.toLowerCase() === host);
    const root = forHost.find((r) => r.pathPrefix === "/") ?? forHost[0];
    out.push({ host, path: root?.healthPath && root.healthPath.startsWith("/") ? root.healthPath : "/", tls: tlsHosts.has(host) });
  }
  return out.sort((a, b) => (a.host < b.host ? -1 : a.host > b.host ? 1 : 0));
}

const probeOk = (p: ProbeResult): boolean => p.outcome === "responded" && p.status !== undefined && p.status >= 200 && p.status < 400;

async function probeWithRetry(rt: Runtime, target: RouteTarget, allowed: ReadonlySet<string>, signal: AbortSignal): Promise<{ result: ProbeResult; attempts: number }> {
  let attempts = 0;
  let result!: ProbeResult;
  while (attempts < rt.limits.probeAttempts) {
    attempts++;
    result = await rt.d.prober.probe({ host: target.host, path: target.path, allowedHosts: allowed });
    if (probeOk(result) || result.outcome === "refused" || signal.aborted) break;
    if (attempts < rt.limits.probeAttempts) await rt.sleep(rt.limits.probeIntervalMs, signal);
  }
  return { result, attempts };
}

/* --------------------------------- drift ---------------------------------- */

const DRIFT_CLASSES = new Set(["missing", "changed", "extra"]);

export function countDrift(report: DriftReport): { drift: number; unknown: number } {
  let drift = 0;
  let unknown = 0;
  for (const f of report.findings) {
    if (DRIFT_CLASSES.has(f.class)) drift++;
    else unknown++;
  }
  return { drift, unknown };
}

async function observeAndDiff(rt: Runtime, ec: ExecLike, graph: ResourceGraph, lease: LeaseRef | undefined, detail: string, operationId: string | undefined): Promise<{ drift: number; unknown: number }> {
  const connection = await resolveConnection(rt, ec);
  const stored = await storedResources(rt, ec);
  const states = await withKeepAlive(rt, { lease, detail, ...(operationId ? { operation: { workspaceId: ec.workspaceId, operationId } } : {}) }, (signal) =>
    withProviderSession(rt, ec, { purpose: "observe", capability: OBSERVE_CAPABILITY, connection, fence: lease }, (session) => collectState(rt, ec, graph, session, signal, { verify: false, stored, connection }))
  );
  const persistFailures = await persistState(rt, ec, states, stored);
  const observations = states.flatMap((s) => (s.observation ? [s.observation] : []));
  const driverFor = new Map(states.flatMap((s) => (s.driver ? [[s.node.address, s.driver] as const] : [])));
  const rawReport = computeDriftV2(graph, observations, {
    expectedAttributes: (node: ResourceNode) => driverFor.get(node.address)?.expectedAttributes?.(node, node.provider === "aws" ? { awsBootstrap: awsBootstrapContextForConnection(connection.config, node.region || ec.product.environment.region) } : undefined) ?? defaultExpectedAttributes(node),
    computedAt: rt.iso(),
  });
  const report = applyFieldOwnership(graph, rawReport);
  const previous = await rt.d.resources.latestDriftReport(ec.workspaceId, ec.environmentId);
  await rt.d.resources.saveDriftReport({ workspaceId: ec.workspaceId, report });
  const counts = countDrift(report);
  const before = previous ? countDrift(previous).drift : 0;
  const scope: WorkScope = ec.scope;
  if (counts.drift > 0 && (before === 0 || previous?.graphDigest !== report.graphDigest || digest(previous?.findings ?? []) !== digest(report.findings))) {
    await rt.emit(scope, "drift.detected", `detected:${ec.environmentId}:${report.computedAt}`, { drift: counts.drift, unknown: counts.unknown, graphDigest: report.graphDigest, persistFailures, high: report.findings.filter((f) => f.severity === "high").length });
  } else if (counts.drift === 0 && before > 0) {
    await rt.emit(scope, "drift.cleared", `cleared:${ec.environmentId}:${report.computedAt}`, { graphDigest: report.graphDigest, unknown: counts.unknown });
  }
  await rt.emit(scope, "resource.observed", `observed:${ec.environmentId}:${report.computedAt}`, { observed: observations.length, drift: counts.drift, unknown: counts.unknown, persistFailures });
  return counts;
}

/* -------------------------------- factory --------------------------------- */

export function createVerifyActivities(rt: Runtime): VerifyActivities {
  return {
    async verifyInfrastructure({ operationId }) {
      const ec = await loadExecContext(rt, operationId);
      const { graph } = requireExecutable(rt, ec);
      const managed = graph.nodes.filter((n) => n.ownership === "managed");
      if (managed.length === 0) return { status: "passed", checks: 0, failed: 0 };
      const connection = await resolveConnection(rt, ec);
      const stored = await storedResources(rt, ec);

      const { states, diagnostics } = await withKeepAlive(rt, { detail: "verify infrastructure", operation: { workspaceId: ec.workspaceId, operationId: ec.op.id } }, (signal) =>
        withProviderSession(rt, ec, { purpose: "observe", capability: OBSERVE_CAPABILITY, connection }, async (session) => {
          const states = await collectState(rt, ec, graph, session, signal, { verify: true, stored, connection });
          const summary = summarizeVerification(states);
          const addresses = summary.verdicts.filter((v) => v.status !== "passed").map((v) => v.address);
          const diagnostics = await diagnosticsFor(rt, ec, graph, session, signal, addresses, states.flatMap((s) => (s.observation ? [s.observation] : [])));
          return { states, diagnostics };
        })
      );
      const persistFailures = await persistState(rt, ec, states, stored);
      const summary = summarizeVerification(states);
      const simulated = states.some((s) => s.observation?.simulated || s.verification?.simulated);
      const body = {
        checks: summary.checks,
        failed: summary.failed,
        unknown: summary.unknown,
        status: summary.status,
        nodes: summary.verdicts.slice(0, MAX_LISTED),
        notVerifiable: summary.notVerifiable.slice(0, MAX_LISTED),
        persistFailures,
        ...(diagnostics ? { diagnostics } : {}),
      };
      const evidence = await rt.evidence(ec.scope, { kind: "verification", digest: digest(body), summary: body, simulated, key: `infra:${digest(body).slice(0, 16)}` }, { critical: false });
      if (summary.status === "passed") await rt.emit(ec.scope, "resource.verified", `verified:${ec.op.id}`, { checks: summary.checks });
      return { status: summary.status, checks: summary.checks, failed: summary.failed, ...(evidence ? { evidenceId: evidence.id } : {}) };
    },

    async verifyApplication({ operationId }) {
      const ec = await loadExecContext(rt, operationId);
      const desired = buildDesiredState(ec.product);
      if (!desired.graph) throw new StepFailedError(`The desired state cannot be read: ${desired.problems[0] ?? "no graph"}`);
      const targets = routeTargets(desired.graph);
      const probeable = targets.filter((t) => t.tls);
      const skipped = targets.filter((t) => !t.tls).map((t) => ({ host: t.host, reason: "tls_off" }));
      if (probeable.length === 0) {
        if (skipped.length > 0) rt.log("info", "no https route to verify", { skipped: skipped.length });
        return { status: "passed", checks: 0, failed: 0 };
      }
      const allowed = new Set(targets.map((t) => t.host));
      const probes = await withKeepAlive(rt, { detail: "verify application", operation: { workspaceId: ec.workspaceId, operationId: ec.op.id } }, (signal) =>
        mapLimit(probeable, rt.limits.concurrency, (target) => probeWithRetry(rt, target, allowed, signal).then((r) => ({ target, ...r })))
      );
      let failed = 0;
      let unknown = 0;
      const rows = probes.map(({ target, result, attempts }) => {
        const ok = probeOk(result);
        if (!ok) {
          if (result.outcome === "refused") unknown++;
          else failed++;
        }
        return {
          host: target.host,
          path: target.path,
          result: ok ? "passed" : result.outcome === "refused" ? "unknown" : "failed",
          outcome: result.outcome,
          attempts,
          ...(result.status !== undefined ? { status: result.status } : {}),
          ...(result.latencyMs !== undefined ? { latencyMs: Math.round(result.latencyMs) } : {}),
          ...(result.bytes !== undefined ? { bytes: result.bytes, truncated: result.truncated === true } : {}),
          ...(result.bodyDigest ? { bodyDigest: result.bodyDigest } : {}),
          ...(result.tlsExpiresAt ? { tlsExpiresAt: result.tlsExpiresAt } : {}),
          ...(result.address ? { address: result.address } : {}),
          ...(result.reason ? { reason: safeText(result.reason, 200) } : {}),
        };
      });
      const body = { checks: probes.length, failed, unknown, hosts: rows, skipped };
      const evidence = await rt.evidence(ec.scope, { kind: "http_probe", digest: digest(body), summary: body, simulated: false, key: `app:${digest(rows.map((r) => [r.host, r.status, r.outcome])).slice(0, 16)}` }, { critical: false });

      const passed = rows.filter((r) => r.result === "passed");
      if (ec.deploymentId && passed.length > 0) {
        const outputs: Output[] = passed.map((r) => ({ key: `url:${r.host}`, label: r.host, value: `https://${r.host}/`, kind: "url", targetId: `dns_record/${r.host}`, simulated: false }));
        await rt.d.product.recordOutputs({ workspaceId: ec.workspaceId, environmentId: ec.environmentId, deploymentId: ec.deploymentId, outputs }).catch((err) => rt.log("warn", "could not record outputs", { error: errorText(err) }));
      }
      const first = rows[0];
      return {
        status: failed > 0 ? "failed" : unknown > 0 ? "unknown" : "passed",
        checks: probes.length,
        failed,
        url: `https://${first.host}`,
        ...(evidence ? { evidenceId: evidence.id } : {}),
      } satisfies VerifyStepResult;
    },

    async observeEnvironment({ operationId }) {
      const ec = await loadExecContext(rt, operationId);
      const { graph } = requireExecutable(rt, ec);
      return observeAndDiff(rt, ec, graph, undefined, "observe environment", ec.op.id);
    },

    async reconcileObserve(input) {
      const { passId, workspaceId, environmentId, lease } = input;
      if (passId !== `reconcile-${environmentId}` || lease.scope !== `reconcile:${environmentId}`) {
        throw new StepFailedError("The reconcile pass does not match its environment or lease; refusing to observe.");
      }
      const owner = await rt.d.product.resolveEnvironment(environmentId);
      if (!owner || owner.workspaceId !== workspaceId) throw new StepFailedError("The environment to reconcile was not found in this workspace.");
      const ports = await reconcilePassPorts();
      if (!ports.loadEnvironment) throw new ReconcileError("platform_store_unavailable", "The canonical reconciliation environment lookup is not configured.");
      return createHeldReconcileActivity(rt, { ports, loadEnvironment: ports.loadEnvironment, loadGraph: ports.loadGraph })(input);
    },
  };
}
