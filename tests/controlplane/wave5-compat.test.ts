import { describe, expect, it } from "vitest";
import { PLATFORM_MIGRATIONS } from "@/lib/controlplane/db/migrations";
import { assessPlatformMigration, assertPendingMigrationsCompatible } from "@/lib/controlplane/db/compat";

describe("Wave 5 migration admission", () => {
  it("keeps the verifier baseline and the complete contiguous assembly", () => {
    expect(PLATFORM_MIGRATIONS.map(m => m.version)).toEqual(Array.from({ length: 59 }, (_, i) => i + 1));
    expect(PLATFORM_MIGRATIONS[41].name).toBe("external_effect_key_bounds");
    expect(PLATFORM_MIGRATIONS[42].name).toBe("mcp_stream_events_tenant_index");
  });

  it.each([44, 45, 46, 47, 48, 50, 52, 54, 55, 56])("admits only the exact additive migration %i", version => {
    const migration = PLATFORM_MIGRATIONS.find(m => m.version === version)!;
    expect(assessPlatformMigration(migration, 43).class).toBe("expand");
    expect(() => assertPendingMigrationsCompatible([migration], { baseline: 43, allowed: new Set() })).not.toThrow();
    expect(() => assertPendingMigrationsCompatible([{ ...migration, sql: migration.sql + "\nalter table platform.operations drop column proposal;" }], { baseline: 43, allowed: new Set([version]) })).toThrow();
    expect(() => assertPendingMigrationsCompatible([{ ...migration, sql: migration.sql.replace("revoke", "grant") }], { baseline: 43, allowed: new Set([version]) })).toThrow();
  });

  it.each([49, 51, 57, 58])("requires exact registry custody and drained-writer admission for CHECK widening %i", version => {
    const migration = PLATFORM_MIGRATIONS.find(m => m.version === version)!;
    expect(() => assertPendingMigrationsCompatible([migration], { baseline: 43, allowed: new Set() })).toThrow("previous release is drained");
    expect(() => assertPendingMigrationsCompatible([migration], { baseline: 43, allowed: new Set([version]) })).not.toThrow();
    expect(() => assertPendingMigrationsCompatible([migration], { baseline: 43, approvals: [], allowed: new Set([version]) })).toThrow("no LIFE-10 approval");
    expect(() => assertPendingMigrationsCompatible([{ ...migration, sql: migration.sql + " " }], { baseline: 43, allowed: new Set([version]) })).toThrow("SQL changed after approval");
  });
});
