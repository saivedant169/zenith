/**
 * Renders `supabase/migrations/0026_platform_core.sql` from the TypeScript
 * migrations — the ONLY way that file is produced. It is never hand-edited: a
 * test (`tests/controlplane/migrations.test.ts`) fails when the committed file
 * differs by even one byte from what `renderSupabaseMigration()` returns now,
 * and `npx tsx scripts/platform/emit-sql.ts` rewrites it.
 *
 * What the emitted file is: the schema, every migration's DDL, the ledger rows
 * (with the same checksums the in-process migrator computes, so the migrator
 * recognises a Supabase-applied migration as applied), and aggregate hardening
 * for the entire schema. Pending migration 7 also carries table-specific RLS
 * and guarded known-role privileges for canonical upgrades from schema 6:
 *   - row level security ON for every table in `platform`, with NO policies
 *     (the service role bypasses RLS; nothing else may read these tables);
 *   - `anon` / `authenticated` lose every privilege on the schema;
 *   - `service_role` gets USAGE and table/sequence DML. Migration 7 applies
 *     its matching table grants only to the three new artifact tables.
 * The role statements are guarded by `pg_roles`, so the same file also applies
 * to a plain PostgreSQL (CI, self-hosted) where those roles may not exist.
 *
 * `platform` is NOT added to the Data API's exposed schemas and must not be.
 */
import { BOOTSTRAP_SQL } from "./bootstrap";
import { PLATFORM_MIGRATIONS, migrationChecksum } from "./index";

export const EMITTED_FILE = "0026_platform_core.sql";

const HARDENING_SQL = `do $$
declare
  t record;
  r text;
begin
  for t in select tablename from pg_tables where schemaname = 'platform' loop
    execute format('alter table platform.%I enable row level security', t.tablename);
  end loop;

  foreach r in array array['anon', 'authenticated'] loop
    if exists (select 1 from pg_roles where rolname = r) then
      execute format('revoke all on schema platform from %I', r);
      execute format('revoke all on all tables in schema platform from %I', r);
      execute format('revoke all on all sequences in schema platform from %I', r);
    end if;
  end loop;

  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant usage on schema platform to service_role;
    grant select, insert, update, delete on all tables in schema platform to service_role;
    grant usage, select, update on all sequences in schema platform to service_role;
    alter default privileges in schema platform grant select, insert, update, delete on tables to service_role;
    alter default privileges in schema platform grant usage, select, update on sequences to service_role;
    -- Direct-object custody is immutable and must not inherit aggregate DML.
    if to_regclass('platform.isolation_plan_custody') is not null then
      revoke all on table platform.isolation_plan_custody from service_role;
      grant select, insert on table platform.isolation_plan_custody to service_role;
    end if;
    if to_regclass('platform.workspace_mfa_controls') is not null then
      revoke all on table platform.workspace_mfa_controls from service_role;
      grant select, insert, update on table platform.workspace_mfa_controls to service_role;
    end if;
    -- Permanent agent receipts keep their narrower migration-specific grants.
    -- Guard absence for the exact legacy schema6 upgrade fixture.
    if to_regclass('platform.agent_effect_receipts') is not null then
      revoke update, delete on table platform.agent_effect_receipts from service_role;
    end if;
    -- Workflow-start attempt tombstones must survive aggregate hardening.
    -- Exact rights also remove inherited TRUNCATE, REFERENCES and TRIGGER.
    if to_regclass('platform.workflow_start_intents') is not null then
      revoke all on table platform.workflow_start_intents from service_role;
      grant select, insert, update on table platform.workflow_start_intents to service_role;
    end if;
    -- Approved source authority is immutable, including inherited privileges.
    if to_regclass('platform.approved_source_snapshots') is not null then
      revoke all on table platform.approved_source_snapshots from service_role;
      grant select, insert on table platform.approved_source_snapshots to service_role;
    end if;
    -- Mixed child candidates never inherit DELETE/TRUNCATE or writable descriptor grants.
    if to_regclass('platform.mixed_child_custody') is not null then
      revoke all on table platform.mixed_child_custody from service_role;
      grant select, insert on table platform.mixed_child_custody to service_role;
    end if;
    if to_regclass('platform.mixed_child_intents') is not null then
      revoke all on table platform.mixed_child_intents from service_role;
      grant select, insert, update on table platform.mixed_child_intents to service_role;
    end if;
    if to_regclass('platform.cleanup_writer_epoch') is not null then
      revoke all on table platform.cleanup_writer_epoch,platform.cleanup_writer_scopes,platform.cleanup_writer_holds,platform.cleanup_writer_deliveries,platform.cleanup_owner_grants from service_role;
      grant select on table platform.cleanup_writer_epoch to service_role;
      grant select,insert on table platform.cleanup_writer_scopes,platform.cleanup_writer_holds,platform.cleanup_writer_deliveries,platform.cleanup_owner_grants to service_role;
      grant update on table platform.cleanup_writer_scopes to service_role;
    end if;
    -- Expand-only settlement groundwork (schema 60): append-only, no update or delete rights.
    if to_regclass('platform.cleanup_writer_hold_releases') is not null then
      revoke all on table platform.cleanup_writer_hold_releases,platform.cleanup_writer_settlements,platform.cleanup_direct_attempts from service_role;
      grant select,insert on table platform.cleanup_writer_hold_releases,platform.cleanup_writer_settlements,platform.cleanup_direct_attempts to service_role;
    end if;
    -- Ownership transfers are append-only: select/insert plus one-way revocation columns.
    if to_regclass('platform.ownership_transfers') is not null then
      revoke all on table platform.ownership_transfers from service_role;
      grant select, insert on table platform.ownership_transfers to service_role;
      grant update (revoked_at, revoked_by) on table platform.ownership_transfers to service_role;
    end if;
    if to_regclass('platform.optimizer_settings') is not null then
      revoke all on table platform.optimizer_settings from service_role;
      grant select,insert,update on table platform.optimizer_settings to service_role;
    end if;
    if to_regclass('platform.standalone_plan_settlements') is not null then
      revoke all on table platform.standalone_plan_backends,platform.standalone_plan_settlements from service_role;
      grant select,insert on table platform.standalone_plan_backends,platform.standalone_plan_settlements to service_role;
    end if;
    if to_regclass('platform.machine_runbook_versions') is not null then
      revoke all on table platform.machine_runbook_versions,platform.machine_runbook_approvals,platform.machine_runbook_audit,platform.machine_runbook_schedules,platform.machine_runbook_runs,platform.machine_runbook_run_steps from service_role;
      grant select,insert on table platform.machine_runbook_versions,platform.machine_runbook_approvals,platform.machine_runbook_audit to service_role;
      grant select,insert,update on table platform.machine_runbook_schedules,platform.machine_runbook_runs,platform.machine_runbook_run_steps to service_role;
    end if;
    -- Platform schemas 30 to 36 (wave 3) keep the narrower grants their own migrations set.
    if to_regclass('platform.operation_authority') is not null then
      revoke all on table platform.operation_authority,platform.durable_intents from service_role;
      grant select on table platform.operation_authority to service_role;
      grant select,insert,update on table platform.durable_intents to service_role;
    end if;
    if to_regclass('platform.approved_semantics') is not null then
      revoke all on table platform.approved_semantics,platform.standing_grants,platform.standing_grant_uses from service_role;
      grant select,insert on table platform.approved_semantics to service_role;
      grant select,insert,update on table platform.standing_grants,platform.standing_grant_uses to service_role;
    end if;
    if to_regclass('platform.external_effects') is not null then
      revoke all on table platform.external_effects,platform.external_effect_events,platform.external_effect_resolutions from service_role;
      grant select,insert,update on table platform.external_effects to service_role;
      grant select,insert on table platform.external_effect_events,platform.external_effect_resolutions to service_role;
    end if;
    if to_regclass('platform.k8s_guest_bindings') is not null then
      revoke all on table platform.k8s_guest_bindings from service_role;
      grant select,insert,update on table platform.k8s_guest_bindings to service_role;
    end if;
    if to_regclass('platform.coding_agent_runs') is not null then
      revoke all on table platform.coding_agent_runs from service_role;
      grant select,insert,update on table platform.coding_agent_runs to service_role;
    end if;
    -- Platform schemas 37 to 41 (wave 4) keep the narrower grants their own migrations set.
    if to_regclass('platform.actual_spend_snapshots') is not null then
      revoke all on table platform.actual_spend_snapshots from service_role;
      grant select,insert on table platform.actual_spend_snapshots to service_role;
    end if;
    if to_regclass('platform.ops_maintenance') is not null then
      revoke all on table platform.ops_maintenance,platform.ops_maintenance_history,platform.tenant_quotas from service_role;
      grant select,insert,update on table platform.ops_maintenance to service_role;
      grant select,insert on table platform.ops_maintenance_history to service_role;
      grant select,insert,update,delete on table platform.tenant_quotas to service_role;
    end if;
    if to_regclass('platform.key_custody_keys') is not null then
      revoke all on table platform.key_custody_keys,platform.key_rewrap_jobs from service_role;
      grant select,insert,update on table platform.key_custody_keys,platform.key_rewrap_jobs to service_role;
    end if;
    if to_regclass('platform.mixed_parent_plans') is not null then
      revoke all on table platform.mixed_parent_plans,platform.mixed_child_plans,platform.mixed_child_receipts,platform.mixed_addresses from service_role;
      grant select,insert,update on table platform.mixed_parent_plans,platform.mixed_child_plans to service_role;
      grant select,insert on table platform.mixed_child_receipts,platform.mixed_addresses to service_role;
    end if;
    if to_regclass('platform.mixed_runs') is not null then
      revoke all on table platform.mixed_runs,platform.mixed_run_events,platform.mixed_output_preauthorizations from service_role;
      grant select,insert,update on table platform.mixed_runs,platform.mixed_output_preauthorizations to service_role;
      grant select,insert on table platform.mixed_run_events to service_role;
    end if;
    -- Wave 5 (44 to 52): aggregate grants must preserve every immutable ledger.
    if to_regclass('platform.mixed_output_records') is not null then
      revoke all on table platform.mixed_output_records from service_role;
      grant select,insert on table platform.mixed_output_records to service_role;
    end if;
    if to_regclass('platform.slo_measurements') is not null then
      revoke all on table platform.slo_measurements from service_role;
      grant select,insert on table platform.slo_measurements to service_role;
    end if;
    if to_regclass('platform.recovery_epochs') is not null then
      revoke all on table platform.recovery_epochs,platform.recovery_items from service_role;
      grant select,insert on table platform.recovery_epochs to service_role;
      grant select,insert,update on table platform.recovery_items to service_role;
    end if;
    if to_regclass('platform.legal_holds') is not null then
      revoke all on table platform.legal_holds,platform.retention_archives,platform.retention_destinations,platform.retention_restores from service_role;
      grant select,insert,update on table platform.legal_holds,platform.retention_archives,platform.retention_destinations to service_role;
      grant select,insert on table platform.retention_restores to service_role;
    end if;
    if to_regclass('platform.audit_exports') is not null then
      revoke all on table platform.audit_exports from service_role;
      grant select,insert on table platform.audit_exports to service_role;
    end if;
    if to_regclass('platform.managed_domains') is not null then
      revoke all on table platform.managed_domains,platform.managed_storage_keys from service_role;
      grant select,insert,update on table platform.managed_domains,platform.managed_storage_keys to service_role;
    end if;
    if to_regclass('platform.billing_accounts') is not null then
      revoke all on table platform.billing_accounts,platform.billing_account_events,platform.billing_invoices,platform.billing_usage_events,platform.billing_webhook_events from service_role;
      grant select,insert,update on table platform.billing_accounts,platform.billing_invoices,platform.billing_usage_events,platform.billing_webhook_events to service_role;
      grant select,insert on table platform.billing_account_events to service_role;
    end if;
  end if;
end
$$;
`;

const quote = (text: string): string => `'${text.replace(/'/g, "''")}'`;

/** The exact text of `supabase/migrations/0026_platform_core.sql`. */
export function renderSupabaseMigration(): string {
  const parts: string[] = [
    `-- Zenith platform control store (ADR-0002) — schema \`platform\`.
--
-- GENERATED FILE — DO NOT EDIT.
-- Source:      src/lib/controlplane/db/migrations/*.ts
-- Regenerate:  npx tsx scripts/platform/emit-sql.ts
-- Verified by: tests/controlplane/migrations.test.ts (byte-for-byte)
--
-- Applied by the operator (Supabase SQL editor, or psql against
-- ZENITH_PLATFORM_DB_URL) or by \`npx tsx scripts/platform/migrate.ts\`, which
-- reaches the same end state through the same ledger. Idempotent: re-applying
-- is a no-op. The application never runs DDL against Postgres; it checks
-- \`platform.schema_migrations\` on start and refuses to run when it is behind.
--
-- Row level security is ON for every table with NO policies: the service role
-- bypasses RLS and is the only identity that reads or writes these tables.
-- \`platform\` must never be added to the Data API's exposed schemas.
`,
    BOOTSTRAP_SQL,
  ];
  for (const migration of PLATFORM_MIGRATIONS) {
    parts.push(`-- ============================ migration ${migration.version}: ${migration.name} ============================\n`);
    parts.push(`${migration.sql.trim()}\n`);
    parts.push(
      `insert into platform.schema_migrations (version, name, checksum)\nvalues (${migration.version}, ${quote(migration.name)}, ${quote(migrationChecksum(migration))})\non conflict (version) do nothing;\n`
    );
  }
  parts.push(`-- ============================ hardening (Supabase roles) ============================\n`);
  parts.push(HARDENING_SQL);
  return parts.join("\n");
}

/** Repo-relative path of the emitted file (the script writes it, the sync test reads it). */
export const EMITTED_RELATIVE_PATH = `supabase/migrations/${EMITTED_FILE}`;
