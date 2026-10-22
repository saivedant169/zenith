/**
 * The apply side of the deploy journey for `kubernetes`-provider environments
 * (PROD-LIFE-07). Every other provider plans and applies through OpenTofu; the
 * Kubernetes drivers declare `compile: false` because their declarative path is
 * render -> server-side apply (ADR-0015). This module is that path, entered from
 * the SAME activities the workflow already calls (`planInfrastructure`,
 * `finalPlan`, `applyInfrastructure`), so lease, fence, policy, human approval,
 * the digest comparison and the evidence trail are unchanged.
 *
 *   plan        render the managed nodes (renderGraph), server-side dry-run every
 *               object against the live cluster, and fold each object's action
 *               (create / update / no-op) and the rendered bytes into a plan
 *               digest. Evidence is recorded as `tofu_plan` like any plan, so
 *               policy and approval bind this digest. No object is written.
 *   final plan  the same, immediately before apply, compared with the approved
 *               digest. A moved digest is `plan_changed`: nothing is applied.
 *   apply       re-renders and re-dry-runs under the deploy grant, refuses unless
 *               the digest is still the approved one and the human approval is
 *               still current, then applies with server-side apply (field manager
 *               `zenith`, never forced, all-or-nothing preflight with ownership
 *               and immutable-field refusals).
 *
 * What it deliberately does not do:
 *   - delete. A node removed from the manifest leaves its objects; the review
 *     lists them as `retained`, and removing them is `infrastructure.destroy`.
 *   - write Secrets. Secret objects carry a vault reference and no data; the
 *     existing secret delivery (`execution/secrets.ts`) writes them with the
 *     resolved value, so they are rendered out of this apply.
 *   - build or release. Source builds and digest releases are the existing
 *     `build` / `deploy` steps through the Kubernetes release ports (LIFE-10
 *     release safety applies there). A workload whose image does not exist yet
 *     is applied with an inert bootstrap image (or the image already running, so
 *     a re-apply never rolls a released digest back) and the deploy step
 *     supplies the real digest.
 *   - wait for pods. Readiness is `verify_infrastructure`, which reads the same
 *     drivers (rollout, ordered readiness, claims, CronJob runs, policy engine).
 */
import { digest } from "@/lib/controlplane/digest";
import { recordReviewedSemantics, assertApprovedSemantics } from "./semantics/dispatch";
import type { CollectArgs } from "./semantics/collect";
import { SemanticsChangedError } from "./semantics/errors";
import type { KubernetesSession } from "@/lib/credentials/types";
import { extractPlanFacts } from "@/lib/policy/plan-facts";
import type { PlanFacts } from "@/lib/policy/types";
import { diff, serverSideApply } from "@/lib/providers/kubernetes/apply";
import { createK8sClient, readObject } from "@/lib/providers/kubernetes/client";
import { RENDERABLE_KINDS, renderGraph } from "@/lib/providers/kubernetes/render";
import { sessionNamespaces } from "@/lib/providers/kubernetes/session";
import { targetFor } from "@/lib/providers/kubernetes/target";
import { ANNOTATION, type K8sObject, type SupportedKind } from "@/lib/providers/kubernetes/types";
import { dig } from "@/lib/providers/kubernetes/util";
import type { ArtifactSpec } from "@/lib/resources/specs";
import type { ResourceGraph, ResourceNode } from "@/lib/resources/types";
import type { NormalizedPlan } from "@/lib/tofu/types";
import type { ExecutionActivities, LeaseRef } from "@/lib/workflows/types";
import { loadExecContext, resolveConnection, type ExecContext } from "./context";
import { assertLeaseFor, costOf, requireExecutable } from "./desired";
import { StepFailedError, TofuPlanChangedError } from "./errors";
import { withKeepAlive } from "./keepalive";
import { planEvidence, toPlanSummary, type PlanCost } from "./plan-evidence";
import type { Runtime } from "./runtime";
import { LONG_SESSION_SEC, PLAN_CAPABILITY, withProviderSession } from "./session";
import { approvedSources } from "./source-snapshot";
import { errorText, safeText } from "./text";

/** An image no registry serves: the pod stays inert until the deploy step supplies the real digest. */
export const BOOTSTRAP_IMAGE = "registry.invalid/zenith/bootstrap:unavailable";

export const isDirectKubernetes = (ec: Pick<ExecContext, "product">): boolean => ec.product.environment.provider === "kubernetes";

interface Rendered {
  objects: K8sObject[];
  notes: string[];
  nodes: ResourceNode[];
}

/** The immutable declaration behind native apply, independent of released image ownership and live rollout state. */
export function kubernetesSemanticsWorkspace(ec: ExecContext, graph: ResourceGraph, connection: Pick<Awaited<ReturnType<typeof resolveConnection>>, "config">): CollectArgs["ws"] {
  const nodes = graph.nodes.filter((n) => n.provider === "kubernetes" && n.ownership === "managed" && RENDERABLE_KINDS.includes(n.kind));
  // Same allowlist the apply render receives from its session, so the reviewed declaration matches what applies.
  const provisionedNamespaces = connection.config.provider === "kubernetes" ? connection.config.namespaces : [];
  const objects = renderGraph(nodes, { environmentId: ec.environmentId, provisionedNamespaces, resolveImage: () => BOOTSTRAP_IMAGE }).objects.filter((o) => o.kind !== "Secret");
  return {
    files: [], backend: "local",
    configDigest: digest({ engine: "kubernetes-apply/K1", graphDigest: graph.graphDigest, objects }),
    lockDigest: digest({ provider: "kubernetes", contract: "K1" }),
  };
}

const IMAGE_BEARING: ReadonlySet<string> = new Set(["container_service", "scheduled_job", "static_site"]);
const PRIMARY: Record<string, SupportedKind> = { container_service: "Deployment", static_site: "Deployment", scheduled_job: "CronJob" };

/** The container image a workload runs now, so a re-apply keeps a released digest. */
function liveImage(live: Record<string, unknown> | undefined, kind: SupportedKind): string | undefined {
  const path = kind === "CronJob" ? ["spec", "jobTemplate", "spec", "template", "spec", "containers", 0, "image"] : ["spec", "template", "spec", "containers", 0, "image"];
  const image = dig(live, ...path);
  return typeof image === "string" && image !== BOOTSTRAP_IMAGE ? image : undefined;
}

async function render(ec: ExecContext, graph: ResourceGraph, session: KubernetesSession, signal: AbortSignal): Promise<Rendered> {
  const nodes = graph.nodes.filter((n) => n.provider === "kubernetes" && n.ownership === "managed" && RENDERABLE_KINDS.includes(n.kind));
  const client = createK8sClient(session, { environmentId: ec.environmentId, signal });
  const images = new Map<string, string>();
  for (const node of nodes) {
    const artifact = node.spec.artifact as ArtifactSpec | undefined;
    if (!IMAGE_BEARING.has(node.kind) || !artifact || artifact.type === "image") continue;
    const kind = PRIMARY[node.kind];
    const ref = targetFor(kind, node, ec.environmentId);
    let live: Record<string, unknown> | undefined;
    try {
      await client.guard.assert(ref.namespace as string);
      live = await readObject(client, ref);
    } catch {
      live = undefined; // a namespace that does not exist yet has nothing running
    }
    images.set(node.address, liveImage(live, kind) ?? BOOTSTRAP_IMAGE);
  }
  const rendered = renderGraph(nodes, { environmentId: ec.environmentId, provisionedNamespaces: sessionNamespaces(session), resolveImage: (node) => images.get(node.address) });
  return {
    // Secrets are written by the secret-delivery step with the resolved value; they carry no data here.
    objects: rendered.objects.filter((o) => o.kind !== "Secret"),
    notes: rendered.notes,
    nodes,
  };
}

const refAddress = (o: { kind: string; metadata: { name: string; namespace?: string } }): string => `${o.kind}/${o.metadata.namespace ?? ""}/${o.metadata.name}`;

interface DirectStage {
  graph: ResourceGraph;
  connection: Awaited<ReturnType<typeof resolveConnection>>;
  plan: NormalizedPlan;
  facts: PlanFacts;
  cost: PlanCost;
  graphDigest: string;
  objects: K8sObject[];
  retained: string[];
}

/** Dry-run the rendered objects against the cluster and fold the result into a normalized plan. */
/**
 * The Kubernetes NormalizedPlan. Like the OpenTofu normalizer, an approved private source binds its
 * executable source digest into the plan digest and the plan, so the reviewed PlanView can show it.
 */
export function kubernetesPlan(input: { graphDigest: string; objects: unknown[]; resourceChanges: { address: string; action: string; changes: unknown[] }[]; notes: string[]; createdAt: string; executableSourceDigest?: string }): NormalizedPlan {
  const { resourceChanges } = input;
  if (input.executableSourceDigest !== undefined && !/^[a-f0-9]{64}$/.test(input.executableSourceDigest)) throw new StepFailedError("Executable source identity is invalid.");
  const count = (a: string) => resourceChanges.filter((r) => r.action === a).length;
  const summary = { create: count("create"), update: count("update"), delete: 0, replace: 0, noop: count("no-op") };
  // The digest binds what would be sent (the rendered bytes) and what it would do to this cluster now.
  const planDigest = digest({ engine: "kubernetes-apply/K1", graphDigest: input.graphDigest, objects: input.objects, actions: resourceChanges.map((r) => [r.address, r.action, r.changes]),
    ...(input.executableSourceDigest ? { executableSourceDigest: input.executableSourceDigest } : {}) });
  return {
    tofuVersion: "kubernetes-apply/K1",
    formatVersion: "K1",
    configDigest: input.graphDigest,
    lockDigest: digest({ provider: "kubernetes", contract: "K1" }),
    planDigest,
    resourceChanges,
    outputChanges: [],
    summary,
    empty: summary.create === 0 && summary.update === 0,
    diagnostics: input.notes.slice(0, 10).map((n) => ({ severity: "warning" as const, summary: safeText(n, 300), detail: "" })),
    createdAt: input.createdAt,
    ...(input.executableSourceDigest ? { executableSourceDigest: input.executableSourceDigest } : {}),
  } as unknown as NormalizedPlan;
}

/** Server-side apply changes in place; an immutable field is refused as a conflict, never replaced. The plan review requires the flag. */
export const kubernetesPlanChanges = (paths: readonly string[]) => paths.slice(0, 50).map((path) => ({ path, forcesReplacement: false }));

async function dryRun(rt: Runtime, ec: ExecContext, graph: ResourceGraph, session: KubernetesSession, signal: AbortSignal): Promise<Omit<DirectStage, "cost" | "graph" | "connection">> {
  const rendered = await render(ec, graph, session, signal);
  const changes = await diff(rendered.objects, session, { environmentId: ec.environmentId, signal });
  const problem = changes.find((c) => ["conflict", "ownership_conflict", "error"].includes(c.action));
  if (problem) {
    const why = problem.action === "ownership_conflict" ? "an object exists that Zenith does not own" : problem.action === "conflict" ? "another field manager owns a field" : "the cluster refused it";
    throw new StepFailedError(`The Kubernetes plan cannot be made: ${refAddress({ kind: problem.ref.kind, metadata: { name: problem.ref.name, namespace: problem.ref.namespace } })}: ${why}. ${safeText(problem.message ?? "", 300)}`);
  }
  const byRef = new Map(changes.map((c) => [`${c.ref.kind}|${c.ref.namespace ?? ""}|${c.ref.name}`, c]));
  const resourceChanges = rendered.objects.map((o) => {
    const c = byRef.get(`${o.kind}|${o.metadata.namespace ?? ""}|${o.metadata.name}`);
    const action = !c || c.action === "create" ? "create" : c.action === "update" ? "update" : "no-op";
    return {
      address: refAddress(o),
      nodeAddress: String(o.metadata.annotations?.[ANNOTATION.resource] ?? ""),
      type: o.kind,
      providerName: "kubernetes",
      action,
      changes: kubernetesPlanChanges(c?.changedPaths ?? []),
      destroysData: false,
    };
  });
  const plan = kubernetesPlan({ graphDigest: graph.graphDigest, objects: rendered.objects, resourceChanges, notes: rendered.notes, createdAt: rt.now().toISOString(),
    ...(ec.executableSourceDigest ? { executableSourceDigest: ec.executableSourceDigest } : {}) });
  const facts: PlanFacts = {
    ...extractPlanFacts(plan),
    statefulDeletes: [],
    dnsDeletes: [],
    destroysData: false,
    destroyedStatefulAddresses: [],
  } as PlanFacts;
  return { plan, facts, graphDigest: graph.graphDigest, objects: rendered.objects, retained: [] };
}

async function stage(rt: Runtime, ec: ExecContext, lease: LeaseRef, detail: string, expected?: string): Promise<DirectStage & { graph: ResourceGraph; connection: Awaited<ReturnType<typeof resolveConnection>> }> {
  assertLeaseFor(ec, lease);
  const { graph } = requireExecutable(rt, ec);
  const connection = await resolveConnection(rt, ec);
  await rt.d.leases.assertFence(lease.scope, lease.fenceToken);
  const result = await withKeepAlive(rt, { lease, detail, operation: { workspaceId: ec.workspaceId, operationId: ec.op.id } }, async (signal) => {
    await approvedSources(rt, ec, graph, lease, !expected, signal);
    return withProviderSession(rt, ec, { purpose: "observe", capability: PLAN_CAPABILITY, fence: lease, connection, durationSec: LONG_SESSION_SEC }, async (session) => {
      if (session.provider !== "kubernetes") throw new StepFailedError("The provider session does not match this environment.");
      return dryRun(rt, ec, graph, session, signal);
    });
  });
  await rt.d.leases.assertFence(lease.scope, lease.fenceToken);
  return { ...result, cost: await costOf(rt, ec, graph), graph, connection };
}

export async function planDirectKubernetes(rt: Runtime, ec: ExecContext, lease: LeaseRef): ReturnType<ExecutionActivities["planInfrastructure"]> {
  const s = await stage(rt, ec, lease, "kubernetes plan");
  if (ec.op.planDigest && ec.op.planDigest !== s.plan.planDigest) throw new TofuPlanChangedError(ec.op.planDigest, s.plan.planDigest);
  // Record the reviewed semantics once before evidence, and re-check them at final plan, apply and release dispatch.
  const semantics = await recordReviewedSemantics(rt, ec, { graph: s.graph, connection: s.connection, ws: kubernetesSemanticsWorkspace(ec, s.graph, s.connection), planDigest: s.plan.planDigest, engineVersion: "kubernetes-apply/K1" });
  const evidence = planEvidence({ plan: s.plan, facts: s.facts, cost: s.cost, graphDigest: s.graphDigest, stage: "plan", approvedSources: ec.approvedSourceSnapshots });
  await rt.evidence(ec.scope, { kind: "tofu_plan", digest: evidence.digest, key: evidence.key, summary: { ...evidence.summary, semantics, engine: "kubernetes-apply", statefulDeletes: [], dnsDeletes: [], retained: s.retained }, simulated: false }, { critical: true });
  if (!ec.op.planDigest) await rt.d.ops.setPlanDigest({ workspaceId: ec.workspaceId, operationId: ec.op.id, planDigest: s.plan.planDigest });
  await rt.emit(ec.scope, "resource.planned", `plan:${s.plan.planDigest}`, { planDigest: s.plan.planDigest, create: s.plan.summary.create, update: s.plan.summary.update, delete: 0, replace: 0, empty: s.plan.empty });
  return toPlanSummary(s.plan, s.facts, s.cost);
}

export async function finalDirectKubernetes(rt: Runtime, ec: ExecContext, lease: LeaseRef, approved: string): ReturnType<ExecutionActivities["finalPlan"]> {
  const s = await stage(rt, ec, lease, "kubernetes plan (final)", approved);
  const evidence = planEvidence({ plan: s.plan, facts: s.facts, cost: s.cost, graphDigest: s.graphDigest, stage: "final_plan", approvedDigest: approved, approvedSources: ec.approvedSourceSnapshots });
  await rt.evidence(ec.scope, { kind: "tofu_plan", digest: evidence.digest, key: evidence.key, summary: { ...evidence.summary, engine: "kubernetes-apply", statefulDeletes: [], dnsDeletes: [] }, simulated: false }, { critical: false });
  if (s.plan.planDigest !== approved) throw new TofuPlanChangedError(approved, s.plan.planDigest);
  await assertApprovedSemantics(rt, ec, { graph: s.graph, connection: s.connection, ws: kubernetesSemanticsWorkspace(ec, s.graph, s.connection), planDigest: approved, engineVersion: "kubernetes-apply/K1" }, "kubernetes final plan");
  return toPlanSummary(s.plan, s.facts, s.cost);
}

export async function applyDirectKubernetes(rt: Runtime, ec: ExecContext, lease: LeaseRef, planDigest: string): ReturnType<ExecutionActivities["applyInfrastructure"]> {
  assertLeaseFor(ec, lease);
  const { graph } = requireExecutable(rt, ec);
  const connection = await resolveConnection(rt, ec);
  await rt.d.leases.assertFence(lease.scope, lease.fenceToken);
  await rt.emit(ec.scope, "resource.applying", `apply:${planDigest}`, { planDigest });
  let started = false;
  try {
    const applied = await withKeepAlive(rt, { lease, detail: "kubernetes apply", operation: { workspaceId: ec.workspaceId, operationId: ec.op.id } }, async (signal) => {
      await approvedSources(rt, ec, graph, lease, false, signal);
      return withProviderSession(rt, ec, { purpose: "deploy", fence: lease, connection, durationSec: LONG_SESSION_SEC }, async (session) => {
        if (session.provider !== "kubernetes") throw new StepFailedError("The provider session does not match this environment.");
        // Everything the reviewed plan depended on must be unchanged, and the plan must still be the approved one.
        const current = await loadExecContext(rt, ec.op.id);
        const currentGraph = requireExecutable(rt, current).graph;
        if (currentGraph.graphDigest !== graph.graphDigest) throw new StepFailedError("The reviewed desired state changed; a new review is required.");
        // Re-prove the approved sources on the fresh context first: they bind the executable source digest into its plan.
        await approvedSources(rt, current, currentGraph, lease, false, signal);
        const fresh = await dryRun(rt, current, currentGraph, session, signal);
        if (fresh.plan.planDigest !== planDigest) throw new TofuPlanChangedError(planDigest, fresh.plan.planDigest);
        const currentConnection = await resolveConnection(rt, current);
        await assertApprovedSemantics(rt, current, { graph: currentGraph, connection: currentConnection, ws: kubernetesSemanticsWorkspace(current, currentGraph, currentConnection), planDigest, engineVersion: "kubernetes-apply/K1" }, "kubernetes apply dispatch");
        const authority = await rt.d.broker.approvalStatus(ec.op.id);
        if (!authority.approved || authority.rejected || (current.op.approvalRequired && !authority.approvalId)) throw new StepFailedError("Current policy or human approval changed before the reviewed plan was applied.");
        await rt.d.leases.assertFence(lease.scope, lease.fenceToken);
        started = true;
        const report = await serverSideApply(fresh.objects, session, { environmentId: ec.environmentId, signal });
        if (!report.ok) {
          const failed = report.results.filter((r) => !["created", "configured", "unchanged"].includes(r.status));
          const detail = failed.slice(0, 3).map((r) => `${r.ref.kind}/${r.ref.name}: ${r.status}`).join("; ");
          if (report.refused) throw new StepFailedError(`The Kubernetes apply was refused before anything was written (${detail}).`);
          throw new Error(`The Kubernetes apply stopped part way (${detail}); partial apply; reconcile will observe the environment.`);
        }
        return { report, plan: fresh.plan, objects: fresh.objects };
      });
    });
    const counts = applied.plan.summary;
    const count = counts.create + counts.update;
    const outputsDigest = digest({ engine: "kubernetes-apply/K1", applied: applied.report.results.map((r) => [r.ref.kind, r.ref.namespace, r.ref.name, r.status, r.generation ?? null]) });
    await rt.evidence(ec.scope, { kind: "tofu_apply", digest: digest({ planDigest, outputsDigest, applied: count }), key: `apply:${planDigest}`, simulated: false,
      summary: { planDigest, engine: "kubernetes-apply", applied: { create: counts.create, update: counts.update, delete: 0, replace: 0 }, outputsDigest, outputs: [], exitCode: 0, durationMs: 0 } }, { critical: true });
    await markActive(rt, ec, applied.objects);
    await rt.emit(ec.scope, "resource.applied", `apply:${planDigest}`, { planDigest, applied: count, outputsDigest });
    await rt.d.leases.assertFence(lease.scope, lease.fenceToken);
    return { applied: count, outputsDigest };
  } catch (err) {
    if (err instanceof TofuPlanChangedError || err instanceof StepFailedError || err instanceof SemanticsChangedError) throw err;
    if (started) {
      await rt.d.ops.markUncertain({ workspaceId: ec.workspaceId, operationId: ec.op.id, reason: safeText("The Kubernetes apply ended without a confirmed outcome.", 300) }).catch(() => undefined);
      throw err instanceof Error && /partial apply/.test(err.message) ? err : new Error(`The Kubernetes apply ended without a confirmed outcome (${errorText(err, 200)}); partial apply; reconcile will observe the environment.`);
    }
    throw new StepFailedError(`The apply did not start; nothing was changed: ${errorText(err)}`);
  }
}

/** Mark the nodes that were applied. A projection only: the cluster is the truth. */
async function markActive(rt: Runtime, ec: ExecContext, objects: readonly K8sObject[]): Promise<void> {
  try {
    const stored = new Map((await rt.d.resources.list(ec.workspaceId, ec.environmentId)).map((r) => [r.address, r.id]));
    const addresses = new Set(objects.map((o) => String(o.metadata.annotations?.[ANNOTATION.resource] ?? "")));
    for (const address of addresses) {
      const id = stored.get(address);
      if (id) await rt.d.resources.setStatus({ workspaceId: ec.workspaceId, resourceId: id, status: "active" });
    }
  } catch (err) {
    rt.log("warn", "could not update resource statuses after the Kubernetes apply", { error: errorText(err) });
  }
}
