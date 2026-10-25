import { requireScope, ScopeError, type Scope } from "../../release/scope";
import type { EnvLike } from "../config";
import type { Plan } from "./contracts";

/** Root approval and the exact awsLive envelope are both required. Keep the
 * strict root manifest in its own FILE; adding fields must not change its digest.
 * Teardown-only recovery may use the original approval after it lapses (LIVE-ACCEPTANCE.md); creation never may. */
export function requireProductionScope(plan: Plan, budgetUsd: number, env: EnvLike, cleanupOnly = false, now?: () => Date): Scope {
  const teardown = { allowExpiredForTeardown: cleanupOnly };
  const scope = requireScope("aws-live", "aws", env, now, teardown);
  // Recovery is bound to the sandbox too: an approved root never admits another account or region.
  const sandbox = scope.sandbox("aws") as { accountId: string; regions: string[] };
  if (plan.settings.accountId !== sandbox.accountId || !sandbox.regions.includes(plan.settings.region)) {
    throw new ScopeError("sandbox_unconfirmed", "The AWS plan account or region is not the owner-confirmed sandbox.");
  }
  scope.assertGrant("aws-live", "aws", "teardown_run_tagged", teardown);
  if (cleanupOnly) {
    scope.authorize({ harness: "aws-live", provider: "aws", action: "teardown_run_tagged", runId: plan.settings.runId, tags: plan.tags }, undefined, teardown);
    return scope;
  }
  scope.assertGrant("aws-live", "aws", "mutate_run_tagged");
  const cap = Math.min(scope.manifest.budgets.perRunUsd, scope.manifest.budgets.perProviderPerRunUsd.aws ?? 0,
    scope.manifest.budgets.totalUsd, scope.manifest.harnesses["aws-live"].maxRunUsd);
  if (!Number.isFinite(budgetUsd) || budgetUsd <= 0 || budgetUsd > cap) {
    throw new ScopeError("budget_exceeded", "The explicit AWS budget exceeds the approved root scope ceiling.");
  }
  scope.authorize({ harness: "aws-live", provider: "aws", action: "create_disposable", estimatedUsd: plan.estimate.usd,
    runId: plan.settings.runId, resourceName: `zenith-${plan.settings.runId}-fixtures`, ttlMinutes: plan.settings.durationMinutes });
  return scope;
}
