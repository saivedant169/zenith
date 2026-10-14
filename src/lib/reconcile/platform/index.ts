/**
 * The platform-store adapter of the reconciliation controller: real
 * `ReconcilePassPorts` over the control store (ADR-0002), with the three
 * outward dependencies — capability broker, credential broker, Temporal —
 * supplied by whoever wires the process.
 *
 *     wireReconcilePorts(() =>
 *       createPlatformReconcilePorts({
 *         db: await platformDb(),
 *         broker: { propose: (p) => capabilityBroker.proposeAsReconciler(p) },
 *         withObserveSession: (req, fn) => observeSession(req, fn),   // grant + CredentialBroker.withSession, purpose "observe"
 *         startRepair: (r) => startDayTwoWorkflow(r.operationId),     // idempotent: workflow id op-<operationId>
 *       }));
 *
 * Everything here reads and writes the `platform` schema only, every statement
 * scoped by `workspace_id`; nothing in this directory touches the product store.
 */
import type { Sql } from "@/lib/controlplane/types";
import { assertFence } from "@/lib/controlplane/db/repos/leases";
import type { ReconcilePassPorts } from "../pass-types";
import type { SchedulerConfig } from "../scheduler";
import type { ReconcilePorts } from "../types";
import { ReconcileError } from "../errors";
import { createPlatformGuard, createPlatformSignals, type PlatformGuardOptions } from "./guard";
import { createPlatformState, loadPlatformEnvironment } from "./state";
import { createPlatformStore, loadGraphFromStore } from "./store";
import { createPlatformStability } from "./stability";

export { createPlatformStability } from "./stability";
export { createPlatformGuard, createPlatformSignals, type PlatformGuardOptions } from "./guard";
export { createPlatformState, loadPlatformEnvironment, registerEnvironment, requestReconcileNow, type RegisterEnvironmentInput } from "./state";
export { createPlatformStore, loadGraphFromStore } from "./store";

export interface PlatformReconcileDeps extends Pick<ReconcilePorts, "broker" | "withObserveSession" | "startRepair"> {
  db: Sql;
  now?: () => Date;
  driverFor?: ReconcilePorts["driverFor"];
  log?: ReconcilePorts["log"];
  resolveAwsBootstrap?: ReconcilePorts["resolveAwsBootstrap"];
  /** Optional sink for observed runtime health (SLO sampling); supplied by the composition root, never imported here. */
  onRuntimeObserved?: ReconcilePorts["onRuntimeObserved"];
  scheduler?: Partial<SchedulerConfig>;
  guard?: PlatformGuardOptions;
}

export function createPlatformReconcilePorts(deps: PlatformReconcileDeps): ReconcilePassPorts {
  const { db } = deps;
  return {
    now: deps.now ?? (() => new Date()),
    store: createPlatformStore(db),
    assertFence: (fence) => assertFence(db, fence.scope, fence.token),
    state: createPlatformState(db, deps.scheduler),
    loadEnvironment: (workspaceId, environmentId) => loadPlatformEnvironment(db, workspaceId, environmentId),
    guard: createPlatformGuard(db, deps.guard),
    signals: createPlatformSignals(db),
    loadGraph: (environment) => loadGraphFromStore(db, environment),
    broker: deps.broker,
    // Always wired in production: no repair is proposed without a confirmed incident and a reservation.
    stability: createPlatformStability(db),
    withObserveSession: deps.withObserveSession,
    resolveAwsBootstrap: deps.resolveAwsBootstrap ?? (async () => { throw new ReconcileError("platform_store_unavailable", "The trusted AWS reconciliation context resolver is not configured."); }),
    startRepair: deps.startRepair,
    ...(deps.onRuntimeObserved ? { onRuntimeObserved: deps.onRuntimeObserved } : {}),
    ...(deps.driverFor ? { driverFor: deps.driverFor } : {}),
    ...(deps.log ? { log: deps.log } : {}),
  };
}
