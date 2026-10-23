import { z } from "zod";
import { digest } from "@/lib/controlplane/digest";
import { StepFailedError } from "@/lib/execution/errors";
import { dig, isRecord } from "../util";
import type { K8sObject } from "../types";
import { configDigest, type IsolatedBuildConfig } from "./config";
import { LIMITS, renderBaseline, renderProxy } from "./render";

export const PROBE_CHECKS = ["nonRoot", "userNamespace", "noToken", "noDeploymentEnv", "rootReadOnly", "sourceReadOnly",
  "metadataDenied", "credentialsEndpointDenied", "directEgressDenied", "proxyDenied", "proxyAllowed", "registryDirectDenied", "resourcesBounded", "processSandbox",
  // The kernel's view, not the pod spec: the Localhost seccomp filter and the zenith-build AppArmor profile are applied.
  "seccompEnforced", "appArmorEnforced"] as const;
export const ProbeSchema = z.object({ version: z.literal(1), checks: z.object(Object.fromEntries(PROBE_CHECKS.map(k => [k, z.literal(true)])) as Record<typeof PROBE_CHECKS[number], z.ZodLiteral<true>>).strict() }).strict();

/** Kubernetes adds defaults; compare every requested field, every list element and list length. */
export function containsExpected(actual: unknown, expected: unknown): boolean {
  if (Array.isArray(expected)) return Array.isArray(actual) && actual.length === expected.length && expected.every((v, i) => containsExpected(actual[i], v));
  if (isRecord(expected)) return isRecord(actual) && Object.entries(expected).every(([k, v]) => containsExpected(actual[k], v));
  return actual === expected;
}

// DefaultTolerationSeconds admission appends these to every pod; they only delay eviction from a failed node.
const ADMISSION_TOLERATIONS = ["node.kubernetes.io/not-ready", "node.kubernetes.io/unreachable"];
function withoutAdmissionTolerations(actual: unknown, expected: unknown): unknown {
  const live = dig(actual, "tolerations"), wanted = dig(expected, "tolerations");
  if (!isRecord(actual) || !Array.isArray(live) || !Array.isArray(wanted)) return actual;
  return { ...actual, tolerations: live.filter(t => !(isRecord(t) && Object.keys(t).length === 4 && ADMISSION_TOLERATIONS.includes(t.key as string) && t.operator === "Exists"
    && t.effect === "NoExecute" && Number.isInteger(t.tolerationSeconds) && (t.tolerationSeconds as number) > 0 && !wanted.some(w => isRecord(w) && w.key === t.key))) };
}

export function assertPod(actual: unknown, expected: unknown): void {
  if (!containsExpected(withoutAdmissionTolerations(actual, expected), expected)) throw new StepFailedError("The executed pod differs from its isolated build request.");
  const p = actual;
  for (const field of ["hostNetwork", "hostPID", "hostIPC", "shareProcessNamespace"]) if (dig(p, field) === true) throw new StepFailedError("Host namespaces are forbidden for isolated execution.");
  for (const field of ["initContainers", "ephemeralContainers", "hostAliases"]) {
    if (dig(p, field) !== undefined && (!Array.isArray(dig(p, field)) || (dig(p, field) as unknown[]).length !== 0)) throw new StepFailedError("The build pod carries unapproved execution inputs.");
  }
  const containers = dig(p, "containers");
  if (!Array.isArray(containers)) throw new StepFailedError("The build pod is unreadable.");
  for (const [index, container] of containers.entries()) {
    for (const field of ["env", "args"]) if (dig(expected, "containers", index, field) === undefined && Array.isArray(dig(container, field)) && (dig(container, field) as unknown[]).length !== 0) throw new StepFailedError("The pod carries unapproved environment or arguments.");
    for (const field of ["envFrom", "volumeDevices", "lifecycle"]) if (dig(container, field) !== undefined) throw new StepFailedError("The build pod carries unapproved credentials or hooks.");
  }
}

export function verifyProbe(message: unknown): z.infer<typeof ProbeSchema> {
  let raw: unknown;
  try { if (typeof message !== "string" || Buffer.byteLength(message) > 4096) throw new Error(); raw = JSON.parse(message); }
  catch { throw new StepFailedError("The isolation probe did not return a bounded receipt."); }
  const parsed = ProbeSchema.safeParse(raw);
  if (!parsed.success) {
    const checks = isRecord(raw) && isRecord(raw.checks) ? raw.checks : {};
    const failed = PROBE_CHECKS.filter(check => checks[check] !== true);
    throw new StepFailedError("Every runtime isolation precondition must be proven before source execution. " + (failed.length ? "Failed or missing checks: " + failed.join(", ") + "." : "The probe receipt is malformed."));
  }
  return parsed.data;
}

export function assertBaseline(config: IsolatedBuildConfig, objects: Record<string, unknown>[]): string {
  const expected = [...renderBaseline(config), ...renderProxy(config)];
  const readings: unknown[] = [];
  for (const wanted of expected) {
    const live = objects.find(o => o.kind === wanted.kind && dig(o, "metadata", "name") === wanted.metadata.name && dig(o, "metadata", "namespace") === wanted.metadata.namespace);
    if (!live || dig(live, "metadata", "deletionTimestamp") || typeof dig(live, "metadata", "uid") !== "string") throw new StepFailedError("The owned build isolation baseline is absent or deleting.");
    if (wanted.kind === "Deployment") {
      if (dig(live, "status", "observedGeneration") !== dig(live, "metadata", "generation") || dig(live, "status", "availableReplicas") !== 1) throw new StepFailedError("The allowlist proxy is not ready.");
      assertPod(dig(live, "spec", "template", "spec"), dig(wanted, "spec", "template", "spec"));
    }
    for (const key of ["spec", "data", "immutable", "automountServiceAccountToken"]) {
      if (key in wanted && !containsExpected(live[key], wanted[key])) throw new StepFailedError("The live isolation baseline does not match the configured policy.");
    }
    if (wanted.kind === "NetworkPolicy" && digest(live.spec) !== digest(wanted.spec)) throw new StepFailedError("An isolation policy has additional permissions.");
    if (wanted.kind === "Namespace" && !containsExpected(dig(live, "metadata", "labels"), wanted.metadata.labels)) throw new StepFailedError("The build namespace admission configuration changed.");
    if (wanted.kind === "ServiceAccount" && (dig(live, "secrets") as unknown[] | undefined)?.length) throw new StepFailedError("The builder account carries a token Secret.");
    readings.push([wanted.kind, wanted.metadata.name, dig(live, "metadata", "uid"), wanted.kind === "Deployment" ? dig(live, "metadata", "generation") : wanted.kind === "ResourceQuota" ? null : dig(live, "metadata", "resourceVersion"), live.spec, live.data, live.immutable, live.automountServiceAccountToken, wanted.kind === "Namespace" ? dig(live, "metadata", "labels") : null]);
  }
  const policies = objects.filter(o => o.kind === "NetworkPolicy");
  if (policies.length !== 3) throw new StepFailedError("Additional network policies could broaden build or proxy egress.");
  const runtime = objects.find(o => o.kind === "RuntimeClass" && dig(o, "metadata", "name") === config.runtimeClass);
  if (!runtime || typeof runtime.handler !== "string" || !runtime.handler || dig(runtime, "metadata", "deletionTimestamp")) throw new StepFailedError("The isolated runtime class is unavailable.");
  return digest([configDigest(config), readings, runtime.handler, dig(runtime, "metadata", "uid"), dig(runtime, "metadata", "resourceVersion")]);
}

export function verifyJob(live: Record<string, unknown>, expected: K8sObject): void {
  if (dig(live, "metadata", "deletionTimestamp") || !containsExpected(dig(live, "metadata", "annotations"), expected.metadata.annotations)) throw new StepFailedError("The build ownership or launch identity changed.");
  if (!containsExpected(live.spec, expected.spec)) throw new StepFailedError("The claimed build Job changed.");
  assertPod(dig(live, "spec", "template", "spec"), dig(expected, "spec", "template", "spec"));
}
export const expectedLimits = LIMITS;




