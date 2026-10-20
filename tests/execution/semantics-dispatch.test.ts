/**
 * PROD-DUR-03 / PROD-DUR-04 at the dispatch points of the real execution activities (isolated fakes):
 * planning records the reviewed semantics write-once and shows them in the plan evidence; the re-plan
 * before apply and the apply dispatch itself recompute them and refuse when anything relevant moved;
 * dispatch-time authority is decided again from current state. Real-PostgreSQL behaviour of the table is
 * covered in tests/controlplane/executable-semantics.test.ts.
 *
 * Two lanes: `memory` (the isolated fakes on the fixture ids) and `postgres` (only with
 * ZENITH_TEST_PLATFORM_PG_URL). The postgres lane records the reviewed semantics in a real
 * `platform.approved_semantics` table, whose foreign key needs a real `platform.operations` row: each test seeds
 * its own operation (a unique id on the persistent database) and the fakes carry that id.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { projectPlanReview } from "@/lib/controlplane/db/repos/operation-review";
import { createPlatformSemanticsStore } from "@/lib/controlplane/db/repos/executable-semantics";
import { readExecutableSemantics, type SemanticComponentName } from "@/lib/execution/semantics/digest";
import { SemanticsChangedError } from "@/lib/execution/semantics/errors";
import { TofuPlanChangedError } from "@/lib/tofu/types";
import { MemorySemanticsStore, type SemanticsStore } from "@/lib/execution/semantics/store";
import { FAILURE_TYPES, type LeaseRef } from "@/lib/workflows/types";
import { StepFailedError } from "@/lib/execution/errors";
import { ReleaseSafetyService, createMemoryReleaseStore, type ProvenanceVerifier } from "@/lib/release-safety";
import { LANES, openLane, seedApprovedOperation } from "../controlplane/_support/harness";
import { ENV, OP, REVISION, WS, builtManifest, bucketManifest, migratingManifest } from "./fakes/fixtures";
import { createWorld, type World, type WorldOptions } from "./fakes/world";

type Mutable = { activeOwnershipTransfers?: () => Promise<unknown[]> };
const transfer = { address: "object_store/assets", resourceType: "aws_s3_bucket", path: "versioning", from: "iac", to: "release", approvalId: "apr_1", approvedAt: "2026-09-30T00:00:00.000Z", digest: "7".repeat(64) };
const moveOwnership = (w: World): void => {
  (w.resources as unknown as Mutable).activeOwnershipTransfers = async () => [transfer];
};

const PG_LANE = LANES.find((l) => l.name === "postgres");
const SEMANTICS_LANES = ["memory", ...(PG_LANE ? ["postgres"] : [])];

describe.each(SEMANTICS_LANES)("execution dispatch [%s]", (name) => {
  const worlds: World[] = [];
  let pg: Awaited<ReturnType<typeof openLane>> | undefined;
  // the operation each test runs on: the fixture id in memory, a freshly seeded platform row per test in postgres
  let op = OP;

  beforeAll(async () => {
    if (PG_LANE && name === "postgres") pg = await openLane(PG_LANE);
  }, 60_000);
  afterAll(async () => {
    await pg?.close();
  });
  beforeEach(async () => {
    if (!pg) return;
    op = (await seedApprovedOperation(pg.db, WS)).operation.id;
  });
  afterEach(() => {
    while (worlds.length) worlds.pop()!.dispose();
  });

  const semantics = (): SemanticsStore => (pg ? createPlatformSemanticsStore(pg.db) : new MemorySemanticsStore());

  /** A world on this lane's operation: the fakes carry the seeded operation id, the fixture workspace and environment. */
  function worldFor(opts: Omit<WorldOptions, "op">): World {
    const w = createWorld({ ...opts, op: { id: op, workspaceId: WS } });
    worlds.push(w);
    return w;
  }
  const leaseOf = (w: World) => w.activities.acquireLease({ operationId: op, scope: `env:${ENV}`, ttlMs: 300_000 });

  function world(withStore = true): { w: World; store: SemanticsStore } {
    const store = semantics();
    const w = worldFor({ semantics: withStore ? store : null });
    w.product.setManifest(bucketManifest());
    // Explicit isolated human-authority fixture; the real broker's dispatch authority is tested in tests/capabilities.
    w.broker.approval = { approved: true, rejected: false, approvalId: "isolated-reviewed-human-fixture" };
    return { w, store };
  }

  async function planned(w: World) {
    await w.activities.markOperation({ operationId: op, status: "running" });
    await w.activities.validateDesiredState({ operationId: op });
    const lease = await leaseOf(w);
    const plan = await w.activities.planInfrastructure({ operationId: op, lease });
    return { lease, plan };
  }

  describe("planning records what the approver is shown", () => {
    it("writes the semantics once, bound to the plan digest, and shows the same digest in the plan evidence", async () => {
      const { w, store } = world();
      const { plan } = await planned(w);
      const row = await store.get(WS, op, plan.planDigest);
      expect(row).not.toBeNull();
      const [evidence] = w.evidence.ofKind("tofu_plan");
      const shown = readExecutableSemantics(evidence.summary.semantics);
      expect(shown?.digest).toBe(row!.semantics.digest);
      // the plan review projection the approval card and the broker read carries it
      const review = projectPlanReview(evidence.summary, plan.planDigest);
      expect(review?.semantics?.digest).toBe(row!.semantics.digest);
    });

    it("a plan whose evidence carries a malformed semantics document is not reviewable", async () => {
      const { w } = world();
      const { plan } = await planned(w);
      const [evidence] = w.evidence.ofKind("tofu_plan");
      expect(projectPlanReview({ ...evidence.summary, semantics: { format: "zenith.executable-semantics.v1", digest: "0".repeat(64), components: {} } }, plan.planDigest)).toBeUndefined();
    });

    it("without a store the legacy behaviour holds and the evidence still shows the semantics", async () => {
      const { w } = world(false);
      const { lease, plan } = await planned(w);
      expect(readExecutableSemantics(w.evidence.ofKind("tofu_plan")[0].summary.semantics)).toBeDefined();
      await expect(w.activities.applyInfrastructure({ operationId: op, planDigest: plan.planDigest, lease })).resolves.toMatchObject({ applied: 1 });
    });
  });

  describe("the re-plan before apply", () => {
    it("passes when nothing relevant changed", async () => {
      const { w } = world();
      const { lease, plan } = await planned(w);
      const again = await w.activities.finalPlan({ operationId: op, approvedPlanDigest: plan.planDigest, lease });
      expect(again.planDigest).toBe(plan.planDigest);
    });

    it("refuses with a plan_changed failure naming the component when ownership moved after review", async () => {
      const { w } = world();
      const { lease, plan } = await planned(w);
      moveOwnership(w);
      const err = await w.activities.finalPlan({ operationId: op, approvedPlanDigest: plan.planDigest, lease }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(SemanticsChangedError);
      expect((err as SemanticsChangedError).changed).toEqual(["ownership"]);
      expect((err as SemanticsChangedError).type).toBe(FAILURE_TYPES.planChanged);
      expect((err as Error).message).toMatch(/final plan/);
    });
  });

  describe("apply dispatch", () => {
    it("dispatches the reviewed original when the semantics are unchanged", async () => {
      const { w } = world();
      const { lease, plan } = await planned(w);
      const out = await w.activities.applyInfrastructure({ operationId: op, planDigest: plan.planDigest, lease });
      expect(out.applied).toBe(1);
      expect(w.evidence.ofKind("tofu_apply")).toHaveLength(1);
    });

    it("refuses at dispatch, before any write, when an ownership transfer appeared after approval", async () => {
      const { w } = world();
      const { lease, plan } = await planned(w);
      moveOwnership(w);
      const err = await w.activities.applyInfrastructure({ operationId: op, planDigest: plan.planDigest, lease }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(SemanticsChangedError);
      expect((err as SemanticsChangedError).changed).toEqual(["ownership"]);
      expect((err as SemanticsChangedError).message).toMatch(/apply dispatch/);
      expect(w.evidence.ofKind("tofu_apply")).toHaveLength(0);
      expect(w.events.ofType("resource.applying")).toHaveLength(1);
      expect(w.events.ofType("resource.applied")).toHaveLength(0);
    });

    it("refuses a plan with no recorded semantics rather than treating it as unchanged", async () => {
      const { w } = world();
      const { lease, plan } = await planned(w);
      w.deps.semantics = new MemorySemanticsStore();
      const err = await w.activities.applyInfrastructure({ operationId: op, planDigest: plan.planDigest, lease }).catch((e: unknown) => e);
      expect((err as Error).message).toMatch(/No executable semantics were recorded/);
      expect(w.evidence.ofKind("tofu_apply")).toHaveLength(0);
    });

    it("refuses when current human approval was withdrawn after review (authority is decided at dispatch)", async () => {
      const { w } = world();
      const { lease, plan } = await planned(w);
      w.broker.approval = { approved: false, rejected: false };
      await expect(w.activities.applyInfrastructure({ operationId: op, planDigest: plan.planDigest, lease })).rejects.toThrow(/Current policy or human approval changed/);
      expect(w.evidence.ofKind("tofu_apply")).toHaveLength(0);
    });

    it("the semantics check runs before the approval check, so a moved plan is never mistaken for a missing approval", async () => {
      const { w } = world();
      const { lease, plan } = await planned(w);
      moveOwnership(w);
      w.broker.approval = { approved: false, rejected: false };
      await expect(w.activities.applyInfrastructure({ operationId: op, planDigest: plan.planDigest, lease })).rejects.toBeInstanceOf(SemanticsChangedError);
    });
  });

  describe("release steps: build, rollout and migration dispatch", () => {
    const SVC = "container_service/web";
    const DIGEST = `sha256:${"a".repeat(64)}`;
    const image = { service: SVC, imageUri: `123456789012.dkr.ecr.us-east-1.amazonaws.com/web@${DIGEST}`, digest: DIGEST };
    const verifier: ProvenanceVerifier = { name: "test", verify: async () => ({ verified: true, level: "pinned_digest", evidenceRef: "ev:test" }) };

    async function releasing() {
      const store = semantics();
      const safety = new ReleaseSafetyService({ store: createMemoryReleaseStore(), verifiers: [verifier], minProvenance: "pinned_digest" });
      const w = worldFor({ semantics: store, releaseSafety: safety });
      const manifest = migratingManifest();
      manifest.release = { migrate: { ...manifest.release!.migrate!, class: "expand" } };
      w.product.setManifest(manifest);
      w.broker.approval = { approved: true, rejected: false, approvalId: "isolated-reviewed-human-fixture" };
      const { lease, plan } = await planned(w);
      return { w, lease, plan, store };
    }
    const move = (w: World): void => {
      (w.resources as unknown as Mutable).activeOwnershipTransfers = async () => [{ ...transfer, address: SVC }];
    };

    it("rolls out and migrates when the semantics are unchanged", async () => {
      const { w, lease } = await releasing();
      expect(await w.activities.deployWorkloads({ operationId: op, lease, images: [image] })).toEqual({ services: 1 });
      expect(w.workloads.deployed).toHaveLength(1);
      expect((await w.activities.runMigrations({ operationId: op, lease })).ran).toBe(true);
      expect(w.migrations.runs).toHaveLength(1);
    });

    it("refuses the first rollout effect when the semantics moved after review", async () => {
      const { w, lease } = await releasing();
      move(w);
      const err = await w.activities.deployWorkloads({ operationId: op, lease, images: [image] }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(SemanticsChangedError);
      expect((err as SemanticsChangedError).message).toMatch(/rollout dispatch/);
      expect(w.workloads.deployed).toHaveLength(0);
    });

    it("refuses the migration, and spends no single-use migration approval, when the semantics moved after the rollout", async () => {
      const { w, lease } = await releasing();
      await w.activities.deployWorkloads({ operationId: op, lease, images: [image] });
      move(w);
      const err = await w.activities.runMigrations({ operationId: op, lease }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(SemanticsChangedError);
      expect((err as SemanticsChangedError).message).toMatch(/migration dispatch/);
      expect(w.migrations.runs).toHaveLength(0);
    });

    it("decides authorization again at rollout dispatch from current state", async () => {
      const { w, lease } = await releasing();
      w.broker.approval = { approved: false, rejected: true };
      const err = await w.activities.deployWorkloads({ operationId: op, lease, images: [image] }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(StepFailedError);
      expect((err as Error).message).toMatch(/Current policy or human approval changed before rollout dispatch/);
      expect(w.workloads.deployed).toHaveLength(0);
    });

    it("decides authorization again at migration dispatch from current state", async () => {
      const { w, lease } = await releasing();
      await w.activities.deployWorkloads({ operationId: op, lease, images: [image] });
      w.broker.approval = { approved: true, rejected: false }; // no approval id although the operation requires one
      w.ops.seed({ ...(await w.ops.get(op))!, approvalRequired: true });
      const err = await w.activities.runMigrations({ operationId: op, lease }).catch((e: unknown) => e);
      expect((err as Error).message).toMatch(/Current policy or human approval changed before migration dispatch/);
      expect(w.migrations.runs).toHaveLength(0);
    });

    it("a legacy worker without the store dispatches as before", async () => {
      const w = worldFor({ semantics: null, releaseSafety: new ReleaseSafetyService({ store: createMemoryReleaseStore(), verifiers: [verifier], minProvenance: "pinned_digest" }) });
      const manifest = migratingManifest();
      manifest.release = { migrate: { ...manifest.release!.migrate!, class: "expand" } };
      w.product.setManifest(manifest);
      await w.activities.markOperation({ operationId: op, status: "running" });
      const lease = await leaseOf(w);
      move(w);
      expect(await w.activities.deployWorkloads({ operationId: op, lease, images: [image] })).toEqual({ services: 1 });
    });
  });

  describe("every changed approved component is refused at each dispatch point", () => {
    const SVC = "container_service/web";
    const DIGEST = `sha256:${"a".repeat(64)}`;
    const image = { service: SVC, imageUri: `123456789012.dkr.ecr.us-east-1.amazonaws.com/web@${DIGEST}`, digest: DIGEST };
    const verifier: ProvenanceVerifier = { name: "test", verify: async () => ({ verified: true, level: "pinned_digest", evidenceRef: "ev:test" }) };
    const SAVED_PLAN_OTHER = "e".repeat(64);
    const otherOwnership = { address: SVC, resourceType: "aws_ecs_service", path: "desired_count", from: "iac", to: "autoscaler", approvalId: "apr_1", approvedAt: "2026-09-30T00:00:00.000Z", digest: "7".repeat(64) };

    type Effect = "apply" | "build" | "rollout" | "migration";
    type Base = "releasing" | "built";
    /**
     * The gate that refuses a changed component, as the product actually orders them:
     * - semantics: `assertApprovedSemantics` / `assertOperationSemantics` compares the recorded and current digests (SemanticsChangedError)
     * - tofuPlan: the engine's fresh re-plan digest differs from the approved plan, before the semantics compare (TofuPlanChangedError)
     * - custody: the approved-source store refuses a changed recipe before the semantics compare (StepFailedError)
     * - admission: signed build provenance admission (`admitBuiltArtifacts`, release.ts) refuses the rollout, before the semantics compare (StepFailedError)
     * - reviewedPlan: the reviewed-plan custody has no plan for the dispatched digest (StepFailedError)
     * - noRecord: no executable semantics were recorded for the operation's plan digest (StepFailedError)
     */
    type Gate = "semantics" | "tofuPlan" | "custody" | "admission" | "reviewedPlan" | "noRecord";
    interface Row {
      component: SemanticComponentName;
      label: string;
      base: Base;
      effects: readonly Effect[];
      /** the gate that fires per effect; every other effect is `semantics` */
      gates?: Partial<Record<Effect, Gate>>;
      mutate(w: World): void | Promise<void>;
    }

    /** One representative mutation per component of the executable-semantics list (the full mutation matrix is in semantics.test.ts). */
    const ROWS: Row[] = [
      { component: "revision", label: "the revision id", base: "releasing", effects: ["apply", "rollout", "migration"], mutate: (w) => { w.product.revisions.set(REVISION, { ...w.product.revisions.get(REVISION)!, id: "rev-act-1-next" }); } },
      // Built source: the approved-source store refuses a changed recipe before the semantics compare, at every effect that reads it.
      { component: "recipe", label: "a Dockerfile / source recipe", base: "built", effects: ["apply", "build", "rollout", "migration"], gates: { apply: "custody", build: "custody", rollout: "custody", migration: "custody" }, mutate: (w) => { w.product.setManifest(builtWithMigrate({ type: "git", repo: "github.com/acme/api", ref: "other", dockerfile: "Dockerfile" })); } },
      { component: "scripts", label: "the release script command", base: "releasing", effects: ["apply", "rollout", "migration"], mutate: (w) => { w.product.setManifest(withMigrate({ command: ["node", "migrate.js", "--down"] })); } },
      { component: "migrations", label: "the declared migration class", base: "releasing", effects: ["apply", "rollout", "migration"], mutate: (w) => { w.product.setManifest(withMigrate({ class: "contract" })); } },
      // The engine's fresh re-plan digest moves with the rendered workspace, so on apply the plan gate fires before the semantics compare.
      { component: "targets", label: "the region", base: "releasing", effects: ["apply", "rollout", "migration"], gates: { apply: "tofuPlan" }, mutate: (w) => { w.product.base.environment.region = "eu-west-1"; } },
      { component: "configuration", label: "the rendered configuration", base: "releasing", effects: ["apply", "rollout", "migration"], gates: { apply: "tofuPlan" }, mutate: (w) => { const m = withMigrate({}); (m.services[0] as unknown as { env: unknown[] }).env = [{ key: "FOO", value: "bar" }]; w.product.setManifest(m); } },
      { component: "providerLocks", label: "the provider lock file", base: "releasing", effects: ["apply", "rollout", "migration"], gates: { apply: "tofuPlan" }, mutate: (w) => { w.deps.tofuWorkspace = { providerSet: () => ({ name: "aws-changed", providers: ["aws"], lockfile: "# changed\n" }) }; } },
      { component: "backend", label: "the backend configuration", base: "releasing", effects: ["apply", "rollout", "migration"], gates: { apply: "tofuPlan" }, mutate: (w) => { w.deps.tofuWorkspace = { backend: () => ({ backend: { kind: "local", path: "changed.tfstate" } }) }; } },
      // The saved plan is the digest argument itself: apply dispatches a different plan (no reviewed custody for it); release steps read a different op.planDigest (no recorded semantics).
      { component: "savedPlan", label: "the saved plan digest", base: "releasing", effects: ["apply", "rollout", "migration"], gates: { apply: "reviewedPlan", rollout: "noRecord", migration: "noRecord" }, mutate: async (w) => { const rec = (await w.ops.get(op))!; w.ops.seed({ ...rec, planDigest: SAVED_PLAN_OTHER }); } },
      // Built source: the approved-source store refuses a changed build context (pipeline spec digest) before the semantics compare.
      // At rollout, admission (`contextDigestFor` in `admitBuiltArtifacts`) refuses the subdirectory build before the semantics compare.
      { component: "provenance", label: "a build context directory", base: "built", effects: ["apply", "build", "rollout", "migration"], gates: { apply: "custody", build: "custody", rollout: "admission", migration: "custody" }, mutate: (w) => { w.product.setManifest(builtWithMigrate({ type: "git", repo: "github.com/acme/api", ref: "main", dockerfile: "Dockerfile", contextDir: "services/api" })); } },
      { component: "ownership", label: "an ownership transfer", base: "releasing", effects: ["apply", "rollout", "migration"], mutate: (w) => { (w.resources as unknown as Mutable).activeOwnershipTransfers = async () => [otherOwnership]; } },
      { component: "runbook", label: "the runbook version (MACH-03)", base: "releasing", effects: ["apply", "rollout", "migration"], mutate: async (w) => { const rec = (await w.ops.get(op))!; w.ops.seed({ ...rec, proposal: { ...rec.proposal, input: { ...(rec.proposal.input as object), runbook: { runbookId: "rb_1", version: 3, definitionDigest: "2".repeat(64) } } } }); } },
      { component: "decommission", label: "an adoption claim", base: "releasing", effects: ["apply", "rollout", "migration"], mutate: (w) => { w.deps.portability = { adoptionFacts: async () => [{ address: "postgres/db", externalId: "db-1", status: "active", lifecycle: "manage" }] } as unknown as typeof w.deps.portability; } },
    ];

    function withMigrate(over: { class?: "expand" | "data" | "contract"; command?: string[] }) {
      const m = migratingManifest();
      m.release = { migrate: { ...m.release!.migrate!, class: "expand", ...over } };
      return m;
    }

    /** The built base: a git-built `api` service that also carries the release migration, so every release effect is reachable. */
    function builtWithMigrate(source: Record<string, unknown> = { type: "git", repo: "github.com/acme/api", ref: "main", dockerfile: "Dockerfile" }): ReturnType<typeof migratingManifest> {
      const m = builtManifest();
      (m.services[0] as unknown as { source: unknown }).source = source;
      return { ...m, version: 2, placement: { provider: "aws", regions: ["us-east-1"] }, release: { migrate: { service: "api", command: ["node", "migrate.js", "--up"], class: "expand" } } } as unknown as ReturnType<typeof migratingManifest>;
    }

    /** A world with the reviewed plan recorded: the manifest of the base, the human approval and (for release steps) the verifier. */
    async function approvedWorld(row: Row) {
      const store = semantics();
      const safety = new ReleaseSafetyService({ store: createMemoryReleaseStore(), verifiers: [verifier], minProvenance: "pinned_digest" });
      const w = worldFor({ semantics: store, releaseSafety: safety });
      w.product.setManifest(row.base === "built" ? builtWithMigrate() : withMigrate({}));
      w.broker.approval = { approved: true, rejected: false, approvalId: "isolated-reviewed-human-fixture" };
      const { lease, plan } = await planned(w);
      return { w, lease, plan };
    }

    /** Assert the exact refusal the gate throws. Every gate is a refusal before any write; the caller asserts the write tracking. */
    function expectGate(err: unknown, gate: Gate, component: SemanticComponentName, stage: string): void {
      switch (gate) {
        case "semantics":
          expect(err).toBeInstanceOf(SemanticsChangedError);
          expect((err as SemanticsChangedError).changed).toContain(component);
          expect((err as SemanticsChangedError).type).toBe(FAILURE_TYPES.planChanged);
          expect((err as Error).message).toMatch(new RegExp(stage));
          return;
        case "tofuPlan":
          expect(err).toBeInstanceOf(TofuPlanChangedError);
          expect((err as TofuPlanChangedError).code).toBe("plan_changed");
          expect((err as Error).message).toMatch(/The infrastructure plan changed since it was approved/);
          return;
        case "custody":
          expect(err).toBeInstanceOf(StepFailedError);
          expect((err as Error).message).toMatch(/Approved source recipe changed; a new operation and review are required/);
          return;
        case "admission":
          // signed build provenance admission (`admitBuiltArtifacts`) refuses before the semantics compare
          expect(err).toBeInstanceOf(StepFailedError);
          expect((err as Error).message).toMatch(/builds from the subdirectory services\/api without the digest source inspection/);
          return;
        case "reviewedPlan":
          expect(err).toBeInstanceOf(StepFailedError);
          expect((err as Error).message).toMatch(/Isolated reviewed plan missing/);
          return;
        case "noRecord":
          expect(err).toBeInstanceOf(StepFailedError);
          expect((err as Error).message).toMatch(/No executable semantics were recorded/);
          return;
      }
    }

    const cases = (effect: Effect) => ROWS.filter((r) => r.effects.includes(effect)).map((r) => [r.component, r, r.gates?.[effect] ?? "semantics"] as const);
    /** The images a release deploys: the reviewed pinned image, or for the built base the image the isolated build produced and signed. */
    const releaseImages = async (row: Row, w: World, lease: LeaseRef) => (row.base === "built" ? (await w.activities.buildArtifacts({ operationId: op, lease })).images : [image]);

    describe("build dispatch", () => {
      it.each(cases("build"))("refuses a changed %s before any build starts", async (component, row, gate) => {
        const { w, lease } = await approvedWorld(row);
        await row.mutate(w);
        const err = await w.activities.buildArtifacts({ operationId: op, lease }).catch((e: unknown) => e);
        expectGate(err, gate, component, "build dispatch");
        expect(w.build.started).toHaveLength(0);
      });
    });

    describe("apply dispatch", () => {
      it.each(cases("apply"))("refuses a changed %s before any apply write", async (component, row, gate) => {
        const { w, lease, plan } = await approvedWorld(row);
        await row.mutate(w);
        // The saved plan is the digest argument: the dispatch names the other plan.
        const dispatched = component === "savedPlan" ? SAVED_PLAN_OTHER : plan.planDigest;
        const err = await w.activities.applyInfrastructure({ operationId: op, planDigest: dispatched, lease }).catch((e: unknown) => e);
        expectGate(err, gate, component, "apply dispatch");
        expect(w.evidence.ofKind("tofu_apply")).toHaveLength(0);
        expect(w.events.ofType("resource.applied")).toHaveLength(0);
      });
    });

    describe("rollout dispatch", () => {
      it.each(cases("rollout"))("refuses a changed %s before the first rollout effect", async (component, row, gate) => {
        const { w, lease } = await approvedWorld(row);
        const images = await releaseImages(row, w, lease);
        await row.mutate(w);
        const err = await w.activities.deployWorkloads({ operationId: op, lease, images }).catch((e: unknown) => e);
        expectGate(err, gate, component, "rollout dispatch");
        expect(w.workloads.deployed).toHaveLength(0);
      });
    });

    describe("migration dispatch", () => {
      it.each(cases("migration"))("refuses a changed %s before the migration runs", async (component, row, gate) => {
        const { w, lease } = await approvedWorld(row);
        await w.activities.deployWorkloads({ operationId: op, lease, images: await releaseImages(row, w, lease) });
        await row.mutate(w);
        const err = await w.activities.runMigrations({ operationId: op, lease }).catch((e: unknown) => e);
        expectGate(err, gate, component, "migration dispatch");
        expect(w.migrations.runs).toHaveLength(0);
      });
    });
  });
});
