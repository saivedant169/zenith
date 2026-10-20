import { describe, expect, it } from "vitest";
import { bindDashboard, composeProfile, importImages, loadArtifacts, localCollector, runImport, validateArtifacts } from "../../deploy/observability/import-harness.mjs";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

describe("observability import contract (offline; no engine evidence)", () => {
  it("validates definitions and binds every panel and tenant variable to the provisioned datasource", () => {
    const artifacts = loadArtifacts();
    expect(validateArtifacts(artifacts)).toEqual({ panels: 18, alerts: 11, pipelines: 2 });
    const bound = bindDashboard(artifacts.dashboard);
    expect(JSON.stringify(bound)).not.toContain("${DS_PROMETHEUS}");
    expect(bound.__inputs).toBeUndefined();
    expect(bound.templating.list[0].datasource.uid).toBe("zenith-prometheus");
    expect(JSON.stringify(artifacts.dashboard)).toContain("${DS_PROMETHEUS}");
  });
  it("rejects missing queries, malformed alerts and undefined pipeline components", () => {
    for (const kind of ["panel", "rule", "collector"]) {
      const artifacts = loadArtifacts();
      if (kind === "panel") artifacts.dashboard.panels.find((panel: { targets?: unknown[] }) => panel.targets)?.targets.splice(0);
      if (kind === "rule") artifacts.rules.groups[0].rules[0].expr = "";
      if (kind === "collector") artifacts.collector.service.pipelines.traces.exporters = ["absent"];
      expect(() => validateArtifacts(artifacts)).toThrow();
    }
  });
  it("keeps the production trace backend separate from the bounded local sink", () => {
    const artifacts = loadArtifacts(), local = localCollector(artifacts.collector);
    expect(local.service.pipelines.traces.exporters).toEqual(["debug"]);
    expect(JSON.stringify(local)).not.toContain("ZENITH_TRACES_BACKEND_ENDPOINT");
    expect(artifacts.collector.service.pipelines.traces.exporters).toEqual(["otlp/traces"]);
    expect(local.processors.memory_limiter).toMatchObject({ limit_mib: 128, spike_limit_mib: 32 });
  });
  it("refuses unresolved image inputs instead of starting containers with floating tags", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "zenith-unresolved-obs-"));
    try { fs.mkdirSync(path.join(directory, "deploy/observability"), { recursive: true }); fs.writeFileSync(path.join(directory, "deploy/observability/images.env"), "ZENITH_PROMETHEUS_IMAGE=prom/prometheus:latest\n"); expect(() => importImages(directory)).toThrow("unresolved"); } finally { fs.rmSync(directory, { recursive: true, force: true }); }
  });
  it("reads only the three observability pins from the shared images.env", () => {
    expect(Object.keys(importImages())).toEqual(["ZENITH_PROMETHEUS_IMAGE", "ZENITH_GRAFANA_IMAGE", "ZENITH_OTEL_IMAGE"]);
  });
  it("uses loopback ports, bounded memory, read-only configs and only private ephemeral storage", () => {
    const image = `example/test@sha256:${createHash("sha256").update("offline image fixture").digest("hex")}`;
    const profile = composeProfile("/tmp/owned-j11", { ZENITH_PROMETHEUS_IMAGE: image, ZENITH_GRAFANA_IMAGE: image, ZENITH_OTEL_IMAGE: image });
    expect(Object.keys(profile.services)).toEqual(["prometheus", "collector", "grafana"]);
    for (const service of Object.values(profile.services)) {
      expect(service.mem_limit).toBe("256m"); expect(service.read_only).toBe(true);
      expect(service.cap_drop).toEqual(["ALL"]);
      for (const port of service.ports) expect(port).toMatch(/^127\.0\.0\.1::\d+$/);
    }
    expect(profile.services.prometheus.volumes.every(volume => volume.read_only)).toBe(true);
    expect(JSON.stringify(profile)).not.toContain("/var/run/docker.sock");
  });
  it("requires explicit engine opt-in before touching Docker", async () => {
    const prior = process.env.ZENITH_TEST_OBSERVABILITY_IMPORT; delete process.env.ZENITH_TEST_OBSERVABILITY_IMPORT;
    try { await expect(runImport()).rejects.toThrow("requires ZENITH_TEST_OBSERVABILITY_IMPORT"); } finally { if (prior !== undefined) process.env.ZENITH_TEST_OBSERVABILITY_IMPORT = prior; }
  });
});

describe.skipIf(process.env.ZENITH_TEST_OBSERVABILITY_IMPORT !== "1")("real observability import (not run: needs Docker and resolved pins on Mac)", () => {
  it("imports/readbacks dashboard, rules, tenant metrics and correlated traces; production-duration alert fires; owned containers are removed", async () => {
    const evidence = await runImport();
    expect(evidence).toMatchObject({ level: "local_engine", syntheticTelemetry: true, panels: 18, alerts: 11, pipelines: 2, tenantMetricReadback: true, alertFired: "ZenithControlStoreDown", correlatedTraceReadback: true });
  }, 480_000);
});
