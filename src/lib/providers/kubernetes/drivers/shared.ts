/**
 * The driver factory every Kubernetes native type goes through, so observe /
 * runtime / verify / discover behave identically across kinds and only the
 * kind-specific parts (what to read, what to expect) are written once each.
 *
 * Lifecycle split (ADR-0005/0015): Kubernetes declarative lifecycle is
 * render → server-side apply (`render.ts`, `apply.ts`), NOT OpenTofu, so these
 * drivers declare `compile: false`. They own the native READS and the day-two
 * operations.
 *
 * Observation rules (DRIVER-CONVENTIONS):
 *   - `known` only for what was read; everything the driver wanted but could
 *     not read is `unknown` with a reason (`access_denied` / `error`).
 *   - presence `present` / `missing` (API said not found, or the kind is not
 *     served) / `inaccessible` (forbidden, unauthorized, outside the namespace
 *     allowlist) / `unknown` (anything else).
 *   - `native` is ≤ 4 KiB of ownership and identity fields. Secret VALUES are
 *     never read into an observation: the Secret driver reports key names only.
 *   - An object that exists without this environment's ownership marks is
 *     `present` with `managedByZenith: false`; it is never treated as ours.
 *
 * Evidence: everything is `contract` (a fake Kubernetes API server in tests).
 * Nothing is `real` or `emulated` until a live/kind acceptance run proves it.
 */
import type { KubernetesSession } from "@/lib/credentials/types";
import type {
  DiscoveredResource,
  DriverContext,
  EvidenceLevel,
  NativeOperation,
  ResourceDriver,
  VerificationCheck,
  VerificationResult,
} from "@/lib/drivers/types";
import type { Observation, ObservedValue, PortableKind, ProviderKey, ResourceNode, RuntimeState } from "@/lib/resources/types";
import { createK8sClient, isNamespacedKind, listObjects, ownedBy, readObject, toK8sError, type K8sClient } from "../client";
import { sessionNamespaces } from "../session";
import { SYSTEM_NAMESPACES } from "../guest";
import { externalIdFor, targetFor } from "../target";
import { ANNOTATION, LABEL, MANAGED_BY_VALUE, type ObjectRef, type SupportedKind } from "../types";
import { boundBag, deepEqual, dig, isRecord, truncate } from "../util";

type Ctx = DriverContext<KubernetesSession>;
export type Plain = Record<string, unknown>;

export interface RuntimeArgs {
  ctx: Ctx;
  client: K8sClient;
  node: ResourceNode;
  ref: ObjectRef;
  live: Plain;
  source: string;
}

export interface KindDef {
  /** id suffix: `deployment` → `kubernetes.deployment@1` */
  suffix: string;
  nativeType: string;
  kind: SupportedKind;
  /** portable kinds this native type can realize; the first is the driver's `kind` */
  portable: PortableKind[];
  /** normalized attributes read from the live object (undefined values are dropped) */
  attributes(live: Plain): Record<string, unknown>;
  /** desired attributes in the same units; only keys `attributes` produces */
  expected(node: ResourceNode): Record<string, unknown>;
  /** scalar attributes for discovery candidates */
  summary(live: Plain): Record<string, string | number | boolean>;
  runtime?(args: RuntimeArgs): Promise<Omit<RuntimeState, "address" | "observedAt" | "source" | "simulated">>;
  extraChecks?(node: ResourceNode, observation: Observation, runtime?: RuntimeState): VerificationCheck[];
  operations?: Record<string, NativeOperation<KubernetesSession>>;
  /** exclude noise from discovery (default-service-account tokens, helm release secrets) */
  skipDiscovery?(live: Plain): boolean;
}

export interface KubernetesDriver extends ResourceDriver<KubernetesSession> {
  /** the Kubernetes kind this driver's primary object has */
  readonly k8sKind: SupportedKind;
  /** every portable kind this native type can realize */
  readonly portableKinds: readonly PortableKind[];
}

const known = (value: unknown, at: string): ObservedValue => ({ state: "known", value, observedAt: at });
const unknownValue = (reason: "access_denied" | "error" | "not_inspected", detail?: string): ObservedValue => ({ state: "unknown", reason, ...(detail ? { detail } : {}) });

type Failure = { presence: Observation["presence"]; reason: "access_denied" | "error"; message: string };

function classify(e: unknown): Failure {
  const err = toK8sError(e);
  switch (err.code) {
    case "forbidden":
    case "unauthorized":
    case "namespace_forbidden":
      return { presence: "inaccessible", reason: "access_denied", message: err.message };
    case "not_found":
    case "unsupported":
      return { presence: "missing", reason: "error", message: err.message };
    default:
      return { presence: "unknown", reason: "error", message: err.message };
  }
}

const isOwned = (live: Plain, env: string) => ownedBy(live, env).owned;

/** Identity and ownership fields worth keeping; bounded and free of any value-bearing field. */
function nativeBag(live: Plain): Record<string, unknown> {
  const labels = isRecord(dig(live, "metadata", "labels")) ? (dig(live, "metadata", "labels") as Record<string, unknown>) : {};
  const annotations = isRecord(dig(live, "metadata", "annotations")) ? (dig(live, "metadata", "annotations") as Record<string, unknown>) : {};
  return boundBag({
    uid: dig(live, "metadata", "uid"),
    resourceVersion: dig(live, "metadata", "resourceVersion"),
    generation: dig(live, "metadata", "generation"),
    creationTimestamp: dig(live, "metadata", "creationTimestamp"),
    managedBy: labels[LABEL.managedBy],
    partOf: labels[LABEL.partOf],
    tier: labels[LABEL.tier],
    resource: annotations[ANNOTATION.resource],
    environment: annotations[ANNOTATION.environment],
    specDigest: annotations[ANNOTATION.specDigest],
  });
}

export function makeKubernetesDriver(def: KindDef, provider: ProviderKey = "kubernetes"): KubernetesDriver {
  const id = `${provider}.${def.suffix}@1`;
  const operations = def.operations ?? {};
  const evidence: Record<string, EvidenceLevel> = { observe: "contract", verify: "contract", discover: "contract" };
  if (def.runtime) evidence.runtime = "contract";
  for (const op of Object.keys(operations)) evidence[op] = "contract";

  const expectedOf = (node: ResourceNode): Record<string, unknown> => ({ managedByZenith: true, ...def.expected(node) });

  const base = (node: ResourceNode, at: string) => ({ address: node.address, observedAt: at, source: id, simulated: false });

  async function locate(ctx: Ctx, node: ResourceNode, externalId?: string): Promise<{ client: K8sClient; ref: ObjectRef; live?: Plain }> {
    const ref = targetFor(def.kind, node, ctx.environmentId, externalId);
    const client = createK8sClient(ctx.session, { signal: ctx.signal, environmentId: ctx.environmentId });
    if (isNamespacedKind(def.kind)) await client.guard.assert(ref.namespace as string);
    const live = await readObject(client, ref);
    return { client, ref, live };
  }

  const driver: KubernetesDriver = {
    id,
    provider,
    kind: def.portable[0],
    nativeType: def.nativeType,
    k8sKind: def.kind,
    portableKinds: def.portable,
    capabilities: {
      compile: false,
      observe: true,
      runtime: def.runtime !== undefined,
      verify: true,
      discover: true,
      operations: Object.keys(operations),
      evidence,
    },
    expectedAttributes: expectedOf,
    operations,

    async observe(ctx, node, externalId) {
      const at = ctx.now().toISOString();
      const wanted = Object.keys(expectedOf(node));
      try {
        const { ref, live } = await locate(ctx, node, externalId);
        if (!live) return { ...base(node, at), presence: "missing", attributes: {} };
        const attrs: Record<string, unknown> = { managedByZenith: isOwned(live, ctx.environmentId), ...def.attributes(live) };
        const native = nativeBag(live);
        // apply.ts uses, never writes, an unlabeled Namespace on the connection allowlist: Zenith ownership is not a
        // desired attribute of it, so it is not reported for drift to compare (verify still checks it is unmarked).
        const provisioned = def.kind === "Namespace" && attrs.managedByZenith === false && native.managedBy === undefined && typeof attrs.name === "string"
          && sessionNamespaces(ctx.session).includes(attrs.name) && !SYSTEM_NAMESPACES.has(attrs.name);
        if (provisioned) { delete attrs.managedByZenith; native.operatorProvisioned = true; }
        const attributes: Record<string, ObservedValue> = {};
        for (const [k, v] of Object.entries(attrs)) if (v !== undefined) attributes[k] = known(v, at);
        for (const k of wanted) if (!(k in attributes) && !(provisioned && k === "managedByZenith")) attributes[k] = known(null, at);
        return { ...base(node, at), externalId: externalIdFor(ref), presence: "present", attributes, native };
      } catch (e) {
        const f = classify(e);
        const attributes: Record<string, ObservedValue> = {};
        for (const k of wanted) attributes[k] = unknownValue(f.reason, f.presence === "missing" ? undefined : truncate(f.message, 200));
        return { ...base(node, at), presence: f.presence, attributes: f.presence === "missing" ? {} : attributes, error: truncate(f.message, 300) };
      }
    },

    async verify(ctx, node, observation, runtime): Promise<VerificationResult> {
      const checks: VerificationCheck[] = [];
      checks.push({
        id: "exists",
        description: `${def.kind} exists`,
        passed: observation.presence === "present" ? true : observation.presence === "missing" ? false : "unknown",
        detail: observation.presence === "present" ? undefined : `presence is ${observation.presence}`,
      });
      const owned = observation.attributes.managedByZenith;
      const native = isRecord(observation.native) ? observation.native : {};
      const name = observation.attributes.name;
      // apply.ts uses, never writes, an unlabeled Namespace on the connection allowlist; it carries no Zenith marks to check.
      const provisioned = def.kind === "Namespace" && observation.presence === "present"
        && ((owned?.state === "known" && owned.value === false) || (owned === undefined && native.operatorProvisioned === true))
        && native.managedBy === undefined && name?.state === "known" && typeof name.value === "string"
        && sessionNamespaces(ctx.session).includes(name.value) && !SYSTEM_NAMESPACES.has(name.value);
      if (provisioned) checks.push({ id: "owned", description: "operator-provisioned namespace on this connection's allowlist; Zenith uses it and never modifies it", passed: true });
      else {
        checks.push({
          id: "owned",
          description: "object is managed by Zenith for this environment",
          passed: observation.presence !== "present" ? "unknown" : owned?.state === "known" ? owned.value === true : "unknown",
        });
        checks.push({
          id: "address",
          description: "object is annotated with this resource's address",
          passed: observation.presence !== "present" ? "unknown" : native.resource === node.address,
        });
      }
      const expected = expectedOf(node);
      const mismatched: string[] = [];
      let unread = false;
      for (const [k, want] of Object.entries(expected)) {
        if (provisioned && k === "managedByZenith") continue;
        const got = observation.attributes[k];
        if (!got || got.state !== "known") unread = true;
        else if (provisioned && k === "podSecurityEnforce" ? !["baseline", "restricted"].includes(String(got.value)) : !deepEqual(got.value, want)) mismatched.push(k);
      }
      checks.push({
        id: "configuration",
        description: "observed configuration matches the desired spec",
        passed: observation.presence !== "present" ? "unknown" : mismatched.length > 0 ? false : unread ? "unknown" : true,
        detail: mismatched.length > 0 ? `differs: ${mismatched.join(", ")}` : undefined,
      });
      checks.push(...(def.extraChecks?.(node, observation, runtime) ?? []));
      const status = checks.some((c) => c.passed === false) ? "failed" : checks.every((c) => c.passed === true) ? "passed" : "unknown";
      return { address: node.address, status, checks, checkedAt: ctx.now().toISOString(), simulated: false };
    },

    async discover(ctx): Promise<DiscoveredResource[]> {
      const client = createK8sClient(ctx.session, { signal: ctx.signal });
      const allow = [...sessionNamespaces(ctx.session)];
      const out: DiscoveredResource[] = [];
      const mk = (live: Plain, ns?: string): DiscoveredResource | undefined => {
        if (def.skipDiscovery?.(live)) return undefined;
        const name = dig(live, "metadata", "name");
        if (typeof name !== "string") return undefined;
        const labels = dig(live, "metadata", "labels");
        const attributes: Record<string, string | number | boolean> = { ...(ns ? { namespace: ns } : {}), ...def.summary(live) };
        return {
          provider,
          kind: def.portable[0],
          nativeType: def.nativeType,
          externalId: externalIdFor({ namespace: ns, name }),
          name,
          region: ctx.region,
          zenithTagged: isRecord(labels) && labels[LABEL.managedBy] === MANAGED_BY_VALUE,
          attributes,
        };
      };

      if (def.kind === "Namespace") {
        // only the allowlist and Zenith-labeled namespaces; never enumerate the whole cluster
        const seen = new Set<string>();
        for (const name of allow) {
          try {
            const live = await readObject(client, { apiVersion: "v1", kind: "Namespace", name });
            const r = live && mk(live);
            if (r && !seen.has(r.name)) {
              seen.add(r.name);
              out.push(r);
            }
          } catch {
            // an unreadable namespace is simply not a candidate
          }
        }
        try {
          const labeled = await listObjects(client, "Namespace", undefined, { labelSelector: `${LABEL.managedBy}=${MANAGED_BY_VALUE}` });
          for (const live of labeled.items) {
            const r = mk(live);
            if (r && !seen.has(r.name)) {
              seen.add(r.name);
              out.push(r);
            }
          }
        } catch {
          // no cluster-scope list permission: the allowlist result stands
        }
        return out.sort((a, b) => a.externalId.localeCompare(b.externalId));
      }

      const namespaces = new Set(allow);
      try {
        const labeled = await listObjects(client, "Namespace", undefined, { labelSelector: `${LABEL.managedBy}=${MANAGED_BY_VALUE}` });
        for (const live of labeled.items) {
          const name = dig(live, "metadata", "name");
          if (typeof name === "string") namespaces.add(name);
        }
      } catch {
        // no cluster-scope list permission: scan the allowlist only
      }
      for (const ns of [...namespaces].sort()) {
        if (ctx.signal.aborted) break;
        try {
          await client.guard.assert(ns);
          const res = await listObjects(client, def.kind, ns, { limit: 200, maxPages: 5 });
          for (const live of res.items) {
            const r = mk(live, ns);
            if (r) out.push(r);
          }
        } catch (e) {
          ctx.log(`kubernetes discover skipped ${ns}: ${toK8sError(e).code}`, "warn");
        }
      }
      return out.sort((a, b) => a.externalId.localeCompare(b.externalId));
    },
  };

  if (def.runtime) {
    const rt = def.runtime;
    driver.runtime = async (ctx, node, externalId) => {
      const at = ctx.now().toISOString();
      const head = { address: node.address, observedAt: at, source: id, simulated: false };
      try {
        const { client, ref, live } = await locate(ctx, node, externalId);
        if (!live) return { ...head, health: "unknown", counts: {}, signals: ["object_missing"] };
        const r = await rt({ ctx, client, node, ref, live, source: id });
        return { ...head, ...r };
      } catch (e) {
        const f = classify(e);
        return { ...head, health: "unknown", counts: {}, signals: [f.presence === "inaccessible" ? "access_denied" : f.presence === "missing" ? "object_missing" : "read_failed"] };
      }
    };
  }
  return driver;
}

/** A check that reads one observed attribute. */
export function attributeCheck(observation: Observation, attr: string, id: string, description: string, test: (value: unknown) => boolean): VerificationCheck {
  const v = observation.attributes[attr];
  if (observation.presence !== "present" || !v || v.state !== "known") return { id, description, passed: "unknown" };
  return { id, description, passed: test(v.value) };
}

