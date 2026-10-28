/**
 * Non-builtin plan-use settlement (teardown WP3, owner decisions 2026-10-26). Expand-only: it replaces two functions from
 * schema 62 in place, adding one source branch and one allowed family. No table, trigger binding, grant or other function
 * changes. A builtin use on such a connection may also settle by this rule: it writes no provider state beyond what its grants
 * allow, and its standalone receipt stays a separate, earlier path. The writer is the worker's settlement pass under the platform
 * key (cleanup-writer-barriers.ts writeDeliverySettlements); the database still decides every horizon.
 */
export const migration0063CleanupPlanUseSettlement = {
  version: 63,
  name: "cleanup_plan_use_settlement",
  sql: `
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
  -- A non-builtin plan use (an AWS OpenTofu apply). Its writer is the apply, which acts only through provider sessions minted
  -- from this operation's capability grants on a short-lived AWS connection (aws_assume_role or oidc_web_identity). The
  -- horizon is the latest of those grants' expiry plus the longest session plus skew, so a grant issued later moves it.
  -- Any other connection (static keys, a runner, another provider), no recorded connection, or a connection created after the
  -- operation (it cannot vouch for the credential the apply used) yields no horizon: never settled.
  elsif p_source='plan_artifact_uses' then
    return query select u.operation_id, (select max(g.expires_at) + interval '3600 seconds' + skew from platform.capability_grants g
        where g.workspace_id=u.workspace_id and g.operation_id=u.operation_id)
      from platform.plan_artifact_uses u join platform.operations o on o.workspace_id=u.workspace_id and o.id=u.operation_id
      join platform.reconcile_state rs on rs.workspace_id=o.workspace_id and rs.environment_id=o.environment_id
      join platform.provider_connections pc on pc.workspace_id=rs.workspace_id and pc.id=rs.connection_id
      where u.workspace_id=p_ws and u.phase in ('dispatched','succeeded','uncertain') and u.attempt_id is not null
        and u.operation_id || ':' || u.attempt_id = p_identity
        and o.status in ('succeeded','failed','cancelled','expired','rejected','denied')
        and pc.provider='aws' and pc.mode in ('aws_assume_role','oidc_web_identity') and pc.created_at <= o.created_at
        -- The environment's pointer is read now, not at apply time. If the workspace held any other kind of AWS connection when
        -- the operation was created, the apply may have used it (static keys outlive every grant): never settle by time.
        and not exists(select 1 from platform.provider_connections x where x.workspace_id=o.workspace_id and x.provider='aws'
          and x.mode not in ('aws_assume_role','oidc_web_identity') and x.created_at <= o.created_at);
  end if;
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
    or (new.family='build' and new.delivery_source='build_launches')
    or (new.family='plan' and new.delivery_source='plan_artifact_uses')) then
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
`,
} as const;
