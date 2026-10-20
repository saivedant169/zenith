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
import { StepFailedError } from "@/lib/execution/errors";
import { readExecutableSemantics, SEMANTIC_COMPONENTS, type SemanticComponentName } from "@/lib/execution/semantics/digest";
import { SemanticsChangedError } from "@/lib/execution/semantics/errors";
import { MemorySemanticsStore, type SemanticsStore } from "@/lib/execution/semantics/store";
import { FAILURE_TYPES } from "@/lib/workflows/types";
import { TofuPlanChangedError } from "@/lib/tofu/types";
import { LANES, openLane, seedApprovedOperation } from "../controlplane/_support/harness";
import { bucketManifest, change, ENV, makePlan, migratingManifest, OP, REVISION, WS } from "./fakes/fixtures";
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

  /** The bucket-only destroy base, or any other manifest the teardown table reviews. */
  async function reviewed(base?: () => Promise<unknown> | unknown) {
    const store = semantics();
    const w = createWorld({ op: { id: op, workspaceId: WS, capability: "infrastructure.destroy" }, semantics: store });
    worlds.push(w);
    w.product.base.environment.deployedRevisionId = REVISION;
    if (base) w.product.setManifest(await base());
    else {
      const { upgradeManifest } = await import("@/lib/resources/upgrade");
      const v2 = upgradeManifest(bucketManifest(), { provider: "aws", region: "us-east-1" });
      v2.policies = { backup: "daily", ...v2.policies, deletion: "allow" };
      w.product.setManifest(v2);
    }
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

  describe("teardown refuses every changed approved component except ownership", () => {
    const SAVED_PLAN_OTHER = "e".repeat(64);

    /** The teardown base: the bucket to delete plus a web service carrying the release migration (no routes, so no DNS guard). */
    function teardownBase(over: { class?: "expand" | "data" | "contract"; command?: string[] } = {}) {
      const m = migratingManifest(over.command);
      m.release = { migrate: { ...m.release!.migrate!, class: over.class ?? "expand" } };
      m.routes = [];
      m.bindings = [];
      m.resources = bucketManifest().resources as typeof m.resources;
      m.policies = { backup: "daily", deletion: "allow" } as typeof m.policies;
      return m;
    }

    type Gate = "semantics" | "tofuPlan" | "reviewedPlan";
    interface TeardownRow {
      component: SemanticComponentName;
      label: string;
      /** the refusal the product throws for this component at teardown dispatch */
      gate: Gate;
      mutate(w: World): void | Promise<void>;
    }

    /** One representative mutation per component the teardown can see; the dispatch table in semantics-dispatch.test.ts uses the same list. */
    const ROWS: TeardownRow[] = [
      { component: "revision", label: "the revision id", gate: "semantics", mutate: (w) => { w.product.revisions.set(REVISION, { ...w.product.revisions.get(REVISION)!, id: "rev-act-1-next" }); } },
      { component: "scripts", label: "the release script command", gate: "semantics", mutate: (w) => { w.product.setManifest(teardownBase({ command: ["node", "migrate.js", "--down"] })); } },
      { component: "migrations", label: "the declared migration class", gate: "semantics", mutate: (w) => { w.product.setManifest(teardownBase({ class: "contract" })); } },
      // The fresh re-plan digest moves with the rendered workspace, so the plan gate fires before the semantics compare.
      { component: "targets", label: "the region", gate: "tofuPlan", mutate: (w) => { w.product.base.environment.region = "eu-west-1"; } },
      { component: "configuration", label: "the rendered configuration", gate: "tofuPlan", mutate: (w) => { const m = teardownBase(); (m.services[0] as unknown as { env: unknown[] }).env = [{ key: "FOO", value: "bar" }]; w.product.setManifest(m); } },
      { component: "providerLocks", label: "the provider lock file", gate: "tofuPlan", mutate: (w) => { w.deps.tofuWorkspace = { providerSet: () => ({ name: "aws-changed", providers: ["aws"], lockfile: "# changed\n" }) }; } },
      { component: "backend", label: "the backend configuration", gate: "tofuPlan", mutate: (w) => { w.deps.tofuWorkspace = { backend: () => ({ backend: { kind: "local", path: "changed.tfstate" } }) }; } },
      // The saved plan is the digest argument: teardown dispatches a plan with no reviewed destroy evidence.
      { component: "savedPlan", label: "the saved plan digest", gate: "reviewedPlan", mutate: async (w) => { const rec = (await w.ops.get(op))!; w.ops.seed({ ...rec, planDigest: SAVED_PLAN_OTHER }); } },
      { component: "runbook", label: "the runbook version (MACH-03)", gate: "semantics", mutate: async (w) => { const rec = (await w.ops.get(op))!; w.ops.seed({ ...rec, proposal: { ...rec.proposal, input: { ...(rec.proposal.input as object), runbook: { runbookId: "rb_1", version: 3, definitionDigest: "2".repeat(64) } } } }); } },
      { component: "decommission", label: "an adoption claim", gate: "semantics", mutate: (w) => { w.deps.portability = { adoptionFacts: async () => [{ address: "postgres/db", externalId: "db-1", status: "active", lifecycle: "manage" }] } as unknown as typeof w.deps.portability; } },
    ];

    /**
     * Components a teardown cannot apply, so their rows are not in the table. A teardown runs no build step, so the
     * recipe and provenance inputs are not produced for it; a source edit moves only the plan digest, which the plan
     * gate refuses first with TofuPlanChangedError (the same refusal the `targets` row shows).
     */
    const NOT_APPLICABLE: Partial<Record<SemanticComponentName, string>> = {
      recipe: "a teardown runs no build step; a source edit reaches the teardown only as a changed plan digest (plan gate, TofuPlanChangedError)",
      provenance: "a teardown runs no build pipeline; a build context edit reaches the teardown only as a changed plan digest (plan gate, TofuPlanChangedError)",
    };

    it("the table covers every approved component except ownership, which the cases above cover", () => {
      const covered = [...ROWS.map((r) => r.component), ...Object.keys(NOT_APPLICABLE)].sort();
      expect(covered).toEqual(SEMANTIC_COMPONENTS.filter((c) => c !== "ownership").sort());
    });

    function expectTeardownGate(err: unknown, gate: Gate, component: SemanticComponentName): void {
      switch (gate) {
        case "semantics":
          expect(err).toBeInstanceOf(SemanticsChangedError);
          expect((err as SemanticsChangedError).changed).toContain(component);
          expect((err as SemanticsChangedError).type).toBe(FAILURE_TYPES.planChanged);
          expect((err as Error).message).toMatch(/destroy dispatch/);
          return;
        case "tofuPlan":
          expect(err).toBeInstanceOf(TofuPlanChangedError);
          expect((err as TofuPlanChangedError).code).toBe("plan_changed");
          expect((err as Error).message).toMatch(/The infrastructure plan changed since it was approved/);
          return;
        case "reviewedPlan":
          expect(err).toBeInstanceOf(StepFailedError);
          expect((err as Error).message).toMatch(/No reviewed destroy plan evidence with a verifiable node list was recorded/);
          return;
      }
    }

    it.each(ROWS.map((r) => [r.component, r] as const))("refuses a changed %s at teardown dispatch before any deletion", async (component, row) => {
      const { w, lease, planDigest } = await reviewed(() => teardownBase());
      await row.mutate(w);
      const dispatched = component === "savedPlan" ? SAVED_PLAN_OTHER : planDigest;
      const err = await w.activities.applyDestroyInfrastructure({ operationId: op, planDigest: dispatched, lease }).catch((e: unknown) => e);
      expectTeardownGate(err, row.gate, component);
      expect(w.evidence.ofKind("tofu_apply")).toHaveLength(0);
      expect(w.ops.uncertain).toHaveLength(0);
    });
  });
});
