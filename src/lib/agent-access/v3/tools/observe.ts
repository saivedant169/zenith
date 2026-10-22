/**
 * Observation tools: `zenith_query_logs`, `zenith_query_metrics` and
 * `zenith_investigate_incident`.
 *
 * Order of operations, always:
 *
 *  1. the grant restrictions (before the broker),
 *  2. `authorizeRead` — policy, integration scope, autonomy; it issues a short
 *     read grant whose claims bind capability, workspace, project and environment,
 *  3. only then the product store and the cloud. A cloud read happens inside the
 *     credential broker's session callback (`ObservabilityPort.withFabric`),
 *     opened with those claims; credentials never leave it.
 *
 * Everything that comes back is the fabric's already-bounded, already-redacted
 * answer. Log lines, event text and metric labels are untrusted data and are
 * returned only under `untrusted_data`. A backend that could not be read is an
 * `unavailable` entry naming it; `simulated` and `truncated` are carried through
 * unchanged. Nothing here fills a gap with a guess.
 */
import { ObservabilityInputError } from "@/lib/observability/query";
import { addressesForService, authorizeReadOrThrow, graphFor, pickManifest, requireEnvironment, requireProject, resolveRange, type ToolContext } from "../context";
import type { ToolOutput } from "../envelope";
import { McpToolError } from "../errors";
import { assertInGrant } from "../principal";
import type { InvestigateIncidentArgs, QueryLogsArgs, QueryMetricsArgs, SearchEventsArgs, SearchTracesArgs } from "../schemas";

const LOG_LIMIT_DEFAULT = 100;

/** A malformed query is the caller's bug: a 400 naming the problems, never a crash. */
function asInvalidInput(error: unknown): never {
  if (error instanceof ObservabilityInputError) {
    throw new McpToolError("invalid_input", `The query is invalid (${error.issues.slice(0, 5).map((i) => i.slice(0, 120)).join("; ")}).`, 400);
  }
  throw error;
}

async function prepare(ctx: ToolContext, capability: string, target: { workspaceId: string; projectId: string; environmentId: string }, serviceId?: string) {
  assertInGrant(ctx.principal, target);
  const auth = await authorizeReadOrThrow(ctx, capability, { workspaceId: target.workspaceId, projectId: target.projectId, environmentId: target.environmentId });
  const project = await requireProject(ctx, target.workspaceId, target.projectId);
  const environment = await requireEnvironment(ctx, target.workspaceId, target.projectId, target.environmentId);
  const { manifest } = await pickManifest(ctx, { workspaceId: target.workspaceId, project, environment });
  const graph = graphFor(manifest, environment);
  const addresses = serviceId ? addressesForService(graph, serviceId) : undefined;
  return { auth, environment, graph, addresses };
}

/* -------------------------------- query_logs -------------------------------- */

export async function queryLogs(args: QueryLogsArgs, ctx: ToolContext): Promise<ToolOutput> {
  const { target } = args;
  const range = resolveRange(args, ctx.ports.now());
  const { auth, environment, graph, addresses } = await prepare(ctx, "logs.read", target, args.serviceId);
  const limit = args.limit ?? LOG_LIMIT_DEFAULT;

  let result;
  try {
    result = await ctx.ports.observability.withFabric({ workspaceId: target.workspaceId, environment, graph, grant: auth.claims }, (fabric) =>
      fabric.searchLogs(
        {
          scope: { workspaceId: target.workspaceId, projectId: target.projectId, environmentId: target.environmentId, ...(addresses ? { addresses } : {}) },
          range,
          ...(args.text ? { text: args.text } : {}),
          ...(args.minSeverity ? { minSeverity: args.minSeverity } : {}),
          limit,
        },
        ctx.signal
      )
    );
  } catch (error) {
    asInvalidInput(error);
  }

  return {
    data: { count: result.items.length, limit, range, sources: result.sources, ...(result.telemetry ? { telemetry: result.telemetry } : {}) },
    untrusted: { logs: result.items },
    simulated: result.simulated,
    unavailable: result.unavailable,
    truncated: result.truncated,
    notes: result.notes ?? [],
  };
}

/* ------------------------- search_events / search_traces ------------------------- */

/** Provider and resource events (e.g. k8s.pod.backoff, deployment.rollout) under the events.read grant. */
export async function searchEvents(args: SearchEventsArgs, ctx: ToolContext): Promise<ToolOutput> {
  const { target } = args;
  const range = resolveRange(args, ctx.ports.now());
  const { auth, environment, graph, addresses } = await prepare(ctx, "events.read", target, args.serviceId);
  const limit = args.limit ?? LOG_LIMIT_DEFAULT;
  let result;
  try {
    result = await ctx.ports.observability.withFabric({ workspaceId: target.workspaceId, environment, graph, grant: auth.claims }, (fabric) =>
      fabric.searchEvents({ scope: { workspaceId: target.workspaceId, projectId: target.projectId, environmentId: target.environmentId, ...(addresses ? { addresses } : {}) }, range, limit }, ctx.signal));
  } catch (error) {
    asInvalidInput(error);
  }
  return {
    data: { count: result.items.length, limit, range, sources: result.sources, ...(result.telemetry ? { telemetry: result.telemetry } : {}) },
    untrusted: { events: result.items },
    simulated: result.simulated,
    unavailable: result.unavailable,
    truncated: result.truncated,
    notes: result.notes ?? [],
  };
}

/** Trace summaries under the traces.read grant; a backend without traces answers unavailable, never a guess. */
export async function searchTraces(args: SearchTracesArgs, ctx: ToolContext): Promise<ToolOutput> {
  const { target } = args;
  const range = resolveRange(args, ctx.ports.now());
  const { auth, environment, graph, addresses } = await prepare(ctx, "traces.read", target, args.serviceId);
  const limit = args.limit ?? LOG_LIMIT_DEFAULT;
  let result;
  try {
    result = await ctx.ports.observability.withFabric({ workspaceId: target.workspaceId, environment, graph, grant: auth.claims }, (fabric) =>
      fabric.searchTraces({ scope: { workspaceId: target.workspaceId, projectId: target.projectId, environmentId: target.environmentId, ...(addresses ? { addresses } : {}) }, range, limit }, ctx.signal));
  } catch (error) {
    asInvalidInput(error);
  }
  return {
    data: { count: result.items.length, limit, range, sources: result.sources, ...(result.telemetry ? { telemetry: result.telemetry } : {}) },
    untrusted: { traces: result.items },
    simulated: result.simulated,
    unavailable: result.unavailable,
    truncated: result.truncated,
    notes: result.notes ?? [],
  };
}

/* ------------------------------- query_metrics ------------------------------ */

export async function queryMetrics(args: QueryMetricsArgs, ctx: ToolContext): Promise<ToolOutput> {
  const { target } = args;
  const range = resolveRange(args, ctx.ports.now());
  const { auth, environment, graph, addresses } = await prepare(ctx, "metrics.read", target, args.serviceId);

  let result;
  try {
    result = await ctx.ports.observability.withFabric({ workspaceId: target.workspaceId, environment, graph, grant: auth.claims }, (fabric) =>
      fabric.queryMetrics(
        {
          scope: { workspaceId: target.workspaceId, projectId: target.projectId, environmentId: target.environmentId, ...(addresses ? { addresses } : {}) },
          range,
          metrics: args.metrics,
          ...(args.stepSec ? { stepSec: args.stepSec } : {}),
        },
        ctx.signal
      )
    );
  } catch (error) {
    asInvalidInput(error);
  }

  return {
    data: { seriesCount: result.items.length, range, sources: result.sources, requested: args.metrics, ...(result.telemetry ? { telemetry: result.telemetry } : {}) },
    untrusted: { series: result.items },
    simulated: result.simulated,
    unavailable: result.unavailable,
    truncated: result.truncated,
    notes: result.notes ?? [],
  };
}

/* -------------------------- investigate_incident --------------------------- */

export async function investigateIncident(args: InvestigateIncidentArgs, ctx: ToolContext): Promise<ToolOutput> {
  const { target } = args;
  const range = resolveRange({ lastMinutes: args.lastMinutes }, ctx.ports.now());
  assertInGrant(ctx.principal, target);
  const auth = await authorizeReadOrThrow(ctx, "incident.investigate", { workspaceId: target.workspaceId, projectId: target.projectId, environmentId: target.environmentId });
  await requireProject(ctx, target.workspaceId, target.projectId);
  await requireEnvironment(ctx, target.workspaceId, target.projectId, target.environmentId);

  const investigator = ctx.ports.investigator;
  if (!investigator.available) {
    return {
      data: { investigated: false },
      unavailable: [{ source: "incident-engine", reason: investigator.reason ?? "The incident engine is not connected on this deployment." }],
      notes: ["No investigation was run and no hypothesis is implied. Read logs, metrics and operations directly, or ask a person to investigate."],
    };
  }

  const investigation = await investigator.investigate({
    workspaceId: target.workspaceId,
    projectId: target.projectId,
    environmentId: target.environmentId,
    ...(args.incidentId ? { incidentId: args.incidentId } : {}),
    ...(args.symptom ? { symptom: args.symptom } : {}),
    range,
    grant: auth.claims,
    signal: ctx.signal,
  });

  return {
    data: {
      investigated: true,
      investigationId: investigation.id,
      startedAt: investigation.startedAt,
      finishedAt: investigation.finishedAt,
      path: investigation.path.map((p) => ({ hop: p.hop, status: p.status })),
      evidence: investigation.evidence.map((e) => ({ id: e.id, hop: e.hop, outcome: e.outcome, observedAt: e.observedAt, simulated: e.simulated })),
      hypotheses: investigation.hypotheses.map((h) => ({
        id: h.id,
        code: h.code,
        confidence: h.confidence,
        category: h.category,
        supportingEvidence: h.supportingEvidence,
        contradictingEvidence: h.contradictingEvidence,
        remediations: h.remediations.map((r) => ({ id: r.id, risk: r.risk, approvalRequired: r.approvalRequired })),
      })),
    },
    untrusted: {
      pathAddresses: investigation.path.map((p) => ({ hop: p.hop, address: p.address })),
      evidence: investigation.evidence.map((e) => ({ id: e.id, address: e.address, check: e.check, finding: e.finding, data: e.data })),
      hypotheses: investigation.hypotheses.map((h) => ({
        id: h.id,
        title: h.title,
        remediations: h.remediations.map((r) => ({ id: r.id, title: r.title, expectedEffect: r.expectedEffect, reversibility: r.reversibility, request: r.request })),
      })),
      recentChanges: investigation.recentChanges,
    },
    simulated: investigation.simulated,
    notes: ["Confidence is computed from which checks passed or failed, by rule. Remediations are exact proposals; submit them through the propose tools. Nothing was changed."],
  };
}
