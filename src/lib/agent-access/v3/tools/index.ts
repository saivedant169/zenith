/**
 * The tool dispatcher: one place where a tool call becomes a broker call.
 *
 *   name ─▶ catalog lookup ─▶ scope check ─▶ strict input parse
 *        ─▶ product-store scope ─▶ handler ─▶ envelope (scrubbed, bounded, labelled)
 *
 * `runTool` never throws: every failure becomes an error envelope with a stable
 * code, so a client sees one shape whatever went wrong. `invokeTool` is the
 * throwing variant for callers that want the exception.
 *
 * There is no handler that is not in `HANDLERS`, no tool that is not in the
 * catalog, and no code path from here to a cloud, a shell or an OpenTofu process
 * except through the broker (and, for reads, a credential-broker session opened
 * with the broker's own grant).
 */
import { TOOL_NAMES, type ToolName } from "../contract";
import { TOOL_SCHEMAS, toolDescriptor } from "../catalog";
import type { ToolContext } from "../context";
import { buildEnvelope, buildErrorEnvelope, type Envelope, type ToolOutput } from "../envelope";
import { mapError, McpToolError, requestCancelled } from "../errors";
import type { McpPrincipal } from "../principal";
import { assertInGrant, requirePluginTool, requireScope, type TargetLike } from "../principal";
import type { McpPorts } from "../ports";
import { executeApprovedOperation } from "./execute";
import { getOperation, getOperationEvents } from "./operations";
import { investigateIncident, queryLogs, queryMetrics, searchEvents, searchTraces } from "./observe";
import { compareRevisions, estimateCost, getCapabilities, getTopology } from "./project";
import { planChange, prepareDeploy, restartService, scaleService } from "./propose";
import { recommendPlacementTool } from "./placement";
import { reviewTeardown } from "./teardown-review";
import { planRunnerConnection } from "./connections";

type Handler = (args: never, ctx: ToolContext) => Promise<ToolOutput>;

const HANDLERS: Record<ToolName, Handler> = {
  zenith_get_topology: getTopology as Handler,
  zenith_get_capabilities: getCapabilities as Handler,
  zenith_plan_change: planChange as Handler,
  zenith_plan_runner_connection: planRunnerConnection as Handler,
  zenith_review_teardown: reviewTeardown as Handler,
  zenith_prepare_deploy: prepareDeploy as Handler,
  zenith_execute_approved_operation: executeApprovedOperation as Handler,
  zenith_query_logs: queryLogs as Handler,
  zenith_query_metrics: queryMetrics as Handler,
  zenith_search_events: searchEvents as Handler,
  zenith_search_traces: searchTraces as Handler,
  zenith_investigate_incident: investigateIncident as Handler,
  zenith_restart_service: restartService as Handler,
  zenith_scale_service: scaleService as Handler,
  zenith_compare_revisions: compareRevisions as Handler,
  zenith_estimate_cost: estimateCost as Handler,
  zenith_recommend_placement: recommendPlacementTool as Handler,
  zenith_get_operation: getOperation as Handler,
  zenith_get_operation_events: getOperationEvents as Handler,
};

export interface InvokeOptions {
  principal: McpPrincipal;
  ports: McpPorts;
  signal?: AbortSignal;
  /** explicit client cancellation only; see ToolContext.cancel */
  cancel?: AbortSignal;
  progress?: (message: string) => Promise<void>;
}

/** Run a tool and return its envelope; throws on any refusal. */
export async function invokeTool(name: string, rawArgs: unknown, options: InvokeOptions): Promise<Envelope> {
  const tool = toolDescriptor(name);
  if (!tool || !(TOOL_NAMES as readonly string[]).includes(name)) throw new McpToolError("unknown_tool", "There is no such tool.", 404);
  requirePluginTool(options.principal, tool.name);
  requireScope(options.principal, tool.name, tool.requiredScope);

  // Every strict schema has one of these two explicit scope shapes.
  const args = TOOL_SCHEMAS[tool.name].parse(rawArgs ?? {}) as { target: TargetLike } | { workspaceId: string };
  // Check the explicit target before even resolving the broker or entering a
  // product-store snapshot. Grant-restricted ids must never touch tenant data.
  const target = "target" in args ? args.target : { workspaceId: args.workspaceId };
  assertInGrant(options.principal, target);
  const run = options.ports.scope(options.principal.identity, async () => {
    const broker = await options.ports.broker();
    const output = await HANDLERS[tool.name](args as never, { principal: options.principal, ports: options.ports, broker, tool, signal: options.signal,
      ...(options.cancel ? { cancel: options.cancel } : {}), ...(options.progress ? { progress: options.progress } : {}) });
    return buildEnvelope(tool, output);
  });
  // A read has no side effect, so an explicit client cancellation can stop waiting for it at once (the
  // work finishes harmlessly in the background). Proposals and execution are NOT raced: they stop at
  // their own checkpoints so a recorded proposal is withdrawn and a claimed operation is never stranded.
  return tool.access === "read" && options.cancel ? raceCancel(run, options.cancel) : run;
}

function raceCancel<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) { void work.catch(() => undefined); return Promise.reject(requestCancelled()); }
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => { void work.catch(() => undefined); reject(requestCancelled()); };
    signal.addEventListener("abort", onAbort, { once: true });
    work.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
}

/** Run a tool and never throw: a refusal is an `ok: false` envelope with a stable code. */
export async function runTool(name: string, rawArgs: unknown, options: InvokeOptions): Promise<Envelope> {
  try {
    return await invokeTool(name, rawArgs, options);
  } catch (error) {
    const tool = toolDescriptor(name) ?? { name: name.slice(0, 64), schemaVersion: 0 };
    // An abort that surfaced as a bare AbortError/TimeoutError is a cancellation, not an internal failure.
    const aborted = options.signal?.aborted === true && error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError" || error === options.signal.reason);
    return buildErrorEnvelope(tool, mapError(aborted ? requestCancelled() : error).body);
  }
}

export { HANDLERS };
