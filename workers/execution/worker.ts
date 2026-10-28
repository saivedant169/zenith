/**
 * Zenith execution worker: the long-running process that runs Temporal
 * workflow tasks and activities for real-infrastructure operations
 * (ADR-0009, docs/platform/EXECUTION-WORKER.md).
 *
 *   npx tsx workers/execution/worker.ts          (development, from the repo root)
 *   node dist/execution/worker.cjs               (container image; see docker/worker.Dockerfile)
 *
 * Activities compose the platform stores, capability/credential brokers and
 * native drivers. Required secrets and schema are checked before polling.
 *
 * Shutdown: SIGTERM / SIGINT stop polling, let running activities finish for
 * ZENITH_WORKER_SHUTDOWN_GRACE_MS, then cancel them. A second signal exits
 * immediately.
 *
 * Logs are JSON lines on stdout. Secrets (the Temporal API key, cloud
 * credentials) are never logged.
 * Loopback probes listen on ZENITH_WORKER_HEALTH_PORT (default 9464).
 * Artifact access expires durably. No ciphertext or legacy plan files are physically pruned.
 */

import { DefaultLogger, NativeConnection, Runtime, Worker } from "@temporalio/worker";
import { Context } from "@temporalio/activity";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { ensurePlatformApp } from "@/lib/platform/app";
import type { PlatformDbHandle } from "@/lib/controlplane/db";
import { composeReconcileSweepRuntime } from "@/lib/platform/execution";
import { createCriticalMaintenanceActivities } from "@/lib/workflows/critical-activities";
import { createMixedActivities } from "@/lib/workflows/mixed-activities";
import { createProductionCodingAgentActivities } from "@/lib/coding-agent/activities";
import { criticalJobHealth } from "@/lib/platform/critical-jobs";
import type { RegisteredWorkerActivities } from "@/lib/workflows/types";
import { listDrivers } from "@/lib/drivers/types";
import { loadPolicyEngine } from "@/lib/policy";
import { planArtifactRetentionPreviewFromEnv, startPlanArtifactJanitor } from "@/lib/execution/plan-janitor";
import { createAzureSourceStorageResolver } from "@/lib/providers/azure/release/source-binding";
import { createActivities } from "@/lib/workflows/activities";
import { startWorkerOpsSampler } from "@/lib/ops/sampler";
import { ensureTelemetryExport } from "@/lib/ops/telemetry/otlp";
import { connectionOptionsFor, describeTemporalConfig } from "@/lib/workflows/config";
import { describeWorkerVersioning } from "@/lib/workflows/versioning";
import { startClosure, startEndpointDigest } from "@/lib/workflows/start-closure";
import { temporalDataConverterFromEnv } from "@/lib/workflows/codec";
import { executionWorkerConfigFromEnv } from "./config";
import { installShutdownHandlers } from "./lifecycle";
import { awaitReconcilePollers, workerOptions, workflowSource } from "./run";
import { ExecutionStartupError, validateExecutionConfiguration, validateReconcileWorkerConfiguration, openExecutionStore, closeExecutionStore, openReconcileWorkerClient, prepareReconcileWorkerSchedule, prepareCriticalMaintenanceSchedule, reconcileWorkerMonitor, type ExecutionFailureCategory } from "./startup";
import { HEALTH_CHECK_TIMEOUT_MS, healthPortFromEnv, startHealthServer } from "./health";

function log(level: "info" | "warn" | "error", msg: string, fields: Record<string, unknown> = {}): void {
  process.stdout.write(`${JSON.stringify({ time: new Date().toISOString(), level, msg, component: "execution-worker", ...fields })}\n`);
}

let failureCategory: ExecutionFailureCategory = "configuration";
async function main(): Promise<void> {
  const config = executionWorkerConfigFromEnv();
  const retentionPreview = process.env.ZENITH_WORKER_PLAN_RETENTION_PREVIEW === undefined
    ? undefined : planArtifactRetentionPreviewFromEnv();
  const dataConverter = temporalDataConverterFromEnv();
  let db: PlatformDbHandle | undefined;
  let connection: NativeConnection | undefined;
  let worker: Worker | undefined;
  let policyLoaded = false;
  let stopping = () => false;
  let janitor: ReturnType<typeof startPlanArtifactJanitor> | undefined;
  let opsSampler: ReturnType<typeof startWorkerOpsSampler> | undefined;
  let healthLog: ReturnType<typeof setInterval> | undefined;
  let reconcileLog: ReturnType<typeof setInterval> | undefined;
  let reconcileClient: Awaited<ReturnType<typeof openReconcileWorkerClient>> | undefined;
  let monitor: ReturnType<typeof reconcileWorkerMonitor> | undefined;
  let workerRun: Promise<void> | undefined;
  failureCategory = "health-listener";
  const endpoint = await startHealthServer({ port: healthPortFromEnv(), checks: {
    async temporal() {
      if (!connection || !worker) return undefined;
      if (stopping() || worker.getState() !== "RUNNING") return false;
      await connection.withDeadline(Date.now() + HEALTH_CHECK_TIMEOUT_MS, () => connection!.workflowService.getSystemInfo({}));
      return !stopping() && worker.getState() === "RUNNING";
    },
    async store() { if (!db) return undefined; await db.query("select 1"); return true; },
    policy: () => policyLoaded,
    drivers: () => ["aws", "kubernetes", "zenith", "gcp", "azure", "oci"].every((provider) => listDrivers().some((driver) => driver.provider === provider)),
    async reconciliation() {
      if (!monitor) return undefined;
      if (stopping()) return false;
      return (await monitor.refresh()).observationCurrent && !stopping();
    },
  } });
  try {
    failureCategory = "configuration";
    await validateExecutionConfiguration();
    validateReconcileWorkerConfiguration(config);
    failureCategory = "platform-store";
    db = await openExecutionStore();
    failureCategory = "platform-composition";
    if (!(await ensurePlatformApp(db))) throw new ExecutionStartupError("Platform runtime composition failed; check platform schema and configuration.");
    // Load the actual verified bundle before advertising readiness, not a flag
    // inferred from platform composition (which intentionally needs no policy).
    failureCategory = "policy-assets";
    await loadPolicyEngine();
    policyLoaded = true;
    failureCategory = "reconcile-composition";
    const sweep = await composeReconcileSweepRuntime(db);
    const planDir = path.resolve(process.env.ZENITH_WORKER_PLAN_DIR ?? path.join(process.env.ZENITH_DATA ?? ".data", "platform-plans"));
    failureCategory = "plan-directory";
    await mkdir(planDir, { recursive: true, mode: 0o700 });
    failureCategory = "activity-composition";
    const activities: RegisteredWorkerActivities = { ...createActivities({ db, workerIdentity: config.identity, planDir, sourceBundles: { azureStorage: createAzureSourceStorageResolver(db) }, ports: { heartbeat: (detail) => Context.current().heartbeat(detail), activitySignal: () => Context.current().cancellationSignal } }), ...sweep.activities, ...createCriticalMaintenanceActivities(db), ...createProductionCodingAgentActivities(db), ...createMixedActivities({ db }) };
    failureCategory = "temporal-runtime";
    Runtime.install({ logger: new DefaultLogger(config.logLevel) });

    failureCategory = "workflow-bundle";
    const workflows = await workflowSource(config);
    if (workflows.fallbackReason) log("warn", "swc could not compile the workflows; used the esbuild fallback", { reason: workflows.fallbackReason });
    failureCategory = "temporal-connect";
    connection = await NativeConnection.connect(connectionOptionsFor(config.temporal));
    failureCategory = "temporal-worker";
    worker = await Worker.create({
      ...workerOptions({
        config,
        connection,
        activities,
        workflows,
      }),
      dataConverter,
    });

    failureCategory = "worker-lifecycle";
    stopping = installShutdownHandlers({ worker, graceMs: config.shutdownGraceMs, log, signals: process, exit: (code) => process.exit(code) });
    // PROD-OPS-02: OTLP push (when configured) and the sampled queue/maintenance gauges plus tenant weights for the fair gate.
    // Both are best effort: a collector or store outage never stops the worker serving activities.
    const telemetry = ensureTelemetryExport();
    if (telemetry.error) log("warn", "telemetry export disabled", { reason: telemetry.error });
    opsSampler = startWorkerOpsSampler(db);
    // Run even if the separately owned client cannot connect: shutdown must
    // drain/finalize this created native worker before its connection closes.
    const pollingStartedAt = Date.now();
    workerRun = worker.run();
    void workerRun.catch(() => undefined);
    failureCategory = "reconcile-client";
    reconcileClient = await openReconcileWorkerClient(config, dataConverter);
    failureCategory = "reconcile-pollers";
    await awaitReconcilePollers(worker, reconcileClient.client, config, pollingStartedAt);
    if (stopping()) throw new ExecutionStartupError("Worker stopped before durable reconciliation preparation.");
    failureCategory = "reconcile-schedule";
    await prepareReconcileWorkerSchedule(reconcileClient.client, sweep, config.reconcile!);
    // Reaping/housekeeping/runbooks schedule. A failure leaves the HTTP fallback cron as the only trigger and is
    // reported through job health ("never_run"/"stale"), so it must not stop the worker serving workflows.
    try { await prepareCriticalMaintenanceSchedule(reconcileClient.client, config.reconcile!); }
    catch { log("warn", "critical maintenance schedule unavailable; the fallback cron is the only trigger until it is provisioned"); }
    monitor = reconcileWorkerMonitor(reconcileClient.client, config.reconcile!);
    const reconciliation = await monitor.refresh();
    log(reconciliation.observationCurrent ? "info" : "warn", "durable reconciliation status", { ...reconciliation });
    reconcileLog = setInterval(() => {
      void monitor!.refresh().then(observed => log(observed.observationCurrent ? "info" : "warn", "durable reconciliation status", { ...observed }));
      void criticalJobHealth(db!).then(h => log(h.healthy ? "info" : "warn", "critical job health", { jobs: h.jobs.map(j => ({ job: j.job, state: j.state, durable: j.durable, ageMs: j.lastSuccessAgeMs, failures: j.consecutiveFailures })) }), () => log("warn", "critical job health unavailable; check control store"));
    }, 30_000);
    reconcileLog.unref();
    const temporal = reconcileClient.client, temporalEndpoint = startEndpointDigest(config.temporal);
    janitor = startPlanArtifactJanitor(db, (result) => {
      if (result) log("info", "plan maintenance", { ...result });
      else log("warn", "plan maintenance unavailable; check plan directory and control store");
    }, { retentionPreview, settlement: { startClosure: (binding, runId) => startClosure(temporal, temporalEndpoint, binding, runId) } });

    const startedAt = Date.now();
    log("info", "execution worker polling", {
      ...describeTemporalConfig(config.temporal),
      taskQueue: config.taskQueue,
      identity: config.identity,
      maxConcurrentActivities: config.maxConcurrentActivities,
      maxConcurrentWorkflowTasks: config.maxConcurrentWorkflowTasks,
      workflowSource: workflows.origin,
      ...describeWorkerVersioning(config.versioning),
      healthPort: endpoint.port,
    });
    healthLog =
      config.healthLogIntervalMs > 0
        ? setInterval(
            () => log("info", "execution worker health", { state: worker!.getState(), uptimeSec: Math.round((Date.now() - startedAt) / 1000) }),
            config.healthLogIntervalMs
          )
        : undefined;
    healthLog?.unref();

    failureCategory = "worker-run";
    await workerRun;
    log("info", "execution worker stopped");
    failureCategory = "resource-close";
  } finally {
    stopping = () => true;
    if (healthLog) clearInterval(healthLog);
    if (reconcileLog) clearInterval(reconcileLog);
    opsSampler?.stop();
    // A failed shutdown or close must not strand another owned resource.
    try {
      // Drain before closing the client or database used by activities.
      if (worker?.getState() === "RUNNING") worker.shutdown();
      await workerRun?.catch(() => undefined);
    }
    finally {
      try { await endpoint.close(); }
      finally {
        try { await monitor?.stop(); }
        finally {
          try { await janitor?.stop(); }
          finally {
            try { await reconcileClient?.close(); }
            finally {
              try { await connection?.close(); }
              finally { await closeExecutionStore(db); }
            }
          }
        }
      }
    }
  }
}

main().then(
  () => process.exit(0),
  (err: unknown) => {
    log("error", "execution worker failed", { failureCategory, error: err instanceof ExecutionStartupError ? err.message : "Execution stopped unexpectedly; check platform store, Temporal and worker configuration." });
    process.exit(1);
  }
);
