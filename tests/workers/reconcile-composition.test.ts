/** Contract models are labelled below. Integration requires real PG and an owned Temporal CLI. */
import { spawn, type ChildProcess } from "node:child_process";
import { generateKeyPairSync, randomBytes, randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { Context } from "@temporalio/activity";
import { Connection, ScheduleNotFoundError, ScheduleOverlapPolicy, type Client, type ScheduleDescription, type WorkflowHandle } from "@temporalio/client";
import { NativeConnection, Worker } from "@temporalio/worker";
import { tempDataDir } from "../_support/data-dir";
tempDataDir("zenith-reconcile-composition-");
const { executionWorkerConfigFromEnv, reconcileWorkerConfigFromEnv } = await import("../../workers/execution/config");
const { validateReconcileWorkerConfiguration, openReconcileWorkerClient, prepareReconcileWorkerSchedule, reconcileWorkerMonitor, openExecutionStore } = await import("../../workers/execution/startup");
const { workerOptions, awaitReconcilePollers } = await import("../../workers/execution/run");
const { readinessProbe } = await import("../../workers/execution/health");
const { openPlatformDb, repos } = await import("@/lib/controlplane/db");
const { createActivities } = await import("@/lib/workflows/activities");
const { composeReconcileSweepRuntime } = await import("@/lib/platform/execution");
const { temporalDataConverterFromEnv, TEMPORAL_PAYLOAD_ENCODING } = await import("@/lib/workflows/codec");
const { setPlatformBrokerForTests, resetPlatformBrokerForTests } = await import("@/lib/capabilities/platform");
const { registerEnvironment } = await import("@/lib/reconcile/platform");
const { inspectReconcileObservation, reconcileScheduleOptions, RECONCILE_SCHEDULE_ID, RECONCILE_SWEEP_CONTRACT, RECONCILE_SWEEP_TYPE, RECONCILE_SWEEP_LEASE } = await import("@/lib/workflows/reconcile-schedule");
const { emptyPassResult } = await import("@/lib/reconcile/pass");
const { TASK_QUEUE } = await import("@/lib/workflows/types");
const { findTemporalCli, waitFor, workflowBundlePath, DEFINITIONS_ENTRY } = await import("../workflows/support");
import type { PlatformDbHandle } from "@/lib/controlplane/db";
import type { Broker } from "@/lib/capabilities/platform";
import { createCriticalMaintenanceActivities } from "@/lib/workflows/critical-activities";
import { createProductionCodingAgentActivities } from "@/lib/coding-agent/activities";
import { createMixedActivities } from "@/lib/workflows/mixed-activities";
import type { ReconcileSweepResult } from "@/lib/workflows/definitions/reconcileSweep";
import type { RegisteredWorkerActivities } from "@/lib/workflows/types";
import type { ReconcileSweepRuntime } from "@/lib/workflows/reconcile-schedule";
import { approveAs, closeSharedPgliteAfterAll, makeHarness as brokerHarness, proposeOk, requestFor, systemPrincipal } from "../capabilities/support";

closeSharedPgliteAfterAll();

describe("reconciliation composition contract models", () => {
  afterEach(() => vi.restoreAllMocks());
  it.each([{ name: "crossed boundary", delay: 1_000, current: false }, { name: "still fresh", delay: 200, current: true }])("rechecks result freshness after an awaited read: $name", async ({ delay, current }) => {
    const closedAt = 1_700_000_000_000;
    let now = closedAt + 179_500;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const options = reconcileScheduleOptions();
    let enter!: () => void, release!: () => void;
    const entered = new Promise<void>(resolve => { enter = resolve; });
    const held = new Promise<void>(resolve => { release = resolve; });
    const description = { ...options, state: { paused: false },
      typedSearchAttributes: { get: () => RECONCILE_SWEEP_CONTRACT, getAll: () => options.typedSearchAttributes },
      raw: { schedule: { action: { startWorkflow: { taskQueue: { name: TASK_QUEUE, kind: 1 } } }, policies: {} } },
      info: { runningActions: [], recentActions: [{ action: { type: "startWorkflow", workflow: { workflowId: `${RECONCILE_SCHEDULE_ID}-owned`, firstExecutionRunId: "00000000-0000-4000-8000-000000000000" } } }] },
    } as unknown as ScheduleDescription;
    const handle = { describe: async () => ({ runId: "00000000-0000-4000-8000-000000000000", type: RECONCILE_SWEEP_TYPE, taskQueue: TASK_QUEUE, status: { name: "COMPLETED" }, closeTime: new Date(closedAt) }),
      result: async () => { enter(); await held; return { status: "completed", counts: emptyPassResult() }; } };
    const client = { schedule: { getHandle: () => ({ describe: async () => description }), withDeadline: async (_deadline: number, fn: () => Promise<unknown>) => fn() },
      workflow: { getHandle: () => handle, withDeadline: async (_deadline: number, fn: () => Promise<unknown>) => fn() },
    } as unknown as Client;
    const observing = inspectReconcileObservation(client);
    const outcome = observing.then(value => ({ value }), error => ({ error }));
    try { await Promise.race([entered, outcome.then(() => { throw new Error("Observation completed before its held result read."); })]); now += delay; } finally { release(); }
    expect(await outcome).toHaveProperty("value.observationCurrent", current);
    expect(await observing).toMatchObject({ phase: current ? "completed" : "stale", completedAtUnixMs: closedAt });
    // This is an explicit clock/result-delay contract model, not elapsed-age or server evidence.
  });
  it("requires explicit permission and bounded resource configuration", () => {
    expect(reconcileWorkerConfigFromEnv({})).toMatchObject({ mode: "observe", input: { maxEnvironments: 25, environmentConcurrency: 3 } });
    const narrow = reconcileWorkerConfigFromEnv({ ZENITH_WORKER_RECONCILE_SCHEDULE_MODE: "provision", ZENITH_WORKER_RECONCILE_MAX_ENVIRONMENTS: "1", ZENITH_WORKER_RECONCILE_CONCURRENCY: "1" });
    expect(narrow).toMatchObject({ mode: "provision", input: { maxEnvironments: 1, environmentConcurrency: 1 } });
    expect(Object.isFrozen(narrow)).toBe(true);
    for (const bad of [{ ZENITH_WORKER_RECONCILE_SCHEDULE_MODE: "true" }, { ZENITH_WORKER_RECONCILE_MAX_ENVIRONMENTS: "26" }, { ZENITH_WORKER_RECONCILE_CONCURRENCY: "4" }, { ZENITH_WORKER_RECONCILE_CONCURRENCY: "1.5" }]) expect(() => reconcileWorkerConfigFromEnv(bad)).toThrow();
  });
  it("keeps arbitrary queue parsing but refuses a worker unable to serve the fixed sweep", () => {
    const config = executionWorkerConfigFromEnv({ ZENITH_WORKER_TASK_QUEUE: "existing-custom-queue" });
    expect(config.taskQueue).toBe("existing-custom-queue");
    expect(() => validateReconcileWorkerConfiguration(config, { ZENITH_TEMPORAL_NAMESPACE: "default" })).toThrow("fixed durable");
    const fixed = executionWorkerConfigFromEnv({ ZENITH_TEMPORAL_NAMESPACE: "default" });
    expect(() => validateReconcileWorkerConfiguration(fixed, {})).toThrow("NAMESPACE");
    expect(() => validateReconcileWorkerConfiguration(fixed, { ZENITH_TEMPORAL_NAMESPACE: "default", NODE_ENV: "production" })).toThrow("authenticated");
  });
  it("retains the four-check health shape for old callers, but supplied reconciliation cannot be omitted", async () => {
    const checks = { temporal: () => true, store: () => true, policy: () => true, drivers: () => true };
    expect(await readinessProbe(checks)()).toEqual({ ready: true, checks: { temporal: "ok", store: "ok", policy: "ok", drivers: "ok" } });
    expect(await readinessProbe({ ...checks, reconciliation: () => undefined })()).toMatchObject({ ready: false, checks: { reconciliation: "unknown" } });
    expect(await readinessProbe({ ...checks, reconciliation: () => false })()).toMatchObject({ ready: false, checks: { reconciliation: "unavailable" } });
  });
  it("observes both current poller kinds and refuses a non-running worker before service queries", async () => {
    const startedAt = Date.now();
    const config = executionWorkerConfigFromEnv({ ZENITH_WORKER_IDENTITY: "owned-contract-poller" });
    const service = vi.fn(async (request: { taskQueueType: number }) => ({ pollers: [{ identity: config.identity, lastAccessTime: { seconds: Math.floor((startedAt + 1) / 1000), nanos: ((startedAt + 1) % 1000) * 1_000_000 } }], kind: request.taskQueueType }));
    const client = { connection: { withDeadline: async (_deadline: number, fn: () => Promise<unknown>) => fn() }, workflowService: { describeTaskQueue: service } } as unknown as Client;
    await expect(awaitReconcilePollers({ getState: () => "STOPPED" }, client, config, startedAt)).rejects.toThrow("not polling");
    expect(service).not.toHaveBeenCalled();
    await awaitReconcilePollers({ getState: () => "RUNNING" }, client, config, startedAt);
    expect(service.mock.calls.map(([request]) => request.taskQueueType)).toEqual([1, 2]);
    expect(service.mock.calls[0][0]).toMatchObject({ namespace: config.temporal.namespace, taskQueue: { name: TASK_QUEUE, kind: 1 } });
  });
  it("stale, foreign, malformed or workflow-only records never confirm current polling", async () => {
    const config = executionWorkerConfigFromEnv({ ZENITH_WORKER_IDENTITY: "owned-contract-poller" });
    for (const bad of ["stale", "foreign", "malformed", "workflow-only"]) {
      const startedAt = Date.now();
      let states = 0;
      const stamp = startedAt + (bad === "stale" ? -1 : 1);
      const service = vi.fn(async ({ taskQueueType }: { taskQueueType: number }) => ({ pollers: bad === "workflow-only" && taskQueueType === 2 ? [] : [{ identity: bad === "foreign" ? "other-poller" : config.identity, lastAccessTime: { seconds: Math.floor(stamp / 1000), nanos: bad === "malformed" ? 1_000_000_000 : (stamp % 1000) * 1_000_000 } }] }));
      const client = { connection: { withDeadline: async (_deadline: number, fn: () => Promise<unknown>) => fn() }, workflowService: { describeTaskQueue: service } } as unknown as Client;
      await expect(awaitReconcilePollers({ getState: () => ++states <= 2 ? "RUNNING" : "STOPPED" }, client, config, startedAt)).rejects.toThrow("not polling");
      // If an invalid record were accepted, the second RUNNING check would
      // return success. Reaching STOPPED establishes the refusal in this model.
      expect(states).toBe(3);
    }
  });
});

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => { const server = createServer(); server.once("error", reject); server.listen(0, "127.0.0.1", () => { const port = (server.address() as { port: number }).port; server.close(error => error ? reject(error) : resolve(port)); }); });
}
/** Only our random-port process and directory; never downloads or attaches to default Temporal. */
class OwnedTemporal {
  child?: ChildProcess;
  private closed = false;
  private served = false;
  constructor(readonly cli: string, readonly directory: string, private port: number) {}
  get address(): string { return `127.0.0.1:${this.port}`; }
  async start(): Promise<void> {
    if (this.port === 7233 || this.child) throw new Error("Invalid owned Temporal start.");
    // freePort() releases a port before Temporal binds it, so another process can take it first. An exit before
    // readiness gets fresh ports; the frontend port is kept once served, because a restart must keep its address.
    for (let attempt = 1; ; attempt += 1) {
      const exit = await this.spawnUntilReady();
      if (!exit) { this.served = true; return; }
      this.child = undefined;
      if (attempt === 3) throw new Error(`Owned Temporal exited before readiness (3 attempts): ${exit}`);
      if (!this.served) this.port = await freePort();
    }
  }
  /** Resolves undefined once the frontend answers, or the stderr tail when the process exits first. */
  private async spawnUntilReady(): Promise<string | undefined> {
    this.closed = false;
    this.child = spawn(this.cli, ["--disable-config-env", "--disable-config-file", "server", "start-dev", "--headless", "--ip", "127.0.0.1", "--port", String(this.port), "--http-port", String(await freePort()), "--metrics-port", String(await freePort()), "--db-filename", path.join(this.directory, "owned-temporal.sqlite"), "--search-attribute", "ZenithScheduleOwner=Keyword"], { stdio: ["ignore", "ignore", "pipe"], windowsHide: true });
    const child = this.child;
    let stderr = "";
    child.stderr?.on("data", (chunk: Buffer) => { stderr = (stderr + chunk.toString()).slice(-600); });
    child.once("close", () => { this.closed = true; });
    let failed: Error | undefined;
    child.once("error", (error) => { failed = error; });
    return waitFor("owned composition Temporal frontend", async () => {
      if (failed || child.exitCode !== null) return failed?.message ?? `exit ${child.exitCode}: ${stderr.trim() || "no stderr"}`;
      let connection: Connection | undefined;
      try { connection = await Connection.connect({ address: this.address, connectTimeout: 500 }); await connection.withDeadline(Date.now() + 500, () => connection!.workflowService.describeNamespace({ namespace: "default" })); return "ready"; }
      catch { return false; }
      finally { await connection?.close(); }
    }, 45_000).then((outcome) => outcome === "ready" ? undefined : outcome);
  }
  async stop(): Promise<void> {
    const child = this.child;
    this.child = undefined;
    if (!child || this.closed || child.exitCode !== null) return;
    const closed = once(child, "close");
    child.kill("SIGTERM");
    const timer = setTimeout(() => child.kill("SIGKILL"), 10_000);
    try { await closed; } finally { clearTimeout(timer); }
  }
}

describe("actual default activity composition: PostgreSQL and owned durable Temporal", () => {
  const enabled = process.env.ZENITH_TEST_RECONCILE_COMPOSITION === "1";
  let skipReason: string | undefined;
  let root = "";
  let server: OwnedTemporal | undefined;
  let db: PlatformDbHandle;
  let blocker: PlatformDbHandle;
  let observer: PlatformDbHandle;
  let bundle = "";
  let workerApplication = "";
  const started: WorkflowHandle[] = [];
  const previous = new Map<string, string | undefined>();
  const fixtures: string[] = [];
  const setEnv = (name: string, value: string | undefined) => { if (!previous.has(name)) previous.set(name, process.env[name]); if (value === undefined) delete process.env[name]; else process.env[name] = value; };
  const config = (mode: "observe" | "provision" = "observe") => executionWorkerConfigFromEnv({ ZENITH_TEMPORAL_ADDRESS: server!.address, ZENITH_TEMPORAL_NAMESPACE: "default", ZENITH_WORKER_IDENTITY: `owned-composition-${randomUUID()}`, ZENITH_WORKER_RECONCILE_SCHEDULE_MODE: mode, ZENITH_WORKER_SHUTDOWN_GRACE_MS: "2000", ZENITH_WORKER_HEARTBEAT_THROTTLE_MS: "100" });
  const converter = () => temporalDataConverterFromEnv();
  async function clientFor(mode: "observe" | "provision" = "observe") { return openReconcileWorkerClient(config(mode), converter()); }
  async function withWorker(body: (client: Client, runtime: ReconcileSweepRuntime, cfg: ReturnType<typeof config>) => Promise<void>, mode: "observe" | "provision" = "observe"): Promise<void> {
    const cfg = config(mode);
    const runtime = await composeReconcileSweepRuntime(db);
    const connection = await NativeConnection.connect({ address: server!.address });
    let worker: Worker | undefined;
    let running: Promise<void> | undefined;
    let client: Awaited<ReturnType<typeof clientFor>> | undefined;
    try {
      const activities: RegisteredWorkerActivities = { ...createActivities({ db, workerIdentity: cfg.identity, planDir: path.join(root, "plans"), ports: { heartbeat: detail => Context.current().heartbeat(detail), activitySignal: () => Context.current().cancellationSignal } }), ...runtime.activities, ...createCriticalMaintenanceActivities(db), ...createProductionCodingAgentActivities(db), ...createMixedActivities({ db }) };
      worker = await Worker.create({ ...workerOptions({ config: cfg, connection, activities, workflows: { workflowBundle: { codePath: bundle }, origin: "prebuilt-bundle" } }), dataConverter: converter() });
      const pollingStartedAt = Date.now();
      running = worker.run();
      void running.catch(() => undefined);
      client = await openReconcileWorkerClient(cfg, converter());
      await awaitReconcilePollers(worker, client.client, cfg, pollingStartedAt);
      await body(client.client, runtime, cfg);
    } finally {
      try { if (worker?.getState() === "RUNNING") worker.shutdown(); await running?.catch(() => undefined); }
      finally { try { await client?.close(); } finally { await connection.close(); } }
    }
  }
  async function scheduled(client: Client): Promise<WorkflowHandle> {
    // Workflow completion may precede the scheduler observing it, especially
    // after restart. Keep SKIP: wait for actual schedule quiescence first.
    const settled = await waitFor("composition schedule action settled", async () => {
      const current = await client.schedule.getHandle(RECONCILE_SCHEDULE_ID).describe();
      return current.info.runningActions.length === 0 ? current : false;
    });
    const before = settled.info.numActionsTaken;
    const triggeredAt = Date.now();
    await client.schedule.getHandle(RECONCILE_SCHEDULE_ID).trigger(ScheduleOverlapPolicy.SKIP);
    let lastObserved = settled;
    let description: ScheduleDescription;
    try {
      description = await waitFor("new composition schedule action", async () => {
        const current = await client.schedule.getHandle(RECONCILE_SCHEDULE_ID).describe();
        lastObserved = current;
        return current.info.numActionsTaken > before ? current : false;
      }, 30_000);
    } catch (cause) {
      if (!(cause instanceof Error) || cause.message !== "timed out waiting for new composition schedule action") throw cause;
      const latest = lastObserved.info.recentActions.at(-1);
      const action = latest?.action;
      const workflow = action?.type === "startWorkflow" ? action.workflow : undefined;
      const suffix = /^[A-Za-z0-9:.+-]{1,96}$/;
      const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
      const execution = workflow && workflow.workflowId.startsWith(`${RECONCILE_SCHEDULE_ID}-`) && suffix.test(workflow.workflowId.slice(RECONCILE_SCHEDULE_ID.length + 1)) && uuid.test(workflow.firstExecutionRunId)
        ? { workflowId: workflow.workflowId, firstExecutionRunId: workflow.firstExecutionRunId }
        : undefined;
      const diagnostic = {
        beforeNumActionsTaken: before,
        lastNumActionsTaken: lastObserved.info.numActionsTaken,
        runningActions: lastObserved.info.runningActions.length,
        recentActions: lastObserved.info.recentActions.length,
        latestActionType: action?.type ?? null,
        generatedExecution: execution ?? null,
        triggerOutcome: "resolved",
        elapsedMs: Math.max(0, Date.now() - triggeredAt),
      };
      throw new Error(`timed out waiting for new composition schedule action; diagnostic=${JSON.stringify(diagnostic)}`, { cause });
    }
    const action = description.info.recentActions.at(-1)?.action;
    if (!action || action.type !== "startWorkflow") throw new Error("Invalid schedule action.");
    const handle = client.workflow.getHandle(action.workflow.workflowId, action.workflow.firstExecutionRunId);
    started.push(handle);
    return handle;
  }
  beforeAll(async () => {
    if (!enabled) { skipReason = "Actual composition requires ZENITH_TEST_RECONCILE_COMPOSITION=1 and a fresh disposable local PostgreSQL database."; return; }
    const cli = findTemporalCli();
    const url = process.env.ZENITH_TEST_PLATFORM_PG_URL;
    if (!cli || !url) throw new Error("Required composition CLI/PostgreSQL prerequisites are absent; models cannot substitute.");
    const parsed = new URL(url);
    if (!["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname)) throw new Error("Composition acceptance requires an explicitly disposable local PostgreSQL URL.");
    root = await mkdtemp(path.join(os.tmpdir(), "zenith-owned-composition-"));
    server = new OwnedTemporal(cli, root, await freePort());
    try {
      workerApplication = `zenith-composition-${randomUUID()}`;
      parsed.searchParams.set("application_name", workerApplication);
      db = await openPlatformDb({ kind: "postgres", url: parsed.toString(), migrate: true, max: 5 });
      // The fixed fleet sweep must never encounter another suite's provider targets.
      expect(await db.query("select environment_id from platform.reconcile_state limit 1")).toEqual([]);
      expect(await db.query("select id from platform.operations limit 1")).toEqual([]);
      blocker = await openPlatformDb({ kind: "postgres", url, max: 1 });
      observer = await openPlatformDb({ kind: "postgres", url, max: 1 });
      setEnv("ZENITH_SECRET_KEY", randomBytes(32).toString("hex"));
      setEnv("ZENITH_TEMPORAL_PREVIOUS_SECRET_KEYS", undefined);
      setEnv("ZENITH_PLAN_ARTIFACT_KEY", randomBytes(32).toString("hex"));
      setEnv("ZENITH_CONTROL_SIGNING_JWK", JSON.stringify(generateKeyPairSync("ed25519").privateKey.export({ format: "jwk" })));
      setEnv("ZENITH_CONTROL_KMS_KEY_ID", undefined);
      setEnv("ZENITH_PLATFORM_BROKER_MEMORY", undefined);
      setEnv("ZENITH_RECONCILE_MEMORY", undefined);
      await server.start();
      bundle = await workflowBundlePath(DEFINITIONS_ENTRY, "actual-default-reconcile-composition-v1");
    } catch (error) { await observer?.close(); await blocker?.close(); await db?.close(); await server.stop(); await rm(root, { recursive: true, force: true }); throw error; }
  }, 180_000);
  afterEach(async () => {
    vi.restoreAllMocks();
    resetPlatformBrokerForTests();
    if (!server?.child) return;
    const client = await clientFor();
    try {
      try { await client.client.schedule.getHandle(RECONCILE_SCHEDULE_ID).delete(); } catch (error) { if (!(error instanceof ScheduleNotFoundError)) throw error; }
      for (const handle of started.splice(0)) await handle.cancel().catch(() => undefined);
    } finally { await client.close(); }
    for (const workspaceId of fixtures.splice(0)) {
      await db.query("delete from platform.reconcile_state where workspace_id=$1", [workspaceId]);
      await db.query("delete from platform.provider_connections where workspace_id=$1", [workspaceId]);
    }
  }, 30_000);
  afterAll(async () => {
    try {
      try { await observer?.close(); } finally { try { await blocker?.close(); } finally { try { await db?.close(); } finally { try { await server?.stop(); } finally { if (root) await rm(root, { recursive: true, force: true }); } } } }
    } finally { for (const [name, value] of previous) { if (value === undefined) delete process.env[name]; else process.env[name] = value; } }
  }, 30_000);
  function actual(name: string, body: () => Promise<void>, timeout = 90_000): void {
    it(name, async context => { if (skipReason) return context.skip(skipReason); await body(); }, timeout);
  }

  actual("refuses actual PGlite, closes a refused handle, and does not inherit a global broker ready flag", async () => {
    const local = await openPlatformDb({ kind: "pglite" });
    const close = vi.spyOn(local, "close");
    await expect(openExecutionStore(async () => local)).rejects.toThrow("PostgreSQL");
    expect(close).toHaveBeenCalledOnce();
    const poison = vi.fn(async () => { throw new Error("Process-global broker must not participate."); });
    setPlatformBrokerForTests({ propose: poison, authorizeRead: poison } as unknown as Broker);
    const runtime = await composeReconcileSweepRuntime(db);
    await runtime.assertReady();
    expect(poison).not.toHaveBeenCalled();
    // An actual ready factory is exercised, not authority on a nonempty/provider graph.
  });
  actual("confirms its real configured namespace, closes its client, and refuses an unavailable namespace", async () => {
    const configured = await clientFor();
    expect((await configured.client.workflowService.describeNamespace({ namespace: "default" })).namespaceInfo?.name).toBe("default");
    await configured.close();
    await expect(configured.client.connection.withDeadline(Date.now() + 1_000, () => configured.client.workflowService.describeNamespace({ namespace: "default" }))).rejects.toThrow();
    const cfg = config();
    await expect(openReconcileWorkerClient({ ...cfg, temporal: { ...cfg.temporal, namespace: `owned-absent-${randomUUID()}` } }, converter())).rejects.toThrow("configured Temporal namespace");
  });
  for (const change of ["unchanged", "demoted", "cancelled"] as const) actual(`owning PostgreSQL canonical broker with modeled current product membership: ${change}`, async () => {
    // Actual SQL/OPA/signing and default composition. Only product scope/current
    // member reads are models; this is not live hosted-role or provider acceptance.
    const h = await brokerHarness({ kind: "postgres" });
    const proposed = await proposeOk(h, requestFor(h, "drift.repair", "prod"), systemPrincipal(), { origin: "reconciler", via: "reconciler" });
    expect(proposed.decision.outcome).toBe("require_approval");
    await approveAs(h, proposed.operation, "erin");
    expect((await repos.operations.get(observer, h.ids.wsA, proposed.id))?.status).toBe("approved");
    const scopesModule = await import("@/lib/platform/scopes");
    const rolesModule = await import("@/lib/capabilities/current-product-roles");
    const portsModule = await import("@/lib/platform/reconcile");
    const originalScopes = scopesModule.platformScopeResolver, originalRoles = rolesModule.currentProductRoleResolver;
    const originalPorts = portsModule.composeReconcilePorts;
    const activity = new AbortController();
    let boundSignal: AbortSignal | undefined;
    let getBroker: (() => Promise<Broker>) | undefined;
    vi.spyOn(scopesModule, "platformScopeResolver").mockImplementation(store => {
      const canonical = originalScopes(store);
      return { resolve: scope => scope.workspaceId === h.ids.wsA ? h.deps.scopes.resolve(scope) : canonical.resolve(scope) };
    });
    vi.spyOn(rolesModule, "currentProductRoleResolver").mockImplementation(options => {
      boundSignal = options?.signal;
      const canonical = originalRoles(options);
      return { async resolve(principal, workspaceId) {
        // All nonhuman principals retain the shared helper's canonical attenuation.
        if (principal.kind !== "user") return canonical.resolve(principal, workspaceId);
        boundSignal?.throwIfAborted();
        const current = await h.deps.roles.resolve(principal, workspaceId);
        boundSignal?.throwIfAborted();
        return current;
      } };
    });
    vi.spyOn(portsModule, "composeReconcilePorts").mockImplementation((store, credentials, factory) => {
      getBroker = factory;
      return originalPorts(store, credentials, factory);
    });
    vi.spyOn(Context, "current").mockReturnValue({ cancellationSignal: activity.signal, heartbeat: vi.fn() } as unknown as Context);
    try {
      const runtime = await composeReconcileSweepRuntime(db);
      expect(await runtime.activities.sweepReconcilePass({ contract: RECONCILE_SWEEP_CONTRACT, maxEnvironments: 25, environmentConcurrency: 3, passId: randomUUID() })).toMatchObject({ status: "completed", counts: { claimed: 0, failed: 0 } });
      expect(boundSignal).toBeInstanceOf(AbortSignal);
      expect(boundSignal?.aborted).toBe(false);
      if (!getBroker) throw new Error("Default composition did not supply its internal canonical broker.");
      const canonical = await getBroker();
      if (change === "demoted") h.world.members.set(`${h.ids.wsA}|erin`, "viewer");
      if (change === "cancelled") { activity.abort(); expect(boundSignal?.aborted).toBe(true); }
      const starting = canonical.beginExecution({ workspaceId: h.ids.wsA, operationId: proposed.id, holder: `workflow:${proposed.id}`, leaseMs: 60_000, audience: "worker" });
      if (change === "unchanged") {
        await starting;
        expect((await repos.operations.get(observer, h.ids.wsA, proposed.id))?.status).toBe("running");
      } else {
        await expect(starting).rejects.toThrow();
        expect((await repos.operations.get(observer, h.ids.wsA, proposed.id))?.status).toBe("approved");
        expect(await observer.query("select id from platform.approvals where workspace_id=$1 and operation_id=$2 and consumed_at is not null", [h.ids.wsA, proposed.id])).toEqual([]);
      }
    } finally {
      vi.restoreAllMocks();
      // Only this isolated SQL fixture's ledger rows; no default API or provider was started.
      await observer.tx(async tx => {
        for (const table of ["capability_grants", "approvals", "policy_decisions", "idempotency_keys", "events", "operations"]) {
          await tx.query(`delete from platform.${table} where workspace_id=$1`, [h.ids.wsA]);
        }
      });
    }
  });
  actual("polls the full default activity set before provisioning and observes encrypted real SQL results", async () => {
    await withWorker(async (client, runtime, cfg) => {
      await prepareReconcileWorkerSchedule(client, runtime, cfg.reconcile!);
      expect(await inspectReconcileObservation(client)).toMatchObject({ phase: "missing", observationCurrent: false });
      await expect(client.schedule.getHandle(RECONCILE_SCHEDULE_ID).describe()).rejects.toBeInstanceOf(ScheduleNotFoundError);
      await prepareReconcileWorkerSchedule(client, runtime, { ...cfg.reconcile!, mode: "provision" });
      const described = await client.schedule.getHandle(RECONCILE_SCHEDULE_ID).describe();
      expect(described.raw.schedule?.action?.startWorkflow?.input?.payloads?.[0]?.metadata?.encoding && Buffer.from(described.raw.schedule.action.startWorkflow.input.payloads[0].metadata.encoding).toString()).toBe(TEMPORAL_PAYLOAD_ENCODING);
      expect(await (await scheduled(client)).result()).toMatchObject({ status: "completed", counts: { failed: 0, claimed: 0 } });
      const monitor = reconcileWorkerMonitor(client, cfg.reconcile!);
      try {
        const observed = await monitor.refresh();
        expect(observed).toMatchObject({ phase: "completed", observationCurrent: true });
        expect(await readinessProbe({ temporal: () => true, store: async () => { await db.query("select 1"); return true; }, policy: () => true, drivers: () => true, reconciliation: async () => (await monitor.refresh()).observationCurrent })()).toMatchObject({ ready: true, checks: { reconciliation: "ok" } });
        // Clock projection model over actual service metadata; no elapsed-age runtime claim.
        const clock = vi.spyOn(Date, "now").mockReturnValue(observed.completedAtUnixMs! + 180_001);
        try { expect(await monitor.refresh()).toMatchObject({ phase: "stale", observationCurrent: false }); }
        finally { clock.mockRestore(); }
      } finally { await monitor.stop(); }
    });
  });
  actual("preserves operator pause and refuses incompatible ownership/routing in both permission modes", async () => {
    await withWorker(async (client, runtime, cfg) => {
      await prepareReconcileWorkerSchedule(client, runtime, cfg.reconcile!);
      const handle = client.schedule.getHandle(RECONCILE_SCHEDULE_ID);
      await handle.pause("Owned operator hold.");
      await prepareReconcileWorkerSchedule(client, runtime, cfg.reconcile!);
      expect(await inspectReconcileObservation(client)).toMatchObject({ phase: "paused", observationCurrent: false });
      expect((await handle.describe()).state.note).toBe("Owned operator hold.");
      // Re-encode only canonical one-attempt retry defaults; SDK 1.24 describes
      // zero backoff but rejects that decoded default when encoding an update.
      await handle.update(current => ({ spec: current.spec, action: { ...current.action, retry: { ...current.action.retry, maximumAttempts: 1, backoffCoefficient: 2 }, taskQueue: "owned-incompatible-queue" }, policies: current.policies, state: current.state, typedSearchAttributes: current.typedSearchAttributes }));
      await expect(prepareReconcileWorkerSchedule(client, runtime, cfg.reconcile!)).rejects.toMatchObject({ code: "incompatible_schedule" });
      await prepareReconcileWorkerSchedule(client, runtime, { ...cfg.reconcile!, mode: "observe" });
      expect(await inspectReconcileObservation(client)).toMatchObject({ phase: "incompatible", observationCurrent: false });
      expect((await handle.describe()).action).toMatchObject({ taskQueue: "owned-incompatible-queue" });
    }, "provision");
  });
  actual("a held actual fleet lease reports busy and cannot advertise successful observation", async () => {
    await withWorker(async (client, runtime, cfg) => {
      await prepareReconcileWorkerSchedule(client, runtime, cfg.reconcile!);
      const lease = await repos.leases.acquire(blocker, { scope: RECONCILE_SWEEP_LEASE, holder: `owned-busy:${randomUUID()}`, ttlMs: 30_000 });
      expect(lease).not.toBeNull();
      try {
        expect(await (await scheduled(client)).result()).toEqual({ status: "busy" });
        expect(await inspectReconcileObservation(client)).toMatchObject({ phase: "busy", observationCurrent: false });
      } finally { if (lease) await repos.leases.release(blocker, lease); }
      expect(await (await scheduled(client)).result()).toMatchObject({ status: "completed" });
      expect(await inspectReconcileObservation(client)).toMatchObject({ observationCurrent: true });
    }, "provision");
  });
  actual("bounded real PostgreSQL lock outage defers a pass and the unpaused schedule recovers", async () => {
    await withWorker(async (client, runtime, cfg) => {
      await prepareReconcileWorkerSchedule(client, runtime, cfg.reconcile!);
      let release!: () => void;
      let acquired = false;
      let blockerPid = 0;
      const barrier = new Promise<void>(resolve => { release = resolve; });
      const blocking = blocker.tx(async tx => {
        blockerPid = (await tx.query<{ pid: number }>("select pg_backend_pid() as pid"))[0].pid;
        await tx.query("lock table platform.schema_migrations in access exclusive mode");
        acquired = true; await barrier;
      });
      void blocking.catch(() => undefined);
      try {
        await waitFor("owned schema lock acquired", () => acquired, 5_000);
        const handle = await scheduled(client);
        // A third handle has its own ALS and clears PostgreSQL's stats snapshot.
        const waiter = await waitFor("actual sweep schema-read waiter and blocker", async () => {
          await observer.query("select pg_stat_clear_snapshot()");
          const rows = await observer.query<{ pid: number }>("select pid from pg_stat_activity where application_name=$1 and pid<>pg_backend_pid() and wait_event_type='Lock' and query like 'select version, name, applied_at, checksum from platform.schema_migrations%' and $2::integer=any(pg_blocking_pids(pid))", [workerApplication, blockerPid]);
          return rows.length === 1 && rows[0].pid !== blockerPid ? rows[0] : false;
        }, 4_000);
        expect(waiter.pid).toBeGreaterThan(0);
        const outcome = await handle.result() as ReconcileSweepResult;
        expect(outcome).toEqual({ status: "deferred", reason: "prerequisites_unavailable" });
        expect(await inspectReconcileObservation(client)).toMatchObject({ phase: "deferred", observationCurrent: false });
        expect((await client.schedule.getHandle(RECONCILE_SCHEDULE_ID).describe()).state.paused).toBe(false);
      } finally { release(); await blocking; }
      expect(await (await scheduled(client)).result()).toMatchObject({ status: "completed" });
      expect(await inspectReconcileObservation(client)).toMatchObject({ observationCurrent: true });
    }, "provision");
  });
  actual("pre-acquisition cancellation during an observed schema prerequisite waiter starts no compensation", async () => {
    await withWorker(async (client, runtime, cfg) => {
      await prepareReconcileWorkerSchedule(client, runtime, cfg.reconcile!);
      // No automatic next pass may obscure the cancelled pass's lease projection.
      await client.schedule.getHandle(RECONCILE_SCHEDULE_ID).pause("Owned prerequisite cancellation fixture.");
      expect(await repos.leases.current(observer, RECONCILE_SWEEP_LEASE)).toBeNull();
      const leaseRows = () => observer.query("select scope,holder,fence_token,acquired_at,renewed_at,expires_at,released_at from platform.leases where scope=$1", [RECONCILE_SWEEP_LEASE]);
      const leasesBefore = await leaseRows();
      let acquired = false;
      let release!: () => void;
      let blockerPid = 0;
      const barrier = new Promise<void>(resolve => { release = resolve; });
      const blocking = blocker.tx(async tx => {
        blockerPid = (await tx.query<{ pid: number }>("select pg_backend_pid() as pid"))[0].pid;
        await tx.query("lock table platform.schema_migrations in access exclusive mode");
        acquired = true; await barrier;
      });
      void blocking.catch(() => undefined);
      let handle: WorkflowHandle | undefined;
      try {
        await waitFor("owned cancellation schema lock acquired", () => acquired, 5_000);
        handle = await scheduled(client);
        await waitFor("actual cancelled sweep SQL waiter", async () => {
          await observer.query("select pg_stat_clear_snapshot()");
          const rows = await observer.query<{ pid: number; observer_pid: number }>("select pid,pg_backend_pid() as observer_pid from pg_stat_activity where application_name=$1 and pid<>pg_backend_pid() and wait_event_type='Lock' and query like 'select version, name, applied_at, checksum from platform.schema_migrations%' and $2::integer=any(pg_blocking_pids(pid))", [workerApplication, blockerPid]);
          if (rows.length !== 1) return false;
          expect(rows[0].pid).not.toBe(blockerPid);
          expect(rows[0].observer_pid).not.toBe(blockerPid);
          expect(rows[0].observer_pid).not.toBe(rows[0].pid);
          return rows[0];
        }, 4_000);
        await handle.cancel();
        // A cancel request is not delivery. Keep the actual prerequisite lock held
        // through heartbeat delivery and WAIT_CANCELLATION_COMPLETED's terminal ack.
        await expect(handle.result()).rejects.toThrow();
        expect((await handle.describe()).status.name).toBe("CANCELLED");
        const history = await handle.fetchHistory();
        const scheduledActivities = history.events?.filter(event => event.activityTaskScheduledEventAttributes);
        expect(scheduledActivities).toHaveLength(1);
        expect(scheduledActivities?.[0].activityTaskScheduledEventAttributes?.activityType?.name).toBe("sweepReconcilePass");
        expect(history.events?.filter(event => event.activityTaskStartedEventAttributes)).toHaveLength(1);
        expect(history.events?.filter(event => event.activityTaskCancelRequestedEventAttributes)).toHaveLength(1);
        expect(history.events?.filter(event => event.activityTaskCanceledEventAttributes)).toHaveLength(1);
        expect(history.events?.filter(event => event.activityTaskCompletedEventAttributes)).toHaveLength(0);
        expect(history.events?.filter(event => event.workflowExecutionCanceledEventAttributes)).toHaveLength(1);
        const activityCancelRequested = history.events!.findIndex(event => event.activityTaskCancelRequestedEventAttributes);
        const activityCanceled = history.events!.findIndex(event => event.activityTaskCanceledEventAttributes);
        const workflowCanceled = history.events!.findIndex(event => event.workflowExecutionCanceledEventAttributes);
        expect(activityCancelRequested).toBeLessThan(activityCanceled);
        expect(activityCanceled).toBeLessThan(workflowCanceled);
        expect(await observer.query("select pid from pg_locks where pid=$1::integer and relation='platform.schema_migrations'::regclass and mode='AccessExclusiveLock' and granted", [blockerPid])).toEqual([{ pid: blockerPid }]);
        expect(await repos.leases.current(observer, RECONCILE_SWEEP_LEASE)).toBeNull();
        expect(await leaseRows()).toEqual(leasesBefore);
        expect(await observer.query("select id from platform.operations limit 1")).toEqual([]);
      } finally { release(); await blocking; }
      expect(await repos.leases.current(observer, RECONCILE_SWEEP_LEASE)).toBeNull();
      expect(await leaseRows()).toEqual(leasesBefore);
      expect(await observer.query("select id from platform.operations limit 1")).toEqual([]);
      // Schedule is intentionally paused; read the terminal workflow above for cancellation.
      expect(await inspectReconcileObservation(client)).toMatchObject({ phase: "paused", observationCurrent: false });
    }, "provision");
  });
  actual("default controller cancellation after an observed post-acquisition SQL waiter releases its exact live fleet lease", async () => {
    await withWorker(async (client, runtime, cfg) => {
      await prepareReconcileWorkerSchedule(client, runtime, cfg.reconcile!);
      // Prevent an automatic next pass from obscuring the cancelled pass's lease.
      await client.schedule.getHandle(RECONCILE_SCHEDULE_ID).pause("Owned post-acquisition cancellation fixture.");
      await runtime.assertReady();
      expect(await observer.query("select id from platform.operations limit 1")).toEqual([]);
      const expectedQuery = `select workspace_id, environment_id, max(finished_at) as at
           from platform.operations
          where status = 'succeeded' and capability in ('deployment.deploy', 'deployment.rollback', 'infrastructure.apply')
            and finished_at >= $1::timestamptz and environment_id is not null
          group by workspace_id, environment_id
          order by max(finished_at) desc
          limit $2::bigint`;
      let enter!: () => void, release!: () => void, blockerPid = 0;
      const entered = new Promise<void>(resolve => { enter = resolve; });
      const held = new Promise<void>(resolve => { release = resolve; });
      const blocking = blocker.tx(async tx => {
        blockerPid = (await tx.query<{ pid: number }>("select pg_backend_pid() as pid"))[0].pid;
        await tx.query("lock table platform.operations in access exclusive mode");
        enter(); await held;
      });
      void blocking.catch(() => undefined);
      let handle: WorkflowHandle | undefined;
      try {
        await Promise.race([entered, blocking.then(() => { throw new Error("Controller blocker exited before its owned table lock."); })]);
        handle = await scheduled(client); // Trigger is explicit, while the owned schedule remains paused.
        const waiter = await waitFor("default controller exact SQL waiter and separate observer", () => observer.tx(async fresh => {
          await fresh.query("select pg_stat_clear_snapshot()");
          const rows = await fresh.query<{ pid: number; observer_pid: number; query: string }>(`select pid,pg_backend_pid() as observer_pid,query from pg_stat_activity
            where application_name=$1 and pid<>pg_backend_pid() and wait_event_type='Lock'
              and query=$2 and $3::integer=any(pg_blocking_pids(pid))`, [workerApplication, expectedQuery, blockerPid]);
          if (rows.length !== 1) return false;
          expect(rows[0].pid).not.toBe(blockerPid);
          expect(rows[0].observer_pid).not.toBe(blockerPid);
          expect(rows[0].observer_pid).not.toBe(rows[0].pid);
          expect(rows[0].query).toBe(expectedQuery);
          return rows[0];
        }), 4_000);
        expect(waiter.pid).toBeGreaterThan(0);
        const lease = await repos.leases.current(observer, RECONCILE_SWEEP_LEASE);
        expect(lease).not.toBeNull();
        if (!lease) throw new Error("Controller SQL waiter did not hold its live fleet lease.");
        expect(lease.scope).toBe(RECONCILE_SWEEP_LEASE);
        expect(lease.holder).toMatch(/^reconcile-sweep:[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/);
        const workflowRun = (await handle.describe()).runId;
        // The workflow defines passId from workflowInfo().runId, binding this live lease to this pass.
        expect(lease.holder).toBe(`reconcile-sweep:${workflowRun}`);
        await handle.cancel();
        // WAIT_CANCELLATION_COMPLETED lets the default activity unwind its actual bounded DB wait.
        await expect(handle.result()).rejects.toThrow();
        expect((await handle.describe()).status.name).toBe("CANCELLED");
        expect(await repos.leases.current(observer, RECONCILE_SWEEP_LEASE)).toBeNull();
        expect(await observer.query("select scope from platform.leases where scope=$1 and holder=$2 and fence_token=$3 and released_at is not null", [lease.scope, lease.holder, lease.fenceToken])).toEqual([{ scope: RECONCILE_SWEEP_LEASE }]);
      } finally { release(); await blocking; }
      // Independent committed read after table unlock; no operation or compensation was created.
      expect(await observer.query("select id from platform.operations limit 1")).toEqual([]);
      expect(await repos.leases.current(observer, RECONCILE_SWEEP_LEASE)).toBeNull();
    }, "provision");
  });
  actual("a canonical eligible empty graph completes in SQL, then owned worker restart services the same schedule", async () => {
    const workspaceId = `owned-composition-${randomUUID()}`;
    fixtures.push(workspaceId);
    const environmentId = `owned-environment-${randomUUID()}`;
    const connection = await repos.connections.create(db, { workspaceId, createdBy: "owned-composition", config: { provider: "aws", mode: "aws_assume_role", accountId: "123456789012", region: "us-east-1", observeRoleArn: "arn:aws:iam::123456789012:role/owned-composition-observe", deployRoleArn: "arn:aws:iam::123456789012:role/owned-composition-deploy", externalId: "owned-sql-metadata" } });
    await repos.connections.recordVerification(db, { workspaceId, id: connection.id, ok: true, detail: "SQL fixture; no provider authentication claim." });
    await registerEnvironment(db, { environment: { workspaceId, environmentId, class: "production", provider: "aws", region: "us-east-1", connection: { id: connection.id, status: "verified" } } });
    await withWorker(async (client, runtime, cfg) => {
      await prepareReconcileWorkerSchedule(client, runtime, cfg.reconcile!);
      expect(await (await scheduled(client)).result()).toMatchObject({ status: "completed", counts: { claimed: 1, nothingToReconcile: 1, failed: 0 } });
      expect(await db.query("select claimed_by,last_outcome from platform.reconcile_state where workspace_id=$1 and environment_id=$2", [workspaceId, environmentId])).toMatchObject([{ claimed_by: null, last_outcome: "nothing_to_reconcile" }]);
    }, "provision");
    // New native worker/client after actual service restart with the same owned SQLite.
    await server!.stop();
    await server!.start();
    await withWorker(async (client, runtime, cfg) => {
      await prepareReconcileWorkerSchedule(client, runtime, cfg.reconcile!);
      expect(await (await scheduled(client)).result()).toMatchObject({ status: "completed" });
      expect(await inspectReconcileObservation(client)).toMatchObject({ observationCurrent: true });
      expect(await db.query("select id from platform.operations where workspace_id=$1", [workspaceId])).toEqual([]);
    });
  });
});
