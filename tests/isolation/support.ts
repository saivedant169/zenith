/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * kubectl-driven helpers for the PROD-MAN-04/05 acceptance suite. These shell out to the
 * real `kubectl` against a real cluster; nothing here is a fake. They are only imported by
 * the gated suite (tests/isolation/tenant-isolation-acceptance.test.ts), which refuses to
 * run unless the target is a disposable kind cluster or an explicitly confirmed one.
 *
 * Every function takes the kubeconfig path explicitly; nothing reads or writes
 * ~/.kube/config.
 */
import { execFile, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface KubectlResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface KubectlOptions {
  input?: string;
  timeoutMs?: number;
  /** kubeconfig to use instead of the run's own (a token-only config for an attacker identity) */
  kubeconfig?: string;
}

export class Kube {
  constructor(readonly kubeconfig: string) {}

  /** Synchronous kubectl; never throws on a non-zero exit. */
  run(args: readonly string[], opts: KubectlOptions = {}): KubectlResult {
    const r = spawnSync("kubectl", ["--kubeconfig", opts.kubeconfig ?? this.kubeconfig, ...args], {
      input: opts.input,
      encoding: "utf8",
      timeout: opts.timeoutMs ?? 120_000,
      maxBuffer: 32 * 1024 * 1024,
    });
    return { code: r.status ?? (r.error ? 127 : 1), stdout: r.stdout ?? "", stderr: `${r.stderr ?? ""}${r.error ? String(r.error) : ""}` };
  }

  /** Asynchronous kubectl so a load generator and a measurement can run at once. */
  async runAsync(args: readonly string[], opts: KubectlOptions = {}): Promise<KubectlResult> {
    try {
      const { stdout, stderr } = await execFileAsync("kubectl", ["--kubeconfig", opts.kubeconfig ?? this.kubeconfig, ...args], {
        timeout: opts.timeoutMs ?? 300_000,
        maxBuffer: 32 * 1024 * 1024,
      });
      return { code: 0, stdout, stderr };
    } catch (e) {
      const err = e as { code?: number | string; stdout?: string; stderr?: string; message?: string };
      return { code: typeof err.code === "number" ? err.code : 1, stdout: err.stdout ?? "", stderr: `${err.stderr ?? ""}${err.message ?? ""}` };
    }
  }

  /** kubectl that must succeed; the error carries stderr and never the input. */
  must(args: readonly string[], opts: KubectlOptions = {}): string {
    const r = this.run(args, opts);
    if (r.code !== 0) throw new Error(`kubectl ${args.slice(0, 3).join(" ")} failed (${r.code}): ${r.stderr.trim().slice(0, 600)}`);
    return r.stdout;
  }

  json<T = any>(args: readonly string[]): T | undefined {
    const r = this.run([...args, "-o", "json"]);
    if (r.code !== 0) return undefined;
    return JSON.parse(r.stdout) as T;
  }

  /** Server-side apply a list of objects with a field manager of this suite. */
  apply(objects: readonly object[], opts: { dryRun?: boolean } = {}): KubectlResult {
    const list = { apiVersion: "v1", kind: "List", items: objects };
    return this.run(["apply", "--server-side", "--force-conflicts", "--field-manager=zenith-isolation-acceptance", ...(opts.dryRun ? ["--dry-run=server"] : []), "-f", "-"], { input: JSON.stringify(list) });
  }

  /** Create exactly one object and report the server's verdict (PSA and quota are decided at create). */
  create(object: object): KubectlResult {
    return this.run(["create", "-f", "-"], { input: JSON.stringify(object) });
  }

  canI(as: string | undefined, verb: string, resource: string, namespace?: string, subresource?: string): boolean {
    const r = this.run(["auth", "can-i", verb, resource, ...(subresource ? [`--subresource=${subresource}`] : []), ...(namespace ? ["-n", namespace] : []), ...(as ? [`--as=${as}`] : [])]);
    return r.stdout.trim() === "yes";
  }

  contextName(): string {
    return this.run(["config", "current-context"]).stdout.trim();
  }
}

/** A kubeconfig that carries one bearer token and no client certificate, for acting as a ServiceAccount from outside the cluster. */
export function tokenKubeconfig(kube: Kube, token: string): { path: string; dispose: () => void } {
  const flat = JSON.parse(kube.must(["config", "view", "--minify", "--flatten", "-o", "json"])) as { clusters: unknown[]; contexts: { context: { cluster: string } }[] };
  const dir = mkdtempSync(path.join(tmpdir(), "zenith-iso-token-"));
  const file = path.join(dir, "kubeconfig");
  const clusterName = flat.contexts[0].context.cluster;
  const config = {
    apiVersion: "v1",
    kind: "Config",
    clusters: flat.clusters,
    users: [{ name: "attacker", user: { token } }],
    contexts: [{ name: "attacker", context: { cluster: clusterName, user: "attacker" } }],
    "current-context": "attacker",
  };
  writeFileSync(file, JSON.stringify(config), { mode: 0o600 });
  return { path: file, dispose: () => rmSync(dir, { recursive: true, force: true }) };
}

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export async function eventually<T>(what: string, attempt: () => T | undefined | false | null | Promise<T | undefined | false | null>, opts: { timeoutMs: number; intervalMs?: number }): Promise<T> {
  const deadline = Date.now() + opts.timeoutMs;
  for (;;) {
    const got = await attempt();
    if (got !== undefined && got !== false && got !== null) return got;
    if (Date.now() >= deadline) throw new Error(`timed out after ${opts.timeoutMs} ms waiting for ${what}`);
    await sleep(opts.intervalMs ?? 2000);
  }
}

/** DNS-1123 safe random suffix. */
export const randomSuffix = (bytes = 4): string => Array.from({ length: bytes * 2 }, () => "0123456789abcdef"[Math.floor(Math.random() * 16)]).join("");

/* ------------------------------ pod construction ----------------------------- */

export interface PodOptions {
  name: string;
  namespace: string;
  image: string;
  script: string;
  labels?: Record<string, string>;
  serviceAccountName?: string;
  /** container resources; left out means the namespace LimitRange supplies the defaults */
  resources?: Record<string, unknown>;
  runtimeClassName?: string;
  volumes?: unknown[];
  volumeMounts?: unknown[];
  restartPolicy?: "Never" | "Always" | "OnFailure";
  /** mutate the pod spec to build an adversarial pod */
  mutate?: (pod: any) => void;
}

/** A pod that satisfies the restricted Pod Security Standard unless `mutate` says otherwise. */
export function restrictedPod(o: PodOptions): Record<string, unknown> {
  const pod: any = {
    apiVersion: "v1",
    kind: "Pod",
    metadata: { name: o.name, namespace: o.namespace, labels: { "zenith-test": "iso", ...(o.labels ?? {}) } },
    spec: {
      restartPolicy: o.restartPolicy ?? "Never",
      automountServiceAccountToken: false,
      terminationGracePeriodSeconds: 0,
      ...(o.serviceAccountName ? { serviceAccountName: o.serviceAccountName } : {}),
      ...(o.runtimeClassName ? { runtimeClassName: o.runtimeClassName } : {}),
      securityContext: { runAsNonRoot: true, runAsUser: 10001, runAsGroup: 10001, seccompProfile: { type: "RuntimeDefault" } },
      containers: [
        {
          name: "main",
          image: o.image,
          command: ["/bin/sh", "-c", o.script],
          securityContext: { allowPrivilegeEscalation: false, capabilities: { drop: ["ALL"] } },
          ...(o.resources ? { resources: o.resources } : {}),
          ...(o.volumeMounts ? { volumeMounts: o.volumeMounts } : {}),
        },
      ],
      ...(o.volumes ? { volumes: o.volumes } : {}),
    },
  };
  o.mutate?.(pod);
  return pod;
}

export interface ProbeResult {
  phase: string;
  log: string;
  exitCode?: number;
  reason?: string;
}

/** Run one short-lived pod to completion and return its log. The pod is always removed. */
export async function runPod(kube: Kube, o: PodOptions, timeoutMs = 150_000): Promise<ProbeResult> {
  const created = kube.create(restrictedPod(o));
  if (created.code !== 0) throw new Error(`probe pod ${o.name} was refused: ${created.stderr.trim().slice(0, 400)}`);
  try {
    const done = await eventually(
      `pod ${o.namespace}/${o.name} to finish`,
      () => {
        const p = kube.json<any>(["-n", o.namespace, "get", "pod", o.name]);
        const phase = p?.status?.phase as string | undefined;
        return phase === "Succeeded" || phase === "Failed" ? p : undefined;
      },
      { timeoutMs, intervalMs: 1500 }
    );
    const log = kube.run(["-n", o.namespace, "logs", o.name, "--limit-bytes=65536"]).stdout.trim();
    const term = done.status?.containerStatuses?.[0]?.state?.terminated;
    return { phase: done.status.phase, log, exitCode: term?.exitCode, reason: term?.reason ?? done.status?.reason };
  } finally {
    kube.run(["-n", o.namespace, "delete", "pod", o.name, "--grace-period=0", "--force", "--ignore-not-found", "--wait=false"]);
  }
}

/** Start a long-running pod and wait until it is Ready (or fail naming why). */
export async function startPod(kube: Kube, o: PodOptions, timeoutMs = 150_000): Promise<{ ip: string }> {
  const created = kube.create(restrictedPod({ ...o, restartPolicy: o.restartPolicy ?? "Always" }));
  if (created.code !== 0) throw new Error(`pod ${o.name} was refused: ${created.stderr.trim().slice(0, 400)}`);
  return eventually(
    `pod ${o.namespace}/${o.name} to be Ready`,
    () => {
      const p = kube.json<any>(["-n", o.namespace, "get", "pod", o.name]);
      const ready = p?.status?.conditions?.some((c: any) => c.type === "Ready" && c.status === "True");
      return ready && p.status.podIP ? { ip: p.status.podIP as string } : undefined;
    },
    { timeoutMs, intervalMs: 1500 }
  );
}

export const deletePod = (kube: Kube, namespace: string, name: string): void => {
  kube.run(["-n", namespace, "delete", "pod", name, "--grace-period=0", "--force", "--ignore-not-found", "--wait=false"]);
};

/**
 * Connection-level reachability as a marker, REACHED or BLOCKED. Any HTTP status line counts as reached (an API server
 * answers a plaintext request with a 400; a firewalled address answers nothing), so a refusal from the far side is never
 * mistaken for a network block.
 */
export const reach = (url: string, timeoutS = 4): string =>
  `out=$(wget -q -T ${timeoutS} -S -O /dev/null '${url}' 2>&1); if echo "$out" | grep -q 'HTTP/'; then echo REACHED; else echo BLOCKED; fi`;

/* --------------------------------- statistics -------------------------------- */

export function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return Number.NaN;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[i];
}

export interface LatencyStats {
  n: number;
  failures: number;
  p50: number;
  p95: number;
  p99: number;
  max: number;
}

/** Parse the output of `latencyScript`: one `LAT <ms>` or `ERR` per request. */
export function parseLatency(log: string): LatencyStats {
  const ms: number[] = [];
  let failures = 0;
  for (const line of log.split(/\r?\n/)) {
    const m = /^LAT (\d+(?:\.\d+)?)$/.exec(line.trim());
    if (m) ms.push(Number(m[1]));
    else if (line.trim() === "ERR") failures++;
  }
  ms.sort((a, b) => a - b);
  return { n: ms.length + failures, failures, p50: percentile(ms, 50), p95: percentile(ms, 95), p99: percentile(ms, 99), max: ms.length ? ms[ms.length - 1] : Number.NaN };
}

/**
 * A busybox script that times `count` sequential requests to `url`, `gapMs` apart.
 * Time comes from /proc/uptime through awk (10 ms resolution), so it needs no `date +%N`.
 */
export const latencyScript = (url: string, count: number, gapMs: number): string =>
  `now() { awk '{ printf "%d", $1 * 1000 }' /proc/uptime; }
i=0
while [ $i -lt ${count} ]; do
  t0=$(now)
  if wget -q -T 5 -O /dev/null '${url}'; then t1=$(now); echo "LAT $((t1 - t0))"; else echo ERR; fi
  i=$((i + 1))
  sleep ${(gapMs / 1000).toFixed(3)}
done`;

/** Bound check for a victim's latency under a neighbour's load. Provisional targets; see docs/platform/TENANT-ISOLATION.md. */
export function latencyBound(baseline: LatencyStats, factor: number, absoluteMs: number): number {
  return Math.max(baseline.p95 * factor, baseline.p95 + absoluteMs);
}
