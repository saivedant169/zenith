/**
 * Environments: where a revision runs, and the policy that guards it.
 *
 * Defaults are visible, never silent: production environments require
 * approval unless you say otherwise, and the plan says so before you create
 * one.
 */
import { z } from "zod";
import { defineAction, type ActionContext } from "@/lib/actions/core";
import { v1View } from "@/lib/resources/upgrade";
import { monthlyCostUsd } from "@/lib/cost/pricing";
import { db, q, save } from "@/lib/db/store";
import {
  EnvironmentClass,
  id,
  type CloudConnection,
  type Deployment,
  type Environment,
  type Project,
} from "@/lib/domain/types";
import { providerRegistry } from "@/lib/providers/types";
import { slugify, uniqueName } from "@/lib/importers/types";
import { fmtUsd } from "@/lib/format";
import { requireConnection, requireEnvironment, requireProject } from "./_shared";

/* ------------------------------- connections ------------------------------ */

/**
 * The always-there sandbox connection, created on demand. Costs nothing,
 * grants nothing. `persist: false` (plan mode) returns the record it *would*
 * create without writing it — planning never leaves phantom rows behind.
 */
export function ensureSandboxConnection(workspaceId: string, persist = true): CloudConnection {
  const existing = db().connections.find(
    (c) => c.workspaceId === workspaceId && c.provider === "sandbox"
  );
  if (existing) return existing;
  const conn: CloudConnection = {
    id: id(),
    workspaceId,
    provider: "sandbox",
    label: "Sandbox",
    region: "local",
    status: "healthy",
    grantedPermissions: ["No cloud access — the sandbox runs inside Zenith and simulates deployments."],
    createdAt: new Date().toISOString(),
  };
  if (persist) {
    db().connections.push(conn);
    save();
  }
  return conn;
}

/** Honest one-liner about what deploying through this connection actually does. */
export function connectionLabel(conn: CloudConnection): string {
  const adapter = providerRegistry().get(conn.provider);
  if (!adapter) return `${conn.provider} (${conn.region})`;
  return `${adapter.displayName} (${conn.region}) — ${adapter.availability}: ${adapter.tagline.replace(/\.$/, "")}`;
}

/* ------------------------------ shared guards ----------------------------- */

/** Statuses where the engine still owns the environment. */
const IN_FLIGHT: Deployment["status"][] = [
  "planning",
  "awaiting_approval",
  "applying",
  "verifying",
  "rolling_back",
];

/**
 * The deployment currently occupying an environment, if any. Every action that
 * changes what an environment *is* asks this first, so a rename or a delete
 * can never land underneath a running deploy.
 */
export function inFlight(environmentId: string): Deployment | undefined {
  return q.deploymentsOf(environmentId).find((d) => IN_FLIGHT.includes(d.status));
}

/**
 * The dispatch/concurrency decision for an environment (PROD-DUR-02). For real
 * (workflow-executed) deployments it reads the platform authority record, never
 * the product Deployment projection. Only simulator deployments, which have no
 * platform operation, are decided from the product store. Without an open
 * platform store (local memory mode) the product record is all there is.
 */
export async function environmentBusy(ctx: { workspaceId: string }, environmentId: string): Promise<{ status: string; source: "authority" | "product" } | undefined> {
  const product = inFlight(environmentId);
  const simulated = product && product.executor !== "workflow" ? product : undefined;
  try {
    const { isMemoryStoreEnabled } = await import("@/lib/capabilities/platform");
    if (isMemoryStoreEnabled()) return product ? { status: product.status, source: "product" } : undefined;
    const [{ platformDb }, { environmentActivity }] = await Promise.all([import("@/lib/controlplane/db"), import("@/lib/controlplane/authority")]);
    const active = await environmentActivity(await platformDb(), ctx.workspaceId, environmentId);
    if (active[0]) return { status: active[0].status, source: "authority" };
    return simulated ? { status: simulated.status, source: "product" } : undefined;
  } catch {
    // A missing or terminal projection cannot prove authoritative work is idle.
    return { status: "authority_unavailable", source: "authority" };
  }
}

export const activityUnavailableMessage = "Zenith cannot check current deployment activity. Try again when the deployment service is available.";
export const teardownSettlingMessage = "Earlier deploy activity has not settled yet. Teardown can start once every earlier deploy credential and workflow has provably stopped: about 80 minutes after an AWS deploy's last credential expires. Activity through static credentials, runners or other providers does not settle on its own.";
export const teardownUntrackedMessage = "This environment has deploy history from before Zenith tracked deploy writers, so Zenith cannot tear it down. Remove its resources with provider tooling; Zenith then verifies absence.";

/** The cleanup barrier's earlier-delivery inventory, read up front so a teardown is refused before approval instead of after. */
export async function teardownSettling(ctx: { workspaceId: string }, env: { id: string; projectId: string }): Promise<string | undefined> {
  try {
    const { isMemoryStoreEnabled } = await import("@/lib/capabilities/platform");
    if (isMemoryStoreEnabled()) return undefined;
    const [{ platformDb }, { cleanupWriterBarriers }] = await Promise.all([import("@/lib/controlplane/db"), import("@/lib/controlplane/db/repos")]);
    const inventory = await cleanupWriterBarriers.preview(await platformDb(), ctx.workspaceId, env.projectId, env.id);
    if (inventory.unknownHistory) return teardownUntrackedMessage;
    return inventory.grants || inventory.handoffs || inventory.reservations ? teardownSettlingMessage : undefined;
  } catch {
    // The worker barrier stays the authority; an unreadable inventory cannot be shown as drained.
    return activityUnavailableMessage;
  }
}

/** "revision 4" when an environment is running one, else undefined. */
export function liveRevision(env: Environment): string | undefined {
  if (!env.deployedRevisionId) return undefined;
  const rev = q.revision(env.deployedRevisionId);
  return rev ? `revision ${rev.number}` : "a revision Zenith no longer holds";
}

/* ------------------------------ env.create -------------------------------- */

export function baseDomainFor(project: Project, name: string, klass: EnvironmentClass): string {
  return klass === "production"
    ? `${project.slug}.zenith.app`
    : `${name}.${project.slug}.zenith.app`;
}

const CreateEnv = z.object({
  projectId: z.string().optional(),
  name: z.string().min(1).optional(),
  class: EnvironmentClass.optional(),
  connectionId: z.string().optional(),
  region: z.string().optional(),
  approvalRequired: z.boolean().optional(),
  budgetUsdMonthly: z.number().positive().optional(),
});
type CreateEnv = z.infer<typeof CreateEnv>;

/**
 * Shared by env.create, project.create, project.applyBlueprint and
 * project.importCompose. Allocates the record; the caller stores it.
 *
 * It takes the whole ActionContext rather than a bare workspaceId because the
 * connection has to be resolved *inside* the caller's tenant. Reading
 * `input.connectionId` out of the whole store let a caller create an
 * environment in their own workspace that deploys through someone else's cloud
 * account — the environment looked ordinary, and every later deploy went to a
 * stranger's connection. `requireConnection` scopes the lookup, and gives a
 * foreign id the same sentence as an id that was never real.
 */
export function buildEnvironment(
  project: Project,
  input: CreateEnv,
  ctx: ActionContext,
  persist = true
): { env: Environment; connection: CloudConnection } {
  const klass = input.class ?? "sandbox";
  const taken = q.environmentsOf(project.id).map((e) => e.name);
  const name = uniqueName(slugify(input.name ?? klass, klass), taken);
  const conn = input.connectionId
    ? requireConnection(ctx, input.connectionId)
    : ensureSandboxConnection(ctx.workspaceId, persist);

  return {
    connection: conn,
    env: {
      id: id(),
      projectId: project.id,
      name,
      class: klass,
      connectionId: conn.id,
      region: input.region ?? conn.region,
      policies: {
        approvalRequired: input.approvalRequired ?? klass === "production",
        budgetUsdMonthly: input.budgetUsdMonthly,
        allowStatefulDeletion: false,
      },
      baseDomain: baseDomainFor(project, name, klass),
      createdAt: new Date().toISOString(),
    },
  };
}

export function envPlanDetails(project: Project, env: Environment, conn: CloudConnection): string[] {
  return [
    `Class "${env.class}" in ${env.region}.`,
    `Deploys through ${connectionLabel(conn)}.`,
    `Managed routes get hostnames under ${env.baseDomain}.`,
    env.policies.approvalRequired
      ? `Approval required before anything is applied${env.class === "production" ? " — the default for production environments" : ""}. Change it in Settings → Environments.`
      : "Deploys apply as soon as they are started. Turn on approval in Settings → Environments if you want a gate.",
    env.policies.budgetUsdMonthly
      ? `Budget ${fmtUsd(env.policies.budgetUsdMonthly)}/month; plans that exceed it are flagged before you deploy.`
      : "No budget set. Set one with env.setBudget to get warned before a plan gets expensive.",
    `Creating an environment costs nothing on its own — the current system would cost ${fmtUsd(monthlyCostUsd(v1View(project.workingManifest)))}/month once deployed (estimate).`,
  ];
}

defineAction<CreateEnv>({
  id: "env.create",
  title: "Create environment",
  category: "environment",
  risk: "low",
  requiredRole: "editor",
  mutates: true,
  input: CreateEnv,
  plan(ctx, input) {
    const project = requireProject(ctx, input.projectId);
    const { env, connection } = buildEnvironment(project, input, ctx, false);
    return {
      summary: `Create the "${env.name}" environment for ${project.name}.`,
      details: envPlanDetails(project, env, connection),
      costDeltaUsd: 0,
      risk: "low",
      warnings: [],
      requiresApproval: false,
    };
  },
  execute(ctx, input) {
    const project = requireProject(ctx, input.projectId);
    const { env } = buildEnvironment(project, input, ctx);
    db().environments.push(env);
    save();
    return {
      ok: true,
      summary: `Created environment "${env.name}" (${env.class}). Nothing is deployed to it yet.`,
      data: { environmentId: env.id, name: env.name, baseDomain: env.baseDomain },
    };
  },
});

/* --------------------------- env.updatePolicies --------------------------- */

const UpdatePolicies = z.object({
  environmentId: z.string().optional(),
  approvalRequired: z.boolean().optional(),
  allowStatefulDeletion: z.boolean().optional(),
});
type UpdatePolicies = z.infer<typeof UpdatePolicies>;

function policyChanges(env: Environment, input: UpdatePolicies): { details: string[]; warnings: string[] } {
  const details: string[] = [];
  const warnings: string[] = [];
  if (input.approvalRequired !== undefined && input.approvalRequired !== env.policies.approvalRequired) {
    details.push(
      input.approvalRequired
        ? `Deploys to ${env.name} will wait for a human to approve them.`
        : `Deploys to ${env.name} will apply immediately, with no approval step.`
    );
    if (!input.approvalRequired && env.class === "production")
      warnings.push(`${env.name} is a production environment. Without approval, any deploy applies straight away.`);
  }
  if (input.allowStatefulDeletion !== undefined && input.allowStatefulDeletion !== env.policies.allowStatefulDeletion) {
    details.push(
      input.allowStatefulDeletion
        ? `Plans that destroy databases, caches, queues or buckets in ${env.name} will be allowed to run.`
        : `Plans that destroy stateful resources in ${env.name} will be blocked.`
    );
    if (input.allowStatefulDeletion)
      warnings.push("Deleting a stateful resource destroys its data. Rollback restores the manifest, not the data.");
  }
  if (details.length === 0) details.push("No policy values changed.");
  return { details, warnings };
}

defineAction<UpdatePolicies>({
  id: "env.updatePolicies",
  title: "Update environment policies",
  category: "environment",
  risk: "medium",
  requiredRole: "admin",
  mutates: true,
  input: UpdatePolicies,
  plan(ctx, input) {
    const env = requireEnvironment(ctx, input.environmentId);
    const { details, warnings } = policyChanges(env, input);
    return {
      summary: `Update deployment policy for "${env.name}".`,
      details,
      costDeltaUsd: 0,
      risk: "medium",
      warnings,
      requiresApproval: false,
    };
  },
  execute(ctx, input) {
    const env = requireEnvironment(ctx, input.environmentId);
    const { details } = policyChanges(env, input);
    if (input.approvalRequired !== undefined) env.policies.approvalRequired = input.approvalRequired;
    if (input.allowStatefulDeletion !== undefined) env.policies.allowStatefulDeletion = input.allowStatefulDeletion;
    save();
    return { ok: true, summary: `Policies updated for "${env.name}". ${details[0]}`, data: { environmentId: env.id, policies: env.policies } };
  },
});

/* ------------------------------ env.setBudget ----------------------------- */

const SetBudget = z.object({
  environmentId: z.string().optional(),
  /** null clears the budget */
  budgetUsdMonthly: z.number().positive().nullable(),
});
type SetBudget = z.infer<typeof SetBudget>;

function budgetDetails(env: Environment, projectMonthly: number, budget: number | null): { details: string[]; warnings: string[] } {
  if (budget === null)
    return {
      details: [`Removes the budget on ${env.name}. Plans will no longer be checked against a limit.`],
      warnings: [],
    };
  const details = [
    `Sets a ${fmtUsd(budget)}/month budget on ${env.name}.`,
    `The current system is estimated at ${fmtUsd(projectMonthly)}/month, ${projectMonthly > budget ? "over" : "under"} that.`,
    "Budgets warn before a deploy; they never stop a running system or delete anything.",
  ];
  const warnings = projectMonthly > budget
    ? [`The system already costs more than this budget (${fmtUsd(projectMonthly)} vs ${fmtUsd(budget)}). Every plan will be flagged until you resize or raise the budget.`]
    : [];
  return { details, warnings };
}

defineAction<SetBudget>({
  id: "env.setBudget",
  title: "Set budget",
  category: "environment",
  risk: "low",
  requiredRole: "admin",
  mutates: true,
  input: SetBudget,
  plan(ctx, input) {
    const env = requireEnvironment(ctx, input.environmentId);
    const project = requireProject(ctx, env.projectId);
    const { details, warnings } = budgetDetails(env, monthlyCostUsd(v1View(project.workingManifest)), input.budgetUsdMonthly);
    return {
      summary: input.budgetUsdMonthly === null ? `Remove the budget on "${env.name}".` : `Set a ${fmtUsd(input.budgetUsdMonthly)}/month budget on "${env.name}".`,
      details,
      costDeltaUsd: 0,
      risk: "low",
      warnings,
      requiresApproval: false,
    };
  },
  execute(ctx, input) {
    const env = requireEnvironment(ctx, input.environmentId);
    env.policies.budgetUsdMonthly = input.budgetUsdMonthly ?? undefined;
    save();
    return {
      ok: true,
      summary:
        input.budgetUsdMonthly === null
          ? `Budget removed from "${env.name}".`
          : `Budget for "${env.name}" set to ${fmtUsd(input.budgetUsdMonthly)}/month (estimates, checked at plan time).`,
      data: { environmentId: env.id, budgetUsdMonthly: env.policies.budgetUsdMonthly ?? null },
    };
  },
});

/* ------------------------------- env.update ------------------------------- */

const UpdateEnv = z.object({
  environmentId: z.string().optional(),
  name: z.string().min(1).optional(),
  region: z.string().optional(),
});
type UpdateEnv = z.infer<typeof UpdateEnv>;

/**
 * One reading of a rename/region change, shared by plan and execute so the
 * refusal a plan shows is character-for-character the one execute would give.
 */
async function envUpdate(ctx: ActionContext, input: UpdateEnv) {
  const env = requireEnvironment(ctx, input.environmentId);
  const project = requireProject(ctx, env.projectId);
  const name = input.name?.trim();
  const region = input.region?.trim();
  const adapter = providerRegistry().get(q.connection(env.connectionId)?.provider ?? "sandbox");

  const details: string[] = [];
  const warnings: string[] = [];
  let blocked: string | undefined;

  const busy = await environmentBusy(ctx, env.id);
  if (busy)
    blocked = busy.status === "authority_unavailable"
      ? activityUnavailableMessage
      : `A deployment is ${busy.status} on ${env.name} right now. Wait for it to finish, or cancel it on the Deploys page, then try again.`;

  if (name && name !== env.name) {
    if (!blocked && q.environmentsOf(project.id).some((e) => e.id !== env.id && e.name === name))
      blocked = `${project.name} already has an environment called "${name}". Pick another name.`;
    const nextDomain = baseDomainFor(project, name, env.class);
    details.push(`Renames "${env.name}" to "${name}".`);
    if (nextDomain === env.baseDomain) {
      details.push(
        `Managed routes keep answering on ${env.baseDomain} — production hostnames follow the project slug, not the environment name.`
      );
    } else {
      details.push(
        `Managed routes move from ${env.baseDomain} to ${nextDomain} — at the next deploy, not now.`
      );
      if (env.deployedRevisionId)
        warnings.push(
          `${env.name} is running ${liveRevision(env)} and still answers on ${env.baseDomain}. The new hostnames exist only after you deploy again.`
        );
    }
  }

  if (region && region !== env.region) {
    if (!blocked && adapter?.regions.length && !adapter.regions.some((r) => r.id === region))
      blocked = `${adapter.displayName} has no region "${region}". Pick one of: ${adapter.regions.map((r) => r.id).join(", ")}.`;
    details.push(`Changes the region from ${env.region} to ${region}.`);
    warnings.push(
      `Changing the region moves nothing that is already running. ${
        env.deployedRevisionId
          ? `${liveRevision(env)} stays where it was deployed until the next deploy.`
          : "It applies from the next deploy."
      }`
    );
  }

  if (details.length === 0)
    details.push("Nothing changes — the name and region sent are the ones already set.");
  return { env, project, name, region, details, warnings, blocked };
}

defineAction<UpdateEnv>({
  id: "env.update",
  title: "Rename environment",
  category: "environment",
  risk: "medium",
  requiredRole: "admin",
  mutates: true,
  input: UpdateEnv,
  async plan(ctx, input) {
    const { env, details, warnings, blocked } = await envUpdate(ctx, input);
    return {
      summary: `Update the "${env.name}" environment.`,
      details,
      costDeltaUsd: 0,
      risk: "medium",
      warnings,
      requiresApproval: false,
      blocked,
    };
  },
  async execute(ctx, input) {
    const { env, project, name, region, blocked } = await envUpdate(ctx, input);
    if (blocked) return { ok: false, summary: `"${env.name}" was not changed.`, error: blocked };
    const was = env.name;
    if (name && name !== env.name) {
      env.name = name;
      env.baseDomain = baseDomainFor(project, name, env.class);
    }
    if (region) env.region = region;
    save();
    return {
      ok: true,
      summary:
        name && name !== was
          ? `Renamed "${was}" to "${env.name}". Managed routes use ${env.baseDomain} from the next deploy.`
          : `Updated "${env.name}" — region ${env.region}, from the next deploy.`,
      data: { environmentId: env.id, name: env.name, region: env.region, baseDomain: env.baseDomain },
    };
  },
});

/* -------------------------------- env.clone ------------------------------- */

const CloneEnv = z.object({
  environmentId: z.string().optional(),
  name: z.string().min(1),
});
type CloneEnv = z.infer<typeof CloneEnv>;

function envClone(ctx: ActionContext, input: CloneEnv) {
  const src = requireEnvironment(ctx, input.environmentId);
  const project = requireProject(ctx, src.projectId);
  const name = slugify(input.name.trim(), src.class);
  const connection = q.connection(src.connectionId);

  let blocked: string | undefined;
  if (q.environmentsOf(project.id).some((e) => e.name === name))
    blocked = `${project.name} already has an environment called "${name}". Pick another name.`;
  else if (!connection)
    blocked = `${src.name} points at connection "${src.connectionId}", which no longer exists. Point it at another connection first, then clone it.`;

  const env: Environment = {
    id: id(),
    projectId: project.id,
    name,
    class: src.class,
    connectionId: src.connectionId,
    region: src.region,
    policies: { ...src.policies },
    baseDomain: baseDomainFor(project, name, src.class),
    createdAt: new Date().toISOString(),
  };
  return { src, project, env, connection, blocked };
}

defineAction<CloneEnv>({
  id: "env.clone",
  title: "Clone environment",
  category: "environment",
  risk: "low",
  requiredRole: "editor",
  mutates: true,
  input: CloneEnv,
  plan(ctx, input) {
    const { src, project, env, connection, blocked } = envClone(ctx, input);
    return {
      summary: `Clone "${src.name}" into a new environment called "${env.name}".`,
      details: [
        `Copies ${src.name}: class, connection, region, budget and deploy policy — nothing else.`,
        ...(connection ? envPlanDetails(project, env, connection) : []),
        `Nothing is deployed to it. ${src.name} is running ${liveRevision(src) ?? "nothing"}; the clone stays empty until you deploy to it.`,
      ],
      costDeltaUsd: 0,
      risk: "low",
      warnings:
        src.class === "production"
          ? [
              "The clone is a production environment: production defaults, production ring, real deploys. Create a staging environment instead if this is a rehearsal.",
            ]
          : [],
      requiresApproval: false,
      blocked,
    };
  },
  execute(ctx, input) {
    const { src, env, blocked } = envClone(ctx, input);
    if (blocked) return { ok: false, summary: "Nothing was cloned.", error: blocked };
    db().environments.push(env);
    save();
    return {
      ok: true,
      summary: `Cloned ${src.name} into "${env.name}" (${env.class}). Nothing is deployed to it yet.`,
      data: { environmentId: env.id, name: env.name, baseDomain: env.baseDomain },
    };
  },
});

/* --------------------------- env.setConnection ---------------------------- */

const SetConnection = z.object({
  environmentId: z.string().optional(),
  connectionId: z.string().min(1),
});
type SetConnection = z.infer<typeof SetConnection>;

async function envSetConnection(ctx: ActionContext, input: SetConnection) {
  const env = requireEnvironment(ctx, input.environmentId);
  const current = q.connection(env.connectionId);
  const next = q.connection(input.connectionId);
  const busy = await environmentBusy(ctx, env.id);

  let blocked: string | undefined;
  if (!next || next.workspaceId !== ctx.workspaceId)
    blocked = `Connection "${input.connectionId}" is not in this workspace. Pick one from Settings → Connections, or connect a cloud first.`;
  else if (next.id === env.connectionId) blocked = `${env.name} already deploys through ${next.label}.`;
  else if (busy)
    blocked = busy.status === "authority_unavailable"
      ? activityUnavailableMessage
      : `A deployment is ${busy.status} on ${env.name} right now. Wait for it to finish, or cancel it on the Deploys page, then move the environment.`;

  const details: string[] = [];
  const warnings: string[] = [];
  if (next) {
    const adapter = providerRegistry().get(next.provider);
    details.push(
      `${env.name} will deploy through ${connectionLabel(next)}.`,
      `Anything already running through ${current?.label ?? "the previous connection"} keeps running. Zenith does not migrate it, copy it or delete it.`,
      next.region === env.region
        ? `The environment stays in ${env.region}.`
        : `The environment's region stays ${env.region} while ${next.label} operates in ${next.region}. Change it with the rename form if they should match.`
    );
    if (adapter && adapter.availability !== "available")
      warnings.push(
        `${adapter.displayName} is ${adapter.availability}: Zenith plans and exports for it, but a deploy to ${env.name} will be refused until it is available.`
      );
    if (next.status !== "healthy")
      warnings.push(
        `${next.label} is ${next.status}. Deploys through it are refused until a check passes — run Check on the connection.`
      );
    if (env.deployedRevisionId)
      warnings.push(
        `${env.name} is running ${liveRevision(env)} through ${current?.label ?? "its old connection"}. The next deploy goes to ${next.label} and starts from nothing there.`
      );
  }
  return { env, current, next, details, warnings, blocked };
}

defineAction<SetConnection>({
  id: "env.setConnection",
  title: "Move environment to another connection",
  category: "environment",
  risk: "medium",
  requiredRole: "admin",
  mutates: true,
  input: SetConnection,
  async plan(ctx, input) {
    const { env, next, details, warnings, blocked } = await envSetConnection(ctx, input);
    return {
      summary: next
        ? `Point "${env.name}" at ${next.label}.`
        : `"${env.name}" cannot be pointed at that connection.`,
      details,
      costDeltaUsd: 0,
      risk: "medium",
      warnings,
      requiresApproval: false,
      blocked,
    };
  },
  async execute(ctx, input) {
    const { env, next, blocked } = await envSetConnection(ctx, input);
    if (blocked || !next) return { ok: false, summary: `"${env.name}" was not moved.`, error: blocked };
    env.connectionId = next.id;
    save();
    return {
      ok: true,
      summary: `${env.name} now deploys through ${next.label}. Nothing running was moved or deleted.`,
      data: { environmentId: env.id, connectionId: next.id },
    };
  },
});

/* ------------------------------- env.delete ------------------------------- */

const DeleteEnv = z.object({ environmentId: z.string().optional() });
type DeleteEnv = z.infer<typeof DeleteEnv>;

async function envDelete(ctx: ActionContext, input: DeleteEnv) {
  const env = requireEnvironment(ctx, input.environmentId);
  const project = requireProject(ctx, env.projectId);
  const siblings = q.environmentsOf(project.id).filter((e) => e.id !== env.id);
  const deployments = q.deploymentsOf(env.id);
  const live = liveRevision(env);
  const busy = await environmentBusy(ctx, env.id);

  let blocked: string | undefined;
  if (busy)
    blocked = busy.status === "authority_unavailable"
      ? activityUnavailableMessage
      : `A deployment is ${busy.status} on ${env.name}. Wait for it to finish, or cancel it on the Deploys page, then delete the environment.`;
  else if (siblings.length === 0)
    blocked = `${env.name} is the only environment in ${project.name}, and every project screen needs one. Create another environment first, or delete the whole project in Settings → Danger zone.`;

  const details = [
    `Removes the environment record, its budget and its deploy policy from ${project.name}.`,
    `${deployments.length} deployment record(s) go with it. The revision history stays — revisions belong to the project, not to one environment.`,
    "Nothing in your cloud or in the sandbox is torn down: this deletes Zenith's records, not running infrastructure.",
    siblings.length
      ? `${siblings.length} other environment(s) are untouched: ${siblings.map((e) => e.name).join(", ")}.`
      : "",
  ].filter(Boolean);

  const warnings = live
    ? [
        `${env.name} is running ${live}. Deleting the environment does not stop it — Zenith simply stops watching it. Tear it down first if you want it gone.`,
      ]
    : [];

  return { env, project, deployments, live, details, warnings, blocked };
}

defineAction<DeleteEnv>({
  id: "env.delete",
  title: "Delete environment",
  category: "environment",
  risk: "high",
  requiredRole: "admin",
  mutates: true,
  input: DeleteEnv,
  async plan(ctx, input) {
    const { env, live, details, warnings, blocked } = await envDelete(ctx, input);
    return {
      summary: `Delete the "${env.name}" environment.`,
      details,
      costDeltaUsd: 0,
      risk: live || env.class === "production" ? "high" : "medium",
      warnings,
      requiresApproval: false,
      blocked,
    };
  },
  async execute(ctx, input) {
    const { env, project, deployments, blocked } = await envDelete(ctx, input);
    if (blocked) return { ok: false, summary: `"${env.name}" was not deleted.`, error: blocked };
    const d = db();
    d.environments = d.environments.filter((e) => e.id !== env.id);
    d.deployments = d.deployments.filter((dep) => dep.environmentId !== env.id);
    save();
    return {
      ok: true,
      summary: `Deleted "${env.name}" from ${project.name}, with ${deployments.length} deployment record(s). Nothing running was torn down.`,
      data: { environmentId: env.id, name: env.name, deploymentsRemoved: deployments.length },
    };
  },
});
