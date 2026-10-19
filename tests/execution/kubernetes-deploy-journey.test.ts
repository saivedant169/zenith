/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * A `kubernetes`-provider environment deploys through the default journey
 * (PROD-LIFE-07): the same plan / policy / approval / final plan / apply
 * activities the workflow calls, with the Kubernetes apply stage behind them.
 * Cluster side: tests/providers/kubernetes/fake-api.ts (contract evidence only;
 * lifecycle-acceptance.test.ts runs the same journey on a real cluster).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SemanticsChangedError } from "@/lib/execution/semantics/errors";
import { TofuPlanChangedError, StepFailedError } from "@/lib/execution/errors";
import { startFakeK8s, type FakeK8s } from "../providers/kubernetes/fake-api";
import { claimOf, ledgerPod, stsConfig } from "../providers/kubernetes/lifecycle-support";
import { sessionFor } from "../providers/kubernetes/helpers";
import { startJourney, type Journey } from "./kubernetes-journey-support";
import { ENV } from "./fakes/fixtures";

const NS = "journey";
const WEB_A = `registry.example.com/acme/web@sha256:${"a".repeat(64)}`;
const WEB_B = `registry.example.com/acme/web@sha256:${"b".repeat(64)}`;

let fake: FakeK8s;
let journey: Journey | undefined;
beforeEach(async () => {
  fake = await startFakeK8s();
});
afterEach(async () => {
  await journey?.releaseLease();
  journey = undefined;
  vi.restoreAllMocks();
  await fake.close();
});

const begin = async (webImage: string | undefined = WEB_A) => {
  journey = await startJourney({ session: await sessionFor(fake, []), namespace: NS, webImage, sts: stsConfig({ namespace: NS, replicas: 1 }) });
  return journey;
};
/** requests that changed the cluster: a server-side dry-run is a PATCH too, but it writes nothing */
const realWrites = () => fake.writes().filter((r) => r.query.dryRun !== "All");
const ownedBy = (kind: string, name: string) => fake.get(kind, NS, name) as any;

describe("deploying a kubernetes environment through the default journey", () => {
  it("validates, plans, passes policy, re-plans unchanged, applies, releases and verifies", async () => {
    const j = await begin();
    const validation = await j.validate();
    expect(validation.problems).toEqual([]);
    expect(validation.nodes).toBeGreaterThan(3);

    const plan = await j.plan();
    expect(plan).toMatchObject({ delete: 0, replace: 0, empty: false, destroysData: false });
    expect(plan.create).toBeGreaterThan(4);
    expect(plan.planDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(realWrites()).toEqual([]); // planning writes nothing
    const row = j.w.evidence.rows.find((e) => e.kind === "tofu_plan" && e.digest === plan.planDigest)!;
    expect(row.summary).toMatchObject({ engine: "kubernetes-apply", planDigest: plan.planDigest, destroysData: false });
    expect(row.summary.semantics).toMatchObject({ digest: expect.stringMatching(/^[a-f0-9]{64}$/) });
    expect(await j.w.deps.semantics!.get(j.w.product.base.workspace.id, j.operationId, plan.planDigest)).toBeDefined();
    expect((await j.w.ops.get(j.operationId))?.planDigest).toBe(plan.planDigest);

    expect((await j.policy(plan.planDigest)).outcome).toBe("allow");
    j.approve();
    const final = await j.finalPlan(plan.planDigest);
    expect(final.planDigest).toBe(plan.planDigest);
    expect(realWrites()).toEqual([]);

    const applied = await j.apply(plan.planDigest);
    expect(applied.applied).toBe(plan.create + plan.update);
    expect(applied.outputsDigest).toMatch(/^[0-9a-f]{64}$/);
    for (const [kind, name] of [["Namespace", ""], ["Deployment", "web"], ["StatefulSet", "ledger"], ["CronJob", "nightly"], ["Service", "ledger"]] as const) {
      expect(fake.get(kind, kind === "Namespace" ? undefined : NS, kind === "Namespace" ? NS : name), `${kind}/${name}`).toBeDefined();
    }
    expect(ownedBy("Deployment", "web").spec.template.spec.containers[0].image).toBe(WEB_A);
    expect(ownedBy("StatefulSet", "ledger").spec.persistentVolumeClaimRetentionPolicy).toEqual({ whenDeleted: "Retain", whenScaled: "Retain" });
    // Secrets carry values and are written by secret delivery, never by this apply
    expect(fake.list("Secret", NS)).toEqual([]);
    expect(j.w.evidence.rows.some((e) => e.kind === "tofu_apply" && e.summary.planDigest === plan.planDigest)).toBe(true);
    expect(j.w.events.events.map((e: any) => e.type)).toEqual(expect.arrayContaining(["resource.planned", "resource.applying", "resource.applied"]));
    expect([...j.w.resources.rows.values()].filter((r) => r.status === "active").length).toBeGreaterThan(3);

    // release: a literal image artifact keeps the exact manifest pin through the release ports
    const deployed = await j.deploy([{ service: "container_service/web", imageUri: WEB_A, digest: `sha256:${"a".repeat(64)}` }]);
    expect(deployed.services).toBeGreaterThan(0);
    expect(ownedBy("Deployment", "web").spec.template.spec.containers[0].image).toBe(WEB_A);

    // readback: the claim and pod the StatefulSet controller would have made
    const claim = claimOf("data-ledger-0", "Bound", { env: ENV }) as any;
    claim.metadata.namespace = NS;
    fake.seed(claim);
    fake.setStatus("PersistentVolumeClaim", NS, "data-ledger-0", { phase: "Bound" });
    const pod = ledgerPod(0, true, {}, ENV) as any;
    pod.metadata.namespace = NS;
    fake.seedPod(pod);
    const verified = await j.verify();
    expect(verified.failed).toBe(0);
    // These accounts hold only cloud log-group grants, which Kubernetes cannot render; the log groups are reported
    // as not verifiable instead of making every account's grants unknown.
    expect(verified.status).toBe("passed");
    const verification = j.w.evidence.rows.find((e) => e.kind === "verification")!.summary as any;
    expect(verification.unknown).toBe(0);
    expect(verification.nodes.filter((n: any) => n.status !== "passed")).toEqual([]);
    expect(verification.notVerifiable).toEqual(expect.arrayContaining(["log_group/nightly", "log_group/web"]));
  });

  it("reports configuration drift when a released pin differs from the literal manifest image", async () => {
    const j = await begin();
    const plan = await j.plan();
    await j.policy(plan.planDigest);
    j.approve();
    await j.apply(plan.planDigest);
    await j.deploy([{ service: "container_service/web", imageUri: WEB_B, digest: `sha256:${"b".repeat(64)}` }]);
    expect(ownedBy("Deployment", "web").spec.template.spec.containers[0].image).toBe(WEB_B);
    expect(await j.verify()).toMatchObject({ status: "failed" });
    const verification = j.w.evidence.rows.find((e) => e.kind === "verification")!.summary as any;
    expect(verification.nodes).toContainEqual({ address: "container_service/web", driver: "kubernetes.deployment@1", status: "failed", failed: ["configuration"], unknown: [] });
  });

  it.each(["final", "apply", "release"] as const)("refuses changed connection semantics before native %s dispatch", async (stage) => {
    const j = await begin();
    const plan = await j.plan();
    await j.policy(plan.planDigest);
    j.approve();
    if (stage === "release") await j.apply(plan.planDigest);
    const before = realWrites().length;
    const connection = j.w.connections.connections[0];
    if (connection.config.provider !== "aws") throw new Error("Unexpected scripted connection configuration.");
    connection.config = { ...connection.config, region: "us-west-2" };
    const attempt = stage === "final" ? j.finalPlan(plan.planDigest) : stage === "apply" ? j.apply(plan.planDigest)
      : j.deploy([{ service: "container_service/web", imageUri: WEB_B, digest: `sha256:${"b".repeat(64)}` }]);
    await expect(attempt).rejects.toBeInstanceOf(SemanticsChangedError);
    expect(realWrites().length).toBe(before);
    if (stage === "release") expect(ownedBy("Deployment", "web").spec.template.spec.containers[0].image).toBe(WEB_A);
    else expect(fake.get("Deployment", NS, "web")).toBeUndefined();
  });

  it("refuses a changed release script before native release writes", async () => {
    const j = await begin();
    const plan = await j.plan();
    await j.policy(plan.planDigest);
    j.approve();
    await j.apply(plan.planDigest);
    const before = realWrites().length;
    const manifest = j.w.product.revisions.get("rev-act-1")!.manifest as any;
    j.w.product.setManifest({ ...manifest, release: { migrate: { service: "web", command: ["node", "migrate.js"] } } });
    await expect(j.deploy([{ service: "container_service/web", imageUri: WEB_A, digest: `sha256:${"a".repeat(64)}` }]))
      .rejects.toMatchObject({ code: "semantics_changed", changed: expect.arrayContaining(["scripts"]) });
    expect(realWrites().length).toBe(before);
    expect(ownedBy("Deployment", "web").spec.template.spec.containers[0].image).toBe(WEB_A);
  });

  it("binds the plan digest to the live cluster: a plan that has already been applied is no longer the reviewed one", async () => {
    const j = await begin();
    const plan = await j.plan();
    await j.policy(plan.planDigest);
    j.approve();
    await j.apply(plan.planDigest);
    const before = realWrites().length;
    await expect(j.finalPlan(plan.planDigest)).rejects.toBeInstanceOf(TofuPlanChangedError);
    await expect(j.apply(plan.planDigest)).rejects.toBeInstanceOf(TofuPlanChangedError);
    expect(realWrites().length).toBe(before);
  });

  it("refuses the apply when the cluster moved between review and apply, and writes nothing", async () => {
    const j = await begin();
    const plan = await j.plan();
    await j.policy(plan.planDigest);
    j.approve();
    // someone created the namespace after the review: the reviewed plan said "create"
    fake.seed({ apiVersion: "v1", kind: "Namespace", metadata: { name: NS, labels: { "app.kubernetes.io/managed-by": "zenith" }, annotations: { "zenith.dev/environment": ENV, "zenith.dev/resource": "network/main" } } });
    const before = realWrites().length;
    await expect(j.apply(plan.planDigest)).rejects.toBeInstanceOf(TofuPlanChangedError);
    expect(realWrites().length).toBe(before);
    expect(fake.get("Deployment", NS, "web")).toBeUndefined();
  });

  it("refuses the apply without a current human approval, and writes nothing", async () => {
    const j = await begin();
    const plan = await j.plan();
    await j.policy(plan.planDigest);
    j.approve(false);
    const before = realWrites().length;
    await expect(j.apply(plan.planDigest)).rejects.toBeInstanceOf(StepFailedError);
    await expect(j.apply(plan.planDigest)).rejects.toThrow(/approval/);
    expect(realWrites().length).toBe(before);
  });

  it("refuses to plan over an object Zenith does not own, naming it, and never adopts it", async () => {
    fake.seed({ apiVersion: "v1", kind: "Namespace", metadata: { name: NS, labels: { "app.kubernetes.io/managed-by": "zenith" }, annotations: { "zenith.dev/environment": ENV, "zenith.dev/resource": "network/main" } } });
    fake.seed({ apiVersion: "apps/v1", kind: "Deployment", metadata: { name: "web", namespace: NS }, spec: { replicas: 1 } });
    const j = await begin();
    await expect(j.plan()).rejects.toThrow(/Deployment\/journey\/web.*does not own/);
    expect(realWrites()).toEqual([]);
    expect(ownedBy("Deployment", "web").metadata.labels?.["app.kubernetes.io/managed-by"]).toBeUndefined();
  });

  it("never deletes: a node removed from the manifest leaves its objects, and the review lists none as deleted", async () => {
    const j = await begin();
    const plan = await j.plan();
    await j.policy(plan.planDigest);
    j.approve();
    await j.apply(plan.planDigest);
    expect(plan.delete).toBe(0);
    // the next revision has no web service
    await j.releaseLease();
    const next = await begin(undefined);
    const replan = await next.plan();
    expect(replan.delete).toBe(0);
    expect(fake.get("Deployment", NS, "web")).toBeDefined();
  });

  it("plans from the cluster's own state, so a re-plan after a converged apply has nothing to do", async () => {
    const j = await begin();
    const first = await j.plan();
    await j.policy(first.planDigest);
    j.approve();
    await j.apply(first.planDigest);
    await j.releaseLease();
    const second = await begin();
    const converged = await second.plan();
    expect(converged).toMatchObject({ create: 0, update: 0, empty: true });
    expect(converged.planDigest).not.toBe(first.planDigest);
  });
});

describe("validation for kubernetes", () => {
  it("accepts the derived log group (Kubernetes realizes logs through the pods) and rejects a kind it cannot render", async () => {
    const j = await begin();
    const ok = await j.validate();
    expect(ok.problems).toEqual([]);
    j.w.product.setManifest({ ...(j.w.product.revisions.get("rev-act-1")!.manifest as any), resources: [{ id: "res-q", name: "jobs", kind: "queue", config: {}, size: "small", ownership: "managed" }] });
    const bad = await j.validate();
    expect(bad.problems.join("\n")).toMatch(/queue|native realization|cannot be rendered/);
  });
});

describe("the production dispatch re-check (PROD-DUR-03) for a kubernetes deploy", () => {
  it("records the reviewed semantics at plan, and apply and the release dispatch pass the guard chain", async () => {
    const j = await begin();
    const plan = await j.plan();
    const recorded = await (j.w.deps.semantics as { get(w: string, o: string, d: string): Promise<unknown> }).get("ws-act-1", j.operationId, plan.planDigest);
    expect(recorded).toBeDefined();
    await j.policy(plan.planDigest);
    j.approve();
    await j.finalPlan(plan.planDigest).catch(() => undefined); // fresh cluster: the digest is unchanged until applied
    await j.apply(plan.planDigest);
    await expect(j.deploy([{ service: "container_service/web", imageUri: WEB_B, digest: `sha256:${"b".repeat(64)}` }])).resolves.toMatchObject({ services: expect.any(Number) });
  });
});
