/**
 * `aws:rds_instance` — compile half (PostgreSQL, and MySQL through
 * `spec.engine`). Observation, runtime, verification and day-two operations are
 * in `rds-instance.ts` / `rds-operations.ts`.
 *
 * What a managed node compiles to (every decision is one line below):
 *
 *   aws_db_subnet_group      the node's PRIVATE subnets (RDS needs ≥ 2 AZs; a
 *                            node with fewer is refused at compile time rather
 *                            than failing at apply)
 *   aws_db_parameter_group   `rds.force_ssl=1` (PostgreSQL) /
 *                            `require_secure_transport=ON` (MySQL); family from
 *                            engine + major version
 *   aws_security_group       the node's own group (see `shared/security-group`),
 *                            attached here; rules come from firewall nodes
 *   aws_db_instance          gp3 + storage autoscaling, encrypted (AWS-managed
 *                            KMS key), never public, IAM database auth on,
 *                            Multi-AZ = `highAvailability`, Performance Insights
 *                            on classes that have it (7 days, free tier), final
 *                            snapshot always, deletion protection unless
 *                            `deletionPolicy = allow`
 *
 * SECRETS: the master password is never generated, stored, output or passed by
 * Zenith. `manage_master_user_password = true` makes RDS create and rotate the
 * credential in Secrets Manager; the fragment exposes only the secret's ARN
 * (`master_user_secret_arn`) for identity grants and as an output. There is no
 * `password`, `random_password` or `password_wo` anywhere in the output, and
 * `spec.config` is never copied (only `storageGb` / `maxStorageGb` are read,
 * as validated integers).
 *
 * Honest limits:
 *   - Contract-level only: the compiled JSON is checked by `tofu validate`
 *     against the pinned provider, never applied to a real account here.
 *   - The final-snapshot identifier is deterministic (`<identifier>-final`), so
 *     deleting, re-creating and deleting the same node a second time collides
 *     with the first final snapshot; AWS refuses rather than overwrites.
 *   - `apply_immediately` is left at the provider default (false): disruptive
 *     changes wait for the maintenance window and show up as pending
 *     modifications in `runtime`.
 *   - `hourly` backups: RDS point-in-time recovery is continuous whenever the
 *     retention period is > 0, so `hourly` compiles to the same 7-day retention
 *     as `daily`; it does not schedule additional snapshots.
 *   - MySQL: `specs.ts` has no `MysqlSpec`; it is assumed to mirror
 *     `PostgresSpec` with `engine: "mysql"` (expansion does not produce it yet).
 */
import type { CompileContext, TofuFragment } from "@/lib/drivers/types";
import type { ResourceNode } from "@/lib/resources/types";
import {
  addSecurityGroup,
  cloudName,
  DriverCompileError,
  FragmentBuilder,
  nodeName,
  refExpr,
  REF,
  resourceTags,
  securityGroupExpr,
  subnetsOf,
  tfLabel,
} from "@/lib/providers/aws/drivers/shared";
import {
  BACKUPS,
  configInt,
  DELETION_POLICIES,
  EMPTY_FRAGMENT,
  escapeTemplate,
  isManaged,
  sizeOf,
  specBool,
  specEnum,
  type BackupPolicy,
  type DeletionPolicy,
  type Size,
} from "./support";

export type RdsEngine = "postgres" | "mysql";

export interface RdsSpecView {
  engine: RdsEngine;
  version: string;
  size: Size | undefined;
  highAvailability: boolean;
  backup: BackupPolicy;
  deletionPolicy: DeletionPolicy;
  instanceClass: string | undefined;
}

/** Instance class by portable size. Same ladder as the legacy exporter so a size means the same thing everywhere. */
export const RDS_CLASS_BY_SIZE: Readonly<Record<Size, string>> = {
  nano: "db.t4g.micro",
  small: "db.t4g.small",
  standard: "db.t4g.medium",
  performance: "db.m6g.large",
};

/** Allocated storage (GiB) by size; gp3's minimum for PostgreSQL and MySQL is 20. */
export const RDS_STORAGE_BY_SIZE: Readonly<Record<Size, number>> = { nano: 20, small: 20, standard: 50, performance: 200 };

const INSTANCE_CLASS = /^db\.[a-z0-9]{2,10}\.[a-z0-9]{3,12}$/;
const POSTGRES_VERSION = /^\d{1,2}(\.\d{1,2})?$/;
const MYSQL_VERSION = /^\d{1,2}\.\d{1,2}(\.\d{1,2})?$/;
const MAX_STORAGE_GIB = 65536;
/** Classes Performance Insights is not offered on (conservative: burstable nano/micro/small). */
const NO_PERFORMANCE_INSIGHTS = /^db\.t[234]g?\.(nano|micro|small)$/;
const RESERVED_DB_NAMES = new Set(["postgres", "template0", "template1", "rdsadmin", "mysql", "sys", "information_schema", "performance_schema"]);

export function readRdsSpec(node: ResourceNode): RdsSpecView {
  const raw = node.spec as Record<string, unknown>;
  const engine = specEnum<RdsEngine>(node, "engine", ["postgres", "mysql"], node.kind === "mysql" ? "mysql" : "postgres");
  const versionRaw = raw.version === undefined ? (engine === "mysql" ? "8.0" : "16") : String(raw.version);
  if (!(engine === "mysql" ? MYSQL_VERSION : POSTGRES_VERSION).test(versionRaw)) {
    throw new DriverCompileError("invalid_spec", node.address, `spec.version "${versionRaw.slice(0, 20)}" is not a ${engine} version such as ${engine === "mysql" ? "8.0" : "16"}.`);
  }
  const instanceClass = typeof raw.instanceClass === "string" && raw.instanceClass !== "" ? raw.instanceClass : undefined;
  if (instanceClass !== undefined && !INSTANCE_CLASS.test(instanceClass)) {
    throw new DriverCompileError("invalid_spec", node.address, `spec.instanceClass "${instanceClass.slice(0, 30)}" is not an RDS instance class such as db.t4g.small.`);
  }
  const size = sizeOf(node);
  if (size === undefined && instanceClass === undefined) {
    throw new DriverCompileError("invalid_spec", node.address, `spec.size must be one of nano, small, standard, performance (or set spec.instanceClass).`);
  }
  return {
    engine,
    version: versionRaw,
    size,
    highAvailability: specBool(node, "highAvailability", false),
    // Unspecified means daily: automated backups stay on with 7-day retention. Explicit `none` is the opt-out.
    backup: specEnum(node, "backup", BACKUPS, "daily"),
    deletionPolicy: specEnum(node, "deletionPolicy", DELETION_POLICIES),
    instanceClass,
  };
}

/** `16.4` → `16`; MySQL `8.0.36` → `8.0`. The unit drift compares (observed versions carry the minor). */
export function majorVersionOf(engine: RdsEngine, version: string): string {
  const parts = version.split(".");
  return engine === "mysql" ? parts.slice(0, 2).join(".") : parts[0];
}

export const rdsInstanceClassOf = (spec: RdsSpecView): string => spec.instanceClass ?? RDS_CLASS_BY_SIZE[spec.size as Size];

/**
 * Backup retention days. `none` disables backups only when the policy allows
 * deleting the data anyway; otherwise RDS keeps one day so a restore point
 * exists. `daily` and `hourly` are both 7 days (see the module comment).
 */
export function backupRetentionFor(backup: BackupPolicy, deletionPolicy: DeletionPolicy): number {
  if (backup === "none") return deletionPolicy === "allow" ? 0 : 1;
  return 7;
}

/** Deletion protection is on for every policy except `allow`. */
export const deletionProtectionFor = (deletionPolicy: DeletionPolicy): boolean => deletionPolicy !== "allow";

export interface RdsStorage {
  allocated: number;
  max: number;
}

export function rdsStorageFor(node: ResourceNode, spec: RdsSpecView): RdsStorage {
  const allocated = configInt(node, "storageGb", 20, MAX_STORAGE_GIB) ?? RDS_STORAGE_BY_SIZE[spec.size ?? "small"];
  const max = configInt(node, "maxStorageGb", 20, MAX_STORAGE_GIB) ?? Math.min(allocated * 5, MAX_STORAGE_GIB);
  if (max < allocated) throw new DriverCompileError("invalid_spec", node.address, `config.maxStorageGb (${max}) must not be below the allocated storage (${allocated}).`);
  return { allocated, max };
}

/** The database name created inside the instance: the node name with `-` → `_`, never a reserved name. */
export function databaseNameFor(address: string): string {
  const base = nodeName(address).replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "") || "app";
  const named = /^[a-z]/.test(base) ? base : `db_${base}`;
  return (RESERVED_DB_NAMES.has(named) ? `${named}_db` : named).slice(0, 60);
}

/** RDS instance identifier: ≤ 63, lowercase letters/digits/hyphens, starts with a letter. */
export function rdsIdentifierFor(ctx: Pick<CompileContext, "namePrefix">, address: string): string {
  const id = cloudName(ctx.namePrefix, nodeName(address), 63);
  return /^[a-z]/.test(id) ? id : `z${id}`.slice(0, 63);
}

/** The deterministic final-snapshot identifier for an instance identifier. */
export const finalSnapshotIdentifierFor = (identifier: string): string => `${identifier.slice(0, 249)}-final`.replace(/-{2,}/g, "-");

export function compileRdsInstance(node: ResourceNode, ctx: CompileContext): TofuFragment {
  if (!isManaged(node)) return { ...EMPTY_FRAGMENT };
  const spec = readRdsSpec(node);
  const label = tfLabel(node.address);
  const identifier = rdsIdentifierFor(ctx, node.address);
  const storage = rdsStorageFor(node, spec);
  const instanceClass = rdsInstanceClassOf(spec);
  const major = majorVersionOf(spec.engine, spec.version);

  const subnets = subnetsOf(node, ctx, "private");
  if (subnets.length < 2) {
    throw new DriverCompileError(
      "missing_node",
      node.address,
      `an RDS subnet group needs private subnets in at least 2 availability zones, but this node depends on ${subnets.length}. Give the environment 2 or more zones.`
    );
  }

  const tags = resourceTags(ctx.tags, node.address, identifier);
  const b = new FragmentBuilder(node.address);

  // The primary resource goes first: `TofuFragment.addresses[0]` is what `ctx.ref` falls back to.
  b.resource("aws_db_instance", label, {
    identifier,
    engine: spec.engine,
    engine_version: spec.version,
    instance_class: instanceClass,
    db_name: databaseNameFor(node.address),
    username: "zenith",
    // RDS creates, stores and rotates the master credential in Secrets Manager.
    // No password attribute of any kind is set, so none can reach state or plan.
    manage_master_user_password: true,
    iam_database_authentication_enabled: true,

    storage_type: "gp3",
    allocated_storage: storage.allocated,
    max_allocated_storage: storage.max,
    storage_encrypted: true,

    multi_az: spec.highAvailability,
    publicly_accessible: false,
    db_subnet_group_name: `\${aws_db_subnet_group.${label}_subnets.name}`,
    vpc_security_group_ids: [securityGroupExpr(ctx, node.address)],
    parameter_group_name: `\${aws_db_parameter_group.${label}_params.name}`,

    backup_retention_period: backupRetentionFor(spec.backup, spec.deletionPolicy),
    copy_tags_to_snapshot: true,
    delete_automated_backups: spec.deletionPolicy === "allow",
    deletion_protection: deletionProtectionFor(spec.deletionPolicy),
    skip_final_snapshot: false,
    final_snapshot_identifier: finalSnapshotIdentifierFor(identifier),

    auto_minor_version_upgrade: true,
    ...(NO_PERFORMANCE_INSIGHTS.test(instanceClass) ? {} : { performance_insights_enabled: true, performance_insights_retention_period: 7 }),
    tags,
  });

  b.resource("aws_db_subnet_group", `${label}_subnets`, {
    name: identifier,
    description: escapeTemplate(`Zenith managed subnet group for ${node.address}`),
    subnet_ids: subnets.map((s) => refExpr(ctx.ref(s.address, REF.id))),
    tags,
  });

  b.resource("aws_db_parameter_group", `${label}_params`, {
    name: `${identifier}-${major.replace(".", "")}`.slice(0, 255),
    family: `${spec.engine}${major}`,
    description: escapeTemplate(`Zenith managed parameters for ${node.address}`),
    parameter:
      spec.engine === "postgres"
        ? [{ name: "rds.force_ssl", value: "1", apply_method: "immediate" }]
        : [{ name: "require_secure_transport", value: "ON", apply_method: "immediate" }],
    // A major-version change renames the group; the new one must exist before the old is destroyed.
    lifecycle: { create_before_destroy: true },
    tags,
  });

  addSecurityGroup(b, node, ctx);

  // Published for other nodes (identity grants, bindings) and for Zenith.
  b.expose(REF.arn, `aws_db_instance.${label}.arn`);
  b.expose(REF.id, `aws_db_instance.${label}.identifier`);
  b.expose("resource_id", `aws_db_instance.${label}.resource_id`);
  b.expose("endpoint_address", `aws_db_instance.${label}.address`);
  b.expose("port", `aws_db_instance.${label}.port`);
  b.expose("master_user_secret_arn", `aws_db_instance.${label}.master_user_secret[0].secret_arn`);

  b.output(`${label}_arn`, `\${aws_db_instance.${label}.arn}`);
  b.output(`${label}_endpoint_address`, `\${aws_db_instance.${label}.address}`, { description: "Connection host; not a secret." });
  b.output(`${label}_port`, `\${aws_db_instance.${label}.port}`);
  b.output(`${label}_master_user_secret_arn`, `\${aws_db_instance.${label}.master_user_secret[0].secret_arn}`, {
    description: "ARN of the RDS-managed master credential in Secrets Manager. The value is never in state.",
  });
  return b.build();
}
