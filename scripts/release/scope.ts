/**
 * Scope permission manifest and enforcement (PROD-REL-04).
 *
 * `docs/build/production/permissions.json` is the machine-readable statement of what live
 * acceptance work may do: approved budgets, disposable resources only, forbidden actions.
 * EVERY live harness loads it and calls `authorize` BEFORE it acts. Fail closed:
 *
 *  - the manifest ships with `approval.status = "not_approved"`; until a person runs
 *    `permissions-cli approve` (which pins the digest of the budget/scope content) every
 *    authorization is refused. Editing a budget or permission after approval invalidates it.
 *  - a harness not listed in the manifest, a provider it was not granted, an action outside
 *    its grant, a forbidden action, a non-disposable resource (wrong name prefix, missing run
 *    tag), an over-budget estimate, an expired approval: all refuse with a stable code.
 *  - spend is tracked per run in a `ScopeLedger`; an estimate that does not fit in the remaining
 *    per-run, per-provider or total budget is refused. Estimates are list prices, never invoices.
 *
 * What this does not do (stated, not hidden): it cannot stop an operator who edits the manifest and
 * re-approves it, nor a harness that never calls it; `tests/release/live-scope-coverage.test.ts`
 * is the guard that every live harness in the repository is either wired to it or exempted by name.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { digest } from "@/lib/controlplane/digest";

export const SCOPE_MANIFEST_RELATIVE = "docs/build/production/permissions.json";

/** Actions a harness may be granted. Anything else is not an action at all. */
export const SCOPE_ACTIONS = ["read", "create_disposable", "mutate_run_tagged", "teardown_run_tagged", "inject_fault"] as const;
export type ScopeAction = (typeof SCOPE_ACTIONS)[number];

/** Actions no grant can ever include. Requesting one is refused even if a manifest tried to allow it. */
export const FORBIDDEN_ACTIONS = [
  "purchase", "accept_terms", "create_account", "production_resource", "unrelated_service", "secret_bypass", "protected_branch_write",
  "history_rewrite", "delete_untagged", "modify_billing", "modify_iam_outside_run", "disable_security_control",
] as const;
export type ForbiddenAction = (typeof FORBIDDEN_ACTIONS)[number];

export const PROVIDERS = ["aws", "gcp", "azure", "oci", "kubernetes", "supabase", "control_plane", "public"] as const;
export type ScopeProvider = (typeof PROVIDERS)[number];

export type ScopeErrorCode =
  | "manifest_unreadable" | "manifest_invalid" | "not_approved" | "approval_stale" | "approval_expired" | "harness_unknown" | "provider_not_granted"
  | "action_not_granted" | "action_forbidden" | "not_disposable" | "run_id_invalid" | "budget_unknown" | "budget_exceeded" | "ttl_exceeded"
  | "sandbox_unconfirmed";

export class ScopeError extends Error {
  readonly code: ScopeErrorCode;
  constructor(code: ScopeErrorCode, message: string) {
    super(message);
    this.name = "ScopeError";
    this.code = code;
  }
}

const Money = z.number().finite().nonnegative();
const HarnessGrant = z.object({
  description: z.string().max(300),
  providers: z.array(z.enum(PROVIDERS)).min(1),
  actions: z.array(z.enum(SCOPE_ACTIONS)).min(1),
  /** this harness may never be estimated above this in one run (USD, list price) */
  maxRunUsd: Money,
}).strict();

const Content = z.object({
  schema: z.literal(1),
  /** every figure below is a PROPOSAL until `approval` pins it */
  budgets: z.object({
    currency: z.literal("USD"),
    perRunUsd: Money,
    perProviderPerRunUsd: z.partialRecord(z.enum(PROVIDERS), Money),
    totalUsd: Money,
    maxRunTtlMinutes: z.number().int().positive().max(24 * 60),
  }).strict(),
  disposable: z.object({
    runIdPattern: z.string().min(4).max(200),
    namePrefix: z.string().regex(/^[a-z][a-z0-9-]{1,30}$/),
    requiredTag: z.string().min(3).max(100),
    ttlTag: z.string().min(3).max(100),
  }).strict(),
  /**
   * The exact sandbox each cloud provider may touch, confirmed by the owner. A provider whose identity is null is
   * refused for every action: an approved budget never widens to "whatever account the credentials happen to reach".
   */
  sandboxes: z.object({
    aws: z.object({ accountId: z.string().regex(/^\d{12}$/).nullable(), regions: z.array(z.string().min(3).max(40)).min(1) }).strict(),
    gcp: z.object({ projectId: z.string().regex(/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/).nullable(), regions: z.array(z.string().min(3).max(40)).min(1) }).strict(),
    azure: z.object({ subscriptionId: z.string().guid().nullable(), tenantId: z.string().guid().nullable(), regions: z.array(z.string().min(3).max(40)).min(1) }).strict(),
    oci: z.object({ tenancyId: z.string().regex(/^ocid1\.tenancy\./).nullable(), compartmentId: z.string().regex(/^ocid1\.compartment\./).nullable(), regions: z.array(z.string().min(3).max(40)).min(1) }).strict(),
    supabase: z.object({ projectRef: z.string().regex(/^[a-z0-9]{20}$/).nullable(), region: z.string().min(3).max(40) }).strict(),
  }).strict(),
  /** Allowances across runs and agents (the shared spend ledger), separate from the per-run budgets above. */
  allowances: z.object({
    /** stop launching new chargeable work at this fraction of an allowance, then reconcile */
    stopAtFraction: z.number().gt(0).max(1),
    /** model-evaluation calls, accounted apart from infrastructure (`budgets.totalUsd`) */
    anthropicUsd: Money,
    sharedLedger: z.string().regex(/^[A-Za-z0-9_./-]+\.json$/),
  }).strict(),
  harnesses: z.record(z.string().regex(/^[a-z0-9][a-z0-9-]{1,60}$/), HarnessGrant),
  forbiddenActions: z.array(z.string()).min(1),
  exemptions: z.array(z.object({ file: z.string().max(300), reason: z.string().max(400) }).strict()).prefault([]),
}).strict();
export type ScopeContent = z.infer<typeof Content>;

const Approval = z.object({
  status: z.enum(["not_approved", "approved"]),
  approvedBy: z.string().max(200).nullable(),
  approvedAt: z.string().nullable(),
  /** approval lapses; an expired approval is refused like none */
  expiresAt: z.string().nullable(),
  /** digest of the manifest content (everything except `approval`) at approval time */
  approvedDigest: z.string().regex(/^[a-f0-9]{64}$/).nullable(),
}).strict();

const Manifest = Content.extend({ approval: Approval }).strict();
export type ScopeManifest = z.infer<typeof Manifest>;

/** Digest of everything a person approves: all of the manifest except the approval block. */
export function contentDigest(manifest: ScopeManifest | ScopeContent): string {
  const { approval: _approval, ...content } = manifest as ScopeManifest;
  return digest(content);
}

export function parseManifest(raw: unknown): ScopeManifest {
  const parsed = Manifest.safeParse(raw);
  if (!parsed.success) throw new ScopeError("manifest_invalid", `The scope manifest is malformed: ${parsed.error.issues.slice(0, 3).map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
  const manifest = parsed.data;
  try { new RegExp(manifest.disposable.runIdPattern); } catch { throw new ScopeError("manifest_invalid", "disposable.runIdPattern is not a valid regular expression."); }
  // The manifest may list extra forbidden actions but can never drop one of ours.
  for (const action of FORBIDDEN_ACTIONS) {
    if (!manifest.forbiddenActions.includes(action)) throw new ScopeError("manifest_invalid", `forbiddenActions must include "${action}".`);
  }
  for (const [id, grant] of Object.entries(manifest.harnesses)) {
    if (grant.maxRunUsd > manifest.budgets.perRunUsd) throw new ScopeError("manifest_invalid", `Harness ${id} allows more per run than the manifest per-run budget.`);
  }
  return manifest;
}

export function loadManifestFile(file: string): ScopeManifest {
  let text: string;
  try { text = readFileSync(file, "utf8"); } catch { throw new ScopeError("manifest_unreadable", `The scope manifest ${path.basename(file)} could not be read.`); }
  let raw: unknown;
  try { raw = JSON.parse(text); } catch { throw new ScopeError("manifest_invalid", "The scope manifest is not valid JSON."); }
  return parseManifest(raw);
}

/** Env variable naming an alternative manifest FILE (a path, never inline content). */
export const SCOPE_FILE_ENV = "ZENITH_LIVE_SCOPE_FILE";

export function defaultManifestPath(env: Readonly<Record<string, string | undefined>> = process.env, cwd: string = process.cwd()): string {
  const named = env[SCOPE_FILE_ENV];
  return named ? path.resolve(named) : path.join(cwd, SCOPE_MANIFEST_RELATIVE);
}

export interface ScopeRequest {
  /** the harness id as listed under `harnesses` in the manifest */
  harness: string;
  provider: ScopeProvider;
  action: ScopeAction | ForbiddenAction;
  /** estimated additional monthly list-price USD this step would add; required for anything that creates */
  estimatedUsd?: number;
  runId?: string;
  /** the name of the resource being created or touched, checked against the disposable prefix */
  resourceName?: string;
  /** current tags of the resource (for mutate/teardown), checked for the run tag */
  tags?: Readonly<Record<string, string>>;
  /** planned lifetime of the run in minutes, checked against the manifest TTL */
  ttlMinutes?: number;
}

/** Teardown-only: a lapsed approval still admits owned cleanup. Content, approver and digest checks always apply; creation never passes it. */
export interface ApprovalOptions { allowExpiredForTeardown?: boolean }
/** The only actions that may ride a lapsed approval. Enforced here, so no caller can widen the carve-out to creation or mutation. */
const LAPSED_OK_ACTIONS: readonly string[] = ["teardown_run_tagged", "read"];
function lapsedAllowance(action: string, options: ApprovalOptions): ApprovalOptions {
  return { allowExpiredForTeardown: !!options.allowExpiredForTeardown && LAPSED_OK_ACTIONS.includes(action) };
}

export interface SpendEntry { provider: ScopeProvider; usd: number; label: string }

/** Per-run spend record shared by every step of one run; `priorUsd` is what earlier runs already committed (shared ledger). */
export class ScopeLedger {
  readonly entries: SpendEntry[] = [];
  constructor(readonly priorUsd = 0) {}
  total(provider?: ScopeProvider): number {
    return this.entries.filter((e) => provider === undefined || e.provider === provider).reduce((sum, e) => sum + e.usd, 0);
  }
}

const CREATES: readonly string[] = ["create_disposable"];
const TOUCHES: readonly string[] = ["mutate_run_tagged", "teardown_run_tagged", "inject_fault"];

export class Scope {
  readonly manifest: ScopeManifest;
  readonly digest: string;
  readonly #now: () => Date;

  constructor(manifest: ScopeManifest, now: () => Date = () => new Date()) {
    this.manifest = manifest;
    this.digest = contentDigest(manifest);
    this.#now = now;
  }

  /** Throws unless a person approved exactly this content and the approval is current. */
  assertApproved(options: ApprovalOptions = {}): void {
    const { approval } = this.manifest;
    if (approval.status !== "approved" || !approval.approvedBy || !approval.approvedAt || !approval.approvedDigest) {
      throw new ScopeError("not_approved", "The live scope manifest has not been approved by a person (approval.status is not_approved). Review docs/build/production/permissions.json, then run: npx tsx scripts/release/permissions-cli.ts approve --by <your name>");
    }
    if (approval.approvedDigest !== this.digest) {
      throw new ScopeError("approval_stale", "The live scope manifest changed after it was approved (budgets, grants or forbidden actions differ from the approved digest); approve it again.");
    }
    if (approval.expiresAt !== null) {
      const expires = Date.parse(approval.expiresAt);
      if (!Number.isFinite(expires) || (expires <= this.#now().getTime() && !options.allowExpiredForTeardown)) throw new ScopeError("approval_expired", "The live scope approval has expired; a person must approve it again.");
    }
  }

  /**
   * Approval, forbidden-action and grant checks only (no run id, no budget): for entry points that decide whether a harness
   * may start at all, before any step with an estimate exists. Steps that create or change things still call `authorize`.
   */
  assertGrant(harness: string, provider: ScopeProvider, action: ScopeAction, options: ApprovalOptions = {}): void {
    this.assertApproved(lapsedAllowance(action, options));
    const grant = this.manifest.harnesses[harness];
    if (!grant) throw new ScopeError("harness_unknown", `Harness "${harness}" has no grant in the scope manifest.`);
    if (!grant.providers.includes(provider)) throw new ScopeError("provider_not_granted", `Harness "${harness}" is not granted provider ${provider}.`);
    if (!(grant.actions as readonly string[]).includes(action)) throw new ScopeError("action_not_granted", `Harness "${harness}" is not granted "${action}".`);
    this.#assertSandbox(provider);
  }

  /** The owner-confirmed sandbox identity a harness must match before touching `provider`. */
  sandbox(provider: ScopeProvider): Record<string, unknown> | undefined {
    return (this.manifest.sandboxes as Record<string, Record<string, unknown>>)[provider];
  }

  #assertSandbox(provider: ScopeProvider): void {
    const sandbox = this.sandbox(provider);
    if (!sandbox) return; // kubernetes (disposable owned cluster), control_plane and public reads carry no cloud identity
    const identity = Object.entries(sandbox).filter(([key]) => key !== "regions" && key !== "region");
    if (identity.some(([, value]) => value === null)) {
      throw new ScopeError("sandbox_unconfirmed", `The ${provider} sandbox identity is not confirmed in the scope manifest; no ${provider} action is authorized.`);
    }
  }

  /**
   * The one question every live harness asks before acting. Returns normally only when the step is allowed;
   * on success a creating step is recorded in `ledger` so later steps see the spend.
   */
  authorize(request: ScopeRequest, ledger?: ScopeLedger, options: ApprovalOptions = {}): void {
    if ((FORBIDDEN_ACTIONS as readonly string[]).includes(request.action) || this.manifest.forbiddenActions.includes(request.action)) {
      throw new ScopeError("action_forbidden", `"${request.action}" is a forbidden action; no live harness may do it.`);
    }
    this.assertApproved(lapsedAllowance(request.action, options));
    const grant = this.manifest.harnesses[request.harness];
    if (!grant) throw new ScopeError("harness_unknown", `Harness "${request.harness}" has no grant in the scope manifest.`);
    if (!grant.providers.includes(request.provider)) throw new ScopeError("provider_not_granted", `Harness "${request.harness}" is not granted provider ${request.provider}.`);
    if (!(grant.actions as readonly string[]).includes(request.action)) throw new ScopeError("action_not_granted", `Harness "${request.harness}" is not granted "${request.action}".`);
    this.#assertSandbox(request.provider);
    if (request.action === "read") return;

    const runIdPattern = new RegExp(this.manifest.disposable.runIdPattern);
    if (!request.runId || !runIdPattern.test(request.runId)) throw new ScopeError("run_id_invalid", "A step that changes anything needs a run id of the disposable-run form.");
    const { namePrefix, requiredTag, ttlTag } = this.manifest.disposable;
    if (CREATES.includes(request.action)) {
      if (!request.resourceName || !request.resourceName.startsWith(`${namePrefix}${request.runId}`) && !request.resourceName.startsWith(`${namePrefix}-${request.runId}`)) {
        throw new ScopeError("not_disposable", `A created resource must be named ${namePrefix}<runId>-... so cleanup can find it (got "${(request.resourceName ?? "").slice(0, 60)}").`);
      }
      if (request.ttlMinutes === undefined || !Number.isFinite(request.ttlMinutes) || request.ttlMinutes <= 0) throw new ScopeError("ttl_exceeded", `A created resource needs a time to live (tag ${ttlTag}); none was given.`);
      if (request.ttlMinutes > this.manifest.budgets.maxRunTtlMinutes) throw new ScopeError("ttl_exceeded", `The requested lifetime ${request.ttlMinutes} min exceeds the approved ${this.manifest.budgets.maxRunTtlMinutes} min.`);
      this.#spend(request, grant, ledger);
    }
    if (TOUCHES.includes(request.action)) {
      if (request.tags?.[requiredTag] !== request.runId) throw new ScopeError("not_disposable", `The resource does not carry ${requiredTag}=${request.runId}; only this run's own resources may be changed.`);
    }
  }

  #spend(request: ScopeRequest, grant: z.infer<typeof HarnessGrant>, ledger?: ScopeLedger): void {
    const usd = request.estimatedUsd;
    if (usd === undefined || !Number.isFinite(usd) || usd < 0) throw new ScopeError("budget_unknown", "A step that creates resources needs a usable cost estimate to check against the approved budget.");
    const budgets = this.manifest.budgets;
    const spent = ledger?.total() ?? 0;
    const spentProvider = ledger?.total(request.provider) ?? 0;
    const providerCap = budgets.perProviderPerRunUsd[request.provider];
    if (usd > grant.maxRunUsd || spent + usd > Math.min(grant.maxRunUsd, budgets.perRunUsd)) {
      throw new ScopeError("budget_exceeded", `This step ($${usd.toFixed(2)}) plus the run so far ($${spent.toFixed(2)}) exceeds the approved per-run budget for "${request.harness}" ($${Math.min(grant.maxRunUsd, budgets.perRunUsd).toFixed(2)}). Estimates are list prices, not invoices.`);
    }
    if (providerCap === undefined || spentProvider + usd > providerCap) throw new ScopeError("budget_exceeded", `The run would exceed the approved ${request.provider} budget ($${(providerCap ?? 0).toFixed(2)} per run).`);
    const prior = ledger?.priorUsd ?? 0, stopAt = budgets.totalUsd * this.manifest.allowances.stopAtFraction;
    if (spent + usd > budgets.totalUsd) throw new ScopeError("budget_exceeded", `The run would exceed the approved total budget ($${budgets.totalUsd.toFixed(2)}).`);
    if (prior + spent + usd > stopAt) throw new ScopeError("budget_exceeded", `Earlier runs ($${prior.toFixed(2)}) plus this run would pass ${Math.round(this.manifest.allowances.stopAtFraction * 100)}% of the infrastructure allowance ($${stopAt.toFixed(2)}); stop and reconcile actual costs first.`);
    ledger?.entries.push({ provider: request.provider, usd, label: request.resourceName ?? request.action });
  }
}

const SharedEntry = z.object({
  runId: z.string().min(4).max(80), harness: z.string().max(80), kind: z.enum(["infrastructure", "anthropic"]),
  recordedAt: z.string(), estimatedUsd: Money, actualUsd: Money.nullable(), activeForecastUsd: Money,
  status: z.enum(["running", "torn_down", "reconciled"]),
}).strict();
const SharedLedgerFile = z.object({ schema: z.literal(1), entries: z.array(SharedEntry) }).strict();

/**
 * What earlier runs committed against an allowance: a reconciled actual where one exists, otherwise the estimate,
 * plus whatever resources are still forecast to accrue. Unreadable ledger = refuse (never assume nothing was spent).
 */
export function committedSpend(file: string, kind: "infrastructure" | "anthropic"): number {
  let parsed;
  try { parsed = SharedLedgerFile.parse(JSON.parse(readFileSync(file, "utf8"))); } catch { throw new ScopeError("budget_unknown", "The shared spend ledger cannot be read; no chargeable work starts until it can."); }
  return parsed.entries.filter((e) => e.kind === kind).reduce((sum, e) => sum + Math.max(e.actualUsd ?? 0, e.status === "reconciled" ? 0 : e.estimatedUsd) + e.activeForecastUsd, 0);
}

/** A per-run ledger seeded with the shared committed infrastructure spend. */
export function runLedger(scope: Scope, root: string = process.cwd()): ScopeLedger {
  return new ScopeLedger(committedSpend(path.resolve(root, scope.manifest.allowances.sharedLedger), "infrastructure"));
}

/** Model-evaluation spend (MACH-06) against its own allowance and the same stop fraction. */
export function authorizeModelSpend(scope: Scope, usd: number, root: string = process.cwd()): void {
  scope.assertApproved();
  if (!Number.isFinite(usd) || usd < 0) throw new ScopeError("budget_unknown", "A model evaluation needs a usable cost estimate.");
  const { anthropicUsd, stopAtFraction, sharedLedger } = scope.manifest.allowances;
  const prior = committedSpend(path.resolve(root, sharedLedger), "anthropic");
  if (prior + usd > anthropicUsd * stopAtFraction) throw new ScopeError("budget_exceeded", `Model evaluations would pass ${Math.round(stopAtFraction * 100)}% of the $${anthropicUsd.toFixed(2)} allowance; stop and reconcile.`);
}

export function loadScope(file: string = defaultManifestPath(), now?: () => Date): Scope {
  return new Scope(loadManifestFile(file), now);
}

/**
 * For gated vitest suites and scripts that must decide "run or skip with a reason": a refusal string, or "" when
 * the harness may begin. It checks approval only (a harness asks `authorize` per step once it runs).
 */
export function scopeSkipReason(harness: string, provider: ScopeProvider, env: Readonly<Record<string, string | undefined>> = process.env, now?: () => Date): string {
  try {
    const scope = loadScope(defaultManifestPath(env), now);
    scope.assertApproved();
    scope.authorize({ harness, provider, action: "read" });
    return "";
  } catch (error) {
    return error instanceof ScopeError ? `scope manifest refuses ${harness} (${error.code}): ${error.message}` : `scope manifest could not be checked for ${harness}`;
  }
}

/** Throwing variant for CLIs: returns the loaded scope or throws a `ScopeError`. */
export function requireScope(harness: string, provider: ScopeProvider, env: Readonly<Record<string, string | undefined>> = process.env, now?: () => Date, options: ApprovalOptions = {}): Scope {
  const scope = loadScope(defaultManifestPath(env), now);
  scope.assertApproved(options);
  scope.authorize({ harness, provider, action: "read" }, undefined, options);
  return scope;
}
