/**
 * Deployment actions. `deploy.plan` is read-only and returns the Changeset the
 * Changes drawer renders; `deploy.apply` snapshots a Revision and hands it to
 * the engine for simulated providers or the broker/workflow bridge for linked,
 * verified real providers. Product approval and deletion policies still apply.
 */
import { z } from "zod";
import { defineAction, type ActionContext, type ActionPlan } from "@/lib/actions/core";
import { db, q, revisionManifestAsync, save } from "@/lib/db/store";
import { diffManifests, validateManifest } from "@/lib/domain/graph";
import {
  emptyManifest,
  id,
  type Changeset,
  type Environment,
  type AnyManifest,
  type Project,
  type Revision,
} from "@/lib/domain/types";
import { getEngine } from "./_engine";
import { isV2 } from "@/lib/resources/manifest-v2";
import { fmtUsd } from "@/lib/format";
import { executionRoute, addWorkflowCheck, startWorkflowDeployment, startWorkflowRollback } from "@/lib/bridge/deploy";
import { approveWorkflowDeployment, cancelWorkflowDeployment, workflowApprovalPlan } from "@/lib/bridge/lifecycle";
import { providerBlock, connectionBlock, statefulDeletionBlock, approvalSeparation } from "@/lib/bridge/guards";
import { findSecret } from "@/lib/capabilities/secret-guard";
import {
  clone,
  maxRisk,
  requireDeployment,
  requireEnvironment,
  requireProject,
  requireRevision,
} from "./_shared";

/**
 * Everything that makes `deploy.apply` refuse, decided once and rendered as
 * `plan.blocked` so no surface has to infer it from warning prose.
 */
async function deployBlock(env: Environment, project: Project, cs: Changeset): Promise<string | undefined> {
  const reasons = [
    await providerBlock(env),
    connectionBlock(env),
    await statefulDeletionBlock(env, cs),
    ...blockingIssues(project.workingManifest),
  ].filter((r): r is string => Boolean(r));
  return reasons.length ? reasons.join(" ") : undefined;
}

/**
 * The manifest currently live in an environment (empty if never deployed).
 * Loaded from cold storage on demand — see `q.revisionManifest`.
 */
export function deployedManifest(env: Environment): AnyManifest {
  const id = env.deployedRevisionId;
  return (id ? q.revisionManifest(id) : undefined) ?? emptyManifest();
}

export async function deployedManifestAsync(env: Environment): Promise<AnyManifest> {
  const revisionId = env.deployedRevisionId;
  return (revisionId ? await revisionManifestAsync(revisionId) : undefined) ?? emptyManifest();
}

export function changesetFor(env: Environment, project: Project): Changeset {
  return diffManifests(deployedManifest(env), project.workingManifest);
}

export async function changesetForAsync(env: Environment, project: Project): Promise<Changeset> {
  return diffManifests(await deployedManifestAsync(env), project.workingManifest);
}

function tally(cs: Changeset): string {
  const n = (op: string) => cs.items.filter((i) => i.op === op).length;
  const parts = [
    n("create") && `${n("create")} added`,
    n("update") && `${n("update")} changed`,
    n("delete") && `${n("delete")} removed`,
  ].filter(Boolean);
  return parts.length ? parts.join(", ") : "no changes";
}

function budgetWarnings(env: Environment, cs: Changeset): string[] {
  const budget = env.policies.budgetUsdMonthly;
  if (!budget || cs.projectedMonthlyUsd <= budget) return [];
  return [
    `This plan puts ${env.name} at ${fmtUsd(cs.projectedMonthlyUsd)}/month, over its ${fmtUsd(budget)} budget (estimates). Resize something, or raise the budget in Settings → Environments.`,
  ];
}

function blockingIssues(m: AnyManifest): string[] {
  return validateManifest(m)
    .filter((i) => i.level === "error")
    .map((i) => `${i.message}${i.fix ? ` ${i.fix}` : ""}`);
}

async function deployPlan(ctx: ActionContext, env: Environment, project: Project): Promise<ActionPlan> {
  const cs = await changesetForAsync(env, project);
  const blocked = await deployBlock(env, project, cs);
  const warnings = validateManifest(project.workingManifest)
    .filter((i) => i.level === "warning")
    .map((i) => `${i.message}${i.fix ? ` ${i.fix}` : ""}`);

  const plan: ActionPlan = {
    summary: blocked
      ? `${project.name} cannot be deployed to ${env.name} — ${tally(cs)} is what would change, but this deploy would be refused.`
      : `Deploy ${project.name} to ${env.name} — ${tally(cs)}.`,
    details: [
      ...(blocked ? [blocked] : []),
      ...cs.items.map((i) => i.explanation),
      `Projected monthly cost after this deploy: ${fmtUsd(cs.projectedMonthlyUsd)} (estimate).`,
      env.policies.approvalRequired
        ? `${env.name} requires approval: the deployment will wait at "awaiting approval" until someone approves it.`
        : `${env.name} applies without an approval step.`,
    ],
    costDeltaUsd: cs.totalCostDeltaUsd,
    risk: maxRisk(cs.items.map((i) => i.risk)),
    // Warnings are advisory only. Anything that stops the deploy is in
    // `blocked`, so a surface disables its button instead of parsing prose.
    warnings: [...cs.warnings, ...budgetWarnings(env, cs), ...warnings],
    requiresApproval: env.policies.approvalRequired,
    blocked,
    /**
     * Both deploy.plan (read-only) and deploy.apply render through here, and
     * the button a user presses is deploy.apply. Say so, so a viewer sees a
     * disabled Deploy with a reason instead of a refusal after the click.
     */
    requiredRole: "editor",
  };
  if ((await executionRoute(env)).kind === "workflow") await addWorkflowCheck(ctx, env, plan);
  return plan;
}

/* -------------------------------- deploy.plan ------------------------------ */

const PlanInput = z.object({
  projectId: z.string().optional(),
  environmentId: z.string().optional(),
});
type PlanInput = z.infer<typeof PlanInput>;

defineAction<PlanInput>({
  id: "deploy.plan",
  title: "Plan deployment",
  category: "deploy",
  risk: "low",
  requiredRole: "viewer",
  mutates: false,
  input: PlanInput,
  async plan(ctx, input) {
    const env = requireEnvironment(ctx, input.environmentId);
    return await deployPlan(ctx, env, requireProject(ctx, input.projectId ?? env.projectId));
  },
  async execute(ctx, input) {
    const env = requireEnvironment(ctx, input.environmentId);
    const project = requireProject(ctx, input.projectId ?? env.projectId);
    const changeset = await changesetForAsync(env, project);
    return {
      ok: true,
      summary: `${tally(changeset)} between ${project.name}'s working copy and ${env.name}.`,
      data: { changeset, environmentId: env.id, blocking: blockingIssues(project.workingManifest) },
    };
  },
});

/* ------------------------------- deploy.apply ------------------------------ */

const ApplyInput = z.object({
  projectId: z.string().optional(),
  environmentId: z.string().optional(),
  message: z.string().optional(),
});
type ApplyInput = z.infer<typeof ApplyInput>;

defineAction<ApplyInput>({
  id: "deploy.apply",
  title: "Deploy",
  category: "deploy",
  risk: "high",
  requiredRole: "editor",
  mutates: true,
  input: ApplyInput,
  async plan(ctx, input) {
    const env = requireEnvironment(ctx, input.environmentId);
    return await deployPlan(ctx, env, requireProject(ctx, input.projectId ?? env.projectId));
  },
  async execute(ctx, input) {
    const env = requireEnvironment(ctx, input.environmentId);
    const project = requireProject(ctx, input.projectId ?? env.projectId);
    const working = project.workingManifest;

    // Refuse before a revision is snapshotted or a deployment record exists.
    const route = await executionRoute(env);
    const providerRefusal = (await providerBlock(env, route)) ?? connectionBlock(env);
    if (providerRefusal)
      return {
        ok: false,
        summary: `${env.name} cannot be deployed to right now.`,
        error: providerRefusal,
      };

    const errors = blockingIssues(working);
    if (errors.length)
      return {
        ok: false,
        summary: `${project.name} cannot be deployed yet — ${errors.length} problem(s) to fix first.`,
        error: errors.join(" "),
      };
    // A V2 manifest also deploys functions and native nodes, so one holding only those is not empty.
    if (working.services.length === 0 && working.resources.length === 0 && !(isV2(working) && (working.functions?.length || working.native?.length)))
      return {
        ok: false,
        summary: "There is nothing to deploy.",
        error: "The system is empty. Add a service or a resource first, or apply a blueprint.",
      };

    const changeset = await changesetForAsync(env, project);
    if (changeset.items.length === 0 && env.deployedRevisionId)
      return {
        ok: false,
        summary: `${env.name} already runs this exact system.`,
        error: "Nothing has changed since the last deploy. Edit the system, or restart a service with ops.restartService.",
      };

    // The same gate the plan renders as `blocked`, enforced again here. A plan
    // is a courtesy, not a checkpoint: `runAction` can be called straight in
    // execute mode, so a refusal that only exists in plan mode is advice, not a
    // policy. This is the wall.
    const statefulRefusal = await statefulDeletionBlock(env, changeset);
    if (statefulRefusal)
      return {
        ok: false,
        summary: `${env.name} does not allow removing a resource that holds data.`,
        error: statefulRefusal,
      };

    if (route.kind === "workflow" && findSecret(input.message))
      return { ok: false, summary: "Deployment message refused.", error: "Remove secret material from the message; use references only." };
    const number = q.revisionsOf(project.id).reduce((max, r) => Math.max(max, r.number), 0) + 1;
    const changeSummary = tally(changeset);
    const revision: Revision = {
      id: id(),
      projectId: project.id,
      number,
      manifest: clone(working),
      message: input.message?.trim() || `${changeSummary} (${env.name})`,
      author: ctx.actor,
      createdAt: new Date().toISOString(),
    };
    db().revisions.push(revision);
    // The save moves the manifest to cold storage; `revision.manifest` keeps
    // reading it back through the store's accessor.
    save(project.id);

    if (route.kind === "workflow") return startWorkflowDeployment({ ctx, env, revision, changeset, changeSummary });
    const engine = await getEngine();
    const deployment = await engine.start({
      projectId: project.id,
      environmentId: env.id,
      revisionId: revision.id,
      changeSummary,
      estCostDeltaUsd: changeset.totalCostDeltaUsd,
      actorName: ctx.actor.name,
      actorId: ctx.actor.id,
      actorType: ctx.actor.type === "navigator" ? "navigator" : "user",
      approved: !env.policies.approvalRequired,
    });

    return {
      ok: true,
      summary:
        deployment.status === "awaiting_approval"
          ? `Revision ${number} is waiting for approval on ${env.name} (${changeSummary}).`
          : `Deploying revision ${number} to ${env.name} (${changeSummary}).`,
      data: {
        deploymentId: deployment.id,
        status: deployment.status,
        revisionId: revision.id,
        revisionNumber: number,
        changeset,
      },
    };
  },
});

/* ------------------- approve / cancel / rollback (engine) ------------------ */

const DeploymentRef = z.object({ deploymentId: z.string().min(1) });
type DeploymentRef = z.infer<typeof DeploymentRef>;
const DeploymentApproval = DeploymentRef.extend({ planDigest: z.string().regex(/^[a-f0-9]{64}$/).optional(), semanticsDigest: z.string().regex(/^[a-f0-9]{64}$/).optional() });
type DeploymentApproval = z.infer<typeof DeploymentApproval>;

/*
 * These three take an id and nothing else, which is exactly the shape that used
 * to walk out of the tenant. A local resolver read `q.deployment` across the
 * whole store, and the execute paths did not resolve at all — they handed the
 * caller's raw string to the engine, which is authoritative and asks no
 * questions. `requireDeployment` / `requireRevision` from ./_shared scope every
 * one of them to ctx.workspaceId, and a foreign id comes back with the same
 * sentence as an id that was never real. Plan and execute both, always: a plan
 * that renders someone else's changeSummary is a disclosure even if the execute
 * refuses, and an execute that runs is the whole estate.
 */

defineAction<DeploymentApproval>({
  id: "deploy.approve",
  title: "Approve deployment",
  category: "deploy",
  risk: "high",
  requiredRole: "admin",
  mutates: true,
  input: DeploymentApproval,
  async plan(ctx, input) {
    const d = requireDeployment(ctx, input.deploymentId);
    const env = q.environment(d.environmentId);
    const separation = approvalSeparation(ctx, d, env);
    if (d.executor === "workflow") {
      const plan = await workflowApprovalPlan(ctx, d);
      if (separation.blocked) plan.blocked = separation.blocked;
      if (separation.selfApproved) plan.details.push("Self-approved (sole admin): recorded in the audit summary.");
      return plan;
    }
    return {
      summary: `Approve and apply this deployment to ${env?.name ?? "its environment"}.`,
      details: [
        d.changeSummary,
        `${d.steps.length} step(s) will run.`,
        "This starts changing the environment immediately.",
        ...(separation.selfApproved
          ? [
              `You started this deployment and are the only admin of this workspace, so you may approve it; the audit log will record it as self-approved (sole admin).`,
            ]
          : []),
      ],
      costDeltaUsd: d.estCostDeltaUsd,
      risk: "high",
      warnings: [],
      requiresApproval: false,
      blocked:
        d.status === "awaiting_approval"
          ? separation.blocked
          : `This deployment is ${d.status}, not awaiting approval, so there is nothing to approve. Start a new deployment from the Changes drawer instead.`,
    };
  },
  async execute(ctx, input) {
    // Resolve first. The engine approves and immediately starts applying, so an
    // unresolved id here is a deployment running in someone else's account.
    const deployment = requireDeployment(ctx, input.deploymentId);
    // The same rule the plan renders as `blocked`, enforced again here: execute
    // can be called without a plan, and this is the wall.
    const separation = approvalSeparation(ctx, deployment, q.environment(deployment.environmentId));
    if (separation.blocked && deployment.status === "awaiting_approval")
      return {
        ok: false,
        summary: "You started this production deployment, so someone else has to approve it.",
        error: separation.blocked,
      };
    if (deployment.executor === "workflow") {
      const result = await approveWorkflowDeployment(ctx, deployment, input.planDigest, input.semanticsDigest);
      if (result.ok && separation.selfApproved) result.summary += " Self-approved (sole admin).";
      return result;
    }
    const engine = await getEngine();
    const d = await engine.approve(deployment.id);
    return {
      ok: true,
      summary: `Approved${separation.selfApproved ? " — self-approved (sole admin)" : ""}. Applying ${d.changeSummary}.`,
      data: { deploymentId: d.id, status: d.status },
    };
  },
});

defineAction<DeploymentRef>({
  id: "deploy.cancel",
  title: "Cancel deployment",
  category: "deploy",
  risk: "medium",
  requiredRole: "editor",
  mutates: true,
  input: DeploymentRef,
  plan(ctx, input) {
    const d = requireDeployment(ctx, input.deploymentId);
    const done = d.steps.filter((s) => s.status === "done").length;
    const finished = ["succeeded", "failed", "cancelled", "rolled_back"].includes(d.status);
    return {
      summary: "Cancel this deployment.",
      details: [
        ...(d.executor === "workflow" ? [`Cancellation routes through platform operation ${d.operationId}; running workflows stop by signal, and the worker records the outcome.`] : []),
        `${done} of ${d.steps.length} step(s) already finished; remaining steps are skipped.`,
        done > 0
          ? "Work already applied stays applied — cancelling stops the deployment, it does not undo it. Use rollback for that."
          : d.executor === "workflow" && d.workflowStartedAt ? "No completed steps are projected yet; cloud changes may already be underway." : "Nothing has been applied yet, so the environment is untouched.",
      ],
      costDeltaUsd: 0,
      risk: done > 0 ? "medium" : "low",
      warnings: done > 0 ? ["The environment is left part-way between two revisions. Roll back or deploy again to make it consistent."] : [],
      requiresApproval: false,
      blocked: finished
        ? `This deployment already finished as ${d.status}; there is nothing to cancel. Deploy again to change the environment, or roll back to undo it.`
        : undefined,
    };
  },
  async execute(ctx, input) {
    // Cancelling someone else's in-flight deployment leaves their environment
    // stranded between two revisions. Resolve inside the tenant first.
    const deployment = requireDeployment(ctx, input.deploymentId);
    if (deployment.executor === "workflow") return cancelWorkflowDeployment(ctx, deployment);
    const engine = await getEngine();
    const d = await engine.cancel(deployment.id);
    return { ok: true, summary: `Deployment cancelled after ${d.steps.filter((s) => s.status === "done").length} completed step(s).`, data: { deploymentId: d.id, status: d.status } };
  },
});

const RollbackInput = z.object({
  environmentId: z.string().optional(),
  toRevisionId: z.string().optional(),
});
type RollbackInput = z.infer<typeof RollbackInput>;

/**
 * The revision a rollback would deploy — resolved, never taken on trust.
 *
 * Two checks, because there are two different wrongs. `requireRevision` keeps a
 * stranger's revision out: the plan diffs the target into `details`, so a global
 * lookup renders another tenant's entire system to whoever asks, and the execute
 * then deploys that manifest into our live infrastructure. And `projectId` has
 * to match the environment's, because a revision of a *different* project — even
 * one we own — describes a system that was never here. The diff against it is a
 * fiction and the deploy would be real.
 *
 * The caller's own project is named in that second message on purpose: it is
 * theirs, so saying so leaks nothing. A revision belonging to another workspace
 * never reaches it — `requireRevision` has already refused with the same
 * sentence an invented id gets.
 */
function requireRollbackTarget(
  ctx: ActionContext,
  env: Environment,
  revisionId: string
): Revision {
  const rev = requireRevision(ctx, revisionId);
  if (rev.projectId !== env.projectId)
    throw new Error(
      `Revision "${revisionId}" belongs to a different project, so ${env.name} cannot be rolled back to it. Pick one from this project's history.`
    );
  return rev;
}

/** A refusal carried as a sentence, so plan can render it as `blocked`. */
type RollbackTarget = { revision: Revision } | { refusal: string };

const noEarlierRevision = (env: Environment) =>
  `${env.name} has no earlier revision to roll back to. ` +
  `Deploy at least one more revision, or pick a specific revision on the Revisions page.`;

/**
 * Explicit target: resolved in the caller's workspace, refusal text and all.
 * Implicit target: read off this environment's own deployment history, which is
 * already inside the tenant — if it no longer resolves there is simply nothing
 * to roll back to, which is the message that branch has always given.
 */
function rollbackTarget(
  ctx: ActionContext,
  env: Environment,
  toRevisionId?: string
): RollbackTarget {
  if (toRevisionId) {
    try {
      return { revision: requireRollbackTarget(ctx, env, toRevisionId) };
    } catch (err) {
      return { refusal: err instanceof Error ? err.message : String(err) };
    }
  }
  const previousId = q.deploymentsOf(env.id)[0]?.previousRevisionId;
  const previous = previousId ? q.revision(previousId) : undefined;
  if (!previous || previous.projectId !== env.projectId)
    return { refusal: noEarlierRevision(env) };
  return { revision: previous };
}

defineAction<RollbackInput>({
  id: "deploy.rollback",
  title: "Roll back",
  category: "deploy",
  risk: "high",
  requiredRole: "editor",
  mutates: true,
  input: RollbackInput,
  async plan(ctx, input) {
    const env = requireEnvironment(ctx, input.environmentId);
    const resolved = rollbackTarget(ctx, env, input.toRevisionId);
    const current = env.deployedRevisionId ? q.revision(env.deployedRevisionId) : undefined;
    // Nothing of the target is read — not its number, not its manifest — until
    // it has been resolved inside this workspace and this project.
    if ("refusal" in resolved)
      return {
        summary: `${env.name} cannot be rolled back.`,
        details: [resolved.refusal],
        costDeltaUsd: 0,
        risk: "low",
        warnings: [],
        requiresApproval: false,
        blocked: resolved.refusal,
      };
    const target = resolved.revision;
    const cs = diffManifests(current?.manifest ?? emptyManifest(), target.manifest);
    const blocked =
      [(await providerBlock(env)) ?? connectionBlock(env), await statefulDeletionBlock(env, cs, "rollback")]
        .filter((r): r is string => Boolean(r))
        .join(" ") || undefined;
    const plan: ActionPlan = {
      summary: blocked
        ? `${env.name} cannot be rolled back — this deploy would be refused.`
        : `Roll ${env.name} back to revision ${target.number}${current ? ` (from ${current.number})` : ""}.`,
      details: [
        ...(blocked ? [blocked] : []),
        ...cs.items.map((i) => i.explanation),
        `Projected monthly cost after rollback: ${fmtUsd(cs.projectedMonthlyUsd)} (estimate).`,
        "Rollback runs as a normal deployment, with its own steps and logs.",
        env.policies.approvalRequired
          ? `${env.name} requires approval, and a rollback is a deployment: it will wait at "awaiting approval" until an admin approves it.`
          : `${env.name} applies without an approval step, so this starts immediately.`,
      ],
      costDeltaUsd: cs.totalCostDeltaUsd,
      risk: "high",
      warnings: [
        ...cs.warnings,
        "Rollback restores the system definition, not data written since the last deploy.",
      ],
      requiresApproval: env.policies.approvalRequired,
      blocked,
    };
    if ((await executionRoute(env)).kind === "workflow") await addWorkflowCheck(ctx, env, plan, "deployment.rollback");
    return plan;
  },
  async execute(ctx, input) {
    const env = requireEnvironment(ctx, input.environmentId);
    const refuse = (error: string) => ({
      ok: false as const,
      summary: `${env.name} cannot be rolled back.`,
      error,
    });

    const resolved = rollbackTarget(ctx, env, input.toRevisionId);
    // Order matters here, and each step earns its place. A target the caller
    // NAMED is a tenancy question, so it comes first: a revision from outside
    // this project must never reach the engine, whatever this environment's
    // provider happens to support. Provider honesty comes next — it speaks only
    // about this environment, which is already the caller's own, so it discloses
    // nothing about the target. Last is "no earlier revision", which is derived
    // from this environment's own history and is not a tenancy matter at all;
    // an environment that cannot be deployed to should say so before it starts
    // discussing what it might roll back to.
    if (input.toRevisionId && "refusal" in resolved) return refuse(resolved.refusal);
    const route = await executionRoute(env);
    const blocked = (await providerBlock(env, route)) ?? connectionBlock(env);
    if (blocked) return refuse(blocked);
    if ("refusal" in resolved) return refuse(resolved.refusal);

    // The same wall `deploy.apply` enforces, against the same live revision: a
    // rollback (or a promotion, which runs through here) whose target predates
    // a data-bearing resource would have the provider destroy it. Plan mode
    // renders this as `blocked`; execute enforces it because execute can be
    // called without a plan.
    const current = env.deployedRevisionId ? q.revision(env.deployedRevisionId) : undefined;
    const statefulRefusal = await statefulDeletionBlock(
      env,
      diffManifests(current?.manifest ?? emptyManifest(), resolved.revision.manifest),
      "rollback"
    );
    if (statefulRefusal)
      return {
        ok: false,
        summary: `${env.name} does not allow removing a resource that holds data.`,
        error: statefulRefusal,
      };

    if (route.kind === "workflow") return startWorkflowRollback({ ctx, env, revision: resolved.revision, changeset: diffManifests(current?.manifest ?? emptyManifest(), resolved.revision.manifest) });
    const engine = await getEngine();
    // The resolved id, never the caller's string: `engine.rollback` deploys
    // whatever revision it is handed straight into this environment.
    const d = await engine.rollback(env.id, resolved.revision.id, {
      id: ctx.actor.id,
      name: ctx.actor.name,
    });
    const target = q.revision(d.revisionId);
    return {
      ok: true,
      summary:
        d.status === "awaiting_approval"
          ? `Rollback to revision ${target?.number ?? "?"} is waiting for approval on ${env.name}.`
          : `Rolling ${env.name} back to revision ${target?.number ?? "?"}.`,
      data: { deploymentId: d.id, status: d.status, revisionId: d.revisionId },
    };
  },
});
