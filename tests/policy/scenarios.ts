/**
 * The decision table. Each row is one request and the decision the committed
 * policy must give it; `scenarios.test.ts` runs every row through the real wasm,
 * and `parity.test.ts` runs the same rows through the OPA interpreter.
 *
 * `codes` is the exact, complete set of reason codes; `constraints` is the exact
 * restriction set (absent means the decision must carry none).
 */
import type { CapabilityName } from "@/lib/capabilities/catalog";
import type { PolicyOutcome } from "@/lib/controlplane/types";
import type { WorkspacePolicyOverrides } from "@/lib/policy";
import { planFacts, production, type Patch } from "./support";

export interface Scenario {
  name: string;
  capability: CapabilityName;
  patch?: Patch;
  workspace?: WorkspacePolicyOverrides;
  outcome: PolicyOutcome;
  codes: string[];
  approval?: { count: number; minRole: "editor" | "admin"; separationOfDuties: boolean };
  constraints?: Record<string, number>;
}

const editor = { count: 1, minRole: "editor", separationOfDuties: false } as const;
const admin = { count: 1, minRole: "admin", separationOfDuties: false } as const;
const adminSeparated = { count: 1, minRole: "admin", separationOfDuties: true } as const;
const logLimits = { maxLines: 1000, maxWindowHours: 24 };
const execLimits = { timeoutSec: 300, maxOutputBytes: 1048576 };

const fullAutonomy = { environment: { autonomyLevel: 5 } };
const reconciler = { principal: { kind: "system", role: "none" }, context: { origin: "reconciler" } };
const agent = { principal: { kind: "integration", role: "editor", integrationScopes: ["read", "plan", "logs", "write"] }, context: { origin: "agent" } };
const openSsh = { address: "aws_security_group.web", port: "22", cidr: "0.0.0.0/0" };

export const SCENARIOS: Scenario[] = [
  /* ------------------------------------------------------------ baseline */
  { name: "editor restarts a service in development", capability: "service.restart", outcome: "allow", codes: ["allowed_within_policy"] },
  { name: "system principal without a role may act within autonomy", capability: "service.restart", patch: { principal: { kind: "system", role: "none" }, context: { origin: "system" } }, outcome: "allow", codes: ["allowed_within_policy"] },
  { name: "read of a plan is allowed for a viewer at autonomy 0", capability: "infrastructure.plan", patch: { principal: { role: "viewer" }, environment: { autonomyLevel: 0 } }, outcome: "allow", codes: ["allowed_read_only"] },
  { name: "read without an environment is allowed", capability: "topology.read", patch: { environment: undefined, resource: undefined }, outcome: "allow", codes: ["allowed_read_only"] },
  { name: "external resource can still be read", capability: "container.inspect", patch: { resource: { ownership: "external" } }, outcome: "allow", codes: ["allowed_read_only"] },

  /* ----------------------------------------------------- roles and scopes */
  { name: "viewer cannot mutate", capability: "service.restart", patch: { principal: { role: "viewer" } }, outcome: "deny", codes: ["viewer_cannot_mutate"] },
  { name: "non-member cannot even read", capability: "topology.read", patch: { principal: { role: "none" } }, outcome: "deny", codes: ["no_workspace_role"] },
  { name: "integration without the write scope is denied", capability: "service.restart", patch: { principal: { kind: "integration", integrationScopes: ["read"] } }, outcome: "deny", codes: ["integration_scope_missing"] },
  { name: "integration with a read scope cannot read logs", capability: "logs.read", patch: { principal: { kind: "integration", integrationScopes: ["read"] } }, outcome: "deny", codes: ["integration_scope_missing"] },
  { name: "integration with the logs scope reads logs, restricted", capability: "logs.read", patch: { principal: { kind: "integration", integrationScopes: ["read", "logs"] } }, outcome: "allow", codes: ["allowed_read_only"], constraints: logLimits },
  { name: "workspace can deny a capability outright", capability: "service.restart", workspace: { deniedCapabilities: ["service.restart"] }, patch: { principal: { role: "admin" } }, outcome: "deny", codes: ["workspace_denied_capability"] },
  { name: "several denials are all reported", capability: "service.restart", patch: { principal: { role: "viewer" }, resource: { ownership: "referenced" } }, outcome: "deny", codes: ["unowned_resource_mutation", "viewer_cannot_mutate"] },

  /* ----------------------------------------------------------- ownership */
  { name: "a referenced resource is never mutated", capability: "service.restart", patch: { resource: { ownership: "referenced" } }, outcome: "deny", codes: ["unowned_resource_mutation"] },
  { name: "an external resource is never mutated", capability: "service.scale", patch: { resource: { ownership: "external" } }, outcome: "deny", codes: ["unowned_resource_mutation"] },
  { name: "a mutation must name its environment", capability: "service.restart", patch: { environment: undefined }, outcome: "deny", codes: ["mutation_environment_unresolved"] },

  /* ---------------------------------------------------------- production */
  { name: "production database delete is denied", capability: "database.delete", patch: { ...production, principal: { role: "admin" } }, outcome: "deny", codes: ["production_database_delete"] },
  { name: "production database delete stays denied under the two-person rule", capability: "database.delete", patch: { ...production, principal: { role: "admin" } }, workspace: { twoPersonProduction: true }, outcome: "deny", codes: ["production_database_delete"] },
  { name: "staging database delete needs approval, not denial", capability: "database.delete", patch: { environment: { class: "staging", autonomyLevel: 5 } }, outcome: "require_approval", codes: ["autonomy_below_capability"], approval: editor },
  { name: "production apply that destroys data is denied", capability: "infrastructure.apply", patch: { ...production, plan: planFacts({ delete: 1, destroysData: true, destroyedStatefulAddresses: ["aws_db_instance.main"] }) }, outcome: "deny", codes: ["production_destroys_data"] },
  { name: "a production read attached to an approved teardown that deletes data is not denied by it", capability: "infrastructure.plan", patch: { ...production, plan: planFacts({ delete: 1, destroysData: true, destroyedStatefulAddresses: ["k8s_statefulset.legacy"] }) }, outcome: "allow", codes: ["allowed_read_only"] },
  { name: "a stateful deletion in staging requires human review at full autonomy", capability: "infrastructure.apply", patch: { environment: { class: "staging", autonomyLevel: 5 }, plan: planFacts({ delete: 1, destroysData: true, destroyedStatefulAddresses: ["aws_db_instance.main"], statefulDeletes: ["aws_db_instance.main"] }) }, outcome: "require_approval", codes: ["stateful_deletes_require_approval"], approval: editor },
  { name: "production infrastructure.destroy needs an admin and a second person", capability: "infrastructure.destroy", patch: { ...production, principal: { role: "admin" }, plan: planFacts({ delete: 4, destroysData: true, destroyedStatefulAddresses: ["aws_s3_bucket.assets"] }) }, outcome: "require_approval", codes: ["autonomy_below_capability", "production_destructive_requires_admin"], approval: adminSeparated },
  { name: "production firewall change needs an admin", capability: "firewall.modify", patch: production, outcome: "require_approval", codes: ["production_network_identity_change"], approval: admin },
  { name: "production firewall change under the two-person rule", capability: "firewall.modify", patch: production, workspace: { twoPersonProduction: true }, outcome: "require_approval", codes: ["production_network_identity_change", "two_person_production"], approval: { count: 1, minRole: "admin", separationOfDuties: true } },
  { name: "production plan touching IAM needs an admin", capability: "infrastructure.apply", patch: { ...production, plan: planFacts({ create: 1, identityChanges: ["aws_iam_role.app"] }) }, outcome: "require_approval", codes: ["production_network_identity_change"], approval: admin },
  { name: "production plan touching DNS needs an admin", capability: "infrastructure.apply", patch: { ...production, plan: planFacts({ update: 1, dnsChanges: ["aws_route53_record.www"] }) }, outcome: "require_approval", codes: ["production_network_identity_change"], approval: admin },
  { name: "the same firewall change in development is only autonomy-gated", capability: "firewall.modify", patch: fullAutonomy, outcome: "allow", codes: ["allowed_within_policy"] },
  { name: "two-person rule adds separation of duties to a production deploy", capability: "deployment.deploy", patch: production, workspace: { twoPersonProduction: true }, outcome: "require_approval", codes: ["two_person_production"], approval: { count: 1, minRole: "editor", separationOfDuties: true } },
  { name: "a production deploy at full autonomy without the rule runs", capability: "deployment.deploy", patch: production, outcome: "allow", codes: ["allowed_within_policy"] },

  /* -------------------------------------------------------------- autonomy */
  { name: "autonomy below the capability's level needs an editor", capability: "firewall.modify", outcome: "require_approval", codes: ["autonomy_below_capability"], approval: editor },
  { name: "autonomy at the capability's level runs unattended", capability: "deployment.deploy", outcome: "allow", codes: ["allowed_within_policy"] },
  { name: "defaultAutonomy 6 never runs unattended", capability: "identity.modify", patch: fullAutonomy, outcome: "require_approval", codes: ["autonomy_below_capability"], approval: editor },

  /* ------------------------------------------------------------------ cost */
  { name: "cost increase at the threshold needs approval", capability: "infrastructure.apply", patch: { ...fullAutonomy, plan: planFacts({ create: 2, costDeltaUsdMonthly: 50 }) }, outcome: "require_approval", codes: ["cost_threshold_exceeded"], approval: editor },
  { name: "cost increase just under the threshold runs", capability: "infrastructure.apply", patch: { ...fullAutonomy, plan: planFacts({ create: 2, costDeltaUsdMonthly: 49.99 }) }, outcome: "allow", codes: ["allowed_within_policy"] },
  { name: "a workspace can raise its own threshold", capability: "infrastructure.apply", workspace: { costApprovalThresholdUsd: 500 }, patch: { ...fullAutonomy, plan: planFacts({ create: 2, costDeltaUsdMonthly: 300 }) }, outcome: "allow", codes: ["allowed_within_policy"] },
  { name: "a cost reduction never needs approval", capability: "infrastructure.apply", patch: { ...fullAutonomy, plan: planFacts({ delete: 2, costDeltaUsdMonthly: -400 }) }, outcome: "allow", codes: ["allowed_within_policy"] },
  { name: "budget overrun needs an admin, not a denial", capability: "infrastructure.apply", workspace: { budgetUsdMonthly: 1000 }, patch: { ...fullAutonomy, plan: planFacts({ create: 1, costDeltaUsdMonthly: 10, projectedMonthlyUsd: 1200 }) }, outcome: "require_approval", codes: ["budget_exceeded"], approval: admin },

  /* --------------------------------------------------------- plan findings */
  { name: "a public database is denied", capability: "infrastructure.apply", patch: { ...fullAutonomy, plan: planFacts({ create: 1, publicDatabases: ["aws_db_instance.main"] }) }, outcome: "deny", codes: ["public_database"] },
  { name: "wildcard IAM is denied", capability: "infrastructure.apply", patch: { ...fullAutonomy, plan: planFacts({ create: 1, wildcardIam: ["aws_iam_policy.admin#statement[0]"] }) }, outcome: "deny", codes: ["wildcard_iam"] },
  { name: "open ingress needs an admin", capability: "infrastructure.apply", patch: { ...fullAutonomy, plan: planFacts({ update: 1, openIngress: [openSsh] }) }, outcome: "require_approval", codes: ["open_ingress"], approval: admin },
  { name: "unresolved security values need review", capability: "infrastructure.apply", patch: { ...fullAutonomy, plan: planFacts({ create: 1, unresolved: ["aws_iam_role_policy.app:policy"] }) }, outcome: "require_approval", codes: ["unresolved_security_attributes"], approval: editor },
  { name: "a denial beats every approval requirement", capability: "infrastructure.apply", patch: { environment: { autonomyLevel: 0 }, ...agent, plan: planFacts({ create: 1, publicDatabases: ["aws_db_instance.main"], costDeltaUsdMonthly: 900, openIngress: [openSsh] }) }, outcome: "deny", codes: ["public_database"] },
  { name: "plan facts are judged even when the capability only plans", capability: "infrastructure.plan", patch: { plan: planFacts({ create: 1, publicDatabases: ["aws_db_instance.main"] }) }, outcome: "deny", codes: ["public_database"] },
  { name: "several approval requirements merge to the strictest", capability: "infrastructure.apply", workspace: { twoPersonProduction: true }, patch: { environment: { class: "production", autonomyLevel: 3 }, plan: planFacts({ create: 1, costDeltaUsdMonthly: 60, openIngress: [openSsh] }) }, outcome: "require_approval", codes: ["autonomy_below_capability", "cost_threshold_exceeded", "open_ingress", "two_person_production"], approval: { count: 1, minRole: "admin", separationOfDuties: true } },

  /* --------------------------------------------------------------- regions */
  { name: "a plan region outside the approved regions is denied", capability: "infrastructure.apply", workspace: { approvedRegions: ["us-east-1"] }, patch: { ...fullAutonomy, plan: planFacts({ create: 1, regions: ["eu-west-1"] }) }, outcome: "deny", codes: ["region_not_approved"] },
  { name: "approved regions are allowed", capability: "infrastructure.apply", workspace: { approvedRegions: ["us-east-1", "eu-west-1"] }, patch: { ...fullAutonomy, plan: planFacts({ create: 1, regions: ["eu-west-1", "us-east-1"] }) }, outcome: "allow", codes: ["allowed_within_policy"] },
  { name: "with no approved-region list every region is allowed", capability: "infrastructure.apply", patch: { ...fullAutonomy, plan: planFacts({ create: 1, regions: ["ap-south-1"] }) }, outcome: "allow", codes: ["allowed_within_policy"] },
  { name: "a deploy into an unapproved environment region is denied", capability: "deployment.deploy", workspace: { approvedRegions: ["eu-west-1"] }, outcome: "deny", codes: ["region_not_approved"] },
  { name: "a teardown of an environment in a no-longer-approved region is not blocked by region", capability: "infrastructure.destroy", workspace: { approvedRegions: ["eu-west-1"] }, patch: { environment: { class: "staging", autonomyLevel: 5 } }, outcome: "require_approval", codes: ["autonomy_below_capability"], approval: editor },

  /* ------------------------------------------------------------ escape hatch */
  { name: "production exec is denied by default", capability: "machine.exec", patch: { ...production, principal: { role: "admin" } }, outcome: "deny", codes: ["escape_hatch_denied_in_production"] },
  { name: "production exec with the workspace opt-in needs an admin and a second person", capability: "machine.exec", workspace: { allowEscapeHatchInProduction: true }, patch: { ...production, principal: { role: "admin" } }, outcome: "require_approval", codes: ["autonomy_below_capability", "escape_hatch_requires_approval"], approval: adminSeparated, constraints: execLimits },
  { name: "development exec always needs an admin", capability: "machine.exec", patch: fullAutonomy, outcome: "require_approval", codes: ["autonomy_below_capability", "escape_hatch_requires_approval"], approval: admin, constraints: execLimits },
  { name: "the requester can narrow exec limits but not widen them", capability: "machine.exec", patch: { ...fullAutonomy, request: { constraints: { timeoutSec: 60, maxOutputBytes: 999999999 } } }, outcome: "require_approval", codes: ["autonomy_below_capability", "escape_hatch_requires_approval"], approval: admin, constraints: { timeoutSec: 60, maxOutputBytes: 1048576 } },
  { name: "provider.native is an escape hatch in production too", capability: "provider.native", patch: { ...production, principal: { role: "admin" } }, outcome: "deny", codes: ["escape_hatch_denied_in_production"] },

  /* --------------------------------------------------- reconciler and agents */
  { name: "development auto-remediation runs at autonomy 4", capability: "drift.repair", patch: reconciler, outcome: "allow", codes: ["allowed_within_policy"] },
  { name: "development auto-remediation below autonomy 4 needs approval", capability: "drift.repair", patch: { ...reconciler, environment: { autonomyLevel: 3 } }, outcome: "require_approval", codes: ["autonomy_below_capability"], approval: editor },
  { name: "production auto-remediation is off by default", capability: "drift.repair", patch: { ...reconciler, ...production }, outcome: "require_approval", codes: ["auto_remediation_disabled"], approval: editor },
  { name: "production auto-remediation limited to safe changes allows a medium-risk restart", capability: "service.restart", workspace: { autoRemediation: { production: "safe" } }, patch: { ...reconciler, ...production }, outcome: "allow", codes: ["allowed_within_policy"] },
  { name: "production auto-remediation limited to safe changes refuses a high-risk repair", capability: "drift.repair", workspace: { autoRemediation: { production: "safe" } }, patch: { ...reconciler, ...production }, outcome: "require_approval", codes: ["auto_remediation_not_safe"], approval: editor },
  { name: "production safe auto-remediation refuses a stateful target (risk raised)", capability: "service.restart", workspace: { autoRemediation: { production: "safe" } }, patch: { ...reconciler, ...production, resource: { stateful: true } }, outcome: "require_approval", codes: ["auto_remediation_not_safe"], approval: editor },
  { name: "staging defaults to safe auto-remediation, which refuses drift repair", capability: "drift.repair", patch: { ...reconciler, environment: { class: "staging", autonomyLevel: 5 } }, outcome: "require_approval", codes: ["auto_remediation_not_safe"], approval: editor },
  { name: "an agent's high-risk change needs an editor's approval even at full autonomy", capability: "deployment.deploy", patch: { ...agent, ...fullAutonomy }, outcome: "require_approval", codes: ["agent_high_risk_requires_approval"], approval: editor },
  { name: "an agent's low-risk change runs within autonomy", capability: "database.snapshot", patch: agent, outcome: "allow", codes: ["allowed_within_policy"] },
  { name: "the navigator's critical change needs approval on both counts", capability: "identity.modify", patch: { ...fullAutonomy, principal: { kind: "navigator", role: "editor" }, context: { origin: "navigator" } }, outcome: "require_approval", codes: ["agent_high_risk_requires_approval", "autonomy_below_capability"], approval: editor },

  /* ------------------------------------------------------------ constraints */
  { name: "log reads are restricted", capability: "logs.read", patch: { principal: { role: "viewer" } }, outcome: "allow", codes: ["allowed_read_only"], constraints: logLimits },
  { name: "system logs are restricted the same way", capability: "system.logs", outcome: "allow", codes: ["allowed_read_only"], constraints: logLimits },
  { name: "a requester can narrow log reads", capability: "logs.read", patch: { request: { constraints: { maxLines: 200, maxWindowHours: 2 } } }, outcome: "allow", codes: ["allowed_read_only"], constraints: { maxLines: 200, maxWindowHours: 2 } },
  { name: "a requester cannot widen log reads", capability: "logs.read", patch: { request: { constraints: { maxLines: 500000, maxWindowHours: 720 } } }, outcome: "allow", codes: ["allowed_read_only"], constraints: logLimits },
  { name: "a long grant duration is capped at an hour", capability: "logs.read", patch: { request: { requestedDurationSec: 3600 } }, outcome: "allow", codes: ["allowed_read_only"], constraints: { ...logLimits, grantDurationSec: 3600 } },
  { name: "a short grant duration is kept", capability: "topology.read", patch: { request: { requestedDurationSec: 120 } }, outcome: "allow", codes: ["allowed_read_only"], constraints: { grantDurationSec: 120 } },
  { name: "critical work gets fifteen-minute grants", capability: "infrastructure.destroy", patch: { environment: { class: "development", autonomyLevel: 5 }, request: { requestedDurationSec: 3600 } }, outcome: "require_approval", codes: ["autonomy_below_capability"], approval: editor, constraints: { grantDurationSec: 900 } },
  { name: "constraints are dropped from a denial", capability: "logs.read", workspace: { deniedCapabilities: ["logs.read"] }, patch: { request: { requestedDurationSec: 60 } }, outcome: "deny", codes: ["workspace_denied_capability"] },
];
