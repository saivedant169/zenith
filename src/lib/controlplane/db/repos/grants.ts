/**
 * The capability-grant ledger (`CapabilityGrantClaims`).
 *
 * The signed grant (JWT) is verified by the execution surface; this table is
 * what makes it *single-use and revocable*: the broker records each issued
 * `jti`, and `consume(jti)` is one conditional UPDATE that succeeds exactly
 * once — the second presenter of the same grant gets `false`. Nothing here
 * stores the token itself, only its identity, scope and lifecycle timestamps.
 */
import type { Sql } from "@/lib/controlplane/types";
import { ControlStoreError, requireText } from "../errors";
import { NATIVE_OPERATION_WRITES } from "@/lib/ownership/conflicts";
import { assertFence } from "./leases";
import { lockForGrant } from "./ownership-transfers";
import { textArray } from "../sql";

export interface GrantRecord {
  jti: string;
  workspaceId: string;
  operationId: string;
  capability: string;
  audience: string;
  issuedAt: string;
  expiresAt: string;
  consumedAt?: string;
  revokedAt?: string;
}

export type GrantStatus = "active" | "consumed" | "revoked" | "expired" | "unknown";

interface GrantRow {
  jti: string;
  workspace_id: string;
  operation_id: string;
  capability: string;
  audience: string;
  issued_at: string;
  expires_at: string;
  consumed_at: string | null;
  revoked_at: string | null;
}

const COLUMNS = "jti, workspace_id, operation_id, capability, audience, issued_at, expires_at, consumed_at, revoked_at";

const toGrant = (row: GrantRow): GrantRecord => ({
  jti: row.jti,
  workspaceId: row.workspace_id,
  operationId: row.operation_id,
  capability: row.capability,
  audience: row.audience,
  issuedAt: row.issued_at,
  expiresAt: row.expires_at,
  consumedAt: row.consumed_at ?? undefined,
  revokedAt: row.revoked_at ?? undefined,
});

export interface InsertGrantInput {
  jti: string;
  workspaceId: string;
  operationId: string;
  capability: string;
  audience: string;
  issuedAt: string;
  expiresAt: string;
}

/**
 * Record an issued grant. `operationId` must be an operation of `workspaceId`
 * (composite foreign key). Grants live at most one hour.
 */
export async function insert(sql: Sql, input: InsertGrantInput): Promise<GrantRecord> {
  const issuedAt = input.issuedAt, expiresAt = input.expiresAt;
  const issued = Date.parse(issuedAt);
  const expires = Date.parse(expiresAt);
  if (!Number.isFinite(issued) || !Number.isFinite(expires) || expires <= issued)
    throw new ControlStoreError("invalid_input", "A grant must expire after it is issued.");
  if (expires - issued > 60 * 60 * 1000) throw new ControlStoreError("invalid_input", "A capability grant may live at most one hour.");
  const args = [requireText("jti", input.jti, 128), requireText("workspaceId", input.workspaceId),
    requireText("operationId", input.operationId), requireText("capability", input.capability, 128),
    requireText("audience", input.audience, 256), issuedAt, expiresAt];
  const [, workspaceId, operationId, grantCapability] = args;
  const originalInsert = async (tx: Sql): Promise<GrantRecord> => {
    const rows = await tx.query<GrantRow>(
      `insert into platform.capability_grants (jti, workspace_id, operation_id, capability, audience, issued_at, expires_at)
       values ($1, $2, $3, $4, $5, $6::timestamptz, $7::timestamptz) returning ${COLUMNS}`, args,
    );
    return toGrant(rows[0]);
  };
  type Owner = { capability: string; lease_scope: string | null; fence_token: number | null };
  const [observed] = await sql.query<Owner>(
    "select capability, lease_scope, fence_token from platform.operations where workspace_id=$1 and id=$2", args.slice(1, 3),
  );
  // Missing/foreign rows retain the existing composite-FK refusal. A read
  // attenuation cannot authorize a field mutation, so its old path is unchanged.
  if (!observed) return originalInsert(sql);
  const ownedCapability = NATIVE_OPERATION_WRITES[observed.capability] !== undefined;
  const requestedOwnershipWrite = NATIVE_OPERATION_WRITES[grantCapability] !== undefined;
  const read = grantCapability === "infrastructure.plan" || grantCapability === "infrastructure.observe";
  const secretSync = grantCapability === "secret.write" && ["deployment.deploy", "deployment.rollback"].includes(observed.capability);
  if ((ownedCapability || requestedOwnershipWrite) && grantCapability !== observed.capability && !read && !secretSync)
    throw new ControlStoreError("conflict", "The grant capability does not match its owning operation.", { reason: "field_ownership_conflict" });
  if (!ownedCapability || read) return originalInsert(sql);

  return sql.tx(async tx => {
    // Same order as native claim: fence, operation, resource/transfer, then
    // the existing cleanup coordinator. Never acquire owning locks after it.
    if (observed.lease_scope !== null && observed.fence_token !== null)
      await assertFence(tx, observed.lease_scope, observed.fence_token);
    const [locked] = await tx.query<Owner>(
      "select capability, lease_scope, fence_token from platform.operations where workspace_id=$1 and id=$2 for update", args.slice(1, 3),
    );
    if (!locked || locked.capability !== observed.capability || locked.lease_scope !== observed.lease_scope || locked.fence_token !== observed.fence_token
      || ((locked.lease_scope === null) !== (locked.fence_token === null)))
      throw new ControlStoreError("conflict", "Current execution ownership changed before grant admission.", { reason: "field_ownership_conflict" });
    const ownership = await lockForGrant(tx, workspaceId, operationId);
    if (ownership === null) return originalInsert(tx);
    // The trigger also takes this coordinator. Waiting for it here ensures
    // expiry is judged by a fresh final statement, rather than before its wait.
    const [schema] = await tx.query<{ present: boolean }>("select to_regclass('platform.cleanup_writer_scopes') is not null as present");
    if (schema!.present) {
      await tx.query("insert into platform.cleanup_writer_scopes(workspace_id) values($1) on conflict do nothing", [workspaceId]);
      await tx.query("select workspace_id from platform.cleanup_writer_scopes where workspace_id=$1 for update", [workspaceId]);
    }
    const rows = await tx.query<GrantRow>(
      `insert into platform.capability_grants (jti, workspace_id, operation_id, capability, audience, issued_at, expires_at)
       select $1, $2, $3, $4, $5, $6::timestamptz, $7::timestamptz from platform.operations o
        where o.workspace_id=$2 and o.id=$3 and o.capability=$8 and o.status='running' and o.expires_at>clock_timestamp()
          and $7::timestamptz>clock_timestamp()
          and o.workspace_id=o.proposal->'scope'->>'workspaceId'
          and o.project_id is not distinct from o.proposal->'scope'->>'projectId'
          and o.environment_id is not distinct from o.proposal->'scope'->>'environmentId'
          and o.resource_id is not distinct from o.proposal->'scope'->>'resourceId'
          and o.lease_scope is not distinct from $9::text and o.fence_token is not distinct from $10::bigint
          and ($9::text is null or exists (select 1 from platform.leases l where l.scope=$9 and l.fence_token=$10
            and l.expires_at>clock_timestamp() and l.released_at is null))
          and not exists (select 1 from unnest($11::text[]) selected(id) where not exists (
            select 1 from platform.ownership_transfers t where t.id=selected.id and t.workspace_id=o.workspace_id
              and t.environment_id=o.environment_id and t.revoked_at is null
              and (t.expires_at is null or t.expires_at>clock_timestamp())))
          and exists (select 1 from platform.resources target where target.workspace_id=o.workspace_id
            and target.environment_id=o.environment_id and target.id=o.resource_id)
          and $12::text::jsonb=coalesce((select jsonb_agg(jsonb_build_object(
            'id', current_node.id, 'address', current_node.address, 'kind', current_node.kind,
            'native_type', current_node.native_type, 'spec', current_node.spec) order by current_node.address)
            from (select id, address, kind, native_type, spec from platform.resources
              where workspace_id=o.workspace_id and environment_id=o.environment_id
              order by address limit 2001) current_node), '[]'::jsonb)
       returning ${COLUMNS}`,
      [...args, locked.capability, locked.lease_scope, locked.fence_token, textArray(ownership.selectedTransferIds), ownership.nodesSnapshot],
    );
    if (rows.length !== 1) throw new ControlStoreError("conflict", "Current field ownership or execution validity changed before grant admission.", { reason: "field_ownership_conflict" });
    return toGrant(rows[0]);
  });
}

/**
 * Consume a grant: true exactly once, and only while it is unexpired, unrevoked
 * and issued in `workspaceId`. When `audience` is given it must equal the
 * grant's. A second consume, a revoked or expired grant, an unknown jti or a
 * grant of another workspace all return false.
 */
export async function consume(sql: Sql, input: { workspaceId: string; jti: string; audience?: string }): Promise<boolean> {
  const workspaceId = requireText("workspaceId", input.workspaceId), jti = requireText("jti", input.jti, 128);
  const once = async (tx: Sql): Promise<boolean> => (await tx.query<{ jti: string }>(
    `update platform.capability_grants set consumed_at = clock_timestamp()
      where workspace_id = $1 and jti = $2 and consumed_at is null and revoked_at is null
        and expires_at > clock_timestamp() and ($3::text is null or audience = $3::text)
      returning jti`,
    [workspaceId, jti, input.audience ?? null]
  )).length > 0;
  const [grant] = await sql.query<{ capability: string; operation_id: string }>(
    "select capability, operation_id from platform.capability_grants where workspace_id = $1 and jti = $2", [workspaceId, jti]);
  if (!grant || NATIVE_OPERATION_WRITES[grant.capability] === undefined) return once(sql);
  // A native field write is re-admitted at consume under the environment coordinator every
  // ownership change takes (field_ownership_conflict when current ownership refuses it). No
  // production path consumes grants today; revocation (migration 59) is the enforced gate.
  return sql.tx(async (tx) => {
    await lockForGrant(tx, workspaceId, grant.operation_id);
    return once(tx);
  });
}

/** Revoke a grant (idempotent; true when it was newly revoked). A consumed grant can still be marked revoked. */
export async function revoke(sql: Sql, workspaceId: string, jti: string): Promise<boolean> {
  const rows = await sql.query<{ jti: string }>(
    `update platform.capability_grants set revoked_at = clock_timestamp()
      where workspace_id = $1 and jti = $2 and revoked_at is null returning jti`,
    [requireText("workspaceId", workspaceId), requireText("jti", jti, 128)]
  );
  return rows.length > 0;
}

/** Revoke every still-live grant of an operation (cancel, lease loss). Returns how many. */
export async function revokeForOperation(sql: Sql, workspaceId: string, operationId: string): Promise<number> {
  const rows = await sql.query<{ jti: string }>(
    `update platform.capability_grants set revoked_at = clock_timestamp()
      where workspace_id = $1 and operation_id = $2 and revoked_at is null and consumed_at is null returning jti`,
    [requireText("workspaceId", workspaceId), requireText("operationId", operationId)]
  );
  return rows.length;
}

export async function get(sql: Sql, workspaceId: string, jti: string): Promise<GrantRecord | null> {
  const rows = await sql.query<GrantRow>(
    `select ${COLUMNS} from platform.capability_grants where workspace_id = $1 and jti = $2`,
    [requireText("workspaceId", workspaceId), requireText("jti", jti, 128)]
  );
  return rows.length ? toGrant(rows[0]) : null;
}

/** Lifecycle status, evaluated on the database clock. */
export async function status(sql: Sql, workspaceId: string, jti: string): Promise<GrantStatus> {
  const rows = await sql.query<{ status: GrantStatus }>(
    `select case
              when revoked_at is not null then 'revoked'
              when consumed_at is not null then 'consumed'
              when expires_at <= clock_timestamp() then 'expired'
              else 'active' end as status
       from platform.capability_grants where workspace_id = $1 and jti = $2`,
    [requireText("workspaceId", workspaceId), requireText("jti", jti, 128)]
  );
  return rows[0]?.status ?? "unknown";
}

/** True only for a grant that exists in `workspaceId` and has been revoked. Unknown jti is NOT "revoked" — use `status` to tell them apart. */
export async function isRevoked(sql: Sql, workspaceId: string, jti: string): Promise<boolean> {
  return (await status(sql, workspaceId, jti)) === "revoked";
}
