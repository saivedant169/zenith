/**
 * LIFE-11 adoption on the owned kind cluster, through the product API with browser approvals only:
 * an out-of-band postgres StatefulSet is declared `referenced`, adopted (manage), released (objects survive),
 * adopted again (manage_and_destroy) and torn down with the environment. The adopted StatefulSet and its
 * template claim are deleted; a never-adopted StatefulSet and claim beside it survive. Fixture objects are
 * created and read back with the independent observer kubeconfig, never through Zenith.
 */
import { browserRequest, ok, action, nonce, until, command, ensure, sha256 } from "../../../tests/e2e/default/support.mjs";
import { approveOperation, connectKind, createTenant, deployKind, detailOf, type OperatedContext, type Tenant } from "./operated";
import { capabilityOperation } from "./export-data";

interface Adoption { id: string; resourceId: string; externalId: string; lifecycle: string; status: string }
const terminal = ["succeeded", "failed", "uncertain", "denied", "expired", "cancelled", "rejected"];

function kube(ctx: OperatedContext) {
  const base = ["--kubeconfig", ctx.config.kind.observerKubeconfigFile, "--context", ctx.config.kind.context, "-n", ctx.config.kind.namespace];
  return {
    apply: (document: unknown) => {
      const options = { input: JSON.stringify(document), timeout: 60_000 };
      return command("kubectl", [...base, "apply", "-f", "-"], options);
    },
    present: async (kind: string, name: string) => (await command("kubectl", [...base, "get", kind, name, "--ignore-not-found", "-o", "name"])).trim() !== "",
    remove: (kind: string, name: string) => command("kubectl", [...base, "delete", kind, name, "--ignore-not-found", "--wait=true", "--timeout=120s"]),
    uid: async (kind: string, name: string) => JSON.parse(await command("kubectl", [...base, "get", kind, name, "-o", "json"])).metadata.uid as string,
  };
}

/** Zero replicas: no image is pulled. The claim is created under the name the controller gives ordinal 0. */
function fixtures(namespace: string, name: string, run: string) {
  const claimSpec = { accessModes: ["ReadWriteOnce"], resources: { requests: { storage: "1Mi" } } };
  const labels = { "io.zenith.driver": "DRV4-ADOPT", "io.zenith.driver.run": run };
  return [
    { apiVersion: "apps/v1", kind: "StatefulSet", metadata: { name, namespace, labels },
      spec: { replicas: 0, serviceName: name, selector: { matchLabels: { app: name } },
        template: { metadata: { labels: { app: name } }, spec: { automountServiceAccountToken: false, containers: [{ name: "db", image: "registry.invalid/zenith/never-pulled:0" }] } },
        volumeClaimTemplates: [{ metadata: { name: "data" }, spec: claimSpec }] } },
    { apiVersion: "v1", kind: "PersistentVolumeClaim", metadata: { name: `data-${name}-0`, namespace, labels }, spec: claimSpec },
  ];
}

async function adoptions(tenant: Tenant): Promise<Adoption[]> {
  const data = ok(await browserRequest(tenant.owner, `/api/platform/v1/environments/${tenant.environmentId}/portability`, undefined, "GET", tenant.workspaceId));
  ensure(data.environmentId === tenant.environmentId && !data.truncated, "complete-adoption-readback");
  return data.adoptions as Adoption[];
}

/** Review, then approve every round the destroy operation asks for in the browser, until it settles. */
async function teardown(ctx: OperatedContext, tenant: Tenant): Promise<void> {
  const env = `/api/platform/v1/environments/${tenant.environmentId}/teardown-review`;
  const requested = ok(await browserRequest(tenant.owner, env, { idempotencyKey: nonce() }, "POST", tenant.workspaceId));
  ensure(typeof requested.reviewOperationId === "string", "teardown-review-requested");
  const reviewed = await until(async () => ok(await browserRequest(tenant.owner, `${env}?reviewId=${requested.reviewOperationId}`, undefined, "GET", tenant.workspaceId)).review,
    (review: { operationId?: string; status: string } | null) => !!review?.operationId || terminal.includes(review?.status ?? ""));
  if (typeof reviewed.operationId !== "string" && ctx.input.env.ZENITH_OPERATED_DIAGNOSTICS === "1") {
    // The review's status and the product's own refusal sentence, with addresses, URLs and long tokens elided.
    const failed = await detailOf(tenant, requested.reviewOperationId).catch(() => undefined) as { operation?: { status?: string; error?: unknown } } | undefined;
    const raw = failed?.operation?.error;
    const error = typeof raw === "string" ? raw.replace(/[a-z]+:\/\/\S+/gi, "…url").replace(/(?=[A-Za-z0-9_+/=-]*[A-Z0-9+/=])[A-Za-z0-9_+/=-]{24,}/g, "…").slice(0, 300) : null;
    process.stderr.write(`operated outside-step failed: journey:teardown-review ${JSON.stringify({ status: reviewed.status, error })}\n`);
  }
  ensure(typeof reviewed.operationId === "string", "teardown-review-proposal");
  const id: string = reviewed.operationId;
  ctx.quiescence.add(async () => {
    const view = await detailOf(tenant, id);
    if (!terminal.includes(view.operation.status) && view.operation.status !== "running")
      ok(await browserRequest(tenant.owner, `/api/platform/v1/operations/${id}/cancel`, { reason: "Owned local rehearsal cleanup" }, "POST", tenant.workspaceId));
  });
  for (let round = 0; round < 3; round++) {
    const view = await until(() => detailOf(tenant, id), (d: { operation: { status: string } }) => d.operation.status === "awaiting_approval" || terminal.includes(d.operation.status), 300_000);
    if (terminal.includes(view.operation.status)) break;
    ensure(view.operation.capability === "infrastructure.destroy" && view.operation.environmentId === tenant.environmentId, "teardown-operation-binding");
    await approveOperation(ctx, tenant, id);
  }
  const done = await until(() => detailOf(tenant, id), (d: { operation: { status: string } }) => terminal.includes(d.operation.status), 300_000);
  if (done.operation.status !== "succeeded" && ctx.input.env.ZENITH_OPERATED_DIAGNOSTICS === "1") {
    // Status, authority phase and the product's own sentence, with URLs and long token-like strings elided (lowercase rule codes stay readable).
    const raw = (done.operation as { error?: unknown }).error;
    const error = typeof raw === "string" ? raw.replace(/[a-z]+:\/\/\S+/gi, "…url").replace(/(?=[A-Za-z0-9_+/=-]*[A-Z0-9+/=])[A-Za-z0-9_+/=-]{24,}/g, "…").slice(0, 400) : null;
    process.stderr.write(`operated outside-step failed: journey:teardown-terminal ${JSON.stringify({ status: done.operation.status, phase: done.authority?.phase ?? null, round: done.operation.approvalRound ?? null, error })}\n`);
  }
  ensure(done.operation.status === "succeeded", "teardown-terminal");
}

export async function operatedAdoption(ctx: OperatedContext): Promise<void> {
  const k = kube(ctx), namespace = ctx.config.kind.namespace, run = ctx.input.runId;
  const adopted = `legacy-${run}`, kept = `kept-${run}`;
  let tenant!: Tenant, resourceId = "";
  const claim = (lifecycle: "manage" | "manage_and_destroy") => ({ claim: { externalId: `${namespace}/${adopted}`, acknowledge: true, lifecycle } });
  await ctx.step("adopt-release-retains", async () => {
    // Registered before any fixture exists, so a lost create response is still cleaned.
    ctx.cleanup.add(async () => {
      for (const name of [adopted, kept]) { await k.remove("statefulset", name); await k.remove("persistentvolumeclaim", `data-${name}-0`); }
      for (const name of [adopted, kept]) ensure(!(await k.present("statefulset", name)) && !(await k.present("persistentvolumeclaim", `data-${name}-0`)), "adoption-fixture-absence");
    });
    for (const name of [adopted, kept]) for (const document of fixtures(namespace, name, run)) await k.apply(document);
    const uid = await k.uid("statefulset", adopted);
    tenant = await createTenant(ctx, "adopt");
    await connectKind(ctx, tenant);
    tenant.manifest = { ...tenant.manifest, resources: [{ id: "legacy-db", name: "legacy-db", kind: "postgres", config: {}, size: "small", ownership: "referenced", externalRef: `${namespace}/${adopted}` }] };
    await action(tenant.owner, "project.updateManifest", { projectId: tenant.project.id, manifest: tenant.manifest });
    await deployKind(ctx, tenant);
    const resources = ok(await browserRequest(tenant.owner, `/api/platform/v1/environments/${tenant.environmentId}/resources`, undefined, "GET", tenant.workspaceId));
    const rows = (resources.rows as { id?: string; node: { kind: string; ownership: string } }[]).filter(row => row.node.kind === "postgres");
    ensure(rows.length === 1 && rows[0].node.ownership === "referenced" && typeof rows[0].id === "string", "referenced-resource-row");
    resourceId = rows[0].id!;
    await capabilityOperation(ctx, tenant, resourceId, "resource.adopt", claim("manage"));
    const managed = (await adoptions(tenant)).filter(a => a.resourceId === resourceId && a.status === "active");
    ensure(managed.length === 1 && managed[0].lifecycle === "manage" && managed[0].externalId === `${namespace}/${adopted}`, "adoption-claim-readback");
    await capabilityOperation(ctx, tenant, resourceId, "resource.release", { adoptionId: managed[0].id, reason: "LIFE-11 release rehearsal" });
    ensure(!(await adoptions(tenant)).some(a => a.resourceId === resourceId && a.status === "active"), "adoption-released");
    // Release never deletes: the same object (same uid) and its claim are still there.
    ensure(await k.uid("statefulset", adopted) === uid && await k.present("persistentvolumeclaim", `data-${adopted}-0`), "release-retains-objects");
  });
  await ctx.step("adopt-destroy-teardown", async () => {
    await capabilityOperation(ctx, tenant, resourceId, "resource.adopt", claim("manage_and_destroy"));
    const active = (await adoptions(tenant)).filter(a => a.resourceId === resourceId && a.status === "active");
    ensure(active.length === 1 && active[0].lifecycle === "manage_and_destroy", "destroy-claim-readback");
    await action(tenant.owner, "env.updatePolicies", { environmentId: tenant.environmentId, allowStatefulDeletion: true });
    await teardown(ctx, tenant);
    const gone = await until(async () => !(await k.present("statefulset", adopted)) && !(await k.present("persistentvolumeclaim", `data-${adopted}-0`)), (absent: boolean) => absent, 120_000);
    ensure(gone, "adopted-objects-deleted");
    ensure(await k.present("statefulset", kept) && await k.present("persistentvolumeclaim", `data-${kept}-0`), "never-adopted-objects-survive");
    ctx.readbacks.adoption = sha256({ deleted: [adopted, `data-${adopted}-0`], kept: [kept, `data-${kept}-0`], uid: await k.uid("statefulset", kept) });
  });
}
