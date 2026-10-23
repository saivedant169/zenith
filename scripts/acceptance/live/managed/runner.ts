import { mkdirSync, readFileSync, renameSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { Scope, contentDigest } from "../../../release/scope";
import { at, assertionsPass, buildPlan, harness, scenarios, type Plan, type Request, type Resource, type Step, type Target } from "./plan";
import { inventoryEmpty, reserveRunBudget, teardownUntilFailure } from "../shared";

export interface Response { status: number; body: unknown }
export interface Transport {
  /** Implementations make one guarded call, or guard each page/subcall using `beforeRead`. */
  send(request: Request, target: Target, beforeRead: (action?: Step["action"], targetId?: string) => void, ownership?: unknown): Promise<Response>;
}
export const Approval = z.object({ schema: z.literal(1), decision: z.literal("DEC-CLOUD"), approvedBy: z.string().min(1).max(100), approvedAt: z.string().datetime(), expiresAt: z.string().datetime(), planSha256: z.string().regex(/^[a-f0-9]{64}$/), scopeDigest: z.string().regex(/^[a-f0-9]{64}$/), sourceCommit: z.string().regex(/^[a-f0-9]{40}$/) }).strict();
export type Approval = z.infer<typeof Approval>;
export interface RecordResult { id: string; scenario: string; phase: "scenario" | "cleanup" | "leak_scan"; status: "passed" | "failed" | "not_run"; attempts: number; detail: string }
export interface Report { schema: 1; runId: string; planSha256: string; sourceCommit: string; scopeDigest: string; environment: "live_sandbox"; results: RecordResult[]; counts: { passed: number; failed: number; notRun: number }; pendingScenarios: string[]; ok: boolean; statement: string }
export interface Journal { schema: 1; planSha256: string; scopeDigest: string; sourceCommit: string; attempted: string[]; counts: Record<string, number>; closed: boolean }
export interface JournalStore { load(): unknown; save(journal: Journal): void }
const JournalSchema = z.object({ schema: z.literal(1), planSha256: z.string(), scopeDigest: z.string(), sourceCommit: z.string(), attempted: z.array(z.string()), counts: z.record(z.string(), z.number().int().nonnegative()), closed: z.boolean() }).strict();
export function fileJournal(file: string): JournalStore {
  return { load: () => existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : undefined,
    save: journal => { mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 }); writeFileSync(`${file}.new`, `${JSON.stringify(journal)}\n`, { mode: 0o600 }); renameSync(`${file}.new`, file); } };
}

/** Persistent conservative reservations across runs. A reservation is never refunded by this harness.
 * Uses the same owner file and reservation schema as L1/L2. */
export function reserveBudget(file: string, plan: Plan, scope: Scope): void {
  const usd = Object.values(plan.estimate.byProviderUsd).reduce((sum, n) => sum + n, 0) + plan.estimate.cleanupReserveUsd;
  reserveRunBudget(file, { runId: plan.runId, planSha256: plan.sha256, usd }, scope.manifest.budgets.totalUsd);
}

export interface RunDeps {
  scope: Scope; approval: Approval; sourceCommit: string; env: Readonly<Record<string, string | undefined>>;
  transport: () => Transport; journal: JournalStore; reserve: () => void;
  now?: () => Date; sleep?: (ms: number) => Promise<void>; signal?: AbortSignal; cleanupOnly?: boolean;
}
export function preflight(plan: Plan, deps: RunDeps, now: () => Date = deps.now ?? (() => new Date())): void {
  const { sha256, ...body } = plan;
  if (buildPlan(body).sha256 !== sha256) throw new Error("Plan integrity failed");
  if (deps.env[`ZENITH_LIVE_${plan.profile === "managed" ? "MANAGED" : plan.profile === "mixed" ? "MIXED" : "RELEASE"}`] !== "1") throw new Error("Live gate is disabled; run --plan without credentials");
  const approval = Approval.parse(deps.approval);
  if (contentDigest(deps.scope.manifest) !== deps.scope.digest) throw new Error("Scope changed after it was loaded");
  if (approval.planSha256 !== sha256 || approval.scopeDigest !== deps.scope.digest || approval.sourceCommit !== plan.sourceCommit || deps.sourceCommit !== plan.sourceCommit) throw new Error("Approval is not bound to this exact plan, scope and checkout");
  if (Date.parse(approval.approvedAt) > now().getTime() || Date.parse(approval.expiresAt) <= now().getTime() || Date.parse(approval.expiresAt) <= Date.parse(approval.approvedAt)) throw new Error("Exact-plan approval is not current");
  const start = Date.parse(plan.startedAt);
  if (start > now().getTime() || !deps.cleanupOnly && now().getTime() >= start + plan.ttlMinutes * 60000) throw new Error("Run lifetime is not current");
  if (plan.ttlMinutes > deps.scope.manifest.budgets.maxRunTtlMinutes) throw new Error("Run exceeds approved TTL");
  deps.scope.assertApproved();
  const name = harness(plan.profile);
  const grant = deps.scope.manifest.harnesses[name];
  const usd = Object.values(plan.estimate.byProviderUsd).reduce((sum, n) => sum + n, 0) + plan.estimate.cleanupReserveUsd;
  if (!grant || usd > Math.min(grant.maxRunUsd, deps.scope.manifest.budgets.perRunUsd, deps.scope.manifest.budgets.totalUsd)) throw new Error("Missing grant or insufficient full-run budget including cleanup reserve");
  for (const t of plan.targets) deps.scope.assertGrant(name, t.provider, "read");
  // Reserve the full lifetime estimate, even for pre-existing fixtures. No unknown/zero cloud price.
  for (const provider of new Set(plan.targets.map(t => t.provider))) {
    const amount = plan.estimate.byProviderUsd[provider];
    if (amount === undefined || provider !== "control_plane" && provider !== "public" && amount <= 0) throw new Error("Every provider needs an explicit positive lifetime estimate");
    const subtotal = Object.values(plan.estimate.byProviderUsd).reduce((sum, n) => sum + n, 0);
    if (amount + (subtotal ? plan.estimate.cleanupReserveUsd * amount / subtotal : 0) > (deps.scope.manifest.budgets.perProviderPerRunUsd[provider] ?? 0)) throw new Error("Per-provider budget exceeded including cleanup reserve");
  }
  for (const s of [...plan.steps, ...plan.cleanup, ...plan.scans]) {
    const t = plan.targets.find(t => t.id === s.request.target)!;
    deps.scope.assertGrant(name, t.provider, s.action);
    const r = plan.resources.find(r => r.id === s.resource);
    if (r) deps.scope.assertGrant(name, plan.targets.find(t => t.id === r.target)!.provider, s.action);
  }
}

/** No response body, URL, credential, provider error, or child-process output enters public evidence. */
export async function runPlan(input: Plan, deps: RunDeps): Promise<Report> {
  const { sha256: suppliedDigest, ...recipe } = input;
  const plan = buildPlan(recipe);
  if (suppliedDigest !== plan.sha256) throw new Error("Plan integrity failed");
  const freeze = (v: unknown): void => { if (v && typeof v === "object") { Object.values(v).forEach(freeze); Object.freeze(v); } };
  freeze(plan);
  const now = deps.now ?? (() => new Date());
  preflight(plan, deps, now); // complete envelope before constructing transport or opening credentials
  const approved = Approval.parse(deps.approval);
  freeze(approved);
  const prior = deps.journal.load();
  const journal: Journal = prior === undefined ? { schema: 1, planSha256: plan.sha256, scopeDigest: deps.scope.digest, sourceCommit: plan.sourceCommit, attempted: [], counts: {}, closed: false } : JournalSchema.parse(prior);
  if (journal.planSha256 !== plan.sha256 || journal.scopeDigest !== deps.scope.digest || journal.sourceCommit !== plan.sourceCommit) throw new Error("Journal belongs to another plan, checkout or scope");
  if (prior !== undefined && !deps.cleanupOnly) throw new Error("Prior run exists; resume --cleanup-only after reviewing uncertain effects");
  if (deps.cleanupOnly && prior === undefined) throw new Error("Cleanup requires the original attempted-effect journal");
  if (!deps.cleanupOnly) deps.reserve();
  deps.journal.save(journal);
  const io = deps.transport();
  const results: RecordResult[] = [];
  const target = (id: string): Target => plan.targets.find(t => t.id === id)!;
  const guard = (key: string, q: Request, action: Step["action"], max: number, resource?: Resource, tags?: Record<string, string>, cleanup = false): void => {
    if (contentDigest(deps.scope.manifest) !== deps.scope.digest || Date.parse(approved.expiresAt) <= now().getTime()) throw new Error("Permission changed or expired before call");
    if (!cleanup && (deps.signal?.aborted || now().getTime() >= Date.parse(plan.startedAt) + plan.ttlMinutes * 60000)) throw new Error("Run interrupted or expired");
    const count = (journal.counts[key] ?? 0) + 1;
    if (count > max) throw new Error("Bounded call envelope exhausted");
    const request = { harness: harness(plan.profile), provider: target(q.target).provider, action, runId: plan.runId, resourceName: resource?.name, tags, ttlMinutes: plan.ttlMinutes, estimatedUsd: action === "create_disposable" ? plan.estimate.byProviderUsd[target(resource!.target).provider] : undefined };
    deps.scope.authorize(request);
    if (resource && resource.target !== q.target) deps.scope.authorize({ ...request, provider: target(resource.target).provider });
    journal.counts[key] = count;
    deps.journal.save(journal); // conservative consumption BEFORE a possibly uncertain effect
  };
  const send = async (key: string, q: Request, action: Step["action"], max: number, resource?: Resource, tags?: Record<string, string>, cleanup = false, ownership?: unknown): Promise<Response> => {
    guard(key, q, action, max, resource, tags, cleanup);
    return io.send(q, target(q.target), (subAction = "read", targetId = q.target) => {
      if (targetId !== q.target && !(q.kind === "mixed_traffic" && q.databaseTarget === targetId)) throw new Error("Unplanned subcall target");
      if (subAction !== "read" && subAction !== action) throw new Error("Unplanned subcall action");
      guard(`${key}.page`, { ...q, target: targetId }, subAction, 120 * max, subAction !== "read" ? resource : undefined, tags, cleanup);
    }, ownership);
  };
  const perform = async (s: Step, phase: RecordResult["phase"]): Promise<boolean> => {
    let attempts = 0;
    try {
      let ownership: unknown;
      let tags: Record<string, string> | undefined;
      const r = plan.resources.find(r => r.id === s.resource);
      if (s.action !== "read" && s.action !== "create_disposable") {
        const read = await send(`${s.id}.ownership`, r!.ownership, "read", 3, undefined, undefined, phase === "cleanup");
        if (read.status !== 200) throw new Error("Independent ownership read failed");
        if ((r!.ownership.kind === "http" || r!.ownership.kind === "kubernetes") && !assertionsPass(read.body, r!.ownership.assertions)) throw new Error("Ownership response differs from the pinned resource assertions");
        ownership = read.body;
        if (at(ownership, r!.tagPointer) !== plan.runId || at(ownership, r!.ttlPointer) !== new Date(Date.parse(plan.startedAt) + plan.ttlMinutes * 60000).toISOString()) throw new Error("Resource ownership or TTL differs from the approved run");
        tags = { [deps.scope.manifest.disposable.requiredTag]: plan.runId };
      }
      if (s.action !== "read") {
        if (!journal.attempted.includes(s.id)) journal.attempted.push(s.id);
        deps.journal.save(journal);
      }
      for (let i = 0; i < s.attempts; i++) {
        attempts++;
        const response = await send(s.id, s.request, s.action, s.attempts * 3, r, tags, phase !== "scenario", ownership);
        const q = s.request;
        const passed = q.kind === "http" ? response.status === q.status && assertionsPass(response.body, q.assertions)
          : q.kind === "kubernetes" ? response.status === 200 && assertionsPass(response.body, q.assertions)
          : q.kind === "inventory" ? response.status === 200 && inventoryEmpty(response.body)
          : q.kind === "delete_namespace" || q.kind === "scale_deployment" ? response.status === 200 || response.status === 202
          : response.status === 200 && (response.body as { ok?: boolean } | null)?.ok === true;
        if (passed) { results.push({ id: s.id, scenario: s.scenario, phase, status: "passed", attempts, detail: q.kind === "inventory" ? "Declared provider inventory is empty; untagged or unsupported resources are not covered" : "Independent response satisfied the exact approved assertions" }); return true; }
        if (i + 1 < s.attempts) await (deps.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms))))(s.intervalMs);
      }
      throw new Error("Independent assertion did not pass");
    } catch {
      results.push({ id: s.id, scenario: s.scenario, phase, status: "failed", attempts, detail: "Call refused, failed, or observation did not satisfy the approved assertion; inspect the plan, journal counts and provider audit trail" });
      return false;
    }
  };
  try {
    let blocked = Boolean(deps.cleanupOnly);
    for (const s of plan.steps) {
      if (blocked) results.push({ id: s.id, scenario: s.scenario, phase: "scenario", status: "not_run", attempts: 0, detail: deps.cleanupOnly ? "Cleanup-only resume never replays scenario effects" : "Earlier scenario did not pass" });
      else if (!await perform(s, "scenario")) blocked = true;
    }
  } finally {
    // Exact owner-approved teardown only. Always attempt every entry; no automatic compensation or permission fallback.
    await teardownUntilFailure(plan.cleanup, step => perform(step, "cleanup"), false);
    // Leak scan is independent of teardown success and never restored from a checkpoint.
    for (const s of plan.scans) await perform(s, "leak_scan");
    journal.closed = results.filter(r => r.phase !== "scenario").every(r => r.status === "passed");
    deps.journal.save(journal);
  }
  const pendingScenarios = scenarios(plan.profile).filter(id => !plan.steps.some(s => s.scenario === id) || results.some(r => r.scenario === id && r.status !== "passed"));
  const counts = { passed: results.filter(r => r.status === "passed").length, failed: results.filter(r => r.status === "failed").length, notRun: results.filter(r => r.status === "not_run").length };
  return { schema: 1, runId: plan.runId, planSha256: plan.sha256, sourceCommit: plan.sourceCommit, scopeDigest: deps.scope.digest, environment: "live_sandbox", results, counts, pendingScenarios,
    ok: !deps.cleanupOnly && counts.failed === 0 && counts.notRun === 0 && pendingScenarios.length === 0,
    statement: "Only performed observations are recorded. These are scoped checks, not requirement verification or production signoff. Missing scenarios, provider inventory limitations and owner decisions remain visible." };
}
