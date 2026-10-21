/**
 * Approved field-ownership transfers (PROD-LIFE-12).
 *
 * A transfer row is created in exactly one place: `recordForApprovedOperation`,
 * called by `approvals.record` in the SAME transaction that moves an operation
 * to `approved`. That path already proves a human user decided, on the exact
 * proposal digest. The transfers it records are the ones named in the stored
 * proposal (`proposal.broker.ownershipTransfers`), so an approver reviewed
 * precisely them; nothing a model or caller supplies later can add one.
 *
 * Every function filters on `workspace_id` in SQL; a foreign id is the same as
 * a missing one.
 */
import type { Sql } from "@/lib/controlplane/types";
import { normalizePath } from "@/lib/ownership/paths";
import { transferDigest } from "@/lib/ownership/registry";
import { factsByAddress } from "@/lib/ownership/facts";
import { checkNativeOperation, writesOwnedFields } from "@/lib/ownership/conflicts";
import { defaultFieldOwnershipRegistry } from "@/lib/ownership/registry";
import type { FieldOwner, OwnershipFacts, OwnershipTransfer, OwnershipTransferRequest } from "@/lib/ownership/types";
import type { ResourceNode } from "@/lib/resources/types";
import { ControlStoreError, requireText } from "../errors";
import { newId } from "../sql";

const OWNERS: readonly string[] = ["iac", "native-op", "autoscaler"];
const iso = (v: unknown): string => new Date(v as string).toISOString();

interface Row {
  workspace_id: string;
  address: string;
  resource_type: string;
  field_path: string;
  from_owner: FieldOwner;
  to_owner: FieldOwner;
  transfer_digest: string;
  approval_id: string;
  approved_at: unknown;
  expires_at: unknown;
}

const toTransfer = (r: Row): OwnershipTransfer => ({
  address: r.address,
  resourceType: r.resource_type,
  path: r.field_path,
  from: r.from_owner,
  to: r.to_owner,
  approvalId: r.approval_id,
  approvedAt: iso(r.approved_at),
  ...(r.expires_at ? { expiresAt: iso(r.expires_at) } : {}),
  digest: r.transfer_digest,
});

const COLUMNS = "workspace_id, address, resource_type, field_path, from_owner, to_owner, transfer_digest, approval_id, approved_at, expires_at";
const IDENTITY_COLUMNS = "id, workspace_id, project_id, environment_id, address, resource_type, field_path, from_owner, to_owner, transfer_digest, operation_id, approval_id, proposal_digest, approved_at, expires_at, created_at, revoked_at, revoked_by";

function parseRequests(raw: unknown): OwnershipTransferRequest[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw) || raw.length > 20) throw new ControlStoreError("invalid_input", "ownershipTransfers must be a short list.");
  return raw.map((r): OwnershipTransferRequest => {
    const o = r as Record<string, unknown>;
    const text = (k: string): string => requireText(`ownershipTransfers.${k}`, o[k], 500);
    const from = text("from");
    const to = text("to");
    if (!OWNERS.includes(from) || !OWNERS.includes(to) || from === to) throw new ControlStoreError("invalid_input", "ownershipTransfers names an owner that cannot be transferred.");
    const req = { address: text("address"), resourceType: text("resourceType"), path: normalizePath(text("path")), from: from as FieldOwner, to: to as FieldOwner };
    // The digest is recomputed, never trusted: the approver reviewed the digest, and it must describe these exact fields.
    const digest = transferDigest(req);
    if (o.digest !== digest) throw new ControlStoreError("digest_mismatch", "An ownership transfer's digest does not match its fields.");
    return { ...req, digest };
  });
}

/**
 * Record the transfers named by an approved operation's stored proposal. Call
 * only inside the transaction that approved it. Refuses unless the approval row
 * is a human `approve` on the operation's current proposal digest.
 */
export async function recordForApprovedOperation(sql: Sql, input: { workspaceId: string; operationId: string; approvalId: string }): Promise<OwnershipTransfer[]> {
  const workspaceId = requireText("workspaceId", input.workspaceId);
  const operationId = requireText("operationId", input.operationId);
  const approvalId = requireText("approvalId", input.approvalId);
  const ops = await sql.query<{ environment_id: string | null; project_id: string | null; proposal_digest: string; transfers: unknown; approval_id: string | null; approved_at: unknown }>(
    `select o.environment_id, o.project_id, o.proposal_digest, o.proposal->'broker'->'ownershipTransfers' as transfers,
            a.id as approval_id, a.created_at as approved_at
       from platform.operations o
       left join platform.approvals a on a.workspace_id = o.workspace_id and a.operation_id = o.id and a.id = $3
        and a.decision = 'approve' and a.proposal_digest = o.proposal_digest and a.approver->>'kind' = 'user'
      where o.workspace_id = $1 and o.id = $2 and o.status = 'approved'`,
    [workspaceId, operationId, approvalId]
  );
  const op = ops[0];
  if (!op) throw new ControlStoreError("operation_not_found", "Approved operation not found.", { id: operationId });
  const requests = parseRequests(op.transfers);
  if (requests.length === 0) return [];
  if (!op.approval_id || !op.environment_id) throw new ControlStoreError("invalid_state", "Ownership transfers need a human approval of this proposal in a specific environment.", { id: operationId });
  const out: OwnershipTransfer[] = [];
  for (const t of requests) {
    const rows = await sql.query<Row>(
      `insert into platform.ownership_transfers
         (id, workspace_id, project_id, environment_id, address, resource_type, field_path, from_owner, to_owner, transfer_digest,
          operation_id, approval_id, proposal_digest, approved_at)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14::timestamptz)
       on conflict (workspace_id, operation_id, transfer_digest) do nothing
       returning ${COLUMNS}`,
      [newId("own"), workspaceId, op.project_id, op.environment_id, t.address, t.resourceType, t.path, t.from, t.to, t.digest, operationId, approvalId, op.proposal_digest, iso(op.approved_at)]
    );
    if (rows.length) {
      out.push(toTransfer(rows[0]));
      continue;
    }
    // A duplicate never rewrites the immutable approval receipt or revives a
    // revoked transfer. Read only the exact original tenant/operation tuple.
    const existing = await sql.query<Row>(
      `select ${IDENTITY_COLUMNS} from platform.ownership_transfers
        where workspace_id = $1 and operation_id = $2 and transfer_digest = $3
          and project_id is not distinct from $4::text and environment_id = $5
          and address = $6 and resource_type = $7 and field_path = $8
          and from_owner = $9 and to_owner = $10 and approval_id = $11
          and proposal_digest = $12 and approved_at = $13::text::timestamptz
          and expires_at is null and revoked_at is null and revoked_by is null`,
      [workspaceId, operationId, t.digest, op.project_id, op.environment_id, t.address, t.resourceType, t.path, t.from, t.to, approvalId, op.proposal_digest, iso(op.approved_at)]
    );
    if (existing.length !== 1)
      throw new ControlStoreError("conflict", "The stored ownership transfer is unavailable or no longer matches this approval.");
    out.push(toTransfer(existing[0]));
  }
  return out;
}

/** Unrevoked, unexpired transfers for one environment (optionally one resource address). */
export async function listActive(sql: Sql, workspaceId: string, environmentId: string, address?: string): Promise<OwnershipTransfer[]> {
  const rows = await sql.query<Row>(
    `select ${COLUMNS} from platform.ownership_transfers
      where workspace_id = $1 and environment_id = $2 and ($3::text is null or address = $3)
        and revoked_at is null and (expires_at is null or expires_at > clock_timestamp())
      order by approved_at, id`,
    [requireText("workspaceId", workspaceId), requireText("environmentId", environmentId), address ?? null]
  );
  return rows.map(toTransfer);
}

/** One-way revocation. Returns false when nothing matched (missing, foreign, or already revoked). */
export async function revoke(sql: Sql, input: { workspaceId: string; transferDigest: string; operationId: string; revokedBy: string }): Promise<boolean> {
  const rows = await sql.query<{ id: string }>(
    `update platform.ownership_transfers set revoked_at = clock_timestamp(), revoked_by = $4
      where workspace_id = $1 and operation_id = $2 and transfer_digest = $3 and revoked_at is null
      returning id`,
    [requireText("workspaceId", input.workspaceId), requireText("operationId", input.operationId), requireText("transferDigest", input.transferDigest, 64), requireText("revokedBy", input.revokedBy, 200)]
  );
  return rows.length > 0;
}

export interface StoredOwnershipGuard {
  node: Pick<ResourceNode, "address" | "nativeType" | "spec">;
  facts: OwnershipFacts;
  transfers: OwnershipTransfer[];
}

/** Must be inside the read/admission transaction; mutation triggers use this exact key. */
async function lockEnvironment(sql: Sql, workspaceId: string, environmentId: string): Promise<void> {
  const [isolation] = await sql.query<{ isolation: string }>("select current_setting('transaction_isolation') as isolation");
  if (isolation?.isolation !== "read committed")
    throw new ControlStoreError("invalid_state", "Field ownership requires a fresh READ COMMITTED snapshot after lock waits.", { reason: "field_ownership_isolation" });
  await sql.query("select pg_advisory_xact_lock(hashtextextended('zenith:field-ownership:' || jsonb_build_array($1::text,$2::text)::text,0))", [workspaceId, environmentId]);
}

/** The facts the broker needs to judge a write to one resource: its node, the environment's autoscalers and its transfers. */
export async function guardFor(sql: Sql, workspaceId: string, environmentId: string, resourceId: string): Promise<StoredOwnershipGuard | null> {
  workspaceId = requireText("workspaceId", workspaceId);
  environmentId = requireText("environmentId", environmentId);
  return sql.tx(async tx => {
    await lockEnvironment(tx, workspaceId, environmentId);
    const rows = await tx.query<{ id: string; address: string; kind: string; native_type: string; spec: Record<string, unknown> }>(
      "select id, address, kind, native_type, spec from platform.resources where workspace_id = $1 and environment_id = $2 order by address limit 2001",
      [workspaceId, environmentId]
    );
    assertCompleteGraph(rows);
    const target = rows.find((r) => r.id === resourceId);
    if (!target) return null;
    const nodes = rows.map((r) => ({ address: r.address, kind: r.kind as ResourceNode["kind"], nativeType: r.native_type, spec: r.spec ?? {} }));
    const facts = factsByAddress({ nodes }).get(target.address) ?? {};
    return {
      node: { address: target.address, nativeType: target.native_type, spec: target.spec ?? {} },
      facts,
      transfers: await listActive(tx, workspaceId, environmentId, target.address),
    };
  });
}

function assertCompleteGraph(rows: readonly unknown[]): void {
  if (rows.length > 2000)
    throw new ControlStoreError("conflict", "The environment ownership graph exceeds the admission limit.", { reason: "field_ownership_graph_limit" });
}

/**
 * Current stored ownership at a final claim/grant admission. The caller already
 * holds the owning operation (and any bound fence) in this transaction. The
 * environment transaction lock also covers new resource/owner inserts through
 * migration 53's triggers. Fresh reads after waiting see the winning mutation.
 * This does not retract a previously issued grant or an in-flight cloud call.
 * Null retains older schemas without the transfer relation. An absent target
 * on a modern schema returns [] so callers still recheck execution validity
 * after the coordinator wait; this is not a positive ownership proof.
 * Returned IDs are database dependencies, not
 * a caller-mintable authorization capability, and need a final live predicate.
 */
export async function lockForOperation(sql: Sql, workspaceId: string, operationId: string): Promise<string[] | null> {
  return (await lockedOwnership(sql, workspaceId, operationId, false))?.selectedTransferIds ?? null;
}

type OwnershipNode = { id: string; address: string; kind: string; native_type: string; status: string; spec: Record<string, unknown>; snapshot: string };

/** Grant admission also binds the complete bounded node inventory. This is a
 * final-statement snapshot dependency held under the shared environment coordinator. */
export async function lockForGrant(sql: Sql, workspaceId: string, operationId: string): Promise<{
  selectedTransferIds: string[]; nodesSnapshot: string;
} | null> {
  return lockedOwnership(sql, workspaceId, operationId, true);
}

async function lockedOwnership(sql: Sql, workspaceId: string, operationId: string, strictInventory: boolean): Promise<{
  selectedTransferIds: string[]; nodesSnapshot: string;
} | null> {
  const [op] = await sql.query<{ capability: string; environment_id: string | null; resource_id: string | null; proposal: { input: Record<string, unknown> } }>(
    "select capability, environment_id, resource_id, proposal from platform.operations where workspace_id=$1 and id=$2",
    [requireText("workspaceId", workspaceId), requireText("operationId", operationId)],
  );
  if (!op) throw new ControlStoreError("operation_not_found", "Operation not found.");
  const changesSize = op.capability === "service.scale" && !!op.proposal?.input && Object.hasOwn(op.proposal.input, "size");
  if (changesSize && (!op.environment_id || !op.resource_id)) throw new ControlStoreError("conflict", "Current size-field ownership refuses this operation.");
  if (!writesOwnedFields(op.capability) || !op.environment_id || !op.resource_id) return null;
  await lockEnvironment(sql, workspaceId, op.environment_id);
  // Mutation triggers share the coordinator; tuple locks here would invert
  // the order of an UPDATE that already owns its tuple before its trigger waits.
  const nodes = await sql.query<OwnershipNode>(
    `select id, address, kind, native_type, status, spec, jsonb_build_object(
      'id', id, 'address', address, 'kind', kind, 'native_type', native_type, 'spec', spec)::text as snapshot from platform.resources
      where workspace_id=$1 and environment_id=$2 order by address limit $3`,
    [workspaceId, op.environment_id, 2001],
  );
  const target = nodes.find(row => row.id === op.resource_id);
  if (strictInventory && (!target || nodes.length > 2000))
    throw new ControlStoreError("conflict", "Current field ownership inventory is unavailable or exceeds its bound.", { reason: "field_ownership_conflict" });
  assertCompleteGraph(nodes);
  if (changesSize && (!target || target.status === "deleted" || nodes.length >= 2000)) throw new ControlStoreError("conflict", "Current size-field ownership could not be established.");
  if (!target) {
    const [schema] = await sql.query<{ present: boolean }>("select to_regclass('platform.ownership_transfers') is not null as present");
    return schema?.present ? { selectedTransferIds: [], nodesSnapshot: "[]" } : null;
  }
  const rows = await sql.query<Row & { id: string; revoked_at: unknown }>(
    `select id, ${COLUMNS}, revoked_at from platform.ownership_transfers
      where workspace_id=$1 and environment_id=$2 and address=$3 order by id`,
    [workspaceId, op.environment_id, target.address],
  );
  // A separate statement gets a fresh clock after the coordinator wait.
  const [clock] = await sql.query<{ now: string }>("select clock_timestamp() as now");
  const now = new Date(clock!.now);
  const transfers = rows.filter(row => row.revoked_at === null).map(row => ({ row, transfer: toTransfer(row) }));
  const facts = factsByAddress({ nodes: nodes.map(row => ({ address: row.address, kind: row.kind as ResourceNode["kind"], nativeType: row.native_type, spec: row.spec ?? {} })) }).get(target.address) ?? {};
  const conflicts = checkNativeOperation({ capability: op.capability, input: op.proposal.input, node: { address: target.address, nativeType: target.native_type, spec: target.spec ?? {} }, facts, transfers: transfers.map(item => item.transfer), now });
  const selected = new Set<string>();
  for (const conflict of conflicts) {
    // Match the default PlatformBrokerStore's existing IaC warning baseline.
    // If a transfer moved a non-IaC base to IaC, that live receipt is still
    // an enabling dependency: expiry would restore the other base owner.
    const warning = conflict.write.path !== "size" && conflict.verdict === "transfer_required" && conflict.resolution.owner === "iac" && conflict.write.writer === "native-op";
    if (!warning && conflict.verdict !== "allowed") throw new ControlStoreError("conflict", "Current field ownership refuses this operation.", { reason: "field_ownership_conflict" });
    if (conflict.resolution.source !== "transfer") continue;
    // An IaC -> native transfer is not an enabling dependency where this
    // store already permits the native write with its existing IaC warning.
    if (conflict.write.path !== "size" && conflict.resolution.baseOwner === "iac" && conflict.write.writer === "native-op") continue;
    const query = { address: conflict.write.address, resourceType: conflict.write.resourceType, path: conflict.write.path, facts };
    const applicable = transfers.filter(item => defaultFieldOwnershipRegistry.transferApplies(item.transfer, query, conflict.resolution.baseOwner, now))
      .sort((a, b) => Date.parse(b.transfer.approvedAt) - Date.parse(a.transfer.approvedAt) || (a.transfer.digest < b.transfer.digest ? -1 : 1));
    const exact = applicable[0];
    if (!exact || exact.transfer.approvalId !== conflict.resolution.transferId) throw new ControlStoreError("conflict", "Current field ownership refuses this operation.", { reason: "field_ownership_conflict" });
    selected.add(exact.row.id);
  }
  // Preserve PostgreSQL JSONB numbers exactly; parsed JS specs may lose precision.
  return { selectedTransferIds: [...selected].sort(), nodesSnapshot: `[${nodes.map(row => row.snapshot).join(",")}]` };
}
