/** Read-only review wrapper. Policy, lease, evidence and proposal belong to the worker activity. */
import { proxyActivities } from "@temporalio/workflow";
import { NON_RETRYABLE_TYPES } from "./policies";

interface ReviewActivities {
  reviewTeardown(input: { workspaceId: string; operationId: string }): Promise<{ operationId: string; planDigest: string; replayed: boolean }>;
}
const activities = proxyActivities<ReviewActivities>({
  startToCloseTimeout: "30m", scheduleToCloseTimeout: "35m", heartbeatTimeout: "60s",
  // Read-only planning retries like planInfrastructure: an attempt lost with a restarted worker would otherwise leave the
  // review queued until its 15-minute TTL expires it. A retry after the attempt claimed the review refuses (invalid_state).
  retry: { initialInterval: "5s", backoffCoefficient: 2, maximumInterval: "1m", maximumAttempts: 3, nonRetryableErrorTypes: NON_RETRYABLE_TYPES },
});

export async function teardownReviewWorkflow(input: { workspaceId: string; operationId: string }) {
  return activities.reviewTeardown({ workspaceId: input.workspaceId, operationId: input.operationId });
}
