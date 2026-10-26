/**
 * Delivery settlement horizons (WP2, owner decisions 2026-10-26). Expand-only: new functions and one new insert trigger on the
 * append-only settlement table from schema 60. No existing trigger, table, grant or repository query changes.
 * The database clock decides every horizon. The settlement payload is authenticated in TypeScript under the platform key;
 * these functions only decide when a delivery may be settled and refuse a settlement row before that horizon.
 * Plan uses keep their standalone receipts and are not settled here.
 */
export const migration0062CleanupDeliverySettlement = {
  version: 62,
  name: "cleanup_delivery_settlement",
  sql: `
-- Horizon of one possible delivery, read from its source row. No row, or a non-terminal source, yields no horizon.
-- Constants: 10 s start RPC deadline and 30 min start recovery window (workflows/start-intent.ts), 3600 s LONG_SESSION_SEC
-- (execution/session.ts), and a 300 s skew margin (owner to confirm). Revocation is never read here.
create or replace function platform.cleanup_delivery_source(p_ws text,p_source text,p_identity text)
returns table(src_operation_id text, src_settles_at timestamptz)
language plpgsql stable set search_path=pg_catalog,platform as $$
declare
  skew constant interval := interval '300 seconds';
begin
  if p_source='workflow_start_intents' then
    return query select w.operation_id, w.attempted_at + interval '10 seconds' + interval '30 minutes' + skew
      from platform.workflow_start_intents w join platform.operations o on o.workspace_id=w.workspace_id and o.id=w.operation_id
      where w.workspace_id=p_ws and w.phase in ('attempted','acknowledged') and w.attempted_at is not null
        and w.operation_id || ':' || w.attempt_id = p_identity
        and o.status in ('succeeded','failed','cancelled','expired','rejected','denied');
  elsif p_source='capability_grants' then
    return query select g.operation_id, g.expires_at + interval '3600 seconds' + skew
      from platform.capability_grants g where g.workspace_id=p_ws and g.jti=p_identity;
  -- settled_at alone is server-set (a revoked runner's job is cancelled at revocation while it may still run), so the
  -- envelope's expiry plus the session horizon also has to pass; the verified signed result is still required.
  elsif p_source='runner_jobs' then
    return query select j.operation_id, greatest(j.settled_at, j.expires_at + interval '3600 seconds' + skew) from platform.runner_jobs j
      where j.workspace_id=p_ws and j.id=p_identity and j.status in ('succeeded','failed','rejected','timed_out','expired','cancelled')
        and j.settled_at is not null;
  elsif p_source='machine_requests' then
    return query select j.operation_id, greatest(j.settled_at, j.expires_at + interval '3600 seconds' + skew) from platform.machine_requests j
      where j.workspace_id=p_ws and j.id=p_identity and j.status in ('succeeded','failed','rejected','timed_out','expired','cancelled')
        and j.settled_at is not null;
  elsif p_source='build_launches' then
    return query select b.operation_id, b.provider_finished_at from platform.build_launches b
      where b.workspace_id=p_ws and b.phase='terminal' and b.terminal_status is not null and b.provider_finished_at is not null
        and b.operation_id || ':' || b.service_address || ':' || b.attempt_id = p_identity;
  end if;
end
$$;

-- Inventory predicate. A delivery is settled only by a verified settlement row (its ciphertext must equal the row) whose
-- horizon, computed here from the source row, has passed on the database clock.
create or replace function platform.cleanup_delivery_settled(p_ws text,p_family text,p_source text,p_identity text,p_verified jsonb)
returns boolean language plpgsql stable set search_path=pg_catalog,platform as $$
declare
  s record;
begin
  if p_verified is null or jsonb_typeof(p_verified)<>'array' or p_identity is null or p_family is null then return false; end if;
  select * into s from platform.cleanup_delivery_source(p_ws,p_source,p_identity);
  if not found or s.src_settles_at is null or s.src_settles_at > clock_timestamp() then return false; end if;
  return exists(select 1 from jsonb_array_elements(p_verified) v
    join platform.cleanup_writer_settlements r on r.workspace_id=p_ws and r.family=p_family and r.delivery_source=p_source
      and r.delivery_identity=p_identity
    where v->>'family'=p_family and v->>'source'=p_source and v->>'identity'=p_identity and v->>'operationId'=r.operation_id
      and r.operation_id=s.src_operation_id and r.horizon_at<=clock_timestamp()
      and r.sealed->>'iv'=v->'sealed'->>'iv' and r.sealed->>'authTag'=v->'sealed'->>'authTag' and r.sealed->>'ciphertext'=v->'sealed'->>'ciphertext');
end
$$;

-- A settlement is written only when its family matches its source, its operation and scope match the delivery, and the
-- database clock has reached the horizon. The horizon stored is the one computed here, never the caller's value.
create or replace function platform.cleanup_writer_settlement_guard() returns trigger
language plpgsql set search_path=pg_catalog,platform as $$
declare
  s record;
begin
  if not ((new.family='workflow' and new.delivery_source='workflow_start_intents')
    or (new.family='grant' and new.delivery_source='capability_grants')
    or (new.family='runner' and new.delivery_source in ('runner_jobs','machine_requests'))
    or (new.family='build' and new.delivery_source='build_launches')) then
    raise exception 'Settlement family does not settle this delivery source' using errcode='23514';
  end if;
  select * into s from platform.cleanup_delivery_source(new.workspace_id,new.delivery_source,new.delivery_identity);
  if not found or s.src_operation_id is distinct from new.operation_id or s.src_settles_at is null or clock_timestamp() < s.src_settles_at then
    raise exception 'Settlement is refused before its horizon or for an unmatched delivery' using errcode='23514';
  end if;
  if not exists(select 1 from platform.operations o where o.workspace_id=new.workspace_id and o.id=new.operation_id
    and o.project_id is not distinct from new.project_id and o.environment_id is not distinct from new.environment_id) then
    raise exception 'Settlement scope does not match its operation' using errcode='23514';
  end if;
  new.horizon_at:=s.src_settles_at;
  return new;
end
$$;
create or replace trigger cleanup_writer_settlement_guard before insert on platform.cleanup_writer_settlements
for each row execute function platform.cleanup_writer_settlement_guard();

do $$
begin
  if exists(select 1 from pg_roles where rolname='service_role') then
    revoke all on function platform.cleanup_delivery_source(text,text,text) from public;
    revoke all on function platform.cleanup_delivery_settled(text,text,text,text,jsonb) from public;
    revoke all on function platform.cleanup_writer_settlement_guard() from public;
    grant execute on function platform.cleanup_delivery_source(text,text,text) to service_role;
    grant execute on function platform.cleanup_delivery_settled(text,text,text,text,jsonb) to service_role;
  end if;
end
$$;
`,
} as const;
