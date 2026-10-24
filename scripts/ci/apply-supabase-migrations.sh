#!/usr/bin/env bash
#
# Apply the committed supabase/migrations, in order, to the database named by
# SUPABASE_DB_URL. Written for the `postgres` job in .github/workflows/ci.yml,
# whose database is a disposable service container — never point it at a
# Supabase project.
#
# ## Why a script and not `supabase db push`
#
# The Supabase CLI wants a linked project and an access token. CI has neither,
# and the thing under test is the *SQL in this repository*, not the CLI. `psql`
# applying the files in order is the smallest thing that proves the schema
# the hosted authority checks for (`src/lib/hosted/authority/pg/index.ts:165-191`)
# can actually be built from what is committed.
#
# ## 0006 and 0007 — the `agent` schema
#
# The agent link flow (`supabase/migrations/0006_agent_link.sql`) and the agent
# control plane (`0007_agent_control.sql`) create one new schema, `agent`, with
# its own `agent.schema_migrations` ledger — deliberately not `hosted.*`, so an
# agent-link outage is not coupled to a hosted-apps migration
# (PLAN2/LINK-PROTOCOL.md §3.2). Both files are idempotent, both create the
# schema if absent and both repeat the `service_role` grant block, so either
# order applies and re-applying is a no-op. They are listed in numeric order
# anyway, because that is the order the operator runbook
# (`docs/HOSTED-POSTGRES.md` §9) tells a human to run them in.
#
# `agent` is **not** exposed to PostgREST on Supabase and nothing in this script
# exposes it here either: the agent journal and credential authority speak
# direct Postgres through `postgres.js`.
#
# ## 0014 — the `platform` schema
#
# `supabase/migrations/0026_platform_core.sql` is GENERATED from the TypeScript
# migrations of the platform control store (`npx tsx scripts/platform/emit-sql.ts`;
# `tests/controlplane/migrations.test.ts` keeps it byte-identical). It creates the
# `platform` schema and its own `platform.schema_migrations` ledger — checksummed,
# unlike `hosted`/`agent` — turns RLS on for every table with no policies, and
# grants only `service_role`. The application never runs DDL against Postgres; it
# checks that ledger on start (`assertPlatformSchemaCurrent`) and fails closed.
# CI uses that same runtime verifier, plus the canonical migration names, before
# checking the platform tables, grants and RLS boundaries below.
#
# ## Supabase role stand-ins
#
# `service_role`. The migrations include grant blocks naming it
# (0001:422-426, 0002:383-387, 0003:245-261, 0004:289-294) because on Supabase
# it is a real role that bypasses RLS. A bare PostgreSQL container has no such
# role, so `create role service_role` below is a **stand-in**: NOLOGIN with
# BYPASSRLS, as required by the SECURITY INVOKER sharing and waitlist functions.
# Contract tests use SET ROLE to verify privileges. No test authenticates as it.
#
# That matters for what the lane can and cannot prove:
#   - PROVES: every DDL statement applies, in order, from an empty database —
#     tables, partial unique indexes, CHECKs, identity columns, plpgsql
#     functions, and the migration ledger the runtime verifies.
#   - PROVES: the new product functions are executable as the stand-in service
#     role and inaccessible as the stand-in `anon`/`authenticated` roles.
#   - DOES NOT PROVE: a real Supabase project's role memberships, exposed API
#     schemas or PostgREST configuration. Tests open a superuser connection and
#     use SET ROLE; they do not authenticate through Supabase.
#
# `anon` and `authenticated` are also NOLOGIN stand-ins. The workspace sharing
# and waitlist migrations explicitly revoke their table/function privileges;
# the contract suites use SET ROLE to verify those application boundaries.
#
# `supabase_auth_admin` is also a NOLOGIN, non-BYPASSRLS stand-in. Migration
# 0011 grants it only the signup hook and admitted email/status reads. The
# contract tests SET ROLE to verify that hook boundary without running Auth.
#
# No extensions are required. `gen_random_uuid()` in the waitlist migration is
# built into the PostgreSQL version used by this lane.
#
# Usage:  SUPABASE_DB_URL=postgresql://… bash scripts/ci/apply-supabase-migrations.sh
# Exit:   0 applied and verified, 1 anything else (with the reason on stderr).

set -euo pipefail

MIGRATION_DIR="supabase/migrations"

# The order is the contract: 0002 creates the `hosted` schema and the migration
# ledger, 0005 writes the ledger row the runtime's boot check reads. Listed
# explicitly rather than globbed so a new file cannot join the lane silently.
MIGRATIONS=(
  "0001_system_of_record.sql"
  "0002_hosted_authority.sql"
  "0003_hosted_app_data.sql"
  "0004_hosted_app_data_atomic.sql"
  "0005_pending_invite_uniqueness.sql"
  "0006_agent_link.sql"
  "0007_agent_control.sql"
  "0008_workspace_ownership.sql"
  "0009_waitlist.sql"
  "0010_waitlist_profile.sql"
  "0011_waitlist_signup_hook.sql"
  "0012_waitlist_admin.sql"
  "0013_google_waitlist_identity.sql"
  "0014_platform_core.sql"
  "0015_agent_oauth_grants.sql"
  "0016_platform_core.sql"
  "0017_platform_core.sql"
  "0018_platform_core.sql"
  "0019_platform_core.sql"
  "0020_platform_core.sql"
  "0021_platform_core.sql"
  "0022_platform_core.sql"
  "0023_platform_core.sql"
  "0024_platform_core.sql"
  "0025_platform_core.sql"
  "0026_platform_core.sql"
  "0027_product_flush_atomic.sql"
)

if [ -z "${SUPABASE_DB_URL:-}" ]; then
  echo "::error::SUPABASE_DB_URL is not set, so there is nothing to apply migrations to." >&2
  exit 1
fi

if ! command -v psql >/dev/null 2>&1; then
  echo "::error::psql is not on PATH. Install postgresql-client before this step (the ubuntu-24.04 runner image ships it)." >&2
  exit 1
fi

# This verifier uses the installed runtime, never an npx download. Check the
# prerequisite before applying DDL so missing dependencies fail immediately.
PLATFORM_VERIFIER="scripts/platform/verify-schema.ts"
AGENT_VERIFIER="scripts/agent/verify-schema.ts"
TSX="node_modules/.bin/tsx"
if [ ! -f "$PLATFORM_VERIFIER" ] || [ ! -f "$AGENT_VERIFIER" ] || [ ! -x "$TSX" ]; then
  echo "::error::The canonical agent/platform schema verifier or installed tsx is missing. Run npm ci --ignore-scripts before applying migrations." >&2
  exit 1
fi

# libpq failures can include a URI/password and SQL CONTEXT can include payloads.
# Preserve failure status while reporting only the current file/check phase.
psql_safe() {
  if ! command psql "$@" 2>/dev/null; then
    echo "::error::psql_failed (${PSQL_PHASE}): Postgres migration or schema check failed." >&2
    return 1
  fi
}

echo "Applying ${#MIGRATIONS[@]} migrations to the configured CI database."

# --- wait for the service container -----------------------------------------
#
# The job's `services:` health check already gates the step, but a container
# that has just reported healthy can still refuse the first connection while it
# finishes its own bootstrap. Bounded: 30 attempts, one second apart.
attempt=0
# Keep the connection argument last: Windows psql stops option parsing at the
# first positional argument, while GNU builds also accept trailing options.
until psql --quiet --no-align --tuples-only --command 'select 1' "$SUPABASE_DB_URL" >/dev/null 2>&1; do
  attempt=$((attempt + 1))
  if [ "$attempt" -ge 30 ]; then
    echo "::error::The configured CI database did not accept a connection after 30 attempts." >&2
    exit 1
  fi
  sleep 1
done
echo "Connected after ${attempt} retr$([ "$attempt" -eq 1 ] && echo y || echo ies)."

# --- the service_role stand-in ----------------------------------------------
#
# Idempotent, so re-running the script against the same container is a no-op.
PSQL_PHASE="role_stand_ins"
echo "--- role stand-ins"
psql_safe --quiet --set ON_ERROR_STOP=1 "$SUPABASE_DB_URL" <<'SQL'
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'service_role') then
    create role service_role nologin noinherit bypassrls;
  end if;
end
$$;
-- Re-running against the same disposable CI cluster upgrades an older stand-in.
alter role service_role bypassrls;
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then
    create role anon nologin noinherit;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then
    create role authenticated nologin noinherit;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'supabase_auth_admin') then
    create role supabase_auth_admin nologin noinherit;
  end if;
end
$$;
SQL
echo "service_role, anon, authenticated and supabase_auth_admin stand-ins present."

# --- apply, each file in its own transaction --------------------------------
#
# --single-transaction matters for 0005: its comment states that the index and
# the ledger insert must succeed or fail together, so that a duplicate legacy
# row cannot leave a ledger row claiming an index that is not there.
for file in "${MIGRATIONS[@]}"; do
  path="${MIGRATION_DIR}/${file}"
  if [ ! -f "$path" ]; then
    echo "::error::${path} does not exist. The migration set this script applies is out of date." >&2
    exit 1
  fi
  echo "--- ${file}"
  PSQL_PHASE="migration:${file}"
  psql_safe \
    --quiet \
    --single-transaction \
    --set ON_ERROR_STOP=1 \
    --file "$path" \
    "$SUPABASE_DB_URL"
done

# --- verify what actually landed --------------------------------------------
#
# Three facts, because "psql exited 0" only says the statements parsed:
#   1. the ledger holds exactly versions 1,2,3 with the names the runtime
#      expects (src/lib/hosted/authority/schema.ts:334-336);
#   2. the partial unique index the boot check probes for exists;
#   3. both schemas hold tables.
echo "--- verification"
PSQL_PHASE="hosted_schema"
ledger="$(psql_safe --no-align --tuples-only --set ON_ERROR_STOP=1 \
  --command "select string_agg(version || ':' || name, ', ' order by version) from hosted.schema_migrations" "$SUPABASE_DB_URL")"
if [ "$ledger" != "1:control-authority-v1, 2:invite-delivery-transport-none, 3:one-pending-invite-per-app-email" ]; then
  echo "::error::The migration ledger is not what src/lib/hosted/authority/schema.ts expects; the authority will refuse to boot." >&2
  exit 1
fi

index_def="$(psql_safe --no-align --tuples-only --set ON_ERROR_STOP=1 \
  --command "select coalesce(indexdef, '') from pg_indexes where schemaname = 'hosted' and indexname = 'app_invites_pending_email'" "$SUPABASE_DB_URL")"
if [ -z "$index_def" ]; then
  echo "::error::hosted.app_invites_pending_email is missing; migration 0005 did not apply." >&2
  exit 1
fi
echo "hosted ledger and app_invites_pending_email verified."

counts="$(psql_safe --no-align --tuples-only --set ON_ERROR_STOP=1 \
  --command "select schemaname || '=' || count(*) from pg_tables where schemaname in ('public','hosted','agent','platform') group by schemaname order by schemaname" "$SUPABASE_DB_URL")"
echo "tables: $(echo "$counts" | tr '\n' ' ')"

# --- the agent schema (0006, 0007, 0015) ------------------------------------
# Names/versions come from the same canonical registry as the OAuth journal.
# This verifies native table/RLS/least privileges without inventing an agent checksum.
PSQL_PHASE="agent_schema"
"$TSX" "$AGENT_VERIFIER"

# The runbook journal indexes plus the canonical OAuth binding. A subset check,
# not an equality one: the primary keys and the two UNIQUE constraints create
# their own system-named indexes beside these, and pinning that list would make
# this script fail on a rename PostgreSQL chose.
AGENT_INDEXES=(
  agent_credentials_live
  agent_credentials_subject
  agent_oauth_grants_binding
  agent_link_codes_expiry
  agent_operation_events_op
  agent_operations_leased
  agent_operations_pending_expiry
  agent_operations_review
  agent_operations_scope
  agent_rate_limits_bucket
  agent_uploads_workspace
)
present="$(psql_safe --no-align --tuples-only --set ON_ERROR_STOP=1 \
  --command "select indexname from pg_indexes where schemaname = 'agent' order by 1" "$SUPABASE_DB_URL")"
for index in "${AGENT_INDEXES[@]}"; do
  if ! grep -qx -- "$index" <<<"$present"; then
    echo "::error::agent.${index} is missing; the canonical agent migrations did not apply the required index." >&2
    exit 1
  fi
done

# The grant block at the tail of each file, which is the one Supabase-only
# thing these migrations need. On the container `service_role` is the NOLOGIN
# stand-in created above, so this proves the statement applied — not that
# Supabase's own role graph is correct. Nothing here authenticates as it.
agent_usage="$(psql_safe --no-align --tuples-only --set ON_ERROR_STOP=1 \
  --command "select has_schema_privilege('service_role','agent','USAGE')" "$SUPABASE_DB_URL")"
if [ "$agent_usage" != "t" ]; then
  echo "::error::service_role has no USAGE on schema agent; the grant block at the tail of 0006/0007 did not apply." >&2
  exit 1
fi
echo "service_role USAGE on schema agent = ${agent_usage}"

# RLS on with no policies is the `hosted` rule, repeated for `agent`. A table
# that reached production with RLS off would be readable by `anon` the moment
# somebody exposed the schema to the Data API by mistake.
unprotected="$(psql_safe --no-align --tuples-only --set ON_ERROR_STOP=1 \
  --command "select string_agg(relname, ', ' order by relname) from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'agent' and c.relkind = 'r' and not c.relrowsecurity" "$SUPABASE_DB_URL")"
if [ -n "$unprotected" ]; then
  echo "::error::row level security is off on an agent table; every table in the agent schema must enable it." >&2
  exit 1
fi
echo "row level security enabled on every table in schema agent."

# --- the platform schema (historical0014/0016/0017/0018/0019/0020/0021/0022 plus current0023) ---------------------------------------------
#
# Use the application's checksum/version verifier and canonical known names.
# No pinned migration count: newly shipped versions follow the runtime manifest,
# and additive versions from a newer deploy retain the runtime's compatibility.
PSQL_PHASE="platform_schema"
echo "--- platform verification"
"$TSX" "$PLATFORM_VERIFIER"

# Tables the runtime code addresses by name. A subset check, like the agent one.
PLATFORM_TABLES=(
  actual_spend_snapshots
  agent_effect_receipts
  agent_nonces
  agent_update_controls
  approvals
  approved_semantics
  approved_source_snapshots
  audit_exports
  billing_account_events
  billing_accounts
  billing_invoices
  billing_usage_events
  billing_webhook_events
  build_launches
  capability_grants
  cleanup_owner_grants
  cleanup_writer_deliveries
  cleanup_writer_epoch
  cleanup_writer_holds
  cleanup_writer_scopes
  coding_agent_runs
  connection_rotations
  cost_estimates
  drift_reports
  durable_intents
  environment_settings
  events
  evidence
  external_effect_events
  external_effect_resolutions
  external_effects
  github_binding_events
  github_install_intents
  github_source_bindings
  github_webhook_deliveries
  github_webhook_installation_epochs
  idempotency_keys
  incident_maintenance_windows
  incident_postmortems
  incident_remediation_attempts
  incident_signal_state
  incidents
  investigations
  isolation_plan_custody
  key_custody_keys
  key_rewrap_jobs
  leases
  legal_holds
  machine_request_logs
  machine_requests
  machine_runbook_approvals
  machine_runbook_audit
  machine_runbook_run_steps
  machine_runbook_runs
  machine_runbook_schedules
  machine_runbook_versions
  machines
  managed_domains
  managed_storage_keys
  mcp_stream_events
  mcp_streams
  mixed_addresses
  mixed_child_custody
  mixed_child_intents
  mixed_child_plans
  mixed_child_receipts
  mixed_output_preauthorizations
  mixed_output_records
  mixed_parent_plans
  mixed_run_events
  mixed_runs
  operation_authority
  operations
  ops_maintenance
  ops_maintenance_history
  optimizer_settings
  ownership_transfers
  plan_artifact_associations
  plan_artifact_uses
  plan_artifacts
  plan_custody_grants
  plan_custody_reads
  plugin_events
  plugin_grants
  plugin_registrations
  policy_decisions
  portability_exports
  portability_restores
  provider_connections
  reconcile_state
  recovery_epochs
  recovery_items
  release_events
  release_migration_approvals
  release_runs
  resource_adoptions
  resource_observations
  resource_runtime
  resources
  retention_archives
  retention_destinations
  retention_restores
  runner_job_logs
  runner_jobs
  runner_registration_tokens
  runners
  scheduled_job_runs
  schema_migrations
  slo_measurements
  slo_samples
  standalone_plan_backends
  standalone_plan_settlements
  standing_grant_uses
  standing_grants
  state_backend_probes
  state_backend_restores
  tenant_quotas
  workflow_start_intents
  workspace_mfa_controls
  workspace_policy
)
platform_present="$(psql_safe --no-align --tuples-only --set ON_ERROR_STOP=1 \
  --command "select tablename from pg_tables where schemaname = 'platform' order by 1" "$SUPABASE_DB_URL")"
for table in "${PLATFORM_TABLES[@]}"; do
  if ! grep -qx -- "$table" <<<"$platform_present"; then
    echo "::error::platform.${table} is missing after the full platform migration chain." >&2
    exit 1
  fi
done

platform_usage="$(psql_safe --no-align --tuples-only --set ON_ERROR_STOP=1 \
  --command "select has_schema_privilege('service_role','platform','USAGE')" "$SUPABASE_DB_URL")"
if [ "$platform_usage" != "t" ]; then
  echo "::error::service_role has no USAGE on schema platform; the hardening block at the tail of 0014 did not apply." >&2
  exit 1
fi
echo "service_role USAGE on schema platform = ${platform_usage}"

# anon and authenticated must hold nothing on the platform schema.
platform_leak="$(psql_safe --no-align --tuples-only --set ON_ERROR_STOP=1 \
  --command "select has_schema_privilege('anon','platform','USAGE') or has_schema_privilege('authenticated','platform','USAGE')" "$SUPABASE_DB_URL")"
if [ "$platform_leak" != "f" ]; then
  echo "::error::anon or authenticated has USAGE on schema platform; the revoke block at the tail of 0014 did not apply." >&2
  exit 1
fi

# RLS on with no policies: the `hosted`/`agent` rule, repeated for `platform`.
platform_unprotected="$(psql_safe --no-align --tuples-only --set ON_ERROR_STOP=1 \
  --command "select string_agg(relname, ', ' order by relname) from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'platform' and c.relkind = 'r' and not c.relrowsecurity" "$SUPABASE_DB_URL")"
if [ -n "$platform_unprotected" ]; then
  echo "::error::row level security is off on a platform table; every table in the platform schema must enable it." >&2
  exit 1
fi
platform_policies="$(psql_safe --no-align --tuples-only --set ON_ERROR_STOP=1 \
  --command "select count(*) from pg_policies where schemaname = 'platform'" "$SUPABASE_DB_URL")"
if [ "$platform_policies" != "0" ]; then
  echo "::error::the platform schema has RLS policies; it is service-role-only by design (RLS on, no policies)." >&2
  exit 1
fi
echo "platform schema verified: known migration ledger, tables, service-role-only grants, RLS on with no policies."

# Verify the new public RPC boundary independently of the TypeScript tests.
PSQL_PHASE="product_rpc"
echo "--- product RPC verification"
psql_safe --quiet --set ON_ERROR_STOP=1 "$SUPABASE_DB_URL" <<'SQL'
do $$
declare
  signature text;
  routine regprocedure;
begin
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'workspaces' and column_name = 'owner_id'
  ) or to_regclass('public.workspace_invites_pending_email') is null then
    raise exception 'Workspace ownership columns or pending-invitation index are missing';
  end if;

  foreach signature in array array[
    'public.zenith_workspace_sharing(text,text,text,text,text,text,text,text,text,text)',
    'public.zenith_waitlist_join(text,text,text)',
    'public.zenith_waitlist_join_profile(text,text,text,jsonb,text)',
    'public.zenith_waitlist_list(text,bigint,integer)',
    'public.zenith_waitlist_admit(integer,text,text)',
    'public.zenith_waitlist_admitted(text)',
    'public.zenith_waitlist_preview(text,text,integer,uuid[])',
    'public.zenith_waitlist_admit_preview(uuid,text,text)',
    'public.zenith_waitlist_history(integer)',
    'public.zenith_waitlist_history_detail(text,integer,integer)',
    'public.zenith_waitlist_list_filtered(text,bigint,integer,text)',
    'public.zenith_waitlist_rate_limit(text,integer,integer)'
  ] loop
    routine := to_regprocedure(signature);
    if routine is null then
      raise exception 'Product RPC % is missing', signature;
    end if;
    if not has_function_privilege('service_role', routine, 'EXECUTE')
       or has_function_privilege('anon', routine, 'EXECUTE')
       or has_function_privilege('authenticated', routine, 'EXECUTE') then
      raise exception 'Product RPC % does not have a service-role-only execution boundary', signature;
    end if;
  end loop;

  routine := to_regprocedure('public.zenith_before_user_created(jsonb)');
  if routine is null
     or not has_function_privilege('supabase_auth_admin', routine, 'EXECUTE')
     or has_function_privilege('anon', routine, 'EXECUTE')
     or has_function_privilege('authenticated', routine, 'EXECUTE')
     or has_function_privilege('service_role', routine, 'EXECUTE') then
    raise exception 'Waitlist signup hook must be executable only by Supabase Auth';
  end if;

  if (select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relkind = 'r' and c.relrowsecurity
        and c.relname in ('waitlist_entries', 'waitlist_admission_batches', 'waitlist_rate_limits', 'waitlist_admission_previews')) <> 4 then
    raise exception 'Waitlist tables are missing or row level security is disabled';
  end if;
end
$$;
SQL
echo "Workspace ownership and waitlist RPC privileges and schema verified."

echo "All ${#MIGRATIONS[@]} committed migrations applied and verified."
