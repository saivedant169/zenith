# METADATA
# title: Deny rules
# description: |
#   Every rule in this package is a complete rule whose value is a reason
#   object `{code, message}`; the rule is defined (true) only when the request
#   must be denied. The decision aggregator (`zenith.decision`) iterates this
#   whole package, so each rule name is the stable identifier reported as
#   `zenith.rules.deny.<name>` in the decision's reasons.
#
#   Keep this package to reason rules only: helpers belong in `zenith.lib`.
#   Messages contain only static text, numbers and validated region names —
#   never resource addresses or other externally derived strings, because
#   reasons are shown to people and to models.
#
#   Any single deny wins over every approval requirement and over allow.
package zenith.rules.deny

import rego.v1

import data.zenith.lib

# A workspace admin can deny a capability outright (exact capability names).
workspace_denied_capability := {
	"code": "workspace_denied_capability",
	"message": "This capability is denied by the workspace policy.",
} if input.request.capability in input.workspacePolicy.deniedCapabilities

# A principal that is not a workspace member has no authority. `system`
# principals (Zenith's own reconciler and workflows) are not human members and
# are governed by the origin/autonomy/auto-remediation rules instead.
no_workspace_role := {
	"code": "no_workspace_role",
	"message": "The principal has no role in this workspace.",
} if {
	not input.principal.kind == "system"

	# `not ref in set` is undefined (not true) when `ref` is undefined, because
	# OPA evaluates call arguments outside the negation; bind a defaulted value
	# first so a missing role is denied instead of slipping through.
	role := object.get(object.get(input, "principal", {}), "role", "none")
	not role in {"viewer", "editor", "admin"}
}

# Viewers can observe, never change anything.
viewer_cannot_mutate := {
	"code": "viewer_cannot_mutate",
	"message": "Viewers cannot run capabilities that change anything.",
} if {
	input.principal.role == "viewer"
	lib.mutating
}

# The capability's integration scope (read/plan/logs/write/publish) must be one
# of the scopes the integration credential was issued with. Scopes are literal:
# `write` does not imply `read`.
integration_scope_missing := {
	"code": "integration_scope_missing",
	"message": "The integration credential lacks the scope this capability requires.",
} if {
	input.principal.kind == "integration"
	required := input.request.integrationScope
	not required in object.get(input.principal, "integrationScopes", [])
}

# An integration request that does not name the required scope cannot be
# checked, so it is refused rather than waved through.
integration_scope_unresolved := {
	"code": "integration_scope_unresolved",
	"message": "The capability's integration scope was not supplied, so the credential cannot be checked.",
} if {
	input.principal.kind == "integration"
	not input.request.integrationScope
}

# Databases are never deleted in production through the delete capability.
production_database_delete := {
	"code": "production_database_delete",
	"message": "Deleting a database in a production environment is not permitted.",
} if {
	lib.is_production
	input.request.capability == "database.delete"
}

# A production plan that deletes or replaces stateful resources is denied,
# except through `infrastructure.destroy`, which has its own admin,
# separation-of-duties approval path (see zenith.rules.approval). A read
# (plan/observe) attached to an approved destroy cannot delete anything, so
# only mutating requests are judged by what their plan deletes.
production_destroys_data := {
	"code": "production_destroys_data",
	"message": "A production plan that deletes or replaces stateful resources is denied unless it is an explicit infrastructure.destroy.",
} if {
	lib.is_production
	lib.mutating
	input.plan.destroysData == true
	input.request.capability != "infrastructure.destroy"
}

# machine.exec / container.exec / provider.native are off in production unless
# the workspace policy explicitly enables them (and then still need approval).
escape_hatch_denied_in_production := {
	"code": "escape_hatch_denied_in_production",
	"message": "Unrestricted execution surfaces are disabled in production for this workspace.",
} if {
	lib.is_production
	lib.escape_hatch
	not input.workspacePolicy.allowEscapeHatchInProduction == true
}

# A plan that would make a database or cache publicly reachable.
public_database := {
	"code": "public_database",
	"message": sprintf("The plan makes %d database or cache resource(s) publicly accessible.", [lib.plan_count("publicDatabases")]),
} if lib.plan_count("publicDatabases") > 0

# A plan whose IAM statements grant `*`/`service:*` actions on `*` resources.
wildcard_iam := {
	"code": "wildcard_iam",
	"message": sprintf("The plan grants wildcard IAM access in %d statement(s).", [lib.plan_count("wildcardIam")]),
} if lib.plan_count("wildcardIam") > 0

# Regions outside the workspace's approved list. "When set": an absent list is
# unrestricted; a present empty list approves nothing and therefore denies every
# checked region (fail closed).
region_not_approved := {
	"code": "region_not_approved",
	"message": sprintf("Region(s) outside the workspace's approved regions: %s.", [concat(", ", sort(unapproved))]),
} if {
	approved_list := input.workspacePolicy.approvedRegions
	approved := {region | some region in approved_list}
	unapproved := {region | some region in lib.checked_regions; not region in approved}
	count(unapproved) > 0
}

# Provider mutations require managed ownership. The exact metadata-only adoption
# capability may propose a referenced ownership claim under mandatory approval.
unowned_resource_mutation := {
	"code": "unowned_resource_mutation",
	"message": "Zenith does not mutate resources it does not own (referenced or external).",
} if {
	lib.mutating
	input.resource
	not input.resource.ownership == "managed"
	not lib.metadata_adoption
}

# A mutation must name the environment it acts on; without it the
# environment-scoped rules (production, autonomy, region) cannot be evaluated.
mutation_environment_unresolved := {
	"code": "mutation_environment_unresolved",
	"message": "A capability that changes something must name the environment it acts on.",
} if {
	lib.mutating
	not input.environment
}

# The input document is structurally invalid. Normally unreachable — the
# TypeScript engine rejects malformed input before it gets here — but a document
# fed straight to the wasm must be denied, not slip past rules that only match
# well-formed data.
malformed_input := {
	"code": "malformed_input",
	"message": "The policy input is malformed.",
} if not lib.well_formed
