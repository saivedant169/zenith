/**
 * PROD-LIFE-11 on a disposable kind cluster: teardown of objects Zenith adopted but never created.
 * Requires ZENITH_TEST_KIND=1, ZENITH_TEST_KIND_ADOPTION=1 and KUBECONFIG. No image is pulled: the StatefulSet has
 * zero replicas and its template claim is created out of band under the name the controller would give it.
 * Works only in its random namespace and deletes it afterwards.
 */
import { randomBytes } from "node:crypto";
import { KubeConfig } from "@kubernetes/client-node";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { teardownKubernetesEnvironment } from "@/lib/providers/kubernetes";
import { createK8sClient, readObject } from "@/lib/providers/kubernetes/client";
import { sessionFromKubeConfig, type ScopedKubernetesSession } from "@/lib/providers/kubernetes/session";
import type { ObjectRef } from "@/lib/providers/kubernetes/types";

const enabled = process.env.ZENITH_TEST_KIND === "1" && process.env.ZENITH_TEST_KIND_ADOPTION === "1" && !!process.env.KUBECONFIG;
describe.skipIf(!enabled)("Kubernetes adopted-object teardown against a disposable kind cluster (ZENITH_TEST_KIND_ADOPTION=1)", () => {
  const suffix = randomBytes(4).toString("hex");
  const namespace = `zenith-adopt-${suffix}`;
  const environmentId = `env-adopt-${suffix}`;
  let session: ScopedKubernetesSession | undefined;
  let namespaceCreated = false;
  const sts = (name: string): ObjectRef => ({ apiVersion: "apps/v1", kind: "StatefulSet", namespace, name });
  const pvc = (name: string): ObjectRef => ({ apiVersion: "v1", kind: "PersistentVolumeClaim", namespace, name });
  const client = () => createK8sClient(session!, { environmentId, signal: AbortSignal.timeout(60_000) });
  const exists = async (ref: ObjectRef) => !!(await readObject(client(), ref));
  const claimSpec = { accessModes: ["ReadWriteOnce"], resources: { requests: { storage: "1Mi" } } };
  const statefulSet = (name: string) => ({
    apiVersion: "apps/v1", kind: "StatefulSet", metadata: { name, namespace },
    spec: {
      replicas: 0, serviceName: name, selector: { matchLabels: { app: name } },
      template: { metadata: { labels: { app: name } }, spec: { automountServiceAccountToken: false, containers: [{ name: "db", image: "registry.invalid/zenith/never-pulled:0" }] } },
      volumeClaimTemplates: [{ metadata: { name: "data" }, spec: claimSpec }],
    },
  });
  const claim = (name: string) => ({ apiVersion: "v1", kind: "PersistentVolumeClaim", metadata: { name, namespace }, spec: claimSpec });
  const teardown = (over: { retainStateful: boolean; dryRun?: boolean }) => teardownKubernetesEnvironment({
    workspaceId: "ws-adopt", environmentId, session: session!, adopted: [{ kind: "StatefulSet", namespace, name: "legacy-db" }], signal: AbortSignal.timeout(120_000), ...over,
  });
  const gone = async (ref: ObjectRef) => {
    for (let i = 0; i < 60; i++) { if (!(await exists(ref))) return true; await new Promise((r) => setTimeout(r, 1000)); }
    return false;
  };

  beforeAll(async () => {
    const config = new KubeConfig(); config.loadFromFile(process.env.KUBECONFIG as string);
    session = sessionFromKubeConfig(config, { namespaces: [namespace], ttlSec: 1800 });
    const c = client();
    await c.objects.create({ apiVersion: "v1", kind: "Namespace", metadata: { name: namespace } });
    namespaceCreated = true;
    // Out of band: nothing here carries a Zenith label or environment annotation.
    await c.objects.create(statefulSet("legacy-db"));
    await c.objects.create(statefulSet("kept-db"));
    for (const name of ["data-legacy-db-0", "data-legacy-db-1", "data-legacy-db-x", "data-kept-db-0", "unrelated"]) await c.objects.create(claim(name));
  }, 120_000);
  afterAll(async () => {
    if (session && namespaceCreated) await createK8sClient(session, { signal: AbortSignal.timeout(30_000) }).objects.delete({ apiVersion: "v1", kind: "Namespace", metadata: { name: namespace } });
  }, 30_000);

  it("retains, plans, then deletes exactly the adopted StatefulSet and its template claims", async () => {
    const retained = await teardown({ retainStateful: true });
    expect(retained.deleted).toEqual([]);
    expect(retained.retained).toEqual(expect.arrayContaining([`StatefulSet/${namespace}/legacy-db`, `PersistentVolumeClaim/${namespace}/data-legacy-db-0`, `PersistentVolumeClaim/${namespace}/data-legacy-db-1`]));
    expect(await exists(sts("legacy-db"))).toBe(true);

    const planned = await teardown({ retainStateful: false, dryRun: true });
    expect([...planned.deleted].sort()).toEqual([`PersistentVolumeClaim/${namespace}/data-legacy-db-0`, `PersistentVolumeClaim/${namespace}/data-legacy-db-1`, `StatefulSet/${namespace}/legacy-db`]);
    expect(planned.uncertain).toEqual([]);
    expect(await exists(pvc("data-legacy-db-0"))).toBe(true);

    const applied = await teardown({ retainStateful: false });
    // The claims' protection finalizer is waited out (bounded), so every planned object is confirmed absent.
    expect([...applied.deleted].sort()).toEqual([...planned.deleted].sort());
    expect(applied.uncertain).toEqual([]);
    for (const ref of [sts("legacy-db"), pvc("data-legacy-db-0"), pvc("data-legacy-db-1")]) expect(await gone(ref)).toBe(true);
    for (const ref of [sts("kept-db"), pvc("data-kept-db-0"), pvc("data-legacy-db-x"), pvc("unrelated")]) expect(await exists(ref)).toBe(true);

    // Verification after deletion: a dry run reports nothing left and no gap for the now-absent adopted names.
    const verified = await teardown({ retainStateful: false, dryRun: true });
    expect(verified).toMatchObject({ deleted: [], uncertain: [] });
    expect(verified.skipped.filter((ref) => !/^(Certificate|DNSEndpoint|HTTPRoute)\/[^/]+\/\*$/.test(ref))).toEqual([]);

    const again = await teardown({ retainStateful: false });
    expect(again.uncertain).toEqual([]);
    for (const ref of [sts("kept-db"), pvc("unrelated")]) expect(await exists(ref)).toBe(true);
  }, 300_000);
});
