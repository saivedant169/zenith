import type { Client } from "@temporalio/client";
import { temporal } from "@temporalio/proto";
import { digest } from "@/lib/controlplane/digest";

const enums = temporal.api.enums.v1;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const RPC_MS = 10_000;
function isNotFound(error: unknown): boolean {
  const e = error as { code?: unknown; cause?: { code?: unknown }; name?: string } | null;
  return !!e && (e.code === 5 || e.cause?.code === 5 || e.name === "WorkflowNotFoundError");
}
/** Closure of one recorded start, for teardown settlement (WP3). Only an authenticated Describe in the bound namespace answers;
 * anything it cannot read exactly is `unknown`, which never settles. NotFound is reported as such: the database horizon
 * (start deadline plus recovery window) decides whether it may settle. */
export type StartClosure = "closed" | "not_found" | "open" | "unknown";
/** The recorded start's endpoint identity, computed exactly as start-intent.ts records it. */
export const startEndpointDigest = (config: { address: unknown; tls: unknown }): string => digest({ address: config.address, tls: config.tls });
export async function startClosure(client: Client, endpointDigest: string, binding: { namespace: string; workflowId: string; endpointDigest: string },
  runId: string | null): Promise<StartClosure> {
  // A Describe from another cluster that happens to share the namespace name proves nothing about this start.
  if (endpointDigest !== binding.endpointDigest || client.options.namespace !== binding.namespace || !binding.workflowId || (runId !== null && !UUID.test(runId))) return "unknown";
  try {
    const described = await client.withDeadline(Date.now() + RPC_MS, () => client.workflowService.describeWorkflowExecution({
      namespace: binding.namespace, execution: { workflowId: binding.workflowId, ...(runId ? { runId } : {}) },
    }));
    const info = described.workflowExecutionInfo;
    if (!info || info.execution?.workflowId !== binding.workflowId || (runId && info.execution?.runId !== runId)) return "unknown";
    const S = enums.WorkflowExecutionStatus;
    // A continued-as-new run hands off to a new run that may still be writing: open, never closed.
    if (info.status === S.WORKFLOW_EXECUTION_STATUS_RUNNING || info.status === S.WORKFLOW_EXECUTION_STATUS_CONTINUED_AS_NEW) return "open";
    return [S.WORKFLOW_EXECUTION_STATUS_COMPLETED, S.WORKFLOW_EXECUTION_STATUS_FAILED, S.WORKFLOW_EXECUTION_STATUS_CANCELED,
      S.WORKFLOW_EXECUTION_STATUS_TERMINATED, S.WORKFLOW_EXECUTION_STATUS_TIMED_OUT].includes(info.status as never) ? "closed" : "unknown";
  } catch (error) {
    return isNotFound(error) ? "not_found" : "unknown";
  }
}
