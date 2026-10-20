/**
 * Real transport for the durable intent relay (Node only; imports the Temporal
 * client). Every call carries the intent id as the receiver-side idempotency key.
 *
 *  - workflow_signal: `SignalWorkflowExecution` with `requestId = intent id`, which
 *    Temporal deduplicates inside the target workflow's history. The signal only
 *    wakes or stops the workflow; the database row remains the truth.
 *  - workflow_start: `recoverWorkflowStartIntent` (Describe + first-history readback
 *    first, identical-request resend only inside its bounded window).
 */
import { randomUUID } from "node:crypto";
import type { Client } from "@temporalio/client";
import { platformDb } from "@/lib/controlplane/db";
import * as startIntents from "@/lib/controlplane/db/repos/workflow-start-intents";
import { temporalConfigFromEnv, type TemporalConnectionConfig } from "@/lib/workflows/config";
import { workflowClient } from "@/lib/workflows/client";
import { recoverWorkflowStartIntent, type StartRecoveryDeps } from "@/lib/workflows/start-intent";
import { SIGNALS, WORKFLOW_ID } from "@/lib/workflows/types";
import type { Sql } from "@/lib/controlplane/types";
import { relayOnce, type DeliveryResult, type DurableIntent, type IntentHandlers, type RelayOptions, type RelayResult } from "./index";

const SIGNAL_NAMES: ReadonlySet<string> = new Set(Object.values(SIGNALS));
const RPC_MS = 10_000;

function isNotFound(error: unknown): boolean {
  const e = error as { code?: unknown; cause?: { code?: unknown }; name?: string } | null;
  return !!e && (e.code === 5 || e.cause?.code === 5 || e.name === "WorkflowNotFoundError");
}

export interface TemporalHandlerDeps {
  sql: Sql;
  config?: () => TemporalConnectionConfig;
  client?: (config: TemporalConnectionConfig) => Promise<Client>;
  /** Start-recovery seams (config, client, clock); production passes none. */
  recovery?: StartRecoveryDeps;
}

/** Best effort: the product projection is re-derivable, so its failure never un-delivers the start. */
async function projectStart(sql: Sql, intent: Pick<DurableIntent, "workspaceId" | "operationId">): Promise<boolean> {
  const retained = await startIntents.get(sql, intent.workspaceId, intent.operationId);
  const deploymentId = retained?.binding.arguments.deploymentId;
  if (!retained?.observed_start_at || typeof deploymentId !== "string") return false;
  const { ensureBoot } = await import("@/lib/server/boot");
  await ensureBoot();
  const { projectAcknowledgedStart } = await import("@/lib/bridge/projection");
  const observedAt = new Date(retained.observed_start_at).toISOString();
  const cron = await import("@/lib/server/cron");
  // Same snapshot scope and write-back as the other legacy-product passes.
  return await cron.inCronScope(async () => projectAcknowledgedStart(deploymentId, observedAt));
}

/**
 * System sweep: re-derive the product's `workflowStartedAt` for acknowledged starts
 * whose operation is still live. The relay projects only when it delivers a start,
 * so a lost product save after an in-process acknowledged start (no relay row), or a
 * failed projection after delivery, would otherwise never converge. Idempotent:
 * `projectAcknowledgedStart` never rewrites an existing fact or a finished deployment.
 * Returns how many product records were repaired.
 */
export async function projectAcknowledgedStarts(sql: Sql, limit = 50): Promise<number> {
  const rows = await sql.query<{ workspace_id: string; operation_id: string }>(
    `select i.workspace_id, i.operation_id
       from platform.workflow_start_intents i
       join platform.operations po on po.workspace_id = i.workspace_id and po.id = i.operation_id
      where i.phase = 'acknowledged' and i.observed_start_at is not null
        and po.recovery_epoch = platform.current_recovery_epoch()
        and po.status in ('awaiting_approval','approved','queued','running','uncertain')
      order by i.observed_start_at desc
      limit $1::bigint`,
    [limit]);
  let repaired = 0;
  for (const row of rows) {
    if (await projectStart(sql, { workspaceId: row.workspace_id, operationId: row.operation_id }).catch(() => false)) repaired++;
  }
  return repaired;
}

export function createTemporalIntentHandlers(deps: TemporalHandlerDeps): IntentHandlers {
  const config = deps.config ?? temporalConfigFromEnv;
  const clientFor = deps.client ?? workflowClient;
  return Object.freeze({
    async workflow_signal(intent: DurableIntent): Promise<DeliveryResult> {
      const signal = intent.payload.signal;
      if (typeof signal !== "string" || !SIGNAL_NAMES.has(signal)) return { status: "refused" };
      let cfg: TemporalConnectionConfig;
      try { cfg = config(); } catch { return { status: "retry", code: "temporal_unconfigured" }; }
      // The recorded start binding names the workflow; absent one, the deterministic id.
      const retained = await startIntents.get(deps.sql, intent.workspaceId, intent.operationId).catch(() => null);
      const workflowId = retained?.binding.workflowId ?? WORKFLOW_ID(intent.operationId);
      try {
        const client = await clientFor(cfg);
        await client.withDeadline(Date.now() + RPC_MS, () => client.workflowService.signalWorkflowExecution({
          namespace: cfg.namespace, workflowExecution: { workflowId }, signalName: signal,
          identity: "zenith.durable-intent.v1", requestId: intent.id,
        }));
        return { status: "delivered" };
      } catch (error) {
        return isNotFound(error) ? { status: "not_found" } : { status: "retry", code: "temporal_unavailable" };
      }
    },
    async workflow_start(intent: DurableIntent): Promise<DeliveryResult> {
      const outcome = await recoverWorkflowStartIntent(deps.sql as never, intent.workspaceId, intent.operationId, deps.recovery);
      if (outcome !== "acknowledged") return outcome === "refused" ? { status: "refused" } : { status: "retry", code: "start_unconfirmed" };
      await projectStart(deps.sql, intent).catch(() => undefined);
      return { status: "delivered" };
    },
  });
}

/** One production relay pass: adopt abandoned start intents, deliver every due intent, then repair lost start projections. */
export async function runIntentRelay(options: Partial<RelayOptions> & { sql?: Sql } = {}): Promise<RelayResult & { projected: number }> {
  const { sql: given, ...relayOptions } = options;
  const sql = given ?? await platformDb();
  const result = await relayOnce(sql, createTemporalIntentHandlers({ sql }), { holder: `relay:${randomUUID()}`, ...relayOptions });
  const sweep = relayOptions.adopt !== false && !relayOptions.only;
  return { ...result, projected: sweep ? await projectAcknowledgedStarts(sql).catch(() => 0) : 0 };
}
