/**
 * The ordered list of platform control-store migrations.
 *
 * Append-only. A migration that has shipped is never edited (its checksum is
 * recorded in `platform.schema_migrations` and verified on every open); a change
 * is a new module with the next version number. Versions are contiguous from 1.
 */
import { sha256Hex } from "@/lib/controlplane/digest";
import { migration0001Core } from "./0001_core";
import { migration0002Reconcile } from "./0002_reconcile";
import { migration0003MachineRequests } from "./0003_machine_requests";
import { migration0004ApprovalRounds } from "./0004_approval_rounds";
import { migration0005ReadJobs } from "./0005_read_jobs";
import { migration0006GithubSources } from "./0006_github_sources";
import { migration0007PlanArtifacts } from "./0007_plan_artifacts";
import { migration0008BuildLaunches } from "./0008_build_launches";
import { migration0009GithubRevocation } from "./0009_github_revocation";
import { migration0010GithubDeliveries } from "./0010_github_deliveries";
import { migration0011AgentEffectReceipts } from "./0011_agent_effect_receipts";
import { migration0012WorkflowStartIntents } from "./0012_workflow_start_intents";
import { migration0013ApprovedSourceSnapshots } from "./0013_approved_source_snapshots";
import { migration0014MixedChildIntents } from "./0014_mixed_child_intents";
import { migration0015CleanupWriterBarriers } from "./0015_cleanup_writer_barriers";
import { migration0016CleanupWriterSettlements } from "./0016_cleanup_writer_settlements";
import { migration0017MachineRunbooks } from "./0017_machine_runbooks";
import { migration0018OwnershipTransfers } from "./0018_ownership_transfers";
import { migration0019IncidentStability } from "./0019_incident_stability";
import { migration0020OptimizerSettings } from "./0020_optimizer_settings";
import { migration0021ScheduledJobRuns } from "./0021_scheduled_job_runs";
import { migration0022ConnectionRotations } from "./0022_connection_rotations";
import { migration0023ReleasePipelines } from "./0023_release_pipelines";
import { migration0024Portability } from "./0024_portability";
import { migration0025AgentLifecycle } from "./0025_agent_lifecycle";
import { migration0026PluginBoundaries } from "./0026_plugin_boundaries";
import { migration0027GithubRevocationReason } from "./0027_github_revocation_reason";
import { migration0036CodingAgentRuns } from "./0036_coding_agent_runs";
import { migration0028IncidentStabilityHardening } from "./0028_incident_stability_hardening";
import { migration0029CleanupWriterRecordFields } from "./0029_cleanup_writer_record_fields";
import { migration0030DurableIntentAuthority } from "./0030_durable_intent_authority";
import { migration0031ExecutableSemantics } from "./0031_executable_semantics";
import { migration0032PlanCustodyStateRecovery } from "./0032_plan_custody_state_recovery";
import { migration0033ExternalEffects } from "./0033_external_effects";
import { migration0034K8sGuestBindings } from "./0034_k8s_guest_bindings";
import { migration0035McpStreams } from "./0035_mcp_streams";
import { migration0037ActualSpend } from "./0037_actual_spend";
import { migration0038FairBoundedControlPlane } from "./0038_fair_bounded_control_plane";
import { migration0039KeyCustody } from "./0039_key_custody";
import { migration0040MixedParentPlans } from "./0040_mixed_parent_plans";
import { migration0041MixedRuns } from "./0041_mixed_runs";
import { migration0042ExternalEffectKeyBounds } from "./0042_external_effect_key_bounds";
import { migration0043McpStreamEventsTenantIndex } from "./0043_mcp_stream_events_tenant_index";
import { migration0044MixedOutputRecords } from "./0044_mixed_output_records";
import { migration0045SloMeasurements } from "./0045_slo_measurements";
import { migration0046RecoveryEpochs } from "./0046_recovery_epochs";
import { migration0047Retention } from "./0047_retention";
import { migration0048AuditExports } from "./0048_audit_exports";
import { migration0049ManagedSourceProvider } from "./0049_managed_source_provider";
import { migration0050ManagedServing } from "./0050_managed_serving";
import { migration0051TenantIsolationEffects } from "./0051_tenant_isolation_effects";
import { migration0052Billing } from "./0052_billing";
import { migration0053FieldOwnershipSerialization } from "./0053_field_ownership_serialization";
import { migration0054AgentUpdateControls } from "./0054_agent_update_controls";
import { migration0055IsolationCustody } from "./0055_isolation_custody";
import { migration0056WorkspaceMfaControls } from "./0056_workspace_mfa_controls";
import { migration0057Wave5Gaps } from "./0057_wave5_gaps";
import { migration0058KubernetesSourceProvider } from "./0058_kubernetes_source_provider";
import { migration0059FieldOwnershipGrantRevocation } from "./0059_field_ownership_grant_revocation";
import { migration0060CleanupWriterExpand } from "./0060_cleanup_writer_expand";
import { migration0061CleanupWriterHoldGenerations } from "./0061_cleanup_writer_hold_generations";
import { migration0062CleanupDeliverySettlement } from "./0062_cleanup_delivery_settlement";

// Unpublished integration closes the unused J4 reservation: versions 55..58
// are isolation custody, workspace MFA, Wave 5 gaps and Kubernetes source custody.

export interface PlatformMigration {
  /** contiguous from 1 */
  version: number;
  name: string;
  /** DDL only; idempotent; may contain many statements */
  sql: string;
}

export const PLATFORM_MIGRATIONS: readonly PlatformMigration[] = [migration0001Core, migration0002Reconcile, migration0003MachineRequests, migration0004ApprovalRounds, migration0005ReadJobs, migration0006GithubSources, migration0007PlanArtifacts, migration0008BuildLaunches, migration0009GithubRevocation, migration0010GithubDeliveries, migration0011AgentEffectReceipts, migration0012WorkflowStartIntents, migration0013ApprovedSourceSnapshots, migration0014MixedChildIntents, migration0015CleanupWriterBarriers, migration0016CleanupWriterSettlements, migration0017MachineRunbooks, migration0018OwnershipTransfers, migration0019IncidentStability, migration0020OptimizerSettings, migration0021ScheduledJobRuns, migration0022ConnectionRotations, migration0023ReleasePipelines, migration0024Portability, migration0025AgentLifecycle, migration0026PluginBoundaries, migration0027GithubRevocationReason, migration0028IncidentStabilityHardening, migration0029CleanupWriterRecordFields, migration0030DurableIntentAuthority, migration0031ExecutableSemantics, migration0032PlanCustodyStateRecovery, migration0033ExternalEffects, migration0034K8sGuestBindings, migration0035McpStreams, migration0036CodingAgentRuns, migration0037ActualSpend, migration0038FairBoundedControlPlane, migration0039KeyCustody, migration0040MixedParentPlans, migration0041MixedRuns, migration0042ExternalEffectKeyBounds, migration0043McpStreamEventsTenantIndex, migration0044MixedOutputRecords, migration0045SloMeasurements, migration0046RecoveryEpochs, migration0047Retention, migration0048AuditExports, migration0049ManagedSourceProvider, migration0050ManagedServing, migration0051TenantIsolationEffects, migration0052Billing, migration0053FieldOwnershipSerialization, migration0054AgentUpdateControls, migration0055IsolationCustody, migration0056WorkspaceMfaControls, migration0057Wave5Gaps, migration0058KubernetesSourceProvider, migration0059FieldOwnershipGrantRevocation, migration0060CleanupWriterExpand, migration0061CleanupWriterHoldGenerations, migration0062CleanupDeliverySettlement];

/** The highest version this build knows. */
export const PLATFORM_SCHEMA_VERSION: number = PLATFORM_MIGRATIONS[PLATFORM_MIGRATIONS.length - 1].version;

/** SHA-256 of the SQL text — what the ledger records and every open verifies. */
export function migrationChecksum(migration: PlatformMigration): string {
  return sha256Hex(migration.sql);
}
