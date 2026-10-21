/**
 * Recovery epochs and operator continuation (PROD-OPS-04).
 *
 * A restore rewinds the platform database to a point in time. What was single-use, monotonic or already
 * delivered after that point looks fresh again, while workers, Temporal histories and providers still remember
 * the timeline that was lost. The epoch is the fence that makes the rewind visible:
 *
 *  - `bumpRecoveryEpoch` (run once per restore, by the restore runbook with database credentials, never from a
 *    request path) appends the next epoch to the append-only `platform.recovery_epochs`. In the same transaction it
 *    - expires every lease and lifts every fence counter to the new epoch floor, so a pre-restore fence token can
 *      never equal a live fence;
 *    - turns every restored `running` operation into `uncertain` (the executor of the lost timeline is unknowable);
 *    - revokes every unconsumed capability grant and closes every non-terminal runner/zenithd job as not claimed
 *      (queued) or outcome unknown (claimed/running) so a restored envelope cannot be executed a second time;
 *    - turns every restored `claimed`/`dispatched` saved-plan use into `uncertain`;
 *    - turns every restored `pending` external effect into `uncertain` (the provider call may have been made after
 *      the backup), and leaves `accepted`, `uncertain` and `conflict` effects exactly as they are;
 *    - opens one `recovery_items` row for every operation, intent and effect that was in flight.
 *  - Every check that grants authority includes the epoch: approval consumption and counting, the execution claim,
 *    the approval record, intent claim and settle, start-intent adoption and approval-signal derivation, and every
 *    lease acquire (the fence token itself carries the epoch). A row stamped below the current epoch is refused or
 *    waits for a human.
 *  - `decideItem` is the continuation command. A person decides, bound to the exact subject they reviewed:
 *    `resume` reopens an operation with a FRESH approval round in the current epoch (the old approvals stay void),
 *    or re-stamps an intent; `abandon` cancels or supersedes it; `keep_uncertain` records that an uncertain
 *    operation or effect was seen and stays uncertain. Nothing resumes on a timer, and an uncertain effect is
 *    resolved only by the existing evidence-bound resolution (PROD-DUR-07), never here.
 *
 * Honest limit: work that happened AFTER the backup left no trace in the restored database (no operation, no
 * effect row). The epoch cannot replay it, and cannot see it. The runbook's RPO window and the provider
 * reconciliation it prescribes are the answer to that, not this module.
 *
 * Tenancy: `bumpRecoveryEpoch` is a system operation across every tenant by design (a restore is one event for the
 * whole database) and is listed as such in the verify document. Every other function names `workspace_id`.
 */
import { createHash } from "node:crypto";
import { ControlStoreError, requireText } from "@/lib/controlplane/db/errors";
import { clampLimit } from "@/lib/controlplane/db/sql";
import { digest } from "@/lib/controlplane/digest";
import { cancelOperation } from "@/lib/controlplane/operations";
import { emitForOperation } from "@/lib/controlplane/events";
import { revokeForOperation } from "@/lib/controlplane/db/repos/grants";
import type { Sql } from "@/lib/controlplane/types";

/** Epochs are bounded so `epoch * FENCE_EPOCH_STRIDE` stays an exact JavaScript integer. */
export const RECOVERY_EPOCH_MAX = 9000;
export const FENCE_EPOCH_STRIDE = 1_000_000_000;

export type RecoveryItemKind = "operation" | "intent" | "effect";
export type RecoveryDecision = "resume" | "abandon" | "keep_uncertain";
export type RecoveryItemState = "pending" | "resumed" | "abandoned" | "kept_uncertain";

const DECISION_STATE: Readonly<Record<RecoveryDecision, Exclude<RecoveryItemState, "pending">>> = {
  resume: "resumed", abandon: "abandoned", keep_uncertain: "kept_uncertain",
};

export interface RecoveryEpochRecord {
  readonly epoch: number;
  readonly kind: "genesis" | "restore";
  readonly actor: string;
  readonly reason: string;
  readonly restoreRunId: string | null;
  readonly manifestDigest: string | null;
  readonly backupId: string | null;
  readonly backupTakenAt: string | null;
  readonly priorEpoch: number | null;
  readonly observedEpoch: number | null;
  readonly createdAt: string;
}

interface EpochRow {
  epoch: number | string; kind: "genesis" | "restore"; actor: string; reason: string; restore_run_id: string | null;
  manifest_digest: string | null; backup_id: string | null; backup_taken_at: unknown; prior_epoch: number | string | null;
  observed_epoch: number | string | null; created_at: unknown;
}
const EPOCH_COLUMNS = "epoch, kind, actor, reason, restore_run_id, manifest_digest, backup_id, backup_taken_at, prior_epoch, observed_epoch, created_at";
const iso = (v: unknown): string => new Date(v as string).toISOString();
const toEpoch = (r: EpochRow): RecoveryEpochRecord => Object.freeze({
  epoch: Number(r.epoch), kind: r.kind, actor: r.actor, reason: r.reason, restoreRunId: r.restore_run_id,
  manifestDigest: r.manifest_digest, backupId: r.backup_id, backupTakenAt: r.backup_taken_at ? iso(r.backup_taken_at) : null,
  priorEpoch: r.prior_epoch === null ? null : Number(r.prior_epoch), observedEpoch: r.observed_epoch === null ? null : Number(r.observed_epoch),
  createdAt: iso(r.created_at),
});

/** The epoch this database is in. 0 until the first restore. */
export async function currentRecoveryEpoch(sql: Sql): Promise<number> {
  const rows = await sql.query<{ epoch: number | string }>("select platform.current_recovery_epoch() as epoch");
  return Number(rows[0]?.epoch ?? 0);
}

/** True when the operation was recorded before the current recovery epoch (it came back in a restore). */
export async function operationPredatesRestore(sql: Sql, workspaceId: string, operationId: string): Promise<boolean> {
  const rows = await sql.query<{ stale: boolean }>(
    "select (recovery_epoch < platform.current_recovery_epoch()) as stale from platform.operations where workspace_id=$1 and id=$2", [workspaceId, operationId]);
  return rows[0]?.stale === true;
}

/** The lowest fence token a lease acquired in `epoch` can hold. */
export const fenceFloor = (epoch: number): number => epoch * FENCE_EPOCH_STRIDE + 1;
/** The epoch a fence token was issued in. */
export const epochOfFence = (fenceToken: number): number => Math.floor(Math.max(0, fenceToken - 1) / FENCE_EPOCH_STRIDE);

export async function listRecoveryEpochs(sql: Sql, limit = 20): Promise<RecoveryEpochRecord[]> {
  const rows = await sql.query<EpochRow>(`select ${EPOCH_COLUMNS} from platform.recovery_epochs order by epoch desc limit $1::bigint`, [clampLimit(limit, 20, 200)]);
  return rows.map(toEpoch);
}

/** `ri_` + sha256 of the canonical tuple; the same expression is used in SQL for the set-based inserts. */
export function recoveryItemId(epoch: number, workspaceId: string, kind: RecoveryItemKind, ref: string): string {
  return `ri_${createHash("sha256").update(JSON.stringify([epoch, workspaceId, kind, ref])).digest("hex").slice(0, 40)}`;
}
const ID_SQL = (kind: string, ws: string, ref: string): string =>
  `'ri_' || substr(encode(sha256(convert_to('[' || $1::bigint::text || ',' || to_json(${ws})::text || ',"${kind}",' || to_json(${ref})::text || ']', 'UTF8')), 'hex'), 1, 40)`;

/* ----------------------------------- bump ---------------------------------- */

export interface BumpRecoveryInput {
  /** unique per restore attempt; replaying the same id never bumps twice */
  restoreRunId: string;
  actor: string;
  reason: string;
  manifestDigest?: string;
  backupId?: string;
  backupTakenAt?: string;
  /** the highest epoch the live (lost) system is known to have reached, learned outside the database */
  observedEpoch?: number;
  /** the epoch recorded in the backup manifest */
  manifestEpoch?: number;
}

export interface BumpCounts {
  leasesExpired: number;
  operationsMadeUncertain: number;
  operationsHeld: number;
  intentsHeld: number;
  effectsMadeUncertain: number;
  effectsHeld: number;
  planUsesUncertain: number;
  grantsRevoked: number;
  runnerJobsClosed: number;
  machineRequestsClosed: number;
  itemsOpened: number;
}

export interface BumpResult {
  readonly epoch: number;
  readonly priorEpoch: number;
  /** true when this restore run had already bumped; nothing was changed again */
  readonly replayed: boolean;
  readonly counts: BumpCounts;
}

const RESTORED_UNCERTAIN_OPERATION = "The database was restored from a backup; the executor of the lost timeline is unknown, so whether this change was applied is unknown.";
const RESTORED_UNCERTAIN_EFFECT = "Restored from a backup: the provider call may have been made after the backup was taken.";
const RESTORED_JOB = "closed by a restore (recovery epoch): the job's outcome in the lost timeline is unknown";
const RUN_ID = /^[A-Za-z0-9_.:-]{8,128}$/;
const DIGEST = /^[a-f0-9]{64}$/;

const count = async (sql: Sql, text: string, params: readonly unknown[] = []): Promise<number> => Number((await sql.query<{ n: number | string }>(text, params))[0]?.n ?? 0);

/**
 * Append the next recovery epoch and apply it (see the module comment). One transaction: either the new epoch and
 * every consequence commit together or nothing changes. Idempotent per `restoreRunId`.
 */
export async function bumpRecoveryEpoch(sql: Sql, input: BumpRecoveryInput): Promise<BumpResult> {
  if (!RUN_ID.test(input.restoreRunId)) throw new ControlStoreError("invalid_input", "restoreRunId must be 8-128 characters of A-Za-z0-9_.:-.", { field: "restoreRunId" });
  const actor = requireText("actor", input.actor, 200);
  const reason = requireText("reason", input.reason, 500).replace(/[\r\n\t]+/g, " ");
  if (input.manifestDigest !== undefined && !DIGEST.test(input.manifestDigest)) throw new ControlStoreError("invalid_input", "manifestDigest must be a 64-character hex digest.", { field: "manifestDigest" });
  for (const [name, v] of [["observedEpoch", input.observedEpoch], ["manifestEpoch", input.manifestEpoch]] as const)
    if (v !== undefined && (!Number.isInteger(v) || v < 0 || v > RECOVERY_EPOCH_MAX)) throw new ControlStoreError("invalid_input", `${name} must be a whole epoch number.`, { field: name });
  const takenAt = input.backupTakenAt === undefined ? null : new Date(input.backupTakenAt).toISOString();

  return sql.tx(async (tx) => {
    await tx.query("lock table platform.recovery_epochs in exclusive mode");
    const prior = await tx.query<EpochRow>(`select ${EPOCH_COLUMNS} from platform.recovery_epochs where restore_run_id = $1`, [input.restoreRunId]);
    if (prior[0]) {
      const epoch = Number(prior[0].epoch);
      return { epoch, priorEpoch: Number(prior[0].prior_epoch ?? 0), replayed: true, counts: await countsOfEpoch(tx, epoch) };
    }
    const current = await currentRecoveryEpoch(tx);
    const next = Math.max(current, input.observedEpoch ?? 0, input.manifestEpoch ?? 0) + 1;
    if (next > RECOVERY_EPOCH_MAX) throw new ControlStoreError("invalid_state", "The recovery epoch counter is exhausted; contact the maintainers before restoring again.");
    await tx.query(
      `insert into platform.recovery_epochs (epoch, kind, actor, reason, restore_run_id, manifest_digest, backup_id, backup_taken_at, prior_epoch, observed_epoch)
       values ($1::bigint, 'restore', $2, $3, $4, $5, $6, $7::timestamptz, $8::bigint, $9::bigint)`,
      [next, actor, reason, input.restoreRunId, input.manifestDigest ?? null, input.backupId ?? null, takenAt, current, input.observedEpoch ?? null]
    );

    const counts: BumpCounts = {
      leasesExpired: 0, operationsMadeUncertain: 0, operationsHeld: 0, intentsHeld: 0, effectsMadeUncertain: 0, effectsHeld: 0, planUsesUncertain: 0,
      grantsRevoked: 0, runnerJobsClosed: 0, machineRequestsClosed: 0, itemsOpened: 0,
    };

    // 1. Fences: every restored lease is void, and the counters jump to the new epoch floor.
    counts.leasesExpired = await count(tx,
      `with u as (update platform.leases
                     set expires_at = clock_timestamp(), released_at = coalesce(released_at, clock_timestamp()),
                         fence_token = greatest(fence_token, $1::bigint * 1000000000::bigint)
                   returning 1)
       select count(*)::int as n from u`, [next]);

    // 2. Work list first (it records the PRIOR state), then the state changes.
    counts.operationsMadeUncertain = await openItems(tx, next, "operation",
      `select workspace_id, id as ref, environment_id, status as prior_state from platform.operations where status = 'running'`, ["keep_uncertain"]);
    counts.operationsHeld = await openItems(tx, next, "operation",
      `select workspace_id, id as ref, environment_id, status as prior_state from platform.operations
        where status in ('proposed','awaiting_approval','approved','queued') and recovery_epoch < $1::bigint`, ["resume", "abandon"]);
    counts.intentsHeld = await openItems(tx, next, "intent",
      `select i.workspace_id, i.id as ref, o.environment_id, i.kind || ':' || i.state as prior_state
         from platform.durable_intents i join platform.operations o on o.workspace_id = i.workspace_id and o.id = i.operation_id
        where i.state = 'pending' and i.recovery_epoch < $1::bigint`, ["resume", "abandon"]);
    counts.effectsHeld = await openItems(tx, next, "effect",
      `select workspace_id, effect_id as ref, environment_id, state as prior_state from platform.external_effects
        where state in ('pending','accepted','uncertain','conflict') and recovery_epoch < $1::bigint`, ["keep_uncertain"]);
    counts.itemsOpened = counts.operationsMadeUncertain + counts.operationsHeld + counts.intentsHeld + counts.effectsHeld;

    // 3. Restored `running` operations: the executor is unknowable, so uncertain (never re-dispatched).
    const uncertain = await tx.query<{ id: string; workspace_id: string; project_id: string | null; environment_id: string | null; resource_id: string | null; correlation_id: string }>(
      `update platform.operations
          set status = 'uncertain', finished_at = clock_timestamp(), updated_at = clock_timestamp(),
              error = coalesce(error, $1::text), lease_holder = null, lease_until = null
        where status = 'running'
        returning id, workspace_id, project_id, environment_id, resource_id, correlation_id`, [RESTORED_UNCERTAIN_OPERATION]);
    for (const op of uncertain) {
      await revokeForOperation(tx, op.workspace_id, op.id);
      await emitForOperation(tx, { id: op.id, workspaceId: op.workspace_id, projectId: op.project_id ?? undefined, environmentId: op.environment_id ?? undefined, resourceId: op.resource_id ?? undefined, correlationId: op.correlation_id },
        "operation.uncertain", { data: { reason: "restored from a backup", recoveryEpoch: next } });
    }

    // 4. Pending external effects: the call may have been made after the backup. Uncertain, never retried.
    counts.effectsMadeUncertain = await count(tx,
      `with u as (update platform.external_effects
                     set state = 'uncertain', state_reason = $2::text, uncertain_at = clock_timestamp(), updated_at = clock_timestamp(), version = version + 1
                   where state = 'pending' and recovery_epoch < $1::bigint
                   returning workspace_id, effect_id),
            e as (insert into platform.external_effect_events (workspace_id, effect_id, kind, from_state, to_state, actor)
                  select workspace_id, effect_id, 'recovery_epoch', 'pending', 'uncertain', 'system:recovery' from u returning 1)
       select count(*)::int as n from u`, [next, RESTORED_UNCERTAIN_EFFECT]);

    // 4b. A saved plan that was claimed or dispatched in the lost timeline may have been applied after the backup.
    counts.planUsesUncertain = await count(tx,
      `with u as (update platform.plan_artifact_uses set phase = 'uncertain', updated_at = clock_timestamp() where phase in ('claimed','dispatched') returning 1)
       select count(*)::int as n from u`);

    // 5. Outstanding capability grants and queued/in-flight jobs of the lost timeline cannot be used again.
    counts.grantsRevoked = await count(tx,
      `with u as (update platform.capability_grants set revoked_at = clock_timestamp() where revoked_at is null and consumed_at is null returning 1)
       select count(*)::int as n from u`);
    counts.runnerJobsClosed = await count(tx,
      `with u as (update platform.runner_jobs
                     set status = case when status = 'queued' then 'cancelled' else 'timed_out' end,
                         settled_at = clock_timestamp(), lease_until = null, error = coalesce(error, $1::text)
                   where status in ('queued','claimed','running') returning 1)
       select count(*)::int as n from u`, [RESTORED_JOB]);
    counts.machineRequestsClosed = await count(tx,
      `with u as (update platform.machine_requests
                     set status = case when status = 'queued' then 'cancelled' else 'timed_out' end,
                         settled_at = clock_timestamp(), lease_until = null, error = coalesce(error, $1::text)
                   where status in ('queued','claimed','running') returning 1)
       select count(*)::int as n from u`, [RESTORED_JOB]);
    return { epoch: next, priorEpoch: current, replayed: false, counts };
  });
}

/** Insert one pending item per row of `source` (which may use `$1` = the new epoch). Returns how many were opened. */
async function openItems(tx: Sql, epoch: number, kind: RecoveryItemKind, source: string, allowed: readonly RecoveryDecision[]): Promise<number> {
  const allowedLiteral = `'{${allowed.join(",")}}'::text[]`;
  return count(tx,
    `with src as (${source}),
          ins as (insert into platform.recovery_items (id, workspace_id, epoch, kind, ref, environment_id, prior_state, allowed)
                  select ${ID_SQL(kind, "src.workspace_id", "src.ref")}, src.workspace_id, $1::bigint, '${kind}', src.ref, src.environment_id, src.prior_state, ${allowedLiteral}
                    from src
                  on conflict (epoch, workspace_id, kind, ref) do nothing
                  returning 1)
     select count(*)::int as n from ins`, [epoch]);
}

async function countsOfEpoch(tx: Sql, epoch: number): Promise<BumpCounts> {
  const n = (kind: RecoveryItemKind, extra = "") => count(tx, `select count(*)::int as n from platform.recovery_items where epoch = $1::bigint and kind = $2 ${extra}`, [epoch, kind]);
  const operationsMadeUncertain = await n("operation", "and prior_state = 'running'");
  const operationsHeld = (await n("operation")) - operationsMadeUncertain;
  const intentsHeld = await n("intent");
  const effectsHeld = await n("effect");
  return { leasesExpired: 0, operationsMadeUncertain, operationsHeld, intentsHeld, effectsMadeUncertain: 0, effectsHeld, planUsesUncertain: 0, grantsRevoked: 0, runnerJobsClosed: 0, machineRequestsClosed: 0, itemsOpened: operationsMadeUncertain + operationsHeld + intentsHeld + effectsHeld };
}

/* ------------------------------ operator continuation ---------------------- */

export interface RecoveryItem {
  readonly id: string;
  readonly workspaceId: string;
  readonly epoch: number;
  readonly kind: RecoveryItemKind;
  readonly ref: string;
  readonly environmentId: string | null;
  readonly priorState: string;
  readonly allowed: readonly RecoveryDecision[];
  readonly state: RecoveryItemState;
  readonly decidedBy: string | null;
  readonly decisionReason: string | null;
  readonly decidedAt: string | null;
  readonly createdAt: string;
  /** what the subject is now; the decision binds to this */
  readonly subject: Readonly<Record<string, string | number | boolean | null>>;
  /** what a person must send to decide; changes when the subject changes */
  readonly bindingDigest: string;
  /** reasons a `resume` would be refused right now, so a person is told before trying */
  readonly resumeBlockedBy: readonly string[];
}

interface ItemRow {
  id: string; workspace_id: string; epoch: number | string; kind: RecoveryItemKind; ref: string; environment_id: string | null;
  prior_state: string; allowed: string[] | string; state: RecoveryItemState; decided_by: string | null; decision_reason: string | null;
  decided_at: unknown; created_at: unknown;
}
const ITEM_COLUMNS = "id, workspace_id, epoch, kind, ref, environment_id, prior_state, allowed, state, decided_by, decision_reason, decided_at, created_at";
const parseAllowed = (v: string[] | string): RecoveryDecision[] =>
  (Array.isArray(v) ? v : v.replace(/^\{|\}$/g, "").split(",").filter(Boolean)) as RecoveryDecision[];

type Subject = Record<string, string | number | boolean | null>;

async function loadSubject(tx: Sql, row: ItemRow): Promise<{ subject: Subject; resumeBlockedBy: string[] }> {
  const ws = row.workspace_id;
  const blocked: string[] = [];
  if (row.kind === "operation") {
    const r = (await tx.query<{ status: string; approval_round: number; proposal_digest: string; recovery_epoch: number | string; expired: boolean }>(
      `select status, approval_round, proposal_digest, recovery_epoch, (expires_at <= clock_timestamp()) as expired from platform.operations where workspace_id = $1 and id = $2`, [ws, row.ref]))[0];
    if (!r) return { subject: { missing: true }, resumeBlockedBy: ["the operation no longer exists"] };
    const start = (await tx.query<{ phase: string }>("select phase from platform.workflow_start_intents where workspace_id = $1 and operation_id = $2", [ws, row.ref]))[0];
    const open = await count(tx, `select count(*)::int as n from platform.external_effects where workspace_id = $1 and operation_id = $2 and state in ('pending','uncertain','conflict')`, [ws, row.ref]);
    if (!["proposed", "awaiting_approval", "approved", "queued"].includes(r.status)) blocked.push(`the operation is ${r.status}`);
    if (r.expired) blocked.push("the operation has expired; propose it again");
    if (start && start.phase !== "prepared") blocked.push(`a workflow start was already ${start.phase} and a start is never replayed`);
    if (open > 0) blocked.push(`${open} external effect(s) of this operation are unresolved; resolve them first`);
    return {
      subject: { status: r.status, approvalRound: Number(r.approval_round), proposalDigest: r.proposal_digest, recoveryEpoch: Number(r.recovery_epoch), startPhase: start?.phase ?? null, unresolvedEffects: open },
      resumeBlockedBy: blocked,
    };
  }
  if (row.kind === "intent") {
    const r = (await tx.query<{ state: string; claim_epoch: number | string; payload_digest: string; recovery_epoch: number | string }>(
      `select state, claim_epoch, payload_digest, recovery_epoch from platform.durable_intents where workspace_id = $1 and id = $2`, [ws, row.ref]))[0];
    if (!r) return { subject: { missing: true }, resumeBlockedBy: ["the intent no longer exists"] };
    if (r.state !== "pending") blocked.push(`the intent is already ${r.state}`);
    return { subject: { state: r.state, claimEpoch: Number(r.claim_epoch), payloadDigest: r.payload_digest, recoveryEpoch: Number(r.recovery_epoch) }, resumeBlockedBy: blocked };
  }
  const r = (await tx.query<{ state: string; version: number | string; request_digest: string }>(
    `select state, version, request_digest from platform.external_effects where workspace_id = $1 and effect_id = $2`, [ws, row.ref]))[0];
  if (!r) return { subject: { missing: true }, resumeBlockedBy: ["the effect no longer exists"] };
  return { subject: { state: r.state, version: Number(r.version), requestDigest: r.request_digest }, resumeBlockedBy: ["an effect is never resumed; resolve it with evidence"] };
}

export function decisionBinding(item: Pick<RecoveryItem, "id" | "epoch" | "kind" | "ref" | "priorState" | "subject">): string {
  return digest({ format: "zenith.recovery-decision.v1", id: item.id, epoch: item.epoch, kind: item.kind, ref: item.ref, priorState: item.priorState, subject: item.subject });
}

async function toItem(tx: Sql, row: ItemRow): Promise<RecoveryItem> {
  const { subject, resumeBlockedBy } = await loadSubject(tx, row);
  const base = {
    id: row.id, workspaceId: row.workspace_id, epoch: Number(row.epoch), kind: row.kind, ref: row.ref, environmentId: row.environment_id,
    priorState: row.prior_state, allowed: parseAllowed(row.allowed), state: row.state, decidedBy: row.decided_by, decisionReason: row.decision_reason,
    decidedAt: row.decided_at ? iso(row.decided_at) : null, createdAt: iso(row.created_at), subject,
  };
  return Object.freeze({ ...base, bindingDigest: decisionBinding(base), resumeBlockedBy: Object.freeze(base.allowed.includes("resume") ? resumeBlockedBy : []) });
}

export interface RecoveryStatus {
  readonly epoch: number;
  readonly epochs: readonly RecoveryEpochRecord[];
  readonly pending: number;
  readonly decided: number;
}

export async function recoveryStatus(sql: Sql, workspaceId: string): Promise<RecoveryStatus> {
  const ws = requireText("workspaceId", workspaceId, 128);
  const [epochs, pending, decided] = await Promise.all([
    listRecoveryEpochs(sql, 5),
    count(sql, "select count(*)::int as n from platform.recovery_items where workspace_id = $1 and state = 'pending'", [ws]),
    count(sql, "select count(*)::int as n from platform.recovery_items where workspace_id = $1 and state <> 'pending'", [ws]),
  ]);
  return { epoch: epochs[0]?.epoch ?? 0, epochs, pending, decided };
}

export async function listRecoveryItems(sql: Sql, workspaceId: string, filter: { state?: RecoveryItemState; limit?: number } = {}): Promise<RecoveryItem[]> {
  const ws = requireText("workspaceId", workspaceId, 128);
  const rows = await sql.query<ItemRow>(
    `select ${ITEM_COLUMNS} from platform.recovery_items where workspace_id = $1 and ($2::text is null or state = $2) order by epoch desc, created_at, id limit $3::bigint`,
    [ws, filter.state ?? null, clampLimit(filter.limit, 100, 500)]);
  return Promise.all(rows.map((r) => toItem(sql, r)));
}

export async function getRecoveryItem(sql: Sql, workspaceId: string, itemId: string): Promise<RecoveryItem | null> {
  const rows = await sql.query<ItemRow>(`select ${ITEM_COLUMNS} from platform.recovery_items where workspace_id = $1 and id = $2`, [requireText("workspaceId", workspaceId, 128), requireText("itemId", itemId, 64)]);
  return rows[0] ? toItem(sql, rows[0]) : null;
}

export interface DecideInput {
  workspaceId: string;
  itemId: string;
  decision: RecoveryDecision;
  /** the human who decided; recorded, never inferred */
  actor: string;
  reason: string;
  /** the `bindingDigest` the person reviewed */
  bindingDigest: string;
}

/**
 * Apply one explicit human decision to one recovery item, atomically with its consequence. Refused (and nothing
 * changed) when the item is missing or another tenant's, already decided, the decision is not allowed for it, the
 * subject changed since the person reviewed it, or the decision is unsafe right now (`resumeBlockedBy`).
 */
export async function decideItem(sql: Sql, input: DecideInput): Promise<RecoveryItem> {
  const ws = requireText("workspaceId", input.workspaceId, 128);
  const itemId = requireText("itemId", input.itemId, 64);
  const actor = requireText("actor", input.actor, 200);
  const reason = requireText("reason", input.reason, 500).replace(/[\r\n\t]+/g, " ");
  if (!DIGEST.test(input.bindingDigest)) throw new ControlStoreError("invalid_input", "bindingDigest must be a 64-character hex digest.", { field: "bindingDigest" });
  if (!(input.decision in DECISION_STATE)) throw new ControlStoreError("invalid_input", "Unknown recovery decision.", { field: "decision" });

  return sql.tx(async (tx) => {
    const rows = await tx.query<ItemRow>(`select ${ITEM_COLUMNS} from platform.recovery_items where workspace_id = $1 and id = $2 for update`, [ws, itemId]);
    if (!rows[0]) throw new ControlStoreError("not_found", "Recovery item not found.");
    const before = await toItem(tx, rows[0]);
    if (before.state !== "pending") throw new ControlStoreError("conflict", "This recovery item was already decided.", { itemId });
    if (!before.allowed.includes(input.decision)) throw new ControlStoreError("invalid_state", `That decision is not allowed for this item (allowed: ${before.allowed.join(", ")}).`, { itemId });
    if (input.bindingDigest !== before.bindingDigest)
      throw new ControlStoreError("digest_mismatch", "The item changed since you reviewed it. Reload and review its current state.", { itemId });
    if (input.decision === "resume" && before.resumeBlockedBy.length > 0)
      throw new ControlStoreError("invalid_state", `This cannot be resumed: ${before.resumeBlockedBy.join("; ")}.`, { itemId, reason: "resume_blocked" });

    if (input.decision !== "keep_uncertain") await applyDecision(tx, before, input.decision, actor, reason);

    const done = await tx.query(
      `update platform.recovery_items
          set state = $3, decided_by = $4, decision_reason = $5, decision_digest = $6, decided_at = clock_timestamp()
        where workspace_id = $1 and id = $2 and state = 'pending' returning id`,
      [ws, itemId, DECISION_STATE[input.decision], actor, reason, before.bindingDigest]);
    if (done.length !== 1) throw new ControlStoreError("conflict", "This recovery item was already decided.", { itemId });
    return (await getRecoveryItemIn(tx, ws, itemId))!;
  });
}

async function getRecoveryItemIn(tx: Sql, ws: string, id: string): Promise<RecoveryItem | null> {
  return getRecoveryItem(tx, ws, id);
}

async function applyDecision(tx: Sql, item: RecoveryItem, decision: "resume" | "abandon", actor: string, reason: string): Promise<void> {
  const ws = item.workspaceId;
  if (item.kind === "operation") {
    if (decision === "abandon") {
      const op = await cancelOperation(tx, { workspaceId: ws, id: item.ref, reason: `Abandoned after a restore by ${actor}: ${reason}` });
      if (op) return;
      // Already closed (expired, rejected, cancelled, finished): nothing is left to cancel, the decision is still recorded.
      const now = (await tx.query<{ status: string }>("select status from platform.operations where workspace_id = $1 and id = $2", [ws, item.ref]))[0]?.status;
      if (now === undefined || ["running", "proposed", "awaiting_approval", "approved", "queued"].includes(now))
        throw new ControlStoreError("invalid_state", "The operation can no longer be abandoned (it moved).", { itemId: item.id });
      return;
    }
    // resume = reopen: a FRESH approval round in the current epoch. Old approvals stay void (other round, other epoch).
    const rows = await tx.query<{ id: string }>(
      `update platform.operations
          set status = 'awaiting_approval', approval_round = approval_round + 1, approval_required = true,
              recovery_epoch = platform.current_recovery_epoch(), updated_at = clock_timestamp(),
              lease_scope = null, fence_token = null, lease_holder = null, lease_until = null
        where workspace_id = $1 and id = $2 and status in ('proposed','awaiting_approval','approved','queued')
          and recovery_epoch < platform.current_recovery_epoch() and expires_at > clock_timestamp()
        returning id`, [ws, item.ref]);
    if (rows.length !== 1) throw new ControlStoreError("invalid_state", "The operation can no longer be reopened (it moved or was already reopened).", { itemId: item.id });
    const op = (await tx.query<{ id: string; workspace_id: string; project_id: string | null; environment_id: string | null; resource_id: string | null; correlation_id: string }>(
      "select id, workspace_id, project_id, environment_id, resource_id, correlation_id from platform.operations where workspace_id = $1 and id = $2", [ws, item.ref]))[0]!;
    await revokeForOperation(tx, ws, item.ref);
    await emitForOperation(tx, { id: op.id, workspaceId: op.workspace_id, projectId: op.project_id ?? undefined, environmentId: op.environment_id ?? undefined, resourceId: op.resource_id ?? undefined, correlationId: op.correlation_id },
      "operation.prepared", { data: { reason: "reopened after a restore; fresh approval required", recoveryItem: item.id } });
    return;
  }
  if (item.kind === "intent") {
    const rows = decision === "resume"
      ? await tx.query<{ id: string }>(
        `update platform.durable_intents set recovery_epoch = platform.current_recovery_epoch(), lease_until = null, next_attempt_at = clock_timestamp()
          where workspace_id = $1 and id = $2 and state = 'pending' and recovery_epoch < platform.current_recovery_epoch() returning id`, [ws, item.ref])
      : await tx.query<{ id: string }>(
        `update platform.durable_intents set state = 'dead', outcome = 'superseded', settled_at = clock_timestamp(), lease_until = null
          where workspace_id = $1 and id = $2 and state = 'pending' returning id`, [ws, item.ref]);
    if (rows.length !== 1) throw new ControlStoreError("invalid_state", "The intent can no longer be changed (it moved).", { itemId: item.id });
    return;
  }
  throw new ControlStoreError("invalid_state", "An effect is never resumed or abandoned here; resolve it with evidence.", { itemId: item.id });
}
