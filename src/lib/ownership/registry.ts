/**
 * The field-ownership registry: (resource type, field path) -> owner.
 *
 * Rules are declarative and pure. Registering two rules that claim the same
 * field of the same resource type is refused: that is exactly the "competing
 * writers" this registry exists to prevent. Facts (an attached autoscaler, a
 * release-managed image) pick the owner within one rule; approved transfers
 * move a single field of a single resource and are honoured only while they
 * still match the rule they were approved against.
 *
 * Anything with no rule is owned by `iac` (declared in the manifest), with
 * `source: "default"` so callers can tell "explicitly owned" from "assumed".
 */
import { digest } from "@/lib/controlplane/digest";
import { normalizePath, pathCovers } from "./paths";
import { FIELD_OWNERS, type FieldOwner, type FieldOwnerResolution, type FieldQuery, type OwnershipRule, type OwnershipTransfer, type OwnershipTransferRequest } from "./types";

export class OwnershipRegistrationError extends Error {
  readonly code = "ownership_rule_invalid";
  constructor(message: string) {
    super(message);
    this.name = "OwnershipRegistrationError";
  }
}

/** The exact content an approval binds. Order-independent, secret-free. */
export function transferDigest(t: Pick<OwnershipTransfer, "address" | "resourceType" | "path" | "from" | "to">): string {
  return digest({ v: 1, address: t.address, resourceType: t.resourceType, path: normalizePath(t.path), from: t.from, to: t.to });
}

export function transferRequest(input: Pick<OwnershipTransfer, "address" | "resourceType" | "path" | "from" | "to">): OwnershipTransferRequest {
  return { ...input, path: normalizePath(input.path), digest: transferDigest(input) };
}

const isOwner = (v: unknown): v is FieldOwner => (FIELD_OWNERS as readonly unknown[]).includes(v);

export class FieldOwnershipRegistry {
  private readonly byId = new Map<string, OwnershipRule>();

  constructor(rules: readonly OwnershipRule[] = []) {
    for (const rule of rules) this.register(rule);
  }

  register(rule: OwnershipRule): void {
    if (!rule.id || rule.resourceTypes.length === 0 || rule.paths.length === 0) throw new OwnershipRegistrationError(`Rule "${rule.id}" needs an id, resource types and paths.`);
    if (this.byId.has(rule.id)) throw new OwnershipRegistrationError(`Rule "${rule.id}" is already registered.`);
    if (!isOwner(rule.owner) || Object.values(rule.whenFact ?? {}).some((o) => !isOwner(o))) throw new OwnershipRegistrationError(`Rule "${rule.id}" names an unknown owner.`);
    for (const other of this.byId.values()) {
      const sharedType = rule.resourceTypes.find((t) => other.resourceTypes.includes(t));
      if (!sharedType) continue;
      for (const a of rule.paths)
        for (const b of other.paths)
          if (pathCovers(a, b) || pathCovers(b, a))
            throw new OwnershipRegistrationError(`Rule "${rule.id}" and "${other.id}" both claim ${sharedType} ${normalizePath(a)}; a field has exactly one owner.`);
    }
    this.byId.set(rule.id, { ...rule });
  }

  rules(): OwnershipRule[] {
    return [...this.byId.values()].sort((a, b) => (a.id < b.id ? -1 : 1));
  }

  /** The rule covering this field, preferring the most specific path. */
  ruleFor(resourceType: string, path: string): OwnershipRule | undefined {
    let best: { rule: OwnershipRule; len: number } | undefined;
    for (const rule of this.byId.values()) {
      if (!rule.resourceTypes.includes(resourceType)) continue;
      for (const p of rule.paths) {
        if (!pathCovers(p, path)) continue;
        const len = normalizePath(p).length;
        if (!best || len > best.len) best = { rule, len };
      }
    }
    return best?.rule;
  }

  /** Rules for a resource type (either spelling). */
  rulesForType(resourceType: string): OwnershipRule[] {
    return this.rules().filter((r) => r.resourceTypes.includes(resourceType));
  }

  /** Owner before transfers. */
  baseOwner(query: FieldQuery): FieldOwnerResolution {
    const rule = this.ruleFor(query.resourceType, query.path);
    if (!rule) {
      return { owner: "iac", baseOwner: "iac", source: "default", reason: `No ownership rule covers ${query.resourceType} ${normalizePath(query.path)}; it is owned by the manifest (iac).` };
    }
    let owner: FieldOwner = rule.owner;
    for (const [fact, o] of Object.entries(rule.whenFact ?? {})) {
      if (o && query.facts?.[fact as keyof NonNullable<FieldQuery["facts"]>] === true) {
        owner = o;
        break;
      }
    }
    return { owner, baseOwner: owner, source: "rule", ruleId: rule.id, reason: rule.reason };
  }

  /** Whether `transfer` is a currently valid movement of exactly this field. */
  transferApplies(transfer: OwnershipTransfer, query: FieldQuery, base: FieldOwner, now: Date): boolean {
    if (!query.address || transfer.address !== query.address) return false;
    if (!transfer.approvalId || transfer.from === transfer.to) return false;
    if (transfer.from === "provider-managed" || transfer.to === "provider-managed") return false;
    if (transfer.from !== base) return false; // approved against a different world
    if (transfer.digest !== transferDigest(transfer)) return false;
    if (Number.isNaN(Date.parse(transfer.approvedAt))) return false;
    if (transfer.expiresAt !== undefined) {
      const exp = Date.parse(transfer.expiresAt);
      if (Number.isNaN(exp) || exp <= now.getTime()) return false;
    }
    const a = this.ruleFor(transfer.resourceType, transfer.path);
    const b = this.ruleFor(query.resourceType, query.path);
    if (a || b) return a !== undefined && a.id === b?.id;
    return transfer.resourceType === query.resourceType && normalizePath(transfer.path) === normalizePath(query.path);
  }

  resolve(query: FieldQuery, opts: { transfers?: readonly OwnershipTransfer[]; now?: Date } = {}): FieldOwnerResolution {
    const base = this.baseOwner(query);
    const now = opts.now ?? new Date();
    const live = (opts.transfers ?? [])
      .filter((t) => this.transferApplies(t, query, base.owner, now))
      .sort((x, y) => Date.parse(y.approvedAt) - Date.parse(x.approvedAt) || (x.digest < y.digest ? -1 : 1));
    const t = live[0];
    if (!t) return base;
    return {
      owner: t.to,
      baseOwner: base.owner,
      source: "transfer",
      ...(base.ruleId ? { ruleId: base.ruleId } : {}),
      transferId: t.approvalId,
      reason: `Ownership of ${normalizePath(query.path)} moved from ${t.from} to ${t.to} by approval ${t.approvalId}.`,
    };
  }
}

/* ------------------------------ default rules ------------------------------ */

/**
 * What exists today, written down. `ignorePaths` mirror the `lifecycle.ignore_changes`
 * the drivers already emit (a test keeps them in step), plus the replica count,
 * which is emitted only when an autoscaler is attached.
 */
export const DEFAULT_OWNERSHIP_RULES: readonly OwnershipRule[] = [
  {
    id: "aws.ecs.replicas",
    resourceTypes: ["aws:ecs_service", "aws_ecs_service"],
    paths: ["replicas", "desired_count"],
    owner: "iac",
    whenFact: { autoscaled: "autoscaler" },
    ignorePaths: ["desired_count"],
    reason: "The manifest sets the task count; an attached Application Auto Scaling target takes it over.",
  },
  {
    id: "k8s.workload.replicas",
    resourceTypes: ["k8s:Deployment", "k8s:StatefulSet"],
    paths: ["replicas", "spec.replicas"],
    owner: "iac",
    whenFact: { autoscaled: "autoscaler" },
    reason: "The manifest sets replicas; a HorizontalPodAutoscaler takes the field over and the Deployment omits it.",
  },
  {
    id: "gcp.cloud-run.replicas",
    resourceTypes: ["gcp:cloud_run_service", "google_cloud_run_v2_service"],
    paths: ["replicas", "template[].scaling[].min_instance_count", "template[].scaling[].max_instance_count"],
    owner: "iac",
    whenFact: { autoscaled: "autoscaler" },
    ignorePaths: ["template[0].scaling[0].min_instance_count", "template[0].scaling[0].max_instance_count"],
    reason: "The manifest sets the instance range; native service.scale needs an approved transfer, and an attached autoscaler takes the range over.",
  },
  {
    id: "azure.container-app.replicas",
    resourceTypes: ["azure:container_app", "azurerm_container_app"],
    paths: ["replicas", "template[].min_replicas", "template[].max_replicas"],
    owner: "iac",
    whenFact: { autoscaled: "autoscaler" },
    ignorePaths: ["template[0].min_replicas", "template[0].max_replicas"],
    reason: "The manifest pins min = max replicas; a scale rule takes the range over.",
  },
  {
    id: "aws.ec2.ami",
    resourceTypes: ["aws:ec2_instance", "aws_instance"],
    paths: ["ami"],
    owner: "provider-managed",
    ignorePaths: ["ami"],
    reason: "A newer AMI must never replace a running instance; the image is chosen at create time and left alone.",
  },
  {
    id: "azure.flexible-server.zone",
    resourceTypes: ["azure:postgresql_flexible_server", "azure:mysql_flexible_server", "azurerm_postgresql_flexible_server", "azurerm_mysql_flexible_server"],
    paths: ["zone", "high_availability[].standby_availability_zone"],
    owner: "provider-managed",
    ignorePaths: ["zone", "high_availability[0].standby_availability_zone"],
    reason: "Azure fails the primary over between zones; the zone it reports is its own decision.",
  },
  {
    id: "azure.release.image",
    resourceTypes: ["azure:container_app","azure:container_app_job","azurerm_container_app","azurerm_container_app_job"],
    paths: ["artifact.image","image","template[].container[].image","template[].container[].args"],
    owner: "iac",
    whenFact: { releaseManaged: "native-op" },
    ignorePaths: ["template[0].container[0].image","template[0].container[0].args"],
    reason: "For built artifacts the release operation records the image digest; IaC preserves it instead of reverting to the placeholder.",
  },
  {
    id: "gcp.cloud-run-service.release.image",
    resourceTypes: ["gcp:cloud_run_service","google_cloud_run_service","google_cloud_run_v2_service"],
    paths: ["artifact.image","image","template[].containers[].image"],
    owner: "iac",
    whenFact: { releaseManaged: "native-op" },
    ignorePaths: ["template[0].containers[0].image"],
    reason: "For built artifacts the release operation records the image digest; IaC preserves it instead of reverting to the placeholder.",
  },
  {
    id: "gcp.cloud-run-job.release.image",
    resourceTypes: ["gcp:cloud_run_job","google_cloud_run_v2_job"],
    paths: ["artifact.image","image","template[].template[].containers[].image"],
    owner: "iac",
    whenFact: { releaseManaged: "native-op" },
    ignorePaths: ["template[0].template[0].containers[0].image"],
    reason: "For built artifacts the release operation records the image digest; IaC preserves it instead of reverting to the placeholder.",
  },
  {
    id: "k8s.release.image",
    resourceTypes: ["k8s:Deployment"],
    paths: ["artifact.image","image"],
    owner: "iac",
    whenFact: { releaseManaged: "native-op" },
    reason: "For built artifacts the release operation records the image digest; IaC preserves it instead of reverting to the placeholder.",
  },
  {
    id: "aws.ssm.parameter-value",
    resourceTypes: ["aws_ssm_parameter"],
    paths: ["value"],
    owner: "native-op",
    ignorePaths: ["value"],
    reason: "IaC creates the parameter with a placeholder; the secret value is written natively and never by tofu.",
  },
];

export const defaultFieldOwnershipRegistry = new FieldOwnershipRegistry(DEFAULT_OWNERSHIP_RULES);
