/**
 * Recall of a capability grant revoked after the agent received its job (ADVERSARIAL-ACCEPTANCE residual, now closed).
 * The agent's next control-plane step, submitting the result, is refused unless the grant is still live.
 */
import { afterEach, describe, expect, it } from "vitest";
import type { GrantStatus } from "@/lib/controlplane/db/repos/grants";
import { POST as pollRunner } from "@/app/api/platform/v1/runners/[id]/poll/route";
import { POST as resultRunner } from "@/app/api/platform/v1/runners/[id]/jobs/[jti]/result/route";
import { POST as registerRunner } from "@/app/api/platform/v1/runners/register/route";
import { GET as grantRunner } from "@/app/api/platform/v1/runners/[id]/jobs/[jti]/grant/route";
import { FakeAgent, createPlane, enqueueProbeJob, registerFakeAgent, teardownPlane, type Plane } from "./_support";

afterEach(teardownPlane);

const ok = { status: "succeeded", startedAt: "2026-09-30T12:00:00Z", finishedAt: "2026-09-30T12:00:01Z", exitCode: 0, result: { open: true } };

/** Register a runner, queue one job and deliver it, as the agent would receive it. */
async function received(extra: Parameters<typeof createPlane>[1]): Promise<{ plane: Plane; runner: FakeAgent; id: string }> {
  const plane = await createPlane("fake", extra);
  const runner = await registerFakeAgent(plane, registerRunner);
  const id = await enqueueProbeJob(plane, runner);
  const jobs = (await runner.post(pollRunner, "/poll", { max: 1, waitSec: 0 })).body.jobs as string[];
  expect(jobs).toHaveLength(1);
  return { plane, runner, id };
}

const submit = (runner: FakeAgent, id: string) => runner.post(resultRunner, `/jobs/${id}/result`, ok, {}, { jti: id });

describe("recall: a grant revoked after receipt stops the agent's next step", () => {
  it("revoked after receipt: the result is refused with 403 and nothing is settled or completed", async () => {
    let status: GrantStatus = "active";
    const lookups: string[] = [];
    const { plane, runner, id } = await received({ grantStatus: async (workspaceId, jti) => { lookups.push(`${workspaceId}:${jti}`); return status; } });
    status = "revoked";
    const res = await submit(runner, id);
    expect(res.status).toBe(403);
    expect(res.body.error).toMatchObject({ code: "grant_not_active" });
    expect((await plane.store.jobs.get("w-a", id))?.status).not.toBe("succeeded");
    expect(plane.events.filter((e) => e.type === "runner.job.completed")).toEqual([]);
    expect(lookups.length).toBeGreaterThan(0);
    expect(lookups.every((l) => l.startsWith("w-a:"))).toBe(true);
  });

  it("an active grant proceeds: the result is accepted", async () => {
    const { runner, id } = await received({ grantStatus: async () => "active" });
    expect(await submit(runner, id)).toMatchObject({ status: 200, body: { status: "accepted" } });
  });

  it("refuses every status but active and consumed: expired, unknown and revoked are all refused", async () => {
    for (const status of ["revoked", "expired", "unknown"] as const) {
      const { runner, id } = await received({ grantStatus: async () => status });
      expect(await submit(runner, id), status).toMatchObject({ status: 403, body: { error: { code: "grant_not_active" } } });
      teardownPlane();
    }
  });

  it("consumed is the grant's own one-time use and proceeds", async () => {
    const { runner, id } = await received({ grantStatus: async () => "consumed" });
    expect((await submit(runner, id)).status).toBe(200);
  });

  it("without a status source it falls back to the revocation hook, and with neither there is no recall source", async () => {
    let revoked = false;
    const hooked = await received({ grantRevoked: async () => revoked });
    revoked = true;
    expect((await submit(hooked.runner, hooked.id)).status).toBe(403);
    teardownPlane();
    const none = await received({});
    expect((await submit(none.runner, none.id)).status).toBe(200);
  });
});

describe("the agent's pre-step check: a multi-step job asks before each step", () => {
  const check = (runner: FakeAgent, id: string) => runner.get(grantRunner, `/jobs/${id}/grant`, {}, { jti: id });

  it("a live grant answers live", async () => {
    const { runner, id } = await received({ grantStatus: async () => "active" });
    expect(await check(runner, id)).toMatchObject({ status: 200, body: { live: true } });
  });

  it("a revoked, expired or unknown grant answers 403 grant_not_active; consumed stays live", async () => {
    for (const status of ["revoked", "expired", "unknown"] as const) {
      const { runner, id } = await received({ grantStatus: async () => status });
      expect(await check(runner, id), status).toMatchObject({ status: 403, body: { error: { code: "grant_not_active" } } });
      teardownPlane();
    }
    const consumed = await received({ grantStatus: async () => "consumed" });
    expect((await check(consumed.runner, consumed.id)).status).toBe(200);
  });

  it("a grant recalled between two checks is refused at the second", async () => {
    let status: GrantStatus = "active";
    const { runner, id } = await received({ grantStatus: async () => status });
    expect((await check(runner, id)).status).toBe(200);
    status = "revoked";
    expect(await check(runner, id)).toMatchObject({ status: 403, body: { error: { code: "grant_not_active" } } });
  });

  it("answers only for the agent's own job", async () => {
    const { plane, id } = await received({ grantStatus: async () => "active" });
    const other = await registerFakeAgent(plane, registerRunner);
    expect((await check(other, id)).status).toBe(404);
  });
});
