/**
 * Hold generations (WP5, owner decision 2026-10-26). Each teardown attempt inserts its own generation row.
 * The environment is frozen while its newest hold has no release row. Releases are written by the retain path
 * and the janitor, only under the workspace coordinator and only at zero counted inventory.
 * Changed: the holds primary key (now workspace_id,hold_seq), one held attempt per hold, and the writer-freeze
 * lookup in cleanup_writer_transition. Unchanged: the refused family set, the grant and plan branches, and the
 * lock order (operation FK row locks, then the workspace coordinator).
 */
export const migration0061CleanupWriterHoldGenerations = {
  version: 61,
  name: "cleanup_writer_hold_generations",
  sql: `
alter table platform.cleanup_writer_holds drop constraint if exists cleanup_writer_holds_pkey;
alter table platform.cleanup_writer_holds add constraint cleanup_writer_holds_pkey primary key(workspace_id,hold_seq);
-- One held attempt owns at most one generation; a second retain for the same attempt is refused by the unique insert.
create unique index if not exists cleanup_writer_holds_attempt on platform.cleanup_writer_holds(workspace_id,operation_id,attempt_id);
-- Newest-generation lookups per scope (writer trigger and janitor sweep).
create index if not exists cleanup_writer_holds_scope on platform.cleanup_writer_holds(workspace_id,project_id,environment_id,hold_seq);

create or replace function platform.cleanup_writer_transition() returns trigger
language plpgsql security definer set search_path=pg_catalog,platform as $$
declare
  o platform.operations%rowtype;
  h platform.cleanup_writer_holds%rowtype;
  ws text;
  opid text;
  family_name text;
  delivery_id text;
  delivery_cap text;
  delivery_attempt text;
  read_only_cap boolean;
begin
  ws:=new.workspace_id; opid:=new.operation_id;
  if TG_TABLE_NAME='workflow_start_intents' then
    if new.phase<>'attempted' or (TG_OP='UPDATE' and old.phase<>'prepared') then return new; end if;
    family_name:='workflow'; delivery_id:=opid || ':' || new.attempt_id; delivery_attempt:=new.attempt_id;
  elsif TG_TABLE_NAME='plan_artifact_uses' then
    if new.phase<>'dispatched' or (TG_OP='UPDATE' and old.phase<>'claimed') then return new; end if;
    family_name:='plan'; delivery_id:=opid || ':' || new.attempt_id; delivery_attempt:=new.attempt_id;
  elsif TG_TABLE_NAME='build_launches' then
    family_name:='build'; delivery_id:=opid || ':' || new.service_address || ':' || new.attempt_id;
  elsif TG_TABLE_NAME='runner_jobs' or TG_TABLE_NAME='machine_requests' then
    if new.status<>'running' or (TG_OP='UPDATE' and old.status='running') then return new; end if;
    family_name:=case when TG_TABLE_NAME='runner_jobs' then 'runner' else 'machine' end;
    delivery_id:=new.id; delivery_cap:=new.capability;
  elsif TG_TABLE_NAME='capability_grants' then
    family_name:='grant'; delivery_id:=new.jti; delivery_cap:=new.capability;
  else
    raise exception 'Unsupported cleanup writer' using errcode='23514';
  end if;
  if delivery_cap in ('infrastructure.plan','infrastructure.observe','topology.read','logs.read','metrics.read','traces.read',
    'events.read','incident.investigate','cost.estimate','firewall.inspect','placement.solve','machine.inspect','process.list',
    'service.status','container.list','container.inspect','container.logs','file.read','network.portCheck','network.dnsCheck','system.metrics','system.logs') then return new; end if;
  -- Every INSERT's operation FK must be acquired before the coordinator.
  -- UPDATE already owns its row and unchanged FK: do not add an op lock.
  if TG_OP='INSERT' then
    select * into o from platform.operations where workspace_id=ws and id=opid for key share;
  else
    select * into o from platform.operations where workspace_id=ws and id=opid;
  end if;
  if not found then raise exception 'Cleanup writer owner is unavailable' using errcode='23514'; end if;
  if o.workspace_id is distinct from o.proposal->'scope'->>'workspaceId'
    or o.project_id is distinct from o.proposal->'scope'->>'projectId'
    or o.environment_id is distinct from o.proposal->'scope'->>'environmentId' then
    raise exception 'Cleanup writer scope projection changed' using errcode='23514';
  end if;
  delivery_cap:=coalesce(delivery_cap,o.capability);
  read_only_cap:=delivery_cap in ('infrastructure.plan','infrastructure.observe','topology.read','logs.read','metrics.read','traces.read',
    'events.read','incident.investigate','cost.estimate','firewall.inspect','placement.solve','machine.inspect','process.list',
    'service.status','container.list','container.inspect','container.logs','file.read','network.portCheck','network.dnsCheck','system.metrics','system.logs');
  if read_only_cap and family_name<>'build' then return new; end if;
  insert into platform.cleanup_writer_scopes(workspace_id) values(ws) on conflict do nothing;
  perform workspace_id from platform.cleanup_writer_scopes where workspace_id=ws for update;
  -- Frozen means the NEWEST hold of the scope has no release row. Superseded generations never freeze.
  select * into h from platform.cleanup_writer_holds ch where ch.workspace_id=ws
    and (o.project_id is null or o.environment_id is null or (ch.project_id=o.project_id and ch.environment_id=o.environment_id))
    and not exists(select 1 from platform.cleanup_writer_holds nh where nh.workspace_id=ch.workspace_id and nh.project_id=ch.project_id
      and nh.environment_id=ch.environment_id and nh.hold_seq>ch.hold_seq)
    and not exists(select 1 from platform.cleanup_writer_hold_releases r where r.workspace_id=ch.workspace_id and r.hold_seq=ch.hold_seq)
    order by ch.hold_seq desc limit 1;
  if found then
    if family_name='grant' then
      if delivery_cap='infrastructure.destroy' and new.audience='worker'
        and exists(select 1 from platform.cleanup_owner_grants g join platform.plan_artifact_uses u
          on u.workspace_id=g.workspace_id and u.operation_id=g.operation_id
          where g.workspace_id=ws and g.operation_id=opid and g.jti=new.jti and g.attempt_id=h.attempt_id and g.generation=h.generation
            and u.phase='claimed' and u.attempt_id=h.attempt_id and u.holder=h.holder and u.fence_token=h.fence_token)
        and o.id=h.operation_id and o.status='running' and o.lease_until>clock_timestamp() and o.expires_at>clock_timestamp()
        and o.lease_holder='workflow:' || o.id and o.lease_scope='env:' || h.environment_id and o.fence_token=h.fence_token
        and exists(select 1 from platform.leases l where l.workspace_id=ws and l.scope=o.lease_scope and l.holder=h.holder
          and l.fence_token=h.fence_token and l.expires_at>clock_timestamp()) then
        delivery_attempt:=h.attempt_id;
      else
        raise exception 'Cleanup hold refuses a new possible delivery' using errcode='23514';
      end if;
    elsif family_name='plan' and o.id=h.operation_id and delivery_attempt=h.attempt_id
      and exists(select 1 from platform.cleanup_owner_grants g join platform.capability_grants c on c.jti=g.jti
        where g.workspace_id=ws and g.operation_id=opid and g.attempt_id=h.attempt_id and g.generation=h.generation
          and c.workspace_id=ws and c.operation_id=opid and c.capability='infrastructure.destroy' and c.audience='worker'
          and c.revoked_at is null and c.expires_at>clock_timestamp()) then
      null;
    else
      raise exception 'Cleanup hold refuses a new possible delivery' using errcode='23514';
    end if;
  elsif delivery_cap='infrastructure.destroy' and family_name in ('grant','plan') then
    -- Direct provider teardown cannot issue a bearer before an authenticated paired hold.
    raise exception 'Destroy requires a held authenticated attempt' using errcode='23514';
  end if;
  insert into platform.cleanup_writer_deliveries(workspace_id,project_id,environment_id,operation_id,family,identity,capability,attempt_id)
    values(ws,o.project_id,o.environment_id,opid,family_name,delivery_id,delivery_cap,delivery_attempt) on conflict do nothing;
  return new;
end
$$;
`,
} as const;
