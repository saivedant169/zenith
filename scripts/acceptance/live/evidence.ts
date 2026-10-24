import { redactAcceptance } from "../redact";
import type { Journal } from "./contracts";
import { digest, scopedRequirementIds } from "./plan";

/** Ledger-shaped entries are emitted only for complete product checks from real
 * execution. Fixtures and pending/unperformed requirements stay separate.
 * Verdict: failed on any failure or open journal; passed when every requirement in
 * the run's declared scope passed; otherwise incomplete. Out-of-scope rows are pending. */
export function evidencePacket(journal: Journal, finishedAt = new Date()) {
  const counts = { passed: 0, failed: 0, pending: 0 };
  for (const c of journal.checks) counts[c.status]++;
  const scope = new Set(scopedRequirementIds(journal.plan.settings, journal.plan.requirements.map(r => r.id)));
  const requirements = journal.plan.requirements.map(r => {
    if (!scope.has(r.id)) return { id: r.id, requiredLevel: "live_sandbox", status: "pending" as const, reason: "outside this run's scope", evidence: [] };
    const check = journal.checks.find(c => c.scope === "product_requirement" && c.id === r.id);
    const complete = journal.provenance === "live_sandbox" && journal.closed && check?.status === "passed" && !counts.failed;
    return { id: r.id, requiredLevel: "live_sandbox", status: complete ? "passed" : check?.status === "failed" ? "failed" : "pending", reason: check?.reason ?? "Product scenario unperformed", evidence: complete ? [{ level: "live_sandbox", commit: journal.commit, result: check!.reason, artifact: `${journal.plan.settings.runId}/evidence.json`, planSha256: journal.plan.sha256 }] : [] };
  });
  const inScope = requirements.filter(r => scope.has(r.id));
  const packet = {
    schema: 1, provenance: journal.provenance, runId: journal.plan.settings.runId, commit: journal.commit,
    scenario: journal.plan.settings.scenario ?? "fixtures", scope: [...scope],
    accountId: journal.plan.settings.accountId, region: journal.plan.settings.region,
    startedAt: journal.startedAt, finishedAt: finishedAt.toISOString(), planSha256: journal.plan.sha256,
    permissionSha256: journal.permissionSha256, estimatedUsd: journal.plan.estimate.usd,
    costProvisional: true, billingMeasured: false, cleanupComplete: journal.closed,
    counts, verdict: counts.failed || !journal.closed ? "failed" : inScope.length > 0 && inScope.every(r => r.status === "passed") ? "passed" : "incomplete",
    checks: journal.checks, requirements,
    releaseStatus: { implementationComplete: false, sandboxVerified: false, pilotReady: false, productionApproved: false },
  };
  const safe = redactAcceptance(packet);
  return { ...safe, sha256: digest(safe) };
}
