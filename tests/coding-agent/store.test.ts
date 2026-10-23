/**
 * `platform.coding_agent_runs` (migration 36) on the real platform store
 * (PGlite always; real PostgreSQL when ZENITH_TEST_PLATFORM_PG_URL is set):
 * tenant filter on every function, version compare-and-set, only a running row
 * takes progress, one resume claim, stale-worker recovery, checkpoint size cap.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { bindRepos } from "@/lib/controlplane/db/repos";
import { LANES, openLane } from "../controlplane/_support/harness";

const base = (id: string, workspaceId: string) => ({
  id,
  workspaceId,
  projectId: "proj_1",
  environmentId: "env_1",
  createdBy: "user_1",
  model: "claude-sonnet-5-5",
  task: "Propose a staging deployment.",
  source: { repository: "acme/shop", commit: "a".repeat(40) },
  limits: { toolCalls: 40 },
  usage: { toolCalls: 0 },
  checkpoint: { version: 1, messages: [] },
  workflowId: `car-${id}`,
});

describe.each(LANES)("coding_agent_runs on $name", (lane) => {
  let repos: ReturnType<typeof bindRepos>["codingAgentRuns"];
  let sql: Awaited<ReturnType<typeof openLane>>["db"];
  let close: () => Promise<void>;
  const ws = `ws_${randomUUID()}`;
  const other = `ws_${randomUUID()}`;

  beforeAll(async () => {
    const opened = await openLane(lane);
    sql = opened.db;
    close = opened.close;
    repos = bindRepos(sql).codingAgentRuns;
  });
  afterAll(async () => close());

  it("creates running, reads back, lists newest first and hides rows from other workspaces", async () => {
    const id = `car_${randomUUID()}`;
    const row = await repos.createRun(base(id, ws));
    expect(row).toMatchObject({ id, workspaceId: ws, status: "running", version: 1, projectId: "proj_1" });
    expect((await repos.getRun(ws, id))?.checkpoint).toEqual({ version: 1, messages: [] });
    // Stored as jsonb objects, not JSON-encoded strings: postgres.js types a bare $n::jsonb parameter and would encode a
    // JSON.stringify'd value a second time (PGlite does not), which only a typed read like this catches.
    expect(await sql.query("select jsonb_typeof(limits) as l, jsonb_typeof(checkpoint) as c from platform.coding_agent_runs where id = $1", [id])).toEqual([{ l: "object", c: "object" }]);
    expect(await repos.getRun(other, id)).toBeNull();
    expect((await repos.listRuns(ws, 100)).map((r) => r.id)).toContain(id);
    expect((await repos.listRuns(other, 100)).map((r) => r.id)).not.toContain(id);
  });

  it("progress is compare-and-set on version and only for a running row; foreign writes see not_found", async () => {
    const id = `car_${randomUUID()}`;
    await repos.createRun(base(id, ws));
    const save = (workspaceId: string, expectedVersion: number, status: "running" | "budget_exhausted" | "completed" | "failed") =>
      repos.saveRun({ workspaceId, id, expectedVersion, status, ...(status === "budget_exhausted" ? { stopReason: { kind: "budget", dimension: "toolCalls" } } : {}), limits: { toolCalls: 40 }, usage: { toolCalls: 3 }, checkpoint: { version: 1, messages: [], steps: 1 } });
    const v2 = await save(ws, 1, "running");
    expect(v2.version).toBe(2);
    await expect(save(ws, 1, "running")).rejects.toMatchObject({ code: "conflict" });
    await expect(save(other, 2, "running")).rejects.toMatchObject({ code: "not_found" });
    const stopped = await save(ws, 2, "budget_exhausted");
    expect(stopped).toMatchObject({ status: "budget_exhausted", stopReason: { kind: "budget", dimension: "toolCalls" }, usage: { toolCalls: 3 } });
    // a stopped row takes no more progress
    await expect(save(ws, stopped.version, "running")).rejects.toMatchObject({ code: "conflict" });
  });

  it("a stopped run is claimed for resume exactly once, with the limits it is given", async () => {
    const id = `car_${randomUUID()}`;
    await repos.createRun(base(id, ws));
    await expect(repos.claimResume({ workspaceId: ws, id, limits: { toolCalls: 80 }, workflowId: "wf_2" })).rejects.toMatchObject({ code: "invalid_state" });
    const stopped = await repos.saveRun({ workspaceId: ws, id, expectedVersion: 1, status: "budget_exhausted", stopReason: { kind: "budget", dimension: "toolCalls" }, limits: { toolCalls: 40 }, usage: {}, checkpoint: { version: 1, messages: [] } });
    const results = await Promise.allSettled([repos.claimResume({ workspaceId: ws, id, limits: { toolCalls: 80 }, workflowId: "wf_2" }), repos.claimResume({ workspaceId: ws, id, limits: { toolCalls: 90 }, workflowId: "wf_3" })]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const claimed = await repos.getRun(ws, id);
    expect(claimed).toMatchObject({ status: "running", version: stopped.version + 1 });
    expect(claimed?.stopReason).toBeUndefined();
    expect(claimed?.workflowId).toMatch(/^wf_[23]$/);
    await expect(repos.claimResume({ workspaceId: other, id, limits: {}, workflowId: "wf_x" })).rejects.toMatchObject({ code: "not_found" });
  });

  it("recovers a crashed worker: a running row untouched for ten minutes can be claimed, a fresh one cannot", async () => {
    const id = `car_${randomUUID()}`;
    await repos.createRun(base(id, ws));
    await expect(repos.claimResume({ workspaceId: ws, id, limits: {}, workflowId: "wf_x" })).rejects.toMatchObject({ code: "invalid_state" });
    await sql.query("update platform.coding_agent_runs set updated_at = clock_timestamp() - interval '11 minutes' where id = $1", [id]);
    expect((await repos.claimResume({ workspaceId: ws, id, limits: { toolCalls: 40 }, workflowId: "wf_y" })).status).toBe("running");
  });

  it("attaches the proposal link and result once, only after the run has stopped", async () => {
    const id = `car_${randomUUID()}`;
    await repos.createRun(base(id, ws));
    await expect(repos.attachOutcome({ workspaceId: ws, id, proposalOperationId: "op_1" })).rejects.toMatchObject({ code: "not_found" });
    await repos.saveRun({ workspaceId: ws, id, expectedVersion: 1, status: "completed", limits: {}, usage: {}, checkpoint: { version: 1, messages: [] } });
    const first = await repos.attachOutcome({ workspaceId: ws, id, result: { artifact: { manifestDigest: "m1" } }, proposalOperationId: "op_1" });
    expect(first).toMatchObject({ proposalOperationId: "op_1", result: { artifact: { manifestDigest: "m1" } } });
    const second = await repos.attachOutcome({ workspaceId: ws, id, result: { artifact: { manifestDigest: "m2" } }, proposalOperationId: "op_2" });
    expect(second).toMatchObject({ proposalOperationId: "op_1", result: { artifact: { manifestDigest: "m1" } } });
    await expect(repos.attachOutcome({ workspaceId: other, id, proposalOperationId: "op_x" })).rejects.toMatchObject({ code: "not_found" });
  });

  it("cancel makes any non-terminal row cancelled once, tenant scoped; a finished row cannot be cancelled", async () => {
    const id = `car_${randomUUID()}`;
    await repos.createRun(base(id, ws));
    await expect(repos.cancelRun({ workspaceId: other, id })).rejects.toMatchObject({ code: "not_found" });
    const cancelled = await repos.cancelRun({ workspaceId: ws, id });
    expect(cancelled).toMatchObject({ status: "cancelled", stopReason: { kind: "cancelled" } });
    await expect(repos.cancelRun({ workspaceId: ws, id })).rejects.toMatchObject({ code: "invalid_state" });
    // a worker that still holds the old version can no longer write
    await expect(repos.saveRun({ workspaceId: ws, id, expectedVersion: 1, status: "running", limits: {}, usage: {}, checkpoint: { version: 1, messages: [] } })).rejects.toMatchObject({ code: "conflict" });
  });

  it("failRun only moves a running row, scoped to the workspace", async () => {
    const id = `car_${randomUUID()}`;
    await repos.createRun(base(id, ws));
    expect(await repos.failRun({ workspaceId: other, id, stopReason: { kind: "provider_error", detail: "x" } })).toBeNull();
    expect((await repos.failRun({ workspaceId: ws, id, stopReason: { kind: "provider_error", detail: "step_failed" } }))?.status).toBe("failed");
    expect(await repos.failRun({ workspaceId: ws, id, stopReason: { kind: "provider_error", detail: "again" } })).toBeNull();
  });

  it("refuses an invalid status and an oversized checkpoint at the database", async () => {
    const id = `car_${randomUUID()}`;
    await repos.createRun(base(id, ws));
    await expect(sql.query("update platform.coding_agent_runs set status = 'approved' where id = $1", [id])).rejects.toBeDefined();
    await expect(repos.saveRun({ workspaceId: ws, id, expectedVersion: 1, status: "running", limits: {}, usage: {}, checkpoint: { blob: "x".repeat(2_200_000) } })).rejects.toBeDefined();
  });
});
