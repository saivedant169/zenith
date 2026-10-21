/**
 * PROD-LIFE-12: an ownership change revokes the live native-write grants it
 * would have refused. Grant issue re-admits current field ownership under the
 * environment coordinator (0053), but a grant issued before an autoscaler
 * attached stayed usable for its lifetime. Revocation is what every execution
 * surface checks (runner claim, dispatch, credential broker), so the change
 * that moves ownership also revokes the grants it invalidates; the operation
 * must be re-admitted against the new owner.
 *
 * - An autoscaling fact (a workload's own spec.autoscaling, or an autoscaler
 *   node, see src/lib/ownership/facts.ts AUTOSCALER_NATIVE_TYPES) only moves
 *   replicas/size, which service.scale and a drift.repair reapply (ECS replica
 *   repair) write: revoke their live grants in the environment. Deploys and
 *   applies keep their grants.
 * - An ownership transfer can move any field: revoke live native-write grants
 *   (NATIVE_OPERATION_WRITES and drift.repair, an IaC reapply) in the environment except those of the transfer's
 *   own operation.
 * Runs AFTER the 0053 BEFORE trigger, so it holds the same environment lock.
 */
export const migration0059FieldOwnershipGrantRevocation = {
  version: 59,
  name: "field_ownership_grant_revocation",
  sql: `
create or replace function platform.revoke_grants_on_ownership_change() returns trigger
language plpgsql set search_path=pg_catalog as $$
declare
  autoscalers constant text[] := array['k8s:HorizontalPodAutoscaler','aws:appautoscaling_target'];
  writes constant text[] := array['service.scale','deployment.deploy','deployment.rollback','drift.repair'];
  ws text;
  envs text[];
  revoked_capabilities text[];
  own_operation text;
begin
  if TG_TABLE_NAME='resources' then
    if TG_OP='INSERT' then
      if not (new.native_type=any(autoscalers) or new.spec ? 'autoscaling') then return null; end if;
    elsif TG_OP='DELETE' then
      if not (old.native_type=any(autoscalers) or old.spec ? 'autoscaling') then return null; end if;
    else
      if not (old.native_type=any(autoscalers) or old.spec ? 'autoscaling' or new.native_type=any(autoscalers) or new.spec ? 'autoscaling') then
        return null;
      end if;
      -- Unchanged facts: same place, same type, same autoscaling block, and an autoscaler node's spec unchanged.
      if new.environment_id is not distinct from old.environment_id and new.address is not distinct from old.address
         and new.native_type is not distinct from old.native_type
         and (new.spec->'autoscaling') is not distinct from (old.spec->'autoscaling')
         and (not (new.native_type=any(autoscalers)) or new.spec is not distinct from old.spec) then
        return null;
      end if;
    end if;
    revoked_capabilities := array['service.scale','drift.repair'];
  else
    revoked_capabilities := writes;
    if TG_OP='DELETE' then own_operation := old.operation_id; else own_operation := new.operation_id; end if;
  end if;
  if TG_OP='DELETE' then
    ws := old.workspace_id; envs := array[old.environment_id];
  elsif TG_OP='INSERT' then
    ws := new.workspace_id; envs := array[new.environment_id];
  else
    ws := new.workspace_id; envs := array_remove(array[old.environment_id, new.environment_id], null);
  end if;
  update platform.capability_grants g set revoked_at=clock_timestamp()
    from platform.operations o
   where g.workspace_id=ws and g.revoked_at is null and g.consumed_at is null and g.expires_at>clock_timestamp()
     and g.capability=any(revoked_capabilities)
     and o.workspace_id=g.workspace_id and o.id=g.operation_id and o.environment_id=any(envs)
     and (own_operation is null or o.id<>own_operation);
  return null;
end
$$;
create or replace trigger field_ownership_resource_grant_revocation
after insert or delete or update of environment_id,address,kind,native_type,spec on platform.resources
for each row execute function platform.revoke_grants_on_ownership_change();
create or replace trigger field_ownership_transfer_grant_revocation
after insert or update or delete on platform.ownership_transfers
for each row execute function platform.revoke_grants_on_ownership_change();
`,
} as const;
