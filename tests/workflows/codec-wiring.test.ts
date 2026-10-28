/** Production construction paths with intercepted transport/startup; no real server. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defaultPayloadConverter, type DataConverter } from "@temporalio/common";
import { type WorkerOptions } from "@temporalio/worker";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { temporalConfigFromEnv, type TemporalConnectionConfig } from "@/lib/workflows/config";
import { closeWorkflowClients, resetAvailabilityCache, temporalAvailable, TemporalUnavailableError, workflowClient } from "@/lib/workflows/client";
import { TemporalCodecError, TemporalPayloadCodec } from "@/lib/workflows/codec";
import type { ReconcileObservation, ReconcileSweepRuntime } from "@/lib/workflows/reconcile-schedule";
import type { ExecutionWorkerConfig, ReconcileWorkerConfig } from "../../workers/execution/config";

const CURRENT = "11".repeat(32);
const PREVIOUS = "22".repeat(32);
const TLS = {
  serverRootCACertificate: Buffer.from("-----BEGIN CERTIFICATE-----\nsynthetic-ca\n-----END CERTIFICATE-----"),
  clientCertPair: {
    crt: Buffer.from("-----BEGIN CERTIFICATE-----\nsynthetic-client\n-----END CERTIFICATE-----"),
    key: Buffer.from("-----BEGIN PRIVATE KEY-----\nsynthetic-private-key\n-----END PRIVATE KEY-----"),
  },
  serverNameOverride: "mtls-server.invalid",
};
const tlsConfig: TemporalConnectionConfig = { address: "mtls-test.invalid:7233", namespace: "default", tls: true, tlsOptions: TLS };
const directories: string[] = [];
const intercepted = vi.hoisted(() => ({
  client: vi.fn(), connect: vi.fn(), nativeConnect: vi.fn(), createWorker: vi.fn(),
  health: vi.fn(), validate: vi.fn(),
  openStore: vi.fn(), closeStore: vi.fn(),
  store: { query: vi.fn(), close: vi.fn() },
  healthClose: vi.fn(), janitorStop: vi.fn(), nativeClose: vi.fn(), artifactJanitor: vi.fn(),
  composeSweep: vi.fn<(db: unknown) => Promise<ReconcileSweepRuntime>>(),
  sourceStorage: vi.fn<(db: unknown) => () => Promise<null>>(), storageResolver: vi.fn<() => Promise<null>>(),
  activities: vi.fn<(options: unknown) => Record<string, never>>(),
  mixedActivities: vi.fn<() => Record<string, never>>(),
  codingActivities: vi.fn<() => Record<string, never>>(),
  criticalActivities: vi.fn<(db: unknown) => Record<string, never>>(),
  criticalHealth: vi.fn<() => Promise<{ healthy: boolean; jobs: [] }>>(),
  sweep: { assertReady: vi.fn<ReconcileSweepRuntime["assertReady"]>(), activities: { sweepReconcilePass: vi.fn<ReconcileSweepRuntime["activities"]["sweepReconcilePass"]>() } },
  validateReconcile: vi.fn<(config: ExecutionWorkerConfig) => void>(),
  reconcileClient: Object.freeze({ fixture: "modeled-reconciliation-client" }),
  openReconcileClient: vi.fn<(config: ExecutionWorkerConfig, converter: DataConverter) => Promise<{ client: unknown; close(): Promise<void> }>>(),
  awaitPollers: vi.fn<(worker: unknown, client: unknown, config: ExecutionWorkerConfig, startedAt: number) => Promise<void>>(),
  prepareSchedule: vi.fn<(client: unknown, runtime: ReconcileSweepRuntime, config: ReconcileWorkerConfig) => Promise<void>>(),
  monitor: vi.fn<(client: unknown, config: ReconcileWorkerConfig) => { refresh(): Promise<ReconcileObservation>; stop(): Promise<void> }>(),
  refreshReconcile: vi.fn<() => Promise<ReconcileObservation>>(), monitorStop: vi.fn<() => Promise<void>>(), reconcileClientClose: vi.fn<() => Promise<void>>(),
  workerRun: vi.fn<() => Promise<void>>(), workerShutdown: vi.fn<() => void>(),
}));

vi.mock("@temporalio/client", async (original) => {
  const sdk = await original<typeof import("@temporalio/client")>();
  return {
    ...sdk,
    Connection: { connect: intercepted.connect },
    Client: class { constructor(options: unknown) { intercepted.client(options); } },
  };
});
vi.mock("@temporalio/worker", async (original) => {
  const sdk = await original<typeof import("@temporalio/worker")>();
  return { ...sdk, NativeConnection: { connect: intercepted.nativeConnect }, Worker: { create: intercepted.createWorker }, Runtime: { install: vi.fn() } };
});
vi.mock("node:fs/promises", async (original) => ({ ...await original<typeof import("node:fs/promises")>(), mkdir: vi.fn() }));
vi.mock("@/lib/platform/app", () => ({ ensurePlatformApp: vi.fn(async () => true) }));
// Intercept the default composition imports themselves, before their product
// store graph can validate process environment during worker module loading.
vi.mock("@/lib/platform/execution", () => ({ composeReconcileSweepRuntime: intercepted.composeSweep }));
vi.mock("@/lib/providers/azure/release/source-binding", () => ({ createAzureSourceStorageResolver: intercepted.sourceStorage }));
vi.mock("@/lib/policy", () => ({ loadPolicyEngine: vi.fn() }));
vi.mock("@/lib/execution/plan-janitor", () => ({ startPlanArtifactJanitor: intercepted.artifactJanitor }));
vi.mock("@/lib/workflows/activities", () => ({ createActivities: intercepted.activities }));
vi.mock("@/lib/workflows/critical-activities", () => ({ createCriticalMaintenanceActivities: intercepted.criticalActivities }));
vi.mock("@/lib/workflows/mixed-activities", () => ({ createMixedActivities: intercepted.mixedActivities }));
vi.mock("@/lib/coding-agent/activities", () => ({ createProductionCodingAgentActivities: intercepted.codingActivities }));
vi.mock("@/lib/platform/critical-jobs", () => ({ criticalJobHealth: intercepted.criticalHealth }));
vi.mock("../../workers/execution/lifecycle", () => ({ installShutdownHandlers: () => () => false }));
vi.mock("../../workers/execution/startup", () => ({
  ExecutionStartupError: class extends Error {},
  validateExecutionConfiguration: intercepted.validate,
  openExecutionStore: intercepted.openStore,
  closeExecutionStore: intercepted.closeStore,
  validateReconcileWorkerConfiguration: intercepted.validateReconcile,
  openReconcileWorkerClient: intercepted.openReconcileClient,
  prepareReconcileWorkerSchedule: intercepted.prepareSchedule,
  reconcileWorkerMonitor: intercepted.monitor,
}));
vi.mock("../../workers/execution/health", () => ({ healthPortFromEnv: () => 9464, startHealthServer: intercepted.health, HEALTH_CHECK_TIMEOUT_MS: 2000 }));
vi.mock("../../workers/execution/run", async (original) => ({
  ...await original<typeof import("../../workers/execution/run")>(),
  workflowSource: async () => ({ workflowBundle: { code: "intercepted-bundle" }, origin: "prebuilt-bundle" }),
  awaitReconcilePollers: intercepted.awaitPollers,
}));

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("NODE_ENV", "production");
  vi.stubEnv("ZENITH_SECRET_KEY", CURRENT);
  vi.stubEnv("ZENITH_TEMPORAL_PREVIOUS_SECRET_KEYS", undefined);
  intercepted.validate.mockResolvedValue(undefined);
  intercepted.openStore.mockResolvedValue(intercepted.store);
  intercepted.composeSweep.mockResolvedValue(intercepted.sweep);
  intercepted.sourceStorage.mockReturnValue(intercepted.storageResolver);
  intercepted.activities.mockReturnValue({});
  intercepted.criticalActivities.mockReturnValue({});
  intercepted.mixedActivities.mockReturnValue({});
  intercepted.codingActivities.mockReturnValue({});
  intercepted.criticalHealth.mockResolvedValue({ healthy: true, jobs: [] });
  intercepted.sweep.assertReady.mockResolvedValue(undefined);
  intercepted.validateReconcile.mockImplementation(() => undefined);
  intercepted.openReconcileClient.mockResolvedValue({ client: intercepted.reconcileClient, close: intercepted.reconcileClientClose });
  intercepted.awaitPollers.mockResolvedValue(undefined);
  intercepted.prepareSchedule.mockResolvedValue(undefined);
  intercepted.monitor.mockReturnValue({ refresh: intercepted.refreshReconcile, stop: intercepted.monitorStop });
  intercepted.refreshReconcile.mockResolvedValue({ phase: "missing", observationCurrent: false, running: 0 });
  intercepted.monitorStop.mockResolvedValue(undefined);
  intercepted.reconcileClientClose.mockResolvedValue(undefined);
  intercepted.workerRun.mockResolvedValue(undefined);
  intercepted.artifactJanitor.mockReturnValue({ stop: intercepted.janitorStop });
  intercepted.closeStore.mockImplementation(async (db?: { close?: () => Promise<void> }) => {
    if (typeof db?.close === "function") await db.close();
  });
  intercepted.store.close.mockResolvedValue(undefined);
  intercepted.connect.mockResolvedValue({ close: vi.fn(async () => undefined), workflowService: { describeNamespace: vi.fn(async () => ({})) } });
});
afterEach(async () => {
  await closeWorkflowClients();
  resetAvailabilityCache();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  for (const directory of directories.splice(0)) {
    if (path.dirname(path.resolve(directory)) !== path.resolve(os.tmpdir())) throw new Error("Unexpected test directory");
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("workflow client and probe mTLS wiring (mocked SDK)", () => {
  it("passes the exact TLS bytes and server identity to Connection.connect", async () => {
    await workflowClient(tlsConfig);
    expect(intercepted.connect).toHaveBeenCalledWith({ address: tlsConfig.address, tls: TLS, connectTimeout: 5000 });
    expect(intercepted.client.mock.calls[0][0]).not.toHaveProperty("tls");
  });

  it.each(["CA", "certificate", "private key", "server name"])("isolates clients and availability results after a %s change", async (field) => {
    const changed = { ...TLS, clientCertPair: { ...TLS.clientCertPair } };
    if (field === "CA") changed.serverRootCACertificate = Buffer.from("different-ca");
    if (field === "certificate") changed.clientCertPair.crt = Buffer.from("different-certificate");
    if (field === "private key") changed.clientCertPair.key = Buffer.from("different-private-key");
    if (field === "server name") changed.serverNameOverride = "another-server.invalid";
    const next = { ...tlsConfig, tlsOptions: changed };
    const first = await workflowClient(tlsConfig);
    const sameBytes = { ...tlsConfig, tlsOptions: { ...TLS, serverRootCACertificate: Buffer.from(TLS.serverRootCACertificate), clientCertPair: { crt: Buffer.from(TLS.clientCertPair.crt), key: Buffer.from(TLS.clientCertPair.key) } } };
    expect(await workflowClient(sameBytes)).toBe(first);
    expect(await workflowClient(next)).not.toBe(first);
    expect(intercepted.connect).toHaveBeenCalledTimes(2);
    const available = await temporalAvailable({ config: tlsConfig, ttlMs: 60_000 });
    expect(available.available).toBe(true);
    expect(await temporalAvailable({ config: sameBytes, ttlMs: 60_000 })).toBe(available);
    expect(await temporalAvailable({ config: next, ttlMs: 60_000 })).not.toBe(available);
    expect(intercepted.connect).toHaveBeenCalledTimes(4);
    expect(intercepted.connect.mock.calls[2][0]).toEqual({ address: tlsConfig.address, tls: TLS, connectTimeout: 2000 });
  });

  it("does not share a default TLS connection with custom TLS", async () => {
    const defaults = { address: tlsConfig.address, namespace: tlsConfig.namespace, tls: true };
    const first = await workflowClient(defaults);
    expect(await workflowClient(tlsConfig)).not.toBe(first);
    expect(intercepted.connect).toHaveBeenCalledTimes(2);
  });

  it.each([
    [16, "authentication failure", "unauthenticated"],
    [5, "missing namespace", "namespace_not_found"],
    [14, "ECONNREFUSED", "unreachable"],
    [undefined, "TLS failure", "error"],
  ])("sanitizes transport error #%# without losing its probe category", async (code, prefix, reason) => {
    const config = { ...tlsConfig, apiKey: "synthetic-api-key" };
    const leaked = [TLS.serverRootCACertificate, TLS.clientCertPair.crt, TLS.clientCertPair.key].map((value) => value.toString()).join(" ");
    intercepted.connect.mockRejectedValue(Object.assign(new Error(`${prefix}: ${leaked} ${JSON.stringify(TLS.clientCertPair.key)} ${config.apiKey}`), { code }));
    const error: unknown = await workflowClient(config).catch((err: unknown) => err);
    expect(error).toBeInstanceOf(TemporalUnavailableError);
    expect(error).not.toHaveProperty("cause");
    const probe = await temporalAvailable({ config, ttlMs: 0 });
    expect(probe).toMatchObject({ available: false, reason });
    const publicText = `${String(error)} ${JSON.stringify(probe)}`;
    expect(publicText).not.toMatch(/BEGIN|synthetic-|"data":|"type":"Buffer"/);
    expect(publicText).toContain("check certificates");
    // Failed clients are evicted and retried with the same options.
    await expect(workflowClient(config)).rejects.toBeInstanceOf(TemporalUnavailableError);
    expect(intercepted.connect).toHaveBeenCalledTimes(3);
  });
});

describe("workflow client codec wiring", () => {
  const config = temporalConfigFromEnv({ ZENITH_TEMPORAL_ADDRESS: "codec-test.invalid:7233" });

  it("passes the codec to the SDK and shares connections for identical encryption config", async () => {
    const first = await workflowClient(config);
    expect(await workflowClient({ ...config })).toBe(first);
    expect(intercepted.connect).toHaveBeenCalledOnce();
    const options = intercepted.client.mock.calls[0][0] as { dataConverter: DataConverter };
    const codec = options.dataConverter.payloadCodecs![0];
    const payload = defaultPayloadConverter.toPayload("synthetic-canary");
    expect(defaultPayloadConverter.fromPayload((await codec.decode(await codec.encode([payload])))[0])).toBe("synthetic-canary");
  });

  it.each([undefined, "", "invalid-test-key"])("refuses production key #%# before connection", async (key) => {
    vi.stubEnv("ZENITH_SECRET_KEY", key);
    await expect(workflowClient(config)).rejects.toBeInstanceOf(TemporalCodecError);
    expect(intercepted.connect).not.toHaveBeenCalled();
    expect(intercepted.client).not.toHaveBeenCalled();
  });

  it("revalidates keys even if an encrypted client is already cached", async () => {
    await workflowClient(config);
    vi.stubEnv("ZENITH_SECRET_KEY", undefined);
    await expect(workflowClient(config)).rejects.toBeInstanceOf(TemporalCodecError);
    expect(intercepted.connect).toHaveBeenCalledOnce();
  });

  it("rebuilds the converter after a key rotation or retained-key change", async () => {
    const first = await workflowClient(config);
    vi.stubEnv("ZENITH_SECRET_KEY", PREVIOUS);
    const second = await workflowClient(config);
    expect(second).not.toBe(first);
    vi.stubEnv("ZENITH_TEMPORAL_PREVIOUS_SECRET_KEYS", JSON.stringify([CURRENT]));
    const third = await workflowClient(config);
    expect(third).not.toBe(second);
    const converter = intercepted.client.mock.calls[2][0].dataConverter as DataConverter;
    const payload = await new TemporalPayloadCodec(CURRENT).encode([defaultPayloadConverter.toPayload("old history")]);
    expect(defaultPayloadConverter.fromPayload((await converter.payloadCodecs![0].decode(payload))[0])).toBe("old history");
    vi.stubEnv("ZENITH_TEMPORAL_PREVIOUS_SECRET_KEYS", JSON.stringify([CURRENT, CURRENT]));
    expect(await workflowClient(config)).toBe(third);
    vi.stubEnv("ZENITH_TEMPORAL_PREVIOUS_SECRET_KEYS", undefined);
    expect(await workflowClient(config)).toBe(second);
    expect(intercepted.connect).toHaveBeenCalledTimes(3);
  });

  it("does not reuse a plaintext development client after encryption is configured", async () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("ZENITH_SECRET_KEY", undefined);
    const plaintext = await workflowClient(config);
    expect(intercepted.client.mock.calls[0][0].dataConverter.payloadCodecs).toEqual([]);
    vi.stubEnv("ZENITH_SECRET_KEY", CURRENT);
    expect(await workflowClient(config)).not.toBe(plaintext);
    expect(intercepted.connect).toHaveBeenCalledTimes(2);
  });
});

describe("execution worker process codec wiring", () => {
  function interceptProcess() {
    vi.resetModules();
    vi.stubEnv("ZENITH_WORKER_HEALTH_LOG_INTERVAL_MS", "0");
    vi.stubEnv("ZENITH_WORKER_RECONCILE_SCHEDULE_MODE", "observe");
    vi.stubEnv("ZENITH_WORKER_RECONCILE_MAX_ENVIRONMENTS", "25");
    vi.stubEnv("ZENITH_WORKER_RECONCILE_CONCURRENCY", "3");
    const exit = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    intercepted.health.mockResolvedValue({ port: 9464, close: intercepted.healthClose });
    intercepted.nativeConnect.mockResolvedValue({ close: intercepted.nativeClose });
    let state: "RUNNING" | "STOPPED" = "RUNNING";
    intercepted.workerShutdown.mockImplementation(() => { state = "STOPPED"; });
    intercepted.createWorker.mockResolvedValue({ run: intercepted.workerRun, getState: () => state, shutdown: intercepted.workerShutdown });
    return { exit, stdout };
  }

  function expectSuccessfulCleanup() {
    expect(intercepted.validate).toHaveBeenCalledOnce();
    expect(intercepted.validateReconcile).toHaveBeenCalledOnce();
    expect(intercepted.openStore).toHaveBeenCalledOnce();
    expect(intercepted.validate.mock.invocationCallOrder[0]).toBeLessThan(intercepted.openStore.mock.invocationCallOrder[0]);
    expect(intercepted.openStore.mock.invocationCallOrder[0]).toBeLessThan(intercepted.nativeConnect.mock.invocationCallOrder[0]);
    const config = intercepted.validateReconcile.mock.calls[0][0];
    const options = intercepted.createWorker.mock.calls[0][0] as WorkerOptions;
    expect(config.reconcile).toEqual({ mode: "observe", input: { contract: "zenith.reconcile-sweep.v1", maxEnvironments: 25, environmentConcurrency: 3 } });
    expect(intercepted.composeSweep).toHaveBeenCalledExactlyOnceWith(intercepted.store);
    expect(intercepted.sourceStorage).toHaveBeenCalledExactlyOnceWith(intercepted.store);
    expect(intercepted.activities).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ db: intercepted.store, workerIdentity: config.identity, sourceBundles: { azureStorage: intercepted.storageResolver } }));
    expect(intercepted.criticalActivities).toHaveBeenCalledExactlyOnceWith(intercepted.store);
    expect(intercepted.mixedActivities).toHaveBeenCalledExactlyOnceWith({ db: intercepted.store });
    expect(intercepted.codingActivities).toHaveBeenCalledExactlyOnceWith(intercepted.store);
    expect(intercepted.openStore.mock.invocationCallOrder[0]).toBeLessThan(intercepted.criticalActivities.mock.invocationCallOrder[0]);
    expect(intercepted.criticalActivities.mock.invocationCallOrder[0]).toBeLessThan(intercepted.nativeConnect.mock.invocationCallOrder[0]);
    expect(options.activities).toHaveProperty("sweepReconcilePass", intercepted.sweep.activities.sweepReconcilePass);
    expect(intercepted.workerRun).toHaveBeenCalledOnce();
    expect(intercepted.openReconcileClient).toHaveBeenCalledExactlyOnceWith(config, options.dataConverter);
    expect(intercepted.awaitPollers).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ run: intercepted.workerRun, shutdown: intercepted.workerShutdown }), intercepted.reconcileClient, config, expect.any(Number));
    expect(intercepted.prepareSchedule).toHaveBeenCalledExactlyOnceWith(intercepted.reconcileClient, intercepted.sweep, config.reconcile);
    expect(intercepted.monitor).toHaveBeenCalledExactlyOnceWith(intercepted.reconcileClient, config.reconcile);
    expect(intercepted.refreshReconcile).toHaveBeenCalledOnce();
    expect(intercepted.workerRun.mock.invocationCallOrder[0]).toBeLessThan(intercepted.openReconcileClient.mock.invocationCallOrder[0]);
    expect(intercepted.awaitPollers.mock.invocationCallOrder[0]).toBeLessThan(intercepted.prepareSchedule.mock.invocationCallOrder[0]);
    expect(intercepted.prepareSchedule.mock.invocationCallOrder[0]).toBeLessThan(intercepted.artifactJanitor.mock.invocationCallOrder[0]);
    expect(intercepted.artifactJanitor).toHaveBeenCalledExactlyOnceWith(intercepted.store, expect.any(Function), { retentionPreview: undefined, settlement: { startClosure: expect.any(Function) } });
    expect(intercepted.createWorker.mock.invocationCallOrder[0]).toBeLessThan(intercepted.artifactJanitor.mock.invocationCallOrder[0]);
    expect(intercepted.closeStore).toHaveBeenCalledExactlyOnceWith(intercepted.store);
    expect(intercepted.store.close).toHaveBeenCalledOnce();
    expect(intercepted.healthClose).toHaveBeenCalledOnce();
    expect(intercepted.janitorStop).toHaveBeenCalledOnce();
    expect(intercepted.nativeClose).toHaveBeenCalledOnce();
    expect(intercepted.workerShutdown).toHaveBeenCalledOnce();
    expect(intercepted.monitorStop).toHaveBeenCalledOnce();
    expect(intercepted.reconcileClientClose).toHaveBeenCalledOnce();
    expect(intercepted.workerShutdown.mock.invocationCallOrder[0]).toBeLessThan(intercepted.healthClose.mock.invocationCallOrder[0]);
    expect(intercepted.healthClose.mock.invocationCallOrder[0]).toBeLessThan(intercepted.monitorStop.mock.invocationCallOrder[0]);
    expect(intercepted.monitorStop.mock.invocationCallOrder[0]).toBeLessThan(intercepted.janitorStop.mock.invocationCallOrder[0]);
    expect(intercepted.janitorStop.mock.invocationCallOrder[0]).toBeLessThan(intercepted.reconcileClientClose.mock.invocationCallOrder[0]);
    expect(intercepted.reconcileClientClose.mock.invocationCallOrder[0]).toBeLessThan(intercepted.nativeClose.mock.invocationCallOrder[0]);
    expect(intercepted.healthClose.mock.invocationCallOrder[0]).toBeLessThan(intercepted.janitorStop.mock.invocationCallOrder[0]);
    expect(intercepted.janitorStop.mock.invocationCallOrder[0]).toBeLessThan(intercepted.nativeClose.mock.invocationCallOrder[0]);
    expect(intercepted.nativeClose.mock.invocationCallOrder[0]).toBeLessThan(intercepted.store.close.mock.invocationCallOrder[0]);
  }

  function configureTlsFiles() {
    const directory = mkdtempSync(path.join(os.tmpdir(), "zenith-mtls-worker-"));
    directories.push(directory);
    for (const [variable, value] of [
      ["ZENITH_TEMPORAL_TLS_CA_FILE", TLS.serverRootCACertificate],
      ["ZENITH_TEMPORAL_TLS_CERT_FILE", TLS.clientCertPair.crt],
      ["ZENITH_TEMPORAL_TLS_KEY_FILE", TLS.clientCertPair.key],
    ] as const) {
      const file = path.join(directory, `${variable}.pem`);
      writeFileSync(file, value);
      vi.stubEnv(variable, file);
    }
    vi.stubEnv("ZENITH_TEMPORAL_TLS_SERVER_NAME", TLS.serverNameOverride);
    vi.stubEnv("ZENITH_TEMPORAL_TLS", "false");
  }

  it("passes mTLS files to NativeConnection.connect and keeps ready logs and worker payloads safe", async () => {
    const { exit, stdout } = interceptProcess();
    configureTlsFiles();
    await import("../../workers/execution/worker");
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(0));
    expectSuccessfulCleanup();
    expect(intercepted.nativeConnect).toHaveBeenCalledWith({ address: "localhost:7233", tls: TLS });
    const options = intercepted.createWorker.mock.calls[0][0] as WorkerOptions;
    expect(options).not.toHaveProperty("tls");
    expect(JSON.stringify(options)).not.toMatch(/BEGIN|synthetic-private-key/);
    const logs = JSON.stringify(stdout.mock.calls);
    expect(logs).toContain('\\"tlsKey\\":\\"set\\"');
    expect(logs).not.toMatch(/BEGIN|synthetic-|\.pem|mtls-server/);
    expect(logs).not.toContain(CURRENT);
  });

  it.each(["postgres-store", "artifact-key", "packaged-tofu-identity"])("refuses a failed %s startup prerequisite while preserving private codec and transport inputs", async (prerequisite) => {
    const { exit, stdout } = interceptProcess();
    const privateDetail = `synthetic-${prerequisite}-input`;
    intercepted.validate.mockRejectedValue(new Error(privateDetail));
    await import("../../workers/execution/worker");
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(1));
    expect(intercepted.validate).toHaveBeenCalledOnce();
    expect(intercepted.openStore).not.toHaveBeenCalled();
    expect(intercepted.validateReconcile).not.toHaveBeenCalled();
    expect(intercepted.composeSweep).not.toHaveBeenCalled();
    expect(intercepted.sourceStorage).not.toHaveBeenCalled();
    expect(intercepted.openReconcileClient).not.toHaveBeenCalled();
    expect(intercepted.nativeConnect).not.toHaveBeenCalled();
    expect(intercepted.createWorker).not.toHaveBeenCalled();
    expect(intercepted.artifactJanitor).not.toHaveBeenCalled();
    expect(intercepted.healthClose).toHaveBeenCalledOnce();
    expect(intercepted.closeStore).toHaveBeenCalledExactlyOnceWith(undefined);
    expect(intercepted.store.close).not.toHaveBeenCalled();
    expect(JSON.stringify(stdout.mock.calls)).not.toContain(privateDetail);
    expect(JSON.stringify(stdout.mock.calls)).not.toContain(CURRENT);
  });

  it("rejects an incomplete mTLS identity before worker startup side effects", async () => {
    const { exit, stdout } = interceptProcess();
    vi.stubEnv("ZENITH_TEMPORAL_TLS_CERT_FILE", "synthetic-private-path");
    vi.stubEnv("ZENITH_TEMPORAL_TLS_KEY_FILE", undefined);
    await import("../../workers/execution/worker");
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(1));
    expect(intercepted.health).not.toHaveBeenCalled();
    expect(intercepted.validate).not.toHaveBeenCalled();
    expect(intercepted.nativeConnect).not.toHaveBeenCalled();
    expect(intercepted.openStore).not.toHaveBeenCalled();
    expect(intercepted.closeStore).not.toHaveBeenCalled();
    expect(intercepted.composeSweep).not.toHaveBeenCalled();
    expect(intercepted.sourceStorage).not.toHaveBeenCalled();
    expect(intercepted.openReconcileClient).not.toHaveBeenCalled();
    expect(JSON.stringify(stdout.mock.calls)).not.toContain("synthetic-private-path");
  });

  it("keeps worker transport failure details private", async () => {
    const { exit, stdout } = interceptProcess();
    configureTlsFiles();
    intercepted.nativeConnect.mockRejectedValue(new Error(`${TLS.clientCertPair.key.toString()} ${JSON.stringify(TLS.clientCertPair.key)}`));
    await import("../../workers/execution/worker");
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(1));
    expect(intercepted.nativeConnect).toHaveBeenCalledOnce();
    expect(intercepted.createWorker).not.toHaveBeenCalled();
    expect(intercepted.closeStore).toHaveBeenCalledExactlyOnceWith(intercepted.store);
    expect(intercepted.store.close).toHaveBeenCalledOnce();
    expect(intercepted.healthClose).toHaveBeenCalledOnce();
    expect(intercepted.nativeClose).not.toHaveBeenCalled();
    expect(intercepted.janitorStop).not.toHaveBeenCalled();
    expect(intercepted.composeSweep).toHaveBeenCalledExactlyOnceWith(intercepted.store);
    expect(intercepted.openReconcileClient).not.toHaveBeenCalled();
    expect(intercepted.monitorStop).not.toHaveBeenCalled();
    expect(intercepted.reconcileClientClose).not.toHaveBeenCalled();
    expect(intercepted.workerShutdown).not.toHaveBeenCalled();
    expect(intercepted.healthClose.mock.invocationCallOrder[0]).toBeLessThan(intercepted.store.close.mock.invocationCallOrder[0]);
    expect(JSON.stringify(stdout.mock.calls)).not.toMatch(/BEGIN|synthetic-|"data":/);
  });

  it("attaches the same decrypt-compatible codec to Worker.create without changing other options", async () => {
    const { exit, stdout } = interceptProcess();
    vi.stubEnv("ZENITH_TEMPORAL_PREVIOUS_SECRET_KEYS", JSON.stringify([PREVIOUS]));
    await import("../../workers/execution/worker");
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(0));
    expectSuccessfulCleanup();
    expect(intercepted.validate).toHaveBeenCalledOnce();
    const options = intercepted.createWorker.mock.calls[0][0] as WorkerOptions;
    expect(options).toMatchObject({ taskQueue: "zenith-execution", maxConcurrentActivityTaskExecutions: 8, workflowBundle: { code: "intercepted-bundle" } });
    const codec = options.dataConverter!.payloadCodecs![0];
    const oldPayload = await new TemporalPayloadCodec(PREVIOUS).encode([defaultPayloadConverter.toPayload("old history")]);
    expect(defaultPayloadConverter.fromPayload((await codec.decode(oldPayload))[0])).toBe("old history");
    const newPayload = await codec.encode([defaultPayloadConverter.toPayload("current")]);
    expect(defaultPayloadConverter.fromPayload((await new TemporalPayloadCodec(CURRENT).decode(newPayload))[0])).toBe("current");
    expect(JSON.stringify(stdout.mock.calls)).not.toContain(CURRENT);
    expect(JSON.stringify(stdout.mock.calls)).not.toContain(PREVIOUS);
  });

  it.each([undefined, "", "invalid-test-key"])("rejects production key #%# before startup side effects", async (key) => {
    const { exit, stdout } = interceptProcess();
    vi.stubEnv("ZENITH_SECRET_KEY", key);
    await import("../../workers/execution/worker");
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(1));
    expect(intercepted.health).not.toHaveBeenCalled();
    expect(intercepted.validate).not.toHaveBeenCalled();
    expect(intercepted.nativeConnect).not.toHaveBeenCalled();
    expect(intercepted.createWorker).not.toHaveBeenCalled();
    expect(intercepted.openStore).not.toHaveBeenCalled();
    expect(intercepted.closeStore).not.toHaveBeenCalled();
    expect(intercepted.validateReconcile).not.toHaveBeenCalled();
    expect(intercepted.composeSweep).not.toHaveBeenCalled();
    expect(intercepted.sourceStorage).not.toHaveBeenCalled();
    expect(intercepted.openReconcileClient).not.toHaveBeenCalled();
    expect(intercepted.criticalActivities).not.toHaveBeenCalled();
    expect(intercepted.mixedActivities).not.toHaveBeenCalled();
    expect(intercepted.codingActivities).not.toHaveBeenCalled();
    expect(intercepted.criticalHealth).not.toHaveBeenCalled();
    expect(JSON.stringify(stdout.mock.calls)).not.toContain("invalid-test-key");
  });
});
