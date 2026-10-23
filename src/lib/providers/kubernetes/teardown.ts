/**
 * Explicit environment teardown, using pruneOrphans' empty-desired-set plan.
 * Automatic prune's protections stay intact: only this entry point may delete
 * retained PVCs and StatefulSets when retainStateful is false. Every deletion
 * rechecks live environment ownership and carries UID and resourceVersion
 * preconditions (the latter also protects against an ownership-mark change).
 *
 * Persistent data (PROD-LIFE-07). PVCs a StatefulSet made from its claim
 * templates carry the ownership marks the template gave them, so they are found
 * and treated exactly like Zenith-rendered PVCs: retained while `retainStateful`
 * is true, deleted (children-first, after their StatefulSet) when it is false,
 * and never touched when unowned. Owned VolumeSnapshots, which are copies of that
 * data, follow the same rule. A cluster without the snapshot CRDs has none, and
 * that is not a coverage gap.
 *
 * Namespaces are always retained: deleting one would cascade into foreign
 * objects, including kinds Zenith cannot inventory. Only allowlisted or
 * live, environment-owned namespaces are scanned. The caller must supply a
 * brokered session authorized for workspaceId and hold the environment lease;
 * Kubernetes ownership marks identify the globally unique environment, not
 * its workspace. This function does not authorize callers or acquire leases.
 *
 * deleted means a subsequent GET confirmed absence; in dryRun it means would
 * delete. Acceptance, termination, interrupted scans and incomplete listings
 * are uncertain. Wildcard refs (Kind/namespace/*, Namespace//*) denote coverage
 * gaps or unavailable kinds. Results contain refs only, never API bodies or
 * error messages. Confirmation is bounded to one read, with no delete retries
 * or finalizer removal. Evidence is contract-only against fake-api.ts; no live
 * cluster teardown has been verified.
 */
import type { KubernetesSession } from "@/lib/credentials/types";
import { SNAPSHOT_KINDS, createK8sClient, listObjects, ownedBy, readObject, toK8sError, type K8sClient } from "./client";
import { defaultNamespace, isDnsLabel } from "./naming";
import { pruneOrphans } from "./prune";
import { sessionNamespaces } from "./session";
import { listOwnedSnapshots } from "./snapshots";
import { APPLY_ORDER, K8sError, KIND_INFO, LABEL, MANAGED_BY_VALUE, refOf, type ObjectRef, type SupportedKind } from "./types";
import { dig, isRecord, sortedUnique } from "./util";

/**
 * An object Zenith adopted (not created) whose active claim allows destruction (PROD-LIFE-11). An adopted
 * StatefulSet takes the claims its volumeClaimTemplates created with it: destroying the data service destroys its data.
 */
export interface AdoptedTeardownRef {
  kind: "StatefulSet" | "PersistentVolumeClaim";
  namespace: string;
  name: string;
}

export interface KubernetesTeardownInput {
  workspaceId: string;
  environmentId: string;
  session: unknown;
  retainStateful: boolean;
  /** Exact adopted objects to delete; they carry no Zenith label, so the owned-object scan never finds them. */
  adopted?: readonly AdoptedTeardownRef[];
  dryRun?: boolean;
  signal?: AbortSignal;
  /** How long to wait for an accepted delete held by a finalizer (e.g. pvc-protection) to disappear. Default 15 s. */
  confirmWaitMs?: number;
}

export interface KubernetesTeardownReport {
  deleted: string[];
  retained: string[];
  skipped: string[];
  uncertain: string[];
}

type Outcome = keyof KubernetesTeardownReport;
const SELECTOR = `${LABEL.managedBy}=${MANAGED_BY_VALUE}`;
const key = (ref: ObjectRef): string => `${ref.kind}/${ref.namespace ?? ""}/${ref.name}`;
const namespaceRef = (name: string): ObjectRef => ({ apiVersion: "v1", kind: "Namespace", name });
const stateful = (ref: ObjectRef): boolean => ref.kind === "PersistentVolumeClaim" || ref.kind === "StatefulSet";

function checkedSession(input: KubernetesTeardownInput): KubernetesSession {
  if (!input || typeof input.workspaceId !== "string" || !input.workspaceId.trim() ||
      typeof input.environmentId !== "string" || !input.environmentId.trim() ||
      typeof input.retainStateful !== "boolean" ||
      (input.dryRun !== undefined && typeof input.dryRun !== "boolean")) {
    throw new K8sError("bad_input", "Teardown requires workspace and environment IDs and a boolean retainStateful flag.");
  }
  const session = input.session;
  if (!isRecord(session) || session.provider !== "kubernetes" || typeof session.kubeConfig !== "function" ||
      typeof session.server !== "string" || typeof session.expiresAt !== "string" || !Number.isFinite(Date.parse(session.expiresAt))) {
    throw new K8sError("session_invalid", "Teardown requires a brokered Kubernetes session.");
  }
  if (Date.parse(session.expiresAt) <= Date.now()) throw new K8sError("session_expired", "The Kubernetes session has expired.");
  if (session.namespaces !== undefined && (!Array.isArray(session.namespaces) ||
      !session.namespaces.every((ns: unknown) => typeof ns === "string" && isDnsLabel(ns)))) {
    throw new K8sError("session_invalid", "The Kubernetes session has an invalid namespace allowlist.");
  }
  return session as unknown as KubernetesSession;
}

/** True only when the API server positively reports the kind as not served; a discovery failure is false. */
async function confirmedAbsent(client: K8sClient, kind: SupportedKind | "VolumeSnapshot", apiVersion = kind in KIND_INFO ? KIND_INFO[kind as SupportedKind].apiVersion : ""): Promise<boolean> {
  try {
    return await client.objects.kindAbsent(apiVersion, kind);
  } catch {
    return false;
  }
}

/** Read, guard, delete once, then confirm absence. Never return provider text. */
async function deleteCandidate(client: K8sClient, ref: ObjectRef, environmentId: string, dryRun: boolean, adopted = false, confirmWaitMs = 15_000): Promise<Outcome> {
  let live;
  try {
    if (ref.namespace) await client.guard.assert(ref.namespace);
    live = await readObject(client, ref);
  } catch {
    return "uncertain";
  }
  if (!live) return dryRun ? "skipped" : "deleted";
  // An adopted object is unlabeled by design; one that another Zenith environment labels as its own is never ours to delete.
  if (adopted ? dig(live, "metadata", "labels", LABEL.managedBy) === MANAGED_BY_VALUE && !ownedBy(live, environmentId).owned : !ownedBy(live, environmentId).owned) return "skipped";
  if (dig(live, "metadata", "deletionTimestamp")) return "uncertain";
  const uid = dig(live, "metadata", "uid");
  const resourceVersion = dig(live, "metadata", "resourceVersion");
  if (typeof uid !== "string" || !uid || typeof resourceVersion !== "string" || !resourceVersion) return "skipped";
  if (dryRun) return "deleted";
  // The caller may have cancelled after the last read. Do not start a write.
  if (client.signal?.aborted) return "skipped";
  try {
    await client.objects.delete(
      { apiVersion: ref.apiVersion, kind: ref.kind, metadata: { name: ref.name, ...(ref.namespace ? { namespace: ref.namespace } : {}) } },
      undefined, undefined, undefined, undefined, "Background", { preconditions: { uid, resourceVersion } }
    );
  } catch (error) {
    const code = toK8sError(error).code;
    if (["field_conflict", "forbidden", "unauthorized", "invalid", "unsupported"].includes(code)) return "skipped";
    // A 404 is also checked below: absence, rather than acceptance, is proof.
    if (code !== "not_found") return "uncertain";
  }
  // A finalizer can hold the same object briefly after the delete is accepted. Absence is proof; a new uid is not ours.
  const deadline = Date.now() + confirmWaitMs;
  for (;;) {
    let current;
    try { current = await readObject(client, ref); } catch { return "uncertain"; }
    if (!current) return "deleted";
    if (dig(current, "metadata", "uid") !== uid || Date.now() >= deadline || client.signal?.aborted) return "uncertain";
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}

export async function teardownKubernetesEnvironment(input: KubernetesTeardownInput): Promise<KubernetesTeardownReport> {
  const session = checkedSession(input);
  if (input.signal?.aborted) throw new K8sError("aborted", "The operation was aborted.");
  let client: K8sClient;
  try {
    client = createK8sClient(session, { environmentId: input.environmentId, signal: input.signal });
  } catch (error) {
    const code = error instanceof K8sError ? error.code : "session_invalid";
    throw new K8sError(code, "The Kubernetes teardown client could not be initialized.");
  }
  const outcomes = new Map<string, Outcome>();
  const record = (ref: ObjectRef, outcome: Outcome) => outcomes.set(key(ref), outcome);
  const namespaces = new Set([...sessionNamespaces(session), defaultNamespace(input.environmentId)]);
  // Discover custom Zenith-created namespaces even when the allowlist is empty.
  try {
    const listing = await listObjects(client, "Namespace", undefined, { labelSelector: SELECTOR });
    if (listing.truncated || listing.unavailable) record(namespaceRef("*"), "uncertain");
    for (const item of listing.items) {
      if (!ownedBy(item, input.environmentId).owned) continue;
      const ref = refOf(item);
      if (isDnsLabel(ref.name)) {
        namespaces.add(ref.name);
        record(ref, dig(item, "metadata", "deletionTimestamp") ? "uncertain" : "retained");
      }
    }
  } catch {
    record(namespaceRef("*"), "uncertain");
  }
  const scan = sortedUnique([...namespaces]);
  const dryRun = input.dryRun === true;
  const candidates = new Map<string, ObjectRef>();
  try {
    // Planning preserves automatic prune's NEVER_AUTO_PRUNE policy unchanged.
    const plan = await pruneOrphans({ desired: [], environmentId: input.environmentId, namespaces: scan, dryRun: true }, session, { signal: input.signal });
    for (const ref of plan.deleted) candidates.set(key(ref), ref);
    for (const { ref } of plan.retained) {
      if (ref.kind === "Namespace" || input.retainStateful) {
        if (outcomes.get(key(ref)) !== "uncertain") record(ref, "retained");
      }
      else candidates.set(key(ref), ref);
    }
    for (const failure of plan.failed) record(failure.ref, "uncertain");
    if (plan.truncated) record(namespaceRef("*"), "uncertain");
  } catch {
    record(namespaceRef("*"), "uncertain");
  }

  // Owned VolumeSnapshots are data too: keep them while stateful data is retained, delete them otherwise.
  for (const namespace of scan) {
    if (input.signal?.aborted) break;
    const gap: ObjectRef = { apiVersion: SNAPSHOT_KINDS.VolumeSnapshot.apiVersion, kind: "VolumeSnapshot", namespace, name: "*" };
    try {
      await client.guard.assert(namespace);
    } catch (error) {
      // a namespace that does not exist holds no snapshots; the object scan below reports any other refusal
      if (toK8sError(error).code !== "not_found") record(gap, "uncertain");
      continue;
    }
    try {
      const snapshots = await listOwnedSnapshots(client, namespace, input.environmentId);
      if (snapshots.truncated) record(gap, "uncertain");
      if (snapshots.unavailable && !(await confirmedAbsent(client, "VolumeSnapshot", SNAPSHOT_KINDS.VolumeSnapshot.apiVersion))) record(gap, "uncertain");
      for (const item of snapshots.items) {
        const ref = refOf(item);
        if (dig(item, "metadata", "deletionTimestamp")) record(ref, "uncertain");
        else if (input.retainStateful) record(ref, "retained");
        else candidates.set(key(ref), ref);
      }
    } catch {
      record(gap, "uncertain");
    }
  }

  // Adopted objects named exactly by an active manage_and_destroy claim (stateful: retained while data is retained).
  const adoptedKeys = new Set<string>();
  const adopt = (ref: ObjectRef) => {
    if (input.retainStateful) { record(ref, "retained"); return; }
    adoptedKeys.add(key(ref));
    candidates.set(key(ref), ref);
  };
  for (const item of input.adopted ?? []) {
    const kind = item.kind === "StatefulSet" || item.kind === "PersistentVolumeClaim" ? item.kind : "PersistentVolumeClaim";
    const ref: ObjectRef = { apiVersion: KIND_INFO[kind].apiVersion, kind, namespace: isDnsLabel(item.namespace) ? item.namespace : "invalid", name: item.name };
    if (kind !== item.kind || !isDnsLabel(item.namespace) || !isDnsLabel(item.name)) { record({ ...ref, name: "*" }, "uncertain"); continue; }
    adopt(ref);
    if (kind !== "StatefulSet") continue;
    // The claims a StatefulSet's templates created are named <template>-<statefulset>-<ordinal> and carry no Zenith label.
    const claims: ObjectRef = { apiVersion: "v1", kind: "PersistentVolumeClaim", namespace: item.namespace, name: `*-${item.name}-*` };
    try {
      await client.guard.assert(item.namespace);
      const live = await readObject(client, ref);
      const templates = (dig(live, "spec", "volumeClaimTemplates") as unknown[] | undefined ?? []).map((t) => dig(t, "metadata", "name")).filter((n): n is string => typeof n === "string");
      if (!templates.length) continue;
      const listing = await listObjects(client, "PersistentVolumeClaim", item.namespace);
      if (listing.truncated || listing.unavailable) record(claims, "uncertain");
      for (const pvc of listing.items) {
        const pvcRef = refOf(pvc);
        if (templates.some((t) => pvcRef.name.startsWith(`${t}-${item.name}-`) && /^\d+$/.test(pvcRef.name.slice(t.length + item.name.length + 2)))) adopt(pvcRef);
      }
    } catch {
      record(claims, "uncertain");
    }
  }

  // Include deliberate stateful deletions in the existing children-first order.
  const order: readonly string[] = [...APPLY_ORDER].reverse();
  const ordered = [...candidates.values()].sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind) || key(a).localeCompare(key(b)));
  for (const ref of ordered) {
    record(ref, input.signal?.aborted ? "skipped" : await deleteCandidate(client, ref, input.environmentId, dryRun, adoptedKeys.has(key(ref)), input.confirmWaitMs));
  }

  // Prune omits already-terminating objects. Reconcile its plan with what remains
  // so retries, new objects and partial scans cannot look like complete teardown.
  for (const namespace of scan) {
    if (input.signal?.aborted) {
      record({ ...namespaceRef("*"), namespace }, "uncertain");
      continue;
    }
    try {
      await client.guard.assert(namespace);
    } catch (error) {
      if (toK8sError(error).code !== "not_found") record(namespaceRef(namespace), "uncertain");
      continue;
    }
    for (const kind of APPLY_ORDER) {
      if (kind === "Namespace") continue;
      const gap: ObjectRef = { apiVersion: KIND_INFO[kind].apiVersion, kind, namespace, name: "*" };
      if (input.signal?.aborted) {
        record({ ...namespaceRef("*"), namespace }, "uncertain");
        break;
      }
      try {
        const listing = await listObjects(client, kind, namespace, { labelSelector: SELECTOR });
        // A kind the cluster does not serve cannot hold an object: that is a coverage note, but only when
        // discovery says so positively. If discovery itself fails, nothing is known about the kind.
        if (listing.unavailable) record(gap, (await confirmedAbsent(client, kind)) ? "skipped" : "uncertain");
        if (listing.truncated) record(gap, "uncertain");
        for (const item of listing.items) {
          if (!ownedBy(item, input.environmentId).owned) continue;
          const ref = refOf(item);
          if (dig(item, "metadata", "deletionTimestamp")) record(ref, "uncertain");
          else if (stateful(ref) && input.retainStateful) record(ref, "retained");
          else if (!outcomes.has(key(ref)) || (!dryRun && outcomes.get(key(ref)) === "deleted")) record(ref, "uncertain");
        }
      } catch {
        record(gap, "uncertain");
      }
    }
  }
  const report: KubernetesTeardownReport = { deleted: [], retained: [], skipped: [], uncertain: [] };
  for (const [ref, outcome] of outcomes) report[outcome].push(ref);
  for (const refs of Object.values(report)) refs.sort();
  return report;
}
