/** Process-entry wiring with isolated lifecycle/readiness model ports; no real SQL or Temporal proof. */
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import type { ReadinessChecks } from "../../workers/execution/health";

const fake = vi.hoisted(() => ({
  checks: undefined as ReadinessChecks | undefined,
  state: "CREATED", stopping: false,
  store: { query: vi.fn(async () => [{}]), close: vi.fn(async () => undefined) },
  openStore: vi.fn(), closeStore: vi.fn(), artifactJanitor: vi.fn(),
  endpointClose: vi.fn(async () => undefined), janitorStop: vi.fn(async () => undefined),
  temporalCheck: vi.fn(async () => ({})), connectionClose: vi.fn(async () => undefined),
  policy: vi.fn(async () => ({})), createWorker: vi.fn(), run: vi.fn(),
  validate: vi.fn(async () => undefined), reconcileValidate: vi.fn(),
  composeSweep: vi.fn(), sweepReady: vi.fn(async () => undefined), sweepPass: vi.fn(),
  openReconcileClient: vi.fn(), reconcileClientClose: vi.fn(async () => undefined),
  awaitPollers: vi.fn(), prepareSchedule: vi.fn(), monitorFactory: vi.fn(),
  refresh: vi.fn(), monitorStop: vi.fn(async () => undefined), shutdown: vi.fn(),
  pollersConfirmed: false, schedulePrepared: false,
  observation: { phase: "stale", observationCurrent: false, running: 0, completedAtUnixMs: 0,
    counts: { claimed: 0, reconciled: 0, nothingToReconcile: 0, busy: 0, ineligible: 0, failed: 0, deferred: 0, nudged: 0,
      driftDetected: 0, driftCleared: 0, openFindings: 0, unreadNodes: 0, repairsProposed: 0, repairsStarted: 0,
      repairsAwaitingApproval: 0, repairsDenied: 0, ms: 1, saturated: false, timedOut: false } },
  client: { modeled: "dedicated schedule client" },
  config: { temporal: { namespace: "synthetic-owned" }, taskQueue: "zenith-execution", identity: "synthetic-worker", healthLogIntervalMs: 0,
    reconcile: { mode: "provision", input: { contract: "zenith.reconcile-sweep.v1", maxEnvironments: 25, environmentConcurrency: 3 } } },
  createActivities: vi.fn(() => ({})),
  azureResolver: vi.fn(async () => null),
  dataConverter: { payloadCodecs: [{ synthetic: "codec" }] },
}));
vi.mock("@temporalio/worker", () => ({ DefaultLogger: class {}, Runtime: { install: vi.fn() }, Worker: { create: fake.createWorker }, NativeConnection: { connect: async () => ({ workflowService: { getSystemInfo: fake.temporalCheck }, withDeadline: (_: unknown, fn: () => unknown) => fn(), close: fake.connectionClose }) } }));
vi.mock("@temporalio/activity", async (original) => ({ ...await original<typeof import("@temporalio/activity")>(), Context: { current: vi.fn() } }));
vi.mock("node:fs/promises", () => ({ mkdir: async () => undefined }));
vi.mock("@/lib/platform/app", () => ({ ensurePlatformApp: async () => true }));
vi.mock("@/lib/platform/execution", () => ({ composeReconcileSweepRuntime: fake.composeSweep }));
vi.mock("@/lib/workflows/activities", () => ({ createActivities: fake.createActivities }));
vi.mock("@/lib/providers/azure/release/source-binding", () => ({ createAzureSourceStorageResolver: (db: unknown) => { expect(db).toBe(fake.store); return fake.azureResolver; } }));
vi.mock("@/lib/drivers/types", () => ({ listDrivers: () => ["aws", "kubernetes", "zenith", "gcp", "azure", "oci"].map((provider) => ({ provider })) }));
vi.mock("@/lib/policy", () => ({ loadPolicyEngine: fake.policy }));
vi.mock("@/lib/execution/plan-janitor", () => ({ startPlanArtifactJanitor: fake.artifactJanitor }));
vi.mock("../../workers/execution/startup", () => ({ ExecutionStartupError: class extends Error {}, validateExecutionConfiguration: fake.validate,
  validateReconcileWorkerConfiguration: fake.reconcileValidate, openExecutionStore: fake.openStore, closeExecutionStore: fake.closeStore,
  openReconcileWorkerClient: fake.openReconcileClient, prepareReconcileWorkerSchedule: fake.prepareSchedule, reconcileWorkerMonitor: fake.monitorFactory }));
vi.mock("../../workers/execution/config", () => ({ executionWorkerConfigFromEnv: () => fake.config }));
vi.mock("@/lib/workflows/config", () => ({ connectionOptionsFor: () => ({}), describeTemporalConfig: () => ({}) }));
vi.mock("../../workers/execution/lifecycle", () => ({ installShutdownHandlers: () => () => fake.stopping }));
vi.mock("../../workers/execution/run", () => ({ workflowSource: async () => ({ origin: "synthetic" }), workerOptions: (options: object) => options, awaitReconcilePollers: fake.awaitPollers }));
vi.mock("@/lib/workflows/codec", () => ({ temporalDataConverterFromEnv: () => fake.dataConverter }));
vi.mock("../../workers/execution/health", async (original) => ({ ...await original<typeof import("../../workers/execution/health")>(), startHealthServer: async ({ checks }: { checks: ReadinessChecks }) => { fake.checks = checks; return { port: 9464, close: fake.endpointClose }; } }));
import { readinessProbe } from "../../workers/execution/health";

let finish: ReturnType<typeof Promise.withResolvers<void>>;
const releaseModelGates: (() => void)[] = [];
const sweep = { assertReady: fake.sweepReady, activities: { sweepReconcilePass: fake.sweepPass } };
const monitor = { refresh: fake.refresh, stop: fake.monitorStop };
const logged = () => output.mock.calls.flatMap(([text]) => String(text).trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>));
let exited: MockInstance<typeof process.exit>;
let output: MockInstance<typeof process.stdout.write>;
beforeEach(() => {
  vi.resetModules(); vi.clearAllMocks(); releaseModelGates.length = 0; fake.checks = undefined; fake.state = "CREATED"; fake.stopping = false;
  fake.policy.mockResolvedValue({}); fake.temporalCheck.mockResolvedValue({});
  fake.pollersConfirmed = false; fake.schedulePrepared = false;
  fake.observation = { ...fake.observation, phase: "stale", observationCurrent: false, running: 0, completedAtUnixMs: Date.now() - 180_001 };
  fake.reconcileValidate.mockImplementation((config) => { expect(config).toBe(fake.config); });
  fake.composeSweep.mockImplementation(async (db) => { expect(db).toBe(fake.store); await sweep.assertReady(); return sweep; });
  fake.openReconcileClient.mockImplementation(async (config, converter) => {
    expect(config).toBe(fake.config); expect(converter).toBe(fake.dataConverter);
    return { client: fake.client, close: fake.reconcileClientClose };
  });
  fake.awaitPollers.mockImplementation(async (worker, client, config, startedAt) => {
    expect(worker.getState()).toBe("RUNNING"); expect(client).toBe(fake.client); expect(config).toBe(fake.config);
    expect(Number.isSafeInteger(startedAt)).toBe(true); expect(startedAt).toBeLessThanOrEqual(Date.now());
    fake.pollersConfirmed = true;
  });
  fake.prepareSchedule.mockImplementation(async (client, runtime, config) => {
    expect(fake.pollersConfirmed).toBe(true); expect(client).toBe(fake.client); expect(runtime).toBe(sweep); expect(config).toBe(fake.config.reconcile);
    fake.schedulePrepared = true;
  });
  fake.monitorFactory.mockImplementation((client, config) => {
    expect(fake.schedulePrepared).toBe(true); expect(client).toBe(fake.client); expect(config).toBe(fake.config.reconcile); return monitor;
  });
  // Explicit readback fixtures exercise wiring/freshness consumption, not the real inspector.
  fake.refresh.mockImplementation(async () => ({ ...fake.observation }));
  fake.validate.mockResolvedValue(undefined);
  fake.openStore.mockResolvedValue(fake.store);
  fake.artifactJanitor.mockReturnValue({ stop: fake.janitorStop });
  fake.closeStore.mockImplementation(async (db?: { close?: () => Promise<void> }) => {
    if (typeof db?.close === "function") await db.close();
  });
  finish = Promise.withResolvers<void>();
  fake.run.mockImplementation(() => { fake.state = "RUNNING"; return finish.promise; });
  fake.shutdown.mockImplementation(() => { fake.state = "STOPPED"; finish.resolve(); });
  fake.createWorker.mockResolvedValue({ getState: () => fake.state, run: fake.run, shutdown: fake.shutdown });
  exited = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
  output = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
});
afterEach(async () => {
  // Model gates and worker-run promises must drain even if an assertion fails.
  fake.stopping = true;
  for (const release of releaseModelGates) release();
  finish.resolve();
  try { if (fake.checks) await vi.waitFor(() => { expect(exited).toHaveBeenCalledOnce(); expect(fake.endpointClose).toHaveBeenCalledOnce(); expect(fake.closeStore).toHaveBeenCalledOnce(); }); }
  finally { vi.restoreAllMocks(); }
});

describe("worker health lifecycle wiring", () => {
  it("stays unready until polling with a loaded policy, probes live connections, drains unready and closes resources", async () => {
    const loaded = Promise.withResolvers<object>(); fake.policy.mockImplementation(() => loaded.promise);
    const clientOpened = Promise.withResolvers<void>(), pollersObserved = Promise.withResolvers<void>(), provisioned = Promise.withResolvers<void>();
    releaseModelGates.push(() => loaded.resolve({}), () => clientOpened.resolve(), () => pollersObserved.resolve(), () => provisioned.resolve());
    const opening = fake.openReconcileClient.getMockImplementation()!, polling = fake.awaitPollers.getMockImplementation()!, preparation = fake.prepareSchedule.getMockImplementation()!;
    fake.openReconcileClient.mockImplementation(async (...args) => { await clientOpened.promise; return opening(...args); });
    fake.awaitPollers.mockImplementation(async (...args) => { await pollersObserved.promise; return polling(...args); });
    fake.prepareSchedule.mockImplementation(async (...args) => { await provisioned.promise; return preparation(...args); });
    await import("../../workers/execution/worker");
    await vi.waitFor(() => expect(fake.policy).toHaveBeenCalledOnce());
    const probe = readinessProbe(fake.checks!);
    expect(await probe()).toMatchObject({ ready: false, checks: { temporal: "unknown", policy: "unavailable", reconciliation: "unknown" } });
    loaded.resolve({}); await vi.waitFor(() => expect(fake.openReconcileClient).toHaveBeenCalledOnce());
    expect(fake.run).toHaveBeenCalledOnce(); expect(fake.awaitPollers).not.toHaveBeenCalled();
    expect(fake.prepareSchedule).not.toHaveBeenCalled(); expect(fake.artifactJanitor).not.toHaveBeenCalled();
    expect(await probe()).toMatchObject({ ready: false, checks: { temporal: "ok", reconciliation: "unknown" } });
    clientOpened.resolve(); await vi.waitFor(() => expect(fake.awaitPollers).toHaveBeenCalledOnce());
    expect(fake.prepareSchedule).not.toHaveBeenCalled(); expect(fake.monitorFactory).not.toHaveBeenCalled();
    expect(await probe()).toMatchObject({ ready: false, checks: { reconciliation: "unknown" } });
    pollersObserved.resolve(); await vi.waitFor(() => expect(fake.prepareSchedule).toHaveBeenCalledOnce());
    expect(fake.pollersConfirmed).toBe(true); expect(fake.schedulePrepared).toBe(false);
    expect(fake.monitorFactory).not.toHaveBeenCalled(); expect(fake.artifactJanitor).not.toHaveBeenCalled();
    expect(await probe()).toMatchObject({ ready: false, checks: { reconciliation: "unknown" } });
    provisioned.resolve(); await vi.waitFor(() => expect(fake.artifactJanitor).toHaveBeenCalledOnce());
    expect(fake.validate).toHaveBeenCalledOnce(); expect(fake.reconcileValidate).toHaveBeenCalledExactlyOnceWith(fake.config);
    expect(fake.openStore).toHaveBeenCalledOnce();
    expect(fake.validate.mock.invocationCallOrder[0]).toBeLessThan(fake.reconcileValidate.mock.invocationCallOrder[0]);
    expect(fake.reconcileValidate.mock.invocationCallOrder[0]).toBeLessThan(fake.openStore.mock.invocationCallOrder[0]);
    expect(fake.openStore.mock.invocationCallOrder[0]).toBeLessThan(fake.policy.mock.invocationCallOrder[0]);
    expect(fake.policy.mock.invocationCallOrder[0]).toBeLessThan(fake.composeSweep.mock.invocationCallOrder[0]);
    expect(fake.composeSweep).toHaveBeenCalledExactlyOnceWith(fake.store); expect(fake.sweepReady).toHaveBeenCalledOnce();
    expect(fake.composeSweep.mock.invocationCallOrder[0]).toBeLessThan(fake.createWorker.mock.invocationCallOrder[0]);
    expect(fake.artifactJanitor).toHaveBeenCalledExactlyOnceWith(fake.store, expect.any(Function), { retentionPreview: undefined, settlement: { startClosure: expect.any(Function) } });
    expect(fake.createWorker.mock.invocationCallOrder[0]).toBeLessThan(fake.run.mock.invocationCallOrder[0]);
    expect(fake.run.mock.invocationCallOrder[0]).toBeLessThan(fake.openReconcileClient.mock.invocationCallOrder[0]);
    expect(fake.openReconcileClient.mock.invocationCallOrder[0]).toBeLessThan(fake.awaitPollers.mock.invocationCallOrder[0]);
    expect(fake.awaitPollers.mock.invocationCallOrder[0]).toBeLessThan(fake.prepareSchedule.mock.invocationCallOrder[0]);
    expect(fake.prepareSchedule.mock.invocationCallOrder[0]).toBeLessThan(fake.monitorFactory.mock.invocationCallOrder[0]);
    expect(fake.monitorFactory.mock.invocationCallOrder[0]).toBeLessThan(fake.refresh.mock.invocationCallOrder[0]);
    expect(fake.refresh.mock.invocationCallOrder[0]).toBeLessThan(fake.artifactJanitor.mock.invocationCallOrder[0]);
    expect(fake.createActivities).toHaveBeenCalledWith(expect.objectContaining({ sourceBundles: { azureStorage: fake.azureResolver } }));
    expect(fake.createWorker).toHaveBeenCalledWith(expect.objectContaining({ dataConverter: fake.dataConverter, activities: expect.objectContaining({ sweepReconcilePass: fake.sweepPass }) }));
    const staleCalls = fake.refresh.mock.calls.length;
    expect(await probe()).toMatchObject({ ready: false, checks: { reconciliation: "unavailable" } });
    expect(fake.refresh).toHaveBeenCalledTimes(staleCalls + 1);
    fake.observation = { ...fake.observation, phase: "completed", observationCurrent: true, running: 0, completedAtUnixMs: Date.now() };
    const liveChecks = fake.temporalCheck.mock.calls.length;
    expect(await probe()).toMatchObject({ ready: true, checks: { reconciliation: "ok" } });
    expect(fake.temporalCheck).toHaveBeenCalledTimes(liveChecks + 1);
    fake.observation = { ...fake.observation, phase: "stale", observationCurrent: false, completedAtUnixMs: Date.now() - 180_001 };
    expect(await probe()).toMatchObject({ ready: false, checks: { reconciliation: "unavailable" } });
    fake.observation = { ...fake.observation, phase: "completed", observationCurrent: true, running: 0, completedAtUnixMs: Date.now() };
    fake.temporalCheck.mockRejectedValue(new Error("synthetic-temporal-secret"));
    expect(await probe()).toMatchObject({ ready: false, checks: { temporal: "unavailable" } });
    fake.temporalCheck.mockResolvedValue({}); fake.stopping = true;
    const stoppingReads = fake.refresh.mock.calls.length;
    expect(await probe()).toMatchObject({ ready: false, checks: { temporal: "unavailable", reconciliation: "unavailable" } });
    expect(fake.refresh).toHaveBeenCalledTimes(stoppingReads);
    finish.resolve(); await vi.waitFor(() => expect(exited).toHaveBeenCalledWith(0));
    expect(fake.shutdown).toHaveBeenCalledOnce();
    expect(fake.endpointClose).toHaveBeenCalledOnce(); expect(fake.monitorStop).toHaveBeenCalledOnce(); expect(fake.janitorStop).toHaveBeenCalledOnce();
    expect(fake.reconcileClientClose).toHaveBeenCalledOnce(); expect(fake.connectionClose).toHaveBeenCalledOnce();
    expect(fake.closeStore).toHaveBeenCalledExactlyOnceWith(fake.store); expect(fake.store.close).toHaveBeenCalledOnce();
    expect(fake.shutdown.mock.invocationCallOrder[0]).toBeLessThan(fake.endpointClose.mock.invocationCallOrder[0]);
    expect(fake.endpointClose.mock.invocationCallOrder[0]).toBeLessThan(fake.monitorStop.mock.invocationCallOrder[0]);
    expect(fake.monitorStop.mock.invocationCallOrder[0]).toBeLessThan(fake.janitorStop.mock.invocationCallOrder[0]);
    expect(fake.janitorStop.mock.invocationCallOrder[0]).toBeLessThan(fake.reconcileClientClose.mock.invocationCallOrder[0]);
    expect(fake.reconcileClientClose.mock.invocationCallOrder[0]).toBeLessThan(fake.connectionClose.mock.invocationCallOrder[0]);
    expect(fake.connectionClose.mock.invocationCallOrder[0]).toBeLessThan(fake.store.close.mock.invocationCallOrder[0]);
    const statuses = logged().filter((line) => line.msg === "durable reconciliation status");
    expect(statuses).toHaveLength(1);
    expect(Object.keys(statuses[0]).sort()).toEqual(["completedAtUnixMs", "component", "counts", "level", "msg", "observationCurrent", "phase", "running", "time"]);
    expect(statuses[0]).toMatchObject({ level: "warn", phase: "stale", observationCurrent: false, running: 0, counts: fake.observation.counts });
    expect(Object.keys(statuses[0].counts as object).sort()).toEqual(["busy", "claimed", "deferred", "driftCleared", "driftDetected", "failed", "ineligible", "ms", "nothingToReconcile", "nudged", "openFindings", "reconciled", "repairsAwaitingApproval", "repairsDenied", "repairsProposed", "repairsStarted", "saturated", "timedOut", "unreadNodes"]);
    expect(output.mock.calls.map(([text]) => String(text)).join("")).not.toContain("synthetic-temporal-secret");
  });

  it.each(["postgres-store", "artifact-key", "packaged-tofu-identity"])("refuses a failed %s prerequisite before store composition or polling", async (prerequisite) => {
    const privateDetail = `synthetic-${prerequisite}-input`;
    fake.validate.mockRejectedValue(new Error(privateDetail));
    await import("../../workers/execution/worker");
    await vi.waitFor(() => expect(exited).toHaveBeenCalledWith(1));
    expect(fake.validate).toHaveBeenCalledOnce();
    expect(fake.reconcileValidate).not.toHaveBeenCalled();
    expect(fake.openStore).not.toHaveBeenCalled();
    expect(fake.policy).not.toHaveBeenCalled();
    expect(fake.createActivities).not.toHaveBeenCalled();
    expect(fake.createWorker).not.toHaveBeenCalled();
    expect(fake.run).not.toHaveBeenCalled();
    expect(fake.artifactJanitor).not.toHaveBeenCalled();
    for (const port of [fake.composeSweep, fake.openReconcileClient, fake.awaitPollers, fake.prepareSchedule, fake.monitorFactory]) expect(port).not.toHaveBeenCalled();
    expect(fake.endpointClose).toHaveBeenCalledOnce();
    expect(fake.closeStore).toHaveBeenCalledExactlyOnceWith(undefined);
    expect(fake.store.close).not.toHaveBeenCalled();
    expect(output.mock.calls.map(([text]) => String(text)).join("")).not.toContain(privateDetail);
  });

  it("refuses polling with an unloaded policy and closes health without logging the failed bundle input", async () => {
    fake.policy.mockRejectedValue(new Error("synthetic-policy-secret"));
    await import("../../workers/execution/worker"); await vi.waitFor(() => expect(exited).toHaveBeenCalledWith(1));
    expect(fake.createWorker).not.toHaveBeenCalled(); expect(fake.endpointClose).toHaveBeenCalledOnce();
    expect(fake.closeStore).toHaveBeenCalledExactlyOnceWith(fake.store); expect(fake.store.close).toHaveBeenCalledOnce();
    expect(fake.janitorStop).not.toHaveBeenCalled(); expect(fake.connectionClose).not.toHaveBeenCalled();
    for (const port of [fake.composeSweep, fake.openReconcileClient, fake.awaitPollers, fake.prepareSchedule, fake.monitorFactory, fake.reconcileClientClose, fake.monitorStop]) expect(port).not.toHaveBeenCalled();
    expect(fake.endpointClose.mock.invocationCallOrder[0]).toBeLessThan(fake.store.close.mock.invocationCallOrder[0]);
    expect(output.mock.calls.map(([text]) => String(text)).join("")).not.toContain("synthetic-policy-secret");
  });

  it("closes the Temporal connection and health listener if worker construction fails", async () => {
    fake.createWorker.mockRejectedValue(new Error("synthetic-worker-secret"));
    await import("../../workers/execution/worker"); await vi.waitFor(() => expect(exited).toHaveBeenCalledWith(1));
    expect(fake.endpointClose).toHaveBeenCalledOnce(); expect(fake.connectionClose).toHaveBeenCalledOnce();
    expect(fake.closeStore).toHaveBeenCalledExactlyOnceWith(fake.store); expect(fake.store.close).toHaveBeenCalledOnce();
    expect(fake.janitorStop).not.toHaveBeenCalled();
    for (const port of [fake.run, fake.openReconcileClient, fake.awaitPollers, fake.prepareSchedule, fake.monitorFactory, fake.reconcileClientClose, fake.monitorStop]) expect(port).not.toHaveBeenCalled();
    expect(fake.endpointClose.mock.invocationCallOrder[0]).toBeLessThan(fake.connectionClose.mock.invocationCallOrder[0]);
    expect(fake.connectionClose.mock.invocationCallOrder[0]).toBeLessThan(fake.store.close.mock.invocationCallOrder[0]);
    expect(output.mock.calls.map(([text]) => String(text)).join("")).not.toContain("synthetic-worker-secret");
  });

  it.each(["reconcile-composition", "reconcile-client", "reconcile-pollers", "reconcile-schedule"] as const)("refuses failed modeled %s readiness, drains started polling and preserves cleanup", async (stage) => {
    const detail = `synthetic-${stage}-secret`;
    const failing = { "reconcile-composition": fake.composeSweep, "reconcile-client": fake.openReconcileClient,
      "reconcile-pollers": fake.awaitPollers, "reconcile-schedule": fake.prepareSchedule }[stage]!;
    failing.mockRejectedValue(new Error(detail));
    await import("../../workers/execution/worker"); await vi.waitFor(() => expect(exited).toHaveBeenCalledWith(1));
    expect(await readinessProbe(fake.checks!)()).toMatchObject({ ready: false });
    expect(fake.artifactJanitor).not.toHaveBeenCalled(); expect(fake.janitorStop).not.toHaveBeenCalled();
    expect(fake.monitorFactory).not.toHaveBeenCalled(); expect(fake.monitorStop).not.toHaveBeenCalled();
    expect(fake.endpointClose).toHaveBeenCalledOnce(); expect(fake.closeStore).toHaveBeenCalledExactlyOnceWith(fake.store); expect(fake.store.close).toHaveBeenCalledOnce();
    if (stage === "reconcile-composition") {
      for (const port of [fake.createActivities, fake.createWorker, fake.run, fake.shutdown, fake.openReconcileClient, fake.connectionClose]) expect(port).not.toHaveBeenCalled();
    } else {
      expect(fake.run).toHaveBeenCalledOnce(); expect(fake.shutdown).toHaveBeenCalledOnce(); expect(fake.connectionClose).toHaveBeenCalledOnce();
      expect(fake.shutdown.mock.invocationCallOrder[0]).toBeLessThan(fake.endpointClose.mock.invocationCallOrder[0]);
      expect(fake.endpointClose.mock.invocationCallOrder[0]).toBeLessThan(fake.connectionClose.mock.invocationCallOrder[0]);
      expect(fake.connectionClose.mock.invocationCallOrder[0]).toBeLessThan(fake.store.close.mock.invocationCallOrder[0]);
    }
    if (stage === "reconcile-client") expect(fake.reconcileClientClose).not.toHaveBeenCalled();
    if (stage === "reconcile-pollers" || stage === "reconcile-schedule") {
      expect(fake.reconcileClientClose).toHaveBeenCalledOnce();
      expect(fake.endpointClose.mock.invocationCallOrder[0]).toBeLessThan(fake.reconcileClientClose.mock.invocationCallOrder[0]);
      expect(fake.reconcileClientClose.mock.invocationCallOrder[0]).toBeLessThan(fake.connectionClose.mock.invocationCallOrder[0]);
    }
    if (stage !== "reconcile-schedule") expect(fake.prepareSchedule).not.toHaveBeenCalled();
    expect(output.mock.calls.map(([text]) => String(text)).join("")).not.toContain(detail);
    expect(logged().find((line) => line.msg === "execution worker failed")).toMatchObject({ failureCategory: stage });
  });
});
