/* eslint-disable @typescript-eslint/no-explicit-any */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { diff, serverSideApply } from "@/lib/providers/kubernetes/apply";
import { renderGraph } from "@/lib/providers/kubernetes/render";
import { ANNOTATION, FIELD_MANAGER, OPS_FIELD_MANAGER, type K8sObject } from "@/lib/providers/kubernetes/types";
import { startFakeK8s, type FakeK8s } from "./fake-api";
import { ENV_ID, NS, OTHER_ENV, SECRET_CANARY, dbNode, fullGraph, networkNode, resolver, secretNode, serviceNode, sessionFor } from "./helpers";

let fake: FakeK8s;
beforeEach(async () => {
  fake = await startFakeK8s();
});
afterEach(async () => {
  await fake.close();
});

const ctx = { environmentId: ENV_ID, resolveDnsTarget: () => "lb.example.elb.amazonaws.com" };
const small = (over: Record<string, unknown> = {}) => renderGraph([networkNode(), serviceNode(over)], ctx).objects;
const find = (objects: K8sObject[], kind: string) => objects.find((o) => o.kind === kind) as K8sObject;
const patches = () => fake.requests.filter((r) => r.method === "PATCH");

describe("serverSideApply", () => {
  it("creates objects in apply order with field manager zenith and force=false, then is a no-op", async () => {
    const session = await sessionFor(fake, []);
    const objects = small();
    const first = await serverSideApply([...objects].reverse(), session, { environmentId: ENV_ID });
    expect(first.ok).toBe(true);
    expect(first.refused).toBe(false);
    expect(first.results.map((r) => `${r.ref.kind}:${r.status}`)).toEqual(["Namespace:created", "NetworkPolicy:created", "Service:created", "Deployment:created"]);
    for (const p of patches()) {
      expect(p.query.fieldManager).toBe("zenith");
      expect(p.query.force).toBe("false");
      expect(p.contentType).toBe("application/apply-patch+yaml");
    }
    expect(patches().map((p) => p.body.kind)).toEqual(["Namespace", "NetworkPolicy", "Service", "Deployment"]);

    const again = await serverSideApply(objects, session, { environmentId: ENV_ID });
    expect(again.results.map((r) => r.status)).toEqual(["unchanged", "unchanged", "unchanged", "unchanged"]);
    expect(first.results[3].resourceVersion).toBe(again.results[3].resourceVersion);
  });

  it("reports `configured` when the desired object changes and the live object follows", async () => {
    const session = await sessionFor(fake, []);
    await serverSideApply(small(), session, { environmentId: ENV_ID });
    const r = await serverSideApply(small({ replicas: 5, artifact: { type: "image", ref: "ghcr.io/acme/web:2.0.0" } }), session, { environmentId: ENV_ID });
    expect(r.results.find((x) => x.ref.kind === "Deployment")?.status).toBe("configured");
    const live = fake.get("Deployment", NS, "web") as any;
    expect(live.spec.replicas).toBe(5);
    expect(live.spec.template.spec.containers[0].image).toBe("ghcr.io/acme/web:2.0.0");
    expect(r.results.find((x) => x.ref.kind === "Namespace")?.status).toBe("unchanged");
  });

  it("reports a no-op when controller status advances after preflight, while still reporting desired changes", async () => {
    const session = await sessionFor(fake, []);
    await serverSideApply(small(), session, { environmentId: ENV_ID });
    const previousVersion = fake.get("Deployment", NS, "web")!.metadata.resourceVersion;
    fake.inject({
      match: (request) => {
        if (request.method !== "PATCH" || !request.path.endsWith("/deployments/web")) return false;
        fake.setStatus("Deployment", NS, "web", { readyReplicas: 1 });
        return true;
      },
      status: 200, message: "", times: 1,
    });
    const again = await serverSideApply(small(), session, { environmentId: ENV_ID });
    const deployment = again.results.find((result) => result.ref.kind === "Deployment")!;
    expect(deployment.resourceVersion).not.toBe(previousVersion);
    expect(deployment.status).toBe("unchanged");
    const changed = await serverSideApply(small({ replicas: 4 }), session, { environmentId: ENV_ID });
    expect(changed.results.find((result) => result.ref.kind === "Deployment")!.status).toBe("configured");
  });

  it("sends every rendered kind to the API exactly as rendered (no field lost in serialization)", async () => {
    const session = await sessionFor(fake, []);
    const { objects } = renderGraph(fullGraph(), ctx);
    const report = await serverSideApply(objects, session, { environmentId: ENV_ID, resolveSecret: async () => "generated-value-0001" });
    expect(report.results.filter((r) => r.status !== "created")).toEqual([]);
    expect(new Set(objects.map((o) => o.kind))).toEqual(
      new Set(["Namespace", "NetworkPolicy", "ServiceAccount", "Secret", "Service", "Deployment", "CronJob", "StatefulSet", "PersistentVolumeClaim", "Ingress", "Certificate", "DNSEndpoint"])
    );
    for (const o of objects) {
      const sent = patches().find((p) => p.body?.kind === o.kind && p.body?.metadata?.name === o.metadata.name);
      expect(sent, `${o.kind}/${o.metadata.name}`).toBeDefined();
      const want = JSON.parse(JSON.stringify(o));
      const got = JSON.parse(JSON.stringify(sent!.body));
      if (o.kind === "Secret") delete got.data; // merged at apply time; asserted separately
      expect(got, `${o.kind}/${o.metadata.name}`).toEqual(want);
    }
  });

  it("REGRESSION: a NetworkPolicy rule's `from` peers reach the API (the library's typed models drop it, which would open the rule to every source)", async () => {
    const session = await sessionFor(fake, []);
    const { objects } = renderGraph(fullGraph(), ctx);
    await serverSideApply(objects.filter((o) => o.kind === "Namespace" || o.kind === "NetworkPolicy"), session, { environmentId: ENV_ID });
    const sent = patches().filter((p) => p.body.kind === "NetworkPolicy" && p.body.metadata.name.startsWith("fw-"));
    expect(sent.length).toBeGreaterThan(0);
    for (const p of sent) {
      const rules = p.body.spec.ingress as any[];
      expect(rules.length).toBeGreaterThan(0);
      for (const rule of rules) {
        expect(Array.isArray(rule.from) && rule.from.length > 0, JSON.stringify(rule)).toBe(true);
        expect(rule).not.toHaveProperty("_from");
      }
    }
    // and what the server stored has them too
    for (const np of fake.list("NetworkPolicy", NS).filter((n) => n.metadata.name.startsWith("fw-"))) {
      for (const rule of (np.spec as any).ingress) expect(rule.from.length).toBeGreaterThan(0);
    }
    // reading a policy back returns the server's JSON as is: `from`, not the library model's `_from`
    const { readObject, createK8sClient } = await import("@/lib/providers/kubernetes/client");
    const live = await readObject(createK8sClient(session, { environmentId: ENV_ID }), { apiVersion: "networking.k8s.io/v1", kind: "NetworkPolicy", namespace: NS, name: "fw-web-to-db" });
    expect(JSON.stringify(live)).toContain('"from"');
    expect(JSON.stringify(live)).not.toContain("_from");
  });

  it("applies the day-two manager too, and refuses to force or use any other manager", async () => {
    const session = await sessionFor(fake, []);
    const r = await serverSideApply(small(), session, { environmentId: ENV_ID, fieldManager: OPS_FIELD_MANAGER });
    expect(r.ok).toBe(true);
    expect(patches()[0].query.fieldManager).toBe("zenith-ops");
    await expect(serverSideApply(small(), session, { force: true as unknown as false })).rejects.toThrow(/never forces/);
    await expect(serverSideApply(small(), session, { fieldManager: "kubectl" as typeof FIELD_MANAGER })).rejects.toThrow(/own field managers/);
  });

  it("refuses objects it did not render: unsupported kinds, missing marks, wrong environment, Secrets with data", async () => {
    const session = await sessionFor(fake, []);
    const good = find(small(), "Deployment");
    const cases: [string, K8sObject, RegExp][] = [
      ["unsupported kind", { apiVersion: "v1", kind: "ConfigMap", metadata: { name: "x", namespace: NS } }, /does not apply/],
      ["no managed-by", { ...good, metadata: { ...good.metadata, labels: {} } }, /managed-by/],
      ["no environment", { ...good, metadata: { ...good.metadata, annotations: { [ANNOTATION.resource]: "service/web" } } }, /environment/],
      ["wrong environment", { ...good, metadata: { ...good.metadata, annotations: { ...good.metadata.annotations, [ANNOTATION.environment]: OTHER_ENV } } }, /different environment/],
      ["no namespace", { ...good, metadata: { ...good.metadata, namespace: undefined } }, /namespace/],
      ["bad name", { ...good, metadata: { ...good.metadata, name: "Not_Valid" } }, /DNS label/],
      ["secret with data", { apiVersion: "v1", kind: "Secret", data: { value: "eA==" }, metadata: { ...good.metadata, name: "s" } }, /without data/],
    ];
    for (const [name, obj, re] of cases) {
      const r = await serverSideApply([obj], session, { environmentId: ENV_ID });
      expect(r.ok, name).toBe(false);
      expect(r.refused, name).toBe(true);
      expect(r.results[0].message, name).toMatch(re);
    }
    expect(fake.writes()).toHaveLength(0);
  });

  it("stops at the first failing object, reports the rest as skipped, and leaves earlier objects applied", async () => {
    const session = await sessionFor(fake, []);
    fake.inject({ match: (r) => r.method === "PATCH" && r.path.endsWith("/services/web"), status: 500, message: "etcd unavailable", times: 1 });
    const r = await serverSideApply(small(), session, { environmentId: ENV_ID });
    expect(r.ok).toBe(false);
    expect(r.results.map((x) => `${x.ref.kind}:${x.status}`)).toEqual(["Namespace:created", "NetworkPolicy:created", "Service:error", "Deployment:skipped"]);
    expect(r.results[2].errorCode).toBe("api_error");
    expect(fake.get("Namespace", undefined, NS)).toBeDefined();
    expect(fake.get("Deployment", NS, "web")).toBeUndefined();
  });

  it("stops promptly when aborted and does not start the remaining objects", async () => {
    const session = await sessionFor(fake, []);
    fake.inject({ match: (r) => r.method === "PATCH" && r.path.endsWith("/networkpolicies/zenith-default-deny-ingress"), status: 200, message: "", delayMs: 300, times: 1 });
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 60);
    const r = await serverSideApply(small(), session, { environmentId: ENV_ID, signal: ac.signal });
    expect(r.ok).toBe(false);
    expect(r.results.find((x) => x.ref.kind === "Service")?.status).toBe("skipped");
    expect(r.results.find((x) => x.ref.kind === "Deployment")?.status).toBe("skipped");
    expect(fake.get("Deployment", NS, "web")).toBeUndefined();
  });

  it("refuses to start with an already-aborted signal", async () => {
    const session = await sessionFor(fake, []);
    const ac = new AbortController();
    ac.abort();
    await expect(serverSideApply(small(), session, { signal: ac.signal })).rejects.toMatchObject({ code: "aborted" });
  });

  it("derives the environment from the objects when none is given, and refuses a batch that names several", async () => {
    const session = await sessionFor(fake, []);
    expect((await serverSideApply(small(), session)).ok).toBe(true);
    const mixed = [...small(), ...renderGraph([networkNode()], { environmentId: OTHER_ENV }).objects];
    await expect(serverSideApply(mixed, session)).rejects.toMatchObject({ code: "invalid_object" });
    const r = await serverSideApply(mixed, session, { environmentId: ENV_ID });
    expect(r.ok).toBe(false);
    expect(r.refused).toBe(true);
  });

  it("never puts the bearer token in a result", async () => {
    const session = await sessionFor(fake, []);
    const r = await serverSideApply(small(), session, { environmentId: ENV_ID });
    expect(JSON.stringify(r)).not.toContain(fake.token);
  });
});

describe("ownership guard", () => {
  it("refuses an existing object that Zenith does not own, applies NOTHING, and never adopts it", async () => {
    const session = await sessionFor(fake, []);
    fake.seed({ apiVersion: "apps/v1", kind: "Deployment", metadata: { name: "web", namespace: NS, labels: { app: "legacy" } }, spec: { replicas: 9, selector: { matchLabels: { app: "legacy" } }, template: { metadata: { labels: { app: "legacy" } }, spec: { containers: [{ name: "c", image: "nginx" }] } } } });
    const r = await serverSideApply(small(), session, { environmentId: ENV_ID });
    expect(r.ok).toBe(false);
    expect(r.refused).toBe(true);
    const conflict = r.results.find((x) => x.status === "ownership_conflict");
    expect(conflict?.ref).toMatchObject({ kind: "Deployment", name: "web", namespace: NS });
    expect(conflict?.errorCode).toBe("ownership_conflict");
    expect(conflict?.message).toMatch(/never modifies or adopts/);
    expect(r.results.filter((x) => x.status === "skipped")).toHaveLength(3);
    expect(fake.writes()).toHaveLength(0);
    const live = fake.get("Deployment", NS, "web") as any;
    expect(live.metadata.labels).toEqual({ app: "legacy" });
    expect(live.spec.replicas).toBe(9);
  });

  it("refuses an object owned by Zenith for a DIFFERENT environment", async () => {
    const session = await sessionFor(fake, []);
    await serverSideApply(renderGraph([networkNode(), serviceNode()], { environmentId: OTHER_ENV }).objects, await sessionFor(fake, [NS]), { environmentId: OTHER_ENV });
    const r = await serverSideApply(small(), session, { environmentId: ENV_ID });
    expect(r.refused).toBe(true);
    expect(r.results.some((x) => x.status === "ownership_conflict")).toBe(true);
    const live = fake.get("Deployment", NS, "web") as any;
    expect(live.metadata.annotations[ANNOTATION.environment]).toBe(OTHER_ENV);
  });

  it("refuses a pre-existing foreign Namespace and does not label it", async () => {
    const session = await sessionFor(fake, [NS]);
    fake.seed({ apiVersion: "v1", kind: "Namespace", metadata: { name: NS } });
    const r = await serverSideApply(small(), session, { environmentId: ENV_ID });
    expect(r.results.find((x) => x.ref.kind === "Namespace")?.status).toBe("ownership_conflict");
    expect(fake.writes()).toHaveLength(0);
    expect((fake.get("Namespace", undefined, NS) as any).metadata.labels).toBeUndefined();
  });

  it("uses an allowlisted operator-provisioned Namespace that enforces Pod Security, without writing or labeling it", async () => {
    const session = await sessionFor(fake, [NS]);
    const provisioned = { "pod-security.kubernetes.io/enforce": "baseline", team: "ops" };
    fake.seed({ apiVersion: "v1", kind: "Namespace", metadata: { name: NS, labels: { ...provisioned } } });
    const planned = await diff(small(), session, { environmentId: ENV_ID });
    expect(planned.find((d) => d.ref.kind === "Namespace")).toMatchObject({ action: "none", changedPaths: [] });
    expect(patches().map((x) => x.body.kind)).not.toContain("Namespace");
    const r = await serverSideApply(small(), session, { environmentId: ENV_ID });
    expect(r.ok).toBe(true);
    expect(r.results.map((x) => `${x.ref.kind}:${x.status}`)).toEqual(["Namespace:unchanged", "NetworkPolicy:created", "Service:created", "Deployment:created"]);
    expect(patches().map((x) => x.body.kind)).not.toContain("Namespace");
    expect((fake.get("Namespace", undefined, NS) as any).metadata.labels).toEqual(provisioned);
  });

  it("still refuses a provisioned Namespace that is off the allowlist or enforces no Pod Security baseline", async () => {
    fake.seed({ apiVersion: "v1", kind: "Namespace", metadata: { name: NS, labels: { "pod-security.kubernetes.io/enforce": "privileged" } } });
    const weak = await serverSideApply(small(), await sessionFor(fake, [NS]), { environmentId: ENV_ID });
    expect(weak.results.find((x) => x.ref.kind === "Namespace")).toMatchObject({ status: "ownership_conflict", message: expect.stringMatching(/does not enforce Pod Security baseline/) });
    (fake.get("Namespace", undefined, NS) as any).metadata.labels["pod-security.kubernetes.io/enforce"] = "restricted";
    const off = await serverSideApply(small(), await sessionFor(fake, []), { environmentId: ENV_ID });
    expect(off.refused).toBe(true);
    expect(off.results.find((x) => x.ref.kind === "Namespace")?.status).toBe("ownership_conflict");
    expect(fake.writes()).toHaveLength(0);
  });

  it("scopes deny policies in a provisioned namespace to this environment's pods, and keeps all-pod deny where Zenith owns it", () => {
    const deny = (objects: K8sObject[]) => objects.find((o) => o.kind === "NetworkPolicy") as any;
    expect(deny(renderGraph([networkNode(), serviceNode()], ctx).objects).spec.podSelector).toEqual({});
    const scoped = deny(renderGraph([networkNode(), serviceNode()], { ...ctx, provisionedNamespaces: [NS] }).objects).spec.podSelector;
    expect(scoped).toEqual({ matchLabels: { "app.kubernetes.io/part-of": expect.any(String) } });
    const pod = (find(small(), "Deployment") as any).spec.template.metadata.labels;
    expect(pod["app.kubernetes.io/part-of"]).toBe(scoped.matchLabels["app.kubernetes.io/part-of"]);
  });

  it("names a provisioned namespace's policies per environment, so two environments sharing it never collide", () => {
    const names = (environmentId: string, provisioned: boolean) => renderGraph([networkNode(), serviceNode()], { ...ctx, environmentId, ...(provisioned ? { provisionedNamespaces: [NS] } : {}) })
      .objects.filter((o) => o.kind === "NetworkPolicy" && o.metadata.namespace === NS).map((o) => o.metadata.name);
    const a = names(ENV_ID, true), b = names(OTHER_ENV, true);
    expect(a.length).toBeGreaterThan(0);
    expect(a.filter((name) => b.includes(name))).toEqual([]);
    expect(names(ENV_ID, true)).toEqual(a); // deterministic
    expect(names(ENV_ID, false)).toContain("zenith-default-deny-ingress"); // a Zenith-owned namespace keeps its stable names
  });

  it("never treats another environment's namespace or a system namespace as provisioned", async () => {
    fake.seed({ apiVersion: "v1", kind: "Namespace", metadata: { name: NS, labels: { "app.kubernetes.io/managed-by": "zenith", "pod-security.kubernetes.io/enforce": "baseline" }, annotations: { [ANNOTATION.environment]: OTHER_ENV } } });
    const foreign = await serverSideApply(small(), await sessionFor(fake, [NS]), { environmentId: ENV_ID });
    expect(foreign.results.find((x) => x.ref.kind === "Namespace")).toMatchObject({ status: "ownership_conflict", message: expect.stringMatching(/never modifies or adopts/) });
    fake.seed({ apiVersion: "v1", kind: "Namespace", metadata: { name: "kube-system", labels: { "pod-security.kubernetes.io/enforce": "baseline" } } });
    const system = await serverSideApply(renderGraph([{ ...networkNode(), spec: { zones: 1, namespace: "kube-system" } }], ctx).objects, await sessionFor(fake, ["kube-system"]), { environmentId: ENV_ID });
    expect(system.results.find((x) => x.ref.kind === "Namespace")?.status).toBe("ownership_conflict");
    expect(fake.writes()).toHaveLength(0);
  });

  it("re-applies its own objects (owned, same environment) without complaint", async () => {
    const session = await sessionFor(fake, []);
    await serverSideApply(small(), session, { environmentId: ENV_ID });
    const r = await serverSideApply(small(), session, { environmentId: ENV_ID });
    expect(r.ok).toBe(true);
  });

  it("refuses to write into a terminating object", async () => {
    const session = await sessionFor(fake, []);
    await serverSideApply(small(), session, { environmentId: ENV_ID });
    fake.foreignUpdate("Deployment", NS, "web", "gc", { metadata: { deletionTimestamp: "2026-01-01T00:00:00Z" } });
    const r = await serverSideApply(small(), session, { environmentId: ENV_ID });
    expect(r.refused).toBe(true);
    expect(r.results.find((x) => x.ref.kind === "Deployment")?.message).toMatch(/being deleted/);
  });
});

describe("field-manager conflicts", () => {
  it("reports a conflict with the other manager and field, and never forces", async () => {
    const session = await sessionFor(fake, []);
    await serverSideApply(small(), session, { environmentId: ENV_ID });
    fake.foreignUpdate("Deployment", NS, "web", "kubectl-edit", { spec: { replicas: 7 } });
    const before = patches().length;
    const r = await serverSideApply(small({ replicas: 3 }), session, { environmentId: ENV_ID });
    expect(r.ok).toBe(false);
    const c = r.results.find((x) => x.status === "conflict");
    expect(c?.ref.kind).toBe("Deployment");
    expect(c?.conflicts).toEqual([{ field: ".spec.replicas", manager: "kubectl-edit" }]);
    expect(c?.message).toMatch(/kubectl-edit/);
    expect(c?.message).toMatch(/does not force/);
    expect((fake.get("Deployment", NS, "web") as any).spec.replicas).toBe(7);
    for (const p of patches().slice(before)) expect(p.query.force).toBe("false");
    expect(patches().slice(before).some((p) => p.query.force === "true")).toBe(false);
  });

  it("does not conflict when the other manager holds the same value (co-ownership)", async () => {
    const session = await sessionFor(fake, []);
    await serverSideApply(small(), session, { environmentId: ENV_ID });
    fake.foreignUpdate("Deployment", NS, "web", "kubectl-edit", { spec: { replicas: 3 } });
    const r = await serverSideApply(small({ replicas: 3 }), session, { environmentId: ENV_ID });
    expect(r.results.find((x) => x.ref.kind === "Deployment")?.status).not.toBe("conflict");
  });
});

describe("secrets", () => {
  const graph = () => renderGraph([networkNode(), secretNode(), serviceNode()], ctx).objects;

  it("merges the resolved value into the request body only, and reveals it nowhere else", async () => {
    const session = await sessionFor(fake, []);
    const logs: string[] = [];
    const r = await serverSideApply(graph(), session, { environmentId: ENV_ID, resolveSecret: resolver(), log: (l) => logs.push(l) });
    expect(r.ok).toBe(true);
    const sent = patches().find((p) => p.body.kind === "Secret");
    expect(sent?.body.data).toEqual({ value: Buffer.from(SECRET_CANARY).toString("base64") });
    const exposed = JSON.stringify({ r, logs });
    expect(exposed).not.toContain(SECRET_CANARY);
    expect(exposed).not.toContain(Buffer.from(SECRET_CANARY).toString("base64"));
    // the rendered input was never mutated
    expect(find(graph(), "Secret").data).toBeUndefined();
  });

  it("refuses the whole batch when a Secret cannot be resolved, before writing anything", async () => {
    const session = await sessionFor(fake, []);
    const none = await serverSideApply(graph(), session, { environmentId: ENV_ID });
    expect(none.refused).toBe(true);
    expect(none.results.find((x) => x.ref.kind === "Secret")?.errorCode).toBe("secret_unresolved");
    const unresolved = await serverSideApply(graph(), session, { environmentId: ENV_ID, resolveSecret: async () => null });
    expect(unresolved.refused).toBe(true);
    expect(unresolved.results.find((x) => x.ref.kind === "Secret")?.message).toMatch(/could not be resolved/);
    expect(fake.writes()).toHaveLength(0);
  });

  it("scrubs the value out of an error the API echoes back", async () => {
    const session = await sessionFor(fake, []);
    fake.inject({ match: (r) => r.method === "PATCH" && r.path.includes("/secrets/"), status: 500, message: `write failed for data ${SECRET_CANARY}`, times: 1 });
    const r = await serverSideApply(graph(), session, { environmentId: ENV_ID, resolveSecret: resolver() });
    expect(r.ok).toBe(false);
    expect(JSON.stringify(r)).not.toContain(SECRET_CANARY);
    expect(r.results.find((x) => x.status === "error")?.message).toContain("[redacted]");
  });

  it("re-applies a changed secret value as `configured`, and an unchanged one as `unchanged`", async () => {
    const session = await sessionFor(fake, []);
    await serverSideApply(graph(), session, { environmentId: ENV_ID, resolveSecret: resolver() });
    const same = await serverSideApply(graph(), session, { environmentId: ENV_ID, resolveSecret: resolver() });
    expect(same.results.find((x) => x.ref.kind === "Secret")?.status).toBe("unchanged");
    const rotated = await serverSideApply(graph(), session, { environmentId: ENV_ID, resolveSecret: resolver({ "vault:proj1/svc1/STRIPE_KEY": "rotated-value-0002" }) });
    expect(rotated.results.find((x) => x.ref.kind === "Secret")?.status).toBe("configured");
    expect(JSON.stringify(rotated)).not.toContain("rotated-value-0002");
  });

  it("resolves a data store's generated credential reference the same way", async () => {
    const session = await sessionFor(fake, []);
    const { objects } = renderGraph([networkNode(), dbNode()], ctx);
    const asked: string[] = [];
    const r = await serverSideApply(objects, session, {
      environmentId: ENV_ID,
      resolveSecret: async (ref) => {
        asked.push(ref);
        return "generated-db-password-0003";
      },
    });
    expect(r.ok).toBe(true);
    expect(asked).toEqual([`vault:generated/${ENV_ID}/resource/db/password`]);
    expect(JSON.stringify(r)).not.toContain("generated-db-password-0003");
  });
});

describe("namespace allowlist", () => {
  it("refuses objects in a namespace that is neither allowlisted nor created by the same batch", async () => {
    const session = await sessionFor(fake, ["elsewhere"]);
    const objects = small().filter((o) => o.kind !== "Namespace");
    const r = await serverSideApply(objects, session, { environmentId: ENV_ID });
    expect(r.refused).toBe(true);
    expect(r.results.filter((x) => x.errorCode === "not_found" || x.errorCode === "namespace_forbidden")).toHaveLength(3);
    expect(fake.writes()).toHaveLength(0);
  });

  it("allows an allowlisted namespace and a namespace the batch itself creates", async () => {
    expect((await serverSideApply(small(), await sessionFor(fake, []), { environmentId: ENV_ID })).ok).toBe(true);
    const f2 = await startFakeK8s();
    try {
      f2.seed({ apiVersion: "v1", kind: "Namespace", metadata: { name: NS, labels: { "app.kubernetes.io/managed-by": "zenith" }, annotations: { [ANNOTATION.environment]: ENV_ID, [ANNOTATION.resource]: "network/main" } } });
      const r = await serverSideApply(small().filter((o) => o.kind !== "Namespace"), await sessionFor(f2, [NS]), { environmentId: ENV_ID });
      expect(r.ok).toBe(true);
    } finally {
      await f2.close();
    }
  });
});

describe("dry run and diff", () => {
  it("dry-run applies nothing and reports what would be created", async () => {
    const session = await sessionFor(fake, []);
    const r = await serverSideApply(small(), session, { environmentId: ENV_ID, dryRun: true });
    expect(r.dryRun).toBe(true);
    expect(r.results.map((x) => x.status)).toEqual(["created", "created", "created", "created"]);
    for (const p of patches()) expect(p.query.dryRun).toBe("All");
    expect(fake.list("Deployment")).toHaveLength(0);
  });

  it("diff reports creates, then nothing, then the exact changed paths", async () => {
    const session = await sessionFor(fake, []);
    const created = await diff(small(), session, { environmentId: ENV_ID });
    expect(created.map((d) => d.action)).toEqual(["create", "create", "create", "create"]);

    await serverSideApply(small(), session, { environmentId: ENV_ID });
    const none = await diff(small(), session, { environmentId: ENV_ID });
    expect(none.map((d) => d.action)).toEqual(["none", "none", "none", "none"]);

    const changed = await diff(small({ replicas: 6, artifact: { type: "image", ref: "ghcr.io/acme/web:9" } }), session, { environmentId: ENV_ID });
    const dep = changed.find((d) => d.ref.kind === "Deployment")!;
    expect(dep.action).toBe("update");
    expect(dep.changedPaths).toContain("spec.replicas");
    expect(dep.changedPaths).toContain("spec.template.spec.containers[name=app].image");
    expect(dep.changedPaths.some((p) => p.startsWith("metadata.annotations"))).toBe(true); // spec-digest moved with the spec
    expect(fake.get("Deployment", NS, "web")).toMatchObject({ spec: { replicas: 2 } });
  });

  it("diff reports ownership conflicts and field conflicts as such, without values", async () => {
    const session = await sessionFor(fake, []);
    fake.seed({ apiVersion: "v1", kind: "Service", metadata: { name: "web", namespace: NS }, spec: { ports: [{ port: 1, targetPort: 1 }] } });
    const d1 = await diff(small(), session, { environmentId: ENV_ID });
    expect(d1.find((d) => d.ref.kind === "Service")?.action).toBe("ownership_conflict");
    expect(d1.filter((d) => d.action === "error")).toHaveLength(3); // skipped siblings
  });

  it("diff shows a rotated secret as a changed path, never its value", async () => {
    const session = await sessionFor(fake, []);
    const objs = renderGraph([networkNode(), secretNode()], ctx).objects;
    await serverSideApply(objs, session, { environmentId: ENV_ID, resolveSecret: resolver() });
    const same = await diff(objs, session, { environmentId: ENV_ID, resolveSecret: resolver() });
    expect(same.find((d) => d.ref.kind === "Secret")?.action).toBe("none");
    const rotated = await diff(objs, session, { environmentId: ENV_ID, resolveSecret: resolver({ "vault:proj1/svc1/STRIPE_KEY": "rotated-value-0004" }) });
    const s = rotated.find((d) => d.ref.kind === "Secret")!;
    expect(s.action).toBe("update");
    expect(s.changedPaths).toEqual(["data.value"]);
    expect(JSON.stringify(rotated)).not.toContain("rotated-value-0004");
    expect(JSON.stringify(rotated)).not.toContain(SECRET_CANARY);
    // only the initial apply (namespace + default-deny + secret) wrote; every diff request was a dry run
    expect(patches().filter((p) => p.query.dryRun !== "All")).toHaveLength(3);
  });
});
