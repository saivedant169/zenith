/**
 * Migrations: apply on a fresh database, re-run is a no-op, tampering is
 * refused, the schema check fails closed with an actionable message, atomicity
 * per migration, concurrent migrators, and the emitted Supabase SQL — which must
 * be byte-identical to what the emitter renders now and must apply cleanly.
 */
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  PLATFORM_MIGRATIONS,
  PLATFORM_SCHEMA_VERSION,
  PlatformSchemaError,
  assertPlatformSchemaCurrent,
  migrationChecksum,
  migratePlatformDb,
  openPlatformDb,
  platformSchemaStatus,
  type PlatformDbHandle,
  type PlatformMigration,
} from "@/lib/controlplane/db";
import { EMITTED_FILE, EMITTED_RELATIVE_PATH, renderSupabaseMigration } from "@/lib/controlplane/db/migrations/emit";
import { ContractMigrationRefusedError } from "@/lib/controlplane/db/compat";
import { BOOTSTRAP_SQL } from "@/lib/controlplane/db/migrations/bootstrap";
import { PG_URL, withScratchDatabase } from "./_support/harness";
import * as repos from "@/lib/controlplane/db/repos";
import { claimOperation, suspendForApproval } from "@/lib/controlplane/operations";
import { proposalFor, uid, user } from "./_support/harness";
import { digest } from "@/lib/controlplane/digest";
import { immutableSourceSnapshot, sourceSnapshotDigest } from "@/lib/execution/source-snapshot";
import { withPlanReview } from "@/lib/controlplane/db/repos/operation-review";
import { normalizePlan } from "@/lib/tofu/plan";
import { extractPlanFacts } from "@/lib/policy/plan-facts";
import { TOFU_VERSION } from "@/lib/tofu/types";
import { planEvidence } from "@/lib/execution/plan-evidence";

if (process.env.ZENITH_TEST_APPROVED_SOURCE_REQUIRED === "1" && !PG_URL) {
  throw new Error("Approved source migration acceptance requires an owned PostgreSQL database.");
}

const core = PLATFORM_MIGRATIONS[0];
/** Every shipped version; the suite must not assume how many migrations exist. */
const ALL = PLATFORM_MIGRATIONS.map((m) => m.version);
/** The next free version, for the synthetic migrations some tests append. */
const NEXT = PLATFORM_MIGRATIONS.length + 1;

const EXPECTED_TABLES = [
  "agent_effect_receipts", "agent_nonces", "approvals", "approved_source_snapshots", "build_launches", "capability_grants", "cleanup_owner_grants", "cleanup_writer_deliveries", "cleanup_writer_epoch", "cleanup_writer_holds",
  "cleanup_writer_scopes", "connection_rotations", "cost_estimates", "drift_reports", "environment_settings", "events", "evidence", "github_binding_events", "github_install_intents", "github_source_bindings",
  "github_webhook_deliveries", "github_webhook_installation_epochs", "idempotency_keys", "incident_maintenance_windows", "incident_postmortems", "incident_remediation_attempts", "incident_signal_state", "incidents",
  "investigations", "leases", "machine_request_logs", "machine_requests", "machine_runbook_approvals", "machine_runbook_audit", "machine_runbook_run_steps", "machine_runbook_runs", "machine_runbook_schedules",
  "machine_runbook_versions", "machines", "mixed_child_custody", "mixed_child_intents", "operations", "optimizer_settings", "plan_artifact_associations", "plan_artifact_uses", "plan_artifacts", "plugin_events", "plugin_grants",
  "plugin_registrations", "policy_decisions", "portability_exports", "portability_restores", "provider_connections", "reconcile_state", "release_events", "release_migration_approvals", "release_runs", "resource_adoptions",
  "resource_observations", "resource_runtime", "resources", "runner_job_logs", "runner_jobs", "runner_registration_tokens", "runners", "scheduled_job_runs", "ownership_transfers", "schema_migrations", "standalone_plan_backends",
  "standalone_plan_settlements", "workflow_start_intents", "workspace_policy",
  // Schema 60 (settled teardown expand): hold generations, settlements and direct attempts.
  "cleanup_direct_attempts", "cleanup_writer_hold_releases", "cleanup_writer_settlements",
  // Platform schemas 30 to 36 (wave 3).
  "operation_authority", "durable_intents", "approved_semantics", "standing_grants", "standing_grant_uses", "plan_custody_grants", "plan_custody_reads", "state_backend_probes", "state_backend_restores", "external_effects", "external_effect_events", "external_effect_resolutions", "k8s_guest_bindings", "mcp_streams", "mcp_stream_events", "coding_agent_runs",
  // Wave 5, after immutable verifier migrations 42/43.
  "mixed_output_records", "slo_samples", "slo_measurements", "recovery_epochs", "recovery_items", "legal_holds", "retention_archives", "retention_destinations", "retention_restores", "audit_exports", "managed_domains", "managed_storage_keys", "billing_accounts", "billing_account_events", "billing_invoices", "billing_usage_events", "billing_webhook_events",
  // Wave 6 integration, schemas 53..58.
  "agent_update_controls", "isolation_plan_custody", "workspace_mfa_controls",
  // Platform schemas 37 to 41 (wave 4).
  "actual_spend_snapshots", "ops_maintenance", "ops_maintenance_history", "tenant_quotas", "key_custody_keys", "key_rewrap_jobs", "mixed_parent_plans", "mixed_child_plans", "mixed_child_receipts", "mixed_addresses", "mixed_runs", "mixed_run_events", "mixed_output_preauthorizations",
];

/** Tables that hold no tenant-visible rows keyed by workspace (see the header of 0001_core.ts). */
// Signed installation events can revoke multiple tenants. These two tables
// are global App-scoped fences/receipts, never tenant-addressable resources.
// The cleanup writer epoch is one installation-wide singleton, not a tenant row.
// Maintenance mode/history and non-secret key custody are installation-wide; tenant_quotas and key_rewrap_jobs remain tenant-scoped.
const NO_WORKSPACE_COLUMN = new Set(["schema_migrations", "agent_nonces", "github_webhook_deliveries", "github_webhook_installation_epochs", "cleanup_writer_epoch", "scheduled_job_runs", "ops_maintenance", "ops_maintenance_history", "key_custody_keys", "slo_samples", "slo_measurements", "recovery_epochs", "billing_webhook_events"]);

interface Lane {
  name: string;
  /** a fresh, empty, un-migrated database */
  withFresh<T>(fn: (open: (migrate: boolean) => Promise<PlatformDbHandle>) => Promise<T>): Promise<T>;
}

const lanes: Lane[] = [
  {
    name: "pglite",
    withFresh: async (fn) => {
      const opened: PlatformDbHandle[] = [];
      try {
        // in-memory PGlite databases are independent, so "reopen" is not possible; tests use one handle
        return await fn(async (migrate) => {
          const db = await openPlatformDb({ kind: "pglite", migrate });
          opened.push(db);
          return db;
        });
      } finally {
        await Promise.all(opened.map((d) => d.close()));
      }
    },
  },
  ...(PG_URL
    ? [
        {
          name: "postgres",
          withFresh: <T>(fn: (open: (migrate: boolean) => Promise<PlatformDbHandle>) => Promise<T>) =>
            withScratchDatabase(async (url) => {
              const opened: PlatformDbHandle[] = [];
              try {
                return await fn(async (migrate) => {
                  const db = await openPlatformDb({ kind: "postgres", url, migrate, max: 3 });
                  opened.push(db);
                  return db;
                });
              } finally {
                await Promise.all(opened.map((d) => d.close()));
              }
            }),
        },
      ]
    : []),
];

/** Historical SQL fixture setup never supplies current contract admission. */
async function historicalFixtureRange(db: PlatformDbHandle, from: number, through: number) {
  const prior = PLATFORM_MIGRATIONS.filter(m => m.version < from);
  await assertPlatformSchemaCurrent(db, prior);
  const ledger = await db.query("select * from platform.schema_migrations order by version");
  expect(ledger.map(row => row.version)).toEqual(prior.map(m => m.version));
  const emitted = renderSupabaseMigration();
  const first = PLATFORM_MIGRATIONS.find(m => m.version === from)!;
  const after = PLATFORM_MIGRATIONS.find(m => m.version === through + 1)!;
  const start = emitted.indexOf(`-- ============================ migration ${first.version}: ${first.name} `);
  const end = emitted.indexOf(`-- ============================ migration ${after.version}: ${after.name} `);
  if (start < 0 || end <= start) throw new Error("Canonical historical fixture boundaries are unavailable.");
  // No aggregate hardening here: creator defaults/owner context remain the
  // actual counterexample under test. These bytes are historical fixture DDL.
  await db.exec(emitted.slice(start, end));
  expect(await db.query("select * from platform.schema_migrations where version<$1 order by version", [from])).toEqual(ledger);
  await assertPlatformSchemaCurrent(db, PLATFORM_MIGRATIONS.filter(m => m.version <= through));
}

/** Only the already approved repair 42 is admitted across owned, drained fixtures. */
async function withOwnedHistoricalRepairAdmission<T>(admit42: boolean, fixture: () => Promise<T>): Promise<T> {
  const admission = process.env.ZENITH_ALLOW_CONTRACT_MIGRATIONS;
  try {
    if (admit42) process.env.ZENITH_ALLOW_CONTRACT_MIGRATIONS = [admission, "42"].filter(Boolean).join(",");
    return await fixture();
  } finally {
    if (admission === undefined) delete process.env.ZENITH_ALLOW_CONTRACT_MIGRATIONS;
    else process.env.ZENITH_ALLOW_CONTRACT_MIGRATIONS = admission;
  }
}

/** Successful historical upgrade fixtures explicitly model drained Wave 5 writers. */
async function migrateDrainedWave5(db: PlatformDbHandle) {
  const admission = process.env.ZENITH_ALLOW_CONTRACT_MIGRATIONS;
  try {
    process.env.ZENITH_ALLOW_CONTRACT_MIGRATIONS = [admission, "49", "51", "57", "58", "61"].filter(Boolean).join(",");
    return await migratePlatformDb(db);
  } finally {
    if (admission === undefined) delete process.env.ZENITH_ALLOW_CONTRACT_MIGRATIONS;
    else process.env.ZENITH_ALLOW_CONTRACT_MIGRATIONS = admission;
  }
}

async function expectHistoricalContractRefusal(db: PlatformDbHandle, versions: number[], target = PLATFORM_MIGRATIONS) {
  const ledger = await db.query("select * from platform.schema_migrations order by version");
  // Retain all rows this fixture principal can read; distinct-owner fixtures
  // deliberately include unrelated tables for which it has REFERENCES only.
  const tables = await db.query<{ tablename: string }>("select tablename from pg_tables where schemaname='platform' and has_table_privilege(current_user,quote_ident(schemaname)||'.'||quote_ident(tablename),'SELECT') order by tablename");
  const rows = () => Promise.all(tables.map(({ tablename }) => db.query(`select to_jsonb(t) as row from platform.${JSON.stringify(tablename)} t order by to_jsonb(t)::text`)));
  const before = await rows();
  const enforcement = process.env.ZENITH_ENFORCE_EXPAND_ONLY;
  try {
    process.env.ZENITH_ENFORCE_EXPAND_ONLY = "1";
    const error = await migratePlatformDb(db, target).catch((error: unknown) => error);
    expect(error).toBeInstanceOf(ContractMigrationRefusedError);
    expect((error as ContractMigrationRefusedError).details?.versions).toEqual(versions);
    for (const version of versions) expect((error as Error).message).toContain(`migration ${version} (`);
    expect((error as Error).message).toContain("no LIFE-10 approval is registered");
  } finally {
    if (enforcement === undefined) delete process.env.ZENITH_ENFORCE_EXPAND_ONLY;
    else process.env.ZENITH_ENFORCE_EXPAND_ONLY = enforcement;
  }
  expect(await db.query("select * from platform.schema_migrations order by version")).toEqual(ledger);
  expect(await rows()).toEqual(before);
}

describe("migration set", () => {
  it("has contiguous versions from 1, unique names, and a stable checksum of the SQL text", () => {
    expect(PLATFORM_MIGRATIONS.map((m) => m.version)).toEqual(PLATFORM_MIGRATIONS.map((_, i) => i + 1));
    expect(new Set(PLATFORM_MIGRATIONS.map((m) => m.name)).size).toBe(PLATFORM_MIGRATIONS.length);
    expect(migrationChecksum(core)).toMatch(/^[0-9a-f]{64}$/);
    expect(migrationChecksum(core)).toBe(migrationChecksum({ ...core }));
    expect(migrationChecksum({ ...core, sql: `${core.sql} ` })).not.toBe(migrationChecksum(core));
  });

  it("preserves the checksums of shipped migrations 1 through 5", () => {
    expect(PLATFORM_MIGRATIONS.slice(0, 5).map(migrationChecksum)).toEqual([
      "ec4e2c1a7185e25ea6afa803e87abcc1fe8a06cb65651773f573f0b66de13764",
      "af708ba78998ba35b05966afc4f037bacec9b38905853e6f43c8fdab92cb47f0",
      "e1eccac97c7852592bcad8cd0e441b67a442c7405735ee9e2619e9e9b100bec6",
      "1e5d84e018bd35c3638bbd23bab8e5b0e7d9b6c3173a430259480508aca6f311",
      "e8349e5ddf50a5396304850bd84bbffe81be1f4b0b7189677c1c1ad36ad4a387",
    ]);
  });

  it("preserves the accepted SQL checksums 1 through 12 and derives the current schema from the canonical list", () => {
    expect(PLATFORM_MIGRATIONS.filter(m => m.version <= 12).map(migrationChecksum)).toEqual([
      "ec4e2c1a7185e25ea6afa803e87abcc1fe8a06cb65651773f573f0b66de13764",
      "af708ba78998ba35b05966afc4f037bacec9b38905853e6f43c8fdab92cb47f0",
      "e1eccac97c7852592bcad8cd0e441b67a442c7405735ee9e2619e9e9b100bec6",
      "1e5d84e018bd35c3638bbd23bab8e5b0e7d9b6c3173a430259480508aca6f311",
      "e8349e5ddf50a5396304850bd84bbffe81be1f4b0b7189677c1c1ad36ad4a387",
      "0e256ace8f784b996b2e6687dc42bb4705f91c4579b4ecb1da38987d9f68d78d",
      "eb445d8479b4b8ba8c9c6e8df38fb95c3f9ca59f8949218e3c07f68727f62ae3",
      "90a025fd0c76ee84b14a26c9d8b1794e215ececec24333848904c22bc0f86e9d",
      "7d00eb79279b57c682dda67af0a5eaffc5ff3825d5e6a370235dd0dfdb502060",
      "a4436e385563b8bd3b3528708b1db757c5a9872e1927dbd8ef5bd595e1e62bfd",
      "f6c9d90f69447e430ad9ef2b8368b137b26cadcd05776d689959c99da9e0430b",
      "7eaa5e87e594d741e772e0cd9b77010c796d36c2c9ceac41f8f47720c804d811",
    ]);
    expect(PLATFORM_SCHEMA_VERSION).toBe(PLATFORM_MIGRATIONS.at(-1)?.version);
    expect(PLATFORM_MIGRATIONS.find(m => m.version === 13)?.name).toBe("approved_source_snapshots");
    const ownership = PLATFORM_MIGRATIONS.find(m => m.version === 18);
    expect(ownership?.name).toBe("ownership_transfers");
    expect(ownership && migrationChecksum(ownership)).toBe("d19177da5b80a5bde2ea6b51d232f288d7123546d7aca483d216d710bd769e7a");
  });

  it("the emitted Supabase file is byte-identical to what the emitter renders now", () => {
    const committed = fs.readFileSync(path.join(process.cwd(), EMITTED_RELATIVE_PATH), "utf8");
    expect(committed).toBe(renderSupabaseMigration());
    expect(EMITTED_RELATIVE_PATH).toBe(`supabase/migrations/${EMITTED_FILE}`);
    // and it carries this build's checksum for every migration (so the TS migrator recognises it)
    for (const m of PLATFORM_MIGRATIONS) expect(committed).toContain(migrationChecksum(m));
    expect(committed).toContain("enable row level security");
    expect(committed).toMatch(/revoke all on schema platform from %I/);
    expect(committed).toMatch(/grant usage on schema platform to service_role/);
    expect(committed).not.toMatch(/create policy/i);
  });

  it("rendering is deterministic", () => {
    expect(renderSupabaseMigration()).toBe(renderSupabaseMigration());
  });
});

describe.each(lanes)("migrator [$name]", (lane) => {
  let allowedBefore: string | undefined;
  beforeEach(() => {
    // These are freshly owned scratch databases with no live N-1 writers.
    // Historical upgrade rehearsals explicitly admit only this approved repair.
    allowedBefore = process.env.ZENITH_ALLOW_CONTRACT_MIGRATIONS;
    process.env.ZENITH_ALLOW_CONTRACT_MIGRATIONS = [allowedBefore, "42"].filter(Boolean).join(",");
  });
  afterEach(() => {
    if (allowedBefore === undefined) delete process.env.ZENITH_ALLOW_CONTRACT_MIGRATIONS;
    else process.env.ZENITH_ALLOW_CONTRACT_MIGRATIONS = allowedBefore;
  });

  it("repairs published external-effect key checks through an approved upgrade without changing history or authority", async () => {
    await lane.withFresh(async (open) => {
      const db = await open(false);
      const previous = PLATFORM_MIGRATIONS.filter((m) => m.version < 42);
      const repair = PLATFORM_MIGRATIONS.find((m) => m.version === 42)!;
      await migratePlatformDb(db, previous);
      const history = await db.query("select * from platform.schema_migrations order by version");
      const authority = () => db.query(`select c.relrowsecurity, c.relacl::text,
        (select array_agg(t.tgname order by t.tgname) from pg_trigger t where t.tgrelid=c.oid and not t.tgisinternal) as triggers
        from pg_class c where c.oid='platform.external_effects'::regclass`);
      const before = await authority();
      const workspaceId = uid("ws");
      const { operation } = await repos.operations.create(db, { workspaceId, principal: user(), proposal: proposalFor(workspaceId), status: "awaiting_approval" });
      const insert = (key: string, token: string | null) => db.query(`insert into platform.external_effects
        (workspace_id,effect_id,family,operation_id,provider,dedup_key,request_digest,idempotency_token,idempotency_supported)
        values ($1,$2,'build_launch',$3,'aws',$4,$5,$6,false)`, [workspaceId,uid("fx"),operation.id,key,"a".repeat(64),token]);
      await expect(insert("before", null)).rejects.toThrow("invalid repetition count");
      const oldAllowed = process.env.ZENITH_ALLOW_CONTRACT_MIGRATIONS;
      const oldEnforcement = process.env.ZENITH_ENFORCE_EXPAND_ONLY;
      try {
        process.env.ZENITH_ENFORCE_EXPAND_ONLY = "1";
        delete process.env.ZENITH_ALLOW_CONTRACT_MIGRATIONS;
        await expect(migratePlatformDb(db)).rejects.toThrow("previous release is drained");
        expect(await db.query("select * from platform.schema_migrations order by version")).toEqual(history);
        process.env.ZENITH_ALLOW_CONTRACT_MIGRATIONS = "42";
        expect((await migratePlatformDb(db, PLATFORM_MIGRATIONS.filter(m => m.version <= 42))).applied).toEqual([42]);
        expect(await db.query("select * from platform.schema_migrations where version < 42 order by version")).toEqual(history);
        expect(await authority()).toEqual(before);
        for (const length of [1,255,256]) await insert("k".repeat(length),"t".repeat(length));
        await insert("Az09_.:/=+-", "Az09_.:-");
        await insert("null-token", null);
        for (const bad of ["", "x".repeat(257), "space key", "x\ny", "é", "@", "x\n"]) {
          await expect(insert(bad, null)).rejects.toMatchObject({ sqlstate: "23514", constraint: "external_effects_dedup_key_check" });
          await expect(insert(uid("key"), bad)).rejects.toMatchObject({ sqlstate: "23514", constraint: "external_effects_idempotency_token_check" });
        }
        for (const bad of ["/", "=", "+"]) await expect(insert(uid("key"), bad)).rejects.toMatchObject({ sqlstate: "23514", constraint: "external_effects_idempotency_token_check" });
        const rows = await db.query("select * from platform.external_effects where workspace_id=$1 order by effect_id", [workspaceId]);
        expect(rows).toHaveLength(5);
        await db.tx(async (tx) => { await tx.query(repair.sql); });
        expect(await db.query("select * from platform.external_effects where workspace_id=$1 order by effect_id", [workspaceId])).toEqual(rows);
        expect((await migratePlatformDb(db, PLATFORM_MIGRATIONS.filter(m => m.version <= 42))).applied).toEqual([]);
      } finally {
        if (oldAllowed === undefined) delete process.env.ZENITH_ALLOW_CONTRACT_MIGRATIONS;
        else process.env.ZENITH_ALLOW_CONTRACT_MIGRATIONS = oldAllowed;
        if (oldEnforcement === undefined) delete process.env.ZENITH_ENFORCE_EXPAND_ONLY;
        else process.env.ZENITH_ENFORCE_EXPAND_ONLY = oldEnforcement;
      }
    });
  }, 60_000);

  it("upgrades existing approvals without dropping their audit history, permitting a fresh plan round", async () => {
    await lane.withFresh(async (open) => {
      const db = await open(false);
      const legacy = PLATFORM_MIGRATIONS.filter((m) => m.version < 4);
      await migratePlatformDb(db, legacy);
      const workspaceId = uid("ws");
      const approver = user();
      const { operation: op } = await repos.operations.create(db, { workspaceId, principal: user(), proposal: proposalFor(workspaceId), status: "awaiting_approval" });
      const approvalId = uid("approval");
      await db.query(`insert into platform.approvals
        (id, workspace_id, operation_id, proposal_digest, decision, approver, approver_id, approver_role, policy_version, expires_at)
        values ($1,$2,$3,$4,'approve',$5::text::jsonb,$6,'editor','legacy',clock_timestamp() + interval '1 hour')`,
      [approvalId, workspaceId, op.id, op.proposalDigest, JSON.stringify(approver), approver.id]);
      await db.query("update platform.operations set status = 'approved' where workspace_id = $1 and id = $2", [workspaceId, op.id]);
      // 61 (hold generations) drops the holds primary key: a contract migration with no LIFE-10 approval registered yet.
      await expectHistoricalContractRefusal(db, [4, 5, 11, 15, 28, 30, 49, 51, 57, 58, 61]);
      await historicalFixtureRange(db, 4, 30);
      expect((await migrateDrainedWave5(db)).applied).toEqual(PLATFORM_MIGRATIONS.filter(m => m.version > 30).map(m => m.version));
      expect(await db.query("select approval_round from platform.approvals where workspace_id = $1 and id = $2", [workspaceId, approvalId])).toEqual([{ approval_round: 0 }]);
      await claimOperation(db, { workspaceId, id: op.id, expectedDigest: op.proposalDigest, holder: "worker" });
      await suspendForApproval(db, { workspaceId, id: op.id });
      await repos.approvals.record(db, { workspaceId, operationId: op.id, approver, approverRole: "editor", decision: "approve", proposalDigest: op.proposalDigest, policyVersion: "plan" });
      expect(await db.query("select approval_round from platform.approvals where workspace_id = $1 and operation_id = $2 order by approval_round", [workspaceId, op.id])).toEqual([{ approval_round: 0 }, { approval_round: 1 }]);
      expect((await repos.approvals.listForOperation(db, workspaceId, op.id))[0].id).toBe(approvalId);
    });
  }, 60_000);

  it("applies on a fresh database, records the ledger with checksums, and re-running is a no-op", async () => {
    await lane.withFresh(async (open) => {
      const db = await open(false);
      const before = await platformSchemaStatus(db);
      expect(before).toMatchObject({ ledgerPresent: false, current: false });
      expect(before.pending.map((m) => m.version)).toEqual(ALL);

      const first = await migratePlatformDb(db);
      expect(first).toEqual({ applied: ALL, alreadyApplied: [] });
      const status = await platformSchemaStatus(db);
      expect(status).toMatchObject({ ledgerPresent: true, current: true, pending: [], tampered: [], ahead: [] });
      expect(status.applied[0]).toMatchObject({ version: 1, name: "core", checksum: migrationChecksum(core) });
      expect(status.applied[0].appliedAt).toMatch(/^\d{4}-\d{2}-\d{2}T.*Z$/);

      const second = await migratePlatformDb(db);
      expect(second).toEqual({ applied: [], alreadyApplied: ALL });
      await assertPlatformSchemaCurrent(db);

      const tables = await db.query<{ table_name: string }>("select table_name from information_schema.tables where table_schema = 'platform' order by table_name");
      expect(tables.map((t) => t.table_name).sort()).toEqual([...EXPECTED_TABLES].sort());
      // Explicit isolated PGlite fixtures have no Supabase roles; guarded migration-7 hardening must still apply.
      if(lane.name==="pglite")expect(await db.query("select rolname from pg_roles where rolname in ('anon','authenticated','service_role')")).toEqual([]);
      expect(await db.query(`select c.relname as name,c.relrowsecurity as rls from pg_class c join pg_namespace n on n.oid=c.relnamespace
        where n.nspname='platform' and c.relname in ('plan_artifacts','plan_artifact_associations','plan_artifact_uses') order by c.relname`)).toEqual([
          {name:"plan_artifact_associations",rls:true},{name:"plan_artifact_uses",rls:true},{name:"plan_artifacts",rls:true},
        ]);
    });
  }, 60_000);

  it("every tenant table has a NOT NULL workspace_id and an index that leads with it", async () => {
    await lane.withFresh(async (open) => {
      const db = await open(true);
      const columns = await db.query<{ table_name: string; is_nullable: string }>(
        "select table_name, is_nullable from information_schema.columns where table_schema = 'platform' and column_name = 'workspace_id'"
      );
      const withWorkspace = new Map(columns.map((c) => [c.table_name, c.is_nullable]));
      const tables = EXPECTED_TABLES.filter((t) => !NO_WORKSPACE_COLUMN.has(t));
      expect(withWorkspace.has("cleanup_writer_epoch")).toBe(false);
      expect(withWorkspace.has("key_custody_keys")).toBe(false);
      expect(withWorkspace.get("key_rewrap_jobs")).toBe("NO");
      expect(await db.query("select singleton from platform.cleanup_writer_epoch")).toEqual([{ singleton: true }]);
      for (const t of tables) expect(withWorkspace.has(t), `${t} has workspace_id`).toBe(true);
      // leases carry an OPTIONAL workspace id (scopes such as env:<id> are globally unique); everything else is NOT NULL
      for (const t of tables.filter((x) => x !== "leases")) expect(withWorkspace.get(t), `${t}.workspace_id nullable`).toBe("NO");
      expect(withWorkspace.get("leases")).toBe("YES");

      const indexed = await db.query<{ table_name: string }>(
        `select distinct c.relname as table_name
           from pg_index i
           join pg_class c on c.oid = i.indrelid
           join pg_namespace n on n.oid = c.relnamespace
           join pg_attribute a on a.attrelid = c.oid and a.attnum = i.indkey[0]
          where n.nspname = 'platform' and a.attname = 'workspace_id'`
      );
      const leading = new Set(indexed.map((r) => r.table_name));
      for (const t of tables) expect(leading.has(t), `${t} has an index leading with workspace_id`).toBe(true);
      expect(await db.query<{ definition: string }>("select indexdef as definition from pg_indexes where schemaname='platform' and indexname='machine_runbook_schedules_scope'")).toEqual([
        { definition: "CREATE INDEX machine_runbook_schedules_scope ON platform.machine_runbook_schedules USING btree (workspace_id, created_at DESC)" },
      ]);

      // This global physical target key is not a tenancy exemption: its owning
      // tuple is immutable, and every private completion also binds that tuple.
      const target = digest(uid("physical_target")), workspaceId = uid("ws");
      const projectId = uid("project"), environmentId = uid("environment"), backend = digest(uid("backend"));
      const primary = await db.query<{ column_name: string }>(`select k.column_name from information_schema.table_constraints c
        join information_schema.key_column_usage k on k.constraint_schema=c.constraint_schema and k.constraint_name=c.constraint_name
        where c.table_schema='platform' and c.table_name='standalone_plan_backends' and c.constraint_type='PRIMARY KEY' order by k.ordinal_position`);
      expect(primary.map(column => column.column_name)).toEqual(["target_digest"]);
      await db.query(`insert into platform.standalone_plan_backends(target_digest,workspace_id,project_id,environment_id,backend_digest)
        values($1,$2,$3,$4,$5)`, [target,workspaceId,projectId,environmentId,backend]);
      for (const foreign of [[uid("foreign_ws"),projectId,environmentId], [workspaceId,uid("foreign_project"),environmentId], [workspaceId,projectId,uid("foreign_environment")]]) {
        expect(await db.query(`insert into platform.standalone_plan_backends(target_digest,workspace_id,project_id,environment_id,backend_digest)
          values($1,$2,$3,$4,$5) on conflict do nothing returning target_digest`, [target,...foreign,backend])).toEqual([]);
        expect(await db.query(`select target_digest from platform.standalone_plan_backends
          where target_digest=$1 and workspace_id=$2 and project_id=$3 and environment_id=$4 and backend_digest=$5`, [target,...foreign,backend])).toEqual([]);
      }
      const originalOwner = await db.query("select * from platform.standalone_plan_backends where target_digest=$1", [target]);
      await expect(db.query("update platform.standalone_plan_backends set workspace_id=$2 where target_digest=$1", [target,uid("foreign_ws")])).rejects.toThrow();
      await expect(db.query("delete from platform.standalone_plan_backends where target_digest=$1", [target])).rejects.toThrow();
      expect(await db.query("select * from platform.standalone_plan_backends where target_digest=$1", [target])).toEqual(originalOwner);
      expect(await db.query<{ name: string; rls: boolean }>(`select c.relname as name,c.relrowsecurity as rls from pg_class c join pg_namespace n on n.oid=c.relnamespace
        where n.nspname='platform' and c.relname in ('standalone_plan_backends','standalone_plan_settlements') order by c.relname`)).toEqual([
        {name:"standalone_plan_backends",rls:true},{name:"standalone_plan_settlements",rls:true},
      ]);
      expect(await db.query<{ name: string }>(`select t.tgname as name from pg_trigger t join pg_class c on c.oid=t.tgrelid join pg_namespace n on n.oid=c.relnamespace
        where n.nspname='platform' and not t.tgisinternal and c.relname in ('standalone_plan_backends','standalone_plan_settlements') order by t.tgname`)).toEqual([
        {name:"immutable_standalone_plan_backend"},{name:"immutable_standalone_plan_settlement"},
      ]);

      for (const [table, keys] of [
        ["github_webhook_installation_epochs", ["app_id", "installation_id"]],
        ["github_webhook_deliveries", ["app_id", "delivery_id"]],
      ] as const) {
        expect(withWorkspace.has(table), `${table} is explicitly App-scoped`).toBe(false);
        const columns = await db.query<{ column_name: string; is_nullable: string }>(
          "select column_name, is_nullable from information_schema.columns where table_schema='platform' and table_name=$1", [table]);
        for (const key of keys) expect(columns.find(column => column.column_name === key)?.is_nullable, `${table}.${key} cannot be unscoped`).toBe("NO");
        const primary = await db.query<{ column_name: string }>(`select k.column_name from information_schema.table_constraints c
          join information_schema.key_column_usage k on k.constraint_schema=c.constraint_schema and k.constraint_name=c.constraint_name
          where c.table_schema='platform' and c.table_name=$1 and c.constraint_type='PRIMARY KEY' order by k.ordinal_position`, [table]);
        expect(primary.map(column => column.column_name)).toEqual(keys);
        const [security] = await db.query<{ rls: boolean }>(`select c.relrowsecurity as rls from pg_class c join pg_namespace n on n.oid=c.relnamespace
          where n.nspname='platform' and c.relname=$1`, [table]);
        expect(security.rls).toBe(true);
      }
    });
  }, 60_000);

  it("refuses to proceed when an applied migration's checksum no longer matches the code", async () => {
    await lane.withFresh(async (open) => {
      const db = await open(true);
      const tampered: PlatformMigration = { ...core, sql: `${core.sql}\n-- edited after release\n` };
      const err = await migratePlatformDb(db, [tampered]).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(PlatformSchemaError);
      expect((err as PlatformSchemaError).code).toBe("schema_tampered");
      expect((err as PlatformSchemaError).message).toMatch(/never be edited/);
      await expect(assertPlatformSchemaCurrent(db, [tampered])).rejects.toMatchObject({ code: "schema_tampered" });
      expect((await platformSchemaStatus(db, [tampered])).tampered).toEqual([
        { version: 1, name: "core", expected: migrationChecksum(tampered), actual: migrationChecksum(core) },
      ]);
      // and a pending second migration in the same call is NOT applied behind a tampered first
      const extra: PlatformMigration = { version: NEXT, name: "extra", sql: "create table platform.zz_never (id int);" };
      await expect(migratePlatformDb(db, [tampered, ...PLATFORM_MIGRATIONS.slice(1), extra])).rejects.toMatchObject({ code: "schema_tampered" });
      expect(await db.query("select 1 from information_schema.tables where table_schema = 'platform' and table_name = 'zz_never'")).toEqual([]);
    });
  }, 60_000);

  it("fails closed when behind, naming the command and the file; migrating then satisfies it", async () => {
    await lane.withFresh(async (open) => {
      const db = await open(false);
      const missingLedger = await assertPlatformSchemaCurrent(db).catch((e: unknown) => e);
      expect(missingLedger).toBeInstanceOf(PlatformSchemaError);
      expect((missingLedger as PlatformSchemaError).code).toBe("schema_behind");
      expect((missingLedger as Error).message).toContain("npx tsx scripts/platform/migrate.ts");
      expect((missingLedger as Error).message).toContain("supabase/migrations/0014_platform_core.sql");

      await migratePlatformDb(db);
      const second: PlatformMigration = { version: NEXT, name: "second", sql: "create table if not exists platform.zz_second (id int primary key);" };
      const behind = await assertPlatformSchemaCurrent(db, [...PLATFORM_MIGRATIONS, second]).catch((e: unknown) => e);
      expect((behind as PlatformSchemaError).code).toBe("schema_behind");
      expect((behind as Error).message).toContain(`${NEXT} ("second")`);

      expect(await migratePlatformDb(db, [...PLATFORM_MIGRATIONS, second])).toEqual({ applied: [NEXT], alreadyApplied: ALL });
      await assertPlatformSchemaCurrent(db, [...PLATFORM_MIGRATIONS, second]);
    });
  }, 60_000);

  it("tolerates a database that is ahead of this build (a newer deploy already migrated)", async () => {
    await lane.withFresh(async (open) => {
      const db = await open(true);
      const newer: PlatformMigration = { version: NEXT, name: "newer", sql: "create table if not exists platform.zz_newer (id int primary key);" };
      await migratePlatformDb(db, [...PLATFORM_MIGRATIONS, newer]);
      const status = await platformSchemaStatus(db); // this build does not know the newest version
      expect(status).toMatchObject({ current: true, ahead: [NEXT], pending: [], tampered: [] });
      await assertPlatformSchemaCurrent(db);
    });
  }, 60_000);

  it("applies each migration atomically with its ledger row: a failing migration leaves nothing behind", async () => {
    await lane.withFresh(async (open) => {
      const db = await open(true);
      const ok: PlatformMigration = { version: NEXT, name: "ok", sql: "create table platform.zz_ok (id int primary key);" };
      const broken: PlatformMigration = {
        version: NEXT + 1,
        name: "broken",
        sql: "create table platform.zz_half (id int primary key);\ncreate table platform.zz_bad (id int references platform.does_not_exist (id));",
      };
      await expect(migratePlatformDb(db, [...PLATFORM_MIGRATIONS, ok, broken])).rejects.toMatchObject({ code: "db_error" });
      const status = await platformSchemaStatus(db, [...PLATFORM_MIGRATIONS, ok, broken]);
      expect(status.applied.map((a) => a.version)).toEqual([...ALL, NEXT]); // `ok` stays applied, `broken` left no trace
      expect(await db.query("select 1 from information_schema.tables where table_schema = 'platform' and table_name = 'zz_half'")).toEqual([]);
    });
  }, 60_000);

  it("the emitted SQL applies on a fresh database, is idempotent, and is recognised by the TypeScript migrator", async () => {
    await lane.withFresh(async (open) => {
      const db = await open(false);
      const emitted = renderSupabaseMigration();
      await db.exec(emitted);
      await db.exec(emitted); // re-applying is a no-op
      const status = await platformSchemaStatus(db);
      expect(status).toMatchObject({ ledgerPresent: true, current: true, tampered: [] });
      expect(status.applied.map((a) => ({ v: a.version, n: a.name, c: a.checksum }))).toEqual(
        PLATFORM_MIGRATIONS.map((m) => ({ v: m.version, n: m.name, c: migrationChecksum(m) }))
      );
      expect(await migratePlatformDb(db)).toEqual({ applied: [], alreadyApplied: ALL });
      const tables = await db.query<{ table_name: string }>("select table_name from information_schema.tables where table_schema = 'platform' order by table_name");
      expect(tables.map((t) => t.table_name).sort()).toEqual([...EXPECTED_TABLES].sort());
      // Explicit isolated PGlite fixtures have no Supabase roles; guarded migration-7 hardening must still apply.
      if(lane.name==="pglite")expect(await db.query("select rolname from pg_roles where rolname in ('anon','authenticated','service_role')")).toEqual([]);
      expect(await db.query(`select c.relname as name,c.relrowsecurity as rls from pg_class c join pg_namespace n on n.oid=c.relnamespace
        where n.nspname='platform' and c.relname in ('plan_artifacts','plan_artifact_associations','plan_artifact_uses') order by c.relname`)).toEqual([
          {name:"plan_artifact_associations",rls:true},{name:"plan_artifact_uses",rls:true},{name:"plan_artifacts",rls:true},
        ]);

      // hardening: RLS is on for every table, and there are NO policies
      const unprotected = await db.query<{ relname: string }>(
        `select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
          where n.nspname = 'platform' and c.relkind = 'r' and not c.relrowsecurity`
      );
      expect(unprotected).toEqual([]);
      expect(await db.query("select 1 from pg_policies where schemaname = 'platform'")).toEqual([]);
    });
  }, 60_000);

  it("the emitted SQL grants only service_role and revokes anon/authenticated when the Supabase roles exist", async () => {
    await lane.withFresh(async (open) => {
      const db = await open(false);
      const rollback = new Error("rollback the role creation");
      // Scratch databases share PostgreSQL's cluster-wide Supabase roles. Keep
      // existing definitions and memberships; only absent roles belong to this fixture.
      const readRoleBoundary = async () => {
        const definitions = await db.query<{ name: string; configuration: string | null; [key: string]: unknown }>(
          `select oid::text as oid, rolname as name, rolsuper, rolinherit, rolcreaterole, rolcreatedb,
                  rolcanlogin, rolreplication, rolconnlimit, rolvaliduntil::text as rolvaliduntil,
                  rolbypassrls, rolconfig::text as configuration
             from pg_roles where rolname in ('anon','authenticated','service_role') order by rolname`
        );
        return {
          // Role configuration can contain private values. Compare its digest without exposing it.
          definitions: definitions.map(({ configuration, ...definition }) => ({ ...definition, configurationDigest: digest(configuration) })),
          memberships: await db.query(
            `select to_jsonb(m) as membership from pg_auth_members m
              where m.roleid in (select oid from pg_roles where rolname in ('anon','authenticated','service_role'))
                 or m.member in (select oid from pg_roles where rolname in ('anon','authenticated','service_role'))
                 or m.grantor in (select oid from pg_roles where rolname in ('anon','authenticated','service_role'))
              order by m.roleid, m.member, m.grantor`
          ),
          databaseAcl: await db.query("select datacl::text as acl from pg_database where datname=current_database()"),
          schemaAcl: await db.query("select nspname, nspacl::text as acl from pg_namespace where nspname in ('public','platform') order by nspname"),
          defaultAcl: await db.query("select to_jsonb(d) as default_acl from pg_default_acl d order by d.oid"),
        };
      };
      const rolesBefore = await readRoleBoundary();
      const createdRoles = ([
        ["anon", "create role anon nologin noinherit"],
        ["authenticated", "create role authenticated nologin noinherit"],
        ["service_role", "create role service_role nologin noinherit bypassrls"],
      ] as const).filter(([name]) => !rolesBefore.definitions.some(role => role.name === name));
      const createdNames = new Set<string>(createdRoles.map(([name]) => name));
      // All role creation, canonical schema/ACL DDL and default privileges roll back together.
      const result = await db
        .tx(async (tx) => {
          for (const [, statement] of createdRoles) await tx.query(statement);
          await (tx as unknown as { exec(t: string): Promise<void> }).exec(renderSupabaseMigration());
          const rows = await tx.query<Record<string, boolean>>(
            `select has_schema_privilege('service_role', 'platform', 'USAGE') as service_usage,
                    has_table_privilege('service_role', 'platform.operations', 'SELECT,INSERT,UPDATE,DELETE') as service_dml,
                    has_sequence_privilege('service_role', 'platform.events_seq_seq', 'USAGE') as service_seq,
                    has_schema_privilege('anon', 'platform', 'USAGE') as anon_usage,
                    has_schema_privilege('authenticated', 'platform', 'USAGE') as auth_usage,
                    has_table_privilege('anon', 'platform.operations', 'SELECT') as anon_select,
                    has_table_privilege('authenticated', 'platform.events', 'SELECT') as auth_select,
                    has_table_privilege('service_role', 'platform.github_source_bindings', 'SELECT,INSERT,UPDATE,DELETE') as github_binding_dml,
                    has_table_privilege('service_role', 'platform.github_install_intents', 'SELECT,INSERT,UPDATE,DELETE') as github_intent_dml,
                    has_table_privilege('anon', 'platform.github_source_bindings', 'SELECT') as anon_github_select,
                    has_table_privilege('authenticated', 'platform.github_install_intents', 'SELECT') as auth_github_select,
                    has_table_privilege('service_role', 'platform.agent_effect_receipts', 'SELECT') as receipt_select,
                    has_table_privilege('service_role', 'platform.agent_effect_receipts', 'INSERT') as receipt_insert,
                    has_table_privilege('service_role', 'platform.agent_effect_receipts', 'UPDATE') as receipt_update,
                    has_table_privilege('service_role', 'platform.agent_effect_receipts', 'DELETE') as receipt_delete,
                    has_table_privilege('service_role', 'platform.mixed_child_custody', 'SELECT,INSERT') as mixed_custody_read_insert,
                    has_table_privilege('service_role', 'platform.mixed_child_custody', 'UPDATE') as mixed_custody_update,
                    has_table_privilege('service_role', 'platform.mixed_child_intents', 'SELECT,INSERT,UPDATE') as mixed_intent_dml,
                    has_table_privilege('service_role', 'platform.mixed_child_intents', 'DELETE') as mixed_intent_delete`
          );
          throw Object.assign(rollback, { rows });
        })
        .catch((e: unknown) => e);
      const rolesAfter = await readRoleBoundary();
      expect(rolesAfter).toEqual(rolesBefore);
      expect(rolesAfter.definitions.filter(role => createdNames.has(role.name))).toEqual([]);
      expect(result).toBe(rollback);
      expect((result as unknown as { rows: Record<string, boolean>[] }).rows[0]).toEqual({
        service_usage: true,
        service_dml: true,
        service_seq: true,
        anon_usage: false,
        auth_usage: false,
        anon_select: false,
        auth_select: false,
        github_binding_dml: true,
        github_intent_dml: true,
        anon_github_select: false,
        auth_github_select: false,
        receipt_select: true,
        receipt_insert: true,
        receipt_update: false,
        receipt_delete: false,
        mixed_custody_read_insert: true,
        mixed_custody_update: false,
        mixed_intent_dml: true,
        mixed_intent_delete: false,
      });
      // Only fixture-created roles disappear; preexisting cluster roles and ACLs are unchanged.
      expect(await db.query("select 1 from information_schema.schemata where schema_name = 'platform'")).toEqual([]);
    });
  }, 60_000);
});

const INCIDENT_HARDENED_TABLES = ["incident_signal_state", "incident_remediation_attempts", "incident_maintenance_windows", "incident_postmortems"] as const;

/** Canonical cluster roles are prerequisites, never invented or repaired by this fixture. */
async function incidentRoleDefinitions(db: PlatformDbHandle) {
  const rows = await db.query<{ name: string; bypass: boolean; superuser: boolean; [key: string]: unknown }>(
    `select oid::text as oid,rolname as name,rolbypassrls as bypass,rolsuper as superuser,
      rolinherit,rolcanlogin,rolcreatedb,rolcreaterole from pg_roles
      where rolname in ('anon','authenticated','service_role') order by rolname`
  );
  expect(rows.map(({ name, bypass, superuser }) => ({ name, bypass, superuser }))).toEqual([
    { name: "anon", bypass: false, superuser: false },
    { name: "authenticated", bypass: false, superuser: false },
    { name: "service_role", bypass: true, superuser: false },
  ]);
  return rows;
}

async function incidentBoundary(db: PlatformDbHandle) {
  const rows = await db.query<{ table_name: string; rls: boolean; policies: number; service_select: boolean; service_insert: boolean; service_update: boolean; service_delete: boolean; service_extra: boolean; anon_any: boolean; authenticated_any: boolean }>(
    `select c.relname as table_name,c.relrowsecurity as rls,
      (select count(*)::integer from pg_policy p where p.polrelid=c.oid) as policies,
      has_table_privilege('service_role',c.oid,'SELECT') as service_select,
      has_table_privilege('service_role',c.oid,'INSERT') as service_insert,
      has_table_privilege('service_role',c.oid,'UPDATE') as service_update,
      has_table_privilege('service_role',c.oid,'DELETE') as service_delete,
      has_table_privilege('service_role',c.oid,'TRUNCATE,REFERENCES,TRIGGER') as service_extra,
      has_table_privilege('anon',c.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') as anon_any,
      has_table_privilege('authenticated',c.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') as authenticated_any
      from pg_class c join pg_namespace n on n.oid=c.relnamespace
      where n.nspname='platform' and c.relname in ('incident_signal_state','incident_remediation_attempts','incident_maintenance_windows','incident_postmortems')
      order by c.relname`
  );
  expect(rows).toEqual([...INCIDENT_HARDENED_TABLES].sort().map(table_name => ({
    table_name, rls: true, policies: 0, service_select: true, service_insert: true, service_update: true, service_delete: true,
    service_extra: false, anon_any: false, authenticated_any: false,
  })));
  return rows;
}

async function assertIncidentClientRefusals(db: PlatformDbHandle) {
  for (const role of ["anon", "authenticated"] as const) {
    for (const table of INCIDENT_HARDENED_TABLES) {
      await expect(db.tx(async tx => {
        await tx.query(role === "anon" ? "set local role anon" : "set local role authenticated");
        expect(await tx.query("select current_user as role")).toEqual([{ role }]);
        await tx.query(`select workspace_id from platform.${table}`);
      })).rejects.toMatchObject({ sqlstate: "42501" });
    }
  }
}

describe.skipIf(!PG_URL)("migrator [postgres] concurrency and fail-closed open", () => {
  it("fresh direct migration and emitted SQL have identical incident RLS and exact grants", async () => {
    const catalogues: Awaited<ReturnType<typeof incidentBoundary>>[] = [];
    for (const source of ["direct", "emitted"] as const) {
      await withScratchDatabase(async url => {
        const db = await openPlatformDb({ kind: "postgres", url, migrate: false, max: 1 });
        try {
          const roles = await incidentRoleDefinitions(db);
          if (source === "direct") expect((await migratePlatformDb(db)).applied).toEqual(ALL);
          else await db.exec(renderSupabaseMigration());
          await assertPlatformSchemaCurrent(db);
          catalogues.push(await incidentBoundary(db));
          await assertIncidentClientRefusals(db);
          await db.tx(async tx => {
            await tx.query("set local role service_role");
            expect(await tx.query("select current_user as role")).toEqual([{ role: "service_role" }]);
            await tx.query(`insert into platform.incident_signal_state(workspace_id,environment_id,fingerprint,last_observed_at)
              values($1,$2,$3,clock_timestamp())`, [uid("ws"), uid("env"), digest(uid("signal"))]);
          });
          expect(await incidentRoleDefinitions(db)).toEqual(roles);
        } finally { await db.close(); }
      });
    }
    expect(catalogues).toHaveLength(2);
    expect(catalogues[0]).toEqual(catalogues[1]);
  }, 120_000);

  it("schema20 upgrade preserves incident rows and old ledger while adding exact hardening and tenant index", async () => {
    await withScratchDatabase(async url => {
      const db = await openPlatformDb({ kind: "postgres", url, migrate: false, max: 1 });
      try {
        const roles = await incidentRoleDefinitions(db);
        const historical = PLATFORM_MIGRATIONS.filter(m => m.version <= 20);
        expect((await migratePlatformDb(db, historical)).applied).toEqual(historical.map(m => m.version));
        const workspaceId = uid("ws"), environmentId = uid("env"), incidentId = uid("incident"), fingerprint = digest(uid("signal"));
        await db.query(`insert into platform.incidents(id,workspace_id,environment_id,title,severity,source,correlation_id)
          values($1,$2,$3,'Retained fixture incident','low','fixture',$4)`, [incidentId, workspaceId, environmentId, uid("correlation")]);
        await db.query(`insert into platform.incident_signal_state(workspace_id,environment_id,fingerprint,consecutive_bad,last_observed_at)
          values($1,$2,$3,2,'2026-10-05T00:00:00Z')`, [workspaceId, environmentId, fingerprint]);
        await db.query(`insert into platform.incident_remediation_attempts(id,workspace_id,incident_id,environment_id,fingerprint,idempotency_key,capability,blast_radius,status)
          values($1,$2,$3,$4,$5,$6,'drift.repair','low','blocked')`, [uid("attempt"), workspaceId, incidentId, environmentId, fingerprint, digest(uid("intent"))]);
        await db.query(`insert into platform.incident_maintenance_windows(id,workspace_id,environment_id,starts_at,ends_at,reason,created_by)
          values($1,$2,$3,'2026-10-05T00:00:00Z','2026-10-05T01:00:00Z','Retained fixture window','user:fixture')`, [uid("window"), workspaceId, environmentId]);
        const document = { retained: "fixture postmortem" };
        await db.query(`insert into platform.incident_postmortems(id,workspace_id,incident_id,document,document_digest)
          values($1,$2,$3,$4::text::jsonb,$5)`, [uid("postmortem"), workspaceId, incidentId, JSON.stringify(document), digest(document)]);
        const retainedRows = async () => Promise.all(INCIDENT_HARDENED_TABLES.map(table => db.query(`select to_jsonb(t) as row from platform.${table} t where workspace_id=$1`, [workspaceId])));
        const before = await retainedRows();
        expect(before.every(rows => rows.length === 1)).toBe(true);
        const ledger = await db.query("select version,name,checksum,applied_at::text from platform.schema_migrations order by version");
        // First retain the complete published wave-2 ledger, then append the fix.
        const published = PLATFORM_MIGRATIONS.filter(m => m.version <= 27);
        expect((await migratePlatformDb(db, published)).applied).toEqual(published.filter(m => m.version > 20).map(m => m.version));
        expect(await retainedRows()).toEqual(before);
        expect(await db.query("select version,name,checksum,applied_at::text from platform.schema_migrations where version<=20 order by version")).toEqual(ledger);
        const publishedLedger = await db.query("select version,name,checksum,applied_at::text from platform.schema_migrations order by version");
        expect(publishedLedger).toHaveLength(27);
        await expectHistoricalContractRefusal(db, [28], PLATFORM_MIGRATIONS.filter(m => m.version <= 28));
        await historicalFixtureRange(db, 28, 28);
        const direct = await incidentBoundary(db);
        expect(await retainedRows()).toEqual(before);
        expect(await db.query("select version,name,checksum,applied_at::text from platform.schema_migrations where version<=20 order by version")).toEqual(ledger);
        expect(await db.query("select version,name,checksum,applied_at::text from platform.schema_migrations where version<=27 order by version")).toEqual(publishedLedger);
        expect(await db.query<{ definition: string }>("select indexdef as definition from pg_indexes where schemaname='platform' and indexname='machine_runbook_schedules_scope'")).toEqual([
          { definition: "CREATE INDEX machine_runbook_schedules_scope ON platform.machine_runbook_schedules USING btree (workspace_id, created_at DESC)" },
        ]);
        await db.exec(renderSupabaseMigration());
        expect(await incidentBoundary(db)).toEqual(direct);
        expect(await retainedRows()).toEqual(before);
        expect(await db.query("select version,name,checksum,applied_at::text from platform.schema_migrations where version<=20 order by version")).toEqual(ledger);
        expect(await db.query("select version,name,checksum,applied_at::text from platform.schema_migrations where version<=27 order by version")).toEqual(publishedLedger);
        expect(await migratePlatformDb(db)).toEqual({ applied: [], alreadyApplied: ALL });
        await assertIncidentClientRefusals(db);
        expect(await incidentRoleDefinitions(db)).toEqual(roles);
      } finally { await db.close(); }
    });
  }, 120_000);
  it.each(["fresh", "same-owner schema6"] as const)("%s canonical migrations keep permanent agent receipts select/insert-only", async mode => {
    await withScratchDatabase(async url => withOwnedHistoricalRepairAdmission(mode === "same-owner schema6", async () => {
      const db = await openPlatformDb({ kind: "postgres", url, migrate: false, max: 1 });
      const rollback = new Error("Deliberate private receipt privilege fixture rollback.");
      try {
        const result = await db.tx(async tx => {
          await db.exec(`do $$ begin
            if not exists (select 1 from pg_roles where rolname='service_role') then create role service_role nologin noinherit bypassrls; end if;
          end $$;`);
          const owner = (await tx.query<{ name: string }>("select current_user as name"))[0].name;
          if (mode === "same-owner schema6") {
            const emitted = renderSupabaseMigration();
            const seventh = emitted.indexOf("-- ============================ migration 7: plan_artifacts");
            const hardening = emitted.indexOf("-- ============================ hardening (Supabase roles)");
            if (seventh < 0 || hardening < seventh) throw new Error("Canonical legacy fixture boundaries are unavailable.");
            await db.exec(emitted.slice(0, seventh) + emitted.slice(hardening));
            await tx.query("create table platform.agent_receipt_acl_probe(id integer)");
            for (const privilege of ["UPDATE", "DELETE"])
              expect((await tx.query<{ inherited: boolean }>("select has_table_privilege('service_role','platform.agent_receipt_acl_probe',$1) as inherited", [privilege]))[0].inherited).toBe(true);
            await tx.query("drop table platform.agent_receipt_acl_probe");
          }
          if (mode === "same-owner schema6") {
            await expectHistoricalContractRefusal(db, [11, 15, 28, 30, 49, 51, 57, 58, 61]);
            await historicalFixtureRange(db, 7, 30);
          }
          await migrateDrainedWave5(db);
          await assertPlatformSchemaCurrent(db);
          expect((await tx.query<{ owner: string }>("select pg_get_userbyid(relowner) as owner from pg_class where oid='platform.agent_effect_receipts'::regclass"))[0].owner).toBe(owner);
          for (const privilege of ["SELECT", "INSERT", "UPDATE", "DELETE", "TRUNCATE", "REFERENCES", "TRIGGER"])
            expect((await tx.query<{ allowed: boolean }>("select has_table_privilege('service_role','platform.agent_effect_receipts',$1) as allowed", [privilege]))[0].allowed,
              `${mode}: ${privilege}`).toBe(["SELECT", "INSERT"].includes(privilege));
          for (const statement of ["update platform.agent_effect_receipts set logical_digest=logical_digest", "delete from platform.agent_effect_receipts"])
            await expect(db.tx(async denied => { await denied.query("set local role service_role"); await denied.query(statement); })).rejects.toMatchObject({ sqlstate: "42501" });
          throw rollback;
        }).catch((error: unknown) => error);
        if (result !== rollback) throw result;
        expect(result).toBe(rollback);
      } finally { await db.close(); }
    }));
  }, 60_000);

  it.each(["fresh", "same-owner schema6"] as const)("%s canonical migrations keep permanent approved source snapshots select/insert-only", async mode => {
    await withScratchDatabase(async url => withOwnedHistoricalRepairAdmission(mode === "same-owner schema6", async () => {
      const db = await openPlatformDb({ kind: "postgres", url, migrate: false, max: 1 });
      const rollback = new Error("Deliberate private source privilege fixture rollback.");
      try {
        const result = await db.tx(async tx => {
          await db.exec(`do $$ begin
            if not exists (select 1 from pg_roles where rolname='service_role') then create role service_role nologin noinherit bypassrls; end if;
          end $$;`);
          const owner = (await tx.query<{ name: string }>("select current_user as name"))[0].name;
          if (mode === "same-owner schema6") {
            const emitted = renderSupabaseMigration();
            const seventh = emitted.indexOf("-- ============================ migration 7: plan_artifacts");
            const hardening = emitted.indexOf("-- ============================ hardening (Supabase roles)");
            if (seventh < 0 || hardening < seventh) throw new Error("Canonical legacy fixture boundaries are unavailable.");
            await db.exec(emitted.slice(0, seventh) + emitted.slice(hardening));
            // Challenge the full inherited-ACL counterexample in the creator's
            // own namespace. All role/default-privilege DDL rolls back below.
            await tx.query("alter default privileges in schema platform grant all on tables to service_role");
            await tx.query("create table platform.approved_source_acl_probe(id integer)");
            for (const privilege of ["SELECT", "INSERT", "UPDATE", "DELETE", "TRUNCATE", "REFERENCES", "TRIGGER"])
              expect((await tx.query<{ inherited: boolean }>("select has_table_privilege('service_role','platform.approved_source_acl_probe',$1) as inherited", [privilege]))[0].inherited).toBe(true);
            await tx.query("drop table platform.approved_source_acl_probe");
            await expectHistoricalContractRefusal(db, [11, 15, 28, 30, 49, 51, 57, 58, 61]);
            await historicalFixtureRange(db, 7, 12);
            expect((await migratePlatformDb(db, PLATFORM_MIGRATIONS.filter(m => m.version <= 13))).applied).toEqual([13]);
            await historicalFixtureRange(db, 14, 30);
            await migrateDrainedWave5(db);
          } else {
            // Fresh canonical Supabase SQL includes the final aggregate ACL
            // reassertion, not only migration13's narrower direct grant.
            await db.exec(renderSupabaseMigration());
          }
          await assertPlatformSchemaCurrent(db);
          expect((await tx.query<{ owner: string }>("select pg_get_userbyid(relowner) as owner from pg_class where oid='platform.approved_source_snapshots'::regclass"))[0].owner).toBe(owner);
          const assertRights = async () => {
            for (const privilege of ["SELECT", "INSERT", "UPDATE", "DELETE", "TRUNCATE", "REFERENCES", "TRIGGER"])
              expect((await tx.query<{ allowed: boolean }>("select has_table_privilege('service_role','platform.approved_source_snapshots',$1) as allowed", [privilege]))[0].allowed,
                `${mode}: ${privilege}`).toBe(["SELECT", "INSERT"].includes(privilege));
          };
          await assertRights();
          // Re-emission must not regrant UPDATE/DELETE or inherited rights.
          await db.exec(renderSupabaseMigration());
          await assertRights();
          expect((await tx.query<{bypass:boolean}>("select rolbypassrls as bypass from pg_roles where rolname='service_role'"))[0].bypass).toBe(true);
          const workspaceId = uid("source_acl_ws"), projectId = uid("project"), environmentId = uid("env");
          const { operation } = await repos.operations.create(tx, { workspaceId, principal: user(), proposal: proposalFor(workspaceId, { scope: { workspaceId, projectId, environmentId } }) });
          // Fixed modeled metadata tests native SQL/role admission only. It does
          // not mint the source capture capability or prove archive provenance.
          const snapshot = immutableSourceSnapshot({ format: "zenith.approved-source.v1", workspaceId, operationId: operation.id, projectId, environmentId,
            serviceAddress: "container_service/web", serviceSpecDigest: digest("service"), pipelineAddress: "build_pipeline/web", pipelineSpecDigest: digest("pipeline"),
            provider: "aws", region: "eu-west-1", owner: "acme", repo: "web", repositoryId: 99, requestedRef: "revision", commitSha: "a".repeat(40), githubBinding: null,
            dockerfile: "Dockerfile", dockerfileDigest: digest("modeled Dockerfile"), recipeDigest: digest("modeled recipe"), archiveFormat: "zip", archiveDigest: digest("modeled archive"), archiveBytes: 100 });
          await db.tx(async service => {
            await service.query("set local role service_role");
            await service.query(`insert into platform.approved_source_snapshots(workspace_id,operation_id,project_id,environment_id,service_address,snapshot,snapshot_digest)
              values ($1,$2,$3,$4,$5,$6::text::jsonb,$7)`, [workspaceId,operation.id,projectId,environmentId,snapshot.serviceAddress,JSON.stringify(snapshot),sourceSnapshotDigest(snapshot)]);
            expect(await service.query("select snapshot from platform.approved_source_snapshots where workspace_id=$1 and operation_id=$2", [workspaceId,operation.id])).toEqual([{snapshot}]);
          });
          await tx.query("reset role");
          const retained = await tx.query("select * from platform.approved_source_snapshots where workspace_id=$1 and operation_id=$2", [workspaceId,operation.id]);
          for (const statement of ["update platform.approved_source_snapshots set snapshot_digest=snapshot_digest", "delete from platform.approved_source_snapshots", "truncate platform.approved_source_snapshots"]) {
            await expect(db.tx(async denied => { await denied.query("set local role service_role"); await denied.query(statement); })).rejects.toMatchObject({ sqlstate: "42501" });
            expect(await tx.query("select * from platform.approved_source_snapshots where workspace_id=$1 and operation_id=$2", [workspaceId,operation.id])).toEqual(retained);
          }
          expect(await migratePlatformDb(db)).toEqual({ applied: [], alreadyApplied: ALL });
          throw rollback;
        }).catch((error: unknown) => error);
        if (result !== rollback) throw result;
        expect(result).toBe(rollback);
      } finally { await db.close(); }
    }));
  }, 60_000);

  it("schema12 refuses startup and even source-free plan review until the canonical source migration is applied", async () => {
    await withScratchDatabase(async url => withOwnedHistoricalRepairAdmission(true, async () => {
      const db = await openPlatformDb({ kind: "postgres", url, migrate: false, max: 1 });
      try {
        await migratePlatformDb(db, PLATFORM_MIGRATIONS.filter(m => m.version < 13));
        await expect(assertPlatformSchemaCurrent(db)).rejects.toMatchObject({ code: "schema_behind" });
        expect((await platformSchemaStatus(db)).pending.map(m => m.version)).toEqual(PLATFORM_MIGRATIONS.filter(m => m.version >= 13).map(m => m.version));
        const workspaceId = uid("source_schema_ws");
        const plan = normalizePlan({format_version:"1.2",terraform_version:TOFU_VERSION,resource_changes:[],output_changes:{}},
          {configDigest:digest("config"),lockDigest:digest("lock"),addressMap:{}});
        const summary = planEvidence({plan,facts:extractPlanFacts(plan),cost:{},graphDigest:digest("graph"),stage:"plan"}).summary;
        const { operation } = await repos.operations.create(db, { workspaceId, principal: user(), proposal: proposalFor(workspaceId, { planDigest: plan.planDigest }) });
        await repos.evidence.insert(db,{workspaceId,operationId:operation.id,kind:"tofu_plan",digest:plan.planDigest,summary,simulated:false});
        await expect(withPlanReview(db, { ...operation, approvalRound: 0 })).rejects.toThrow("Approved source review is unavailable");
        expect((await migratePlatformDb(db, PLATFORM_MIGRATIONS.filter(m => m.version <= 13))).applied).toEqual([13]);
        expect((await withPlanReview(db, { ...operation, approvalRound: 0 })).planReview?.view).toEqual(summary.view);
        await expectHistoricalContractRefusal(db, [15, 28, 30], PLATFORM_MIGRATIONS.filter(m => m.version <= 30));
        await historicalFixtureRange(db, 14, 30);
        await migrateDrainedWave5(db);
        await assertPlatformSchemaCurrent(db);
        expect((await withPlanReview(db, { ...operation, approvalRound: 0 })).planReview?.view).toEqual(summary.view);
      } finally { await db.close(); }
    }));
  }, 60_000);

  it("schema 6 emitted hardening upgrades through the canonical migrator under a distinct owner with RLS, role isolation and immutable artifacts",async()=>{
    await withScratchDatabase(async url => withOwnedHistoricalRepairAdmission(true, async () => {
      const db=await openPlatformDb({kind:"postgres",url,migrate:false,max:1});
      const rollback=new Error("Deliberate private upgrade fixture rollback");
      try {
        const result=await db.tx(async tx=>{
          // Test roles are transaction-local DDL and roll back; existing roles are never altered.
          await db.exec(`do $$ begin
            if not exists (select 1 from pg_roles where rolname='anon') then create role anon nologin; end if;
            if not exists (select 1 from pg_roles where rolname='authenticated') then create role authenticated nologin; end if;
            if not exists (select 1 from pg_roles where rolname='service_role') then create role service_role nologin bypassrls; end if;
          end $$;`);
          const emitted=renderSupabaseMigration();
          const seventh=emitted.indexOf("-- ============================ migration 7: plan_artifacts");
          const hardening=emitted.indexOf("-- ============================ hardening (Supabase roles)");
          if(seventh<0 || hardening<seventh)throw new Error("Canonical emitted migration boundaries are unavailable.");
          // Exact shipped 1–6 text/checksums plus existing emitted hardening.
          await db.exec(emitted.slice(0,seventh)+emitted.slice(hardening));
          // This distinct-owner fixture verifies the published schema6→43 authority contract.
          const historical = PLATFORM_MIGRATIONS.filter(m => m.version <= 43);
          const historicalVersions = historical.map(m => m.version);
          const next = PLATFORM_MIGRATIONS.find(m => m.version === 44)!;
          const historicalEnd = emitted.indexOf(`-- ============================ migration ${next.version}: ${next.name} `);
          if (historicalEnd <= seventh || hardening <= historicalEnd) throw new Error("Canonical schema43 fixture boundary is unavailable.");
          const historicalEmitted = emitted.slice(0, historicalEnd) + emitted.slice(hardening);
          const pending = historical.filter(m => m.version > 6).map(m => m.version);
          expect((await platformSchemaStatus(db, historical)).pending.map(m=>m.version)).toEqual(pending);
          await expect(assertPlatformSchemaCurrent(db, historical)).rejects.toMatchObject({code:"schema_behind"});
          const originalUser=(await tx.query<{name:string}>("select current_user as name"))[0].name;
          const migrationOwner=uid("zt_plan_migration").replace(/-/g,"");
          const legacySourceOwner=uid("zt_source_owner").replace(/-/g,"");
          const legacyIncidentOwner=uid("zt_incident_owner").replace(/-/g,"");
          const legacyAgentOwner=uid("zt_agent_owner").replace(/-/g,"");
          const legacyQueueOwner=uid("zt_queue_owner").replace(/-/g,"");
          // A distinct authorized migration owner has schema-create, ledger DML/RLS bypass, FK references,
          // and exact TRIGGER permissions on legacy tables used by migrations 15 and 30.
          const databaseName=(await tx.query<{name:string}>("select current_database() as name"))[0].name;
          await db.exec(`create role ${migrationOwner} nologin bypassrls;
            create role ${legacySourceOwner} nologin;
            create role ${legacyIncidentOwner} nologin;
            create role ${legacyAgentOwner} nologin;
            create role ${legacyQueueOwner} nologin;
            grant usage on schema platform to ${legacySourceOwner};
            grant usage on schema platform to ${legacyIncidentOwner};
            grant usage on schema platform to ${legacyAgentOwner};
            grant usage on schema platform to ${legacyQueueOwner};
            alter table platform.github_source_bindings owner to ${legacySourceOwner};
            alter table platform.github_install_intents owner to ${legacySourceOwner};
            alter table platform.incidents owner to ${legacyIncidentOwner};
            alter table platform.runners owner to ${legacyAgentOwner};
            alter table platform.machines owner to ${legacyAgentOwner};
            alter table platform.runner_jobs owner to ${legacyQueueOwner};
            grant ${legacySourceOwner} to ${migrationOwner};
            grant create on database "${databaseName.replace(/"/g,'""')}" to ${migrationOwner};
            grant usage,create on schema platform to ${migrationOwner} with grant option;
            grant select,insert,update,delete on all tables in schema platform to ${migrationOwner};
            grant references on table platform.operations,platform.approvals,platform.provider_connections,platform.github_source_bindings,platform.runner_jobs,platform.machine_requests to ${migrationOwner};
            grant trigger on table platform.runner_jobs,platform.machine_requests,platform.capability_grants to ${migrationOwner};`);
          await tx.query(`set local role ${migrationOwner}`);
          expect((await tx.query<{name:string}>("select current_user as name"))[0].name).toBe(migrationOwner);
          expect(migrationOwner).not.toBe(originalUser);
          expect(await tx.query("select c.relname from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='platform' and c.relkind='r' and pg_get_userbyid(c.relowner)=$1 order by c.relname", [legacyQueueOwner])).toEqual([{relname:"runner_jobs"}]);
          expect((await tx.query<{allowed:boolean}>("select pg_has_role(current_user,$1,'USAGE') as allowed",[legacyQueueOwner]))[0].allowed).toBe(false);
          expect((await tx.query<{allowed:boolean}>("select has_table_privilege(current_user,'platform.capability_grants','TRIGGER') as allowed"))[0].allowed).toBe(true);
          expect((await tx.query<{allowed:boolean}>("select has_table_privilege(current_user,'platform.approvals','REFERENCES') as allowed"))[0].allowed).toBe(true);
          // Published migrations 19, 25 and 38 change or index legacy tables.
          // DML and REFERENCES do not authorize owner DDL: admit exact owners.
          await expect(db.tx(async denied => {
            await denied.query("alter table platform.incidents add column fixture_unauthorized_owner text");
          })).rejects.toMatchObject({sqlstate:"42501"});
          for (const table of ["runners", "machines", "runner_jobs"] as const) {
            await expect(db.tx(async denied => {
              await denied.query(`alter table platform.${table} add column fixture_unauthorized_owner text`);
            })).rejects.toMatchObject({sqlstate:"42501"});
          }
          expect((await tx.query<{allowed:boolean}>("select has_table_privilege(current_user,'platform.provider_connections','REFERENCES') as allowed"))[0].allowed).toBe(true);
          await tx.query("reset role");
          await tx.query(`grant ${legacyIncidentOwner},${legacyAgentOwner} to ${migrationOwner}`);
          await tx.query(`set local role ${migrationOwner}`);
          expect((await tx.query<{allowed:boolean}>("select pg_has_role(current_user,$1,'USAGE') as allowed",[legacyIncidentOwner]))[0].allowed).toBe(true);
          expect((await tx.query<{allowed:boolean}>("select pg_has_role(current_user,$1,'USAGE') as allowed",[legacyAgentOwner]))[0].allowed).toBe(true);
          // Admission refuses historical contracts before constructing schema7..30;
          // the canonical migrator then exercises only the published schema31..43.
          await expectHistoricalContractRefusal(db, [11, 15, 28, 30], historical);
          await historicalFixtureRange(db, 7, 29);
          expect((await tx.query<{allowed:boolean}>("select has_table_privilege(current_user,'platform.operations','TRIGGER') as allowed"))[0].allowed).toBe(false);
          const before30 = await tx.query("select * from platform.schema_migrations order by version");
          // Canonical historical30 requires one additional exact legacy-table
          // privilege. Its failed DDL stays inside this owned savepoint; this
          // is historical SQL construction, not current contract admission.
          await expect(db.tx(() => historicalFixtureRange(db, 30, 30))).rejects.toMatchObject({sqlstate:"42501"});
          expect(await tx.query("select * from platform.schema_migrations order by version")).toEqual(before30);
          expect((await tx.query<{name:string|null}>("select to_regclass('platform.operation_authority')::text as name"))[0].name).toBeNull();
          await tx.query("reset role");
          expect((await tx.query<{name:string}>("select current_user as name"))[0].name).toBe(originalUser);
          await tx.query(`grant trigger on table platform.operations to ${migrationOwner}`);
          await tx.query(`set local role ${migrationOwner}`);
          expect((await tx.query<{allowed:boolean}>("select has_table_privilege(current_user,'platform.operations','TRIGGER') as allowed"))[0].allowed).toBe(true);
          expect((await tx.query<{owner:string}>("select pg_get_userbyid(relowner) as owner from pg_class where oid='platform.operations'::regclass"))[0].owner).toBe(originalUser);
          await expect(db.tx(async denied => {
            await denied.query("alter table platform.operations add column fixture_unauthorized_owner text");
          })).rejects.toMatchObject({sqlstate:"42501"});
          await historicalFixtureRange(db, 30, 30);
          // Actual migration38 indexes the legacy queue table. Its owner must
          // be explicitly authorized; DML and TRIGGER alone do not allow INDEX.
          const beforeCurrent = await tx.query("select * from platform.schema_migrations order by version");
          await expect(db.tx(() => migratePlatformDb(db, historical))).rejects.toMatchObject({sqlstate:"42501",message:"must be owner of table runner_jobs"});
          expect(await tx.query("select * from platform.schema_migrations order by version")).toEqual(beforeCurrent);
          expect(await tx.query("select to_regclass('platform.approved_semantics')::text as semantics, to_regclass('platform.runner_jobs_ws_queued')::text as queue_index"))
            .toEqual([{semantics:null,queue_index:null}]);
          await tx.query("reset role");
          expect((await tx.query<{name:string}>("select current_user as name"))[0].name).toBe(originalUser);
          await tx.query(`grant ${legacyQueueOwner} to ${migrationOwner}`);
          await tx.query(`set local role ${migrationOwner}`);
          expect((await tx.query<{allowed:boolean}>("select pg_has_role(current_user,$1,'USAGE') as allowed",[legacyQueueOwner]))[0].allowed).toBe(true);
          expect(await migratePlatformDb(db, historical)).toEqual({applied:pending.filter(version => version > 30),alreadyApplied:historicalVersions.filter(version => version <= 30)});
          expect((await tx.query<{owner:string}>("select pg_get_userbyid(relowner) as owner from pg_class where oid='platform.runner_jobs'::regclass"))[0].owner).toBe(legacyQueueOwner);
          expect((await tx.query<{owner:string}>("select pg_get_userbyid(relowner) as owner from pg_class where oid='platform.operations'::regclass"))[0].owner).toBe(originalUser);
          await expect(db.tx(async denied => {
            await denied.query("alter table platform.operations add column fixture_unauthorized_owner text");
          })).rejects.toMatchObject({sqlstate:"42501"});
          await assertPlatformSchemaCurrent(db, historical);
          expect((await platformSchemaStatus(db, historical)).applied.map(({version,name,checksum})=>({version,name,checksum})))
            .toEqual(historical.map(m=>({version:m.version,name:m.name,checksum:migrationChecksum(m)})));
          expect(await migratePlatformDb(db, historical)).toEqual({applied:[],alreadyApplied:historicalVersions});
          await tx.query("reset role");
          expect((await tx.query<{owner:string}>("select pg_get_userbyid(relowner) as owner from pg_class where oid='platform.incidents'::regclass"))[0].owner).toBe(legacyIncidentOwner);
          expect(await tx.query<{name:string;owner:string}>("select relname as name,pg_get_userbyid(relowner) as owner from pg_class where oid in ('platform.runners'::regclass,'platform.machines'::regclass) order by relname"))
            .toEqual([{name:"machines",owner:legacyAgentOwner},{name:"runners",owner:legacyAgentOwner}]);
          const tables=await tx.query<{name:string;rls:boolean;owner:string}>(`select c.relname as name,c.relrowsecurity as rls,pg_get_userbyid(c.relowner) as owner
            from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='platform'
            and c.relname in ('plan_artifacts','plan_artifact_associations','plan_artifact_uses','build_launches','github_binding_events','github_webhook_deliveries','github_webhook_installation_epochs','agent_effect_receipts','workflow_start_intents','approved_source_snapshots','mixed_child_custody','mixed_child_intents') order by c.relname`);
          const grants: Record<string, readonly string[]> = {
            plan_artifacts: ["SELECT", "INSERT", "UPDATE", "DELETE"],
            plan_artifact_associations: ["SELECT", "INSERT", "UPDATE", "DELETE"],
            plan_artifact_uses: ["SELECT", "INSERT", "UPDATE", "DELETE"],
            build_launches: ["SELECT", "INSERT", "UPDATE"],
            agent_effect_receipts: ["SELECT", "INSERT"],
            github_binding_events: ["SELECT", "INSERT"],
            github_webhook_deliveries: ["SELECT", "INSERT", "UPDATE"],
            github_webhook_installation_epochs: ["SELECT", "INSERT", "UPDATE"],
            workflow_start_intents: ["SELECT", "INSERT", "UPDATE"],
            approved_source_snapshots: ["SELECT", "INSERT"],
            mixed_child_custody: ["SELECT", "INSERT"],
            mixed_child_intents: ["SELECT", "INSERT", "UPDATE"],
          };
          expect(tables.map(table=>table.name)).toEqual(Object.keys(grants).sort());
          for(const table of tables) {
            expect(table.rls).toBe(true);expect(table.owner).toBe(migrationOwner);
            for(const role of ["anon","authenticated"]) {
              for(const privilege of ["SELECT","INSERT","UPDATE","DELETE","TRUNCATE","REFERENCES","TRIGGER"])
                expect((await tx.query<{allowed:boolean}>("select has_table_privilege($1,$2,$3) as allowed",[role,`platform.${table.name}`,privilege]))[0].allowed).toBe(false);
              await expect(db.tx(async denied=>{await denied.query(`set local role ${role}`);await denied.query(`select count(*) from platform.${table.name}`);})).rejects.toMatchObject({sqlstate:"42501"});
            }
            // Canonical migration-specific grants do not replay aggregate emitted hardening.
            // A distinct creator role also has its own default-privilege namespace.
            for(const privilege of ["SELECT","INSERT","UPDATE","DELETE","TRUNCATE","REFERENCES","TRIGGER"])
              expect((await tx.query<{allowed:boolean}>("select has_table_privilege('service_role',$1,$2) as allowed",[`platform.${table.name}`,privilege]))[0].allowed).toBe(grants[table.name].includes(privilege));
          }
          for(const role of ["anon","authenticated"])
            expect((await tx.query<{allowed:boolean}>("select has_schema_privilege($1,'platform','USAGE') as allowed",[role]))[0].allowed).toBe(false);
          expect((await tx.query<{allowed:boolean}>("select has_schema_privilege('service_role','platform','USAGE') as allowed"))[0].allowed).toBe(true);
          expect(await tx.query("select policyname from pg_policies where schemaname='platform' and tablename in ('plan_artifacts','plan_artifact_associations','plan_artifact_uses')")).toEqual([]);
          const ws=uid("ws_upgrade"),planDigest="d".repeat(64);
          const source=await repos.operations.create(tx,{workspaceId:ws,principal:user(),proposal:proposalFor(ws,{capability:"infrastructure.plan",planDigest})});
          const destination=await repos.operations.create(tx,{workspaceId:ws,principal:user(),proposal:proposalFor(ws,{capability:"infrastructure.destroy",planDigest})});
          // Synthetic ciphertext exercises upgrade triggers/ACLs only; this is not producer or dispatch evidence.
          await tx.query(`insert into platform.plan_artifacts(workspace_id,operation_id,manifest,manifest_digest,plan_digest,iv,auth_tag,ciphertext,expires_at)
            values($1,$2,$3::text::jsonb,$4,$4,$5,$6,'synthetic-ciphertext',clock_timestamp()+interval '1 hour')`,
            [ws,source.operation.id,JSON.stringify({workspaceId:ws,operationId:source.operation.id,planDigest}),planDigest,"A".repeat(16),"A".repeat(24)]);
          expect(await tx.query("select manifest from platform.plan_artifacts where workspace_id=$1 and operation_id=$2", [ws,source.operation.id]))
            .toEqual([{manifest:{workspaceId:ws,operationId:source.operation.id,planDigest}}]);
          await tx.query(`insert into platform.plan_artifact_associations(workspace_id,operation_id,source_operation_id,source_evidence_id,source_manifest_digest,source_raw_sha256,proposal_digest,input_digest,expires_at)
            values($1,$2,$3,'synthetic-evidence',$4,$4,$5,$6,clock_timestamp()+interval '1 hour')`,[ws,destination.operation.id,source.operation.id,planDigest,destination.operation.proposalDigest,destination.operation.inputDigest]);
          for(const table of ["plan_artifacts","plan_artifact_associations"]) {
            await expect(db.tx(inner=>inner.query(`update platform.${table} set expires_at=clock_timestamp() where workspace_id=$1`,[ws]))).rejects.toMatchObject({sqlstate:"23514"});
            await expect(db.tx(inner=>inner.query(`delete from platform.${table} where workspace_id=$1`,[ws]))).rejects.toMatchObject({sqlstate:"23514"});
          }
          // No inferred custom runtime grants: the existing service-role RLS bypass is an explicit prerequisite.
          expect((await tx.query<{bypass:boolean}>("select rolbypassrls as bypass from pg_roles where rolname='service_role'"))[0].bypass).toBe(true);
          await db.tx(async service=>{await service.query("set local role service_role");expect(await service.query("select operation_id from platform.plan_artifacts where workspace_id=$1",[ws])).toEqual([{operation_id:source.operation.id}]);});
          await tx.query("reset role");
          await db.exec(historicalEmitted);await assertPlatformSchemaCurrent(db, historical);
          expect(await migratePlatformDb(db, historical)).toEqual({applied:[],alreadyApplied:historicalVersions});
          throw rollback;
        }).catch((error:unknown)=>error);
        if (result !== rollback) throw result;
        expect(result).toBe(rollback);
      } finally {await db.close();}
    }));
  },60000);

  it("two migrators racing on an empty database converge: one applies, the other finds it done", async () => {
    await withScratchDatabase(async (url) => {
      const a = await openPlatformDb({ kind: "postgres", url, migrate: false, max: 2 });
      const b = await openPlatformDb({ kind: "postgres", url, migrate: false, max: 2 });
      try {
        const results = await Promise.all([migratePlatformDb(a), migratePlatformDb(b), migratePlatformDb(a), migratePlatformDb(b)]);
        expect(results.flatMap((r) => r.applied).sort((a, b) => a - b)).toEqual(ALL);
        expect(await platformSchemaStatus(a)).toMatchObject({ current: true });
        const ledger = await a.query<{ n: number }>("select count(*)::int as n from platform.schema_migrations");
        expect(ledger[0].n).toBe(ALL.length);
      } finally {
        await a.close();
        await b.close();
      }
    });
  }, 60_000);

  it("openPlatformDb({ kind: 'postgres' }) does not migrate unless asked, and a bare open sees the schema as behind", async () => {
    await withScratchDatabase(async (url) => {
      const db = await openPlatformDb({ kind: "postgres", url, max: 1 });
      try {
        expect((await platformSchemaStatus(db)).ledgerPresent).toBe(false);
        await expect(assertPlatformSchemaCurrent(db)).rejects.toMatchObject({ code: "schema_behind" });
      } finally {
        await db.close();
      }
    });
  }, 60_000);

  it("schema 60 gives service_role insert-only settlement groundwork and row security, and clients nothing", async () => {
    await withScratchDatabase(async (url) => {
      const db = await openPlatformDb({ kind: "postgres", url, max: 1 });
      try {
        await migratePlatformDb(db);
        const roles = await db.query<{ n: number }>("select count(*)::int as n from pg_roles where rolname in ('anon','authenticated','service_role')");
        if (roles[0]?.n !== 3) throw new Error("Canonical fixed roles are required before schema 60 role rights can be checked.");
        const rights = await db.query<{ tbl: string; insert: boolean; clear: boolean; client: boolean; rls: boolean }>(`select t.tbl as tbl,
            has_table_privilege('service_role','platform.'||t.tbl,'INSERT') as insert,
            has_table_privilege('service_role','platform.'||t.tbl,'UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') as clear,
            (has_table_privilege('anon','platform.'||t.tbl,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
              or has_table_privilege('authenticated','platform.'||t.tbl,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')) as client,
            (select relrowsecurity from pg_class where oid=('platform.'||t.tbl)::regclass) as rls
          from (values ('cleanup_writer_hold_releases'),('cleanup_writer_settlements'),('cleanup_direct_attempts')) as t(tbl) order by t.tbl`);
        expect(rights).toEqual([
          { tbl: "cleanup_direct_attempts", insert: true, clear: false, client: false, rls: true },
          { tbl: "cleanup_writer_hold_releases", insert: true, clear: false, client: false, rls: true },
          { tbl: "cleanup_writer_settlements", insert: true, clear: false, client: false, rls: true },
        ]);
      } finally {
        await db.close();
      }
    });
  }, 60_000);

  it("BOOTSTRAP_SQL is idempotent", async () => {
    await withScratchDatabase(async (url) => {
      const db = await openPlatformDb({ kind: "postgres", url, max: 1 });
      try {
        await db.exec(BOOTSTRAP_SQL);
        await db.exec(BOOTSTRAP_SQL);
        expect((await platformSchemaStatus(db)).ledgerPresent).toBe(true);
      } finally {
        await db.close();
      }
    });
  }, 60_000);
});

// PGlite always runs, so this needs no PostgreSQL gate. The native role-rights check for these tables
// lives in tests/controlplane/cleanup-writer-barriers.test.ts (its existing RLS and client-denial case).
describe("cleanup writer expand schema 60 [pglite]", () => {
  const lane = lanes[0];
  const SCOPE ={ workspaceId: "ws_expand60", projectId: "project_a", environmentId: "env_a" };
  const generation = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
  const seedOperation = (db: PlatformDbHandle, id: string) =>
    db.query(`insert into platform.operations(id,workspace_id,capability,principal,status,proposal,proposal_digest,input_digest,correlation_id,expires_at)
      values($1,$2,'infrastructure.destroy','{}'::jsonb,'succeeded','{}'::jsonb,$3,$3,'corr',clock_timestamp()+interval '1 day')`, [id, SCOPE.workspaceId, digest(id)]);
  // Schema 59 rows have no hold_seq, so inserts name only the columns that exist before migration 60.
  const insertHold = (db: PlatformDbHandle, environmentId: string, operationId: string, attempt: string, gen: number) =>
    db.query(`insert into platform.cleanup_writer_holds(workspace_id,project_id,environment_id,operation_id,attempt_id,generation,manifest_digest,authority_digest,holder,fence_token)
      values($1,$2,$3,$4,$5,$6,$7,$8,'holder_a',1)`, [SCOPE.workspaceId, SCOPE.projectId, environmentId, operationId, attempt, generation(gen), digest(`m:${attempt}`), digest(`a:${attempt}`)]);
  const holdSeq = async (db: PlatformDbHandle, environmentId: string) => (await db.query<{ hold_seq: string }>("select hold_seq::text as hold_seq from platform.cleanup_writer_holds where environment_id=$1", [environmentId]))[0];
  const primaryKey = async (db: PlatformDbHandle, table: string) => (await db.query<{ column_name: string }>(`select k.column_name from information_schema.table_constraints c
      join information_schema.key_column_usage k on k.constraint_schema=c.constraint_schema and k.constraint_name=c.constraint_name
      where c.table_schema='platform' and c.table_name=$1 and c.constraint_type='PRIMARY KEY' order by k.ordinal_position`, [table])).map((r) => r.column_name);

  it("gives existing holds a generation order without changing their key, columns or history", async () => {
    await lane.withFresh(async (open) => {
      const db = await open(false);
      await migratePlatformDb(db, PLATFORM_MIGRATIONS.filter((m) => m.version <= 59));
      await seedOperation(db, "op_expand_a");
      await seedOperation(db, "op_expand_b");
      await insertHold(db, "env_a", "op_expand_a", "attempt_a", 1);
      await insertHold(db, "env_b", "op_expand_b", "attempt_b", 2);
      const columns = "workspace_id,project_id,environment_id,operation_id,attempt_id,generation,manifest_digest,authority_digest,holder,fence_token,created_at";
      const before = await db.query(`select ${columns} from platform.cleanup_writer_holds order by environment_id`);
      expect(await primaryKey(db, "cleanup_writer_holds")).toEqual(["workspace_id", "project_id", "environment_id"]);

      // Schema 61 replaces this key (see the schema 61 block below); this block checks schema 60 only.
      await migratePlatformDb(db, PLATFORM_MIGRATIONS.filter((m) => m.version <= 60));
      expect(await primaryKey(db, "cleanup_writer_holds")).toEqual(["workspace_id", "project_id", "environment_id"]);
      expect(await db.query(`select ${columns} from platform.cleanup_writer_holds order by environment_id`)).toEqual(before);
      const seqs = await db.query<{ environment_id: string; hold_seq: string }>("select environment_id, hold_seq::text as hold_seq from platform.cleanup_writer_holds order by environment_id");
      expect(seqs).toHaveLength(2);
      expect(seqs.every((r) => /^\d+$/.test(r.hold_seq))).toBe(true);
      expect(new Set(seqs.map((r) => r.hold_seq)).size).toBe(2);
      // An N-1 insert that omits hold_seq still succeeds and receives the next generation.
      await insertHold(db, "env_c", "op_expand_a", "attempt_c", 3);
      expect(BigInt((await holdSeq(db, "env_c")).hold_seq)).toBeGreaterThan(BigInt(seqs[1].hold_seq));
    });
  }, 60_000);

  it("the new tables are append-only, row-secured and bound to real holds and operations", async () => {
    await lane.withFresh(async (open) => {
      const db = await open(true);
      await seedOperation(db, "op_expand_c");
      await insertHold(db, "env_a", "op_expand_c", "attempt_c", 4);
      const hold = await holdSeq(db, "env_a");
      await db.query(`insert into platform.cleanup_writer_hold_releases(workspace_id,project_id,environment_id,hold_seq,operation_id,attempt_id,generation,released_by,inventory_snapshot)
        values($1,$2,$3,$4::bigint,'op_expand_c','attempt_c',$5,'janitor','{"workflow":0}'::jsonb)`, [SCOPE.workspaceId, SCOPE.projectId, SCOPE.environmentId, hold.hold_seq, generation(4)]);
      // A release cannot name a generation that is not that hold's generation.
      await expect(db.query(`insert into platform.cleanup_writer_hold_releases(workspace_id,project_id,environment_id,hold_seq,operation_id,attempt_id,generation,released_by,inventory_snapshot)
        values($1,$2,$3,$4::bigint,'op_expand_c','attempt_c',$5,'janitor','{}'::jsonb)`, [SCOPE.workspaceId, SCOPE.projectId, SCOPE.environmentId, hold.hold_seq, generation(99)])).rejects.toThrow();
      // Schema 62 refuses a settlement before its database-clock horizon, so this row settles a runner job already settled.
      await db.query(`insert into platform.runners(id,workspace_id,name,public_key) values('runner_expand_c',$1,'diagnostic','fixture-public-key')`, [SCOPE.workspaceId]);
      await db.query(`insert into platform.runner_jobs(id,runner_id,workspace_id,operation_id,kind,capability,envelope,status,expires_at,started_at,settled_at)
        values('job_expand_c','runner_expand_c',$1,'op_expand_c','diagnostic','infrastructure.apply','synthetic-no-authority','succeeded',clock_timestamp()-interval '1 hour',clock_timestamp()-interval '2 hours',clock_timestamp()-interval '2 hours')`, [SCOPE.workspaceId]);
      await db.query(`insert into platform.cleanup_writer_settlements(workspace_id,project_id,environment_id,operation_id,family,delivery_source,delivery_identity,horizon_at,sealed)
        values($1,null,null,'op_expand_c','runner','runner_jobs','job_expand_c',clock_timestamp(),'{"reserved":true}'::jsonb)`, [SCOPE.workspaceId]);
      await db.query(`insert into platform.cleanup_direct_attempts(workspace_id,project_id,environment_id,operation_id,attempt_id,evidence_digest,lease_scope,holder,fence_token,state)
        values($1,$2,$3,'op_expand_c','attempt_d',$4,'env:env_a','holder_a',1,'claimed')`, [SCOPE.workspaceId, SCOPE.projectId, SCOPE.environmentId, digest("evidence")]);
      await expect(db.query(`insert into platform.cleanup_writer_settlements(workspace_id,family,project_id,environment_id,operation_id,delivery_source,delivery_identity,horizon_at,sealed)
        values($1,'unknown',$2,$3,'op_expand_c','runner_jobs','x',clock_timestamp(),'{}'::jsonb)`, [SCOPE.workspaceId, SCOPE.projectId, SCOPE.environmentId])).rejects.toThrow();
      await expect(db.query(`insert into platform.cleanup_direct_attempts(workspace_id,project_id,environment_id,operation_id,attempt_id,evidence_digest,lease_scope,holder,fence_token,state)
        values($1,$2,$3,'op_expand_c','attempt_e',$4,'env:env_a','holder_a',1,'applied')`, [SCOPE.workspaceId, SCOPE.projectId, SCOPE.environmentId, digest("evidence")])).rejects.toThrow();
      await expect(db.query(`insert into platform.cleanup_writer_settlements(workspace_id,project_id,environment_id,operation_id,family,delivery_source,delivery_identity,horizon_at,sealed)
        values($1,$2,$3,'op_missing','workflow','workflow_start_intents','op_missing:a',clock_timestamp(),'{}'::jsonb)`, [SCOPE.workspaceId, SCOPE.projectId, SCOPE.environmentId])).rejects.toThrow();

      for (const [table, set] of [
        ["cleanup_writer_hold_releases", "released_by='changed'"],
        ["cleanup_writer_settlements", "horizon_at=clock_timestamp()"],
        ["cleanup_direct_attempts", "state='dispatched'"],
      ] as const) {
        await expect(db.query(`update platform.${table} set ${set}`), `${table} update`).rejects.toThrow(/cannot be changed or cleared/);
        await expect(db.query(`delete from platform.${table}`), `${table} delete`).rejects.toThrow(/cannot be changed or cleared/);
        expect((await db.query<{ n: string }>(`select count(*)::text as n from platform.${table}`))[0].n).toBe("1");
      }
      expect(await db.query<{ name: string; rls: boolean }>(`select c.relname as name, c.relrowsecurity as rls from pg_class c join pg_namespace n on n.oid=c.relnamespace
        where n.nspname='platform' and c.relname in ('cleanup_writer_hold_releases','cleanup_writer_settlements','cleanup_direct_attempts') order by c.relname`)).toEqual([
        { name: "cleanup_direct_attempts", rls: true },
        { name: "cleanup_writer_hold_releases", rls: true },
        { name: "cleanup_writer_settlements", rls: true },
      ]);
    });
  }, 60_000);
});

// Runs on every lane: PGlite always, and the PostgreSQL lane when ZENITH_TEST_PLATFORM_PG_URL is set.
describe("cleanup direct attempt history schema 60", () => {
  const WS = "ws_direct60";
  const seedOperation = (db: PlatformDbHandle, id: string) =>
    db.query(`insert into platform.operations(id,workspace_id,capability,principal,status,proposal,proposal_digest,input_digest,correlation_id,expires_at)
      values($1,$2,'infrastructure.destroy','{}'::jsonb,'succeeded','{}'::jsonb,$3,$3,'corr',clock_timestamp()+interval '1 day')`, [id, WS, digest(id)]);
  const attempt = (db: PlatformDbHandle, operationId: string, state: "claimed" | "dispatched", evidence: string, fence = 1) =>
    db.query(`insert into platform.cleanup_direct_attempts(workspace_id,project_id,environment_id,operation_id,attempt_id,evidence_digest,lease_scope,holder,fence_token,state)
      values($1,'project_d','env_d',$2,'attempt_direct',$3,'env:env_d','holder_d',$4,$5)`, [WS, operationId, evidence, fence, state]);
  const rowsFor = (db: PlatformDbHandle, operationId: string) =>
    db.query<{ state: string }>("select state from platform.cleanup_direct_attempts where workspace_id=$1 and operation_id=$2 order by state", [WS, operationId]);

  it("a dispatch is history after its own matching claim: refused without it, on any mismatch, and immutable once written", async () => {
    for (const lane of lanes) {
      await lane.withFresh(async (open) => {
        const db = await open(true);
        await seedOperation(db, "op_direct_a");
        const evidence = digest("evidence-a");
        await expect(attempt(db, "op_direct_a", "dispatched", evidence), `${lane.name}: dispatch without claim`).rejects.toThrow(/matching claimed attempt/);
        await attempt(db, "op_direct_a", "claimed", evidence);
        await expect(attempt(db, "op_direct_a", "dispatched", digest("other-evidence")), `${lane.name}: other evidence`).rejects.toThrow(/matching claimed attempt/);
        await expect(attempt(db, "op_direct_a", "dispatched", evidence, 2), `${lane.name}: other fence`).rejects.toThrow(/matching claimed attempt/);
        expect(await rowsFor(db, "op_direct_a")).toEqual([{ state: "claimed" }]);
        await attempt(db, "op_direct_a", "dispatched", evidence);
        expect(await rowsFor(db, "op_direct_a")).toEqual([{ state: "claimed" }, { state: "dispatched" }]);
        await expect(attempt(db, "op_direct_a", "claimed", evidence), `${lane.name}: second claim`).rejects.toThrow();
        await expect(db.query("update platform.cleanup_direct_attempts set holder='changed' where operation_id='op_direct_a'")).rejects.toThrow(/cannot be changed or cleared/);
        await expect(db.query("delete from platform.cleanup_direct_attempts where operation_id='op_direct_a'")).rejects.toThrow(/cannot be changed or cleared/);
        expect(await rowsFor(db, "op_direct_a")).toEqual([{ state: "claimed" }, { state: "dispatched" }]);
      });
    }
  }, 120_000);
});

describe("cleanup writer hold generations schema 61", () => {
  const WS = "ws_gen61";
  const gen = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
  // The writer trigger projects the operation's proposal scope, so every scoped operation carries it.
  const seedOperation = (db: PlatformDbHandle, id: string, environmentId: string) =>
    db.query(`insert into platform.operations(id,workspace_id,project_id,environment_id,capability,principal,status,proposal,proposal_digest,input_digest,correlation_id,expires_at)
      values($1,$2,'project_g',$3,'infrastructure.apply','{}'::jsonb,'succeeded',$4::text::jsonb,$5,$5,'corr',clock_timestamp()+interval '1 day')`,
      [id, WS, environmentId, JSON.stringify({ scope: { workspaceId: WS, projectId: "project_g", environmentId } }), digest(id)]);
  const insertHold = (db: PlatformDbHandle, environmentId: string, operationId: string, attempt: string, n: number) =>
    db.query(`insert into platform.cleanup_writer_holds(workspace_id,project_id,environment_id,operation_id,attempt_id,generation,manifest_digest,authority_digest,holder,fence_token)
      values($1,'project_g',$2,$3,$4,$5,$6,$7,'holder_g',1)`, [WS, environmentId, operationId, attempt, gen(n), digest(`m:${attempt}`), digest(`a:${attempt}`)]);
  const release = (db: PlatformDbHandle, environmentId: string, n: number) =>
    db.query(`insert into platform.cleanup_writer_hold_releases(workspace_id,project_id,environment_id,hold_seq,operation_id,attempt_id,generation,released_by,inventory_snapshot)
      select h.workspace_id,h.project_id,h.environment_id,h.hold_seq,h.operation_id,h.attempt_id,h.generation,'test','{"workflow":0}'::jsonb
      from platform.cleanup_writer_holds h where h.workspace_id=$1 and h.environment_id=$2 and h.generation=$3`, [WS, environmentId, gen(n)]);
  const deliver = (db: PlatformDbHandle, operationId: string, jti: string) =>
    db.query(`insert into platform.capability_grants(jti,workspace_id,operation_id,capability,audience,issued_at,expires_at)
      values($1,$2,$3,'infrastructure.apply','worker',clock_timestamp(),clock_timestamp()+interval '1 hour')`, [jti, WS, operationId]);

  it("the newest unreleased generation freezes its scope, and older unreleased generations never freeze", async () => {
    for (const lane of lanes) {
      await lane.withFresh(async (open) => {
        const db = await open(true);
        expect((await db.query<{ key: string }>(`select string_agg(a.attname, ',' order by k.ordinality) as key from pg_constraint c
          cross join lateral unnest(c.conkey) with ordinality as k(attnum, ordinality) join pg_attribute a on a.attrelid=c.conrelid and a.attnum=k.attnum
          where c.conrelid='platform.cleanup_writer_holds'::regclass and c.contype='p'`))[0].key).toBe("workspace_id,hold_seq");
        for (const id of ["op_g_a1", "op_g_a2", "op_g_a3"]) await seedOperation(db, id, "env_a");
        await seedOperation(db, "op_g_b1", "env_b");
        await insertHold(db, "env_a", "op_g_a1", "attempt_1", 1);
        await expect(deliver(db, "op_g_a2", "jti-1"), `${lane.name}: first freeze`).rejects.toThrow(/refuses a new possible delivery/);
        await deliver(db, "op_g_b1", "jti-b");
        // A superseding generation is the frozen one: the older unreleased generation no longer matters.
        await insertHold(db, "env_a", "op_g_a2", "attempt_2", 2);
        await expect(deliver(db, "op_g_a3", "jti-2"), `${lane.name}: superseding freeze`).rejects.toThrow(/refuses a new possible delivery/);
        await release(db, "env_a", 2);
        await deliver(db, "op_g_a3", "jti-3");
        await expect(deliver(db, "op_g_a3", "jti-4"), `${lane.name}: still released`).resolves.toBeDefined();
      });
    }
  }, 120_000);

  it("a generation releases once, and one held attempt owns at most one generation", async () => {
    for (const lane of lanes) {
      await lane.withFresh(async (open) => {
        const db = await open(true);
        await seedOperation(db, "op_g_c1", "env_c");
        await insertHold(db, "env_c", "op_g_c1", "attempt_c", 3);
        await expect(insertHold(db, "env_c", "op_g_c1", "attempt_c", 4), `${lane.name}: second generation for one attempt`).rejects.toThrow();
        await release(db, "env_c", 3);
        await expect(release(db, "env_c", 3), `${lane.name}: second release`).rejects.toThrow();
        expect((await db.query<{ n: string }>("select count(*)::text as n from platform.cleanup_writer_hold_releases where workspace_id=$1", [WS]))[0].n).toBe("1");
      });
    }
  }, 120_000);
});
