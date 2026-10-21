/**
 * `azure:container_app` — portable `container_service` on Azure Container Apps.
 *
 * Declarative (tofu): one `azurerm_container_app` in the environment's
 * Container Apps environment (owned by the network node), Consumption
 * workload profile, single-revision mode.
 *   - size: the portable (vcpu, memoryMb) is rounded UP to the nearest valid
 *     Consumption pair (memory = 2 Gi per vCPU, 0.25 steps); the effective
 *     values are what `expectedAttributes` compares (nano 256 MB → 512 MB).
 *   - replicas: min = max = `spec.replicas` (the spec has no autoscaling
 *     intent, so none is invented; day-two `service.scale` changes it).
 *   - ingress: only when the app has a port. `external_enabled` is true only
 *     when the load balancer node routes to it; otherwise the app is reachable
 *     from inside the environment only. TLS is terminated by the environment;
 *     insecure (plain HTTP) connections are redirected.
 *   - identity: the workload's user-assigned identity (`identity/<svc>`), used
 *     for ACR pull and for Key Vault secret references. Secrets are references
 *     only (see workload.ts): no value is ever compiled.
 *   - probes: HTTP liveness/readiness on `healthPath` when the spec has one.
 *
 * Native (read-only): revisions and replicas via ARM for `runtime`.
 * Day two: `service.restart` (restart the active revision) and `service.scale`
 * (update replica counts), both guarded by the Zenith tag check in `ops.ts`.
 *
 * Honest limits: exercised with schema validation and a fake ARM server only.
 * Built images are bootstrapped then owned by the digest release path (see workload.ts).
 */
import type { AzureSession } from "@/lib/credentials/types";
import type { CompileContext, NativeOperation, TofuFragment } from "@/lib/drivers/types";
import type { ResourceNode } from "@/lib/resources/types";
import type { ContainerServiceSpec } from "@/lib/resources/specs";
import { block, fragment, resolveNetwork, specOf } from "@/lib/providers/azure/compile-util";
import { exportLocals, exportRef } from "@/lib/providers/azure/exports";
import { defineAzureDriver, locateByTags, pick, props, type AzureCtx, type Located, type RuntimeRead } from "@/lib/providers/azure/kit";
import { armClient, pollOperation, type ArmClient, type ArmResource, type Json } from "@/lib/providers/azure/arm";
import { azureTags, tfLabel } from "@/lib/providers/azure/naming";
import { acaSize, API } from "@/lib/providers/azure/platform";
import { bootstrapArgs, buildWorkload, isRouted, memoryToMb, RELEASE_ARGS_PATH, RELEASE_IMAGE_PATH } from "@/lib/providers/azure/drivers/compute/workload";
import { clientRequestId, intInRange, notManagedHere, opFailure, opFailureFromError } from "@/lib/providers/azure/ops";
import { factsForNode, lifecycleIgnoreChanges } from "@/lib/ownership";

export const CONTAINER_APP = { type: "Microsoft.App/containerApps", apiVersion: API.containerApps } as const;

export function compileContainerApp(node: ResourceNode, ctx: CompileContext): TofuFragment {
  const spec = specOf<ContainerServiceSpec>(node);
  const a = node.address;
  const net = resolveNetwork(node, ctx);
  const w = buildWorkload(node, ctx, spec);
  const L = tfLabel(a, "app");
  const replicas = Math.max(1, Math.trunc(spec.replicas));
  const hasIngress = typeof spec.port === "number";

  const probe = (kind: "liveness" | "readiness") => ({
    transport: "HTTP",
    port: spec.port,
    path: spec.healthPath,
    interval_seconds: 10,
    failure_count_threshold: 3,
    ...(kind === "readiness" ? { success_count_threshold: 1 } : {}),
    initial_delay: 5,
    timeout: 3,
  });

  const container: Record<string, unknown> = {
    name: w.containerName,
    image: w.image,
    cpu: w.cpu,
    memory: w.memory,
    ...(spec.artifact.type === "built" ? { args: bootstrapArgs(spec.port) } : {}),
    ...(w.env.length ? { env: w.env } : {}),
    ...(hasIngress && spec.healthPath ? { liveness_probe: [probe("liveness")], readiness_probe: [probe("readiness")] } : {}),
  };

  // The release owns the image when built; an autoscaler owns the replica range (field-ownership registry).
  const releasePaths = spec.artifact.type === "built" ? [RELEASE_IMAGE_PATH, RELEASE_ARGS_PATH] : [];
  const owned = lifecycleIgnoreChanges({ resourceType: "azurerm_container_app", address: node.address, facts: factsForNode(node, ctx.nodes ? { nodes: ctx.nodes() } : undefined) });
  // Release paths keep their order (unchanged output); ownership adds only paths not already present.
  const ignoreChanges = owned ? [...releasePaths, ...owned.ignore_changes.filter((path) => !releasePaths.includes(path))] : releasePaths;
  const body: Record<string, unknown> = {
    name: w.name,
    resource_group_name: exportRef(net, "rg_name"),
    container_app_environment_id: exportRef(net, "cae_id"),
    revision_mode: "Single",
    workload_profile_name: "Consumption",
    ...(w.identityBlock ? { identity: w.identityBlock } : {}),
    ...(w.registry.length ? { registry: w.registry } : {}),
    ...(w.secrets.length ? { secret: w.secrets } : {}),
    ...(hasIngress
      ? {
          ingress: {
            target_port: spec.port,
            external_enabled: isRouted(node, ctx),
            allow_insecure_connections: false,
            transport: "auto",
            traffic_weight: [{ latest_revision: true, percentage: 100 }],
          },
        }
      : {}),
    template: { min_replicas: replicas, max_replicas: replicas, container: [container] },
    ...(ignoreChanges.length ? { lifecycle: { ignore_changes: ignoreChanges } } : {}),
    tags: azureTags(ctx, node),
  };

  return fragment({
    resource: block("azurerm_container_app", L, body),
    locals: exportLocals(a, {
      id: `\${azurerm_container_app.${L}.id}`,
      name: `\${azurerm_container_app.${L}.name}`,
      ...(hasIngress ? { fqdn: `\${azurerm_container_app.${L}.ingress[0].fqdn}` } : {}),
    }),
  });
}

/* --------------------------------- expected --------------------------------- */

export function expectedContainerApp(node: ResourceNode): Record<string, unknown> {
  const spec = specOf<ContainerServiceSpec>(node);
  const out: Record<string, unknown> = { minReplicas: Math.max(1, Math.trunc(spec.replicas)), maxReplicas: Math.max(1, Math.trunc(spec.replicas)) };
  try {
    const size = acaSize(spec.vcpu, spec.memoryMb);
    out.vcpu = size.cpu;
    out.memoryMb = size.memoryMb;
  } catch {
    /* an unrealizable size is a compile error; drift simply has nothing to compare */
  }
  if (typeof spec.port === "number") out.port = spec.port;
  if (spec.artifact.type === "image") out.image = spec.artifact.ref;
  return out;
}

function firstContainer(res: ArmResource): Json | undefined {
  const cs = pick<Json[]>(props(res), "template", "containers");
  return Array.isArray(cs) ? cs[0] : undefined;
}

export function readContainerApp(res: ArmResource): Record<string, unknown> {
  const c = firstContainer(res);
  return {
    vcpu: pick<number>(c, "resources", "cpu"),
    memoryMb: memoryToMb(pick(c, "resources", "memory")),
    minReplicas: pick<number>(props(res), "template", "scale", "minReplicas"),
    maxReplicas: pick<number>(props(res), "template", "scale", "maxReplicas"),
    port: pick<number>(props(res), "configuration", "ingress", "targetPort"),
    image: pick<string>(c, "image"),
  };
}

/* --------------------------------- runtime ---------------------------------- */

interface Revision {
  id: string;
  name: string;
  properties?: Json;
}

async function activeRevisions(arm: ArmClient, appId: string): Promise<{ revisions: Revision[]; requestIds: string[] }> {
  const { items, requestIds } = await arm.list<Revision>(`${appId}/revisions`, { apiVersion: API.containerApps }, 3);
  const active = items.filter((r) => pick<boolean>(r, "properties", "active") === true);
  return { revisions: active.slice(0, 3), requestIds };
}

export async function runtimeContainerApp(_ctx: AzureCtx, _node: ResourceNode, res: ArmResource, arm: ArmClient): Promise<RuntimeRead> {
  const desired = pick<number>(props(res), "template", "scale", "minReplicas");
  const { revisions } = await activeRevisions(arm, res.id);
  const counts: Record<string, number> = {};
  const signals: string[] = [];
  if (typeof desired === "number") counts.desired = desired;
  counts.activeRevisions = revisions.length;
  if (revisions.length === 0) return { health: "unknown", counts, signals: ["no_active_revision"] };

  let running = 0;
  let notRunning = 0;
  let unhealthyRevisions = 0;
  let worstState: "Running" | "Processing" | "Degraded" | "Failed" | "Stopped" | "Unknown" = "Running";
  const rank = { Running: 0, Processing: 1, Degraded: 2, Stopped: 3, Failed: 4, Unknown: 1 } as const;
  for (const rev of revisions) {
    const state = (pick<string>(rev, "properties", "runningState") ?? "Unknown") as keyof typeof rank;
    if (!(state in rank)) continue;
    if (rank[state] > rank[worstState]) worstState = state;
    if (pick<string>(rev, "properties", "healthState") === "Unhealthy") {
      unhealthyRevisions++;
      signals.push(`revision_unhealthy:${rev.name}`);
    }
    if (state !== "Running" && state !== "Processing") signals.push(`revision_${state.toLowerCase()}:${rev.name}`);
    const replicas = await arm.list<Json>(`${rev.id}/replicas`, { apiVersion: API.containerApps }, 2);
    for (const r of replicas.items) {
      const s = pick<string>(r, "properties", "runningState");
      if (s === "Running") running++;
      else {
        notRunning++;
        signals.push(`replica_${String(s ?? "unknown").toLowerCase()}:${String(r.name ?? "?").slice(0, 60)}`);
      }
    }
  }
  counts.running = running;
  counts.notRunning = notRunning;
  counts.unhealthyRevisions = unhealthyRevisions;

  const wantsReplicas = typeof desired === "number" && desired > 0;
  let health: RuntimeRead["health"];
  if (worstState === "Failed" || worstState === "Stopped" || (wantsReplicas && running === 0 && worstState !== "Processing")) health = "unhealthy";
  else if (worstState === "Degraded" || unhealthyRevisions > 0 || notRunning > 0 || (wantsReplicas && running < desired)) health = "degraded";
  else health = "healthy";
  return { health, counts, signals: [...new Set(signals)].slice(0, 20) };
}

/* ------------------------------- day-two ops -------------------------------- */

async function locateApp(ctx: AzureCtx, node: ResourceNode, input: Record<string, unknown>): Promise<Located> {
  return locateByTags(ctx, node, CONTAINER_APP, typeof input.externalId === "string" ? input.externalId : undefined);
}

const restart: NativeOperation<AzureSession> = async (ctx, node, input) => {
  const arm = armClient(ctx.session, ctx.signal);
  try {
    const found = await locateApp(ctx, node, input);
    if (found.state !== "found") return opFailure(`Cannot restart ${node.address}: ${found.state}.`);
    const refused = notManagedHere(ctx, node, found.resource);
    if (refused) return opFailure(`Refusing to restart ${node.address}: ${refused}.`);
    const { revisions, requestIds } = await activeRevisions(arm, found.resource.id);
    if (revisions.length === 0) return opFailure(`${node.address} has no active revision to restart.`, { requestIds });
    // a requested revision must be one of the ACTIVE ones just listed; it is never spliced into a URL from input
    const wanted = typeof input.revision === "string" ? input.revision : undefined;
    const targets = wanted ? revisions.filter((r) => r.name === wanted) : revisions;
    if (targets.length === 0) return opFailure(`Revision "${String(wanted).slice(0, 60)}" is not an active revision of ${node.address}.`, { requestIds });
    const restarted: string[] = [];
    for (const rev of targets) {
      const r = await arm.post(`${rev.id}/restart`, { apiVersion: API.containerApps, headers: { "x-ms-client-request-id": clientRequestId(ctx) } });
      if (r.requestId) requestIds.push(r.requestId);
      restarted.push(rev.name);
    }
    return { ok: true, summary: `Restarted ${restarted.length} active revision${restarted.length === 1 ? "" : "s"} of ${node.address}.`, data: { revisions: restarted }, requestIds, simulated: false };
  } catch (e) {
    return opFailureFromError(e, `Restart of ${node.address}`);
  }
};

const scale: NativeOperation<AzureSession> = async (ctx, node, input) => {
  const replicas = intInRange(input.replicas ?? input.minReplicas, 1, 300);
  if (replicas === undefined) return opFailure("service.scale needs an integer `replicas` between 1 and 300.");
  const requestedMax = input.maxReplicas === undefined ? undefined : intInRange(input.maxReplicas, replicas, 1000);
  if (input.maxReplicas !== undefined && requestedMax === undefined) return opFailure("`maxReplicas` must be an integer between `replicas` and 1000.");
  const arm = armClient(ctx.session, ctx.signal);
  try {
    const found = await locateApp(ctx, node, input);
    if (found.state !== "found") return opFailure(`Cannot scale ${node.address}: ${found.state}.`);
    const refused = notManagedHere(ctx, node, found.resource);
    if (refused) return opFailure(`Refusing to scale ${node.address}: ${refused}.`);
    const currentMin = pick<number>(props(found.resource), "template", "scale", "minReplicas");
    const currentMax = pick<number>(props(found.resource), "template", "scale", "maxReplicas");
    const maxReplicas = requestedMax ?? Math.max(typeof currentMax === "number" ? currentMax : replicas, replicas);
    const r = await arm.patch(found.resource.id, {
      apiVersion: API.containerApps,
      headers: { "x-ms-client-request-id": clientRequestId(ctx) },
      // JSON merge patch: only the scale bounds change; `location` is required by the API
      body: { location: found.resource.location, properties: { template: { scale: { minReplicas: replicas, maxReplicas } } } },
    });
    const outcome = await pollOperation(ctx.session, r, { signal: ctx.signal });
    const requestIds = [r.requestId, ...outcome.requestIds].filter((x): x is string => Boolean(x));
    if (outcome.state === "failed") return opFailure(`Scaling ${node.address} failed: ${outcome.detail ?? "the operation reported failure"}.`, { requestIds });
    return {
      ok: true,
      summary: `${outcome.state === "succeeded" ? "Scaled" : "Accepted scaling of"} ${node.address} to ${replicas}–${maxReplicas} replicas${currentMin === replicas ? " (unchanged)" : ""}${outcome.state === "succeeded" ? "" : "; completion not confirmed yet"}.`,
      data: { minReplicas: replicas, maxReplicas, previousMinReplicas: currentMin ?? null, operation: outcome.state },
      requestIds,
      simulated: false,
    };
  } catch (e) {
    return opFailureFromError(e, `Scaling ${node.address}`);
  }
};

export const containerAppDriver = defineAzureDriver({
  id: "azure.container_app@1",
  kind: "container_service",
  nativeType: "azure:container_app",
  arm: CONTAINER_APP,
  compile: compileContainerApp,
  expected: expectedContainerApp,
  read: readContainerApp,
  native: (res) => ({
    provisioningState: props(res).provisioningState,
    latestRevision: props(res).latestReadyRevisionName,
    fqdn: pick(props(res), "configuration", "ingress", "fqdn"),
    external: pick(props(res), "configuration", "ingress", "external"),
    customDomains: pick<Json[]>(props(res), "configuration", "ingress", "customDomains")?.map((d) => ({ name: d.name, bindingType: d.bindingType })),
    workloadProfile: props(res).workloadProfileName,
  }),
  runtime: runtimeContainerApp,
  serving: true,
  operations: { "service.restart": restart, "service.scale": scale },
});
