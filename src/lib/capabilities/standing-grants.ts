/**
 * Standing grants: a person's explicit, bounded, revocable pre-approval for a class of repeat
 * operations an agent proposes (PROD-DUR-04, "standing grants are explicitly bounded").
 *
 * A standing grant is NOT a new kind of authority. It is a human administrator, in a browser
 * session, approving in advance a narrow set of exact operations. When a matching proposal
 * arrives, the broker records an ordinary approval row for it, with the grant's creator as the
 * approver and the grant id in the reason, so every later gate (claim, current-policy recheck,
 * worker dispatch, SQL consumption) sees the same approval shape it always sees and the same
 * separation-of-duties, role and policy rechecks apply.
 *
 * Bounds, all mandatory (there is no unbounded grant):
 *   - scope: one environment, optionally one project and one resource
 *   - capabilities: an explicit list; never destructive, escape-hatch or "never unattended" ones
 *   - risk ceiling: `maxRisk` is at most `high`; the operation's effective risk must not exceed it
 *   - principals: an explicit list of agents/integrations that may use it (never a human)
 *   - count: `maxUses` between 1 and 1000, consumed atomically (a reserved use counts)
 *   - expiry: between five minutes and thirty days from creation
 *
 * It never covers: a proposal needing more than one approver, an operation whose proposal carries
 * an ownership transfer, a plan gate (a later approval round: concrete plans are always reviewed by
 * a person), or anything policy denies. Policy and roles are evaluated as usual first.
 *
 * Dispatch-time revocation: an approval that came from a standing grant stops counting the moment
 * the grant is revoked or expired or its creator is no longer an admin. `beginExecution` and the
 * worker's `approvalStatus` both drop such approvals before deciding, so revoking a grant stops
 * operations that were already approved under it but have not yet been dispatched.
 */
import type { OperationRecord, Principal } from "@/lib/controlplane/types";
import { capability as catalogEntry, isCapability, type CapabilityDef, type CapabilityRisk } from "./catalog";
import { BrokerError, notFound } from "./errors";
import { memberAccess, newId, requesterOf, requireHumanSession } from "./internal";
import { ROLE_RANK, type BrokerDeps } from "./ports";
import { scrubSecrets } from "./secret-guard";
import type { BrowserSessionProof } from "./types";

/* --------------------------------- limits --------------------------------- */

export const STANDING_MIN_LIFETIME_MS = 5 * 60 * 1000;
export const STANDING_MAX_LIFETIME_MS = 30 * 24 * 60 * 60 * 1000;
export const STANDING_MAX_USES = 1000;
export const STANDING_MAX_CAPABILITIES = 20;
export const STANDING_MAX_PRINCIPALS = 20;
const RISK_RANK: Readonly<Record<CapabilityRisk, number>> = { low: 0, medium: 1, high: 2, critical: 3 };
const PRINCIPAL_KEY = /^(integration|navigator):[A-Za-z0-9_.:-]{1,200}$/;

/* --------------------------------- records -------------------------------- */

export interface StandingGrant {
  id: string;
  workspaceId: string;
  /** the administrator whose approval this grant stands for */
  createdBy: string;
  createdByName: string;
  projectId?: string;
  environmentId: string;
  resourceId?: string;
  capabilities: string[];
  maxRisk: CapabilityRisk;
  /** `integration:<id>` or `navigator:<id>` */
  allowedPrincipals: string[];
  maxUses: number;
  uses: number;
  expiresAt: string;
  createdAt: string;
  status: "active" | "revoked";
  revokedAt?: string;
  revokedBy?: string;
  revokedReason?: string;
}

export interface StandingGrantUse {
  id: string;
  workspaceId: string;
  grantId: string;
  operationId: string;
  principalKey: string;
  approvalId?: string;
  createdAt: string;
  voidedAt?: string;
}

export type NewStandingGrant = Omit<StandingGrant, "uses" | "status" | "revokedAt" | "revokedBy" | "revokedReason">;

export type ReserveUseResult = { ok: true; grant: StandingGrant; use: StandingGrantUse } | { ok: false; reason: "not_found" | "revoked" | "expired" | "exhausted" };

/** Storage port. The reservation of a use is atomic: of N concurrent callers at most `maxUses - uses` succeed. */
export interface StandingGrantStore {
  create(grant: NewStandingGrant): Promise<StandingGrant>;
  get(workspaceId: string, id: string): Promise<StandingGrant | null>;
  list(workspaceId: string, filter?: { environmentId?: string; activeOnly?: boolean; now?: Date; limit?: number }): Promise<StandingGrant[]>;
  /** Idempotent: an already revoked grant is returned unchanged. `null` when it does not exist in the workspace. */
  revoke(input: { workspaceId: string; id: string; revokedBy: string; reason?: string; at: Date }): Promise<StandingGrant | null>;
  reserveUse(input: { workspaceId: string; grantId: string; useId: string; operationId: string; principalKey: string; now: Date }): Promise<ReserveUseResult>;
  attachApproval(input: { workspaceId: string; useId: string; approvalId: string }): Promise<boolean>;
  /** Give a reserved use back (the approval could not be recorded). */
  voidUse(input: { workspaceId: string; useId: string; at: Date }): Promise<boolean>;
  usesForOperation(workspaceId: string, operationId: string): Promise<StandingGrantUse[]>;
  /** Usage history of one grant, newest first, bounded. */
  usesForGrant(workspaceId: string, grantId: string, limit?: number): Promise<StandingGrantUse[]>;
}

const clone = <T>(value: T): T => structuredClone(value);

/** In-process store for tests and the in-memory development composition. Every method is one atomic step. */
export class MemoryStandingGrantStore implements StandingGrantStore {
  private readonly grants = new Map<string, StandingGrant>();
  private readonly uses: StandingGrantUse[] = [];

  private key = (workspaceId: string, id: string): string => `${workspaceId}\u0000${id}`;

  async create(grant: NewStandingGrant): Promise<StandingGrant> {
    if (this.grants.has(this.key(grant.workspaceId, grant.id))) throw new BrokerError("conflict", "That standing grant id already exists.");
    const stored: StandingGrant = { ...clone(grant), uses: 0, status: "active" };
    this.grants.set(this.key(grant.workspaceId, grant.id), stored);
    return clone(stored);
  }

  async get(workspaceId: string, id: string): Promise<StandingGrant | null> {
    const g = this.grants.get(this.key(workspaceId, id));
    return g ? clone(g) : null;
  }

  async list(workspaceId: string, filter: { environmentId?: string; activeOnly?: boolean; now?: Date; limit?: number } = {}): Promise<StandingGrant[]> {
    const now = (filter.now ?? new Date()).getTime();
    return [...this.grants.values()]
      .filter((g) => g.workspaceId === workspaceId)
      .filter((g) => !filter.environmentId || g.environmentId === filter.environmentId)
      .filter((g) => !filter.activeOnly || (g.status === "active" && Date.parse(g.expiresAt) > now && g.uses < g.maxUses))
      .sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : a.id < b.id ? -1 : 1))
      .slice(0, Math.max(1, Math.min(200, filter.limit ?? 100)))
      .map(clone);
  }

  async revoke(input: { workspaceId: string; id: string; revokedBy: string; reason?: string; at: Date }): Promise<StandingGrant | null> {
    const g = this.grants.get(this.key(input.workspaceId, input.id));
    if (!g) return null;
    if (g.status === "active") {
      g.status = "revoked";
      g.revokedAt = input.at.toISOString();
      g.revokedBy = input.revokedBy;
      if (input.reason) g.revokedReason = input.reason;
    }
    return clone(g);
  }

  async reserveUse(input: { workspaceId: string; grantId: string; useId: string; operationId: string; principalKey: string; now: Date }): Promise<ReserveUseResult> {
    const g = this.grants.get(this.key(input.workspaceId, input.grantId));
    if (!g) return { ok: false, reason: "not_found" };
    if (g.status !== "active") return { ok: false, reason: "revoked" };
    if (Date.parse(g.expiresAt) <= input.now.getTime()) return { ok: false, reason: "expired" };
    if (g.uses >= g.maxUses) return { ok: false, reason: "exhausted" };
    if (this.uses.some((u) => u.workspaceId === input.workspaceId && u.grantId === input.grantId && u.operationId === input.operationId && !u.voidedAt)) return { ok: false, reason: "exhausted" };
    g.uses += 1;
    const use: StandingGrantUse = { id: input.useId, workspaceId: input.workspaceId, grantId: input.grantId, operationId: input.operationId, principalKey: input.principalKey, createdAt: input.now.toISOString() };
    this.uses.push(use);
    return { ok: true, grant: clone(g), use: clone(use) };
  }

  async attachApproval(input: { workspaceId: string; useId: string; approvalId: string }): Promise<boolean> {
    const use = this.uses.find((u) => u.workspaceId === input.workspaceId && u.id === input.useId);
    if (!use || use.approvalId || use.voidedAt) return false;
    use.approvalId = input.approvalId;
    return true;
  }

  async voidUse(input: { workspaceId: string; useId: string; at: Date }): Promise<boolean> {
    const use = this.uses.find((u) => u.workspaceId === input.workspaceId && u.id === input.useId);
    if (!use || use.voidedAt || use.approvalId) return false;
    use.voidedAt = input.at.toISOString();
    const g = this.grants.get(this.key(input.workspaceId, use.grantId));
    if (g && g.uses > 0) g.uses -= 1;
    return true;
  }

  async usesForOperation(workspaceId: string, operationId: string): Promise<StandingGrantUse[]> {
    return this.uses.filter((u) => u.workspaceId === workspaceId && u.operationId === operationId).map(clone);
  }

  async usesForGrant(workspaceId: string, grantId: string, limit = 50): Promise<StandingGrantUse[]> {
    return this.uses
      .filter((u) => u.workspaceId === workspaceId && u.grantId === grantId)
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0))
      .slice(0, Math.max(1, Math.min(200, limit)))
      .map(clone);
  }
}

/* ------------------------------- eligibility ------------------------------ */

/** Capabilities a standing grant can never cover: they always need a person at the moment of the decision. */
export function standingIneligibleReason(def: CapabilityDef): string | undefined {
  if (!def.mutates) return "it changes nothing, so it needs no approval";
  if (def.destructive) return "it is destructive";
  if (def.escapeHatch) return "it is an unrestricted execution surface";
  if (def.defaultAutonomy === 6) return "it never runs unattended at any autonomy level";
  if (def.risk === "critical") return "it is critical risk";
  return undefined;
}

export interface UseContext {
  def: CapabilityDef;
  /** the effective risk the policy evaluated for this operation */
  risk: CapabilityRisk;
  scope: { projectId?: string; environmentId?: string; resourceId?: string };
  principal: Principal;
  approval: { count: number; minRole: "editor" | "admin"; separationOfDuties: boolean };
  hasOwnershipTransfers: boolean;
  now: Date;
}

export const principalKeyOf = (principal: Principal): string => `${principal.kind}:${principal.id}`;

/** Pure: does this grant cover this exact use? Returns a short reason code when not. */
export function standingGrantRefusal(grant: StandingGrant, ctx: UseContext): string | undefined {
  if (grant.status !== "active") return "revoked";
  if (Date.parse(grant.expiresAt) <= ctx.now.getTime()) return "expired";
  if (grant.uses >= grant.maxUses) return "exhausted";
  if (standingIneligibleReason(ctx.def)) return "capability_never_standing";
  if (!grant.capabilities.includes(ctx.def.name)) return "capability_not_granted";
  if (RISK_RANK[ctx.risk] > RISK_RANK[grant.maxRisk]) return "risk_above_ceiling";
  if (!grant.allowedPrincipals.includes(principalKeyOf(ctx.principal))) return "principal_not_granted";
  if (ctx.principal.kind !== "integration" && ctx.principal.kind !== "navigator") return "principal_not_agent";
  if (!ctx.scope.environmentId || ctx.scope.environmentId !== grant.environmentId) return "scope_environment";
  if (grant.projectId && ctx.scope.projectId !== grant.projectId) return "scope_project";
  if (grant.resourceId && ctx.scope.resourceId !== grant.resourceId) return "scope_resource";
  if (ctx.approval.count > 1) return "needs_multiple_approvers";
  if (ctx.hasOwnershipTransfers) return "ownership_transfer_needs_person";
  if (ctx.approval.separationOfDuties && requesterOf(ctx.principal) === grant.createdBy) return "separation_of_duties";
  return undefined;
}

/* --------------------------------- creation -------------------------------- */

export interface CreateStandingGrantInput {
  workspaceId: string;
  actor: Principal;
  session: BrowserSessionProof;
  scope: { projectId?: string; environmentId: string; resourceId?: string };
  capabilities: string[];
  maxRisk: CapabilityRisk;
  allowedPrincipals: string[];
  maxUses: number;
  /** lifetime from now, in milliseconds */
  lifetimeMs: number;
  reason?: string;
}

function standingStore(deps: BrokerDeps) {
  const store = deps.store.standingGrants;
  if (!store) throw new BrokerError("platform_store_unavailable", "This capability store does not support standing grants, so none can be created or used.", "Use the platform control store.");
  return store;
}

async function audit(deps: BrokerDeps, actor: Principal | undefined, scope: { workspaceId: string; projectId?: string; environmentId?: string; resourceId?: string }, operationId: string | undefined, data: Record<string, unknown>): Promise<void> {
  try {
    await deps.store.appendEvent({
      type: "policy.evaluated",
      workspaceId: scope.workspaceId,
      projectId: scope.projectId,
      environmentId: scope.environmentId,
      resourceId: scope.resourceId,
      operationId,
      correlationId: newId(deps, "corr"),
      actor,
      data,
    });
  } catch {
    /* the grant/ledger rows are authoritative; a missed audit append never turns a refusal into an allow */
  }
}

export async function createStandingGrant(deps: BrokerDeps, input: CreateStandingGrantInput): Promise<StandingGrant> {
  const store = standingStore(deps);
  requireHumanSession(input.actor, input.session, "create a standing grant");
  const access = await memberAccess(deps, input.actor, input.workspaceId);
  if (ROLE_RANK[access.role] < ROLE_RANK.admin) throw new BrokerError("admin_required", `Creating a standing grant needs the admin role and you are ${access.role} in this workspace.`, "Ask a workspace admin.");

  const resolved = await deps.scopes.resolve({ workspaceId: input.workspaceId, projectId: input.scope.projectId, environmentId: input.scope.environmentId, resourceId: input.scope.resourceId });
  if (!resolved?.environment) throw notFound();
  if (access.allowedEnvironmentIds && !access.allowedEnvironmentIds.includes(input.scope.environmentId)) throw notFound();
  if (access.allowedProjectIds && resolved.scope.projectId && !access.allowedProjectIds.includes(resolved.scope.projectId)) throw notFound();

  const invalid = (message: string, details?: Record<string, unknown>): never => {
    throw new BrokerError("invalid_request", message, "A standing grant needs an explicit scope, capability list, risk ceiling, principal list, use count and expiry.", details);
  };
  if (!(input.maxRisk === "low" || input.maxRisk === "medium" || input.maxRisk === "high")) invalid("maxRisk must be low, medium or high; critical risk is never covered by a standing grant.");
  const caps = [...new Set(input.capabilities)];
  if (caps.length === 0 || caps.length > STANDING_MAX_CAPABILITIES) invalid(`Name between 1 and ${STANDING_MAX_CAPABILITIES} capabilities.`);
  for (const name of caps) {
    if (!isCapability(name)) invalid("Unknown capability in the list.");
    const def = catalogEntry(name);
    const why = standingIneligibleReason(def);
    if (why) invalid(`${name} cannot be covered by a standing grant: ${why}.`, { capability: name });
    if (RISK_RANK[def.risk] > RISK_RANK[input.maxRisk]) invalid(`${name} is ${def.risk} risk, above the grant's ceiling of ${input.maxRisk}.`, { capability: name });
  }
  const principals = [...new Set(input.allowedPrincipals)];
  if (principals.length === 0 || principals.length > STANDING_MAX_PRINCIPALS || !principals.every((p) => PRINCIPAL_KEY.test(p))) {
    invalid(`Name between 1 and ${STANDING_MAX_PRINCIPALS} agents as integration:<id> or navigator:<id>.`);
  }
  if (!Number.isInteger(input.maxUses) || input.maxUses < 1 || input.maxUses > STANDING_MAX_USES) invalid(`maxUses must be a whole number from 1 to ${STANDING_MAX_USES}.`);
  if (!Number.isFinite(input.lifetimeMs) || input.lifetimeMs < STANDING_MIN_LIFETIME_MS || input.lifetimeMs > STANDING_MAX_LIFETIME_MS) invalid("The grant must expire between 5 minutes and 30 days from now.");

  const now = deps.clock.now();
  const grant = await store.create({
    id: newId(deps, "sgr"),
    workspaceId: input.workspaceId,
    createdBy: input.actor.id,
    createdByName: input.actor.name || input.actor.id,
    ...(resolved.scope.projectId ? { projectId: resolved.scope.projectId } : {}),
    environmentId: input.scope.environmentId,
    // Uses compare the operation's canonical target, so the grant stores the resolved one too.
    ...(input.scope.resourceId ? { resourceId: resolved.scope.resourceId ?? input.scope.resourceId } : {}),
    capabilities: caps.sort(),
    maxRisk: input.maxRisk,
    allowedPrincipals: principals.sort(),
    maxUses: input.maxUses,
    expiresAt: new Date(now.getTime() + input.lifetimeMs).toISOString(),
    createdAt: now.toISOString(),
  });
  await audit(deps, input.actor, { workspaceId: input.workspaceId, projectId: grant.projectId, environmentId: grant.environmentId, resourceId: grant.resourceId }, undefined, {
    kind: "standing_grant_created",
    grantId: grant.id,
    capabilities: grant.capabilities,
    maxRisk: grant.maxRisk,
    principals: grant.allowedPrincipals,
    maxUses: grant.maxUses,
    expiresAt: grant.expiresAt,
    ...(input.reason ? { reason: String(scrubSecrets(input.reason)).replace(/\s+/g, " ").slice(0, 300) } : {}),
  });
  return grant;
}

export async function revokeStandingGrant(deps: BrokerDeps, input: { workspaceId: string; id: string; actor: Principal; session: BrowserSessionProof; reason?: string }): Promise<StandingGrant> {
  const store = standingStore(deps);
  requireHumanSession(input.actor, input.session, "revoke a standing grant");
  const access = await memberAccess(deps, input.actor, input.workspaceId);
  const grant = await store.get(input.workspaceId, input.id);
  if (!grant) throw notFound();
  if (ROLE_RANK[access.role] < ROLE_RANK.admin && grant.createdBy !== input.actor.id) {
    throw new BrokerError("role_insufficient", "Only the administrator who created a standing grant, or another admin, can revoke it.", "Ask a workspace admin.");
  }
  const reason = input.reason ? String(scrubSecrets(input.reason)).replace(/\s+/g, " ").slice(0, 300) : undefined;
  const revoked = await store.revoke({ workspaceId: input.workspaceId, id: input.id, revokedBy: input.actor.id, reason, at: deps.clock.now() });
  if (!revoked) throw notFound();
  await audit(deps, input.actor, { workspaceId: input.workspaceId, projectId: revoked.projectId, environmentId: revoked.environmentId, resourceId: revoked.resourceId }, undefined, {
    kind: "standing_grant_revoked",
    grantId: revoked.id,
    ...(reason ? { reason } : {}),
  });
  return revoked;
}

export async function listStandingGrants(deps: BrokerDeps, input: { workspaceId: string; principal: Principal; environmentId?: string; activeOnly?: boolean }): Promise<StandingGrant[]> {
  const store = standingStore(deps);
  const access = await memberAccess(deps, input.principal, input.workspaceId);
  const all = await store.list(input.workspaceId, { environmentId: input.environmentId, activeOnly: input.activeOnly, now: deps.clock.now() });
  return all.filter((g) => (!access.allowedEnvironmentIds || access.allowedEnvironmentIds.includes(g.environmentId)) && (!access.allowedProjectIds || !g.projectId || access.allowedProjectIds.includes(g.projectId)));
}

/** Usage history of one grant for any member who can see the grant. Operation ids only; nothing about the operation's content. */
export async function listStandingGrantUsage(deps: BrokerDeps, input: { workspaceId: string; principal: Principal; grantId: string }): Promise<StandingGrantUse[]> {
  const store = standingStore(deps);
  await memberAccess(deps, input.principal, input.workspaceId);
  const visible = await listStandingGrants(deps, { workspaceId: input.workspaceId, principal: input.principal });
  if (!visible.some((g) => g.id === input.grantId)) throw notFound();
  return store.usesForGrant(input.workspaceId, input.grantId);
}

/* ------------------------------- use at propose ----------------------------- */

const creatorOf = (grant: StandingGrant): Principal => ({ kind: "user", id: grant.createdBy, name: grant.createdByName });

/**
 * Try to satisfy a freshly proposed operation's approval requirement with a standing grant.
 * Returns the approved operation, or `null` when no grant applies (the operation simply keeps
 * waiting for a person). Never throws: a failure here must not fail the proposal.
 */
export async function applyStandingGrant(
  deps: BrokerDeps,
  args: { operation: OperationRecord; def: CapabilityDef; risk: CapabilityRisk; approval: UseContext["approval"] | undefined; policyVersion: string; hasOwnershipTransfers: boolean }
): Promise<OperationRecord | null> {
  const store = deps.store.standingGrants;
  const { operation: op } = args;
  if (!store || op.status !== "awaiting_approval" || !args.approval) return null;
  if (op.principal.kind !== "integration" && op.principal.kind !== "navigator") return null;
  const environmentId = op.proposal.scope.environmentId;
  if (!environmentId) return null;
  try {
    const now = deps.clock.now();
    const candidates = await store.list(op.workspaceId, { environmentId, activeOnly: true, now });
    for (const grant of candidates) {
      const ctx: UseContext = { def: args.def, risk: args.risk, scope: op.proposal.scope, principal: op.principal, approval: args.approval, hasOwnershipTransfers: args.hasOwnershipTransfers, now };
      if (standingGrantRefusal(grant, ctx)) continue;
      const creator = creatorOf(grant);
      const access = await deps.roles.resolve(creator, op.workspaceId);
      if (ROLE_RANK[access.role] < ROLE_RANK.admin || ROLE_RANK[access.role] < ROLE_RANK[args.approval.minRole]) continue;
      const useId = newId(deps, "sgu");
      const reserved = await store.reserveUse({ workspaceId: op.workspaceId, grantId: grant.id, useId, operationId: op.id, principalKey: principalKeyOf(op.principal), now });
      if (!reserved.ok) continue;
      try {
        const recorded = await deps.store.recordApproval({
          workspaceId: op.workspaceId,
          operationId: op.id,
          approver: creator,
          approverRole: "admin",
          decision: "approve",
          proposalDigest: op.proposalDigest,
          policyVersion: args.policyVersion,
          reason: `standing grant ${grant.id} (use ${reserved.grant.uses} of ${reserved.grant.maxUses})`,
        });
        await store.attachApproval({ workspaceId: op.workspaceId, useId, approvalId: recorded.approval.id });
        await audit(deps, op.principal, { workspaceId: op.workspaceId, projectId: op.projectId, environmentId, resourceId: op.resourceId }, op.id, {
          kind: "standing_grant_used",
          grantId: grant.id,
          useId,
          approvalId: recorded.approval.id,
          usesAfter: reserved.grant.uses,
          maxUses: reserved.grant.maxUses,
          expiresAt: reserved.grant.expiresAt,
        });
        return recorded.operation;
      } catch {
        await store.voidUse({ workspaceId: op.workspaceId, useId, at: deps.clock.now() }).catch(() => false);
      }
    }
  } catch {
    /* the operation keeps waiting for a person */
  }
  return null;
}

/* ----------------------------- dispatch-time check -------------------------- */

/**
 * Approval ids that came from a standing grant which no longer stands: revoked, expired, or its
 * creator is no longer an admin. Callers drop these approvals before they count them.
 */
export async function lapsedStandingApprovalIds(deps: BrokerDeps, op: Pick<OperationRecord, "workspaceId" | "id">): Promise<Set<string>> {
  const lapsed = new Set<string>();
  const store = deps.store.standingGrants;
  if (!store) return lapsed;
  const uses = await store.usesForOperation(op.workspaceId, op.id);
  const now = deps.clock.now().getTime();
  for (const use of uses) {
    if (!use.approvalId || use.voidedAt) continue;
    const grant = await store.get(op.workspaceId, use.grantId);
    let standing = !!grant && grant.status === "active" && Date.parse(grant.expiresAt) > now;
    if (standing && grant) {
      const access = await deps.roles.resolve(creatorOf(grant), op.workspaceId);
      standing = ROLE_RANK[access.role] >= ROLE_RANK.admin;
    }
    if (!standing) lapsed.add(use.approvalId);
  }
  return lapsed;
}

/** True when the approval was given by a standing grant, whether or not it still stands. */
export async function isStandingApproval(deps: BrokerDeps, op: Pick<OperationRecord, "workspaceId" | "id">, approvalId: string): Promise<boolean> {
  const store = deps.store.standingGrants;
  if (!store) return false;
  return (await store.usesForOperation(op.workspaceId, op.id)).some((u) => u.approvalId === approvalId && !u.voidedAt);
}
