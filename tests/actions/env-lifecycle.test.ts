/**
 * The environment and project lifecycle actions added for Settings: rename,
 * clone, re-point at another connection, delete, and delete the whole project.
 *
 * The property worth protecting is that a refusal is the same sentence in the
 * plan and in execute — the plan is what disables the confirm button, so if
 * they drift the button becomes a dead control again.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ActionContext } from "@/lib/actions/core";
import { emptyManifest, type CloudConnection, type Deployment } from "@/lib/domain/types";
import { tempDataDir } from "../_support/data-dir";

tempDataDir("zenith-envlife-", { fast: true });
const { runAction } = await import("@/lib/actions/core");
const { db, resetDb, q, save } = await import("@/lib/db/store");
await import("@/lib/actions/defs");

const ctx: ActionContext = {
  workspaceId: "ws-test",
  actor: { type: "user", id: "you", name: "you" },
};

async function exec(actionId: string, input: unknown, scope: Partial<ActionContext> = {}) {
  const { result } = await runAction(actionId, { ...ctx, ...scope }, input, { mode: "execute" });
  return result!;
}

async function plan(actionId: string, input: unknown, scope: Partial<ActionContext> = {}) {
  const { plan } = await runAction(actionId, { ...ctx, ...scope }, input, { mode: "plan" });
  return plan!;
}

let projectId = "";
/** the project's first environment (sandbox class, sandbox connection) */
let envId = "";
/** a second environment, so deleting the first one is allowed */
let otherId = "";

beforeEach(async () => {
  resetDb({
    workspaces: [{ id: "ws-test", name: "Test", slug: "test", createdAt: new Date().toISOString() }],
  });
  const created = await exec("project.create", { name: "Atlas" });
  const data = created.data as { projectId: string; environmentId: string };
  projectId = data.projectId;
  envId = data.environmentId;
  const second = await exec("env.create", { projectId, name: "staging", class: "staging" });
  otherId = (second.data as { environmentId: string }).environmentId;
});

/** A deployment record in whatever state the test needs, without the engine. */
function fakeDeployment(environmentId: string, status: Deployment["status"], revisionId = "rev-x") {
  const dep: Deployment = {
    id: `dep-${status}-${environmentId}`,
    projectId,
    environmentId,
    revisionId,
    status,
    steps: [],
    outputs: [],
    changeSummary: "1 change",
    estCostDeltaUsd: 0,
    actor: ctx.actor,
    createdAt: new Date().toISOString(),
  };
  db().deployments.push(dep);
  save();
  return dep;
}

afterEach(() => vi.restoreAllMocks());

describe("environment mutation authority", () => {
  async function authority(active: boolean, unreadable = false) {
    vi.spyOn(await import("@/lib/capabilities/platform"), "isMemoryStoreEnabled").mockReturnValue(false);
    const platform = await import("@/lib/controlplane/db");
    vi.spyOn(platform, "platformDb").mockImplementation(async () => {
      if (unreadable) throw new Error("authority unavailable fixture");
      return {} as Awaited<ReturnType<typeof platform.platformDb>>;
    });
    const activity = await import("@/lib/controlplane/authority");
    vi.spyOn(activity, "environmentActivity").mockResolvedValue(active
      ? [{ status: "running" }] as Awaited<ReturnType<typeof activity.environmentActivity>> : []);
  }

  it.each(["absent", "terminal"])("unreadable authority with %s projection refuses every mutation", async projection => {
    if (projection === "terminal") fakeDeployment(envId, "succeeded");
    await authority(false, true);
    const connection = { ...q.connection(q.environment(envId)!.connectionId)!, id: "authority-next", label: "Next" };
    db().connections.push(connection); save();
    const before = JSON.stringify(db());
    for (const [id, input] of [
      ["env.update", { environmentId: envId, name: "changed" }],
      ["env.setConnection", { environmentId: envId, connectionId: connection.id }],
      ["env.delete", { environmentId: envId }],
      ["project.delete", { projectId }],
      ["env.reviewTeardown", { environmentId: envId, idempotencyKey: "owned-review-01" }],
    ] as const) {
      const preview = await plan(id, input), result = await exec(id, input);
      expect(preview.blocked).toContain("cannot check current deployment activity");
      expect(result).toMatchObject({ ok: false, error: preview.blocked });
      expect(JSON.stringify(db())).toBe(before);
    }
    const teardown = await exec("env.teardown", { environmentId: envId });
    expect(teardown).toMatchObject({ ok: false, error: expect.stringContaining("cannot check current deployment activity") });
    expect(JSON.stringify(db())).toBe(before);
  });

  it.each([
    ["unsettled earlier deliveries", { unknownHistory: 0, grants: 1, handoffs: 0, reservations: 0 }, "Earlier deploy activity has not settled yet."],
    ["untracked history", { unknownHistory: 1, grants: 0, handoffs: 0, reservations: 0 }, "from before Zenith tracked deploy writers"],
    ["an unreadable inventory", undefined, "cannot check current deployment activity"],
  ] as const)("teardown and its review with %s are refused before approval with the same sentence in plan and execute", async (_case, inventory, sentence) => {
    await authority(false);
    const repos = await import("@/lib/controlplane/db/repos");
    const preview = vi.spyOn(repos.cleanupWriterBarriers, "preview");
    if (inventory) preview.mockResolvedValue(inventory); else preview.mockRejectedValue(new Error("inventory unavailable fixture"));
    const before = JSON.stringify(db());
    for (const [id, input] of [["env.teardown", { environmentId: envId }], ["env.reviewTeardown", { environmentId: envId, idempotencyKey: "settling-review-01" }]] as const) {
      const proposed = await plan(id, input), result = await exec(id, input);
      expect(proposed.blocked).toContain(sentence);
      expect(result).toMatchObject({ ok: false, error: proposed.blocked });
    }
    expect(preview).toHaveBeenCalledWith(expect.anything(), ctx.workspaceId, projectId, envId);
    expect(JSON.stringify(db())).toBe(before);
  });

  it("a drained inventory adds no teardown refusal", async () => {
    await authority(false);
    const repos = await import("@/lib/controlplane/db/repos");
    vi.spyOn(repos.cleanupWriterBarriers, "preview").mockResolvedValue({ unknownHistory: 0, grants: 0, handoffs: 0, reservations: 0 });
    const { teardownSettling } = await import("@/lib/actions/defs/env");
    await expect(teardownSettling(ctx, { id: envId, projectId })).resolves.toBeUndefined();
  });

  it("active authoritative work blocks mutation without a deployment projection", async () => {
    await authority(true);
    const before = q.environment(envId)!.name;
    expect((await exec("env.update", { environmentId: envId, name: "changed" })).ok).toBe(false);
    expect(q.environment(envId)!.name).toBe(before);
  });

  it("readable idle authority still respects active simulator work", async () => {
    await authority(false); fakeDeployment(envId, "applying");
    expect((await exec("env.update", { environmentId: envId, name: "changed" })).ok).toBe(false);
  });

  it("explicit memory mode uses its product projection", async () => {
    vi.spyOn(await import("@/lib/capabilities/platform"), "isMemoryStoreEnabled").mockReturnValue(true);
    expect((await exec("env.update", { environmentId: envId, name: "memory-idle" })).ok).toBe(true);
    fakeDeployment(envId, "applying");
    expect((await exec("env.update", { environmentId: envId, name: "memory-busy" })).ok).toBe(false);
  });
});

describe("env.update", () => {
  it("renames the environment and moves its managed hostnames", async () => {
    const result = await exec("env.update", { environmentId: envId, name: "sandbox-2" });
    expect(result.ok).toBe(true);
    const env = q.environment(envId)!;
    expect(env.name).toBe("sandbox-2");
    expect(env.baseDomain.startsWith("sandbox-2.")).toBe(true);
  });

  it("refuses a name another environment already has — same sentence in plan and execute", async () => {
    const preview = await plan("env.update", { environmentId: otherId, name: "sandbox" });
    expect(preview.blocked).toContain("already has an environment");
    const result = await exec("env.update", { environmentId: otherId, name: "sandbox" });
    expect(result.ok).toBe(false);
    expect(result.error).toBe(preview.blocked);
    expect(q.environment(otherId)!.name).toBe("staging");
  });

  it("refuses a region the provider does not have, and accepts one it does", async () => {
    // Regions come from the provider registry, which the engine populates.
    (await import("@/lib/engine/engine")).ensureEngine();

    expect((await plan("env.update", { environmentId: envId, region: "mars-1" })).blocked).toContain(
      "mars-1"
    );
    const result = await exec("env.update", { environmentId: envId, region: "sim-b" });
    expect(result.ok).toBe(true);
    expect(q.environment(envId)!.region).toBe("sim-b");
  });
});

describe("env.clone", () => {
  it("copies class, connection, region, budget and policy, and starts empty", async () => {
    await exec("env.setBudget", { environmentId: otherId, budgetUsdMonthly: 250 });
    await exec("env.updatePolicies", { environmentId: otherId, allowStatefulDeletion: true });

    const result = await exec("env.clone", { environmentId: otherId, name: "staging-copy" });
    expect(result.ok).toBe(true);
    const src = q.environment(otherId)!;
    const clone = q.environment((result.data as { environmentId: string }).environmentId)!;
    expect(clone.class).toBe(src.class);
    expect(clone.connectionId).toBe(src.connectionId);
    expect(clone.region).toBe(src.region);
    expect(clone.policies).toEqual(src.policies);
    expect(clone.deployedRevisionId).toBeUndefined();
    expect(clone.baseDomain).toContain("staging-copy");
  });

  it("refuses a name that is taken instead of silently picking another", async () => {
    const preview = await plan("env.clone", { environmentId: otherId, name: "sandbox" });
    expect(preview.blocked).toContain("already has an environment");
    const result = await exec("env.clone", { environmentId: otherId, name: "sandbox" });
    expect(result.ok).toBe(false);
    expect(result.error).toBe(preview.blocked);
    expect(q.environmentsOf(projectId)).toHaveLength(2);
  });
});

describe("env.setConnection", () => {
  function secondConnection(status: CloudConnection["status"] = "healthy"): CloudConnection {
    const conn: CloudConnection = {
      id: `conn-2-${status}`,
      workspaceId: "ws-test",
      provider: "sandbox",
      label: "Second sandbox",
      region: "local",
      status,
      grantedPermissions: [],
      createdAt: new Date().toISOString(),
    };
    db().connections.push(conn);
    save();
    return conn;
  }

  it("re-points the environment and leaves everything else alone", async () => {
    const conn = secondConnection();
    const result = await exec("env.setConnection", { environmentId: envId, connectionId: conn.id });
    expect(result.ok).toBe(true);
    expect(q.environment(envId)!.connectionId).toBe(conn.id);
    expect(q.environment(otherId)!.connectionId).not.toBe(conn.id);
  });

  it("says a disconnected connection will refuse deploys, without blocking the move", async () => {
    const conn = secondConnection("disconnected");
    const preview = await plan("env.setConnection", { environmentId: envId, connectionId: conn.id });
    expect(preview.blocked).toBeUndefined();
    expect(preview.warnings.join(" ")).toContain("disconnected");
  });

  it("blocks the connection it already uses and one that is not in the workspace", async () => {
    const same = q.environment(envId)!.connectionId;
    expect((await plan("env.setConnection", { environmentId: envId, connectionId: same })).blocked)
      .toContain("already deploys through");
    expect(
      (await plan("env.setConnection", { environmentId: envId, connectionId: "nope" })).blocked
    ).toContain("not in this workspace");
  });
});

describe("env.delete", () => {
  it("refuses the only environment a project has", async () => {
    const solo = await exec("project.create", { name: "Solo" });
    const soloEnv = (solo.data as { environmentId: string }).environmentId;
    const preview = await plan("env.delete", { environmentId: soloEnv });
    expect(preview.blocked).toContain("only environment");
    expect((await exec("env.delete", { environmentId: soloEnv })).ok).toBe(false);
  });

  it("refuses while a deployment is still in flight", async () => {
    fakeDeployment(envId, "applying");
    const preview = await plan("env.delete", { environmentId: envId });
    expect(preview.blocked).toContain("applying");
    const result = await exec("env.delete", { environmentId: envId });
    expect(result.ok).toBe(false);
    expect(q.environment(envId)).toBeDefined();
  });

  it("removes the environment and its deployment records, and warns about what keeps running", async () => {
    fakeDeployment(envId, "succeeded");
    const env = q.environment(envId)!;
    db().revisions.push({
      id: "rev-live",
      projectId,
      number: 99,
      manifest: emptyManifest(),
      message: "live",
      author: ctx.actor,
      createdAt: new Date().toISOString(),
    });
    env.deployedRevisionId = "rev-live";
    save();

    const preview = await plan("env.delete", { environmentId: envId });
    expect(preview.warnings.join(" ")).toContain("revision 99");
    expect(preview.risk).toBe("high");

    const result = await exec("env.delete", { environmentId: envId });
    expect(result.ok).toBe(true);
    expect(q.environment(envId)).toBeUndefined();
    expect(q.deploymentsOf(envId)).toHaveLength(0);
    expect(q.revisionsOf(projectId).some((r) => r.id === "rev-live")).toBe(true);
  });
});

describe("project.delete", () => {
  it("refuses while any environment is mid-deployment", async () => {
    fakeDeployment(otherId, "awaiting_approval");
    const preview = await plan("project.delete", { projectId });
    expect(preview.blocked).toContain("awaiting_approval");
    const result = await exec("project.delete", { projectId });
    expect(result.ok).toBe(false);
    expect(result.error).toBe(preview.blocked);
    expect(q.project(projectId)).toBeDefined();
  });

  it("removes the project and everything under it, and nothing above it", async () => {
    fakeDeployment(envId, "succeeded");
    const otherProject = await exec("project.create", { name: "Keep me" });
    const keepId = (otherProject.data as { projectId: string }).projectId;

    const preview = await plan("project.delete", { projectId });
    expect(preview.blocked).toBeUndefined();
    expect(preview.details.join(" ")).toContain("Nothing in your cloud");

    const result = await exec("project.delete", { projectId });
    expect(result.ok).toBe(true);
    expect(q.project(projectId)).toBeUndefined();
    expect(q.environmentsOf(projectId)).toHaveLength(0);
    expect(q.deploymentsOf(envId)).toHaveLength(0);
    expect(db().revisions.filter((r) => r.projectId === projectId)).toHaveLength(0);
    expect(q.project(keepId)).toBeDefined();
    expect(db().connections.length).toBeGreaterThan(0); // connections outlive projects
  });
});
