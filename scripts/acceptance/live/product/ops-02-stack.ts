/**
 * OPS-02 live: the runner's Zenith stack with the repository's own observability definitions loaded into a real Prometheus.
 *
 * The lean stack sets no CRON_SECRET, so its metrics route refuses every scrape. The API is recreated once with a
 * run-scoped secret (a private file; the composition file is rewritten and its original bytes are put back by close()).
 * Prometheus (the pinned deploy/observability/images.env image) runs on the host network as the runner's own user, scrapes
 * the API's /api/internal/metrics over the stack's TLS every 5 s and evaluates both rule files as shipped.
 *
 * The control-store outage stops the stack's Supabase database container; the full outage also stops the API and worker.
 * Nothing here prints a URL, key or secret; refusals name the step only.
 */
import { execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import type { EnvLike } from "../../config";
import { compose, docker, readState } from "../../default-stack/runtime.mjs";
import { envValues, isPinned } from "../../../deploy/pin-digests.mjs";
import { refuse, sanitizedError } from "./mix-03";
import { runnerStack } from "./mix-03-driver";
import { named } from "./ops-04-stack";

export interface PromSample { metric: Record<string, string>; value: number }
export interface Ops02Stack {
  /** Give the API a run-scoped CRON_SECRET and start Prometheus on it; resolves once the API target is up. */
  observe(): Promise<void>;
  /** One instant PromQL query. */
  query(expr: string): Promise<PromSample[]>;
  /** Names of the alerts Prometheus has firing now. */
  firing(): Promise<string[]>;
  stopControlStore(): Promise<void>;
  startControlStore(): Promise<void>;
  stop(services: ("api" | "execution-worker")[]): Promise<void>;
  start(service: "api" | "execution-worker"): Promise<void>;
  close(): Promise<void>;
}

type State = ReturnType<typeof readState> & { directory: string; compositionSha256: string; applicationInstallationId: string; projectId: string; installationId: string };
const run = promisify(execFile);
const PROM = "127.0.0.1:19090";
const RULES = ["zenith-control-plane.rules.json", "zenith-slo.rules.json"];

export function runnerOps02Stack(env: EnvLike, runId: string): Ops02Stack {
  const directory = env.ZENITH_DEFAULT_STACK_DIRECTORY?.trim() || refuse("no stack directory");
  const root = path.join(env.RUNNER_TEMP?.trim() || refuse("no runner temp"), "zenith-ops02");
  const original = readState(directory) as State;
  const file = path.join(original.directory, "installation", "stack.compose.json");
  const originalBytes = readFileSync(file);
  const container = `zenith-ops02-prometheus-${runId.slice(-4)}`;
  let active: State = original, started = false;

  const healthy = async (service: string) => {
    for (const deadline = Date.now() + 360_000; Date.now() < deadline; await new Promise(r => setTimeout(r, 5_000))) {
      const id = String(await compose(active, ["ps", "-q", service])).trim();
      if (!id) continue;
      const [item] = JSON.parse(String(await docker(["inspect", id]))) as { Config: { Labels?: Record<string, string> }; State: { Health?: { Status?: string } } }[];
      if (item?.Config.Labels?.["io.zenith.installation"] === original.applicationInstallationId && item.State.Health?.Status === "healthy") return;
    }
    refuse(`the ${service} container was not healthy within 6 minutes`);
  };
  const prom = async (pathname: string): Promise<unknown> => {
    const response = await fetch(`http://${PROM}${pathname}`, { signal: AbortSignal.timeout(10_000) });
    if (!response.ok) refuse(`Prometheus answered HTTP ${response.status}`);
    const body = await response.json() as { status?: string; data?: unknown };
    if (body.status !== "success") refuse("Prometheus did not answer success");
    return body.data;
  };
  const supabase = (service: string) => `supabase_${service}_${original.projectId}`;

  return {
    observe: () => named("starting Prometheus on the stack's metrics", async () => {
      if (existsSync(root)) refuse("the observability directory already exists");
      mkdirSync(root, { recursive: true, mode: 0o700 });
      const secret = randomBytes(32).toString("hex");
      writeFileSync(path.join(root, "cron.secret"), secret, { mode: 0o600 });
      const document = JSON.parse(readFileSync(file, "utf8")) as { services: Record<string, { environment?: Record<string, string> }> };
      document.services.api!.environment = { ...document.services.api!.environment, CRON_SECRET: secret };
      writeFileSync(file, JSON.stringify(document), { mode: 0o600 });
      active = { ...original, compositionSha256: createHash("sha256").update(readFileSync(file)).digest("hex") };
      await compose(active, ["up", "-d", "--no-deps", "api"]);
      await healthy("api");

      const image = envValues(readFileSync("deploy/observability/images.env", "utf8")).ZENITH_PROMETHEUS_IMAGE ?? "";
      if (!isPinned(image)) refuse("the Prometheus image is not pinned to a digest");
      copyFileSync(path.join(original.directory, "tls", "ca.crt"), path.join(root, "ca.crt"));
      for (const rules of RULES) copyFileSync(path.join("deploy/observability/alerts", rules), path.join(root, rules));
      // The scrape uses the API URL's own scheme: the runner stack serves plain HTTP on loopback (run 41164135020).
      const api = new URL(runnerStack(env).apiUrl), scheme = api.protocol === "https:" ? "https" : "http";
      writeFileSync(path.join(root, "prometheus.json"), JSON.stringify({
        global: { scrape_interval: "5s", evaluation_interval: "5s" },
        rule_files: RULES.map(rules => `/etc/zenith/${rules}`),
        scrape_configs: [{ job_name: "zenith-api", scheme, metrics_path: "/api/internal/metrics",
          authorization: { type: "Bearer", credentials_file: "/etc/zenith/cron.secret" }, ...(scheme === "https" ? { tls_config: { ca_file: "/etc/zenith/ca.crt" } } : {}),
          static_configs: [{ targets: [api.host] }] }],
      }), { mode: 0o600 });
      // The runner's own uid reads the 0600 files; the TSDB lives in a private tmpfs.
      const { stdout: uid } = await run("id", ["-u"]), { stdout: gid } = await run("id", ["-g"]);
      await docker(["run", "-d", "--name", container, "--label", `io.zenith.ops02=${runId}`, "--network", "host",
        "--user", `${uid.trim()}:${gid.trim()}`, "--read-only", "--tmpfs", "/prometheus:rw,size=256m,mode=1777", "--memory", "256m",
        "--mount", `type=bind,source=${root},target=/etc/zenith,readonly`, image,
        "--config.file=/etc/zenith/prometheus.json", `--web.listen-address=${PROM}`, "--storage.tsdb.path=/prometheus"]);
      started = true;
      for (const deadline = Date.now() + 120_000; ; await new Promise(r => setTimeout(r, 2_000))) {
        const data = await prom("/api/v1/targets").catch(() => undefined) as { activeTargets?: { health?: string; lastError?: string }[] } | undefined;
        if (data?.activeTargets?.some(t => t.health === "up")) return;
        if (Date.now() > deadline) {
          // Why: the target's own scrape error, or else the container's state and last log lines, scrubbed and elided.
          const target = data?.activeTargets?.[0];
          if (target) refuse(`Prometheus did not scrape the API's metrics within 2 minutes (target ${/^[a-z]{1,10}$/.test(target.health ?? "") ? target.health : "unknown"}: ${sanitizedError(target.lastError) ?? "no error"})`);
          const status = String(await docker(["inspect", "-f", "{{.State.Status}} exit {{.State.ExitCode}}", container]).catch(() => "absent")).trim();
          const logs = String(await docker(["logs", "--tail", "3", container]).catch(() => "")).split("\n").map(line => sanitizedError(line)).filter(Boolean).join(" | ");
          refuse(`Prometheus did not answer within 2 minutes (container ${/^[a-z]{1,12} exit \d{1,3}$/.test(status) ? status : "unknown"}${logs ? `; ${logs}` : ""})`);
        }
      }
    }),
    query: (expr) => named("a Prometheus query", async () => {
      const data = await prom(`/api/v1/query?query=${encodeURIComponent(expr)}`) as { result?: { metric?: Record<string, string>; value?: [number, string] }[] };
      return (data.result ?? []).map(r => ({ metric: r.metric ?? {}, value: Number(r.value?.[1]) }));
    }),
    firing: () => named("the Prometheus alerts", async () => {
      const data = await prom("/api/v1/alerts") as { alerts?: { labels?: { alertname?: string }; state?: string }[] };
      return (data.alerts ?? []).filter(a => a.state === "firing").map(a => String(a.labels?.alertname ?? ""));
    }),
    stopControlStore: () => named("stopping the control store", async () => { await docker(["stop", supabase("db")]); }),
    startControlStore: () => named("starting the control store", async () => {
      await docker(["start", supabase("db")]);
      // The pooler and REST service hold connections to the database: restart them onto the new one.
      await docker(["restart", supabase("pooler"), supabase("rest")]);
    }),
    stop: (services) => named(`stopping ${services.join(" and ")}`, async () => { await compose(active, ["stop", ...services]); }),
    start: (service) => named(`starting ${service}`, async () => { await compose(active, ["up", "-d", "--no-deps", service]); await healthy(service); }),
    async close() {
      if (started) await docker(["rm", "-f", container]).catch(() => undefined);
      writeFileSync(file, originalBytes, { mode: 0o600 });
    },
  };
}
