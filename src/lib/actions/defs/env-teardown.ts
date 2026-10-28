/** Teardown changes infrastructure and always requires a browser human review. */
import { z } from "zod";
import { defineAction } from "@/lib/actions/core";
import { proposeTeardown, teardownPlan } from "@/lib/bridge/destroy";
import { requireEnvironment } from "./_shared";
import { environmentBusy, activityUnavailableMessage, teardownSettling } from "./env";
import { principalFromAction } from "@/lib/capabilities/action-bridge";
import { platformBroker } from "@/lib/capabilities/platform";
import { getDestroyReview, requestDestroyReview } from "@/lib/capabilities/destroy-review";
import { bridgeDeps } from "@/lib/bridge/deps";

const Input = z.object({ environmentId: z.string().min(1).max(200) }).strict();
const ReviewInput = Input.extend({ idempotencyKey: z.string().regex(/^[A-Za-z0-9_-]{8,100}$/), refresh: z.boolean().optional() });
defineAction<z.infer<typeof ReviewInput>>({
  id: "env.reviewTeardown", title: "Review teardown", category: "environment",
  risk: "low", requiredRole: "viewer", mutates: false, input: ReviewInput,
  async plan(ctx, input) {
    const env = requireEnvironment(ctx, input.environmentId);
    const busy = await environmentBusy(ctx, env.id);
    const blocked = busy ? (busy.status === "authority_unavailable" ? activityUnavailableMessage : "Wait for the environment's active deployment to finish.") : await teardownSettling(ctx, env);
    return { summary: `Review teardown of "${env.name}".`, details: ["Run a read-only destroy plan under observe credentials and record a proposal for separate human approval."],
      costDeltaUsd: 0, risk: "low", warnings: [], requiresApproval: false, ...(blocked ? { blocked } : {}) };
  },
  async execute(ctx, input) {
    const env = requireEnvironment(ctx, input.environmentId);
    const busy = await environmentBusy(ctx, env.id);
    if (busy) return { ok: false, summary: "Teardown review refused.", error: busy.status === "authority_unavailable" ? activityUnavailableMessage : "Wait for the environment's active deployment to finish." };
    const settling = await teardownSettling(ctx, env);
    if (settling) return { ok: false, summary: "Teardown review refused.", error: settling };
    const data = await requestDestroyReview(await platformBroker(), { workspaceId: ctx.workspaceId, projectId: env.projectId, environmentId: env.id },
      principalFromAction(ctx), { idempotencyKey: input.idempotencyKey, refresh: input.refresh }, "ui");
    return { ok: true, summary: "Read-only teardown review requested. Nothing was applied.", data };
  },
});
defineAction<z.infer<typeof Input>>({
  id: "env.teardown", title: "Tear down environment infrastructure", category: "environment",
  risk: "high", requiredRole: "admin", mutates: true, input: Input,
  async plan(ctx, input) {
    const env = requireEnvironment(ctx, input.environmentId);
    const plan = await teardownPlan(ctx, env);
    const busy = await environmentBusy(ctx, env.id);
    if (busy) plan.blocked = busy.status === "authority_unavailable" ? activityUnavailableMessage : "Wait for the environment's active deployment to finish before proposing teardown.";
    else { const settling = await teardownSettling(ctx, env); if (settling) plan.blocked = settling; }
    return plan;
  },
  async execute(ctx, input) {
    const env = requireEnvironment(ctx, input.environmentId);
    const busy = await environmentBusy(ctx, env.id);
    if (busy) return { ok: false, summary: "Teardown refused.", error: busy.status === "authority_unavailable" ? activityUnavailableMessage : "Wait for the environment's active deployment to finish." };
    const settling = await teardownSettling(ctx, env);
    if (settling) return { ok: false, summary: "Teardown refused.", error: settling };
    const broker = await bridgeDeps().broker();
    const existing = await getDestroyReview(broker, { workspaceId: ctx.workspaceId, projectId: env.projectId, environmentId: env.id }, principalFromAction(ctx));
    if (existing.review && ["approved", "queued", "running", "uncertain"].includes(existing.review.status)) {
      return { ok: false, summary: "Teardown refused.", error: "Inspect the current teardown review or operation before proposing another teardown." };
    }
    if (existing.review && "operation" in existing.review && existing.review.status === "awaiting_approval") {
      const plan = await teardownPlan(ctx, env);
      if (plan.blocked) return { ok: false, summary: "Teardown refused.", error: plan.blocked };
      return { ok: true, summary: "The current teardown review is already awaiting human approval.", data: { operationId: existing.review.operationId } };
    }
    return proposeTeardown(ctx, env);
  },
});
