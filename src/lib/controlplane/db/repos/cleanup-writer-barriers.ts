/** Native possible-delivery inventory. Only an authenticated settlement row past its database-clock horizon removes a delivery. */
import type { Sql } from "@/lib/controlplane/types";
import type { Sealed, VaultCipher } from "@/lib/secrets";
import type { InsertGrantInput } from "./grants";

const DELIVERY_SETTLEMENT_FORMAT = "zenith.cleanup.delivery-settlement.v1";
// Liveness bound: a few dozen deploys stay far below it. Above it nothing is verified, so nothing settles (fail closed).
const DELIVERY_SETTLEMENT_LIMIT = 4096;
export interface DeliverySettlementPlain {
  readonly workspaceId: string; readonly family: string; readonly source: string; readonly identity: string; readonly operationId: string;
}
export interface VerifiedDeliverySettlement extends DeliverySettlementPlain { readonly sealed: Sealed }
/** One AAD ref per delivery, so a sealed row cannot be re-pointed at another delivery. */
export function deliverySettlementRef(family: string, source: string, identity: string): string {
  return `${DELIVERY_SETTLEMENT_FORMAT}:${family}:${source}:${identity}`;
}
/** Platform-key seal of the exact delivery it settles. The settlement writer (WP3) and the tests use this seam. */
export function sealDeliverySettlement(cipher: VaultCipher, plain: DeliverySettlementPlain): Sealed {
  return cipher.seal(plain.workspaceId, deliverySettlementRef(plain.family, plain.source, plain.identity),
    JSON.stringify({ format: DELIVERY_SETTLEMENT_FORMAT, ...plain }));
}
async function platformCipher(): Promise<VaultCipher | undefined> {
  try { return (await import("@/lib/platform/plan-artifacts")).planArtifactCipherFromEnv(); } catch { return undefined; }
}
/** Only rows that open under the platform key, for their own delivery, count. Others never settle anything. */
async function verifiedDeliverySettlements(sql: Sql, workspaceId: string, projectId: string, environmentId: string): Promise<readonly VerifiedDeliverySettlement[]> {
  const cipher = await platformCipher();
  if (!cipher) return Object.freeze([]);
  const rows = await sql.query<{ family: string; source: string; identity: string; operationId: string; sealed: Sealed }>(`select family, delivery_source as source,
    delivery_identity as identity, operation_id as "operationId", sealed from platform.cleanup_writer_settlements
    where workspace_id=$1 and (project_id is null or environment_id is null or (project_id=$2 and environment_id=$3))
    order by family, delivery_source, delivery_identity limit $4`, [workspaceId, projectId, environmentId, DELIVERY_SETTLEMENT_LIMIT + 1]);
  if (rows.length > DELIVERY_SETTLEMENT_LIMIT) return Object.freeze([]);
  const verified: VerifiedDeliverySettlement[] = [];
  for (const row of rows) {
    try {
      const sealed = { iv: row.sealed.iv, authTag: row.sealed.authTag, ciphertext: row.sealed.ciphertext };
      const value = JSON.parse(cipher.open(workspaceId, deliverySettlementRef(row.family, row.source, row.identity), sealed).value) as Record<string, unknown>;
      if (value.format === DELIVERY_SETTLEMENT_FORMAT && value.workspaceId === workspaceId && value.family === row.family && value.source === row.source
        && value.identity === row.identity && value.operationId === row.operationId)
        verified.push(Object.freeze({ workspaceId, family: row.family, source: row.source, identity: row.identity, operationId: row.operationId, sealed }));
    } catch { /* unauthenticated or foreign: this row settles nothing */ }
  }
  return Object.freeze(verified);
}

export class CleanupWriterBarrierError extends Error {
  readonly code = "cleanup_writer_unconfirmed";
  constructor() { super("Cleanup writer authority or earlier delivery is unconfirmed; destruction was refused."); }
}
export interface CleanupHold {
  readonly workspaceId: string; readonly projectId: string; readonly environmentId: string;
  readonly operationId: string; readonly attemptId: string; readonly generation: string;
  readonly manifestDigest: string; readonly authorityDigest: string;
}
export interface CleanupInventory {
  readonly unknownHistory: number; readonly grants: number; readonly handoffs: number; readonly reservations: number;
}
/** Tenant-scoped read only. Unknown or pre-epoch history cannot be made green by empty projections. */
export async function preview(sql: Sql, workspaceId: string, projectId: string, environmentId: string): Promise<CleanupInventory> {
  return inventory(sql, workspaceId, projectId, environmentId);
}
/** Internal counted inventory; owner exceptions come only from a privately authenticated held attempt. */
export async function inventory(sql: Sql, workspaceId: string, projectId: string, environmentId: string,
  owner?: Readonly<{operationId:string;attemptId:string;generation:string;jti?:string;controlIdentity?:string}>): Promise<CleanupInventory> {
  return inventoryWithSettlements(sql,workspaceId,projectId,environmentId,owner,"[]");
}
/** The exclusion set is available only from a live private paired origin. No caller list or status can create it. */
export async function inventoryForNativeOrigin(owning:Sql,tx:Sql,origin:unknown):Promise<CleanupInventory> {
  const bound=await (await import("@/lib/platform/plan-artifacts")).readNativeCleanupInventoryOrigin(origin,owning);
  const c=bound.access.custody;
  const holds=await tx.query<{generation:string}>(`select generation from platform.cleanup_writer_holds where workspace_id=$1 and project_id=$2
    and environment_id=$3 and operation_id=$4 and attempt_id=$5 and manifest_digest=$6 and holder=$7 and fence_token=$8`,
    [c.workspaceId,c.projectId,c.environmentId,c.operationId,bound.attempt,bound.manifestDigest,bound.access.lease.holder,bound.access.lease.fenceToken]);
  if(holds.length!==1 || bound.hold && holds[0].generation!==bound.hold.generation)throw new CleanupWriterBarrierError();
  const w=await (await import("./workflow-start-intents")).get(tx,c.workspaceId,c.operationId);
  const op=await (await import("./operations")).get(tx,c.workspaceId,c.operationId);
  const controlIdentity=w && op && w.phase==="acknowledged" && w.binding.kind==="destroy" && op.workflowId===w.binding.workflowId
    && w.binding.arguments.workspaceId===c.workspaceId && w.binding.arguments.operationId===c.operationId && w.binding.arguments.environmentId===c.environmentId
    && w.binding.proposalDigest===c.proposalDigest && w.binding.inputDigest===c.inputDigest ? c.operationId+":"+w.attempt_id : undefined;
  return inventoryWithSettlements(tx,c.workspaceId,c.projectId,c.environmentId,{operationId:c.operationId,attemptId:bound.attempt,
    generation:holds[0].generation,jti:bound.jti,controlIdentity},JSON.stringify(bound.settlements));
}
async function inventoryWithSettlements(sql:Sql,workspaceId:string,projectId:string,environmentId:string,
  owner:Readonly<{operationId:string;attemptId:string;generation:string;jti?:string;controlIdentity?:string}>|undefined,settlements:string):Promise<CleanupInventory> {
  const verified = JSON.stringify(await verifiedDeliverySettlements(sql, workspaceId, projectId, environmentId));
  const rows = await sql.query<CleanupInventory>(`select
    ((select count(*) from platform.operations o where o.workspace_id=$1
      and (o.project_id is null or o.environment_id is null or (o.project_id=$2 and o.environment_id=$3))
      and o.created_at < (select installed_at from platform.cleanup_writer_epoch where singleton))
    + (select count(*) from platform.resources r where r.workspace_id=$1 and (r.project_id is null or r.project_id=$2) and r.environment_id=$3
      and r.created_at < (select installed_at from platform.cleanup_writer_epoch where singleton))
    + case when exists(select 1 from platform.cleanup_writer_epoch where singleton) then 0 else 1 end
    + case when platform.cleanup_scope_epoch_unknown($1,$2,$3) then 1 else 0 end)::integer as "unknownHistory",
    (select count(*) from platform.capability_grants g join platform.operations o on o.workspace_id=g.workspace_id and o.id=g.operation_id
      where g.workspace_id=$1 and (o.project_id is null or o.environment_id is null or (o.project_id=$2 and o.environment_id=$3))
      and g.capability not in ('infrastructure.plan','infrastructure.observe','topology.read','logs.read','metrics.read','traces.read',
        'events.read','incident.investigate','cost.estimate','firewall.inspect','placement.solve','machine.inspect','process.list','service.status',
        'container.list','container.inspect','container.logs','file.read','network.portCheck','network.dnsCheck','system.metrics','system.logs')
      and not platform.cleanup_delivery_settled(g.workspace_id,'grant','capability_grants',g.jti,$10::text::jsonb)
      and not (g.jti is not distinct from $7::text and g.operation_id is not distinct from $4::text))::integer as grants,
    ((select count(*) from platform.cleanup_writer_deliveries d where d.workspace_id=$1
      and (d.project_id is null or d.environment_id is null or (d.project_id=$2 and d.environment_id=$3))
      and not (d.family='plan' and exists(select 1 from jsonb_array_elements($9::text::jsonb) settled
        join platform.standalone_plan_settlements receipt on receipt.workspace_id=$1
          and receipt.operation_id=settled->'receipt'->'binding'->>'operationId' and receipt.attempt_id=settled->'receipt'->'binding'->>'attemptId'
        join platform.plan_artifact_uses terminal on terminal.workspace_id=receipt.workspace_id and terminal.operation_id=receipt.operation_id
        where receipt.project_id=$2 and receipt.environment_id=$3 and d.operation_id=receipt.operation_id and d.attempt_id=receipt.attempt_id
          and d.identity=receipt.operation_id || ':' || receipt.attempt_id and terminal.phase='succeeded' and terminal.attempt_id=receipt.attempt_id
          and receipt.settlement_digest=settled->'receipt'->>'settlementDigest' and receipt.iv=settled->'receipt'->'sealed'->>'iv'
          and receipt.auth_tag=settled->'receipt'->'sealed'->>'authTag' and receipt.ciphertext=settled->'receipt'->'sealed'->>'ciphertext'))
      and not platform.cleanup_delivery_settled(d.workspace_id,case when d.family='machine' then 'runner' else d.family end,
        case d.family when 'workflow' then 'workflow_start_intents' when 'grant' then 'capability_grants' when 'build' then 'build_launches'
          when 'runner' then 'runner_jobs' when 'machine' then 'machine_requests' when 'plan' then 'plan_artifact_uses' end,d.identity,$10::text::jsonb)
      and not (d.operation_id is not distinct from $4::text and
        ((d.family='workflow' and d.identity is not distinct from $8::text)
        or (d.family='grant' and d.identity is not distinct from $7::text and d.attempt_id is not distinct from $5::text)
        or (d.family='plan' and d.attempt_id is not distinct from $5::text))))
    + (select count(*) from platform.workflow_start_intents w join platform.operations o on o.workspace_id=w.workspace_id and o.id=w.operation_id
      where w.workspace_id=$1 and w.phase in ('attempted','acknowledged') and o.capability not in ('infrastructure.plan','infrastructure.observe')
      and (o.project_id is null or o.environment_id is null or (o.project_id=$2 and o.environment_id=$3))
      and not platform.cleanup_delivery_settled(w.workspace_id,'workflow','workflow_start_intents',w.operation_id||':'||w.attempt_id,$10::text::jsonb)
      and not (w.operation_id is not distinct from $4::text and w.operation_id || ':' || w.attempt_id is not distinct from $8::text))
    + (select count(*) from platform.build_launches b join platform.operations o on o.workspace_id=b.workspace_id and o.id=b.operation_id
      where b.workspace_id=$1 and (o.project_id is null or o.environment_id is null or (o.project_id=$2 and o.environment_id=$3))
      and not platform.cleanup_delivery_settled(b.workspace_id,'build','build_launches',b.operation_id||':'||b.service_address||':'||b.attempt_id,$10::text::jsonb))
    + (select count(*) from platform.plan_artifact_uses u join platform.operations o on o.workspace_id=u.workspace_id and o.id=u.operation_id
      where u.workspace_id=$1 and u.phase in ('dispatched','succeeded','uncertain') and o.capability not in ('infrastructure.plan','infrastructure.observe')
      and (o.project_id is null or o.environment_id is null or (o.project_id=$2 and o.environment_id=$3))
      and not exists(select 1 from jsonb_array_elements($9::text::jsonb) settled join platform.standalone_plan_settlements receipt
        on receipt.workspace_id=$1 and receipt.operation_id=settled->'receipt'->'binding'->>'operationId'
          and receipt.attempt_id=settled->'receipt'->'binding'->>'attemptId'
        where receipt.project_id=$2 and receipt.environment_id=$3 and receipt.operation_id=u.operation_id and receipt.attempt_id=u.attempt_id
          and u.phase='succeeded' and receipt.settlement_digest=settled->'receipt'->>'settlementDigest'
          and receipt.iv=settled->'receipt'->'sealed'->>'iv' and receipt.auth_tag=settled->'receipt'->'sealed'->>'authTag'
          and receipt.ciphertext=settled->'receipt'->'sealed'->>'ciphertext')
      and not platform.cleanup_delivery_settled(u.workspace_id,'plan','plan_artifact_uses',u.operation_id||':'||u.attempt_id,$10::text::jsonb)
      and not (u.operation_id is not distinct from $4::text and u.attempt_id is not distinct from $5::text))
    + (select count(*) from platform.runner_jobs j join platform.operations o on o.workspace_id=j.workspace_id and o.id=j.operation_id
      where j.workspace_id=$1 and (j.started_at is not null or j.status in ('claimed','running','uncertain'))
      and j.capability not in ('infrastructure.plan','infrastructure.observe','topology.read','logs.read','metrics.read','traces.read',
        'events.read','incident.investigate','cost.estimate','firewall.inspect','placement.solve','machine.inspect','process.list','service.status',
        'container.list','container.inspect','container.logs','file.read','network.portCheck','network.dnsCheck','system.metrics','system.logs')
      and (o.project_id is null or o.environment_id is null or (o.project_id=$2 and o.environment_id=$3))
      and not platform.cleanup_delivery_settled(j.workspace_id,'runner','runner_jobs',j.id,$10::text::jsonb))
    + (select count(*) from platform.machine_requests j join platform.operations o on o.workspace_id=j.workspace_id and o.id=j.operation_id
      where j.workspace_id=$1 and (j.started_at is not null or j.status in ('claimed','running','uncertain'))
      and j.capability not in ('infrastructure.plan','infrastructure.observe','topology.read','logs.read','metrics.read','traces.read',
        'events.read','incident.investigate','cost.estimate','firewall.inspect','placement.solve','machine.inspect','process.list','service.status',
        'container.list','container.inspect','container.logs','file.read','network.portCheck','network.dnsCheck','system.metrics','system.logs')
      and (o.project_id is null or o.environment_id is null or (o.project_id=$2 and o.environment_id=$3))
      and not platform.cleanup_delivery_settled(j.workspace_id,'runner','machine_requests',j.id,$10::text::jsonb)))::integer as handoffs,
    (select count(*) from platform.cleanup_owner_grants g join platform.cleanup_writer_holds h
      on h.workspace_id=g.workspace_id and h.operation_id=g.operation_id and h.attempt_id=g.attempt_id and h.generation=g.generation
      where g.workspace_id=$1 and h.project_id=$2 and h.environment_id=$3
      and not (g.operation_id is not distinct from $4::text and g.attempt_id is not distinct from $5::text
        and g.generation is not distinct from $6::text and g.jti is not distinct from $7::text))::integer as reservations`,
    [workspaceId,projectId,environmentId,owner?.operationId??null,owner?.attemptId??null,owner?.generation??null,owner?.jti??null,owner?.controlIdentity??null,settlements,verified]);
  const value = rows[0];
  if (!value || Object.values(value).some(n => !Number.isSafeInteger(n) || n < 0)) throw new CleanupWriterBarrierError();
  return Object.freeze(value);
}
/** Only the default paired codec's one-call capability can reach the committing hold path. */
export async function retain(sql: Sql, origin: unknown): Promise<Readonly<{hold:CleanupHold;inventory:CleanupInventory}>> {
  return (await import("./plan-artifacts")).retainCleanupWriterHold(sql,origin);
}
/** Private invocation capability, not operation equality, authorizes one retained JTI. */
export async function reserveOwnerGrant(sql: Sql, origin: unknown, jti: string): Promise<void> {
  await (await import("./plan-artifacts")).reserveCleanupOwnerGrant(sql,origin,jti);
}
/** Signing is local. The fresh native authorization and actual grant INSERT commit together. */
export async function insertOwnerGrant(sql: Sql, origin: unknown, input: InsertGrantInput): Promise<void> {
  await (await import("./plan-artifacts")).insertCleanupOwnerGrant(sql,origin,input);
}

/* --------------------------- settlement writer (WP3) --------------------------- */

export type DeliveryStartClosure = "closed" | "not_found" | "open" | "unknown";
export interface DeliverySettlementPorts {
  /** Authenticated Temporal Describe of a recorded start. Absent: workflow starts are never settled by this pass. */
  readonly startClosure?: (binding: { namespace: string; workflowId: string; endpointDigest: string }, runId: string | null) => Promise<DeliveryStartClosure>;
}
export interface DeliverySettlementPass { readonly written: number; readonly skipped: number }
interface SettlementCandidate {
  ws: string; project: string | null; environment: string | null; op: string; family: string; source: string; identity: string;
  binding: { namespace?: unknown; workflowId?: unknown; endpointDigest?: unknown } | null; run: string | null;
}
const SETTLEMENT_PASS_LIMIT = 200;
/**
 * Worker-only pass: seal and insert a settlement for each possible delivery whose database-clock horizon has passed. The
 * database computes every horizon (platform.cleanup_delivery_source) and its insert trigger refuses anything early, so this
 * pass decides nothing about time. It adds the two checks the database cannot make: a workflow start settles only when an
 * authenticated Describe reports it closed (or NotFound past the horizon), and nothing is written without the platform key.
 * Runner and machine jobs need a verified signed runner result and are not settled here. Cross-workspace by design: it is
 * the janitor's scan, and each row it writes is bound to its own workspace, operation and scope by the trigger.
 */
export async function writeDeliverySettlements(sql: Sql, ports: DeliverySettlementPorts = {},
  options: { cipher?: VaultCipher; limit?: number } = {}): Promise<DeliverySettlementPass> {
  const cipher = options.cipher ?? await platformCipher(), limit = options.limit ?? SETTLEMENT_PASS_LIMIT;
  if (!cipher) return Object.freeze({ written: 0, skipped: 0 });
  // shortcut: one random bounded page per tick over all candidates; a backlog drains over several ticks, upgrade to a cursor if it grows.
  const candidates = await sql.query<SettlementCandidate>(`select c.* from (
      select g.workspace_id as ws, o.project_id as project, o.environment_id as environment, g.operation_id as op,
        'grant' as family, 'capability_grants' as source, g.jti as identity, null::jsonb as binding, null::text as run
      from platform.capability_grants g join platform.operations o on o.workspace_id=g.workspace_id and o.id=g.operation_id
      where g.expires_at + interval '3900 seconds' <= clock_timestamp()
      union all
      select w.workspace_id, o.project_id, o.environment_id, w.operation_id, 'workflow', 'workflow_start_intents',
        w.operation_id || ':' || w.attempt_id, w.binding, w.run_id
      from platform.workflow_start_intents w join platform.operations o on o.workspace_id=w.workspace_id and o.id=w.operation_id
      where w.phase in ('attempted','acknowledged') and w.attempt_id is not null and w.attempted_at is not null
      union all
      select b.workspace_id, o.project_id, o.environment_id, b.operation_id, 'build', 'build_launches',
        b.operation_id || ':' || b.service_address || ':' || b.attempt_id, null::jsonb, null::text
      from platform.build_launches b join platform.operations o on o.workspace_id=b.workspace_id and o.id=b.operation_id
      where b.phase='terminal' and b.provider_finished_at is not null
      union all
      select u.workspace_id, o.project_id, o.environment_id, u.operation_id, 'plan', 'plan_artifact_uses',
        u.operation_id || ':' || u.attempt_id, null::jsonb, null::text
      from platform.plan_artifact_uses u join platform.operations o on o.workspace_id=u.workspace_id and o.id=u.operation_id
      where u.phase in ('dispatched','succeeded','uncertain') and u.attempt_id is not null
    ) c cross join lateral platform.cleanup_delivery_source(c.ws, c.source, c.identity) s
    where s.src_operation_id=c.op and s.src_settles_at is not null and s.src_settles_at <= clock_timestamp()
      and not exists(select 1 from platform.cleanup_writer_settlements r where r.workspace_id=c.ws and r.family=c.family
        and r.delivery_source=c.source and r.delivery_identity=c.identity)
    order by random() limit $1`, [limit]);
  let written = 0, skipped = 0;
  for (const c of candidates) {
    if (c.family === "workflow") {
      const namespace = c.binding?.namespace, workflowId = c.binding?.workflowId, endpointDigest = c.binding?.endpointDigest;
      const closure = ports.startClosure && typeof namespace === "string" && typeof workflowId === "string" && typeof endpointDigest === "string"
        ? await ports.startClosure({ namespace, workflowId, endpointDigest }, c.run).catch((): DeliveryStartClosure => "unknown") : "unknown";
      if (closure !== "closed" && closure !== "not_found") { skipped++; continue; }
    }
    const sealed = sealDeliverySettlement(cipher, { workspaceId: c.ws, family: c.family, source: c.source, identity: c.identity, operationId: c.op });
    try {
      const rows = await sql.query(`insert into platform.cleanup_writer_settlements(workspace_id,project_id,environment_id,operation_id,family,
        delivery_source,delivery_identity,horizon_at,sealed) values($1,$2,$3,$4,$5,$6,$7,clock_timestamp(),$8::text::jsonb)
        on conflict (workspace_id,family,delivery_source,delivery_identity) do nothing returning 1 as ok`,
        [c.ws, c.project, c.environment, c.op, c.family, c.source, c.identity, JSON.stringify(sealed)]);
      if (rows.length === 1) written++; else skipped++;
    } catch {
      // The trigger refused it (horizon moved, scope changed): nothing is written, a later pass reads it again.
      skipped++;
    }
  }
  return Object.freeze({ written, skipped });
}
