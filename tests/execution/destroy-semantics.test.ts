/**
 * PROD-DUR-03 for teardown: the destroy review records the executable semantics, the destroy re-plan and the
 * apply dispatch recompute them, and a mismatch refuses before any deletion (isolated fakes, no cloud).
 *
 * Two lanes: `memory` (the isolated fakes on the fixture ids) and `postgres` (only with
 * ZENITH_TEST_PLATFORM_PG_URL). The postgres lane records the review in a real `platform.approved_semantics`
 * table, whose foreign key needs a real `platform.operations` row: each test seeds its own approved operation
 * (a unique id on the persistent database) and the fakes carry that id.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createPlatformSemanticsStore } from "@/lib/controlplane/db/repos/executable-semantics";
import { readExecutableSemantics } from "@/lib/execution/semantics/digest";
import { SemanticsChangedError } from "@/lib/execution/semantics/errors";
import { MemorySemanticsStore, type SemanticsStore } from "@/lib/execution/semantics/store";
import { LANES, openLane, seedApprovedOperation } from "../controlplane/_support/harness";
import { bucketManifest, change, ENV, makePlan, OP, REVISION, WS } from "./fakes/fixtures";
import { createWorld, type World } from "./fakes/world";

const PG_LANE = LANES.find((l) => l.name === "postgres");
const SEMANTICS_LANES = ["memory", ...(PG_LANE ? ["postgres"] : [])];

describe.each(SEMANTICS_LANES)("teardown executable semantics [%s]", (name) => {
  const worlds: World[] = [];
  let pg: Awaited<ReturnType<typeof openLane>> | undefined;
  // the operation each test tears down: the fixture id in memory, a freshly seeded platform row per test in postgres
  let op = OP;

  beforeAll(async () => {
    if (PG_LANE && name === "postgres") pg = await openLane(PG_LANE);
  }, 60_000);
  afterAll(async () => {
    await pg?.close();
  });
  beforeEach(async () => {
    if (!pg) return;
    op = (await seedApprovedOperation(pg.db, WS, { proposal: { capability: "infrastructure.destroy" } })).operation.id;
  });
  afterEach(() => worlds.splice(0).forEach((w) => w.dispose()));

  const semantics = (): SemanticsStore => (pg ? createPlatformSemanticsStore(pg.db) : new MemorySemanticsStore());

  async function reviewed() {
    const store = semantics();
    const w = createWorld({ op: { id: op, workspaceId: WS, capability: "infrastructure.destroy" }, semantics: store });
    worlds.push(w);
    w.product.base.environment.deployedRevisionId = REVISION;
    const { upgradeManifest } = await import("@/lib/resources/upgrade");
    const v2 = upgradeManifest(bucketManifest(), { provider: "aws", region: "us-east-1" });
    v2.policies = { backup: "daily", ...v2.policies, deletion: "allow" };
    w.product.setManifest(v2);
    w.tofu.planFactory = (ws) => makePlan({ configDigest: ws.configDigest, lockDigest: ws.lockDigest, changes: [change({ address: "aws_s3_bucket.object_store_assets", nodeAddress: "object_store/assets", type: "aws_s3_bucket", action: "delete", destroysData: true })] });
    await w.activities.markOperation({ operationId: op, status: "running" });
    const lease = await w.activities.acquireLease({ operationId: op, scope: `env:${ENV}`, ttlMs: 300_000 });
    const plan = await w.activities.planDestroyInfrastructure({ operationId: op, lease });
    w.broker.approval = { approved: true, rejected: false, approvalId: "app-1" };
    return { w, store, lease, planDigest: plan.planDigest };
  }

  type Mutable = { activeOwnershipTransfers?: () => Promise<unknown[]> };
  const moveOwnership = (w: World): void => {
    (w.resources as unknown as Mutable).activeOwnershipTransfers = async () => [{ address: "object_store/assets", resourceType: "aws_s3_bucket", path: "versioning", from: "iac", to: "release", approvalId: "a", approvedAt: "2026-09-30T00:00:00.000Z", digest: "7".repeat(64) }];
  };

  describe("teardown executable semantics", () => {
    it("records the semantics at review and shows them in the destroy plan evidence", async () => {
      const { w, store, planDigest } = await reviewed();
      const row = await store.get(WS, op, planDigest);
      expect(row).not.toBeNull();
      const [evidence] = w.evidence.ofKind("tofu_plan");
      expect(readExecutableSemantics(evidence.summary.semantics)?.digest).toBe(row!.semantics.digest);
    });

    it("applies when nothing relevant changed", async () => {
      const { w, lease, planDigest } = await reviewed();
      await expect(w.activities.applyDestroyInfrastructure({ operationId: op, planDigest, lease })).resolves.toMatchObject({ deleted: 1 });
    });

    it("refuses at dispatch, before any deletion, when ownership moved after the review", async () => {
      const { w, lease, planDigest } = await reviewed();
      moveOwnership(w);
      const err = await w.activities.applyDestroyInfrastructure({ operationId: op, planDigest, lease }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(SemanticsChangedError);
      expect((err as SemanticsChangedError).changed).toEqual(["ownership"]);
      expect((err as Error).message).toMatch(/destroy dispatch/);
      expect(w.evidence.ofKind("tofu_apply")).toHaveLength(0);
      expect(w.ops.uncertain).toHaveLength(0);
    });

    it("refuses the destroy re-plan when the semantics moved", async () => {
      const { w, lease, planDigest } = await reviewed();
      moveOwnership(w);
      const err = await w.activities.finalDestroyPlan({ operationId: op, approvedPlanDigest: planDigest, lease }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(SemanticsChangedError);
      expect((err as Error).message).toMatch(/destroy final plan/);
    });

    it("refuses a teardown whose review recorded no semantics", async () => {
      const { w, lease, planDigest } = await reviewed();
      w.deps.semantics = new MemorySemanticsStore();
      await expect(w.activities.applyDestroyInfrastructure({ operationId: op, planDigest, lease })).rejects.toThrow(/No executable semantics were recorded/);
      expect(w.evidence.ofKind("tofu_apply")).toHaveLength(0);
    });
  });
});
