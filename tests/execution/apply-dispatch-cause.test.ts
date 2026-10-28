/**
 * An OpenTofu failure behind an unconfirmed plan dispatch keeps its fixed failure code on the uncertain operation
 * (src/lib/platform/plan-artifacts.ts wraps it; src/lib/execution/apply.ts records it). Kept apart from apply.test.ts,
 * whose bytes tests/ci/platform-coverage.test.ts pins.
 */
import { afterEach, describe, expect, it } from "vitest";
import { OP, bucketManifest } from "./fakes/fixtures";
import { createWorld, type World } from "./fakes/world";

const worlds: World[] = [];
afterEach(() => { while (worlds.length) worlds.pop()!.dispose(); });

describe("applyInfrastructure behind an unconfirmed plan dispatch", () => {
  it("keeps the OpenTofu failure code on the uncertain operation", async () => {
    const w = createWorld();
    worlds.push(w);
    w.product.setManifest(bucketManifest());
    w.broker.approval = { approved: true, rejected: false, approvalId: "isolated-reviewed-human-fixture" };
    await w.activities.markOperation({ operationId: OP, status: "running" });
    await w.activities.validateDesiredState({ operationId: OP });
    const lease = await w.lease();
    const plan = await w.activities.planInfrastructure({ operationId: OP, lease });
    w.tofu.apply = "dispatch_unconfirmed";
    await w.activities.applyInfrastructure({ operationId: OP, planDigest: plan.planDigest, lease }).catch(() => undefined);
    expect(w.ops.ops.get(OP)!.status).toBe("uncertain");
    expect(w.ops.uncertain[0]!.reason).toContain("; cause TofuCommandError/tofu_command_failed/apply:api_AccessDeniedException).");
  });
});
