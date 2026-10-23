/**
 * Explicit teardown, never compensation. Brokered credentials stay inside
 * callbacks; leases fence every plan, apply and observation. Stateful deletion
 * needs explicit allow plus policy approval. DNS ownership is read before plan
 * and apply. Missing proves absence; inaccessible/unknown/simulated never does.
 * Cloud execution is unverified live; tests exercise contracts and local tofu.
 */
import { digest } from "@/lib/controlplane/digest";
import type { ProviderSession } from "@/lib/credentials/types";
import { PORTABLE_KINDS, type ResourceGraph, type ResourceNode } from "@/lib/resources/types";
import { extractPlanFacts } from "@/lib/policy/plan-facts";
import { assessRecordDeletion } from "@/lib/providers/aws/drivers/network/route53-record";
import { assessRecordDeletion as assessGcpRecordDeletion } from "@/lib/providers/gcp/dns-ownership";
import { assessRecordDeletion as assessAzureRecordDeletion } from "@/lib/providers/azure/dns-ownership";
import { assessRecordDeletion as assessOciRecordDeletion } from "@/lib/providers/oci/dns-ownership";
import { presenceOfDeletion, readDeletionEvidence } from "@/lib/providers/oci/deletion-evidence";
import { assertProofsMatchReview, dnsDisposition, dnsOwnershipSummary, reviewedProofFor, type DnsAssessment, type DnsRecordSetProof } from "@/lib/providers/dns-teardown-proof";
import { assertDeletionAllowed, TofuDeletionRefusedError } from "@/lib/tofu/plan";
import { assertTeardownOwnership } from "./decommission";
import { TofuCommandError } from "@/lib/tofu/runner";
import { TofuPlanProvenanceError, type NormalizedPlan } from "@/lib/tofu/types";
import type { DestroyActivities } from "@/lib/workflows/definitions/destroy";
import type { LeaseRef, PlanSummary } from "@/lib/workflows/types";
import { buildWorkspace } from "./compile";
import { loadExecContext, loadOperation, resolveConnection, type ExecContext } from "./context";
import { assertLeaseFor, requireExecutable, tofuSessionFor } from "./desired";
import { LeaseLostError, StepFailedError, TofuPlanChangedError } from "./errors";
import { withKeepAlive } from "./keepalive";
import { planEvidence, toPlanSummary } from "./plan-evidence";
import { planCustody, type Runtime } from "./runtime";
import { assertApprovedSemantics, recordReviewedSemantics } from "./semantics/dispatch";
import { SemanticsChangedError } from "./semantics/errors";
import { driverContext, LONG_SESSION_SEC, OBSERVE_CAPABILITY, PLAN_CAPABILITY, withProviderSession } from "./session";
import { safeText } from "./text";
import { buildDesiredState } from "./graph";
import { z } from "zod";
import { platformBroker, type Broker } from "@/lib/capabilities/platform";
import { acceptCleanupEffect, beginCleanupEffect, priorCleanupResult, uncertainCleanupEffect, type CleanupEffectScope } from "@/lib/effects/cleanup";
import type { EffectRecord } from "@/lib/effects/types";
import { runDestroyReview, type DestroyReviewResult } from "@/lib/capabilities/destroy-review";
import type { ManagedDatabaseProvider } from "@/lib/providers/zenith/database";
import type { ZenithTeardownDatabase } from "@/lib/providers/zenith/teardown";

const HEX64 = /^[0-9a-f]{64}$/;

/** C1 object references; injected transports are contract fakes, never live proof. */
export interface TeardownInput {
  workspaceId: string; environmentId: string; session: unknown; retainStateful: boolean;
  /** Adopted objects whose active claim allows destruction; named exactly, since Zenith never labelled them. */
  adopted?: readonly { kind: "StatefulSet" | "PersistentVolumeClaim"; namespace: string; name: string }[];
  dryRun?: boolean; signal?: AbortSignal;
}
export interface TeardownResult { deleted: string[]; retained: string[]; skipped: string[]; uncertain: string[] }
export interface DestroyProviderPorts {
  /** Scoped broker override for worker contract tests. */
  reviewBroker?: () => Promise<Broker>;
  teardownKubernetesEnvironment?: (input: TeardownInput) => Promise<TeardownResult>;
  teardownZenithEnvironment?: (input: TeardownInput) => Promise<TeardownResult>;
  /** Managed sessions need a platform opener: the customer credential broker has no zenith config. */
  withZenithSession?<T>(input: { workspaceId: string; environmentId: string; signal: AbortSignal; databases?: ManagedDatabaseProvider }, fn: (session: unknown) => Promise<T>): Promise<T>;
}
const ObjectRef = z.string().min(1).max(500).regex(/^[A-Za-z][A-Za-z0-9]*\/[^/\s]*\/[^/\s]+$/);
const ResultSchema = z.object({ deleted: z.array(ObjectRef).max(10_000), retained: z.array(ObjectRef).max(10_000), skipped: z.array(ObjectRef).max(10_000), uncertain: z.array(ObjectRef).max(10_000) }).strict();
/**
 * A coverage-gap marker for a kind the cluster does not serve (`Certificate/ns/*` when cert-manager is not installed).
 * A kind the API does not serve cannot hold an object, so it is not an unreviewed part of the teardown. Any other
 * skipped ref (a named object, or a wildcard for a kind the cluster serves) still blocks.
 */
const UNSERVED_CRD_KINDS: ReadonlySet<string> = new Set(["Certificate", "DNSEndpoint", "HTTPRoute"]);
const blockingSkips = (skipped: readonly string[]): string[] => skipped.filter((ref) => {
  const [kind, , name] = ref.split("/");
  return !(name === "*" && UNSERVED_CRD_KINDS.has(kind));
});
const isDirect = (ec: ExecContext) => ["kubernetes", "zenith"].includes(ec.product.environment.provider);

async function teardown(ports: DestroyProviderPorts, provider: string, input: TeardownInput): Promise<TeardownResult> {
  let fn = provider === "kubernetes" ? ports.teardownKubernetesEnvironment : ports.teardownZenithEnvironment;
  if (!fn) {
    // These pinned modules belong to parallel jobs and are absent at this base.
    // Lazy resolution fails closed without generating a fake implementation.
    try {
      fn = provider === "kubernetes"
        ? (await import("@/lib/providers/kubernetes/teardown")).teardownKubernetesEnvironment
        : (await import("@/lib/providers/zenith/teardown")).teardownZenithEnvironment;
    } catch { throw new StepFailedError("The provider teardown module is not integrated in this worker."); }
  }
  if (typeof fn !== "function") throw new StepFailedError("The provider teardown contract is unavailable.");
  let reply: unknown;
  try { reply = await fn(input); }
  catch (error) {
    if (error instanceof LeaseLostError) throw error;
    throw new StepFailedError(input.dryRun ? "Provider destroy review failed; nothing was applied." : "Provider teardown outcome is unconfirmed; partial deletion is possible.");
  }
  const parsed = ResultSchema.safeParse(reply);
  if (!parsed.success) throw new StepFailedError("The provider returned an invalid teardown result.");
  const result = Object.fromEntries(Object.entries(parsed.data).map(([key, refs]) => [key, [...new Set(refs)].sort()])) as unknown as TeardownResult;
  const all = [...result.deleted, ...result.retained, ...result.skipped, ...result.uncertain];
  if (new Set(all).size !== all.length) throw new StepFailedError("The provider reported conflicting teardown results.");
  return result;
}

/**
 * Stateful data is retained unless the environment allows stateful deletion AND every managed stateful node allows it.
 * An adopted node has no Zenith deletion policy of its own; its active manage_and_destroy claim is the person's
 * per-resource consent (PROD-LIFE-11), so it counts as allowed. The environment switch is still required.
 */
function retainStateful(ec: ExecContext, graph: ResourceGraph, destroyable: ReadonlySet<string> = new Set()): boolean {
  return !ec.product.environment.policies.allowStatefulDeletion || graph.nodes.some((node) =>
    node.ownership === "managed" && ["postgres", "mysql", "redis", "object_store", "queue", "pubsub", "volume", "secret"].includes(node.kind) &&
    !destroyable.has(node.address) && node.spec.deletionPolicy !== "allow" && node.spec.deletionPolicy !== "approval");
}

/** Addresses of managed (adopted) nodes whose ACTIVE adoption claim allows destruction. */
async function destroyableAdopted(rt: Runtime, ec: ExecContext, graph: ResourceGraph): Promise<Set<string>> {
  if (!rt.d.portability) return new Set();
  const facts = await rt.d.portability.adoptionFacts(ec.workspaceId, ec.environmentId);
  return new Set(facts.filter((fact) => fact.status === "active" && fact.lifecycle === "manage_and_destroy"
    && graph.nodes.some((node) => node.address === fact.address && node.ownership === "managed")).map((fact) => fact.address));
}

/**
 * The complete managed-database inventory of a managed environment (PROD-MAN-01): every managed `postgres` node of the
 * deployed graph PLUS the removed resources `context()` merged in from the workspace-scoped store, each with the provider
 * id the store recorded. It is built by the worker from trusted state; the provider teardown refuses a missing inventory as
 * unknown (never as empty), so a managed environment can only be torn down once its databases are accounted for.
 *
 * Ownership proof is layered: only nodes this environment owns as `managed` on provider `zenith` are listed (adopted or
 * referenced databases never are), a stored row for the address must agree on kind, provider and tenant, adoption claims
 * were already checked by `assertTeardownOwnership`, and the database adapter itself refuses a provider project it did not
 * create for this exact (workspace, environment, address). `deny` always retains; `approval` deletes only when approved.
 */
async function zenithDatabaseInventory(rt: Runtime, ec: ExecContext, graph: ResourceGraph): Promise<ZenithTeardownDatabase[]> {
  const rows = new Map((await rt.d.resources.list(ec.workspaceId, ec.environmentId)).map((row) => [row.address, row]));
  const inventory: ZenithTeardownDatabase[] = [];
  for (const node of graph.nodes) {
    if (node.kind !== "postgres" || node.ownership !== "managed" || node.provider !== "zenith") continue;
    const stored = rows.get(node.address);
    if (stored && (stored.kind !== "postgres" || stored.provider !== "zenith" || stored.workspaceId !== ec.workspaceId || stored.environmentId !== ec.environmentId))
      throw new StepFailedError("A stored managed database does not match the deployed graph; refusing teardown.");
    const externalId = stored?.externalId ?? node.externalRef;
    const policy = node.spec.deletionPolicy;
    inventory.push({
      address: node.address,
      deletionPolicy: policy === "allow" || policy === "approval" ? policy : "deny",
      ...(externalId && /^[A-Za-z0-9_-]{1,200}$/.test(externalId) ? { externalId } : {}),
    });
  }
  return inventory;
}

/**
 * PROD-LIFE-11: the Kubernetes objects named by an ACTIVE manage_and_destroy adoption claim whose node is managed
 * (adopted) in this graph. `assertTeardownOwnership` has already refused any adopted node whose claim forbids it.
 */
async function adoptedTeardownRefs(rt: Runtime, ec: ExecContext, graph: ResourceGraph): Promise<NonNullable<TeardownInput["adopted"]>> {
  if (ec.product.environment.provider !== "kubernetes" || !rt.d.portability) return [];
  const facts = await rt.d.portability.adoptionFacts(ec.workspaceId, ec.environmentId);
  return facts.filter((fact) => fact.status === "active" && fact.lifecycle === "manage_and_destroy").flatMap((fact) => {
    const node = graph.nodes.find((candidate) => candidate.address === fact.address);
    const kind = node?.nativeType === "k8s:StatefulSet" ? "StatefulSet" : node?.nativeType === "k8s:PersistentVolumeClaim" ? "PersistentVolumeClaim" : undefined;
    if (!node || node.ownership !== "managed" || !kind) return [];
    // A malformed identity still reaches teardown, which reports it uncertain rather than silently dropping it.
    const [namespace = "", name = "", ...rest] = fact.externalId.split("/");
    return [{ kind, namespace, name: rest.length ? "*" : name }];
  });
}

async function directCall(rt: Runtime, ec: ExecContext, graph: ResourceGraph, lease: LeaseRef, ports: DestroyProviderPorts, dryRun: boolean, approved: boolean): Promise<TeardownResult> {
  const adopted = await adoptedTeardownRefs(rt, ec, graph);
  const destroyable = await destroyableAdopted(rt, ec, graph);
  return withKeepAlive(rt, { lease, detail: dryRun ? "provider destroy review" : "provider teardown", operation: { workspaceId: ec.workspaceId, operationId: ec.op.id } }, async (signal) => {
    const invoke = (session: unknown) => teardown(ports, ec.product.environment.provider,
      { workspaceId: ec.workspaceId, environmentId: ec.environmentId, session, retainStateful: retainStateful(ec, graph, destroyable), ...(adopted.length ? { adopted } : {}), dryRun, signal });
    if (ec.product.environment.provider === "zenith") {
      const inventory = (await zenithDatabaseInventory(rt, ec, graph)).map((db) => ({ ...db, approved }));
      const invokeManaged = (session: unknown) => invoke(typeof session === "object" && session !== null ? { ...session, teardown: { databases: inventory } } : session);
      // An explicit opener (contract tests) wins; otherwise the composed managed substrate opens the tenant-scoped session (PROD-MAN-01).
      const managed = rt.d.managed;
      const open: DestroyProviderPorts["withZenithSession"] | undefined = ports.withZenithSession ?? (managed ? (input, fn) => managed.withSession({ workspaceId: input.workspaceId, environmentId: input.environmentId, signal: input.signal }, fn) : undefined);
      if (!open) throw new StepFailedError("Managed Zenith teardown requires a platform-scoped session opener.");
      // A grant still gates platform credentials even though they use a separate opener.
      await rt.d.broker.issueGrant(ec.op.id, "worker", lease, { capability: dryRun ? PLAN_CAPABILITY : "infrastructure.destroy" });
      // The managed-database port exists only when there is something to delete; failing to build it is a refusal, never an empty inventory.
      let databases: ManagedDatabaseProvider | undefined;
      if (inventory.length && !ports.withZenithSession) {
        if (!managed) throw new StepFailedError("Managed Zenith teardown of databases requires the composed managed substrate.");
        try { databases = managed.databaseRuntime({ workspaceId: ec.workspaceId, projectId: ec.product.project.id, environmentId: ec.environmentId, nodes: graph.nodes }).databases; }
        catch { throw new StepFailedError("The managed database provider is not available, so this environment's databases cannot be torn down; nothing was applied."); }
      }
      return open({ workspaceId: ec.workspaceId, environmentId: ec.environmentId, signal, ...(databases ? { databases } : {}) }, invokeManaged);
    }
    const connection = await resolveConnection(rt, ec);
    return withProviderSession(rt, ec, { purpose: dryRun ? "observe" : "deploy", capability: dryRun ? PLAN_CAPABILITY : "infrastructure.destroy", fence: lease, connection }, (session) => {
      if (session.provider !== "kubernetes") throw new StepFailedError("The provider session does not match this environment.");
      return invoke(session);
    });
  });
}

async function directPlan(rt: Runtime, ec: ExecContext, graph: ResourceGraph, result: TeardownResult): Promise<NormalizedPlan> {
  const destroyable = await destroyableAdopted(rt, ec, graph);
  const provider = ec.product.environment.provider;
  const stateful = (ref: string) => /^(PersistentVolumeClaim|PersistentVolume|StatefulSet|VolumeSnapshot|Secret|Postgres|Database|ManagedDatabase)\//i.test(ref);
  return { tofuVersion: "provider-teardown/C1", formatVersion: "C1", configDigest: graph.graphDigest,
    lockDigest: digest({ provider, contract: "C1" }),
    planDigest: digest({ provider, graphDigest: graph.graphDigest, retainStateful: retainStateful(ec, graph, destroyable), ...result }),
    resourceChanges: result.deleted.map((address) => ({ address, type: address.split("/")[0], providerName: provider, action: "delete", changes: [], destroysData: stateful(address) })),
    outputChanges: [], summary: { create: 0, update: 0, delete: result.deleted.length, replace: 0, noop: 0 },
    empty: result.deleted.length === 0, diagnostics: [], createdAt: rt.now().toISOString() };
}

/** The operation whose planning recorded the reviewed semantics: a teardown reuses its source review's plan. */
const semanticsOperation = (ec: ExecContext): string => (ec.op.proposal as { broker?: { destroyPlan?: { operationId?: string } } }).broker?.destroyPlan?.operationId ?? ec.op.id;
/** Provider-direct teardown has no rendered workspace; the graph digest and the contract stand in for configuration and locks. */
const directWorkspace = (graph: ResourceGraph) => ({ files: [], configDigest: graph.graphDigest, lockDigest: digest({ contract: "provider-teardown/C1" }), backend: "local" as const });

async function directPlanStage(rt: Runtime, ec: ExecContext, graph: ResourceGraph, lease: LeaseRef, ports: DestroyProviderPorts, approvedDigest?: string): Promise<PlanSummary> {
  // Review deletes nothing. The destroy operation is digest-bound to a human approval before apply, and that approval covers exactly this
  // list, so an approval-policy database is shown here as a deletion; apply re-checks the approval before passing approved=true.
  const result = await directCall(rt, ec, graph, lease, ports, true, true);
  await rt.d.leases.assertFence(lease.scope, lease.fenceToken);
  if (result.uncertain.length || blockingSkips(result.skipped).length) throw new StepFailedError("The provider could not completely review teardown; skipped or uncertain objects require investigation.");
  const plan = await directPlan(rt, ec, graph, result), facts = extractPlanFacts(plan);
  const evidence = planEvidence({ plan, facts, cost: {}, graphDigest: graph.graphDigest, stage: approvedDigest ? "final_plan" : "plan", approvedDigest });
  await rt.evidence(ec.scope, { kind: "tofu_plan", digest: plan.planDigest, key: `destroy:${evidence.key}`, simulated: false,
    summary: { ...evidence.summary, engine: "provider-teardown", destroy: true, destroyAddresses: result.deleted, retained: result.retained, statefulDeletes: facts.destroyedStatefulAddresses } }, { critical: false });
  const expected = approvedDigest ?? ec.op.planDigest;
  if (expected && expected !== plan.planDigest) throw new TofuPlanChangedError(expected, plan.planDigest);
  // PROD-DUR-03: the executable semantics of a teardown are recorded at review and must be identical at every later stage.
  const directArgs = { graph, connection: { id: ec.product.environment.connectionId, config: null }, ws: directWorkspace(graph), planDigest: plan.planDigest };
  if (approvedDigest || ec.op.planDigest) await assertApprovedSemantics(rt, ec, directArgs, "teardown dispatch", { operationId: semanticsOperation(ec) });
  else await recordReviewedSemantics(rt, ec, directArgs);
  if (!approvedDigest) await rt.d.ops.setPlanDigest({ workspaceId: ec.workspaceId, operationId: ec.op.id, planDigest: plan.planDigest });
  return toPlanSummary(plan, facts, {});
}

async function context(rt: Runtime, operationId: string, lease: LeaseRef, planning = false): Promise<{ ec: ExecContext; graph: ResourceGraph }> {
  const ec = await loadExecContext(rt, operationId);
  const readOnlyPlan = planning && ec.op.capability === PLAN_CAPABILITY;
  if (ec.op.capability !== "infrastructure.destroy" && !readOnlyPlan) throw new StepFailedError("Teardown requires an infrastructure.destroy operation (or infrastructure.plan for read-only review).");
  assertLeaseFor(ec, lease);
  await rt.d.leases.assertFence(lease.scope, lease.fenceToken);
  // Teardown compiles the deployed graph, never a caller's replacement revision.
  const deployed = ec.product.environment.deployedRevisionId;
  if (deployed) {
    const revision = await rt.d.product.loadRevision({ workspaceId: ec.workspaceId, environmentId: ec.environmentId, revisionId: deployed });
    if (!revision) throw new StepFailedError("The deployed revision could not be loaded; refusing teardown.");
    ec.product = { ...ec.product, revision };
  }
  // C1 discovers owned live objects itself; teardown does not need every
  // deployment driver to compile (e.g. the derived log_group on Kubernetes).
  const desired = isDirect(ec) ? buildDesiredState(ec.product) : undefined;
  const graph = isDirect(ec) ? desired?.graph : requireExecutable(rt, ec).graph;
  if (!graph || graph.nodes.some((node) => node.ownership === "managed" && node.provider !== ec.product.environment.provider)) throw new StepFailedError("The deployed graph cannot be safely reviewed for teardown.");
  const nodes = new Map(graph.nodes.map((node) => [node.address, node]));
  // Retain removed nodes from earlier revisions, using workspace-scoped rows.
  for (const row of await rt.d.resources.list(ec.workspaceId, ec.environmentId)) {
    const declared = nodes.get(row.address);
    if (declared) {
      // An adopted resource is managed in the store while its manifest still declares it referenced (PROD-LIFE-11);
      // the store is the ownership authority, so the decommission gate below sees it.
      if (declared.ownership === "referenced" && row.ownership === "managed") nodes.set(row.address, { ...declared, ownership: "managed" });
      continue;
    }
    if (![...PORTABLE_KINDS, "provider_native"].includes(row.kind as ResourceNode["kind"]) || row.provider !== ec.product.environment.provider) throw new StepFailedError("A stored resource cannot be safely compiled for teardown.");
    nodes.set(row.address, { address: row.address, kind: row.kind as ResourceNode["kind"], provider: ec.product.environment.provider, region: row.region ?? ec.product.environment.region, nativeType: row.nativeType, ownership: row.ownership, spec: row.spec, origin: row.origin, dependsOn: row.dependsOn, specDigest: row.specDigest, labels: row.labels, ...(row.externalId ? { externalRef: row.externalId } : {}) });
  }
  const all = [...nodes.values()].sort((a, b) => a.address < b.address ? -1 : a.address > b.address ? 1 : 0);
  // An adopted object is torn down only if its claim allowed destruction (PROD-LIFE-11); refused at review, replan and apply alike.
  await assertTeardownOwnership(rt, ec, all);
  return { ec, graph: { ...graph, nodes: all, graphDigest: digest({ graphDigest: graph.graphDigest, nodes: all }) } };
}

function guard(plan: NormalizedPlan, nodes: readonly ResourceNode[]): void {
  if (plan.resourceChanges.some((c) => !["delete", "no-op", "read"].includes(c.action))) throw new StepFailedError("A teardown plan contains a non-deletion mutation.");
  for (const change of plan.resourceChanges.filter((c) => c.action === "delete")) {
    const node = nodes.find((n) => n.address === change.nodeAddress);
    if (!node || node.ownership !== "managed") throw new StepFailedError("A teardown deletion has no managed resource node; refusing to delete unmapped state.");
  }
  try { assertDeletionAllowed(plan, nodes); }
  catch (err) { if (err instanceof TofuDeletionRefusedError) throw new StepFailedError(err.message); throw err; }
}

/** Current provider reads confirm historical targets; no assessor grants write authority. */
async function guardDns(rt: Runtime, ec: ExecContext, nodes: readonly ResourceNode[], session: ProviderSession, signal: AbortSignal, lease: LeaseRef): Promise<DnsRecordSetProof[]> {
  const dns = nodes.filter((node) => node.ownership === "managed" && node.kind === "dns_record");
  if (dns.length === 0) return [];
  // Non-AWS record sets each leave an ownership proof that the review stores and apply must reproduce.
  let proofs: DnsRecordSetProof[] = [];
  const assess = async (readSession: ProviderSession): Promise<void> => {
    proofs = [];
    for (const node of dns) {
      const ctx = driverContext(rt, ec, readSession, signal, { node, fence: lease });
      let result: DnsAssessment;
      if (node.provider === "aws" && node.nativeType === "aws:route53_record" && readSession.provider === "aws") {
        result = await assessRecordDeletion({ ...ctx, session: readSession }, node);
      } else if (node.provider === "gcp" && node.nativeType === "gcp:dns_record_set" && readSession.provider === "gcp") {
        result = await assessGcpRecordDeletion({ ...ctx, session: readSession }, node, nodes);
      } else if (node.provider === "azure" && node.nativeType === "azure:dns_record_set" && readSession.provider === "azure") {
        result = await assessAzureRecordDeletion({ ...ctx, session: readSession }, node, nodes);
      } else if (node.provider === "oci" && node.nativeType === "oci:dns_rrset" && readSession.provider === "oci") {
        result = await assessOciRecordDeletion({ ...ctx, session: readSession }, node, nodes);
      } else {
        throw new StepFailedError("DNS record teardown is unsupported without a provider target ownership guard.");
      }
      if (!result.safe) throw new StepFailedError("DNS record target ownership could not be confirmed; refusing teardown.");
      if (node.provider !== "aws") {
        // A safe non-AWS verdict without a proof cannot be bound to the approval.
        if (!result.proof) throw new StepFailedError("DNS record target ownership could not be confirmed; refusing teardown.");
        proofs.push(result.proof);
      }
    }
  };
  try {
    if (session.provider === "oci" && session.capability !== PLAN_CAPABILITY) {
      if (session.capability !== ec.op.capability) throw new StepFailedError("DNS record target ownership could not be confirmed; refusing teardown.");
      // OCI's destroy grant has no DNS read rule. Independently authorize a
      // weaker read for this parent operation; keep its write session intact.
      const connection = await resolveConnection(rt, ec);
      if (connection.config.provider !== "oci") throw new StepFailedError("DNS record target ownership could not be confirmed; refusing teardown.");
      await withProviderSession(rt, ec, { purpose: "observe", capability: PLAN_CAPABILITY, fence: lease, connection }, async (readSession, claims) => {
        if (readSession.provider !== "oci" || readSession.capability !== PLAN_CAPABILITY ||
          readSession.scope.workspaceId !== ec.workspaceId || readSession.scope.projectId !== ec.op.projectId || readSession.scope.environmentId !== ec.environmentId ||
          claims.cap !== PLAN_CAPABILITY || claims.op !== ec.op.id || claims.digest !== ec.op.proposalDigest ||
          claims.sub !== (ec.op.principal.onBehalfOf ?? ec.op.principal.id) || claims.ws !== ec.workspaceId || claims.proj !== ec.op.projectId || claims.env !== ec.environmentId || claims.fence !== lease.fenceToken) {
          throw new StepFailedError("DNS record target ownership could not be confirmed; refusing teardown.");
        }
        await assess(readSession);
      });
    } else await assess(session);
  } catch (error) {
    if (error instanceof LeaseLostError || error instanceof StepFailedError) throw error;
    throw new StepFailedError("DNS record target ownership could not be confirmed; refusing teardown.");
  }
  return proofs;
}

/** Apply may dispatch only if the record sets proven now are exactly the reviewed ones. */
function bindDnsProofs(fresh: readonly DnsRecordSetProof[], reviewed: unknown): void {
  try { assertProofsMatchReview(fresh, reviewed); }
  catch { throw new StepFailedError("DNS record ownership changed since review; a new review is required."); }
}

async function reviewedDnsOwnership(rt: Runtime, ec: ExecContext, planDigest: string): Promise<unknown> {
  const row = await rt.d.evidence.find({ workspaceId: ec.workspaceId, operationId: ec.op.id, kind: "tofu_plan", digest: planDigest });
  return row?.summary.dnsOwnership;
}

async function planStage(rt: Runtime, operationId: string, lease: LeaseRef, ports: DestroyProviderPorts, approvedDigest?: string): Promise<PlanSummary> {
  if (approvedDigest !== undefined && !HEX64.test(approvedDigest)) throw new StepFailedError("The approved plan digest is invalid.");
  const { ec, graph } = await context(rt, operationId, lease, true);
  if (isDirect(ec)) return directPlanStage(rt, ec, graph, lease, ports, approvedDigest);
  const destroyRef=(ec.op.proposal as {broker?:{destroyPlan?:{operationId?:string;evidenceId?:string}}}).broker?.destroyPlan;
  const originalDigest=approvedDigest ?? (destroyRef ? ec.op.proposal.planDigest : undefined);
  if (destroyRef && (!destroyRef.operationId || !destroyRef.evidenceId || !originalDigest || originalDigest!==ec.op.proposal.planDigest || originalDigest!==ec.op.planDigest)) throw new StepFailedError("The source destroy review is unavailable; a new review is required.");
  const connection = await resolveConnection(rt, ec);
  const { ws } = buildWorkspace({ ec, graph, connection, drivers: rt.drivers, overrides: rt.d.tofuWorkspace });
  const semanticsArgs = (plan: NormalizedPlan) => ({ graph, connection, ws, planDigest: plan.planDigest });
  let dnsProofs: DnsRecordSetProof[] = [];
  const result = await withKeepAlive(rt, { lease, detail: "tofu destroy plan", operation: { workspaceId: ec.workspaceId, operationId } }, (signal) =>
    withProviderSession(rt, ec, { purpose: "observe", capability: PLAN_CAPABILITY, fence: lease, connection, durationSec: LONG_SESSION_SEC }, async (session) => {
      dnsProofs = await guardDns(rt, ec, graph.nodes, session, signal, lease);
      if (originalDigest) {
        if (!rt.d.planArtifacts) throw new StepFailedError("Durable reviewed-plan custody is required; a new review is required.");
        await rt.d.planArtifacts.inspect({ custody: planCustody(ec,graph.graphDigest,connection), planDigest: originalDigest, lease }, async () => undefined);
      }
      return rt.tofu.planWorkspace(ws, await tofuSessionFor(rt, ec, session, ws), { destroy: true, custody: planCustody(ec, graph.graphDigest, connection), lock: false, signal, deletionNodes: graph.nodes, inspectPlan: (plan) => guard(plan, graph.nodes), normalize: { fingerprintKey: rt.d.fingerprintKey } });
    })
  );
  await rt.d.leases.assertFence(lease.scope, lease.fenceToken);
  guard(result.plan, graph.nodes);
  const facts = extractPlanFacts(result.plan);
  const evidence = planEvidence({ plan: result.plan, facts, cost: {}, graphDigest: graph.graphDigest, stage: approvedDigest ? "final_plan" : "plan", approvedDigest });
  // Even an empty state plan needs observation: an out-of-band resource may
  // still exist, and refresh may already have removed missing resources.
  const destroyAddresses = graph.nodes.filter((node) => node.ownership === "managed").map((node) => node.address).sort();
  if (approvedDigest && result.plan.planDigest !== approvedDigest) throw new TofuPlanChangedError(approvedDigest, result.plan.planDigest);
  if (!approvedDigest && ec.op.planDigest && ec.op.planDigest !== result.plan.planDigest) throw new TofuPlanChangedError(ec.op.planDigest, result.plan.planDigest);
  // PROD-DUR-03: record at review, compare at every later stage (the source review operation holds the row).
  let semantics: Awaited<ReturnType<typeof recordReviewedSemantics>> | undefined;
  if (originalDigest) await assertApprovedSemantics(rt, ec, semanticsArgs(result.plan), "destroy final plan", { operationId: semanticsOperation(ec) });
  else semantics = await recordReviewedSemantics(rt, ec, semanticsArgs(result.plan));
  const dnsOwnership = dnsOwnershipSummary(dnsProofs);
  const summary = { ...evidence.summary, destroy: true, destroyAddresses, statefulDeletes: facts.destroyedStatefulAddresses, ...(semantics ? { semantics } : {}), ...(dnsOwnership ? { dnsOwnership } : {}) };
  if (!rt.d.planArtifacts) throw new StepFailedError("Durable reviewed-plan custody is required.");
  if (!originalDigest) await rt.d.planArtifacts.publish({ produced: result.produced, lease, evidence: {
    id: `evd_${digest({ w: ec.scope.id, kind: "tofu_plan", key: `destroy:${evidence.key}` }).slice(0,32)}`,
    workspaceId: ec.workspaceId, operationId, kind: "tofu_plan", digest: evidence.digest, summary, simulated: false,
  } });
  else await rt.evidence(ec.scope,{ kind:"tofu_plan",digest:evidence.digest,key:`destroy:${evidence.key}`,summary,simulated:false },{critical:false});
  return toPlanSummary(result.plan, facts, {});
}

async function reviewedPlan(rt: Runtime, ec: ExecContext, planDigest: string): Promise<string[]> {
  if (!HEX64.test(planDigest) || ec.op.planDigest !== planDigest) throw new StepFailedError("The destroy digest does not match this operation's reviewed plan.");
  const row = await rt.d.evidence.find({ workspaceId: ec.workspaceId, operationId: ec.op.id, kind: "tofu_plan", digest: planDigest });
  const addresses = row?.summary.destroyAddresses;
  if (!row || row.simulated || row.summary.destroy !== true || !Array.isArray(addresses) || addresses.some((a) => typeof a !== "string")) throw new StepFailedError("No reviewed destroy plan evidence with a verifiable node list was recorded.");
  return addresses as string[];
}

/** The shared gate must not treat policy's auto-approval as a person's approval. */
export async function checkDestroyApproval(rt: Runtime, operationId: string): Promise<{ approved: boolean; rejected: boolean; approvalId?: string }> {
  const op = await loadOperation(rt, operationId);
  if (op.capability !== "infrastructure.destroy") throw new StepFailedError("This is not a destroy operation.");
  const status = await rt.d.broker.approvalStatus(operationId);
  const approvalId = typeof status.approvalId === "string" && status.approvalId.length > 0 ? safeText(status.approvalId, 100) : undefined;
  return { approved: status.approved === true && !!approvalId && !status.rejected, rejected: status.rejected === true, ...(approvalId ? { approvalId } : {}) };
}

export function createDestroyActivities(rt: Runtime, ports: DestroyProviderPorts = (rt.d as typeof rt.d & { destroyProviders?: DestroyProviderPorts }).destroyProviders ?? {}): DestroyActivities & {
  reviewTeardown(input: { workspaceId: string; operationId: string }): Promise<DestroyReviewResult>;
} {
  return {
    async reviewTeardown(input) {
      return runDestroyReview(rt, await (ports.reviewBroker ?? platformBroker)(), input,
        (lease) => planStage(rt, input.operationId, lease, ports));
    },
    planDestroyInfrastructure: ({ operationId, lease }) => planStage(rt, operationId, lease, ports),
    finalDestroyPlan: ({ operationId, approvedPlanDigest, lease }) => planStage(rt, operationId, lease, ports, approvedPlanDigest),
    async applyDestroyInfrastructure({ operationId, planDigest, lease }) {
      const { ec, graph } = await context(rt, operationId, lease);
      const reviewedAddresses = await reviewedPlan(rt, ec, planDigest);
      const reviewedDns = isDirect(ec) ? undefined : await reviewedDnsOwnership(rt, ec, planDigest);
      const approval = await checkDestroyApproval(rt, operationId);
      if (!approval.approved || approval.rejected) throw new StepFailedError("Teardown requires a current digest-bound human approval.");
      // PROD-DUR-08: this exact destroy is applied at most once. A retry returns the saved result or refuses; it never re-applies.
      const effects = rt.d.effects;
      const effectScope: CleanupEffectScope | undefined = effects ? { workspaceId: ec.workspaceId, operationId, environmentId: ec.environmentId,
        provider: ec.product.environment.provider, planDigest, addresses: reviewedAddresses, fence: { scope: lease.scope, token: lease.fenceToken } } : undefined;
      if (effects && effectScope) { const prior = await priorCleanupResult(effects, effectScope); if (prior) return prior; }
      let effect: EffectRecord | undefined;
      if (isDirect(ec)) {
        await directPlanStage(rt, ec, graph, lease, ports, planDigest);
        await rt.d.leases.assertFence(lease.scope, lease.fenceToken);
        const freshApproval = await checkDestroyApproval(rt, operationId);
        if (!freshApproval.approved || freshApproval.rejected) throw new StepFailedError("The human approval is no longer valid.");
        if (effects && effectScope) effect = await beginCleanupEffect(effects, effectScope);
        try {
          const result = await directCall(rt, ec, graph, lease, ports, false, freshApproval.approved && !freshApproval.rejected);
          // The provider's answer is evidence even when the lease has since been lost.
          if (effects && effect) effect = await acceptCleanupEffect(effects, effect, result.deleted.length);
          await rt.d.leases.assertFence(lease.scope, lease.fenceToken);
          await rt.evidence(ec.scope, { kind: "tofu_apply", digest: digest({ destroy: true, planDigest, ...result }), key: `destroy:${planDigest}`,
            summary: { engine: "provider-teardown", destroy: true, planDigest, matchesReviewed: result.deleted.every((ref) => reviewedAddresses.includes(ref)), ...result }, simulated: false }, { critical: true });
          return { deleted: result.deleted.length };
        } catch (error) {
          if (effects && effect) await uncertainCleanupEffect(effects, effect, "Provider teardown outcome is unconfirmed; partial deletion is possible.");
          await rt.d.ops.markUncertain({ workspaceId: ec.workspaceId, operationId, reason: "Provider teardown outcome is unconfirmed; partial deletion is possible." }).catch(() => undefined);
          if (error instanceof LeaseLostError) throw error;
          throw new StepFailedError("Provider teardown ended without a confirmed outcome; partial deletion is possible.");
        }
      }
      const connection = await resolveConnection(rt, ec);
      const { ws } = buildWorkspace({ ec, graph, connection, drivers: rt.drivers, overrides: rt.d.tofuWorkspace });
      let started = false;
      try {
        if (!rt.d.planArtifacts) throw new StepFailedError("Durable reviewed-plan custody is required; a new review is required.");
        const custody = planCustody(ec, graph.graphDigest, connection);
        const result = await withKeepAlive(rt, { lease, detail: "tofu destroy apply", operation: { workspaceId: ec.workspaceId, operationId } }, (signal) =>
          // The authenticated consume commits its native hold before acquiring any mutating credential.
          rt.d.planArtifacts!.consume({ custody, planDigest, lease }, (original, dispatch) =>
            withProviderSession(rt, ec, { purpose: "deploy", fence: lease, connection, durationSec: LONG_SESSION_SEC }, async (session) => {
              await guardDns(rt, ec, graph.nodes, session, signal, lease);
              const tofuEnv = await tofuSessionFor(rt, ec, session, ws);
              return rt.tofu.applyVerifiedPlan(ws, { approvedDigest: planDigest, original, custody,
              beforeDispatch: async () => {
                const freshContext = await context(rt,operationId,lease);
                const freshConnection = await resolveConnection(rt,freshContext.ec);
                const freshWorkspace = buildWorkspace({ec:freshContext.ec,graph:freshContext.graph,connection:freshConnection,drivers:rt.drivers,overrides:rt.d.tofuWorkspace}).ws;
                if (digest(planCustody(freshContext.ec,freshContext.graph.graphDigest,freshConnection)) !== digest(custody) || digest(freshWorkspace) !== digest(ws)) throw new StepFailedError("Reviewed destroy provenance changed; a new review is required.");
                // PROD-DUR-03: targets, locks, backend, adoption claims and ownership must equal what the reviewer approved.
                await assertApprovedSemantics(rt, freshContext.ec, { graph: freshContext.graph, connection: freshConnection, ws: freshWorkspace, planDigest }, "destroy dispatch", { operationId: semanticsOperation(freshContext.ec) });
                const current = await checkDestroyApproval(rt, operationId);
                if (!current.approved || current.rejected) throw new StepFailedError("The human approval is no longer valid.");
                bindDnsProofs(await guardDns(rt, freshContext.ec, freshContext.graph.nodes, session, signal, lease), reviewedDns);
                await rt.d.leases.assertFence(lease.scope,lease.fenceToken);
                if (effects && effectScope) effect = await beginCleanupEffect(effects, effectScope);
                started=true; await dispatch();
              }, destroy: true, deletionNodes: graph.nodes, session: tofuEnv, signal, normalize: { fingerprintKey: rt.d.fingerprintKey }, inspectPlan: async (plan) => {
              guard(plan, graph.nodes);
              bindDnsProofs(await guardDns(rt, ec, graph.nodes, session, signal, lease), reviewedDns);
              await rt.d.leases.assertFence(lease.scope, lease.fenceToken);
            } });
          }))
        );
        // The provider's answer is evidence even when the lease has since been lost.
        if (effects && effect) effect = await acceptCleanupEffect(effects, effect, result.plan.summary.delete);
        await rt.d.leases.assertFence(lease.scope, lease.fenceToken);
        await rt.evidence(ec.scope, { kind: "tofu_apply", digest: digest({ destroy: true, planDigest, deleted: result.plan.summary.delete }), key: `destroy:${planDigest}`, summary: { destroy: true, planDigest, deleted: result.plan.summary.delete, exitCode: result.apply.exitCode }, simulated: false }, { critical: true });
        // Resource status stays unconfirmed until observation proves absence.
        return { deleted: result.plan.summary.delete };
      } catch (err) {
        if (err instanceof TofuPlanChangedError || err instanceof StepFailedError || err instanceof SemanticsChangedError) throw err;
        if (err instanceof TofuDeletionRefusedError) throw new StepFailedError(err.message);
        if (!started && err instanceof TofuPlanProvenanceError) throw new StepFailedError("Reviewed plan provenance changed; a new review is required.");
        if (effects && effect) await uncertainCleanupEffect(effects, effect, "Teardown did not complete; resource absence is unconfirmed.");
        if (started) await rt.d.ops.markUncertain({ workspaceId: ec.workspaceId, operationId, reason: "Teardown did not complete; resource absence is unconfirmed." }).catch(() => undefined);
        if (err instanceof LeaseLostError) throw err;
        if (!started) throw new StepFailedError("Teardown did not start; nothing was applied.");
        if (err instanceof TofuCommandError && err.code === "tofu_command_failed") throw new StepFailedError("OpenTofu teardown failed; partial deletion is possible. Reconcile must observe the environment.");
        throw new Error("Teardown ended without a confirmed outcome; partial deletion is possible.");
      }
    },
    async verifyDestroyedInfrastructure({ operationId, planDigest, lease }) {
      const { ec, graph } = await context(rt, operationId, lease);
      const addresses = await reviewedPlan(rt, ec, planDigest);
      if (isDirect(ec)) {
        const remaining = await directCall(rt, ec, graph, lease, ports, true, true);
        await rt.d.leases.assertFence(lease.scope, lease.fenceToken);
        const applied = await rt.d.evidence.find({ workspaceId: ec.workspaceId, operationId, kind: "tofu_apply" });
        const unresolved = !applied || applied.simulated || applied.summary.planDigest !== planDigest || applied.summary.matchesReviewed === false || remaining.uncertain.length > 0 || blockingSkips(remaining.skipped).length > 0 ||
          (Array.isArray(applied.summary.uncertain) && applied.summary.uncertain.length > 0) ||
          (Array.isArray(applied.summary.skipped) && blockingSkips(applied.summary.skipped.filter((ref): ref is string => typeof ref === "string")).length > 0);
        const failed = new Set([...remaining.deleted, ...remaining.retained.filter((ref) => addresses.includes(ref))]).size;
        // C1 dry-run enumerates deletable live objects; retained objects are not absence targets.
        const status = unresolved ? "unknown" : failed ? "failed" : "passed";
        await rt.evidence(ec.scope, { kind: "verification", digest: digest({ destroy: true, planDigest, status, ...remaining }), key: `destroy:${planDigest}`,
          summary: { destroy: true, planDigest, engine: "provider-teardown", status, ...remaining }, simulated: false }, { critical: false });
        return { status, checks: addresses.length, failed };
      }
      const connection = await resolveConnection(rt, ec);
      const reviewedDns = await reviewedDnsOwnership(rt, ec, planDigest);
      let failed = 0, unknown = 0;
      const checks: { address: string; presence: string; simulated: boolean; basis?: string[]; dns?: string }[] = [];
      await withKeepAlive(rt, { lease, detail: "verify destroy absence", operation: { workspaceId: ec.workspaceId, operationId } }, (signal) =>
        withProviderSession(rt, ec, { purpose: "observe", capability: OBSERVE_CAPABILITY, fence: lease, connection }, async (session) => {
          const stored = new Map((await rt.d.resources.list(ec.workspaceId, ec.environmentId)).map((row) => [row.address, row]));
          for (const address of addresses) {
            const node = graph.nodes.find((n) => n.address === address);
            const driver = node ? rt.drivers(node.provider, node.nativeType) : undefined;
            let presence = "unknown", simulated = false, basis: string[] | undefined;
            if (node && driver?.observe) {
              try {
                const dctx = driverContext(rt, ec, session, signal, { node, fence: lease, connection });
                const obs = await driver.observe(dctx, node, stored.get(address)?.externalId);
                simulated = obs.simulated;
                if (obs.address === address && !simulated) presence = obs.presence;
                // OCI: a driver `missing` stands only if independent family readback (GET state / 404 plus
                // complete listing, newest delete work request) agrees. MySQL and unregistered types never pass.
                if (presence === "missing" && node.provider === "oci" && session.provider === "oci") {
                  const found = await readDeletionEvidence({ ...dctx, session }, node, stored.get(address)?.externalId, { observation: obs });
                  presence = presenceOfDeletion(found);
                  basis = found.basis;
                }
              } catch { /* An unreadable API cannot prove absence. */ }
            }
            // Non-AWS DNS: absence counts only against the reviewed ownership proof (idempotent re-run = already_absent).
            let dns: string | undefined;
            if (node?.kind === "dns_record" && node.provider !== "aws") {
              dns = dnsDisposition(reviewedProofFor(reviewedDns, address), { presence, simulated });
              if (presence === "missing" && dns === "unknown") presence = "unknown";
            }
            if (presence === "present") failed++;
            else if (presence !== "missing") unknown++;
            checks.push({ address, presence, simulated, ...(basis ? { basis } : {}), ...(dns ? { dns } : {}) });
            const row = stored.get(address);
            if (row) await rt.d.resources.setStatus({ workspaceId: ec.workspaceId, resourceId: row.id, status: presence === "missing" ? "deleted" : "unknown" });
          }
        })
      );
      await rt.d.leases.assertFence(lease.scope, lease.fenceToken);
      const status = unknown ? "unknown" : failed ? "failed" : "passed";
      await rt.evidence(ec.scope, { kind: "verification", digest: digest({ destroy: true, planDigest, checks }), key: `destroy:${planDigest}`, summary: { destroy: true, planDigest, status, checks }, simulated: checks.some((c) => c.simulated) }, { critical: false });
      return { status, checks: checks.length, failed };
    },
  };
}
