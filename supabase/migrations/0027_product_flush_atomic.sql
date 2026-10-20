-- 0027 — one transaction for a product-store snapshot flush (PROD-DUR-02).
--
-- `PostgresStore` used to write a snapshot's changed rows one PostgREST call
-- at a time. Each row is version-guarded, but a later 409 left the earlier
-- rows committed: an environment row that released its writer lease and set
-- `deployedRevisionId` could land while the deployment row that justified it
-- was refused. Those two rows decide the environment writer fence together,
-- so they must commit together.
--
-- `zenith_product_flush` applies the same per-row rules inside one function
-- call, which PostgreSQL runs as one transaction:
--   * an insert (no baseline) inserts exactly the columns sent; a duplicate
--     key raises 23505;
--   * an update and a delete match the baseline `version` and raise PZ409
--     when no row matches (somebody else moved or removed it);
--   * any error rolls back every write of the call.
-- Tables are an explicit allowlist of the store's row collections. Identifiers
-- are quoted with %I and key values with %L (an untyped literal takes the key
-- column's type, so the primary-key index serves the match). `security definer`, so EXECUTE
-- is the whole access decision: PUBLIC gets none, service_role gets it.
-- Re-runnable: `create or replace` and idempotent grants.

create or replace function public.zenith_product_flush(p_writes jsonb, p_deletes jsonb)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  allowed constant text[] := array[
    'workspaces', 'members', 'invites', 'connections', 'projects', 'environments',
    'revisions', 'deployments', 'findings', 'navigator_runs', 'alert_rules',
    'alert_events', 'alert_outbox'];
  change jsonb;
  tbl text;
  cols text;
  cond text;
  affected bigint;
begin
  if jsonb_typeof(p_writes) is distinct from 'array' or jsonb_typeof(p_deletes) is distinct from 'array' then
    raise exception 'zenith_product_flush: writes and deletes must be arrays' using errcode = '22023';
  end if;

  for change in select value from jsonb_array_elements(p_writes) loop
    tbl := change->>'table';
    if tbl is null or not (tbl = any (allowed))
       or jsonb_typeof(change->'row') is distinct from 'object'
       or jsonb_typeof(change->'key') is distinct from 'object' then
      raise exception 'zenith_product_flush: malformed write' using errcode = '22023';
    end if;
    select string_agg(format('%I', k), ', ' order by k) into cols from jsonb_object_keys(change->'row') k;
    select string_agg(format('t.%I = %L', k, change->'key'->>k), ' and ' order by k) into cond
      from jsonb_object_keys(change->'key') k;
    if cols is null or cond is null then
      raise exception 'zenith_product_flush: empty write' using errcode = '22023';
    end if;
    if jsonb_typeof(change->'baseline') is distinct from 'number' then
      execute format('insert into public.%I (%s) select %s from jsonb_populate_record(null::public.%I, $1)',
        tbl, cols, cols, tbl) using change->'row';
    else
      execute format('update public.%I t set (%s) = (select %s from jsonb_populate_record(null::public.%I, $1)) where %s and t.version = $2',
        tbl, cols, cols, tbl, cond) using change->'row', (change->>'baseline')::bigint;
      get diagnostics affected = row_count;
      if affected = 0 then
        raise exception 'zenith_product_flush: % row moved since it was loaded', tbl using errcode = 'PZ409';
      end if;
    end if;
  end loop;

  for change in select value from jsonb_array_elements(p_deletes) loop
    tbl := change->>'table';
    if tbl is null or not (tbl = any (allowed))
       or jsonb_typeof(change->'key') is distinct from 'object'
       or jsonb_typeof(change->'baseline') is distinct from 'number' then
      raise exception 'zenith_product_flush: malformed delete' using errcode = '22023';
    end if;
    select string_agg(format('t.%I = %L', k, change->'key'->>k), ' and ' order by k) into cond
      from jsonb_object_keys(change->'key') k;
    if cond is null then
      raise exception 'zenith_product_flush: empty delete' using errcode = '22023';
    end if;
    execute format('delete from public.%I t where %s and t.version = $1', tbl, cond)
      using (change->>'baseline')::bigint;
    get diagnostics affected = row_count;
    if affected = 0 then
      raise exception 'zenith_product_flush: % row moved since it was loaded', tbl using errcode = 'PZ409';
    end if;
  end loop;
end;
$$;

revoke all on function public.zenith_product_flush(jsonb, jsonb) from public;
revoke all on function public.zenith_product_flush(jsonb, jsonb) from anon, authenticated;
grant execute on function public.zenith_product_flush(jsonb, jsonb) to service_role;
