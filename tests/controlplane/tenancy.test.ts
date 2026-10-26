/**
 * Cross-tenant negative sweep.
 *
 * Workspace A gets one of everything; workspace B then calls EVERY read and
 * mutation that takes a workspace id, naming A's ids, and must see nothing and
 * change nothing. A completeness guard fails this file when a repository
 * function is added without being classified below, so a new function cannot
 * quietly skip the tenancy check.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as repos from "@/lib/controlplane/db/repos";
import { bindRepos } from "@/lib/controlplane/db/repos";
import { ControlStoreError } from "@/lib/controlplane/db";
import { digest } from "@/lib/controlplane/digest";
import type { BrokerProposal } from "@/lib/capabilities/types";
import { executionHolder } from "@/lib/execution/platform";
import type { PlanArtifactManifest } from "@/lib/tofu/engine";
import type { ResourceNode } from "@/lib/resources/types";
import { LANES, PG_URL, approve, newWorkspace, openLane, proposalFor, seedApprovedOperation, seedAwaitingApproval, uid, user } from "./_support/harness";
import { makeHarness, closeSharedPgliteAfterAll, scriptedEngine, requireApproval, sessionFor, approveAs, proposeOk, requestFor } from "../capabilities/support";
import { makePlan, change } from "../execution/fakes/fixtures";
import { buildPlanFacts } from "@/lib/capabilities/evaluate";
import { planEvidence } from "@/lib/execution/plan-evidence";
import { createOperationsPort } from "@/lib/execution/platform";
import { createExecutionBroker } from "@/lib/platform/broker";
import { registerEnvironment } from "@/lib/reconcile/platform";
import { mkNode } from "../providers/aws/drivers/compute/fixtures";
import { immutableSourceSnapshot, sourceRecipe, sourceSnapshotDigest, sourceSnapshotSetDigest } from "@/lib/execution/source-snapshot";

if (process.env.ZENITH_TEST_WORKFLOW_START_REQUIRED === "1" && !PG_URL) {
  throw new Error("Workflow start tenant acceptance requires an owned PostgreSQL database.");
}
if (process.env.ZENITH_TEST_APPROVED_SOURCE_REQUIRED === "1" && !PG_URL) {
  throw new Error("Approved source tenant acceptance requires an owned PostgreSQL database.");
}
closeSharedPgliteAfterAll();

/** These run in the real-PostgreSQL canonical-broker sweep below, never as PGlite authority. */
const BUILD_LAUNCH_SWEPT = new Set(["buildLaunches.claim", "buildLaunches.get", "buildLaunches.acknowledge", "buildLaunches.observeTerminal"]);
// Actual owning/foreign PostgreSQL controls are mandatory in mixed-child-admission.test.ts; PGlite is never mixed custody authority.
const MIXED_CHILD_SWEPT = new Set(["mixedChildIntents.get", "mixedChildIntents.reserve"]);
const WORKFLOW_START_SWEPT = new Set(["workflowStartIntents.get", "workflowStartIntents.prepare", "workflowStartIntents.claim", "workflowStartIntents.acknowledge"]);

/** These construct/check scoped capabilities, not unscoped tenant reads.
 * The returned methods' actual PostgreSQL foreign-scope/provenance refusals are
 * individually mandatory in their native owning suites.
 */
const CAPABILITY_CONSTRUCTORS: Record<string, string> = {
  "approvedSourceSnapshots.createApprovedSourceSnapshotStore": "actual owning PostgreSQL constructor; returned list/retain/assertCurrent/assertReviewed use native tenant/operation scope, not bindRepos argument injection",
  "approvedSourceSnapshots.isApprovedSourceSnapshotStore": "private runtime capability membership predicate; no SQL or tenant access and cannot mint captured archive provenance",
  "approvedSourceSnapshots.createIsolatedApprovedSourceStoreForTests": "test-only captured capability factory; creation and every method invocation require NODE_ENV=test before dependency access",
  "connections.captureVerification": "scoped read captures a one-use capability only from a genuine owning PostgreSQL handle, the exact tenant connection and current editor/admin member; owning success and foreign/revoked refusal are mandatory in kubernetes-connection-link.test.ts, not a structural PGlite sweep",
};

/** Functions exercised by the sweep (each named `namespace.function`). */
const SWEPT = new Set([
  ...BUILD_LAUNCH_SWEPT,
  ...WORKFLOW_START_SWEPT,
  ...MIXED_CHILD_SWEPT,
  "cleanupWriterBarriers.preview", "cleanupWriterBarriers.inventory",
  "approvals.consume", "approvals.listForOperation", "approvals.record", "approvals.requiredApprovalCount", "approvals.consumeApprovals",
  "connections.get", "connections.list", "connections.recordVerification", "connections.revoke",
  "cost.get", "cost.list",
  "actualSpend.listActualSpend",
  "drift.latest", "drift.list",
  "events.list",
  "evidence.get", "evidence.list",
  "grants.consume", "grants.get", "grants.isRevoked", "grants.revoke", "grants.revokeForOperation", "grants.status",
  "incidents.getIncident", "incidents.getInvestigation", "incidents.listIncidents", "incidents.listInvestigationsForIncident", "incidents.transitionIncident",
  "incidentStability.getStabilityIncident", "incidentStability.listRemediationAttempts", "incidentStability.listMaintenanceWindows", "incidentStability.getPostmortem", "incidentStability.listEscalations",
  "jobs.appendLogs", "jobs.cancel", "jobs.claimNext", "jobs.get", "jobs.listForOperation", "jobs.listLogs", "jobs.markRunning", "jobs.settle",
  "leases.listActive",
  "machines.getMachine", "machines.heartbeatMachine", "machines.listMachines", "machines.revokeMachine",
  "observations.getRuntime", "observations.latestObservation", "observations.latestObservationsByEnvironment", "observations.listRuntimeByEnvironment", "observations.observationHistory", "observations.pruneObservations",
  "operations.claimForExecution", "operations.get", "operations.heartbeat", "operations.list", "operations.transition",
  "operationExecution.suspendForApproval", "operationExecution.setPlanDigest", "operationExecution.setPolicyDecision", "operationExecution.deny",
  "policyDecisions.get", "policyDecisions.listForOperation",
  "planArtifacts.publish", "planArtifacts.read", "planArtifacts.associate", "planArtifacts.claim", "planArtifacts.dispatch", "planArtifacts.finish",
  // The owning claim persists a real native witness; its lookup and foreign-scope refusal run in both lane sweeps.
  "planArtifacts.requiresProductComposition",
  // Counts-only owning/foreign reads run in this sweep and in the mandatory native retention suite:
  // "never lets another workspace artifact or hold alter the selected workspace preview".
  "planArtifacts.previewRetention", "planArtifacts.readStandaloneSettlements",
  "resources.changeOwnership", "resources.get", "resources.getByAddress", "resources.listByEnvironment", "resources.setStatus",
  "runners.getRunner", "runners.heartbeat", "runners.listRunners", "runners.revokeRunner",
  "settings.getEnvironmentSettings", "settings.getWorkspacePolicy",
  // PROD-LIFE-12: tenant-scoped ownership-transfer reads/writes; recordForApprovedOperation is also reachable only via approvals.record.
  "ownershipTransfers.listActive", "ownershipTransfers.guardFor", "ownershipTransfers.revoke", "ownershipTransfers.recordForApprovedOperation",
  "ownershipTransfers.lockForOperation", "ownershipTransfers.lockForGrant",
  "optimizerSettings.getOptimizerSettings",
  "workspaceMfaControls.getWorkspaceMfaControls",
  // PROD-LIFE-11: tenant-scoped reads of verified exports, restores and ownership claims (writes are classified below).
  "portability.getExport", "portability.listExports", "portability.listRestores", "portability.getAdoption", "portability.listAdoptions", "portability.adoptionFacts",
  // PROD-LIFE-01 / PROD-UX-03: tenant-scoped reads (workspace_id in SQL; a foreign id equals a missing one). Writes are classified below.
  "connectionRotations.get", "connectionRotations.getOpen", "connectionRotations.list",
  "plugins.get", "plugins.list", "plugins.listGrants", "plugins.listEvents",
  // PROD-DUR-05/06: tenant-scoped reads of custody receipts and state recovery records.
  "planCustody.listReads", "stateBackendRecovery.provenOwner", "stateBackendRecovery.latestProbe", "stateBackendRecovery.get", "stateBackendRecovery.backendOf", "stateBackendRecovery.list",
  // PROD-UX-02: workspace_id AND principal digest in SQL; a foreign workspace, a foreign principal and an unknown stream are the same empty answer (real rows: tests/agent-v3/stream-store.test.ts).
  "mcpStreams.readStreamEvents", "mcpStreams.streamCancelRequested", "mcpStreams.streamStatus",
]);

/** Writes that bind the new row to the workspace they are given; their tenant checks are tested with the owning suite. */
const WRITES = new Set([
  // Opaque identity is issued only by genuine paired codec/default current proof.
  // Mandatory native cleanup suite proves owning commit, clone/foreign refusal, one JTI and post-wait authority.
  "cleanupWriterBarriers.retain",
  "cleanupWriterBarriers.reserveOwnerGrant",
  "cleanupWriterBarriers.insertOwnerGrant",
  "planArtifacts.retainCleanupWriterHold",
  "planArtifacts.reserveCleanupOwnerGrant",
  "planArtifacts.insertCleanupOwnerGrant",
  // bindRepos exposes this row API; only the genuine paired codec can supply
  // its private completion origin. Mandatory saved-builtin native cases prove
  // owning success and copied/foreign/status/seeded-ciphertext refusal.
  "planArtifacts.finishStandalone",
  "connections.create", "cost.insert", "drift.insert", "events.append", "evidence.insert", "grants.insert", "incidents.openIncident", "incidents.insertInvestigation",
  // Incident stability writes bind every row to the supplied workspace and resolve the incident inside it; a foreign incident id yields a fail-closed refusal (incident_inactive / not_found / null) and no row.
  // Owning and foreign controls: tests/controlplane/incident-stability.test.ts (settle, postmortem, investigation, windows).
  "incidentStability.observeSignal", "incidentStability.checkRemediation", "incidentStability.reserveRemediation", "incidentStability.settleAttempt", "incidentStability.escalateIncident", "incidentStability.evaluateIncidentEscalation", "incidentStability.recordInvestigation",
  "incidentStability.createMaintenanceWindow", "incidentStability.cancelMaintenanceWindow", "incidentStability.recordPostmortem", "incidentStability.bindAttemptToOperation", "incidentStability.syncAttemptOutcomes", "incidentStability.acknowledgeEscalation",
  // Exact private capture identity/owner and original tenant tuple settle only
  // after the connection lock wait and a fresh native editor/admin membership read.
  // Mandatory Kubernetes linking controls cover owning success, copied/wrong-owner
  // captures, config/link/status/microsecond drift and demotion/removal/foreign membership.
  "connections.recordCapturedVerification",
  // Signed outcome settlement has direct foreign-scope refusal and owning controls
  // in tests/runners/late-effect-receipts.test.ts on both agent domains.
  "jobs.settleOutcome", "jobs.enqueue", "machines.upsertTarget", "observations.appendObservation", "observations.upsertRuntime", "operations.create", "policyDecisions.insert",
  // Binds only the supplied workspace's running operation to its live worker fence.
  // Mandatory native controls in first-source-lease-binding.test.ts:
  // "refuses a foreign workspace at native binding and rolls back the newly acquired lease"
  // and "binds the first real worker lease before default source capture and native retain after a claim without a lease".
  "operations.bindExecutionLease",
  // The same 24 mandatory native cases cover acquire plus binding atomically,
  // including the exact first-worker success and foreign-workspace rollback above.
  "operations.acquireExecutionLease",
  // Native candidate capture binds only exact owning IDs; foreign retention leaves custody/approvals untouched.
  // Covered by the mandatory mixed-child admission native duplicate + foreign-workspace controls.
  "mixedChildIntents.retain",
  // PROD-LIFE-11: each binds the row and every lookup to the supplied workspace; foreign-workspace refusals, approval binding and append-only rules are covered by tests/portability/store.test.ts.
  "portability.recordExport", "portability.recordRestore", "portability.adopt", "portability.release",
  // PROD-LIFE-01: every statement binds the supplied workspace and resolves the connection inside it; foreign-id refusals are covered by tests/controlplane/rotations-repo.test.ts.
  "connectionRotations.stage", "connectionRotations.recordCandidateVerification", "connectionRotations.abort", "connectionRotations.promote",
  "connections.revokeAudited", "connections.appendLifecycleEvent",
  // PROD-DUR-05: every statement binds the supplied workspace; tenant, fence, tamper, revocation and expiry refusals are in tests/controlplane/plan-custody.test.ts.
  "planCustody.admit", "planCustody.verify", "planCustody.revokeWorker",
  // PROD-DUR-06: workspace-bound writes with guarded transitions; foreign-workspace, digest and state-machine refusals are in tests/controlplane/state-backend-recovery.test.ts.
  "stateBackendRecovery.recordProbe", "stateBackendRecovery.propose", "stateBackendRecovery.approve", "stateBackendRecovery.reject", "stateBackendRecovery.beginExecution",
  "stateBackendRecovery.complete", "stateBackendRecovery.failUncertain", "stateBackendRecovery.expireStale",
  // PROD-UX-03: workspace-bound plugin registry and grant writes; foreign-workspace refusals are covered by the plugin store tests.
  "plugins.register", "plugins.review", "plugins.revoke", "plugins.createGrant", "plugins.revokeGrant", "plugins.touchGrant",
  // PROD-DUR-07/08: external-effect ledger. Every statement binds the supplied workspace in SQL and a foreign effect id equals a missing one;
  // the foreign-workspace refusals for reads and writes are individually covered by tests/effects/ledger.test.ts (not the generic attempt sweep).
  "externalEffects.begin", "externalEffects.get", "externalEffects.getByDedup", "externalEffects.list", "externalEffects.listEvents", "externalEffects.listResolutions",
  "externalEffects.isFenceLive", "externalEffects.recordAccepted", "externalEffects.recordRejected", "externalEffects.markUncertain", "externalEffects.recordReadback", "externalEffects.resolve",
  // PROD-UX-02: every statement binds the supplied workspace and the authenticated principal digest; foreign-workspace and foreign-principal refusals are covered by tests/agent-v3/stream-store.test.ts.
  "mcpStreams.openStream", "mcpStreams.appendStreamEvent", "mcpStreams.requestStreamCancel", "mcpStreams.finishStream",
  // PROD-MACH-06: every statement binds the supplied workspace in SQL and a foreign run id equals a missing one; foreign-workspace refusals are covered by tests/coding-agent/store.test.ts.
  "codingAgentRuns.createRun", "codingAgentRuns.getRun", "codingAgentRuns.listRuns", "codingAgentRuns.saveRun", "codingAgentRuns.attachOutcome", "codingAgentRuns.claimResume", "codingAgentRuns.cancelRun", "codingAgentRuns.failRun",
  // PROD-MACH-02: workspace-keyed guest binding rows (no credential column); foreign-workspace refusals are covered by tests/controlplane/k8s-guest-bindings.test.ts.
  "k8sGuestBindings.ensure", "k8sGuestBindings.get", "k8sGuestBindings.listOpen", "k8sGuestBindings.listForConnection", "k8sGuestBindings.markActive", "k8sGuestBindings.recordIssuance", "k8sGuestBindings.recordError",
  "k8sGuestBindings.markConnectionRevoking", "k8sGuestBindings.markRevoked", "k8sGuestBindings.markRevoking",
  // PROD-OBS-01: workspace and environment bound in SQL (reads repairs of one environment and settles its own reserved attempts first); real SQL in tests/repair/lifecycle.platform.test.ts.
  "incidentStability.listRepairsAwaitingVerification",
  // PROD-MIX-01/02: every statement binds the supplied workspace in SQL (composite keys to platform.operations) and a foreign plan, child or operation id equals a missing one; real SQL in tests/controlplane/mixed-parent-plans.test.ts.
  "mixedParentPlans.getPlan", "mixedParentPlans.getPlanByParentOperation", "mixedParentPlans.listPlansForEnvironment", "mixedParentPlans.createPlan", "mixedParentPlans.getAddresses", "mixedParentPlans.listChildren",
  "mixedParentPlans.attachParentOperation", "mixedParentPlans.adoptChild", "mixedParentPlans.markChildStarted", "mixedParentPlans.recordExecutableSemantics", "mixedParentPlans.recordReceipt", "mixedParentPlans.getReceipt",
  "mixedParentPlans.listReceipts", "mixedParentPlans.blockChild", "mixedParentPlans.setParentStatus", "mixedParentPlans.readOperationFacts",
  // PROD-MIX-03/04 join (wave-4 assembly): run deadline and review lookups; each statement binds the supplied workspace, and a review approval counts only for the named parent run and a live human approval of its own proposal digest.
  "mixedParentPlans.readParentApprovalExpiry", "mixedParentPlans.findReviewOperation", "mixedParentPlans.readReviewApprovalDigest", "mixedParentPlans.findReviewApprovalId", "mixedParentPlans.findOpenReviewOperation",
  // PROD-MIX-03/04: run state, ledger and output preauthorizations are workspace-bound in SQL; foreign-workspace hiding is covered by tests/controlplane/mixed-runs.test.ts.
  // Managed serving owning/foreign SQL controls are in domain-store.test.ts and domain-routes.test.ts.
  "managedServing.claimDomain", "managedServing.getDomainForVerification", "managedServing.getDomain", "managedServing.listDomains", "managedServing.verifiedHostnames", "managedServing.applyDomainTransition", "managedServing.revokeDomain", "managedServing.recordStorageKey", "managedServing.activeStorageKey", "managedServing.listStorageKeys", "managedServing.markStorageKeyRevoked", "managedServing.retireStorageKey",
  "mixedOutputRecords.findChildByOperation", "mixedOutputRecords.findLatestChildOfOperationEnvironment",
  // Wave 5: workspace-qualified reads and immutable output writes, owning/foreign controls in mixed-follow-up.test.ts.
  "mixedOutputRecords.recordOutput", "mixedOutputRecords.getOutput", "mixedOutputRecords.listOutputs", "mixedOutputRecords.readProducerObservation",
  "mixedSignals.latestChildDriftReport", "mixedSignals.childMigrationClasses",
  "mixedRuns.get", "mixedRuns.create", "mixedRuns.save", "mixedRuns.listEvents",
  "mixedOutputPreauthorizations.create", "mixedOutputPreauthorizations.get", "mixedOutputPreauthorizations.list", "mixedOutputPreauthorizations.revoke", "mixedOutputPreauthorizations.reserveUse",
  "resources.upsertDesired", "runners.createRegistrationToken", "settings.putEnvironmentSettings", "settings.putWorkspacePolicy", "optimizerSettings.putOptimizerSettings",
  "workspaceMfaControls.putWorkspaceMfaControls",
  // PROD-COST-01: binds the row and the idempotency lookup to the supplied workspace; foreign-workspace listing and cross-tenant isolation are covered by tests/cost/actual-spend-store.test.ts and the sweep below.
  "actualSpend.insertActualSpend", "idempotency.reserve", "idempotency.complete",
]);

/** Deliberately not workspace-filtered, with the reason. */
const EXEMPT: Record<string, string> = {
  "managedServing.listDomainsDue": "system renewal under the managed-serving lease; returns workspace-qualified rows and all transitions rebind the row workspace (domain-store.test.ts)",
  "managedServing.listRevokePending": "system revocation under the managed-serving lease; returns workspace-qualified key rows and readback/settlement rebinds that workspace (domain-store.test.ts)",
  "planCustody.PlanCustodyError": "pure fixed error class; no SQL or tenant data and excluded from bindRepos",
  "stateBackendRecovery.StateRecoveryRecordError": "pure fixed error class; no SQL or tenant data and excluded from bindRepos",
  "stateBackendRecovery.restoreProposalDigest": "pure digest over a supplied proposal; reads no SQL and is excluded from bindRepos",
  "cleanupWriterBarriers.inventoryForNativeOrigin": "reads only through a private opaque native origin whose owning workspace, project and environment are bound by the genuine paired codec; no caller-supplied tenant, and excluded from bindRepos",
  "cleanupWriterBarriers.CleanupWriterBarrierError": "pure fixed error class; no tenant query or authority and excluded from bindRepos",
  "mixedChildIntents.MixedChildAdmissionError": "pure fixed-category error class, contains no SQL or tenant data; excluded from bindRepos",
  "buildLaunches.assertIsolatedBuildTestAdmission": "zero-argument NODE_ENV admission guard; reads no SQL or tenant data, cannot supply approval authority, and is excluded from bindRepos",
  "workflowStartIntents.WorkflowStartIntentError": "pure error class, contains no SQL or tenant data",
  "workflowStartIntents.snapshotWorkflowArguments": "pure own-scalar whitelist parser; returns detached frozen planning arguments, reads no SQL or authority, and is excluded from bindRepos",
  "workflowStartIntents.createIsolatedStartIntentStoreForTests": "NODE_ENV=test-only factory captures one actual broker dependency set; takes no SQL or tenant data itself, returns the same scoped SQL implementations, and is excluded from bindRepos",
  "buildLaunches.BuildLaunchError": "pure error class, contains no SQL or tenant data",
  "buildLaunches.createIsolatedBuildClaimerForTests": "NODE_ENV=test-only factory captures one actual isolated broker; returns the same scoped claim implementation, takes no tenant data or SQL itself, and is excluded from bindRepos",
  "planArtifacts.PlanArtifactError": "pure error class, contains no SQL or tenant data",
  "planArtifacts.captureArtifactAccess": "pure fixed custody and lease projection; reads no SQL or tenant data, grants no authority, and is excluded from bindRepos",
  "planArtifacts.expire": "system logical-expiry maintenance; workspace taken from database candidates, never from tenant input",
  "planArtifacts.releaseDrainedHolds": "system hold-release sweep (schema 61); workspace, project and environment come from database candidates, never tenant input, and each release is written under the workspace coordinator",
  "leases.acquire": "keyed by a globally unique scope string; a workspace-tagged scope refuses a foreign workspace (tested in leases.test.ts)",
  "leases.renew": "keyed by scope + holder + fence",
  "leases.release": "keyed by scope + holder + fence",
  "leases.current": "keyed by scope",
  "leases.assertFence": "keyed by scope + fence",
  "nonces.remember": "keyed by agent id (globally unique); never read by tenants",
  "nonces.prune": "system maintenance",
  "idempotency.prune": "system maintenance",
  "operations.markUncertainExpired": "system reconciler; every returned record carries its workspace",
  "operations.expireOverdue": "system reconciler",
  "operations.getForSystem": "trusted worker lookup by id only; tests/execution/ledger-approval.test.ts uses the returned workspace for all later calls",
  "jobs.expireStale": "system reaper",
  "operations.toOperation": "pure row mapper",
  "runners.generateRegistrationToken": "pure helper",
  "runners.hashRegistrationToken": "pure helper",
  "runners.consumeRegistrationToken": "keyed by the token hash; the workspace comes FROM the token",
  "runners.registerRunner": "the workspace comes from the registration token, never from the caller",
  "machines.registerMachine": "the workspace comes from the registration token, never from the caller",
  "runners.findRunnerForAuth": "the one documented unscoped lookup: a signed request names only the agent id",
  "machines.findMachineForAuth": "the one documented unscoped lookup: a signed request names only the machine id",
  "plugins.resolveGrantByTokenHash": "authentication lookup keyed by a 256-bit token hash; the workspace comes FROM the grant row and the caller binds it for every later call, never from caller input",
  "plugins.diagnoseTokenHash": "audit-only diagnosis keyed by a 256-bit token hash; returns a fixed vocabulary word and no tenant data",
  "plugins.hasGrantTokenHash": "authentication discriminator keyed by a 256-bit token hash; returns only existence, never tenant data, before authenticating the audience-bound grant (launch-integration.test.ts)",
  "scheduledJobs.beginRun": "system scheduler health row keyed by a fixed job name and lease fence; holds counts only, no tenant data",
  "scheduledJobs.finishRun": "system scheduler health row keyed by job name and lease fence; a stale holder cannot finish",
  "scheduledJobs.recordSkip": "system scheduler health row keyed by job name; counts only",
  "scheduledJobs.getScheduledJob": "system scheduler health read by job name; no tenant rows",
  "scheduledJobs.listScheduledJobs": "system scheduler health read; no tenant rows",
  "externalEffects.sweepStalePending": "system maintenance under the housekeeping lease: declares pending effects whose dispatcher vanished uncertain (never retried); every returned row carries its workspace and nothing is read from tenant input",
  "mixedRuns.listDue": "system housekeeping sweep: returns workspace-qualified run keys only (never content); each run is then ticked under its own workspace and the runs of other tenants are untouched (tests/controlplane/mixed-runs.test.ts)",
  "optimizerSettings.listOptedInEnvironments": "system scheduler only: lists (workspace, environment) pairs that opted in; every returned row carries its workspace and each is processed under that workspace",
};

const hex = (c: string): string => c.repeat(64);

describe("completeness guard", () => {
  it("every repository function is classified: swept, a workspace-bound write, or exempt with a reason", () => {
    const unclassified: string[] = [];
    for (const [ns, mod] of Object.entries(repos)) {
      if (typeof mod !== "object" || mod === null || ns === "bindRepos") continue;
      for (const [name, value] of Object.entries(mod)) {
        if (typeof value !== "function") continue;
        const key = `${ns}.${name}`;
        if (!SWEPT.has(key) && !WRITES.has(key) && !(key in EXEMPT) && !(key in CAPABILITY_CONSTRUCTORS)) unclassified.push(key);
      }
    }
    expect(unclassified, `classify these in tests/controlplane/tenancy.test.ts`).toEqual([]);
  });

  it("nothing is classified twice, and every classified name still exists", () => {
    const all = new Set<string>();
    for (const [ns, mod] of Object.entries(repos)) {
      if (typeof mod !== "object" || mod === null) continue;
      for (const [name, value] of Object.entries(mod)) if (typeof value === "function") all.add(`${ns}.${name}`);
    }
    for (const key of [...SWEPT, ...WRITES, ...Object.keys(EXEMPT), ...Object.keys(CAPABILITY_CONSTRUCTORS)]) expect(all.has(key), `${key} exists`).toBe(true);
    const overlap = [...SWEPT].filter((k) => WRITES.has(k) || k in EXEMPT || k in CAPABILITY_CONSTRUCTORS);
    expect(overlap).toEqual([]);
    for (const key of Object.keys(CAPABILITY_CONSTRUCTORS)) expect(WRITES.has(key) || key in EXEMPT).toBe(false);
  });

  it("bindRepos exposes every repository function except the pure helpers, with sql pre-applied", async () => {
    const stub = { query: async () => [], tx: async <T>(fn: (s: never) => Promise<T>) => fn(undefined as never) };
    const bound = bindRepos(stub as never);
    expect(Object.keys(bound.operations)).toEqual(expect.arrayContaining(["create", "get", "list", "transition", "claimForExecution"]));
    expect(Object.keys(bound.operations)).not.toContain("toOperation");
    expect(Object.keys(bound.runners)).not.toContain("generateRegistrationToken");
    expect(Object.keys(bound.planArtifacts)).not.toContain("PlanArtifactError");
    expect(Object.keys(bound.planArtifacts)).not.toContain("captureArtifactAccess");
    expect(Object.keys(bound.connections)).toEqual(expect.arrayContaining(["captureVerification", "recordCapturedVerification"]));
    expect(Object.keys(bound.buildLaunches)).toEqual(expect.arrayContaining(["claim", "get", "acknowledge", "observeTerminal"]));
    expect(Object.keys(bound.buildLaunches)).not.toContain("BuildLaunchError");
    expect(Object.keys(bound.buildLaunches)).not.toContain("createIsolatedBuildClaimerForTests");
    expect(Object.keys(bound.buildLaunches)).not.toContain("assertIsolatedBuildTestAdmission");
    expect(new Set(Object.keys(bound.workflowStartIntents))).toEqual(new Set(
      [...WORKFLOW_START_SWEPT].map(key => key.split(".")[1]),
    ));
    for (const helper of ["WorkflowStartIntentError", "snapshotWorkflowArguments", "createIsolatedStartIntentStoreForTests"]) {
      expect(Object.keys(bound.workflowStartIntents)).not.toContain(helper);
    }
    expect(Object.keys(bound.cleanupWriterBarriers)).toEqual(["preview"]);
    for(const name of ["retainCleanupWriterHold","reserveCleanupOwnerGrant","insertCleanupOwnerGrant"])expect(Object.keys(bound.planArtifacts)).not.toContain(name);
    expect(Object.keys(bound.approvedSourceSnapshots)).toEqual([]);
    expect(Object.keys(repos.approvedSourceSnapshots).sort()).toEqual(Object.keys(CAPABILITY_CONSTRUCTORS).filter(key => key.startsWith("approvedSourceSnapshots.")).map(key => key.split(".")[1]).sort());
    expect(await bound.events.list("ws_x")).toEqual([]);
  });
});

/** Turn "not found in your workspace" refusals into an empty result for the sweep. */
async function seen<T>(promise: Promise<T>): Promise<unknown> {
  try {
    return await promise;
  } catch (err) {
    if (err instanceof ControlStoreError && ["operation_not_found", "not_found", "tenant_mismatch"].includes(err.code)) return null;
    if (err instanceof repos.planArtifacts.PlanArtifactError) return null;
    throw err;
  }
}

function isEmpty(value: unknown): boolean {
  if (value === null || value === undefined || value === false || value === 0 || value === "unknown") return true;
  if (Array.isArray(value)) return value.length === 0;
  if (typeof value === "object") {
    const o = value as Record<string, unknown>;
    if ("items" in o) return Array.isArray(o.items) && o.items.length === 0;
    if (o.isDefault === true) return true;
    if ("revoked" in o) return false;
  }
  return false;
}

describe.each(LANES)("tenant isolation sweep [$name]", (lane) => {
  let ctx: Awaited<ReturnType<typeof openLane>>;
  beforeAll(async () => {
    ctx = await openLane(lane);
  }, 60_000);
  afterAll(async () => {
    await ctx.close();
  });

  it("workspace B can neither see nor change anything of workspace A", async () => {
    const db = ctx.db;
    // ------------------------------ seed workspace A ------------------------------
    const seeded = await seedAwaitingApproval(db);
    const A = seeded.workspaceId;
    const B = newWorkspace();
    const decided = await approve(db, seeded, user("approver"));
    const strict = await seedAwaitingApproval(db, { workspaceId: A, count: 3 }); // A's decision that demands three approvers
    const opId = seeded.operation.id;
    const active = await seedApprovedOperation(db, A);
    await repos.operations.claimForExecution(db, { workspaceId: A, id: active.operation.id, expectedDigest: active.operation.proposalDigest, holder: "worker" });
    const activeDecision = await repos.policyDecisions.insert(db, { workspaceId: A, operationId: active.operation.id, outcome: "require_approval", policyVersion: "v", inputDigest: hex("a"), reasons: [] });
    const denyDecision = await repos.policyDecisions.insert(db, { workspaceId: A, operationId: opId, outcome: "deny", policyVersion: "v", inputDigest: hex("a"), reasons: [] });
    const envId = seeded.operation.environmentId as string;
    const now = Date.now();

    const jti = uid("jti");
    await repos.grants.insert(db, { jti, workspaceId: A, operationId: opId, capability: "infrastructure.apply", audience: "worker", issuedAt: new Date(now).toISOString(), expiresAt: new Date(now + 60_000).toISOString() });
    await repos.events.append(db, { type: "operation.approved", workspaceId: A, operationId: opId, correlationId: "corr_a" });
    const evidence = await repos.evidence.insert(db, { workspaceId: A, operationId: opId, kind: "tofu_plan", digest: hex("c"), summary: {}, simulated: false });
    await repos.settings.putEnvironmentSettings(db, { workspaceId: A, environmentId: envId, autonomyLevel: 4, updatedBy: "u" });
    await repos.settings.putWorkspacePolicy(db, { workspaceId: A, params: { k: 1 }, updatedBy: "u" });
    await repos.optimizerSettings.putOptimizerSettings(db, { workspaceId: A, environmentId: envId, enabled: true, updatedBy: "u" });
    await repos.workspaceMfaControls.putWorkspaceMfaControls(db, { workspaceId: A, requireForAllMutations: true, maxAgeSeconds: 300, expectedVersion: 0, actor: user("u"), correlationId: uid("mfa") });
    const connection = await repos.connections.create(db, {
      workspaceId: A,
      createdBy: "u",
      config: { provider: "aws", mode: "oidc_web_identity", accountId: "123456789012", observeRoleArn: "arn:aws:iam::123456789012:role/o", deployRoleArn: "arn:aws:iam::123456789012:role/d", region: "ap-south-1" },
    });
    const node: ResourceNode = { address: "service/web", kind: "container_service", provider: "aws", region: "ap-south-1", nativeType: "aws:ecs_service", ownership: "managed", spec: {}, origin: [], dependsOn: [], specDigest: hex("a"), labels: {} };
    const resource = await repos.resources.upsertDesired(db, { workspaceId: A, environmentId: envId, node });
    await repos.observations.appendObservation(db, { workspaceId: A, resourceId: resource.id, observation: { address: "service/web", presence: "present", attributes: {}, observedAt: new Date().toISOString(), source: "test", simulated: false } });
    await repos.observations.upsertRuntime(db, { workspaceId: A, resourceId: resource.id, runtime: { address: "service/web", health: "healthy", counts: {}, signals: [], observedAt: new Date().toISOString(), source: "test", simulated: false } });
    await repos.drift.insert(db, { workspaceId: A, report: { environmentId: envId, graphDigest: hex("d"), computedAt: new Date().toISOString(), findings: [], unobserved: [], simulated: false } });
    const { tokenHash } = repos.runners.generateRegistrationToken("runner");
    await repos.runners.createRegistrationToken(db, { workspaceId: A, kind: "runner", createdBy: "u", tokenHash });
    const runner = await repos.runners.registerRunner(db, { tokenHash, name: "r", publicKey: "A".repeat(43) });
    const job = await repos.jobs.enqueue(db, { id: uid("job"), workspaceId: A, runnerId: runner.id, operationId: opId, kind: "tofu.run", capability: "infrastructure.apply", envelope: "a.b.c" });
    await repos.jobs.appendLogs(db, { workspaceId: A, runnerId: runner.id, jobId: job.id, batchSeq: 1, lines: [{ ts: new Date().toISOString(), stream: "stdout", line: "hello" }] });
    const machine = await repos.machines.upsertTarget(db, { workspaceId: A, environmentId: envId, name: "web-1", transport: "aws_ssm", targetId: "i-0abc" });
    const incident = await repos.incidents.openIncident(db, { workspaceId: A, environmentId: envId, title: "t", severity: "low", source: "user" });
    await repos.incidents.insertInvestigation(db, { id: uid("inv"), incidentId: incident.id, workspaceId: A, environmentId: envId, startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(), path: [], evidence: [], hypotheses: [], recentChanges: [], simulated: false });
    const cost = await repos.cost.insert(db, { workspaceId: A, environmentId: envId, estimate: { kind: "estimate", catalogVersion: "v1", currency: "USD", monthlyUsd: 10, lines: [], assumptions: {}, included: [], excluded: [], computedAt: new Date().toISOString() } });
    await repos.actualSpend.insertActualSpend(db, { workspaceId: A, environmentId: envId, recordedBy: "u", snapshot: { kind: "actual_spend", provider: "aws", scope: "123456789012", periodStart: "2026-10-01", periodEnd: "2026-11-01", currency: "USD", totalUsd: 1, lines: [], costBasis: "test", finalization: "provisional", source: { adapter: "test", endpoint: "https://example.invalid/", retrievedAt: "2026-10-11T00:00:00.000Z", responseSha256: hex("c") }, notice: "test" } });
    const decision = await repos.policyDecisions.listForOperation(db, A, opId);
    const investigations = await repos.incidents.listInvestigationsForIncident(db, A, incident.id);
    await repos.leases.acquire(db, { scope: `env:${envId}`, holder: "w", ttlMs: 60_000, workspaceId: A });
    expect(decision.length).toBeGreaterThan(0);
    expect(investigations).toHaveLength(1);

    // Synthetic ciphertext exercises SQL tenancy only; no engine authenticity or durable runtime claim.
    const artifactSource=await seedApprovedOperation(db,A,{proposal:{capability:"infrastructure.plan",scope:{workspaceId:A,projectId:"proj_1",environmentId:envId},input:{environmentId:envId,teardownReview:true}}});
    await repos.operations.claimForExecution(db,{workspaceId:A,id:artifactSource.operation.id,expectedDigest:artifactSource.operation.proposalDigest,holder:executionHolder(artifactSource.operation.id)});
    const artifactLease=await repos.leases.current(db,`env:${envId}`);
    if(!artifactLease)throw new Error("Tenant artifact fixture lease is unavailable.");
    const source=artifactSource.operation,artifactDigest=hex("d");
    const manifest:PlanArtifactManifest={workspaceId:A,operationId:source.id,projectId:"proj_1",environmentId:envId,proposalDigest:source.proposalDigest,inputDigest:source.inputDigest,expiresAt:source.expiresAt,
      sourceDigest:hex("a"),graphDigest:hex("b"),format:"zenith.plan-artifact.v1",purpose:"destroy",configDigest:hex("c"),lockDigest:hex("e"),backendDigest:hex("f"),addressMapDigest:hex("a"),planDigest:artifactDigest,
      rawSha256:hex("b"),bytes:1,executable:{version:"synthetic",platform:"synthetic",sha256:hex("c"),archiveSha256:null}};
    const artifactEvidenceId=uid("evd_artifact");
    const artifactInput:repos.planArtifacts.PublishArtifact={manifest,sealed:{iv:"A".repeat(16),authTag:"A".repeat(24),ciphertext:"synthetic-tenant-fixture"},lease:artifactLease,evidence:{id:artifactEvidenceId,workspaceId:A,operationId:source.id,kind:"tofu_plan",digest:artifactDigest,summary:{planDigest:artifactDigest},simulated:false}};
    await repos.planArtifacts.publish(db,artifactInput);
    const destroyProposal:BrokerProposal={
      ...proposalFor(A,{capability:"infrastructure.destroy",scope:{workspaceId:A,projectId:"proj_1",environmentId:envId},input:{environmentId:envId},planDigest:artifactDigest}),
      broker:{v:1,risk:"medium",destroyPlan:{operationId:source.id,evidenceId:artifactEvidenceId,retained:[]}},
    };
    const destination=await seedAwaitingApproval(db,{workspaceId:A,proposal:destroyProposal});
    const associationInput={workspaceId:A,sourceOperationId:source.id,destinationOperationId:destination.operation.id,sourceEvidenceId:artifactEvidenceId,planDigest:artifactDigest,lease:artifactLease};
    await repos.planArtifacts.associate(db,associationInput);
    const artifactAccess={custody:manifest,planDigest:artifactDigest,lease:artifactLease};
    const artifactBefore=await repos.planArtifacts.read(db,artifactAccess);
    const associationsBefore=await db.query("select * from platform.plan_artifact_associations where workspace_id=$1",[A]);
    let usesBefore=await db.query("select * from platform.plan_artifact_uses where workspace_id=$1 order by operation_id",[A]);
    const foreignAccess={...artifactAccess,custody:{...manifest,workspaceId:B}};
    let sourceEvidenceBefore=await repos.evidence.list(db,A,{operationId:source.id});
    expect(sourceEvidenceBefore.map(row=>row.id)).toEqual([artifactEvidenceId]);
    let claimedArtifact:repos.planArtifacts.ArtifactRow|undefined;

    // ------------------------ workspace B tries everything -------------------------
    const dig = seeded.operation.proposalDigest;
    // Real retained rows produce an owning counts-only read; a foreign workspace
    // and foreign hold below cannot expose their rows or mutate original custody.
    const retentionCutoff = new Date().toISOString();
    expect((await repos.planArtifacts.previewRetention(db, {
      workspaceId: A, createdBefore: retentionCutoff, holdOperationIds: [], limit: 1000,
    })).scanned).toBeGreaterThan(0);

    const cleanupBefore=await db.query("select * from platform.cleanup_writer_deliveries where workspace_id=$1 order by family,identity",[A]);
    expect((await repos.cleanupWriterBarriers.preview(db,A,"proj_1",envId)).grants).toBeGreaterThan(0);
    expect((await repos.cleanupWriterBarriers.inventory(db,A,"proj_1",envId)).handoffs).toBeGreaterThan(0);
    const foreignCleanupRead=async(read:typeof repos.cleanupWriterBarriers.preview)=>{
      const value=await read(db,B,"proj_1",envId);
      expect(value.grants).toBe(0);expect(value.handoffs).toBe(0);expect(value.reservations).toBe(0);
      // Unknown scope is a fixed conservative count, never owning-row disclosure or clearance.
      expect(value.unknownHistory).toBe(1);return null;
    };
    const attempts: Record<string, () => Promise<unknown>> = {
      "cleanupWriterBarriers.preview":()=>foreignCleanupRead(repos.cleanupWriterBarriers.preview),
      "cleanupWriterBarriers.inventory":()=>foreignCleanupRead(repos.cleanupWriterBarriers.inventory),
      "planArtifacts.publish": () => seen(repos.planArtifacts.publish(db,{...artifactInput,manifest:{...manifest,workspaceId:B},evidence:{...artifactInput.evidence,workspaceId:B}})),
      "planArtifacts.read": () => seen(repos.planArtifacts.read(db,foreignAccess)),
      "planArtifacts.associate": () => seen(repos.planArtifacts.associate(db,{...associationInput,workspaceId:B})),
      "planArtifacts.claim": () => seen(repos.planArtifacts.claim(db,foreignAccess,"foreign-attempt")),
      "planArtifacts.dispatch": async () => {
        claimedArtifact=await repos.planArtifacts.claim(db,artifactAccess,"tenant-owner-attempt");
        usesBefore=await db.query("select * from platform.plan_artifact_uses where workspace_id=$1 order by operation_id",[A]);
        // This deliberate owning claim adds the canonical immutable observation.
        // Verify its exact native identity/anchors, then retain both full rows as the foreign-call baseline.
        sourceEvidenceBefore=await repos.evidence.list(db,A,{operationId:source.id});
        const witnessId=`evd_pp_${digest([A,source.id,source.id,"tenant-owner-attempt"])}`;
        expect(sourceEvidenceBefore.map(row=>row.id).sort()).toEqual([artifactEvidenceId,witnessId].sort());
        const witness=sourceEvidenceBefore.find(row=>row.id===witnessId);
        if(!witness)throw new Error("The owning native claim witness is unavailable.");
        expect(witness).toMatchObject({workspaceId:A,operationId:source.id,kind:"observation",simulated:false});
        expect(witness.digest).toBe(digest(witness.summary));
        expect(witness.summary).toMatchObject({kind:"native-absence",phase:"claimed",workspaceId:A,projectId:manifest.projectId,
          environmentId:envId,sourceOperationId:source.id,destinationOperationId:source.id,attemptId:"tenant-owner-attempt",
          manifestDigest:artifactBefore.manifest_digest,planDigest:artifactDigest});
        return seen(repos.planArtifacts.dispatch(db,foreignAccess,"tenant-owner-attempt"));
      },
      "planArtifacts.previewRetention": async () => {
        const preview = await repos.planArtifacts.previewRetention(db, {
          workspaceId: B, createdBefore: retentionCutoff, holdOperationIds: [source.id], limit: 1000,
        });
        expect(preview).toEqual({ mode: "dry-run", scanned: 0, hasMore: false,
          held: 0, active: 0, unresolved: 0, unavailable: 0, withinRetention: 0, archiveReview: 0 });
        return preview.scanned;
      },
      "planArtifacts.requiresProductComposition": async () => {
        if(!claimedArtifact)throw new Error("The genuine owning claim is unavailable.");
        expect(await repos.planArtifacts.requiresProductComposition(db,claimedArtifact,source.id,"tenant-owner-attempt")).toBe(false);
        const foreignRow={...claimedArtifact,workspace_id:B,manifest:{...claimedArtifact.manifest,workspaceId:B}};
        await expect(repos.planArtifacts.requiresProductComposition(db,foreignRow,source.id,"tenant-owner-attempt"))
          .rejects.toBeInstanceOf(repos.planArtifacts.PlanArtifactError);
        return null;
      },
      "planArtifacts.readStandaloneSettlements": () => repos.planArtifacts.readStandaloneSettlements(db,{...manifest,workspaceId:B},manifest.backendDigest),
      "planArtifacts.finish": () => repos.planArtifacts.finish(db,foreignAccess,"tenant-owner-attempt",false),
      "operationExecution.suspendForApproval": () => repos.operationExecution.suspendForApproval(db, { workspaceId: B, id: active.operation.id }),
      "operationExecution.setPlanDigest": () => repos.operationExecution.setPlanDigest(db, { workspaceId: B, id: opId, planDigest: hex("d") }),
      "operationExecution.setPolicyDecision": () => repos.operationExecution.setPolicyDecision(db, { workspaceId: B, id: active.operation.id, decisionId: activeDecision.id }),
      "operationExecution.deny": () => repos.operationExecution.deny(db, { workspaceId: B, id: opId, decisionId: denyDecision.id }),
      "approvals.consume": () => repos.approvals.consume(db, { workspaceId: B, operationId: opId, proposalDigest: dig }),
      "approvals.consumeApprovals": () => repos.approvals.consumeApprovals(db, { workspaceId: B, operationId: opId, proposalDigest: dig }),
      "approvals.listForOperation": () => repos.approvals.listForOperation(db, B, opId),
      "approvals.record": () => seen(repos.approvals.record(db, { workspaceId: B, operationId: opId, approver: user(), approverRole: "admin", decision: "reject", proposalDigest: dig, policyVersion: "v" })),
      // B must not learn A's policy decision (3 approvers): it gets the default 1
      "approvals.requiredApprovalCount": async () => ((await repos.approvals.requiredApprovalCount(db, B, strict.decision.id)) === 1 ? null : "leaked"),
      "connections.get": () => repos.connections.get(db, B, connection.id),
      "connections.list": () => repos.connections.list(db, B, { includeRevoked: true }),
      "connections.recordVerification": () => repos.connections.recordVerification(db, { workspaceId: B, id: connection.id, ok: true }),
      "connections.revoke": () => repos.connections.revoke(db, B, connection.id),
      "cost.get": () => repos.cost.get(db, B, cost.id),
      "cost.list": () => repos.cost.list(db, B, { environmentId: envId }),
      "actualSpend.listActualSpend": () => repos.actualSpend.listActualSpend(db, B, { environmentId: envId }),
      "drift.latest": () => repos.drift.latest(db, B, envId),
      "drift.list": () => repos.drift.list(db, B, envId),
      "events.list": () => repos.events.list(db, B, { operationId: opId }),
      "evidence.get": () => repos.evidence.get(db, B, evidence.id),
      "evidence.list": () => repos.evidence.list(db, B, { operationId: opId }),
      "grants.consume": () => repos.grants.consume(db, { workspaceId: B, jti }),
      "grants.get": () => repos.grants.get(db, B, jti),
      "grants.isRevoked": () => repos.grants.isRevoked(db, B, jti),
      "grants.revoke": () => repos.grants.revoke(db, B, jti),
      "grants.revokeForOperation": () => repos.grants.revokeForOperation(db, B, opId),
      "grants.status": () => repos.grants.status(db, B, jti),
      "incidents.getIncident": () => repos.incidents.getIncident(db, B, incident.id),
      "incidents.getInvestigation": () => repos.incidents.getInvestigation(db, B, investigations[0].id),
      "incidents.listIncidents": () => repos.incidents.listIncidents(db, B),
      "incidents.listInvestigationsForIncident": () => repos.incidents.listInvestigationsForIncident(db, B, incident.id),
      "incidents.transitionIncident": () => repos.incidents.transitionIncident(db, { workspaceId: B, id: incident.id, from: ["open"], to: "resolved" }),
      "incidentStability.getStabilityIncident": () => repos.incidentStability.getStabilityIncident(db, B, incident.id),
      "incidentStability.listRemediationAttempts": () => repos.incidentStability.listRemediationAttempts(db, B, incident.id),
      "incidentStability.listMaintenanceWindows": () => repos.incidentStability.listMaintenanceWindows(db, B),
      "incidentStability.getPostmortem": () => repos.incidentStability.getPostmortem(db, B, incident.id),
      "incidentStability.listEscalations": () => repos.incidentStability.listEscalations(db, B),
      "jobs.appendLogs": () => repos.jobs.appendLogs(db, { workspaceId: B, runnerId: runner.id, jobId: job.id, batchSeq: 2, lines: [{ ts: new Date().toISOString(), stream: "stdout", line: "x" }] }),
      "jobs.cancel": () => repos.jobs.cancel(db, B, job.id),
      "jobs.claimNext": () => repos.jobs.claimNext(db, { workspaceId: B, runnerId: runner.id }),
      "jobs.get": () => repos.jobs.get(db, B, job.id),
      "jobs.listForOperation": () => repos.jobs.listForOperation(db, B, opId),
      "jobs.listLogs": () => repos.jobs.listLogs(db, { workspaceId: B, jobId: job.id }),
      "jobs.markRunning": () => repos.jobs.markRunning(db, { workspaceId: B, runnerId: runner.id, jobId: job.id, leaseMs: 60_000 }),
      "jobs.settle": () => repos.jobs.settle(db, { workspaceId: B, runnerId: runner.id, jobId: job.id, status: "succeeded" }),
      "leases.listActive": () => repos.leases.listActive(db, B),
      "machines.getMachine": () => repos.machines.getMachine(db, B, machine.id),
      "machines.heartbeatMachine": () => repos.machines.heartbeatMachine(db, { workspaceId: B, id: machine.id }),
      "machines.listMachines": () => repos.machines.listMachines(db, B, { environmentId: envId }),
      "machines.revokeMachine": () => repos.machines.revokeMachine(db, B, machine.id),
      "observations.getRuntime": () => repos.observations.getRuntime(db, B, resource.id),
      "observations.latestObservation": () => repos.observations.latestObservation(db, B, resource.id),
      "observations.latestObservationsByEnvironment": () => repos.observations.latestObservationsByEnvironment(db, B, envId),
      "observations.listRuntimeByEnvironment": () => repos.observations.listRuntimeByEnvironment(db, B, envId),
      "observations.observationHistory": () => repos.observations.observationHistory(db, B, resource.id),
      "observations.pruneObservations": () => repos.observations.pruneObservations(db, { workspaceId: B, keepPerResource: 1 }),
      "operations.claimForExecution": () => seen(repos.operations.claimForExecution(db, { workspaceId: B, id: opId, expectedDigest: dig, holder: "w" })),
      "operations.get": () => repos.operations.get(db, B, opId),
      "operations.heartbeat": () => repos.operations.heartbeat(db, { workspaceId: B, id: opId, holder: "w" }),
      "operations.list": () => repos.operations.list(db, B, { environmentId: envId }),
      "operations.transition": () => repos.operations.transition(db, { workspaceId: B, id: opId, from: ["approved"], to: "cancelled" }),
      "policyDecisions.get": () => repos.policyDecisions.get(db, B, decision[0].id),
      "policyDecisions.listForOperation": () => repos.policyDecisions.listForOperation(db, B, opId),
      "resources.changeOwnership": () => repos.resources.changeOwnership(db, { workspaceId: B, id: resource.id, from: "managed", to: "external" }),
      "resources.get": () => repos.resources.get(db, B, resource.id),
      "resources.getByAddress": () => repos.resources.getByAddress(db, B, envId, "service/web"),
      "resources.listByEnvironment": () => repos.resources.listByEnvironment(db, B, envId, { includeDeleted: true }),
      "resources.setStatus": () => repos.resources.setStatus(db, B, resource.id, "deleted"),
      "runners.getRunner": () => repos.runners.getRunner(db, B, runner.id),
      "runners.heartbeat": () => repos.runners.heartbeat(db, { workspaceId: B, id: runner.id }),
      "runners.listRunners": () => repos.runners.listRunners(db, B),
      "runners.revokeRunner": () => repos.runners.revokeRunner(db, B, runner.id),
      "ownershipTransfers.listActive": () => repos.ownershipTransfers.listActive(db, B, envId),
      "ownershipTransfers.guardFor": () => repos.ownershipTransfers.guardFor(db, B, envId, resource.id),
      "ownershipTransfers.revoke": () => repos.ownershipTransfers.revoke(db, { workspaceId: B, transferDigest: hex("a"), operationId: opId, revokedBy: "b" }),
      "ownershipTransfers.recordForApprovedOperation": () => seen(repos.ownershipTransfers.recordForApprovedOperation(db, { workspaceId: B, operationId: opId, approvalId: "apr_foreign" })),
      "ownershipTransfers.lockForOperation": async () => {
        await expect(repos.ownershipTransfers.lockForOperation(db, B, opId)).rejects.toMatchObject({ code: "operation_not_found" });
        return null;
      },
      "ownershipTransfers.lockForGrant": async () => {
        await expect(repos.ownershipTransfers.lockForGrant(db, B, opId)).rejects.toMatchObject({ code: "operation_not_found" });
        return null;
      },
      "portability.getExport": () => repos.portability.getExport(db, B, "pex_foreign"),
      "portability.listExports": () => repos.portability.listExports(db, B, envId),
      "portability.listRestores": () => repos.portability.listRestores(db, B, envId),
      "portability.getAdoption": () => repos.portability.getAdoption(db, B, "ado_foreign"),
      "portability.listAdoptions": () => repos.portability.listAdoptions(db, B, envId),
      "portability.adoptionFacts": () => repos.portability.adoptionFacts(db, B, envId),
      "connectionRotations.get": () => repos.connectionRotations.get(db, B, "crot_foreign"),
      "connectionRotations.getOpen": () => repos.connectionRotations.getOpen(db, B, connection.id),
      "connectionRotations.list": () => repos.connectionRotations.list(db, B, connection.id),
      "plugins.get": () => repos.plugins.get(db, B, "plg_foreign"),
      "plugins.list": () => repos.plugins.list(db, B),
      "plugins.listGrants": () => repos.plugins.listGrants(db, B),
      "plugins.listEvents": () => repos.plugins.listEvents(db, B, "plg_foreign"),
      "planCustody.listReads": () => repos.planCustody.listReads(db, B, opId, 10),
      "stateBackendRecovery.provenOwner": () => repos.stateBackendRecovery.provenOwner(db, B, envId, hex("a")),
      "stateBackendRecovery.latestProbe": () => repos.stateBackendRecovery.latestProbe(db, B, envId, hex("a")),
      "stateBackendRecovery.get": () => repos.stateBackendRecovery.get(db, B, "sbr_foreign"),
      "stateBackendRecovery.backendOf": () => repos.stateBackendRecovery.backendOf(db, B, "sbr_foreign"),
      "stateBackendRecovery.list": () => repos.stateBackendRecovery.list(db, B, envId),
      "mcpStreams.readStreamEvents": () => repos.mcpStreams.readStreamEvents(db, { workspaceId: B, principalKey: hex("a"), streamId: "f".repeat(32), afterSeq: 0 }),
      "mcpStreams.streamCancelRequested": () => repos.mcpStreams.streamCancelRequested(db, { workspaceId: B, streamId: "f".repeat(32) }),
      "mcpStreams.streamStatus": () => repos.mcpStreams.streamStatus(db, { workspaceId: B, principalKey: hex("a"), streamId: "f".repeat(32) }),
      "settings.getEnvironmentSettings": () => repos.settings.getEnvironmentSettings(db, B, envId),
      "settings.getWorkspacePolicy": () => repos.settings.getWorkspacePolicy(db, B),
      "optimizerSettings.getOptimizerSettings": () => repos.optimizerSettings.getOptimizerSettings(db, B, envId),
      "workspaceMfaControls.getWorkspaceMfaControls": () => repos.workspaceMfaControls.getWorkspaceMfaControls(db, B),
    };
    // Build launches and workflow starts use actual broker/PG positive controls
    // in their separate sweeps below; all remaining functions run in both lanes.
    expect(new Set(Object.keys(attempts))).toEqual(new Set([...SWEPT].filter(
      key => !BUILD_LAUNCH_SWEPT.has(key) && !WORKFLOW_START_SWEPT.has(key) && !MIXED_CHILD_SWEPT.has(key),
    )));

    for (const [name, attempt] of Object.entries(attempts)) {
      const result = await attempt();
      expect(isEmpty(result), `${name} leaked or acted across tenants: ${JSON.stringify(result)?.slice(0, 200)}`).toBe(true);
      expect(await repos.evidence.list(db,A,{operationId:source.id}), `${name} preserved the exact owning plan and claim witness`).toEqual(sourceEvidenceBefore);
    }

    expect(await db.query("select * from platform.cleanup_writer_deliveries where workspace_id=$1 order by family,identity",[A])).toEqual(cleanupBefore);
    expect(await db.query("select * from platform.cleanup_writer_holds where workspace_id=$1",[B])).toEqual([]);
    // ------------------------ and A's data is exactly as it was -------------------------
    expect(await repos.planArtifacts.read(db,artifactAccess)).toEqual(artifactBefore);
    expect(await db.query("select * from platform.plan_artifact_associations where workspace_id=$1",[A])).toEqual(associationsBefore);
    expect(await db.query("select * from platform.plan_artifact_uses where workspace_id=$1 order by operation_id",[A])).toEqual(usesBefore);
    for(const table of ["plan_artifacts","plan_artifact_associations","plan_artifact_uses","evidence"])
      expect(await db.query(`select operation_id from platform.${table} where workspace_id=$1`,[B])).toHaveLength(0);
    expect((await repos.operations.get(db,A,source.id))?.planDigest).toBe(artifactDigest);
    expect((await repos.operations.get(db,A,destination.operation.id))?.status).toBe("awaiting_approval");
    expect(await repos.approvals.listForOperation(db,A,destination.operation.id)).toHaveLength(0);
    expect(await repos.evidence.list(db,A,{operationId:source.id})).toEqual(sourceEvidenceBefore);
    expect((await repos.operations.get(db, A, opId))?.status).toBe("approved");
    expect((await repos.operations.get(db, A, opId))?.planDigest).toBeUndefined();
    expect((await repos.operations.get(db, A, active.operation.id))?.status).toBe("running");
    expect((await repos.operations.get(db, A, active.operation.id))?.policyDecisionId).toBeUndefined();
    expect(await repos.approvals.listForOperation(db, A, opId)).toHaveLength(1);
    expect((await repos.approvals.listForOperation(db, A, opId))[0].consumedAt).toBeUndefined();
    expect(decided.approval.id).toBeDefined();
    expect(await repos.grants.status(db, A, jti)).toBe("active");
    expect((await repos.connections.get(db, A, connection.id))?.status).toBe("pending_verification");
    expect((await repos.resources.get(db, A, resource.id))?.ownership).toBe("managed");
    expect((await repos.resources.get(db, A, resource.id))?.status).toBe("planned");
    expect((await repos.runners.getRunner(db, A, runner.id))?.status).toBe("active");
    expect((await repos.jobs.get(db, A, job.id))?.status).toBe("queued");
    expect(await repos.jobs.listLogs(db, { workspaceId: A, jobId: job.id })).toHaveLength(1);
    expect((await repos.machines.getMachine(db, A, machine.id))?.status).toBe("active");
    expect((await repos.incidents.getIncident(db, A, incident.id))?.status).toBe("open");
    expect((await repos.settings.getEnvironmentSettings(db, A, envId)).autonomyLevel).toBe(4);
    expect((await repos.optimizerSettings.getOptimizerSettings(db, A, envId)).enabled).toBe(true);
    expect(await repos.workspaceMfaControls.getWorkspaceMfaControls(db, A)).toMatchObject({ requireForAllMutations: true, maxAgeSeconds: 300, version: 1 });
    expect(await repos.observations.latestObservation(db, A, resource.id)).not.toBeNull();
    expect(await repos.leases.listActive(db, A)).toHaveLength(1);
  });
});

describe.skipIf(!PG_URL)("build launch tenant isolation sweep [postgres]",()=>{
  let ctx: Awaited<ReturnType<typeof openLane>>;
  beforeAll(async()=>{ctx=await openLane(LANES.find(l=>l.name==="postgres")!);},60000);
  afterAll(async()=>{await ctx?.close();});

  it("sweeps claim/get/acknowledge/observeTerminal with current owning authority and preserves A exactly",async()=>{
    const db=ctx.db, h=await makeHarness({kind:"postgres",engine:scriptedEngine("tenant-build-policy",()=>requireApproval(1,"admin",true))});
    const A=h.ids.wsA,B=newWorkspace(),environmentId=h.ids.envAProd,accountId="123456789012",region="eu-west-1";
    h.deps.clock={now:()=>new Date()};
    h.world.environments.get(environmentId)!.region=region;
    const {operation:op}=await h.broker.propose({capability:"deployment.deploy",scope:{workspaceId:A,projectId:h.ids.projA,environmentId},input:{}},user("alice"));
    const decide=(planDigest?:string)=>h.broker.approve({workspaceId:A,operationId:op.id,proposalDigest:op.proposalDigest,planDigest,approver:user("erin"),session:sessionFor("erin")});
    await decide();
    await h.broker.beginExecution({workspaceId:A,operationId:op.id,holder:`workflow:${op.id}`,audience:"worker"});
    const ports=createOperationsPort(db),worker=createExecutionBroker(db,async()=>h.broker);
    const pipeline=mkNode("build_pipeline/web","build_pipeline","aws:codebuild_project",{source:{repo:"https://github.com/acme/web",ref:"revision"}},{region,specDigest:digest("tenant-pipeline")});
    const service=mkNode("container_service/web","container_service","aws:ecs_service",{artifact:{type:"built",pipeline:pipeline.address}},{region,specDigest:digest("tenant-service")});
    for(const node of [pipeline,service])await repos.resources.upsertDesired(db,{workspaceId:A,projectId:h.ids.projA,environmentId,node,status:"active"});
    const sourceDigest=digest("tenant-source");
    // Modeled archive metadata; this sweep proves owning SQL/broker tenancy,
    // not archive acquisition, native capture provenance or provider execution.
    const source=immutableSourceSnapshot({format:"zenith.approved-source.v1",workspaceId:A,operationId:op.id,projectId:h.ids.projA,environmentId,
      serviceAddress:service.address,serviceSpecDigest:service.specDigest,pipelineAddress:pipeline.address,pipelineSpecDigest:pipeline.specDigest,provider:"aws",region,
      owner:"acme",repo:"web",repositoryId:99,requestedRef:"revision",commitSha:"a".repeat(40),githubBinding:null,dockerfile:"Dockerfile",
      dockerfileDigest:digest("modeled Dockerfile bytes"),recipeDigest:sourceRecipe(service,pipeline),archiveFormat:"zip",archiveDigest:sourceDigest,archiveBytes:100});
    await db.query("insert into platform.approved_source_snapshots(workspace_id,operation_id,project_id,environment_id,service_address,snapshot,snapshot_digest) values ($1,$2,$3,$4,$5,$6::text::jsonb,$7)",
      [A,op.id,h.ids.projA,environmentId,service.address,JSON.stringify(source),sourceSnapshotDigest(source)]);
    const plan=makePlan({changes:[change({address:"aws_codebuild_project.web",type:"aws_codebuild_project",action:"create"})]});
    plan.executableSourceDigest=sourceSnapshotSetDigest([source]);
    plan.planDigest=digest({configDigest:plan.configDigest,lockDigest:plan.lockDigest,tofuVersion:plan.tofuVersion,resourceChanges:plan.resourceChanges,outputChanges:plan.outputChanges,executableSourceDigest:plan.executableSourceDigest});
    const facts=buildPlanFacts(plan)!;
    await repos.evidence.insert(db,{workspaceId:A,operationId:op.id,kind:"tofu_plan",digest:plan.planDigest,summary:planEvidence({plan,facts,cost:{},graphDigest:digest("tenant-graph"),stage:"plan",approvedSources:[source]}).summary,simulated:false});
    await ports.setPlanDigest({workspaceId:A,operationId:op.id,planDigest:plan.planDigest});
    const policy=await worker.reevaluate(op.id,facts);
    await ports.setPolicyDecision({workspaceId:A,operationId:op.id,decisionId:policy.decisionId});
    await ports.transition({workspaceId:A,operationId:op.id,to:"awaiting_approval"});
    await decide(plan.planDigest);
    const lease=await repos.leases.acquire(db,{workspaceId:A,scope:`env:${environmentId}`,holder:`worker:${op.id}`,ttlMs:60000});
    if(!lease)throw new Error("Tenant build fixture lease unavailable.");
    await repos.operations.claimForExecution(db,{workspaceId:A,id:op.id,expectedDigest:op.proposalDigest,holder:`workflow:${op.id}`,leaseMs:60000,lease,expectedPolicyVersion:"tenant-build-policy"});
    // Synthetic completed-plan use is fixture provenance, not provider/apply acceptance.
    await db.query("insert into platform.plan_artifact_uses(workspace_id,operation_id,phase) values ($1,$2,'succeeded')",[A,op.id]);
    const connection=await repos.connections.create(db,{workspaceId:A,createdBy:"tenant-fixture-admin",config:{provider:"aws",mode:"oidc_web_identity",accountId,region,observeRoleArn:`arn:aws:iam::${accountId}:role/observe`,deployRoleArn:`arn:aws:iam::${accountId}:role/deploy`}});
    await repos.connections.recordVerification(db,{workspaceId:A,id:connection.id,ok:true});
    await registerEnvironment(db,{environment:{workspaceId:A,environmentId,provider:"aws",region,class:"development",connection:{id:connection.id,status:"verified"}}});
    const buildId="zenith-build-web:11111111-2222-3333-4444-555555555555";
    const binding:repos.buildLaunches.BuildLaunchBinding={workspaceId:A,operationId:op.id,environmentId,serviceAddress:service.address,serviceSpecDigest:service.specDigest,pipelineAddress:pipeline.address,pipelineSpecDigest:pipeline.specDigest,
      accountId,region,projectName:"zenith-build-web",projectArn:`arn:aws:codebuild:${region}:${accountId}:project/zenith-build-web`,sourceBucket:"zenith-source-fixture",sourceKey:`zenith/${environmentId}/web/${sourceDigest}.zip`,sourceDigest,settingsDigest:digest("tenant-settings"),executedSettingsDigest:digest("tenant-executed-settings")};
    const fence={scope:lease.scope,token:lease.fenceToken},claim=repos.buildLaunches.createIsolatedBuildClaimerForTests(h.broker);
    const first=await claim(db,binding,fence);
    expect(first).toMatchObject({claimed:true,launch:{workspace_id:A,phase:"dispatched",build_id:null}});
    let current=first.launch;
    const foreignBinding={...binding,workspaceId:B};
    const foreignLaunch=():repos.buildLaunches.BuildLaunch=>({...current,workspace_id:B,binding:foreignBinding,binding_digest:digest(foreignBinding)});
    const receiptRows=()=>db.query("select * from platform.build_launches where workspace_id=$1 and operation_id=$2 order by service_address",[A,op.id]);
    const authorityRows=async()=>({
      operation:await db.query("select * from platform.operations where workspace_id=$1 and id=$2",[A,op.id]),
      approvals:await db.query("select * from platform.approvals where workspace_id=$1 and operation_id=$2 order by id",[A,op.id]),
      lease:await db.query("select * from platform.leases where scope=$1",[fence.scope]),
      resources:await db.query("select * from platform.resources where workspace_id=$1 and environment_id=$2 order by address",[A,environmentId]),
      connection:await db.query("select * from platform.provider_connections where workspace_id=$1 and id=$2",[A,connection.id]),
      planUse:await db.query("select * from platform.plan_artifact_uses where workspace_id=$1 and operation_id=$2",[A,op.id]),
      source:await db.query("select * from platform.approved_source_snapshots where workspace_id=$1 and operation_id=$2 order by service_address",[A,op.id]),
      evidence:await db.query("select * from platform.evidence where workspace_id=$1 and operation_id=$2 order by id",[A,op.id]),
      github:await db.query("select * from platform.github_source_bindings where workspace_id=$1 order by owner,repo",[A]),
    });
    const authorityBefore=await authorityRows();
    const attempts:Record<string,()=>Promise<void>>={
      "buildLaunches.claim":async()=>{await expect(claim(ctx.db2,foreignBinding,fence)).rejects.toBeInstanceOf(repos.buildLaunches.BuildLaunchError);},
      "buildLaunches.acknowledge":async()=>{await expect(repos.buildLaunches.acknowledge(ctx.db2,foreignLaunch(),buildId,["tenant-accepted-request"])).rejects.toBeInstanceOf(repos.buildLaunches.BuildLaunchError);},
      "buildLaunches.get":async()=>{expect(await repos.buildLaunches.get(ctx.db2,B,op.id,buildId)).toBeNull();},
      "buildLaunches.observeTerminal":async()=>{await expect(repos.buildLaunches.observeTerminal(ctx.db2,foreignLaunch(),{status:"STOPPED",finishedAt,requestId:"tenant-terminal-read"})).rejects.toBeInstanceOf(repos.buildLaunches.BuildLaunchError);},
    };
    expect(new Set(Object.keys(attempts))).toEqual(BUILD_LAUNCH_SWEPT);
    const foreignAttempt=async(name:string)=>{
      const before=await receiptRows();
      await attempts[name]();
      expect(await receiptRows(),`${name} preserved A's immutable receipt`).toEqual(before);
      expect(await authorityRows(),`${name} preserved A's authority`).toEqual(authorityBefore);
      expect(await db.query("select * from platform.build_launches where workspace_id=$1",[B])).toHaveLength(0);
    };
    await foreignAttempt("buildLaunches.claim");
    await foreignAttempt("buildLaunches.acknowledge");
    current=await repos.buildLaunches.acknowledge(db,first.launch,buildId,["tenant-accepted-request"]);
    expect(current.phase).toBe("accepted");
    expect(await repos.buildLaunches.get(db,A,op.id,buildId)).toEqual(current);
    await foreignAttempt("buildLaunches.get");
    await db.query("select pg_sleep(0.002)");
    const [provider]=await db.query<{finished_at:string;within_receipt_window:boolean}>(`select date_trunc('milliseconds',clock_timestamp())::text as finished_at,
      date_trunc('milliseconds',clock_timestamp())>=created_at as within_receipt_window
      from platform.build_launches where workspace_id=$1 and operation_id=$2 and phase='accepted'`,[A,op.id]);
    expect(provider.within_receipt_window).toBe(true);
    const finishedAt=new Date(provider.finished_at);
    await foreignAttempt("buildLaunches.observeTerminal");
    const terminal=await repos.buildLaunches.observeTerminal(db,current,{status:"STOPPED",finishedAt,requestId:"tenant-terminal-read"});
    expect(terminal).toMatchObject({phase:"terminal",terminal_status:"STOPPED"});
    expect(await authorityRows()).toEqual(authorityBefore);
  },15000);
});

/**
 * Actual independent PostgreSQL handles and canonical Broker/signing/evaluation.
 * Product scope, membership and browser-session ports are isolated fixture data.
 * The acknowledgement below models a SQL evidence sink, not Temporal transport,
 * authenticated history, namespace permissions or cloud acceptance.
 */
describe.skipIf(!PG_URL)("workflow start tenant isolation sweep [postgres]", () => {
  let ctx: Awaited<ReturnType<typeof openLane>>;
  beforeAll(async () => {
    ctx = await openLane(LANES.find(lane => lane.name === "postgres")!);
  }, 60_000);
  afterAll(async () => { await ctx?.close(); });

  it("sweeps get/prepare/claim/acknowledge with owning approval and fence while preserving A's immutable attempt and authority", async () => {
    const { db, db2 } = ctx;
    expect(db2).not.toBe(db);
    const [ownBackend] = await db.query<{ pid: number }>("select pg_backend_pid() as pid");
    const [foreignBackend] = await db2.query<{ pid: number }>("select pg_backend_pid() as pid");
    expect(ownBackend.pid).not.toBe(foreignBackend.pid);
    const h = await makeHarness({ kind: "postgres", engine: scriptedEngine("tenant-start-policy", () => requireApproval(1, "admin", true)) });
    h.deps.clock = { now: () => new Date() };
    const A = h.ids.wsA, B = h.ids.wsB, environmentId = h.ids.envAProd;
    const op = await proposeOk(h, requestFor(h, "service.restart", "prod"), user("bob"));
    await approveAs(h, op.operation, "erin");
    const fence = await h.acquireLease(environmentId);
    await h.broker.beginExecution({ workspaceId: A, operationId: op.id, holder: `workflow:${op.id}`,
      audience: "worker", leaseMs: 60_000, lease: fence });
    // This captures the actual isolated canonical broker once. Its alternate
    // pool/store is discarded; each repository transaction rebinds its SQL store.
    const store = repos.workflowStartIntents.createIsolatedStartIntentStoreForTests(h.broker);
    const request: repos.workflowStartIntents.StartRequest = {
      kind: "dayTwo", arguments: { workspaceId: A, operationId: op.id, environmentId, capability: "service.restart" },
      namespace: "default", endpointDigest: digest("tenant-owned-frontend"), taskQueue: "tenant-start-contract",
    };
    const foreignRequest: repos.workflowStartIntents.StartRequest = {
      ...request, arguments: { ...request.arguments, workspaceId: B },
    };
    const rows = () => db.query("select * from platform.workflow_start_intents where workspace_id=$1 and operation_id=$2", [A, op.id]);
    const authority = async () => ({
      operation: await db.query("select * from platform.operations where workspace_id=$1 and id=$2", [A, op.id]),
      approvals: await db.query("select * from platform.approvals where workspace_id=$1 and operation_id=$2 order by id", [A, op.id]),
      fence: await db.query("select * from platform.leases where workspace_id=$1 and scope=$2", [A, fence.scope]),
      decisions: await db.query("select * from platform.policy_decisions where workspace_id=$1 and operation_id=$2 order by id", [A, op.id]),
      grants: await db.query("select * from platform.capability_grants where workspace_id=$1 and operation_id=$2 order by jti", [A, op.id]),
    });
    const [live] = await db.query<{ operation: boolean; fence: boolean; approvals: number }>(`select
      o.status='running' and o.expires_at>clock_timestamp() and o.lease_until>clock_timestamp() as operation,
      l.expires_at>clock_timestamp() and l.released_at is null and l.fence_token=o.fence_token as fence,
      (select count(*)::integer from platform.approvals a where a.workspace_id=o.workspace_id and a.operation_id=o.id
        and a.approval_round=o.approval_round and a.proposal_digest=o.proposal_digest and a.decision='approve'
        and a.approver->>'kind'='user' and a.approver_id='erin' and a.consumed_at is not null
        and a.expires_at>clock_timestamp()) as approvals
      from platform.operations o join platform.leases l on l.scope=o.lease_scope and l.workspace_id=o.workspace_id
      where o.workspace_id=$1 and o.id=$2`, [A, op.id]);
    expect(live).toEqual({ operation: true, fence: true, approvals: 1 });
    const authorityBefore = await authority();
    const prepared = await store.prepare(db, request);
    expect(prepared).toMatchObject({ workspace_id: A, operation_id: op.id, phase: "prepared", attempt_id: null, run_id: null });
    expect(await repos.workflowStartIntents.get(db2, A, op.id)).toEqual(prepared);
    expect(await authority()).toEqual(authorityBefore);

    let current = prepared;
    // A foreign acknowledgement supplies a self-consistent forged tenant binding,
    // rather than relying on an unrelated malformed-input failure.
    const foreignIntent = (): repos.workflowStartIntents.WorkflowStartIntent => {
      const argumentsDigest = digest(foreignRequest.arguments);
      const binding = { ...current.binding, arguments: foreignRequest.arguments, argumentsDigest,
        sourceDigest: digest({ proposalDigest: current.binding.proposalDigest, inputDigest: current.binding.inputDigest, argumentsDigest }) };
      return { ...current, workspace_id: B, binding, binding_digest: digest(binding) };
    };
    const attempts: Record<string, () => Promise<void>> = {
      "workflowStartIntents.get": async () => { expect(await repos.workflowStartIntents.get(db2, B, op.id)).toBeNull(); },
      "workflowStartIntents.prepare": async () => { await expect(store.prepare(db2, foreignRequest)).rejects.toBeInstanceOf(repos.workflowStartIntents.WorkflowStartIntentError); },
      "workflowStartIntents.claim": async () => { await expect(store.claim(db2, foreignRequest)).rejects.toBeInstanceOf(repos.workflowStartIntents.WorkflowStartIntentError); },
      "workflowStartIntents.acknowledge": async () => { await expect(repos.workflowStartIntents.acknowledge(db2, foreignIntent(), observed)).rejects.toBeInstanceOf(repos.workflowStartIntents.WorkflowStartIntentError); },
    };
    expect(new Set(Object.keys(attempts))).toEqual(WORKFLOW_START_SWEPT);
    const foreignAttempt = async (name: string) => {
      const before = await rows();
      await attempts[name]();
      expect(await rows(), `${name} preserved A's immutable ${current.phase} row`).toEqual(before);
      expect(await authority(), `${name} preserved A's operation, consumed approvals and live fence`).toEqual(authorityBefore);
      expect(await db.query("select * from platform.workflow_start_intents where workspace_id=$1", [B])).toHaveLength(0);
    };
    // Prepared acknowledgement would fail before looking up the tenant because
    // it has no attempt. Exercise this method only with a valid retained attempt.
    for (const name of [...WORKFLOW_START_SWEPT].filter(key => key !== "workflowStartIntents.acknowledge")) await foreignAttempt(name);
    const claimed = await store.claim(db, request);
    expect(claimed.dispatch).toBe(true);
    expect(claimed.intent).toMatchObject({ phase: "attempted", run_id: null, binding_digest: prepared.binding_digest });
    expect(claimed.intent.attempt_id).toMatch(/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/);
    current = claimed.intent;
    // Valid UUID/time/digest deliberately model reader output only. No actual
    // engine request, history result or another transport Start is constructed.
    const [databaseClock] = await db.query<{ started_at: string }>("select clock_timestamp()::text as started_at");
    const observed: repos.workflowStartIntents.StartReadback = {
      runId: randomUUID(), startedAt: new Date(databaseClock.started_at).toISOString(), evidenceDigest: digest("modeled owning SQL readback"),
    };
    expect(await authority()).toEqual(authorityBefore);
    for (const name of WORKFLOW_START_SWEPT) await foreignAttempt(name);
    const repeated = await store.claim(db2, request);
    expect(repeated).toEqual({ dispatch: false, intent: current });
    expect(await rows()).toHaveLength(1);
    expect(await authority()).toEqual(authorityBefore);
    current = await repos.workflowStartIntents.acknowledge(db, current, observed);
    expect(current).toMatchObject({ phase: "acknowledged", run_id: observed.runId, attempt_id: claimed.intent.attempt_id,
      binding_digest: prepared.binding_digest, evidence_digest: observed.evidenceDigest });
    expect(await repos.workflowStartIntents.get(db2, A, op.id)).toEqual(current);
    for (const name of WORKFLOW_START_SWEPT) await foreignAttempt(name);
    expect(await store.claim(db2, request)).toEqual({ dispatch: false, intent: current });
    expect(await repos.workflowStartIntents.acknowledge(db2, current, observed)).toEqual(current);
    expect(await rows()).toHaveLength(1);
    expect(await authority()).toEqual(authorityBefore);
  }, 20_000);
});
