import { describe, expect, it } from "vitest";
import { rdsInstanceDriver } from "@/lib/providers/aws/drivers/data";
import { DriverCompileError } from "@/lib/providers/aws/drivers/shared";
import {
  backupRetentionFor,
  databaseNameFor,
  deletionProtectionFor,
  finalSnapshotIdentifierFor,
  RDS_CLASS_BY_SIZE,
} from "@/lib/providers/aws/drivers/data/rds-compile";
import { compileCtx, mkNode, networkNodes, postgresSpec } from "./_helpers";

const SUBNETS = ["subnet/private-a", "subnet/private-b"];
const build = (spec: Record<string, unknown>, over: Partial<Parameters<typeof mkNode>[3]> = {}, kind: "postgres" | "mysql" = "postgres", address = "postgres/db") =>
  mkNode(address, kind, spec, { dependsOn: SUBNETS, ...over });

function compile(node = build(postgresSpec())) {
  const nodes = [...networkNodes(), node];
  return rdsInstanceDriver.compile!(node, compileCtx(nodes));
}
const instance = (f: ReturnType<typeof compile>, label = "postgres_db") => (f.resource!.aws_db_instance as Record<string, Record<string, unknown>>)[label];

describe("aws:rds_instance compile: structure", () => {
  it("defines the instance first, then subnet group, parameter group and the node's security group", () => {
    const f = compile();
    expect(f.addresses).toEqual([
      "aws_db_instance.postgres_db",
      "aws_db_subnet_group.postgres_db_subnets",
      "aws_db_parameter_group.postgres_db_params",
      "aws_security_group.postgres_db_sg",
    ]);
    expect(Object.keys(f.resource!).sort()).toEqual(["aws_db_instance", "aws_db_parameter_group", "aws_db_subnet_group", "aws_security_group"]);
  });

  it("puts the database in the private subnets, behind its own security group, encrypted and private", () => {
    const f = compile();
    const db = instance(f);
    expect(db.publicly_accessible).toBe(false);
    expect(db.storage_encrypted).toBe(true);
    expect(db.iam_database_authentication_enabled).toBe(true);
    expect(db.vpc_security_group_ids).toEqual(["${local.ref_postgres_db__security_group_id}"]);
    const group = (f.resource!.aws_db_subnet_group as Record<string, Record<string, unknown>>).postgres_db_subnets;
    expect(group.subnet_ids).toEqual(["${local.ref_subnet_private_a__id}", "${local.ref_subnet_private_b__id}"]);
  });

  it("uses gp3 storage with autoscaling headroom, Performance Insights where the class has it, and a final snapshot", () => {
    const db = instance(compile());
    expect(db).toMatchObject({
      storage_type: "gp3",
      allocated_storage: 20,
      max_allocated_storage: 100,
      auto_minor_version_upgrade: true,
      copy_tags_to_snapshot: true,
      skip_final_snapshot: false,
      final_snapshot_identifier: "zen-prod-db-final",
    });
    // db.t4g.small has no Performance Insights: none is requested
    expect(db.performance_insights_enabled).toBeUndefined();
    const big = instance(compile(build(postgresSpec({ size: "performance" }))));
    expect(big).toMatchObject({ instance_class: "db.m6g.large", performance_insights_enabled: true, performance_insights_retention_period: 7, allocated_storage: 200, max_allocated_storage: 1000 });
  });

  it("enforces TLS in a parameter group whose family follows engine and major version", () => {
    const pg = (f: ReturnType<typeof compile>) => (f.resource!.aws_db_parameter_group as Record<string, Record<string, unknown>>).postgres_db_params;
    expect(pg(compile())).toMatchObject({ family: "postgres16", parameter: [{ name: "rds.force_ssl", value: "1", apply_method: "immediate" }], lifecycle: { create_before_destroy: true } });
    expect(pg(compile(build(postgresSpec({ version: "17.2" }))))).toMatchObject({ family: "postgres17" });
  });

  it("publishes the references other nodes and Zenith use, and exposes the master secret ARN as an output", () => {
    const f = compile();
    expect(Object.keys(f.locals!).sort()).toEqual(
      [
        "ref_postgres_db__arn",
        "ref_postgres_db__endpoint_address",
        "ref_postgres_db__id",
        "ref_postgres_db__master_user_secret_arn",
        "ref_postgres_db__port",
        "ref_postgres_db__resource_id",
        "ref_postgres_db__security_group_id",
      ].sort()
    );
    expect(f.locals!.ref_postgres_db__master_user_secret_arn).toBe("${aws_db_instance.postgres_db.master_user_secret[0].secret_arn}");
    expect(f.output!.postgres_db_master_user_secret_arn.value).toBe("${aws_db_instance.postgres_db.master_user_secret[0].secret_arn}");
    expect(Object.values(f.output!).every((o) => o.sensitive !== true)).toBe(true);
  });

  it("is deterministic: compiling twice gives identical JSON", () => {
    expect(JSON.stringify(compile())).toBe(JSON.stringify(compile()));
  });

  it("compiles referenced and external nodes to nothing, never to a resource block", () => {
    for (const ownership of ["referenced", "external"] as const) {
      expect(compile(build(postgresSpec(), { ownership, externalRef: "arn:aws:rds:ap-south-1:123456789012:db:legacy" }))).toEqual({ addresses: [] });
    }
  });
});

describe("aws:rds_instance compile: no secret can reach the fragment", () => {
  const CANARY = "CANARY-pw-7f3a91c2d0e84b";

  it("never sets a password attribute and ignores secret-looking spec.config", () => {
    const f = compile(build(postgresSpec({ config: { password: CANARY, masterPassword: CANARY, token: CANARY, storageGb: 40 } })));
    const text = JSON.stringify(f);
    expect(text).not.toContain(CANARY);
    const db = instance(f);
    expect(db.manage_master_user_password).toBe(true);
    expect(db).not.toHaveProperty("password");
    expect(db).not.toHaveProperty("password_wo");
    expect(db).not.toHaveProperty("password_wo_version");
    expect(db.allocated_storage).toBe(40); // the allowlisted key is honoured, the rest is not copied
    expect(Object.keys(f.resource!)).not.toContain("random_password");
    expect(Object.keys(f.resource!)).not.toContain("aws_secretsmanager_secret_version");
    // the only password-shaped key anywhere is the boolean that delegates the credential to RDS
    const keys = [...text.matchAll(/"([A-Za-z_]+)":/g)].map((m) => m[1]).filter((k) => /password|passwd|secret_string/i.test(k));
    expect([...new Set(keys)]).toEqual(["manage_master_user_password"]);
  });

  it("escapes template openers in tag values built from context text", () => {
    const node = build(postgresSpec());
    const ctx = compileCtx([...networkNodes(), node], { tags: { "zenith:workspace": "${file(\"/etc/passwd\")}" } });
    const f = rdsInstanceDriver.compile!(node, ctx);
    expect(instance(f).tags).toMatchObject({ "zenith:workspace": "$${file(\"/etc/passwd\")}" });
  });
});

describe("aws:rds_instance compile: policy mappings", () => {
  it.each([
    ["deny", true],
    ["approval", true],
    ["allow", false],
  ] as const)("deletionPolicy %s → deletion_protection %s", (policy, protectedDb) => {
    const db = instance(compile(build(postgresSpec({ deletionPolicy: policy }))));
    expect(db.deletion_protection).toBe(protectedDb);
    expect(db.skip_final_snapshot).toBe(false);
    expect(db.delete_automated_backups).toBe(policy === "allow");
    expect(deletionProtectionFor(policy)).toBe(protectedDb);
  });

  it("keeps automated backups on (7 days) when the spec names no backup policy", () => {
    expect(instance(compile(build(postgresSpec({ backup: undefined })))).backup_retention_period).toBe(7);
  });

  it.each([
    ["none", "allow", 0],
    ["none", "approval", 1],
    ["none", "deny", 1],
    ["daily", "allow", 7],
    ["daily", "approval", 7],
    ["hourly", "deny", 7],
  ] as const)("backup %s with deletionPolicy %s → backup_retention_period %i", (backup, policy, days) => {
    expect(backupRetentionFor(backup, policy)).toBe(days);
    expect(instance(compile(build(postgresSpec({ backup, deletionPolicy: policy })))).backup_retention_period).toBe(days);
  });

  it.each([
    ["nano", "db.t4g.micro"],
    ["small", "db.t4g.small"],
    ["standard", "db.t4g.medium"],
    ["performance", "db.m6g.large"],
  ] as const)("size %s → %s, and an explicit instanceClass wins", (size, klass) => {
    expect(RDS_CLASS_BY_SIZE[size]).toBe(klass);
    expect(instance(compile(build(postgresSpec({ size })))).instance_class).toBe(klass);
    expect(instance(compile(build(postgresSpec({ size, instanceClass: "db.r6g.xlarge" })))).instance_class).toBe("db.r6g.xlarge");
  });

  it("Multi-AZ follows highAvailability", () => {
    expect(instance(compile(build(postgresSpec({ highAvailability: true })))).multi_az).toBe(true);
    expect(instance(compile(build(postgresSpec({ highAvailability: false })))).multi_az).toBe(false);
  });

  it("serves MySQL through spec.engine with its own parameter group", () => {
    const node = build(postgresSpec({ engine: "mysql", version: "8.0" }), {}, "mysql", "mysql/legacy");
    const f = rdsInstanceDriver.compile!(node, compileCtx([...networkNodes(), node]));
    const db = (f.resource!.aws_db_instance as Record<string, Record<string, unknown>>).mysql_legacy;
    expect(db).toMatchObject({ engine: "mysql", engine_version: "8.0", manage_master_user_password: true });
    expect((f.resource!.aws_db_parameter_group as Record<string, Record<string, unknown>>).mysql_legacy_params).toMatchObject({ family: "mysql8.0", parameter: [{ name: "require_secure_transport", value: "ON" }] });
  });
});

describe("aws:rds_instance compile: refuses what it cannot express", () => {
  it("needs private subnets in at least two zones", () => {
    const one = build(postgresSpec(), { dependsOn: ["subnet/private-a"] });
    expect(() => rdsInstanceDriver.compile!(one, compileCtx([...networkNodes(), one]))).toThrow(DriverCompileError);
    const none = build(postgresSpec(), { dependsOn: [] });
    expect(() => rdsInstanceDriver.compile!(none, compileCtx([...networkNodes(), none]))).toThrow(/at least 2 availability zones/);
  });

  it.each([
    ["an unknown deletion policy (fail closed)", { deletionPolicy: "whenever" }],
    ["an unknown backup policy", { backup: "minutely" }],
    ["a malformed version", { version: "16; drop" }],
    ["a malformed instance class", { instanceClass: "${file('x')}" }],
    ["an unknown size with no class override", { size: "huge" }],
    ["a non-integer storage size", { config: { storageGb: "lots" } }],
    ["a maximum below the allocation", { config: { storageGb: 100, maxStorageGb: 50 } }],
  ])("%s", (_name, over) => {
    const node = build(postgresSpec(over));
    expect(() => rdsInstanceDriver.compile!(node, compileCtx([...networkNodes(), node]))).toThrow(DriverCompileError);
  });
});

describe("rds naming helpers", () => {
  it("derives a valid database name and a deterministic final-snapshot id", () => {
    expect(databaseNameFor("postgres/orders-db")).toBe("orders_db");
    expect(databaseNameFor("postgres/postgres")).toBe("postgres_db");
    expect(databaseNameFor("postgres/9lives")).toBe("db_9lives");
    expect(finalSnapshotIdentifierFor("zen-prod-db")).toBe("zen-prod-db-final");
  });

  it("keeps identifiers within 63 characters with a hash suffix when cut", () => {
    const long = build(postgresSpec(), {}, "postgres", `postgres/${"x".repeat(30)}`);
    const id = instance(compile(long), `postgres_${"x".repeat(30)}`).identifier as string;
    expect(id.length).toBeLessThanOrEqual(63);
    expect(id).toMatch(/^[a-z][a-z0-9-]*[a-z0-9]$/);
  });
});
