/**
 * Loopback-only worker probes. Liveness reports the HTTP process; readiness
 * requires current Temporal/store reachability, a loaded policy and registered
 * drivers. The actual worker also requires a current durable sweep observation.
 * Probe errors and configuration/identity never enter HTTP responses.
 * Checks are bounded in time and shared by concurrent requests. A stuck check
 * remains single-flight rather than accumulating new background checks.
 */
import { createServer, type Server } from "node:http";
import { metricsRegistry } from "@/lib/ops/telemetry/metrics";

export type CheckStatus = "ok" | "unavailable" | "unknown";
export type HealthCheck = () => boolean | undefined | Promise<boolean | undefined>;
export interface ReadinessChecks {
  temporal: HealthCheck;
  store: HealthCheck;
  policy: HealthCheck;
  drivers: HealthCheck;
  /** Actual worker supplies this; older pure health callers keep their four checks. */
  reconciliation?: HealthCheck;
}
export interface ReadinessResult {
  ready: boolean;
  checks: Record<"temporal" | "store" | "policy" | "drivers", CheckStatus> & { reconciliation?: CheckStatus };
}
export const HEALTH_CHECK_TIMEOUT_MS = 2000;
const MAX_ABANDONED = 2;

export function healthPortFromEnv(env: Readonly<Record<string, string | undefined>> = process.env): number {
  const raw = env.ZENITH_WORKER_HEALTH_PORT?.trim() || "9464";
  const port = Number(raw);
  if (!/^\d+$/.test(raw) || !Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error("ZENITH_WORKER_HEALTH_PORT must be an integer from 1 to 65535.");
  return port;
}

export function readinessProbe(checks: ReadinessChecks, timeoutMs = HEALTH_CHECK_TIMEOUT_MS): () => Promise<ReadinessResult> {
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30_000) throw new Error("Health check timeout must be from 1 to 30000 milliseconds.");
  const keys: (keyof ReadinessChecks)[] = ["temporal", "store", "policy", "drivers"];
  if (checks.reconciliation) keys.push("reconciliation");
  const pending = new Map<keyof ReadinessChecks, { check: Promise<CheckStatus>; started: number }>();
  // A check that outlived its timeout (e.g. a query on a connection that died in a network partition and never
  // answers) is abandoned so a later probe retries; at most MAX_ABANDONED per dependency stay outstanding.
  const abandoned = new Map<keyof ReadinessChecks, number>();
  return async () => {
    const statuses = await Promise.all(keys.map(async (key): Promise<CheckStatus> => {
      let entry = pending.get(key);
      if (entry && Date.now() - entry.started >= timeoutMs && (abandoned.get(key) ?? 0) < MAX_ABANDONED) {
        abandoned.set(key, (abandoned.get(key) ?? 0) + 1);
        void entry.check.then(() => abandoned.set(key, (abandoned.get(key) ?? 1) - 1));
        pending.delete(key); entry = undefined;
      }
      let check = entry?.check;
      if (!check) {
        const started = Date.now();
        check = Promise.resolve().then(() => checks[key]?.()).then((ok): CheckStatus => ok === undefined ? "unknown" : ok === true ? "ok" : "unavailable", (): CheckStatus => "unavailable");
        const created = check;
        pending.set(key, { check: created, started });
        void created.then(() => { if (pending.get(key)?.check === created) pending.delete(key); });
      }
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        return await Promise.race([check, new Promise<CheckStatus>((resolve) => { timer = setTimeout(() => resolve("unavailable"), timeoutMs); })]);
      } finally { if (timer) clearTimeout(timer); }
    }));
    return { ready: statuses.every((status) => status === "ok"), checks: Object.fromEntries(keys.map((key, i) => [key, statuses[i]])) as ReadinessResult["checks"] };
  };
}

export async function startHealthServer(options: { port: number; checks: ReadinessChecks; timeoutMs?: number }): Promise<{ server: Server; port: number; close(): Promise<void> }> {
  if (!Number.isInteger(options.port) || options.port < 0 || options.port > 65535) throw new Error("Health port is invalid.");
  const probe = readinessProbe(options.checks, options.timeoutMs);
  const server = createServer((req, res) => {
    res.setHeader("content-type", "application/json");
    res.setHeader("cache-control", "no-store");
    const send = (status: number, body: unknown): void => { res.writeHead(status); res.end(JSON.stringify(body)); };
    if (req.method !== "GET" && req.method !== "HEAD") { res.setHeader("allow", "GET, HEAD"); send(405, { error: "method_not_allowed" }); return; }
    const pathname = req.url?.split("?", 1)[0];
    if (pathname === "/healthz") { send(200, { alive: true }); return; }
    // PROD-OPS-02: Prometheus scrape of this worker (loopback listener; fair-scheduling and activity metrics).
    if (pathname === "/metrics") { res.setHeader("content-type", "text/plain; version=0.0.4; charset=utf-8"); res.writeHead(200); res.end(req.method === "HEAD" ? undefined : metricsRegistry().renderPrometheus()); return; }
    if (pathname !== "/readyz") { send(404, { error: "not_found" }); return; }
    void probe().then((result) => send(result.ready ? 200 : 503, result));
  });
  server.requestTimeout = 5000;
  server.headersTimeout = 5000;
  await new Promise<void>((resolve, reject) => {
    const failed = (): void => { reject(new Error("Worker health listener could not start; check ZENITH_WORKER_HEALTH_PORT.")); };
    server.once("error", failed);
    server.listen(options.port, "127.0.0.1", () => { server.off("error", failed); resolve(); });
  });
  const address = server.address();
  return {
    server, port: typeof address === "object" && address ? address.port : options.port,
    close: () => new Promise<void>((resolve, reject) => { server.close((err) => err ? reject(new Error("Worker health listener could not close.")) : resolve()); server.closeIdleConnections(); }),
  };
}
