/**
 * App composition, once per process. An unconfigured/broken platform must not
 * break the legacy product. No default PGlite is silently opened at app boot.
 * Only identifiers enter runner audit; expired jobs never get re-dispatched.
 */
import { platformDb, platformDbConfigFromEnv, repos, assertPlatformSchemaCurrent } from "@/lib/controlplane/db";
import type { Sql } from "@/lib/controlplane/types";
import { registerDefaultPlatformComposition } from "@/lib/capabilities/platform";
import { createOperationsPort } from "@/lib/execution";
import { configureRunnerRuntime } from "@/lib/runners/runtime";
import type { RunnerRuntime } from "@/lib/runners/runtime";
import { createPlatformRunnerStore } from "@/lib/runners/db/pg-store";
import { reapExpiredJobs } from "@/lib/runners/service";
import { wireReconcilePorts } from "@/lib/reconcile/ports";
import { custodySeparationErrors } from "@/lib/keycustody/startup";
import { log } from "@/lib/log";
import { platformCredentialBroker } from "./credentials";
import { composeReconcilePorts } from "./reconcile";
import { createDefaultManagedSubstrate } from "./zenith-managed";
import { registerAllDrivers } from "./drivers";
import { composeAgentPorts } from "./agent-ports";
import { withDiagnosisRecording } from "@/lib/repair/diagnosis";
import { registerCredentialBroker, registerInvestigator } from "@/lib/agent-access/v3/adapters";

type State = { boot?: Promise<boolean>; db?: Sql };
type G = typeof globalThis & { __zenithPlatformApp?: State };
const state = (): State => (globalThis as G).__zenithPlatformApp ??= {};
const runnerPorts = (sql: Sql): Pick<RunnerRuntime, "store" | "events"> => ({ store: createPlatformRunnerStore(sql), events: { async emit(event) {
  await repos.events.append(sql, { type: event.type, workspaceId: event.workspaceId, operationId: event.operationId || undefined, correlationId: event.operationId || event.agentId, actor: event.actorId ? { kind: "user", id: event.actorId, name: "Workspace operator" } : undefined, data: { ...event.data, agentId: event.agentId } });
} } });

/** Explicit injection also lets contract tests use a fresh in-memory store. */
export function ensurePlatformApp(db?: Sql): Promise<boolean> {
  const s = state();
  return s.boot ??= (async () => {
    try {
      if (!db && platformDbConfigFromEnv().source === "default") return false;
      const sql = db ?? await platformDb();
      await assertPlatformSchemaCurrent(sql);
      // PROD-OPS-05: report (never refuse here; the worker refuses) shared or misplaced keys, codes only.
      try { const findings = custodySeparationErrors(); if (findings.length) log.warn("key custody separation findings; run scripts/key-custody.ts diagnose", { scope: "platform", codes: findings.map((f) => f.code) }); } catch { /* diagnostics only */ }
      registerAllDrivers();
      // Built inside the capabilities module so the production broker keeps default provenance (saved-plan dispatch binds it).
      registerDefaultPlatformComposition(sql);
      configureRunnerRuntime(runnerPorts(sql));
      const credentials = platformCredentialBroker(sql);
      const managed = createDefaultManagedSubstrate({ db: sql });
      wireReconcilePorts(() => composeReconcilePorts(sql, credentials, undefined, managed));
      const agentPorts = composeAgentPorts(sql, credentials);
      registerCredentialBroker(credentials, agentPorts.observability);
      // Diagnose stage of the canonical repair lifecycle: finished investigations of tracked incidents are recorded, and an inconclusive one escalates.
      registerInvestigator(withDiagnosisRecording(agentPorts.investigator, (investigation) => repos.incidentStability.recordInvestigation(sql, { investigation })));
      s.db = sql;
      return true;
    } catch {
      // Do not log connection strings, signer input or provider errors.
      log.warn("platform composition unavailable; check platform store configuration and schema", { scope: "platform" });
      return false;
    }
  })();
}

export async function platformRunnerReaperPass(): Promise<{ ran: boolean; jobs: number }> {
  if (!(await ensurePlatformApp())) return { ran: false, jobs: 0 };
  return reapRunnerJobs(state().db!);
}

/** The reap itself against an explicit store, so the durable worker and the HTTP fallback share one implementation. */
export async function reapRunnerJobs(db: Sql): Promise<{ ran: boolean; jobs: number }> {
  // The reaper needs no signer/sealer: operate on the configured queues and
  // append the same safe events, without requiring cloud configuration.
  return db.tx(async (tx) => {
    const expired = await reapExpiredJobs(runnerPorts(tx));
    const ops = createOperationsPort(tx);
    const jobs = [...expired.runnerJobs, ...expired.machineRequests];
    // Read jobs (C4) own no operation: nothing to mark, and marking "" would roll back the reap.
    for (const job of jobs) {
      if (!job.operationId) continue;
      await ops.markUncertain({ workspaceId: job.workspaceId, operationId: job.operationId, reason: "An owning runner or machine job expired; the external outcome is unknown." });
    }
    return { ran: true, jobs: jobs.length };
  });
}

/** Test isolation; does not close caller-owned stores. */
export function resetPlatformAppForTests(): void {
  delete (globalThis as G).__zenithPlatformApp;
  registerCredentialBroker(undefined);
  registerInvestigator(undefined);
}
