/**
 * The process-wide fairness runtime (PROD-OPS-02). Node runtime only.
 *
 * One instance per process holds the limiters, in-flight gates, the maintenance
 * cache and the tenant-quota cache, all built from the same `opsLimitsFromEnv`.
 * Everything here is bounded and best effort in how it READS the control store:
 * a slow or unreachable store yields the last known value or the platform
 * default, never an error on the request path. (Writes - the operator routes -
 * do report store failures.)
 */
import { log } from "@/lib/log";
import { ConcurrencyGate } from "./concurrency";
import { opsLimitsFromEnv, type OpsLimits } from "./config";
import { MaintenanceCache, effectiveMaintenance, type MaintenanceState } from "./maintenance";
import { getMaintenance, getTenantQuota, type TenantQuota } from "./store";
import { opsMetrics } from "./telemetry/catalog";
import { ensureTelemetryExport } from "./telemetry/otlp";
import { TokenBucketLimiter, type BucketSpec } from "./token-bucket";
import type { Sql } from "@/lib/controlplane/types";

/** True when this host has a platform control store configured at all. */
export function platformConfigured(env: Readonly<Record<string, string | undefined>> = process.env): boolean {
  return Boolean(env.ZENITH_PLATFORM_DB?.trim() || env.ZENITH_PLATFORM_DB_URL?.trim() || env.SUPABASE_DB_URL?.trim());
}

interface QuotaEntry { quota: TenantQuota | null; at: number }

export class QuotaCache {
  private readonly entries = new Map<string, QuotaEntry>();
  constructor(private readonly load: (workspaceId: string) => Promise<TenantQuota | null>, private readonly ttlMs = 15_000, private readonly maxEntries = 5_000, private readonly now: () => number = Date.now, private readonly timeoutMs = 1_000) {}

  /**
   * The workspace's overrides, or null for "platform defaults". Never throws by default: a failed load keeps
   * the last known value. With `failClosed`, a failed load throws and caches nothing (dispatch admission uses this).
   */
  async get(workspaceId: string, opts: { failClosed?: boolean } = {}): Promise<TenantQuota | null> {
    const hit = this.entries.get(workspaceId);
    if (hit && this.now() - hit.at < this.ttlMs) return hit.quota;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const quota = await Promise.race([
        this.load(workspaceId),
        new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("timeout")), this.timeoutMs); }),
      ]);
      this.put(workspaceId, quota);
      return quota;
    } catch (error) {
      if (opts.failClosed) throw error;
      // Keep serving with the last known value; retry after one TTL, not per request.
      this.put(workspaceId, hit?.quota ?? null);
      return hit?.quota ?? null;
    } finally { if (timer) clearTimeout(timer); }
  }

  private put(workspaceId: string, quota: TenantQuota | null): void {
    if (this.entries.size >= this.maxEntries) {
      const oldest = this.entries.keys().next();
      if (!oldest.done) this.entries.delete(oldest.value);
    }
    this.entries.delete(workspaceId);
    this.entries.set(workspaceId, { quota, at: this.now() });
  }

  invalidate(workspaceId?: string): void {
    if (workspaceId) this.entries.delete(workspaceId); else this.entries.clear();
  }
}

export interface OpsRuntime {
  limits: OpsLimits;
  apiLimiter: TokenBucketLimiter;
  dispatchLimiter: TokenBucketLimiter;
  globalGate: ConcurrencyGate;
  tenantGate: ConcurrencyGate;
  maintenance: MaintenanceCache;
  quotas: QuotaCache;
  /** the platform control store handle; rejects when none is configured or it is unreachable */
  store: () => Promise<Sql>;
}

const key = Symbol.for("zenith.ops.runtime.v1");
type G = typeof globalThis & { [key]?: OpsRuntime };

async function defaultStore(): Promise<Sql> {
  if (!platformConfigured()) throw new Error("no platform store");
  const { platformDb } = await import("@/lib/controlplane/db");
  return platformDb();
}

export function buildRuntime(limits: OpsLimits = opsLimitsFromEnv(), store: () => Promise<Sql> = defaultStore): OpsRuntime {
  return {
    limits,
    apiLimiter: new TokenBucketLimiter({ ratePerSec: limits.api.ratePerSec, burst: limits.api.burst }, limits.api.maxTenants),
    dispatchLimiter: new TokenBucketLimiter({ ratePerSec: limits.dispatch.ratePerSec, burst: limits.dispatch.burst }, limits.api.maxTenants),
    globalGate: new ConcurrencyGate(limits.api.maxInFlight),
    tenantGate: new ConcurrencyGate(limits.api.maxInFlight),
    maintenance: new MaintenanceCache(async () => getMaintenance(await store()), { ttlMs: limits.maintenanceCacheMs }),
    quotas: new QuotaCache(async (ws) => getTenantQuota(await store(), ws)),
    store,
  };
}

/** The runtime for this process; first use also reports config issues and starts telemetry export. */
export function opsRuntime(): OpsRuntime {
  const g = globalThis as G;
  if (g[key]) return g[key] as OpsRuntime;
  const runtime = (g[key] = buildRuntime());
  for (const issue of runtime.limits.issues) log.warn("ops configuration issue", { scope: "ops", issue });
  const exporter = ensureTelemetryExport();
  if (exporter.error) log.warn("telemetry export disabled", { scope: "ops", reason: exporter.error });
  return runtime;
}

/** Tests: install a runtime built with injected dependencies, or clear it. */
export function setOpsRuntimeForTests(runtime: OpsRuntime | undefined): void {
  (globalThis as G)[key] = runtime;
}

/** Effective maintenance state: stored state merged with the host-level override. Never throws. */
export async function currentMaintenance(runtime: OpsRuntime = opsRuntime()): Promise<MaintenanceState> {
  const stored = platformConfigured() || runtime.maintenance.peek().version > 0 ? await runtime.maintenance.get() : runtime.maintenance.peek();
  const state = effectiveMaintenance(stored, runtime.limits.maintenanceOverride);
  const gauge = opsMetrics().maintenanceMode;
  for (const mode of ["off", "dispatch_paused", "read_only"] as const) gauge.set({ mode }, state.mode === mode ? 1 : 0);
  return state;
}

/** The bucket spec for a workspace's API traffic: its override, else the default scaled by its weight. */
export function apiSpecFor(limits: OpsLimits, quota: TenantQuota | null): { spec: BucketSpec; maxConcurrent: number } {
  const w = quota?.weight ?? 1;
  return {
    spec: {
      ratePerSec: quota?.apiRatePerSec ?? limits.api.ratePerSec * w,
      burst: quota?.apiBurst ?? Math.min(100_000, limits.api.burst * w),
    },
    maxConcurrent: quota?.maxConcurrentRequests ?? Math.min(10_000, limits.api.maxConcurrentPerTenant * w),
  };
}
