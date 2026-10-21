/**
 * `gcp:cloud_run_service` — a Cloud Run v2 service for `container_service`.
 *
 * Compile (google_cloud_run_v2_service):
 *   - literal image artifacts are declarative; built artifacts use a pinned
 *     bootstrap image until release patches the digest. OpenTofu ignores only
 *     their image and digest annotation, retaining the released image on apply;
 *   - cpu/memory from `vcpu`/`memoryMb` (clamped to Cloud Run's lattice);
 *   - instances: `replicas` is the always-warm minimum, the maximum is
 *     `max(10, 4 × replicas)` (Cloud Run has no fixed replica count; this is
 *     the documented translation), both on the revision template;
 *   - ingress: `web` workloads default to INTERNAL_LOAD_BALANCER (only the
 *     global external LB can reach the service), `worker`s to INTERNAL_ONLY;
 *     `spec.ingress` of internal/private/all is honoured, unknown values fall
 *     back to the default — never to ALL. A public `web` service gets one
 *     `allUsers` → `roles/run.invoker` binding, because the LB cannot present
 *     an identity to Cloud Run; direct `.run.app` access stays blocked by the
 *     ingress setting;
 *   - Direct VPC egress to private ranges with a workload network tag;
 *   - env and Secret Manager env (`secret_key_ref`, version latest);
 *   - startup/liveness probes (HTTP on `healthPath`, else TCP startup) and
 *     startup CPU boost; request-based CPU for web, always-on CPU for workers;
 *   - a runtime service account: the node's `identity`, else a dedicated
 *     permission-less one (never the Compute default account).
 *   `workload: "worker"` runs as a Cloud Run SERVICE, which must listen on
 *   $PORT; a pure background worker needs a Cloud Run worker pool, which this
 *   driver does not create.
 *
 * Day two (native API, read-modify-write with the service etag):
 *   - `service.restart`: a new revision by setting the template annotation
 *     `zenith.dev/restart-token` to the operation id; replaying the same
 *     operation id is a no-op. The fence token is recorded next to it.
 *   - `service.scale`: sets `template.scaling` min/max instances.
 *   Both refuse a service that does not carry this environment's Zenith
 *   labels. The annotations are listed in `lifecycle.ignore_changes`, so tofu
 *   never reverts a restart.
 */
import type { CompileContext, NativeOperation, ResourceDriver, TofuFragment } from "@/lib/drivers/types";
import type { GcpSession } from "@/lib/credentials/types";
import type { ContainerServiceSpec } from "@/lib/resources/specs";
import type { ResourceNode } from "@/lib/resources/types";
import { GcpCompileError } from "../../errors";
import { cloudName, labelsMatch, nodeLabels, tagDescription, tfLabel, tfSub } from "../../naming";
import { RUN, cloudRunServiceName, contractCapabilities, managedOnly, specOf } from "../../driver-util";
import { dataFragment, expr, lastSegment, safeRegion } from "../../hcl";
import { arr, fetchObject, makeReaders, num, rec, str, tail, type ReadSpec } from "../../read-kit";
import { gcpCall, waitOperation } from "../../rest";
import {
  FENCE_ANNOTATION,
  IGNORED_OPERATION_ANNOTATIONS,
  RESTART_ANNOTATION,
  cpuString,
  directVpcEgress,
  envBlocks,
  parseCpu,
  parseMemoryMb,
  runCpu,
  runMemoryMb,
  runtimeIdentity,
} from "./run-common";
import { imageOf, ignoredImageChanges } from "./run-image";
import { factsForNode, lifecycleIgnoreChanges } from "@/lib/ownership";

/** The instance range, when an autoscaler owns it (field-ownership registry); the IaC apply must not reset it. */
function ownedScalingPaths(node: ResourceNode, ctx: CompileContext): string[] {
  return lifecycleIgnoreChanges({ resourceType: "google_cloud_run_v2_service", address: node.address, facts: factsForNode(node, ctx.nodes ? { nodes: ctx.nodes() } : undefined) })?.ignore_changes
    .filter((path) => path.includes("scaling")) ?? [];
}

export const DRIVER_ID = "gcp.cloud_run_service@1";
const INGRESS = { all: "INGRESS_TRAFFIC_ALL", internal: "INGRESS_TRAFFIC_INTERNAL_ONLY", lb: "INGRESS_TRAFFIC_INTERNAL_LOAD_BALANCER" } as const;

export function ingressOf(spec: Pick<ContainerServiceSpec, "workload" | "ingress">): (typeof INGRESS)[keyof typeof INGRESS] {
  const v = String(spec.ingress ?? "").toLowerCase();
  if (v === "internal" || v === "private") return INGRESS.internal;
  if (v === "all" || v === "public" || v === "internet") return INGRESS.all;
  if (v === "lb" || v === "load_balancer" || v === "load-balancer" || v === "internal_and_lb") return INGRESS.lb;
  return spec.workload === "worker" ? INGRESS.internal : INGRESS.lb;
}

export function instanceBounds(replicas: number): { min: number; max: number } {
  const r = Number.isInteger(replicas) && replicas >= 0 ? replicas : 1;
  return { min: Math.min(r, 1000), max: Math.min(Math.max(10, r * 4), 1000) };
}

function sizing(s: ContainerServiceSpec): { cpu: number; memoryMb: number } {
  const cpu = runCpu(s.vcpu);
  return { cpu, memoryMb: runMemoryMb(s.memoryMb, cpu) };
}

function desiredAttributes(node: ResourceNode): Record<string, unknown> {
  const s = specOf<ContainerServiceSpec>(node);
  const { cpu, memoryMb } = sizing(s);
  const { min, max } = instanceBounds(s.replicas);
  const a = s.artifact as { type?: string; ref?: string };
  return {
    ...(a?.type === "image" ? { image: a.ref } : {}),
    port: s.port ?? 8080,
    cpu,
    memory: memoryMb,
    minInstances: min,
    maxInstances: max,
    ingress: ingressOf(s),
    envKeys: (s.env ?? []).map((e) => e.key).sort(),
  };
}

/** Foreign (`referenced`/`external`) nodes carry only declared attributes; Zenith demands no configuration of them. */
const expectedAttributes = managedOnly(desiredAttributes);

function compile(node: ResourceNode, ctx: CompileContext): TofuFragment {
  const L = tfLabel(node.address);
  if (node.ownership !== "managed") {
    return dataFragment("google_cloud_run_v2_service", L, { name: lastSegment(node.externalRef, node.address), location: safeRegion(node.region) });
  }
  safeRegion(ctx.region);
  const s = specOf<ContainerServiceSpec>(node);
  const { cpu, memoryMb } = sizing(s);
  const { min, max } = instanceBounds(s.replicas);
  const port = s.port ?? 8080;
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new GcpCompileError("invalid_spec", `${node.address}: port must be 1-65535.`);
  const ingress = ingressOf(s);
  const identity = runtimeIdentity(node, ctx);
  const vpc = directVpcEgress(node, ctx);
  const isWeb = s.workload !== "worker";

  const probe = s.healthPath
    ? { http_get: [{ path: String(s.healthPath).startsWith("/") ? s.healthPath : `/${s.healthPath}`, port }] }
    : { tcp_socket: [{ port }] };
  const container: Record<string, unknown> = {
    name: "app",
    image: imageOf(node, ctx),
    ports: [{ container_port: port }],
    resources: [{ limits: { cpu: cpuString(cpu), memory: `${memoryMb}Mi` }, cpu_idle: isWeb, startup_cpu_boost: true }],
    startup_probe: [{ ...probe, initial_delay_seconds: 0, period_seconds: 5, timeout_seconds: 3, failure_threshold: 24 }],
  };
  const env = envBlocks(s.env, node, ctx);
  if (env.length) container.env = env;
  if (s.healthPath) container.liveness_probe = [{ http_get: probe.http_get, period_seconds: 30, timeout_seconds: 5, failure_threshold: 3 }];

  const template: Record<string, unknown> = {
    service_account: identity.email,
    timeout: "300s",
    execution_environment: "EXECUTION_ENVIRONMENT_GEN2",
    scaling: [{ min_instance_count: min, max_instance_count: max }],
    containers: [container],
  };
  if (vpc) template.vpc_access = [vpc];

  const svcLabel = L;
  const resource: NonNullable<TofuFragment["resource"]> = {
    google_cloud_run_v2_service: {
      [svcLabel]: {
        name: cloudName(ctx.namePrefix, node.address, { max: 49 }),
        location: ctx.region,
        description: tagDescription(ctx.tags, node, "container service"),
        labels: nodeLabels(ctx.tags, node),
        ingress,
        // Stateless: teardown must be possible. The provider defaults this to true.
        deletion_protection: false,
        template: [template],
        lifecycle: { ignore_changes: [...IGNORED_OPERATION_ANNOTATIONS, ...ignoredImageChanges(node), ...ownedScalingPaths(node, ctx)] },
      },
    },
  };
  const addresses = [`google_cloud_run_v2_service.${svcLabel}`];
  if (identity.extra) {
    resource[identity.extra.type] = { [identity.extra.label]: identity.extra.body };
    addresses.push(`${identity.extra.type}.${identity.extra.label}`);
  }
  if (isWeb && ingress !== INGRESS.internal) {
    const pub = tfSub(node.address, "public");
    resource.google_cloud_run_v2_service_iam_member = {
      [pub]: { name: expr(`google_cloud_run_v2_service.${svcLabel}.name`), location: ctx.region, role: "roles/run.invoker", member: "allUsers" },
    };
    addresses.push(`google_cloud_run_v2_service_iam_member.${pub}`);
  }
  return {
    resource,
    output: { [`${L}_uri`]: { value: expr(`google_cloud_run_v2_service.${svcLabel}.uri`), description: "service URL" } },
    addresses,
  };
}

/* --------------------------------- reading --------------------------------- */

const spec: ReadSpec = {
  driverId: DRIVER_ID,
  nativeType: "gcp:cloud_run_service",
  kind: "container_service",
  attributes: ["image", "port", "cpu", "memory", "minInstances", "maxInstances", "ingress", "egress", "envKeys"],
  resolve: cloudRunServiceName,
  list: {
    url: (ctx) => `${RUN}/projects/${ctx.session.projectId}/locations/${ctx.region}/services?pageSize=100`,
    itemsKey: "services",
    pageTokenParam: "pageToken",
    labelsOf: (item) => rec(item.labels),
  },
  extract(o) {
    const name = str(o.name);
    if (!name) throw new Error("no name");
    const tpl = rec(o.template);
    const c = rec(arr(tpl.containers)[0]);
    const limits = rec(rec(c.resources).limits);
    const scaling = rec(tpl.scaling);
    const envKeys = arr(c.env).map((e) => str(rec(e).name)).filter((n): n is string => !!n).sort();
    const conds = arr(o.conditions).map((x) => rec(x));
    return {
      externalId: name,
      name: tail(name),
      attributes: {
        image: str(c.image),
        port: num(rec(arr(c.ports)[0]).containerPort),
        cpu: parseCpu(str(limits.cpu)),
        memory: parseMemoryMb(str(limits.memory)),
        minInstances: num(scaling.minInstanceCount) ?? 0,
        maxInstances: num(scaling.maxInstanceCount),
        ingress: str(o.ingress),
        egress: str(rec(tpl.vpcAccess).egress) ?? "NONE",
        envKeys,
      },
      native: {
        uri: str(o.uri),
        generation: str(o.generation),
        latestReadyRevision: tail(str(o.latestReadyRevision)),
        latestCreatedRevision: tail(str(o.latestCreatedRevision)),
        serviceAccountSet: !!str(tpl.serviceAccount),
        conditionStates: conds.slice(0, 8).map((x) => `${String(x.type).slice(0, 40)}=${String(x.state).slice(0, 40)}`),
      },
    };
  },
  runtime(o) {
    const terminal = rec(o.terminalCondition);
    const state = str(terminal.state);
    const signals: string[] = [];
    let health: "healthy" | "degraded" | "unhealthy" | "unknown" = "unknown";
    if (state === "CONDITION_SUCCEEDED") health = "healthy";
    else if (state === "CONDITION_FAILED") health = "unhealthy";
    else if (state === "CONDITION_RECONCILING" || state === "CONDITION_PENDING") health = "degraded";
    const safe = (v: unknown) => String(v ?? "").replace(/[^A-Za-z0-9_.-]/g, "").slice(0, 48);
    for (const c of arr(o.conditions).map((x) => rec(x))) {
      const st = str(c.state);
      if (st && st !== "CONDITION_SUCCEEDED") signals.push(`condition:${safe(c.type)}:${safe(st)}${c.reason ? `:${safe(c.reason)}` : ""}`);
    }
    const ready = str(o.latestReadyRevision);
    const created = str(o.latestCreatedRevision);
    if (ready && created && ready !== created) {
      signals.push(`revision_not_ready:${safe(tail(created))}`);
      if (health === "healthy") health = "degraded";
    }
    if (!ready && health !== "unhealthy") signals.push("no_ready_revision");
    const scaling = rec(rec(o.template).scaling);
    const counts: Record<string, number> = {};
    const min = num(scaling.minInstanceCount) ?? 0;
    counts.minInstances = min;
    const max = num(scaling.maxInstanceCount);
    if (max !== undefined) counts.maxInstances = max;
    const gen = num(o.generation);
    const observed = num(o.observedGeneration);
    if (gen !== undefined) counts.generation = gen;
    if (observed !== undefined) counts.observedGeneration = observed;
    if (gen !== undefined && observed !== undefined && gen !== observed && health === "healthy") {
      health = "degraded";
      signals.push("generation_not_observed");
    }
    return { health, counts, signals };
  },
};

const readers = makeReaders(spec, expectedAttributes, { serving: true });

/* ------------------------------- day-two ops -------------------------------- */

const OP_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;

const refuse = (summary: string): { ok: false; summary: string; simulated: false } => ({ ok: false, summary, simulated: false });

type TemplateChange = { already: string } | { template: Record<string, unknown>; summary: string };

async function changeTemplate(
  ctx: Parameters<NativeOperation<GcpSession>>[0],
  node: ResourceNode,
  input: Record<string, unknown>,
  capability: string,
  change: (template: Record<string, unknown>, current: Record<string, unknown>) => TemplateChange
) {
  const externalId = typeof input.externalId === "string" ? input.externalId : undefined;
  const f = await fetchObject(spec, ctx, node, externalId);
  if (f.kind === "invalid") return refuse(`${capability}: ${f.error}`);
  if (f.kind === "none") return refuse(`${capability}: the service could not be read (${f.outcome}${f.detail ? `: ${f.detail}` : ""}).`);
  const current = f.obj;
  const name = str(current.name);
  if (!name) return refuse(`${capability}: the service response had no name.`);
  if (!labelsMatch(rec(current.labels), nodeLabels(ctx.tags, node))) {
    return refuse(`${capability}: refusing to change ${tail(name)}; it does not carry this environment's Zenith labels for ${node.address}.`);
  }
  const outcome = change(rec(current.template), current);
  if ("already" in outcome) return { ok: true, summary: outcome.already, data: { service: tail(name), changed: false }, requestIds: [], simulated: false as const };

  const res = await gcpCall(ctx, "PATCH", `${RUN}/${name}?updateMask=template`, { template: outcome.template, ...(str(current.etag) ? { etag: current.etag } : {}) });
  if (res.outcome !== "ok") {
    const conflict = res.status === 409 || res.status === 412;
    return { ...refuse(`${capability}: Cloud Run rejected the update (${conflict ? "concurrent modification, retry" : res.outcome}${res.detail ? `: ${res.detail}` : ""}).`), requestIds: res.requestId ? [res.requestId] : [] };
  }
  const opName = str(res.json.name);
  const requestIds = [res.requestId, opName].filter((x): x is string => !!x);
  let done = res.json.done === true;
  let failure: string | undefined;
  const waitSec = typeof input.waitSeconds === "number" && input.waitSeconds >= 0 && input.waitSeconds <= 120 ? input.waitSeconds : 20;
  if (!done && opName && waitSec > 0 && /^projects\/[A-Za-z0-9_-]+\/locations\/[a-z0-9-]+\/operations\/[A-Za-z0-9_.-]+$/.test(opName)) {
    const w = await waitOperation(ctx, `${RUN}/${opName}`, { maxPolls: Math.ceil(waitSec / 2), intervalMs: 2000 });
    done = w.done;
    failure = w.error;
  }
  return {
    ok: failure === undefined,
    summary: failure ? `${capability}: the operation failed: ${failure}` : `${outcome.summary}${done ? "" : " (still rolling out; check runtime)"}`,
    data: { service: tail(name), changed: true, operationDone: done },
    requestIds,
    simulated: false as const,
  };
}

const restart: NativeOperation<GcpSession> = async (ctx, node, input) => {
  const token = ctx.operationId;
  if (!token || !OP_ID.test(token)) return refuse("service.restart needs an operation id (letters, digits, _ . : -) so a retry cannot restart twice.");
  return changeTemplate(ctx, node, input, "service.restart", (tpl) => {
    const annotations = { ...rec(tpl.annotations) };
    if (annotations[RESTART_ANNOTATION] === token) return { already: "This operation already restarted the service; nothing to do." };
    annotations[RESTART_ANNOTATION] = token;
    if (ctx.fence) annotations[FENCE_ANNOTATION] = String(ctx.fence.token);
    return { template: { ...tpl, annotations }, summary: "Started a new revision to restart the service." };
  });
};

const scale: NativeOperation<GcpSession> = async (ctx, node, input) => {
  const bound = (v: unknown): number | undefined | "bad" => (v === undefined ? undefined : typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= 1000 ? v : "bad");
  const wantMin = bound(input.minInstances);
  const wantMax = bound(input.maxInstances);
  if (wantMin === "bad" || wantMax === "bad") return refuse("service.scale: minInstances and maxInstances must be integers from 0 to 1000.");
  if (wantMin === undefined && wantMax === undefined) return refuse("service.scale: pass minInstances and/or maxInstances.");
  return changeTemplate(ctx, node, input, "service.scale", (tpl) => {
    const scaling = { ...rec(tpl.scaling) };
    const curMin = num(scaling.minInstanceCount) ?? 0;
    const curMax = num(scaling.maxInstanceCount);
    const min = wantMin ?? curMin;
    const max = wantMax ?? curMax;
    if (max !== undefined && min > max) throw new RangeError(`minInstances ${min} exceeds maxInstances ${max}`);
    if (min === curMin && max === curMax) return { already: `The service already has min ${min}${max !== undefined ? ` / max ${max}` : ""}; nothing to do.` };
    scaling.minInstanceCount = min;
    if (max !== undefined) scaling.maxInstanceCount = max;
    const annotations = { ...rec(tpl.annotations) };
    if (ctx.fence) annotations[FENCE_ANNOTATION] = String(ctx.fence.token);
    return { template: { ...tpl, scaling, ...(Object.keys(annotations).length ? { annotations } : {}) }, summary: `Set instances to min ${min}${max !== undefined ? ` / max ${max}` : ""}.` };
  }).catch((e: unknown) => (e instanceof RangeError ? refuse(`service.scale: ${e.message}.`) : Promise.reject(e)));
};

export const cloudRunServiceDriver: ResourceDriver<GcpSession> = {
  id: DRIVER_ID,
  provider: "gcp",
  kind: "container_service",
  nativeType: "gcp:cloud_run_service",
  capabilities: contractCapabilities({ runtime: true, discover: true, operations: ["service.restart", "service.scale"] }),
  compile,
  observe: readers.observe,
  runtime: readers.runtime,
  verify: readers.verify,
  discover: readers.discover,
  expectedAttributes,
  operations: { "service.restart": restart, "service.scale": scale },
};
