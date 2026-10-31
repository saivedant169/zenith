/**
 * Sampled control-plane gauges (PROD-OPS-02): queue depth, active operations,
 * maintenance mode and "is the control store answering".
 *
 * `sampleControlPlane` is one bounded read pass. It is called by
 *  - the Prometheus route (`/api/internal/metrics`) on every scrape, and
 *  - the execution worker on a timer (`startWorkerOpsSampler`), which also
 *    refreshes the worker's tenant weights from `platform.tenant_quotas`.
 * It never throws: a failed read sets `zenith_control_store_up` to 0 and keeps
 * the previous gauges, which is itself the signal the "control plane degraded"
 * alert fires on while workloads keep serving.
 */
import type { Sql } from "@/lib/controlplane/types";
import { effectiveMaintenance } from "./maintenance";
import { opsLimitsFromEnv } from "./config";
import { drainStatus, getMaintenance, listTenantQuotas } from "./store";
import { opsMetrics } from "./telemetry/catalog";
import { tenantLabeler } from "./telemetry/metrics";
import { workerFairGate } from "./worker-gate";
import { flushSloSamples } from "@/lib/slo/recorder";

export interface SampleResult { up: boolean; drained?: boolean }

/** A stopped store can leave reads hanging on the pooler; the scrape must still answer (Prometheus times out at 5 s). */
export const SAMPLE_TIMEOUT_MS = 2_000;

export async function sampleControlPlane(sql: Sql, env: Readonly<Record<string, string | undefined>> = process.env, timeoutMs = SAMPLE_TIMEOUT_MS): Promise<SampleResult> {
  const m = opsMetrics();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const deadline = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("control store read timed out")), timeoutMs); });
    const [drain, stored] = await Promise.race([Promise.all([drainStatus(sql, 50), getMaintenance(sql)]), deadline]);
    clearTimeout(timer);
    const labeler = tenantLabeler();
    m.runnerQueueDepth.replace(drain.busiest.map((b) => ({ labels: { tenant: labeler.label(b.workspaceId) }, value: b.queuedJobs })));
    m.activeOperations.replace(drain.busiest.map((b) => ({ labels: { tenant: labeler.label(b.workspaceId) }, value: b.activeOperations })));
    m.runnerQueueDepthTotal.set({}, drain.queuedRunnerJobs);
    const state = effectiveMaintenance(stored, opsLimitsFromEnv(env).maintenanceOverride);
    for (const mode of ["off", "dispatch_paused", "read_only"] as const) m.maintenanceMode.set({ mode }, state.mode === mode ? 1 : 0);
    m.controlStoreUp.set({}, 1);
    // PROD-OPS-01: persist this process's SLI deltas (best effort, never throws).
    await flushSloSamples(sql);
    return { up: true, drained: drain.drained };
  } catch {
    clearTimeout(timer);
    m.controlStoreUp.set({}, 0);
    return { up: false };
  }
}

/** Refresh the worker's weight table from tenant quotas. Failure keeps the previous weights. */
export async function refreshWorkerWeights(sql: Sql): Promise<boolean> {
  const gate = workerFairGate();
  if (!gate) return false;
  try {
    const weights = new Map<string, number>();
    for (const q of await listTenantQuotas(sql, 500)) weights.set(q.workspaceId, q.weight);
    gate.setWeights(weights);
    return true;
  } catch { return false; }
}

/** Start the worker's periodic sampler. Returns stop(). The timer is unref'd. */
export function startWorkerOpsSampler(sql: Sql, intervalMs = 30_000): { stop(): void } {
  const tick = (): void => { void refreshWorkerWeights(sql); void sampleControlPlane(sql); };
  tick();
  const timer = setInterval(tick, intervalMs);
  timer.unref();
  return { stop: () => clearInterval(timer) };
}
