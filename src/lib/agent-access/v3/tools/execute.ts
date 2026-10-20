/**
 * MCP execution uses the canonical native broker claim and durable start intent.
 * Deploys require a committed, exact product association and current source
 * semantics before claiming and again before dispatch. Retrying a claimed
 * operation requires its retained intent; attempted starts are read back rather
 * than sent a second time. Browser approval and native final admission remain
 * the authority. Bearer grants never enter the model response or workflow args.
 */
import { BrokerError, isBrokerError, notFound } from "@/lib/capabilities/errors";
import type { OperationView } from "@/lib/capabilities/types";
import { isBackpressureError } from "@/lib/ops/errors";
import { type DayTwoWorkflowInput, type DeployWorkflowInput } from "@/lib/workflows/types";
import { type ToolContext } from "../context";
import type { ToolOutput } from "../envelope";
import { McpToolError, requestCancelled } from "../errors";
import { assertInGrant } from "../principal";
import type { ExecuteApprovedOperationArgs } from "../schemas";
import { nextStepFor } from "./operations";

type Kind = "deploy" | "day_two";

/** The capabilities this tool will start, and which workflow runs them. */
export const EXECUTABLE: Readonly<Record<string, Kind>> = {
  "deployment.deploy": "deploy",
  "service.restart": "day_two",
  "service.scale": "day_two",
  // PROD-LIFE-11: approved portability operations run through the same day-two workflow; approval is a person in the browser.
  "data.export": "day_two",
  "data.import": "day_two",
  "resource.adopt": "day_two",
  "resource.release": "day_two",
  // A machine health read: policy-approved and read-only, run by the same day-two workflow and machine grant path.
  "system.metrics": "day_two",
};

const FINISHED_AFTER_START: ReadonlySet<string> = new Set(["succeeded", "failed", "uncertain"]);

function digestMismatch(): BrokerError {
  return new BrokerError(
    "digest_mismatch",
    "The operation's proposal digest is not the expectedDigest you passed. Nothing was executed.",
    "Use the proposalDigest returned by the propose tool for this operation, exactly. If the operation was re-proposed, it is a different operation."
  );
}

async function deployInput(ctx: ToolContext, op: OperationView): Promise<DeployWorkflowInput> {
  return ctx.ports.deployments.validate(ctx.principal.identity, op);
}

function dayTwoInput(op: OperationView): DayTwoWorkflowInput {
  if (!op.environmentId) throw new McpToolError("operation_input_invalid", "This operation has no environment and cannot be started.", 409);
  return { operationId: op.id, workspaceId: op.workspaceId, environmentId: op.environmentId, capability: op.capability };
}

/** The workflow input, built and validated BEFORE anything is claimed: a malformed operation must not burn an approval. */
async function prepareStart(ctx: ToolContext, kind: Kind, op: OperationView): Promise<(mode: "new" | "retained") => Promise<{ workflowId: string; runId: string }>> {
  if (kind === "deploy") {
    const input = await deployInput(ctx, op);
    return mode => ctx.ports.workflows.startDeploy(input, mode);
  }
  const input = dayTwoInput(op);
  return mode => ctx.ports.workflows.startDayTwo(input, mode);
}

export async function executeApprovedOperation(args: ExecuteApprovedOperationArgs, ctx: ToolContext): Promise<ToolOutput> {
  assertInGrant(ctx.principal, { workspaceId: args.workspaceId });

  const detail = await ctx.broker.getOperationDetail({ workspaceId: args.workspaceId, operationId: args.operationId, principal: ctx.principal.principal });
  const op = detail.operation;
  assertInGrant(ctx.principal, op);

  // Only what was proposed for the person this connection acts for, and only by an integration (not a person in the UI or the Navigator).
  const requester = op.principal.onBehalfOf ?? op.principal.id;
  if (op.principal.kind !== "integration" || requester !== ctx.principal.principal.onBehalfOf
    || op.principal.id !== ctx.principal.principal.id) throw notFound();

  if (op.proposalDigest !== args.expectedDigest) throw digestMismatch();

  const kind = EXECUTABLE[op.capability];
  if (!kind) {
    throw new McpToolError(
      "not_executable",
      `${op.capability} operations cannot be started from MCP. A plan is a record for review; to deploy, propose it with zenith_prepare_deploy.`,
      409
    );
  }

  const approvalUrl = `${ctx.ports.origin()}/platform/operations/${encodeURIComponent(op.id)}`;

  if (op.status === "expired") throw new BrokerError("operation_expired", "The operation expired before it could be executed.", "Propose it again.");

  if (FINISHED_AFTER_START.has(op.status)) {
    // A terminal ledger status does not prove that a workflow was started.
    return {
      data: { operationId: op.id, status: op.status, startedNow: false, nextStep: nextStepFor(op, approvalUrl) },
      notes: [`This operation already finished as ${op.status}. This call did not start or confirm a workflow.`],
    };
  }
  if (op.status === "awaiting_approval") {
    throw new BrokerError("approval_required", "This operation has not been approved. A person must approve it in the Zenith web app.", `Ask the person to open ${approvalUrl}. A yes in chat is not an approval.`, { status: op.status });
  }
  if (op.status !== "approved" && op.status !== "queued" && op.status !== "running") {
    throw new BrokerError("invalid_state", `This operation is ${op.status}; only an approved operation can be executed.`, "Propose it again if the change is still wanted.", { status: op.status });
  }

  // Probe BEFORE claiming: an engine outage must not consume an approval.
  const availability = await ctx.ports.workflows.available();
  if (!availability.available) {
    throw new McpToolError(
      "execution_unavailable",
      "The workflow engine is not reachable, so nothing was started and no approval was consumed.",
      503,
      "Try again later with the same arguments; this call did not claim the operation.",
      { operationStatus: op.status, reason: availability.reason },
      true
    );
  }

  const start = await prepareStart(ctx, kind, op);

  // Last cancellation checkpoint. Before the claim nothing has changed, so a cancelled call stops here
  // and consumes no approval. After the claim the start is driven to a recorded outcome: abandoning a
  // claimed operation midway would strand it, and recovery needs the retained start intent.
  if (ctx.signal?.aborted || ctx.cancel?.aborted) throw requestCancelled("The client cancelled this request before the operation was claimed; nothing was started and no approval was consumed.");
  await ctx.progress?.("claiming the approved operation");

  let startedNow = false;
  let mode: "new" | "retained" = "retained";
  if (op.status === "approved" || op.status === "queued") {
    // PROD-OPS-02: refuse BEFORE the claim so a paused or over-quota dispatch consumes no approval.
    try {
      await (await import("@/lib/ops/admission")).assertDispatchAdmitted({ workspaceId: op.workspaceId, kind: kind === "deploy" ? "deploy" : "dayTwo", operationId: op.id });
    } catch (error) {
      if (!isBackpressureError(error)) throw error;
      throw new McpToolError("dispatch_backpressure", error.message, error.status,
        error.detail?.fix ? `${error.detail.fix} This call did not claim the operation.` : `Retry the same call in about ${error.retryAfterSec} seconds; this call did not claim the operation.`,
        { operationStatus: op.status, reason: error.code, retryAfterSec: error.retryAfterSec, ...(error.detail?.feature ? { feature: error.detail.feature } : {}) }, error.code !== "plan_feature_unavailable");
    }
    try {
      // The returned grant is deliberately not kept: it is a bearer for executing surfaces and has no business in a model-visible process.
      await ctx.broker.beginExecution({ workspaceId: op.workspaceId, operationId: op.id, holder: `workflow:${op.id}`, audience: "worker", leaseMs: 5 * 60_000 });
      startedNow = true;
      mode = "new";
    } catch (error) {
      // Another caller won. Recovery still requires its committed native intent.
      if (!(isBrokerError(error) && error.code === "already_claimed")) throw error;
    }
  }

  let started;
  try {
    if (kind === "deploy") await deployInput(ctx, op);
    await ctx.progress?.("starting the workflow");
    started = await start(mode);
  } catch (error) {
    if (error instanceof McpToolError || isBrokerError(error)) throw error;
    throw new McpToolError(
      "workflow_start_unconfirmed",
      "The operation is claimed but its workflow could not be confirmed started.",
      503,
      "Inspect this operation and its retained start intent. The same call may confirm that retained intent; an unrecorded claim cannot be reconstructed and a transport attempt is never repeated. Do not propose a replacement operation.",
      { operationStatus: startedNow ? "running" : op.status },
      true
    );
  }

  return {
    data: {
      operationId: op.id,
      status: "running",
      startedNow,
      workflow: { id: started.workflowId, runId: started.runId, kind },
      poll: {
        tools: ["zenith_get_operation", "zenith_get_operation_events"],
        hint: "Poll zenith_get_operation every few seconds: it carries the workflow's step progress. The operation ends as succeeded, failed or uncertain; succeeded is not proof of health, so check logs and metrics afterwards.",
      },
    },
    notes: startedNow
      ? ["The operation was claimed and its workflow start was confirmed."]
      : ["The operation was already claimed; its retained durable intent and original workflow execution were confirmed."],
  };
}
