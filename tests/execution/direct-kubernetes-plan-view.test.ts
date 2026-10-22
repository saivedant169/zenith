/** A Kubernetes in-place update must stay reviewable: the approval projection requires a boolean forcesReplacement. */
import { describe, expect, it } from "vitest";
import { kubernetesPlan, kubernetesPlanChanges } from "@/lib/execution/direct-kubernetes";
import { planEvidence } from "@/lib/execution/plan-evidence";
import { projectPlanReview } from "@/lib/controlplane/db/repos/operation-review";
import { boundedPlanView } from "@/lib/execution/plan-evidence";
import { ViewSchema } from "@/lib/controlplane/db/repos/operation-review";
import type { NormalizedPlan } from "@/lib/tofu/types";

describe("direct Kubernetes plan view", () => {
  it("projects an in-place image update as a reviewable plan", () => {
    const changes = kubernetesPlanChanges(["spec.template.spec.containers[name=app].image", "metadata.annotations"]);
    expect(changes.every((c) => c.forcesReplacement === false)).toBe(true);
    const plan = { tofuVersion: "kubernetes-apply/K1", formatVersion: "K1", configDigest: "c".repeat(64), lockDigest: "d".repeat(64), planDigest: "a".repeat(64),
      resourceChanges: [{ address: "Deployment/zenith-j2/witness", nodeAddress: "container_service/witness", type: "Deployment", providerName: "kubernetes", action: "update", changes, destroysData: false }],
      outputChanges: [], summary: { create: 0, update: 1, delete: 0, replace: 0, noop: 0 }, empty: false, diagnostics: [], createdAt: new Date(0).toISOString() } as unknown as NormalizedPlan;
    expect(ViewSchema.safeParse(boundedPlanView(plan)).success).toBe(true);
  });
  it("caps the listed changes at the review limit", () => {
    expect(kubernetesPlanChanges(Array.from({ length: 80 }, (_, i) => `data.k${i}`))).toHaveLength(50);
  });
  it("binds an approved private source into the plan and keeps its review projectable", () => {
    const base = { graphDigest: "c".repeat(64), objects: [{ kind: "Deployment" }], notes: [], createdAt: new Date(0).toISOString(),
      resourceChanges: [{ address: "Deployment/zenith-j2/witness", nodeAddress: "container_service/witness", type: "Deployment", providerName: "kubernetes", action: "create", changes: [], destroysData: false }] };
    const source = { serviceAddress: "container_service/witness", commitSha: "a".repeat(40), dockerfileDigest: "b".repeat(64), recipeDigest: "d".repeat(64), archiveDigest: "e".repeat(64), archiveFormat: "tar.gz" };
    const bound = kubernetesPlan({ ...base, executableSourceDigest: "f".repeat(64) });
    expect(bound.planDigest).not.toBe(kubernetesPlan(base).planDigest);
    const evidence = planEvidence({ plan: bound, facts: { create: 1, update: 0, delete: 0, replace: 0, destroysData: false, destroyedStatefulAddresses: [], regions: [], publicDatabases: [], openIngress: [], wildcardIam: [], identityChanges: [], firewallChanges: [], dnsChanges: [] } as never,
      cost: {}, graphDigest: base.graphDigest, stage: "plan", approvedSources: [source] as never });
    const review = projectPlanReview(evidence.summary, bound.planDigest);
    expect(review?.view.executableSourceDigest).toBe("f".repeat(64));
    expect(review?.view.approvedSources?.[0]?.commit).toBe(source.commitSha);
    // Without the bound digest the same approved source makes the review unreadable (the 500 seen in DRV-1).
    const unbound = planEvidence({ plan: kubernetesPlan(base), facts: evidence.summary.facts as never, cost: {}, graphDigest: base.graphDigest, stage: "plan", approvedSources: [source] as never });
    expect(projectPlanReview(unbound.summary, kubernetesPlan(base).planDigest)).toBeUndefined();
  });
});
