/**
 * Conditional execution-ledger writes. These are tenant-scoped repository
 * primitives; the operations service commits their events in the same tx.
 * Optional fences are asserted under a lock and must match the recorded claim.
 * A suspension clears the claim, opens a new approval round and never reuses
 * earlier human decisions. Metadata never changes a terminal operation.
 */
import type { OperationRecord, Sql } from "@/lib/controlplane/types";
import { requireText } from "../errors";
import { requireDigest } from "../sql";
import { assertFence } from "./leases";
import { OPERATION_COLUMNS, toOperation, type OperationRow } from "./operations";

export interface ExecutionWriteInput {
  workspaceId: string;
  id: string;
  fence?: { scope: string; fenceToken: number };
}

/** A changed row, or null for a missing/foreign row, stale state or repeat. */
async function write(sql: Sql, input: ExecutionWriteInput, statement: string, extra: readonly unknown[] = [], lockOperation = false): Promise<OperationRecord | null> {
  const workspaceId = requireText("workspaceId", input.workspaceId);
  const id = requireText("id", input.id);
  const run = async (tx: Sql): Promise<OperationRecord | null> => {
    if (input.fence) await assertFence(tx, input.fence.scope, input.fence.fenceToken);
    if (lockOperation) {
      // A separate statement after this lock sees approvals committed by a
      // reviewer we waited behind, even when their partial set left status
      // unchanged. An EXISTS in the UPDATE alone uses an older PG snapshot.
      const locked = await tx.query("select id from platform.operations where workspace_id = $1 and id = $2 for update", [workspaceId, id]);
      if (locked.length === 0) return null;
    }
    const rows = await tx.query<OperationRow>(statement, [workspaceId, id, input.fence?.scope ?? null, input.fence?.fenceToken ?? null, ...extra]);
    return rows.length ? toOperation(rows[0]) : null;
  };
  return input.fence || lockOperation ? sql.tx(run) : run(sql);
}

const FENCE = "($3::text is null or (lease_scope = $3::text and fence_token = $4::bigint))";

/** Only a live running claim may open a new gate. The environment lease itself is not released here. */
export async function suspendForApproval(sql: Sql, input: ExecutionWriteInput): Promise<OperationRecord | null> {
  return write(sql, input,
    `update platform.operations set
       status = 'awaiting_approval', approval_required = true, approval_round = approval_round + 1,
       updated_at = clock_timestamp(), lease_holder = null, lease_until = null, lease_scope = null, fence_token = null
     where workspace_id = $1 and id = $2 and status = 'running'
       and expires_at > clock_timestamp() and lease_until > clock_timestamp() and ${FENCE}
     returning ${OPERATION_COLUMNS}`);
}

/**
 * Write-once plan digest. A reviewed plan round cannot acquire a plan after its human decision. A proposal round
 * (round zero, or the fresh round a recovery resume reopens, PROD-OPS-04) is decided before the operation's workflow
 * start is attempted; a plan round is opened by a running workflow, so its decisions come after that attempt.
 */
export async function setPlanDigest(sql: Sql, input: ExecutionWriteInput & { planDigest: string }): Promise<OperationRecord | null> {
  const planDigest = requireDigest("planDigest", input.planDigest);
  return write(sql, input,
    `update platform.operations o set plan_digest = $5, updated_at = clock_timestamp()
     where workspace_id = $1 and id = $2 and plan_digest is null
       and status in ('proposed','awaiting_approval','approved','queued','running')
       and expires_at > clock_timestamp() and ${FENCE}
       and (approval_round = 0 or not exists (select 1 from platform.approvals a
             where a.workspace_id = $1 and a.operation_id = $2 and a.approval_round = o.approval_round
               and not exists (select 1 from platform.workflow_start_intents w
                     where w.workspace_id = $1 and w.operation_id = $2 and w.attempted_at is not null and a.created_at < w.attempted_at)))
     returning ${OPERATION_COLUMNS}`, [planDigest], true);
}

/**
 * Link the plan's latest decision, only in running/awaiting_approval, only for
 * this operation (or an unbound decision) in the same workspace. Once a human
 * has reviewed this round its requirements cannot be changed underneath them.
 */
export async function setPolicyDecision(sql: Sql, input: ExecutionWriteInput & { decisionId: string }): Promise<OperationRecord | null> {
  const decisionId = requireText("decisionId", input.decisionId);
  return write(sql, input,
    `update platform.operations o set policy_decision_id = $5, updated_at = clock_timestamp()
     where workspace_id = $1 and id = $2 and status in ('running','awaiting_approval')
       and policy_decision_id is distinct from $5::text and expires_at > clock_timestamp() and ${FENCE}
       and exists (select 1 from platform.policy_decisions d
                   where d.workspace_id = $1 and d.id = $5 and (d.operation_id is null or d.operation_id = $2))
       and (status = 'running' or not exists (select 1 from platform.approvals a
             where a.workspace_id = $1 and a.operation_id = $2 and a.approval_round = o.approval_round))
     returning ${OPERATION_COLUMNS}`, [decisionId], true);
}

/** Execution-time policy refusal before claiming: approved → denied. */
export async function deny(sql: Sql, input: ExecutionWriteInput & { decisionId: string }): Promise<OperationRecord | null> {
  const decisionId = requireText("decisionId", input.decisionId);
  return write(sql, input,
    `update platform.operations set status = 'denied', policy_decision_id = $5,
       finished_at = clock_timestamp(), updated_at = clock_timestamp(), lease_holder = null, lease_until = null
     where workspace_id = $1 and id = $2 and status = 'approved' and ${FENCE}
       and exists (select 1 from platform.policy_decisions d
                   where d.workspace_id = $1 and d.id = $5 and d.outcome = 'deny'
                     and (d.operation_id is null or d.operation_id = $2))
     returning ${OPERATION_COLUMNS}`, [decisionId]);
}
