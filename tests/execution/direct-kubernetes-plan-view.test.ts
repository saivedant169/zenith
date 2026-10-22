/** A Kubernetes in-place update must stay reviewable: the approval projection requires a boolean forcesReplacement. */
import { describe, expect, it } from "vitest";
import { kubernetesPlanChanges } from "@/lib/execution/direct-kubernetes";
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
});
