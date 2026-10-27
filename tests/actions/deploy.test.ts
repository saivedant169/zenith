import { describe, expect, it, beforeAll } from "vitest";
import type { ActionContext } from "@/lib/actions/core";
import type { Changeset, Deployment } from "@/lib/domain/types";
import { tempDataDir } from "../_support/data-dir";

tempDataDir("zenith-deploy-", { fast: true });
const { runAction } = await import("@/lib/actions/core");
const { resetDb, q } = await import("@/lib/db/store");
await import("@/lib/actions/defs");

const ctx: ActionContext = {
  workspaceId: "ws-test",
  actor: { type: "user", id: "you", name: "you" },
};

let projectId = "";
let environmentId = "";

async function exec(actionId: string, input: unknown, scope: Partial<ActionContext> = {}) {
  const { result } = await runAction(actionId, { ...ctx, ...scope }, input, { mode: "execute" });
  return result!;
}

/** The engine ticks every 250ms; wait for it rather than assuming a duration. */
async function settle(deploymentId: string, ms = 20_000): Promise<Deployment> {
  const deadline = Date.now() + ms;
  for (;;) {
    const d = q.deployment(deploymentId)!;
    if (["succeeded", "failed", "cancelled", "rolled_back"].includes(d.status)) return d;
    if (Date.now() > deadline) throw new Error(`deployment stuck in ${d.status}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

beforeAll(async () => {
  resetDb({
    workspaces: [{ id: "ws-test", name: "Test", slug: "test", createdAt: new Date().toISOString() }],
  });
  const created = await exec("project.applyBlueprint", { blueprint: "internal-tool", name: "Atlas" });
  expect(created.ok).toBe(true);
  const data = created.data as { projectId: string; environmentId: string };
  projectId = data.projectId;
  environmentId = data.environmentId;
});

describe("deploy.* actions", () => {
  it("plans read-only, against an environment that has never been deployed", async () => {
    const result = await exec("deploy.plan", {}, { projectId, environmentId });
    const { changeset } = result.data as { changeset: Changeset };
    expect(result.ok).toBe(true);
    expect(changeset.items.length).toBeGreaterThan(0);
    expect(changeset.items.every((i) => i.op === "create")).toBe(true);
    expect(changeset.projectedMonthlyUsd).toBeGreaterThan(0);
    expect(q.deploymentsOf(environmentId)).toHaveLength(0); // planning creates nothing
  });

  it("applies: snapshots a revision, runs the engine, ends with a live URL", async () => {
    const result = await exec("deploy.apply", {}, { projectId, environmentId });
    expect(result.ok).toBe(true);
    const { deploymentId, revisionNumber } = result.data as { deploymentId: string; revisionNumber: number };
    expect(revisionNumber).toBe(1);

    const done = await settle(deploymentId);
    expect(done.status).toBe("succeeded");
    expect(done.outputs.some((o) => o.kind === "url")).toBe(true);
    expect(q.environment(environmentId)!.deployedRevisionId).toBe(q.revision(done.revisionId)!.id);
  });

  it("refuses a second deploy with nothing to change, and says what to do", async () => {
    const result = await exec("deploy.apply", {}, { projectId, environmentId });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/ops\.restartService|Edit the system/);
  });

  it("blocks a deploy that would not validate, naming the fix", async () => {
    await exec("system.addService", { name: "broken", kind: "web", image: "x:1" }, { projectId });
    await exec("system.updateService", { serviceId: "broken", port: 8080 }, { projectId });
    // remove the port again to make it invalid
    const project = q.project(projectId)!;
    project.workingManifest.services.find((s) => s.name === "broken")!.port = undefined;

    const result = await exec("deploy.apply", {}, { projectId, environmentId });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/port/i);
    expect(result.error).toMatch(/Set the port/);
  });

  it("rolls back to the previous revision through the engine", async () => {
    const project = q.project(projectId)!;
    project.workingManifest.services = project.workingManifest.services.filter((s) => s.name !== "broken");
    await exec("ops.scaleService", { serviceId: "app", replicas: 2 }, { projectId });

    const second = await exec("deploy.apply", {}, { projectId, environmentId });
    expect(second.ok).toBe(true);
    await settle((second.data as { deploymentId: string }).deploymentId);

    const rolled = await exec("deploy.rollback", {}, { projectId, environmentId });
    expect(rolled.ok).toBe(true);
    const d = await settle((rolled.data as { deploymentId: string }).deploymentId);
    expect(["succeeded", "rolled_back"]).toContain(d.status);
    expect(q.revision(q.environment(environmentId)!.deployedRevisionId!)!.number).toBe(1);
  });
});

describe("deploy.apply on a V2 manifest", () => {
  it("does not call a functions-only system empty, and still refuses one with no nodes", async () => {
    const created = await exec("project.applyBlueprint", { blueprint: "internal-tool", name: "Fn" });
    const { projectId: pid, environmentId: eid } = created.data as { projectId: string; environmentId: string };
    const { parseEditableManifest } = await import("@/lib/actions/defs/_manifest");
    const parseManifest = (raw: unknown) => { const parsed = parseEditableManifest(raw); if (!parsed.ok) throw new Error(JSON.stringify(parsed.errors)); return parsed.manifest; };
    const project = q.project(pid)!;
    project.workingManifest = parseManifest({ version: 2, functions: [{
      id: "fn", name: "fn", kind: "function", provider: "aws", region: "us-east-1", runtime: "nodejs22.x", handler: "index.handler",
      source: { type: "s3", bucket: "b-123", key: "fn.zip", version: "3HL4kqtJlcpXroDTDmJ", sha256: "c".repeat(64), sourceDigest: "d".repeat(64) },
    }] });
    const withFunction = await exec("deploy.apply", {}, { projectId: pid, environmentId: eid });
    expect(withFunction.error ?? "").not.toMatch(/system is empty/);

    project.workingManifest = parseManifest({ version: 2 });
    const empty = await exec("deploy.apply", {}, { projectId: pid, environmentId: eid });
    expect(empty.ok).toBe(false);
    expect(empty.error).toMatch(/system is empty/);
  });
});
