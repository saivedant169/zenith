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

/** The original-evidence source the release tooling reads for one requirement (scripts/release/status.mjs sourceOutcome). */
export interface ReleaseSource {
  schema: "zenith.live-release-source.v1"; commit: string; mode: "live"; requirements: [string];
  counts: { passed: 1; failed: 0; skipped: 0 }; exitCode: 0; verdict: "passed"; command: string; environment: string;
  evidence: { runId: string; file: "evidence.json"; sha256: string; packetSha256: string }; result: string;
}

/**
 * One requirement a live run passed, projected from that run's published evidence.json (the file's own bytes, `evidenceSha256`).
 * Only a live sandbox run whose cleanup completed and whose row for this requirement passed has one; anything else is undefined,
 * so a pending, failed or out-of-scope requirement can never become release evidence. Counts are that one requirement's
 * product check: passed once, nothing failed or skipped.
 */
export function releaseSource(packet: unknown, requirementId: string, evidenceSha256: string): ReleaseSource | undefined {
  const p = packet as { provenance?: unknown; cleanupComplete?: unknown; commit?: unknown; runId?: unknown; scenario?: unknown; accountId?: unknown; region?: unknown;
    planSha256?: unknown; permissionSha256?: unknown; sha256?: unknown; requirements?: { id?: unknown; status?: unknown; reason?: unknown }[] };
  const row = Array.isArray(p?.requirements) ? p.requirements.find(r => r?.id === requirementId) : undefined;
  const text = (v: unknown, shape: RegExp) => typeof v === "string" && shape.test(v) ? v : undefined;
  const commit = text(p?.commit, /^[a-f0-9]{40}$/), runId = text(p?.runId, /^zlive-[0-9]{12}-[a-f0-9]{4}$/), scenario = text(p?.scenario, /^[a-z0-9-]{1,20}$/);
  const account = text(p?.accountId, /^\d{12}$/), region = text(p?.region, /^[a-z]{2}-[a-z]+-\d$/);
  const plan = text(p?.planSha256, /^[a-f0-9]{64}$/), permission = text(p?.permissionSha256, /^[a-f0-9]{64}$/), packetSha = text(p?.sha256, /^[a-f0-9]{64}$/);
  if (p?.provenance !== "live_sandbox" || p.cleanupComplete !== true || row?.status !== "passed" || typeof row.reason !== "string") return undefined;
  if (!commit || !runId || !scenario || !account || !region || !plan || !permission || !packetSha || !/^[a-f0-9]{64}$/.test(evidenceSha256) || !/^PROD-[A-Z]+-\d{2}$/.test(requirementId)) return undefined;
  return {
    schema: "zenith.live-release-source.v1", commit, mode: "live", requirements: [requirementId], counts: { passed: 1, failed: 0, skipped: 0 }, exitCode: 0, verdict: "passed",
    command: `GitHub Actions live-acceptance.yml, scenario ${scenario}, run id ${runId}; plan sha256 ${plan}`,
    environment: `Disposable AWS sandbox account ${account}, region ${region}; permission sha256 ${permission}; cleanup complete`,
    evidence: { runId, file: "evidence.json", sha256: evidenceSha256, packetSha256: packetSha }, result: row.reason.slice(0, 2000),
  };
}
