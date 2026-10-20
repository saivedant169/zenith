#!/usr/bin/env node
/** Disposable local import rehearsal. It does not prove fairness or a production outage. */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { envValues, isPinned } from "../../scripts/deploy/pin-digests.mjs";

const ARTIFACTS = { dashboard: "grafana/zenith-control-plane.dashboard.json", rules: "alerts/zenith-control-plane.rules.json", collector: "otel/collector.json" };
const DATASOURCE = "zenith-prometheus";
const fail = (message) => { throw new Error(message); };
const sha256 = (value) => createHash("sha256").update(value).digest("hex");
export function loadArtifacts(root = process.cwd()) {
  const read = file => JSON.parse(fs.readFileSync(path.join(root, "deploy/observability", file), "utf8"));
  return { dashboard: read(ARTIFACTS.dashboard), rules: read(ARTIFACTS.rules), collector: read(ARTIFACTS.collector) };
}

/** Offline structural checks complement the catalog/runbook tests; engine validation is separate. */
export function validateArtifacts({ dashboard, rules, collector }) {
  if (dashboard.uid !== "zenith-control-plane" || typeof dashboard.title !== "string" || !Number.isInteger(dashboard.schemaVersion) || !Array.isArray(dashboard.panels) || !dashboard.panels.length) fail("Malformed Grafana dashboard");
  const panels = dashboard.panels.filter(panel => panel.type !== "row" && panel.type !== "text");
  if (new Set(dashboard.panels.map(panel => panel.id)).size !== dashboard.panels.length) fail("Duplicate Grafana panel id");
  for (const panel of panels) {
    if (panel.datasource?.type !== "prometheus" || panel.datasource?.uid !== "${DS_PROMETHEUS}" || !panel.targets?.length || panel.targets.some(target => typeof target.expr !== "string" || !target.expr.trim())) fail("Dashboard panel lacks an explicit datasource/query");
  }
  if (!Array.isArray(rules.groups) || !rules.groups.length) fail("Malformed Prometheus rule groups");
  const alerts = rules.groups.flatMap(group => {
    if (typeof group.name !== "string" || !Array.isArray(group.rules) || !group.rules.length) fail("Empty Prometheus rule group");
    return group.rules;
  });
  if (new Set(alerts.map(rule => rule.alert)).size !== alerts.length) fail("Duplicate alert name");
  for (const rule of alerts) if (typeof rule.alert !== "string" || typeof rule.expr !== "string" || !rule.expr.trim() || !/^\d+[smh]$/.test(rule.for) || !rule.labels?.severity || !rule.annotations?.runbook_url) fail("Malformed alert rule");
  for (const signal of ["metrics", "traces"]) {
    const pipeline = collector.service?.pipelines?.[signal];
    if (!pipeline || !pipeline.receivers?.includes("otlp") || !pipeline.exporters?.length) fail(`Missing ${signal} pipeline`);
    for (const section of ["receivers", "processors", "exporters"]) for (const name of pipeline[section] ?? []) if (!collector[section]?.[name]) fail(`Undefined collector ${section} component`);
  }
  if (!collector.receivers?.otlp?.protocols?.http || !collector.exporters?.prometheus) fail("Missing OTLP/Prometheus endpoint");
  return { panels: panels.length, alerts: alerts.length, pipelines: 2 };
}

export function bindDashboard(dashboard) {
  const bound = JSON.parse(JSON.stringify(dashboard).replaceAll("${DS_PROMETHEUS}", DATASOURCE));
  delete bound.__inputs;
  delete bound.id;
  return bound;
}

export function localCollector(collector) {
  const local = structuredClone(collector);
  // This profile uses a local debug trace sink, never the production trace endpoint.
  local.exporters = { prometheus: local.exporters.prometheus, debug: { verbosity: "detailed" } };
  local.service.pipelines.traces.exporters = ["debug"];
  local.processors.memory_limiter.limit_mib = 128;
  local.processors.memory_limiter.spike_limit_mib = 32;
  local.processors.batch.timeout = "1s";
  local.extensions = { health_check: { endpoint: "0.0.0.0:13133" } };
  local.service.extensions = ["health_check"];
  return local;
}

export function importImages(root = process.cwd()) {
  const pins = envValues(fs.readFileSync(path.join(root, "deploy/observability/images.env"), "utf8"));
  const keys = ["ZENITH_PROMETHEUS_IMAGE", "ZENITH_GRAFANA_IMAGE", "ZENITH_OTEL_IMAGE"];
  // images.env also pins the local-stack images (Mailpit, Stripe mock, Postgres); the import uses only these three.
  if (keys.some(key => !isPinned(pins[key] ?? ""))) fail("Observability images are unresolved; run pin-digests.mjs --resolve --scope bases on the Mac");
  return Object.fromEntries(keys.map(key => [key, pins[key]]));
}

export function composeProfile(directory, images) {
  const defaults = { read_only: true, cap_drop: ["ALL"], security_opt: ["no-new-privileges:true"], mem_limit: "256m", cpus: 0.5, pids_limit: 128, labels: { "io.zenith.j11-import": path.basename(directory) }, logging: { driver: "json-file", options: { "max-size": "2m", "max-file": "1" } } };
  const bind = (file, target) => ({ type: "bind", source: path.join(directory, file), target, read_only: true });
  return { services: {
    prometheus: { ...defaults, image: images.ZENITH_PROMETHEUS_IMAGE, command: ["--config.file=/etc/prometheus/prometheus.json", "--storage.tsdb.retention.time=1h", "--storage.tsdb.retention.size=32MB"], ports: ["127.0.0.1::9090"], volumes: [bind("prometheus.json", "/etc/prometheus/prometheus.json"), bind("rules.json", "/etc/prometheus/rules.json")], tmpfs: ["/prometheus:rw,noexec,nosuid,size=64m,mode=1777", "/tmp:rw,noexec,nosuid,size=16m"] },
    collector: { ...defaults, image: images.ZENITH_OTEL_IMAGE, command: ["--config=/etc/otelcol/config.json"], ports: ["127.0.0.1::4318", "127.0.0.1::13133"], volumes: [bind("collector.json", "/etc/otelcol/config.json")] },
    grafana: { ...defaults, image: images.ZENITH_GRAFANA_IMAGE, ports: ["127.0.0.1::3000"], environment: { GF_AUTH_ANONYMOUS_ENABLED: "true", GF_AUTH_ANONYMOUS_ORG_ROLE: "Admin", GF_AUTH_DISABLE_LOGIN_FORM: "true", GF_ANALYTICS_REPORTING_ENABLED: "false", GF_ANALYTICS_CHECK_FOR_UPDATES: "false", GF_ANALYTICS_CHECK_FOR_PLUGIN_UPDATES: "false", GF_PLUGINS_PREINSTALL_DISABLED: "true" }, tmpfs: ["/var/lib/grafana:rw,noexec,nosuid,size=64m,mode=1777", "/tmp:rw,noexec,nosuid,size=16m"] },
  } };
}

function command(binary, args) {
  const result = spawnSync(binary, args, { encoding: "utf8", timeout: 180_000, maxBuffer: 8 * 1024 * 1024, shell: false });
  if (result.status !== 0 || result.error) fail(`${binary} ${args[0]} failed; engine acceptance not established`);
  return result.stdout;
}

async function request(base, route, body) {
  const result = await fetch(`${base}${route}`, { method: body === undefined ? "GET" : "POST", headers: body === undefined ? {} : { "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(5000), redirect: "error" });
  if (!result.ok) fail(`Import API failed with HTTP ${result.status}`);
  const text = await result.text();
  return text ? JSON.parse(text) : {};
}

async function until(check, timeout = 120_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    try { const value = await check(); if (value) return value; } catch { /* bounded readiness retry; final failure stays fatal */ }
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  fail("Observability readiness/readback timed out");
}

/** No cloud endpoints, credentials, ambient compose project or production installation. */
export async function runImport(root = process.cwd()) {
  if (process.env.ZENITH_TEST_OBSERVABILITY_IMPORT !== "1") fail("Real import requires ZENITH_TEST_OBSERVABILITY_IMPORT=1 and Docker on the Mac");
  const artifacts = loadArtifacts(root), counts = validateArtifacts(artifacts), images = importImages(root);
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "zenith-obs-j11-"));
  const project = `zenith-obs-j11-${randomBytes(6).toString("hex")}`;
  const compose = path.join(directory, "compose.json");
  const dc = (...args) => command("docker", ["compose", "--project-name", project, "--file", compose, ...args]);
  let started = false, clean = false;
  try {
    const generated = { "rules.json": artifacts.rules, "collector-production.json": artifacts.collector, "collector.json": localCollector(artifacts.collector), "prometheus.json": { global: { scrape_interval: "5s", evaluation_interval: "5s" }, rule_files: ["/etc/prometheus/rules.json"], scrape_configs: [{ job_name: "zenith-collector", static_configs: [{ targets: ["collector:8889"] }] }] } };
    for (const [file, value] of Object.entries(generated)) fs.writeFileSync(path.join(directory, file), JSON.stringify(value, null, 2));
    fs.writeFileSync(compose, JSON.stringify(composeProfile(directory, images), null, 2));
    const validator = (name, memory) => ["run", "--rm", "--name", `${project}-${name}`, "--label", `io.zenith.j11-import=${path.basename(directory)}`, "--network", "none", "--memory", memory, "--cap-drop", "ALL", "--security-opt", "no-new-privileges"];
    command("docker", [...validator("promtool", "128m"), "--mount", `type=bind,src=${path.join(directory, "rules.json")},dst=/rules.json,readonly`, "--entrypoint", "/bin/promtool", images.ZENITH_PROMETHEUS_IMAGE, "check", "rules", "/rules.json"]);
    for (const file of ["collector-production.json", "collector.json"]) command("docker", [...validator(file === "collector.json" ? "collector-local-validate" : "collector-production-validate", "256m"), "--env", "ZENITH_TRACES_BACKEND_ENDPOINT=127.0.0.1:4317", "--mount", `type=bind,src=${path.join(directory, file)},dst=/config.json,readonly`, images.ZENITH_OTEL_IMAGE, "validate", "--config=/config.json"]);
    started = true; // includes a partially failed compose up in owned cleanup
    dc("up", "--detach");
    const endpoint = (service, port) => {
      const binding = dc("port", service, String(port)).trim();
      if (!/^127\.0\.0\.1:\d+$/.test(binding)) fail("Non-loopback or ambiguous published port refused");
      return `http://${binding}`;
    };
    const prom = endpoint("prometheus", 9090), grafana = endpoint("grafana", 3000), otlp = endpoint("collector", 4318), health = endpoint("collector", 13133);
    await until(async () => (await request(grafana, "/api/health")).database === "ok");
    await until(async () => { const response = await fetch(`${prom}/-/ready`, { signal: AbortSignal.timeout(5000) }); return response.ok; });
    await until(async () => { const response = await fetch(health, { signal: AbortSignal.timeout(5000) }); return response.ok; });
    await request(grafana, "/api/datasources", { name: "Zenith Prometheus", uid: DATASOURCE, type: "prometheus", access: "proxy", url: "http://prometheus:9090", isDefault: true });
    const dashboard = bindDashboard(artifacts.dashboard);
    const imported = await request(grafana, "/api/dashboards/db", { dashboard, overwrite: true });
    if (imported.uid !== dashboard.uid || imported.status !== "success") fail("Dashboard import was not acknowledged");
    const readback = await request(grafana, `/api/dashboards/uid/${dashboard.uid}`);
    // Grafana may add defaults; every imported field must retain its value.
    const retained = (expected, actual) => {
      if (Array.isArray(expected)) return Array.isArray(actual) && expected.length === actual.length && expected.every((value, index) => retained(value, actual[index]));
      if (expected && typeof expected === "object") return actual && typeof actual === "object" && Object.entries(expected).every(([key, value]) => retained(value, actual[key]));
      return expected === actual;
    };
    if (!retained(dashboard.panels, readback.dashboard.panels) || !retained(dashboard.templating, readback.dashboard.templating)) fail("Dashboard readback differs from imported panels or tenant filter");
    const source = await request(grafana, `/api/datasources/uid/${DATASOURCE}`);
    if (source.type !== "prometheus" || source.url !== "http://prometheus:9090") fail("Datasource readback differs");
    const traceId = randomBytes(16).toString("hex"), spanId = randomBytes(8).toString("hex"), operation = `j11-import-${randomBytes(6).toString("hex")}`;
    const now = (BigInt(Date.now()) * 1_000_000n).toString();
    const resource = { attributes: [{ key: "service.name", value: { stringValue: "zenith-j11-import" } }] };
    await request(otlp, "/v1/metrics", { resourceMetrics: [{ resource, scopeMetrics: [{ scope: { name: "zenith-j11-import" }, metrics: [{ name: "zenith_control_store_up", gauge: { dataPoints: [{ timeUnixNano: now, asDouble: 0 }] } }, { name: "zenith_active_operations", gauge: { dataPoints: [{ timeUnixNano: now, asDouble: 3, attributes: [{ key: "tenant", value: { stringValue: "j11-tenant-a" } }] }] } }] }] }] });
    await request(otlp, "/v1/traces", { resourceSpans: [{ resource, scopeSpans: [{ scope: { name: "zenith-j11-import" }, spans: [{ traceId, spanId, name: "j11-observability-import", kind: 2, startTimeUnixNano: now, endTimeUnixNano: (BigInt(now) + 1_000_000n).toString(), attributes: [{ key: "zenith.tenant.id", value: { stringValue: "j11-tenant-a" } }, { key: "zenith.operation.id", value: { stringValue: operation } }] }] }] }] });
    const query = encodeURIComponent('zenith_active_operations{tenant="j11-tenant-a"}');
    await until(async () => { const result = await request(prom, `/api/v1/query?query=${query}`); return result.status === "success" && result.data.result.some(item => item.value[1] === "3"); });
    const viaGrafana = await request(grafana, `/api/datasources/proxy/uid/${DATASOURCE}/api/v1/query?query=${query}`);
    if (viaGrafana.status !== "success" || !viaGrafana.data.result.some(item => item.value[1] === "3")) fail("Grafana datasource cannot read the imported tenant metric");
    const expectedAlerts = artifacts.rules.groups.flatMap(group => group.rules.map(rule => rule.alert)).sort();
    await until(async () => {
      const result = await request(prom, "/api/v1/rules");
      if (result.status !== "success") return false;
      const actual = result.data.groups.flatMap(group => group.rules);
      if (JSON.stringify(actual.map(rule => rule.name).sort()) !== JSON.stringify(expectedAlerts) || actual.some(rule => rule.health !== "ok" || rule.lastError)) return false;
      return actual.find(rule => rule.name === "ZenithControlStoreDown")?.state === "firing";
    }, 210_000); // retains the real production rule's two-minute pending duration
    await until(async () => { const logs = dc("logs", "--no-color", "collector"); return logs.includes(traceId) && logs.includes(operation) && logs.includes("zenith.tenant.id") && logs.includes("j11-tenant-a"); });
    return { level: "local_engine", syntheticTelemetry: true, ...counts, dashboardUid: dashboard.uid, tenantMetricReadback: true, alertFired: "ZenithControlStoreDown", correlatedTraceReadback: true, artifactsSha256: sha256(JSON.stringify(artifacts)), images, project };
  } finally {
    try {
      if (started) {
        dc("down", "--volumes", "--remove-orphans", "--timeout", "10");
        const remaining = command("docker", ["ps", "--all", "--quiet", "--filter", `label=com.docker.compose.project=${project}`]).trim();
        if (remaining) fail("Owned import containers survived cleanup");
      }
      // Also settle validators if their Docker client timed out before compose up.
      const selector = `label=io.zenith.j11-import=${path.basename(directory)}`;
      const validators = command("docker", ["ps", "--all", "--quiet", "--filter", selector]).trim().split(/\s+/).filter(Boolean);
      if (validators.some(id => !/^[a-f0-9]{12,64}$/.test(id))) fail("Invalid owned-container identity during cleanup");
      if (validators.length) command("docker", ["rm", "--force", ...validators]);
      if (command("docker", ["ps", "--all", "--quiet", "--filter", selector]).trim()) fail("Owned validator survived cleanup");
      clean = true;
    } finally {
      if (clean) fs.rmSync(directory, { recursive: true, force: true });
      else console.error(`Owned import cleanup failed; retained configuration at ${directory}`);
    }
  }
}

export async function main(args) {
  try {
    if (args.length !== 1 || !["lint", "run"].includes(args[0])) fail("usage: node deploy/observability/import-harness.mjs lint|run");
    console.log(JSON.stringify(args[0] === "lint" ? { level: "offline_structure", ...validateArtifacts(loadArtifacts()), engineValidation: "not run (needs Docker/promtool/collector on Mac)" } : await runImport()));
    return 0;
  } catch (error) { console.error(error.message); return 1; }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = await main(process.argv.slice(2));
