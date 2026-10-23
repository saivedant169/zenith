/** Contract evidence against fake-api.ts; no real cluster or finalizer controller. */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { teardownKubernetesEnvironment, type KubernetesTeardownInput } from "@/lib/providers/kubernetes";
import { defaultNamespace } from "@/lib/providers/kubernetes/naming";
import { ANNOTATION, KIND_INFO, LABEL, type K8sObject, type SupportedKind } from "@/lib/providers/kubernetes/types";
import { startFakeK8s, type FakeK8s } from "./fake-api";
import { ENV_ID, NS, OTHER_ENV, SECRET_CANARY, sessionFor } from "./helpers";

let fake: FakeK8s;
beforeEach(async () => { fake = await startFakeK8s(); });
afterEach(async () => { await fake.close(); });

function owned(kind: SupportedKind, name: string, namespace = NS): K8sObject {
  return {
    apiVersion: KIND_INFO[kind].apiVersion,
    kind,
    metadata: {
      name,
      ...(kind === "Namespace" ? {} : { namespace }),
      labels: { [LABEL.managedBy]: "zenith" },
      annotations: { [ANNOTATION.environment]: ENV_ID },
    },
    ...(kind === "Namespace" ? {} : { spec: {} }),
  };
}

function seedEnvironment(namespace = NS): void {
  fake.seed(owned("Namespace", namespace));
  fake.seed(owned("Deployment", "web", namespace));
  fake.seed(owned("Service", "web", namespace));
  fake.seed(owned("Secret", "credentials", namespace));
  fake.seed(owned("StatefulSet", "db", namespace));
  fake.seed(owned("PersistentVolumeClaim", "db-data", namespace));
}

const teardown = async (overrides: Partial<KubernetesTeardownInput> = {}) => teardownKubernetesEnvironment({
  workspaceId: "ws-1", environmentId: ENV_ID, session: await sessionFor(fake), retainStateful: true, confirmWaitMs: 0, ...overrides,
});
const deletes = () => fake.requests.filter((request) => request.method === "DELETE");

describe("teardownKubernetesEnvironment (contract)", () => {
  it("exports the C1 entry point and retains data while confirming non-stateful absence", async () => {
    seedEnvironment();
    const report = await teardown();
    expect(report).toEqual({
      deleted: [`Deployment/${NS}/web`, `Secret/${NS}/credentials`, `Service/${NS}/web`],
      retained: [`Namespace//${NS}`, `PersistentVolumeClaim/${NS}/db-data`, `StatefulSet/${NS}/db`],
      skipped: [], uncertain: [],
    });
    expect(fake.get("Deployment", NS, "web")).toBeUndefined();
    expect(fake.get("StatefulSet", NS, "db")).toBeDefined();
    expect(fake.get("PersistentVolumeClaim", NS, "db-data")).toBeDefined();
    expect(deletes().every((request) => typeof request.body?.preconditions?.uid === "string" && typeof request.body?.preconditions?.resourceVersion === "string")).toBe(true);
    for (const request of deletes()) {
      expect(fake.requests.slice(fake.requests.indexOf(request) + 1).some((read) => read.method === "GET" && read.path === request.path)).toBe(true);
    }
  });

  it("explicitly deletes stateful objects with UID preconditions and children-first ordering", async () => {
    seedEnvironment();
    const report = await teardown({ retainStateful: false });
    expect(report.deleted).toEqual([
      `Deployment/${NS}/web`, `PersistentVolumeClaim/${NS}/db-data`, `Secret/${NS}/credentials`, `Service/${NS}/web`, `StatefulSet/${NS}/db`,
    ]);
    expect(report.retained).toEqual([`Namespace//${NS}`]);
    expect(report.uncertain).toEqual([]);
    expect(deletes().map((request) => request.path.split("/").at(-2))).toEqual([
      "deployments", "statefulsets", "services", "persistentvolumeclaims", "secrets",
    ]);
    expect(deletes().every((request) => request.body?.preconditions?.uid?.startsWith("uid-"))).toBe(true);
    expect(fake.get("StatefulSet", NS, "db")).toBeUndefined();
    expect(fake.get("PersistentVolumeClaim", NS, "db-data")).toBeUndefined();
  });

  it.each([true, false])("dryRun reports would-delete refs with retainStateful=%s and writes nothing", async (retainStateful) => {
    seedEnvironment();
    const report = await teardown({ dryRun: true, retainStateful });
    expect(report.deleted).toHaveLength(retainStateful ? 3 : 5);
    expect(report.retained).toHaveLength(retainStateful ? 3 : 1);
    expect(report.uncertain).toEqual([]);
    expect(fake.writes()).toEqual([]);
    expect(fake.get("Deployment", NS, "web")).toBeDefined();
    expect(fake.get("PersistentVolumeClaim", NS, "db-data")).toBeDefined();
  });

  it("never deletes foreign objects, including foreign children inside an owned namespace", async () => {
    seedEnvironment();
    const otherEnvironment = owned("StatefulSet", "other-environment");
    otherEnvironment.metadata.annotations = { [ANNOTATION.environment]: OTHER_ENV };
    const otherTool = owned("PersistentVolumeClaim", "other-tool");
    otherTool.metadata.labels = { [LABEL.managedBy]: "helm" };
    const annotationOnly = owned("Service", "annotation-only");
    delete annotationOnly.metadata.labels;
    const labelOnly = owned("Service", "label-only");
    delete labelOnly.metadata.annotations;
    const foreign = [otherEnvironment, otherTool, annotationOnly, labelOnly];
    for (const object of foreign) fake.seed(object);
    fake.seed({ apiVersion: "v1", kind: "Secret", metadata: { name: "unmarked", namespace: NS }, data: { value: Buffer.from(SECRET_CANARY).toString("base64") } });
    fake.seedPod({ apiVersion: "v1", kind: "Pod", metadata: { name: "unmarked-pod", namespace: NS } });
    const report = await teardown({ retainStateful: false });
    for (const object of foreign) {
      expect(fake.get(object.kind, NS, object.metadata.name)).toBeDefined();
      expect(JSON.stringify(report)).not.toContain(object.metadata.name);
    }
    expect(fake.get("Secret", NS, "unmarked")).toBeDefined();
    expect(fake.get("Pod", NS, "unmarked-pod")).toBeDefined();
    expect(deletes().some((request) => request.path === `/api/v1/namespaces/${NS}`)).toBe(false);
    expect(report.retained).toContain(`Namespace//${NS}`);
  });

  describe("adopted objects (PROD-LIFE-11)", () => {
    const adoptedPvc = (name: string, labels?: Record<string, string>): K8sObject => ({
      apiVersion: "v1", kind: "PersistentVolumeClaim", metadata: { name, namespace: NS, ...(labels ? { labels } : {}) }, spec: {},
    });
    const claim = (name: string) => [{ kind: "PersistentVolumeClaim" as const, namespace: NS, name }];

    it("deletes an unlabeled adopted claim exactly when its claim allows destruction", async () => {
      seedEnvironment();
      fake.seed(adoptedPvc("adopted-data"));
      fake.seed(adoptedPvc("never-adopted"));
      const report = await teardown({ retainStateful: false, adopted: claim("adopted-data") });
      expect(report.deleted).toContain(`PersistentVolumeClaim/${NS}/adopted-data`);
      expect(fake.get("PersistentVolumeClaim", NS, "adopted-data")).toBeUndefined();
      expect(fake.get("PersistentVolumeClaim", NS, "never-adopted")).toBeDefined();
      expect(JSON.stringify(report)).not.toContain("never-adopted");
      const request = deletes().find((entry) => entry.path.endsWith("/persistentvolumeclaims/adopted-data"));
      expect(request?.body?.preconditions?.uid).toMatch(/^uid-/);
    });

    it("deletes an adopted StatefulSet with exactly the claims its templates created", async () => {
      fake.seed({ apiVersion: "apps/v1", kind: "StatefulSet", metadata: { name: "legacy-db", namespace: NS }, spec: { volumeClaimTemplates: [{ metadata: { name: "data" } }] } });
      fake.seed(adoptedPvc("data-legacy-db-0"));
      fake.seed(adoptedPvc("data-legacy-db-1"));
      fake.seed(adoptedPvc("data-legacy-db-x"));
      fake.seed(adoptedPvc("data-other-db-0"));
      const report = await teardown({ retainStateful: false, adopted: [{ kind: "StatefulSet", namespace: NS, name: "legacy-db" }] });
      expect(report.deleted).toEqual(expect.arrayContaining([`StatefulSet/${NS}/legacy-db`, `PersistentVolumeClaim/${NS}/data-legacy-db-0`, `PersistentVolumeClaim/${NS}/data-legacy-db-1`]));
      expect(fake.get("StatefulSet", NS, "legacy-db")).toBeUndefined();
      expect(fake.get("PersistentVolumeClaim", NS, "data-legacy-db-0")).toBeUndefined();
      expect(fake.get("PersistentVolumeClaim", NS, "data-legacy-db-x")).toBeDefined();
      expect(fake.get("PersistentVolumeClaim", NS, "data-other-db-0")).toBeDefined();
      expect(report.uncertain).toEqual([]);
    });

    it("retains an adopted claim while stateful data is retained", async () => {
      fake.seed(adoptedPvc("adopted-data"));
      const report = await teardown({ retainStateful: true, adopted: claim("adopted-data") });
      expect(report.retained).toContain(`PersistentVolumeClaim/${NS}/adopted-data`);
      expect(fake.get("PersistentVolumeClaim", NS, "adopted-data")).toBeDefined();
      expect(deletes()).toEqual([]);
    });

    it("never deletes an adopted name that another Zenith environment owns", async () => {
      const other = owned("PersistentVolumeClaim", "shared-data");
      other.metadata.annotations = { [ANNOTATION.environment]: OTHER_ENV };
      fake.seed(other);
      const report = await teardown({ retainStateful: false, adopted: claim("shared-data") });
      expect(report.skipped).toContain(`PersistentVolumeClaim/${NS}/shared-data`);
      expect(fake.get("PersistentVolumeClaim", NS, "shared-data")).toBeDefined();
    });

    it("plans an adopted deletion in a dry run without writing", async () => {
      fake.seed(adoptedPvc("adopted-data"));
      const report = await teardown({ retainStateful: false, dryRun: true, adopted: claim("adopted-data") });
      expect(report.deleted).toContain(`PersistentVolumeClaim/${NS}/adopted-data`);
      expect(deletes()).toEqual([]);
      expect(fake.get("PersistentVolumeClaim", NS, "adopted-data")).toBeDefined();
    });

    it("reports a malformed adopted reference as uncertain and deletes nothing for it", async () => {
      fake.seed(adoptedPvc("adopted-data"));
      const report = await teardown({ retainStateful: false, adopted: [{ kind: "PersistentVolumeClaim", namespace: NS, name: "Bad/Name" }] });
      expect(report.uncertain).toContain(`PersistentVolumeClaim/${NS}/*`);
      expect(deletes()).toEqual([]);
    });
  });

  it("does not use a namespace's foreign ownership as an excuse to delete it", async () => {
    const namespace = owned("Namespace", NS);
    namespace.metadata.annotations = { [ANNOTATION.environment]: OTHER_ENV };
    fake.seed(namespace);
    fake.seed(owned("Service", "ours"));
    const report = await teardown({ retainStateful: false });
    expect(report.deleted).toEqual([`Service/${NS}/ours`]);
    expect(report.retained).toEqual([]);
    expect(fake.get("Namespace", undefined, NS)).toBeDefined();
  });

  it("discovers custom environment-owned namespaces with an empty session allowlist", async () => {
    seedEnvironment("custom-one");
    seedEnvironment("custom-two");
    fake.seed(owned("Namespace", "other-environment"));
    fake.foreignUpdate("Namespace", undefined, "other-environment", "other", { metadata: { annotations: { [ANNOTATION.environment]: OTHER_ENV } } });
    fake.seed(owned("Service", "not-allowlisted", "other-environment"));
    const report = await teardown({ session: await sessionFor(fake, []), retainStateful: false });
    expect(report.deleted).toHaveLength(10);
    expect(report.retained).toEqual(["Namespace//custom-one", "Namespace//custom-two"]);
    expect(fake.get("Service", "other-environment", "not-allowlisted")).toBeDefined();
    expect(JSON.stringify(report)).not.toContain("not-allowlisted");
  });

  it("scans allowlisted shared namespaces but deletes only this environment's objects", async () => {
    fake.seed({ apiVersion: "v1", kind: "Namespace", metadata: { name: "shared" } });
    fake.seed(owned("Service", "ours", "shared"));
    fake.seed({ apiVersion: "v1", kind: "Service", metadata: { name: "foreign", namespace: "shared" } });
    const report = await teardown({ session: await sessionFor(fake, ["shared", "shared"]) });
    expect(report.deleted).toEqual(["Service/shared/ours"]);
    expect(fake.get("Service", "shared", "foreign")).toBeDefined();
    expect(fake.requests.filter((request) => request.method === "GET" && request.path.endsWith("/namespaces/shared/services"))).toHaveLength(2);
  });

  it("uses the environment's deterministic default namespace when namespace listing is forbidden", async () => {
    const namespace = defaultNamespace(ENV_ID);
    seedEnvironment(namespace);
    fake.inject({ match: (request) => request.method === "GET" && request.path === "/api/v1/namespaces", status: 403, message: "denied" });
    const report = await teardown({ session: await sessionFor(fake, []) });
    expect(report.deleted).toContain(`Deployment/${namespace}/web`);
    expect(report.uncertain).toContain("Namespace//*");
    expect(fake.get("PersistentVolumeClaim", namespace, "db-data")).toBeDefined();
  });

  it("treats repeated teardown as idempotent without issuing repeated DELETEs", async () => {
    seedEnvironment();
    await teardown({ retainStateful: false });
    const count = deletes().length;
    const second = await teardown({ retainStateful: false });
    expect(second).toEqual({ deleted: [], retained: [`Namespace//${NS}`], skipped: [], uncertain: [] });
    expect(deletes()).toHaveLength(count);
  });

  it.each(["Service", "StatefulSet", "PersistentVolumeClaim"] as const)("rechecks %s ownership between plan and deletion", async (kind) => {
    fake.seed(owned("Namespace", NS));
    fake.seed(owned(kind, "changed"));
    fake.inject({
      match: (request) => {
        if (request.method === "GET" && request.path.endsWith("/changed")) {
          fake.foreignUpdate(kind, NS, "changed", "new-owner", { metadata: { annotations: { [ANNOTATION.environment]: OTHER_ENV } } });
        }
        return false;
      }, status: 200, message: "",
    });
    const report = await teardown({ retainStateful: false });
    expect(report.skipped).toEqual([`${kind}/${NS}/changed`]);
    expect(report.deleted).toEqual([]);
    expect(deletes()).toEqual([]);
    expect(fake.get(kind, NS, "changed")).toBeDefined();
  });

  it.each(["Service", "StatefulSet", "PersistentVolumeClaim"] as const)("the %s UID precondition protects a replacement and is never retried", async (kind) => {
    fake.seed(owned("Namespace", NS));
    const first = fake.seed(owned(kind, "replaced"));
    fake.inject({
      match: (request) => {
        if (request.method === "DELETE" && request.path.endsWith("/replaced")) fake.seed(owned(kind, "replaced"));
        return false;
      }, status: 200, message: "",
    });
    const report = await teardown({ retainStateful: false });
    expect(report.skipped).toEqual([`${kind}/${NS}/replaced`]);
    expect(report.deleted).toEqual([]);
    expect(deletes()).toHaveLength(1);
    expect(deletes()[0].body?.preconditions?.uid).toBe(first.metadata.uid);
    expect(fake.get(kind, NS, "replaced")?.metadata.uid).not.toBe(first.metadata.uid);
  });

  it("reports accepted deletion as uncertain when the confirmation read still sees an object", async () => {
    fake.seed(owned("Namespace", NS));
    fake.seed(owned("Service", "pending"));
    let accepted = false;
    fake.inject({
      match: (request) => {
        if (request.method === "DELETE" && request.path.endsWith("/services/pending")) accepted = true;
        else if (accepted && request.method === "GET" && request.path.endsWith("/services/pending")) {
          // The fake has no finalizer controller: explicitly model the read-back.
          const terminating = owned("Service", "pending");
          terminating.metadata.deletionTimestamp = "2026-10-01T00:00:00Z";
          fake.seed(terminating);
        }
        return false;
      }, status: 200, message: "",
    });
    const report = await teardown();
    expect(report.uncertain).toEqual([`Service/${NS}/pending`]);
    expect(report.deleted).toEqual([]);
    expect(deletes()).toHaveLength(1);
  });

  it("waits, bounded, for an accepted delete a finalizer holds briefly, then reports it deleted", async () => {
    fake.seed(owned("Namespace", NS));
    const claim = fake.seed(owned("Service", "finalized"));
    let reads = 0;
    fake.inject({
      match: (request) => {
        if (request.method !== "GET" || !request.path.endsWith("/services/finalized") || !deletes().length) return false;
        // Two reads still see the same terminating object; then the finalizer is gone.
        if (++reads <= 2) { const held = owned("Service", "finalized"); held.metadata.uid = claim.metadata.uid; held.metadata.deletionTimestamp = "2026-10-01T00:00:00Z"; fake.seed(held); }
        else fake.remove("Service", NS, "finalized");
        return false;
      }, status: 200, message: "",
    });
    const report = await teardown({ confirmWaitMs: 5_000 });
    expect(report.deleted).toEqual([`Service/${NS}/finalized`]);
    expect(report.uncertain).toEqual([]);
    expect(reads).toBeGreaterThanOrEqual(3);
  });

  it("sends the read resourceVersion to protect against same-UID ownership changes", async () => {
    fake.seed(owned("Namespace", NS));
    const first = fake.seed(owned("Service", "changed-owner"));
    fake.inject({
      match: (request) => {
        if (request.method !== "DELETE" || !request.path.endsWith("/services/changed-owner")) return false;
        fake.foreignUpdate("Service", NS, "changed-owner", "new-owner", { metadata: { annotations: { [ANNOTATION.environment]: OTHER_ENV } } });
        // The fake's DELETE only enforces UID. Model the server's version
        // refusal explicitly; this proves the precondition on the wire only.
        return request.body?.preconditions?.resourceVersion !== fake.get("Service", NS, "changed-owner")?.metadata.resourceVersion;
      }, status: 409, message: "Resource version changed",
    });
    const report = await teardown();
    expect(deletes()).toHaveLength(1);
    expect(deletes()[0].body.preconditions).toEqual({ uid: first.metadata.uid, resourceVersion: first.metadata.resourceVersion });
    expect(fake.get("Service", NS, "changed-owner")?.metadata.uid).toBe(first.metadata.uid);
    expect(report.skipped).toEqual([`Service/${NS}/changed-owner`]);
    expect(report.deleted).toEqual([]);
  });

  it("reports accepted deletion as uncertain when confirmation is forbidden", async () => {
    fake.seed(owned("Namespace", NS));
    fake.seed(owned("Service", "pending"));
    fake.inject({ match: (request) => request.method === "GET" && request.path.endsWith("/services/pending") && deletes().length > 0, status: 403, message: SECRET_CANARY });
    const report = await teardown();
    expect(report.uncertain).toEqual([`Service/${NS}/pending`]);
    expect(report.deleted).toEqual([]);
    expect(JSON.stringify(report)).not.toContain(SECRET_CANARY);
  });

  it("reports already-terminating objects as uncertain without deleting them again", async () => {
    fake.seed(owned("Namespace", NS));
    for (const kind of ["Service", "StatefulSet", "PersistentVolumeClaim"] as const) {
      const object = owned(kind, "terminating");
      object.metadata.deletionTimestamp = "2026-10-01T00:00:00Z";
      fake.seed(object);
    }
    const report = await teardown({ retainStateful: false });
    expect(report.uncertain).toEqual([
      `PersistentVolumeClaim/${NS}/terminating`, `Service/${NS}/terminating`, `StatefulSet/${NS}/terminating`,
    ]);
    expect(report.deleted).toEqual([]);
    expect(deletes()).toEqual([]);
  });

  it("reports an already-terminating namespace as uncertain rather than retained", async () => {
    const object = owned("Namespace", NS);
    object.metadata.deletionTimestamp = "2026-10-01T00:00:00Z";
    fake.seed(object);
    const report = await teardown();
    expect(report.uncertain).toEqual([`Namespace//${NS}`]);
    expect(report.retained).toEqual([]);
    expect(fake.writes()).toEqual([]);
  });

  it("skips missing UIDs, even in a dry run", async () => {
    fake.seed(owned("Namespace", NS));
    const object = owned("Service", "no-uid");
    object.metadata.uid = "";
    fake.seed(object);
    const report = await teardown({ dryRun: true });
    expect(report.skipped).toEqual([`Service/${NS}/no-uid`]);
    expect(report.deleted).toEqual([]);
    expect(deletes()).toEqual([]);
  });

  it("checks absence for an object that disappears between the read and the DELETE", async () => {
    fake.seed(owned("Namespace", NS));
    fake.seed(owned("Service", "gone"));
    fake.inject({ match: (request) => {
      if (request.method === "DELETE" && request.path.endsWith("/services/gone")) fake.remove("Service", NS, "gone");
      return false;
    }, status: 200, message: "" });
    const report = await teardown();
    expect(report.deleted).toEqual([`Service/${NS}/gone`]);
    expect(report.uncertain).toEqual([]);
  });

  it.each([{ status: 403, outcome: "skipped" }, { status: 500, outcome: "uncertain" }] as const)("classifies HTTP $status deletion failures without leaking response text", async ({ status, outcome }) => {
    fake.seed(owned("Namespace", NS));
    fake.seed(owned("Service", "failed"));
    fake.inject({ match: (request) => request.method === "DELETE", status, message: `${SECRET_CANARY} ${fake.token}` });
    const report = await teardown();
    expect(report[outcome]).toEqual([`Service/${NS}/failed`]);
    expect(report.deleted).toEqual([]);
    expect(JSON.stringify(report)).not.toContain(SECRET_CANARY);
    expect(JSON.stringify(report)).not.toContain(fake.token);
    expect(deletes()).toHaveLength(1);
  });

  it("reports unavailable CRDs as skipped object-ref patterns", async () => {
    fake.seed(owned("Namespace", NS));
    fake.setCrds(false);
    const report = await teardown();
    for (const kind of ["Certificate", "DNSEndpoint", "HTTPRoute"]) expect(report.skipped).toContain(`${kind}/${NS}/*`);
    expect(report.uncertain).toEqual([]);
  });

  it("reports list failure as a coverage gap while continuing safe deletions", async () => {
    seedEnvironment();
    fake.inject({ match: (request) => request.method === "GET" && request.path.endsWith(`/namespaces/${NS}/services`), status: 500, message: SECRET_CANARY });
    const report = await teardown();
    expect(report.uncertain).toContain(`Service/${NS}/*`);
    expect(report.deleted).toContain(`Deployment/${NS}/web`);
    expect(fake.get("Service", NS, "web")).toBeDefined();
    expect(JSON.stringify(report)).not.toContain(SECRET_CANARY);
  });

  it("reports bounded pagination as uncertain and does not pretend the final object was planned", async () => {
    fake.seed(owned("Namespace", NS));
    for (let i = 0; i < 6; i++) fake.seed(owned("Service", `page-${i}`));
    fake.inject({ match: (request) => {
      // Model a server that returns smaller pages than the requested limit.
      if (request.method === "GET" && request.path.endsWith(`/namespaces/${NS}/services`)) request.query.limit = "1";
      return false;
    }, status: 200, message: "" });
    const report = await teardown({ dryRun: true });
    expect(report.deleted).toHaveLength(5);
    expect(report.uncertain).toContain(`Service/${NS}/*`);
    expect(report.uncertain).toContain("Namespace//*");
    expect(report.deleted).not.toContain(`Service/${NS}/page-5`);
    expect(fake.writes()).toEqual([]);
  });

  it("rejects a pre-aborted call before making any API request", async () => {
    const controller = new AbortController();
    controller.abort(SECRET_CANARY);
    await expect(teardown({ signal: controller.signal })).rejects.toMatchObject({ code: "aborted", message: "The operation was aborted." });
    expect(fake.requests).toEqual([]);
  });

  it("marks in-flight deletion uncertain on abort and never dispatches remaining candidates", async () => {
    seedEnvironment();
    const controller = new AbortController();
    fake.inject({ match: (request) => {
      if (request.method === "DELETE") controller.abort(SECRET_CANARY);
      return false;
    }, status: 200, message: "" });
    const report = await teardown({ signal: controller.signal, retainStateful: false });
    expect(deletes()).toHaveLength(1);
    expect(report.uncertain).toContain(`Deployment/${NS}/web`);
    expect(report.skipped).toContain(`StatefulSet/${NS}/db`);
    expect(report.deleted).toEqual([]);
    expect(JSON.stringify(report)).not.toContain(SECRET_CANARY);
  });

  it("marks an interrupted plan as incomplete and writes nothing", async () => {
    seedEnvironment();
    const controller = new AbortController();
    fake.inject({ match: (request) => {
      if (request.method === "GET" && request.path.endsWith(`/namespaces/${NS}/deployments`)) controller.abort();
      return false;
    }, status: 200, message: "" });
    const report = await teardown({ signal: controller.signal });
    expect(report.uncertain.length).toBeGreaterThan(0);
    expect(report.deleted).toEqual([]);
    expect(fake.writes()).toEqual([]);
  });

  it("reports a deletion whose response exceeds the caller's deadline as uncertain", async () => {
    fake.seed(owned("Namespace", NS));
    fake.seed(owned("Service", "timeout"));
    const controller = new AbortController();
    fake.inject({
      match: (request) => {
        if (request.method !== "DELETE") return false;
        // Start the deadline only after dispatch so the test isolates an
        // ambiguous write timeout rather than a slower discovery request.
        const deadline = AbortSignal.timeout(10);
        deadline.addEventListener("abort", () => controller.abort(deadline.reason), { once: true });
        return true;
      }, status: 200, message: "", delayMs: 75,
    });
    const report = await teardown({ signal: controller.signal });
    expect(report.uncertain).toContain(`Service/${NS}/timeout`);
    expect(report.deleted).toEqual([]);
    expect(deletes()).toHaveLength(1);
  });

  it("does not start a deletion when cancelled after its live ownership read", async () => {
    fake.seed(owned("Namespace", NS));
    fake.seed(owned("Service", "cancelled"));
    const controller = new AbortController();
    fake.inject({ match: (request) => {
      if (request.method === "GET" && request.path.endsWith("/services/cancelled")) controller.abort();
      return false;
    }, status: 200, message: "" });
    const report = await teardown({ signal: controller.signal });
    expect(report.uncertain).toContain(`Service/${NS}/cancelled`);
    expect(report.deleted).toEqual([]);
    expect(fake.writes()).toEqual([]);
  });

  it("keeps credential and Secret payloads out of the report", async () => {
    fake.seed(owned("Namespace", NS));
    fake.seed({ ...owned("Secret", "secret"), data: { value: Buffer.from(SECRET_CANARY).toString("base64") }, stringData: { value: SECRET_CANARY } });
    const report = await teardown();
    expect(report.deleted).toEqual([`Secret/${NS}/secret`]);
    expect(JSON.stringify(report)).not.toContain(SECRET_CANARY);
    expect(JSON.stringify(report)).not.toContain(Buffer.from(SECRET_CANARY).toString("base64"));
    expect(JSON.stringify(report)).not.toContain(fake.token);
    expect(deletes()[0].body).toEqual({ preconditions: { uid: expect.any(String), resourceVersion: expect.any(String) } });
  });

  it.each([
    { workspaceId: "" }, { environmentId: " " }, { retainStateful: "false" }, { dryRun: "true" },
    { session: null }, { session: { provider: "aws" } },
  ])("rejects invalid input before I/O: %j", async (overrides) => {
    await expect(teardown(overrides as unknown as Partial<KubernetesTeardownInput>)).rejects.toHaveProperty("code");
    expect(fake.requests).toEqual([]);
  });

  it("refuses an expired session even when its kubeConfig function would still succeed", async () => {
    const session = await sessionFor(fake);
    await expect(teardown({ session: { ...session, expiresAt: "2000-01-01T00:00:00Z", kubeConfig: () => session.kubeConfig() } })).rejects.toMatchObject({ code: "session_expired" });
    expect(fake.requests).toEqual([]);
  });

  it("rejects malformed namespace scopes before any deletion", async () => {
    const session = await sessionFor(fake);
    await expect(teardown({ session: { ...session, namespaces: ["bad/namespace"], kubeConfig: () => session.kubeConfig() } })).rejects.toMatchObject({ code: "session_invalid" });
    expect(fake.requests).toEqual([]);
  });

  it("never echoes an error raised while initializing session credentials", async () => {
    const session = await sessionFor(fake);
    await expect(teardown({ session: { ...session, kubeConfig: () => { throw new Error(`${SECRET_CANARY} ${fake.token}`); } } })).rejects.toMatchObject({ code: "session_invalid", message: "The Kubernetes teardown client could not be initialized." });
    expect(fake.requests).toEqual([]);
  });
});
