/** Exact additive successor identities used ONLY for historical test projections. */
export const wave5PlatformIds = new Set([
  "platform-postgres:tests/controlplane/mixed-follow-up.test.ts:4ffb771187f9",
  "platform-postgres:tests/slo/slo.engine.test.ts:b91cf3d98b2b",
  "platform-postgres:tests/billing/billing.engine.test.ts:9a5544b04d11",
]);
export const mixedRunStorePlatformIds = new Set([
  "platform-postgres:tests/execution/mixed-run-store.test.ts:1ddbcdaf45c3",
  "platform-postgres:tests/execution/mixed-run-store.test.ts:7fdd1696d09e",
  "platform-postgres:tests/execution/mixed-run-store.test.ts:c8f88d9bf71d",
  "platform-postgres:tests/execution/mixed-run-store.test.ts:cf422a33bfa8",
  "platform-postgres:tests/execution/mixed-run-store.test.ts:e35daa2ea56a",
]);
// J13 adds one discovered native suite; only its exact ID leaves predecessor projections.
export const integrationPlatformIds = new Set([
  "platform-postgres:tests/controlplane/ownership-serialization.test.ts:3564a64396e1",
]);
// PROD-DUR-07 moves the destroy-apply group onto the real-PostgreSQL lane; only its exact ID leaves predecessor projections.
// PROD-LIFE-12 adds the revoked-grant broker case to the vault-target cohort; also excluded from predecessors.
// TEARDOWN WP5 adds the schema 61 hold-lifecycle cases (and renames the discarded-hold case); also excluded from predecessors.
// TEARDOWN WP2 adds the schema 62 delivery-settlement cases; also excluded from predecessors.
export const destroyApplyLaneIds = new Set(["platform-postgres:tests/effects/cleanup.test.ts:f5c03b3613d3", "platform-postgres:tests/platform/kubernetes-vault-target.test.ts:ae52cf35e61f", "platform-postgres:tests/controlplane/cleanup-writer-barriers.test.ts:da4c8cee68e1", "platform-postgres:tests/controlplane/cleanup-writer-barriers.test.ts:b8cf0ebdec0a", "platform-postgres:tests/controlplane/cleanup-writer-barriers.test.ts:0a7ac7065d6f", "platform-postgres:tests/controlplane/cleanup-writer-barriers.test.ts:5c37dcc9b7bf", "platform-postgres:tests/controlplane/cleanup-writer-barriers.test.ts:1aab2f9ff7af", "platform-postgres:tests/controlplane/cleanup-writer-barriers.test.ts:c3572304b3c0", "platform-postgres:tests/controlplane/cleanup-writer-barriers.test.ts:dafcdbed5310", "platform-postgres:tests/controlplane/cleanup-writer-barriers.test.ts:782689cc0496", "platform-postgres:tests/controlplane/cleanup-writer-barriers.test.ts:a5f2df45ef4e", "platform-postgres:tests/controlplane/cleanup-writer-barriers.test.ts:0c5bce0bc670", "platform-postgres:tests/controlplane/cleanup-writer-barriers.test.ts:bd065b763481", "platform-postgres:tests/controlplane/cleanup-writer-barriers.test.ts:b3546d57d9e0", "platform-postgres:tests/controlplane/cleanup-writer-barriers.test.ts:c7206da536b1", "platform-postgres:tests/controlplane/cleanup-writer-barriers.test.ts:9cafa1c03f1f", "platform-postgres:tests/controlplane/cleanup-writer-barriers.test.ts:d117e6d0c14d", "platform-postgres:tests/controlplane/cleanup-writer-barriers.test.ts:411c0cb49f99"]);
export const incomingPlatformIds = new Set(
["platform-postgres:tests/controlplane/durable-intent-authority.test.ts:932f3808dde1", "platform-postgres:tests/controlplane/executable-semantics.test.ts:e9879ff0d6eb", "platform-postgres:tests/controlplane/k8s-guest-bindings.test.ts:69e0124d07dc", "platform-postgres:tests/controlplane/mixed-parent-plans.test.ts:a2c1d654d201", "platform-postgres:tests/controlplane/mixed-runs.test.ts:e483ae1e82c7", "platform-postgres:tests/controlplane/plan-custody.test.ts:35394b79986e", "platform-postgres:tests/controlplane/state-backend-recovery.test.ts:7d391123fdde", "platform-postgres:tests/capabilities/standing-grants.test.ts:8e0139c01528", "platform-postgres:tests/effects/build-launch.test.ts:66558e46614c", "platform-postgres:tests/effects/cleanup.test.ts:56d57a2f04e0", "platform-postgres:tests/effects/ledger.test.ts:5b8ae9d0841b", "platform-postgres:tests/effects/provider-resolvers.test.ts:ae6277c04b4b", "platform-postgres:tests/effects/proxy.test.ts:71ecab8d34b4", "platform-postgres:tests/effects/resolvers.test.ts:514f933542c5", "platform-postgres:tests/repair/lifecycle.platform.test.ts:8c02d63e3cde", "platform-postgres:tests/coding-agent/store.test.ts:a2b7923f32dd", "platform-postgres:tests/controlplane/mcp-stream-tenant-index.test.ts:2754979ea1cc", ...mixedRunStorePlatformIds, ...integrationPlatformIds]
);
export const incomingWorkflowFiles = new Set(
["tests/platform/plan-custody-crypto.test.ts", "tests/platform/semantics-approval.test.ts", "tests/platform/state-session.test.ts", "tests/workflows/coding-agent.test.ts", "tests/workflows/mixed-parent.test.ts", "tests/workflows/start-recovery.test.ts", "tests/workflows/upgrade-rehearsal.test.ts", "tests/workflows/versioning-audit.test.ts"]
);
export function withoutIncomingPlatform<T extends { id: string }>(items: T[]): T[] {
  return items.filter(item => !incomingPlatformIds.has(item.id) && !wave5PlatformIds.has(item.id) && !destroyApplyLaneIds.has(item.id));
}

// The full codec successor is mandatory now; only historical cohort projections
// remove this exact known addition. Unknown future identities remain visible.
export const historyCodecWorkflowId = "workflows:tests/workflows/history-fixtures.test.ts:4ee93ed6c454";
export const wave5WorkflowIds = new Set(
  ["tests/platform/recovery-service.test.ts", "tests/platform/zenith-build.test.ts", "tests/platform/zenith-managed-composition.test.ts", "tests/platform/managed-reconcile.test.ts", "tests/platform/zenith-onboarding.test.ts"].map(file => `workflows:${file}:4ee93ed6c454`),
);
export const incomingWorkflowIds = new Set([
  ...[...incomingWorkflowFiles].map(file => `workflows:${file}:4ee93ed6c454`),
  historyCodecWorkflowId,
  ...wave5WorkflowIds,
]);

// J4 and J14 add these exact mandatory workflow contracts. Historical projections
// remove only these reviewed identities; the executable lane still requires both.
export const integrationWorkflowIds = new Set([
  "workflows:tests/platform/billing-schedule.test.ts:4ee93ed6c454",
  "workflows:tests/platform/zenith-isolation-custody.test.ts:4ee93ed6c454",
]);
