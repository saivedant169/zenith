import type { AwsPermission, Call, Plan } from "./contracts";
import { allCalls, buildPlan, digest } from "./plan";
function freeze(value: unknown): void {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return;
  Object.values(value).forEach(freeze);
  Object.freeze(value);
}

export function readPermission(document: unknown): AwsPermission {
  if (!document || typeof document !== "object" || !("awsLive" in document)) throw new Error("permissions.json needs an approved awsLive extension (Wave 5 join)");
  const p = (document as { awsLive: AwsPermission }).awsLive;
  if (!p || p.schema !== 1 || p.decision !== "DEC-CLOUD" || !p.approvedBy?.trim() ||
    !Number.isFinite(Date.parse(p.approvedAt)) || !Number.isFinite(Date.parse(p.expiresAt)) ||
    Date.parse(p.expiresAt) <= Date.parse(p.approvedAt) || !/^[a-f0-9]{64}$/.test(p.planSha256) || !/^[a-f0-9]{40}$/.test(p.sourceCommit) ||
    !Number.isFinite(p.maxUsd) || p.maxUsd <= 0 || !Number.isInteger(p.maxMinutes) ||
    !Array.isArray(p.grants) || p.grants.some(g => !g || typeof g.action !== "string" || g.action.includes("*") || typeof g.resource !== "string" || !Number.isInteger(g.maximumCalls) || g.maximumCalls < 1)) {
    throw new Error("Malformed or unapproved DEC-CLOUD permission");
  }
  return p;
}
export function grantsFor(plan: Plan): AwsPermission["grants"] {
  const grants = new Map<string, AwsPermission["grants"][number]>();
  for (const call of allCalls(plan)) {
    const key = `${call.action}\n${call.resource}`;
    const current = grants.get(key) ?? { action: call.action, resource: call.resource, maximumCalls: 0 };
    current.maximumCalls += call.maximumCalls;
    grants.set(key, current);
  }
  return [...grants.values()];
}
const REPAIR_IDS: ReadonlySet<string> = new Set(["s3-tag", "dns-tag"]);
/** No transport is constructed until this entire envelope passes. No wildcard
 * matching: the handful of AWS unscopable operations are exact reviewed entries. */
export class Guard {
  readonly counts: Record<string, number>;
  private readonly approvedCalls: Map<string, string>;
  private readonly cleanupIds: Set<string>;
  constructor(readonly plan: Plan, readonly permission: AwsPermission, readonly budgetUsd: number,
    readonly now: () => Date = () => new Date(), counts: Record<string, number> = {}, cleanupOnly = false) {
    readPermission({ awsLive: permission });
    const { sha256, ...body } = plan;
    if (digest(body) !== sha256) throw new Error("Plan integrity failed");
    if (buildPlan(plan.settings).sha256 !== sha256) throw new Error("Plan is not the canonical bounded AWS topology");
    if (permission.planSha256 !== sha256 || permission.runId !== plan.settings.runId || permission.accountId !== plan.settings.accountId || permission.region !== plan.settings.region) throw new Error("Permission is not bound to this exact plan/run/account/region");
    if (!Number.isFinite(budgetUsd) || budgetUsd <= 0 || budgetUsd > permission.maxUsd || plan.estimate.usd > budgetUsd || plan.settings.durationMinutes > permission.maxMinutes) throw new Error("Explicit budget/duration cannot cover the full plan including cleanup reserve");
    if (Date.parse(permission.approvedAt) > now().getTime() || (!cleanupOnly && Date.parse(permission.expiresAt) <= now().getTime())) throw new Error("Permission is not currently approved");
    // Validate every permission before even sts:GetCallerIdentity.
    for (const grant of grantsFor(plan)) {
      const approved = permission.grants.find(g => g.action === grant.action && g.resource === grant.resource);
      if (!approved || approved.maximumCalls < grant.maximumCalls) throw new Error(`Missing bounded permission: ${grant.action}`);
    }
    const known = new Map(allCalls(plan).map(c => [c.id, c]));
    if (known.size !== allCalls(plan).length) throw new Error("Duplicate planned call identity");
    if (Object.entries(counts).some(([id, count]) => !known.has(id) || !Number.isInteger(count) || count < 0 || count > known.get(id)!.maximumCalls)) throw new Error("Invalid persisted call counts");
    this.counts = { ...counts };
    this.approvedCalls = new Map(allCalls(plan).map(c => [c.id, digest(c)]));
    this.cleanupIds = new Set([...plan.preflight.filter(c => ["identity", "marker", "run-claim-read", "dns-discover"].includes(c.id)), ...plan.fixtures.flatMap(f => [f.ownership, ...f.teardown, ...f.leak])].map(c => c.id));
    freeze(plan); freeze(permission);
  }
  consume(call: Call, cleanup = false, repair = false): void {
    if (this.approvedCalls.get(call.id) !== digest(call)) throw new Error("Unplanned AWS call refused");
    // Recovery may re-apply a planned tag only through execute.ts's proven untagged-create repair; no create is ever in this set.
    if (cleanup && !this.cleanupIds.has(call.id) && !(repair && REPAIR_IDS.has(call.id))) throw new Error("Recovery cannot create or invoke resources");
    if (!cleanup && Date.parse(this.permission.expiresAt) <= this.now().getTime()) throw new Error("Permission expired before call");
    const n = (this.counts[call.id] ?? 0) + 1;
    if (n > call.maximumCalls) throw new Error(`Request envelope exhausted: ${call.id}`);
    this.counts[call.id] = n;
  }
}
