/** Contract-only planner/runner tests. Faked exec never establishes engine or live evidence. */
import { mkdtempSync, writeFileSync, readFileSync, unlinkSync, symlinkSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { LOCAL_TARGETS, localTargetLane, requiredChecks, validateLocalReceipt, localEnvironment, loopbackUrl } from "../../scripts/release/local-targets";
import { localPaths, upLocal, downLocal, assertLocalDocker } from "../../scripts/release/local-environment";
import { mixedObjects } from "../../scripts/release/local-kubernetes";
import { localTargetCli } from "../../scripts/release/local-target-runner";
import { runAcceptance, classifyVitest, type Exec } from "../../scripts/release/acceptance-orchestrator";
import { SCENARIOS, type Scenario } from "../../scripts/release/scenarios";
import { memoryStore } from "../../scripts/release/checkpoint";
import { approvedScope } from "./_support";
import { handler } from "../../fixtures/mixed-app/enricher/lambda.mjs";
import { handler as enrich } from "../../fixtures/mixed-app/enricher/handler.mjs";
import { j4ReadinessRoute, maintenanceEnvironment } from "../../scripts/release/local-joined";
import { createEnricherServer } from "../../fixtures/mixed-app/enricher/server.mjs";
import { createStoreFromEnv } from "../../fixtures/mixed-app/web/stores.mjs";

const commit = "a".repeat(40);
const runId = "j15-test";
const temp = () => mkdtempSync(path.join(os.tmpdir(), "j15-contract-"));
const receipt = (scenarioId = "stateful-traffic") => ({
  schema: 1, evidenceLabel: "local_rehearsal", scenarioId, runId, sourceCommit: commit,
  checks: requiredChecks(scenarioId).map(id => ({ id, status: "passed" })), limits: ["Contract fixture; no engine was executed."],
});
describe("local target boundaries", () => {
  it("requires scenario-specific J2 evidence and retains uncovered scenarios as incomplete", async () => {
    const { journeyScenarioStatus } = await import("../../scripts/release/local-joined");
    expect(journeyScenarioStatus("rotation", { status: "passed", checks: [{ id: "connection-rotation-readback", status: "passed" }] })).toBe("passed");
    expect(journeyScenarioStatus("revocation", { status: "passed", checks: [{ id: "connection-rotation-readback", status: "passed" }] })).toBe("failed");
    expect(journeyScenarioStatus("restore", { status: "passed", checks: [] })).toBe("skipped");
    expect(journeyScenarioStatus("rotation", { status: "passed", checks: [{ id: "connection-rotation-readback", status: "passed" }, { id: "connection-rotation-readback", status: "passed" }] })).toBe("failed");
  });
  it("maps all nineteen scenarios, including joined journeys, to gated targets", () => {
    expect(Object.keys(LOCAL_TARGETS).sort()).toEqual(SCENARIOS.map(s => s.id).sort());
    for (const scenario of SCENARIOS) {
      const drv1 = ["private-source", "update-rollback"].includes(scenario.id);
      const drv2 = ["drift-repair", "crash-partition"].includes(scenario.id);
      const drv3 = scenario.id === "upgrade" || scenario.id === "restore";
      const drv4 = scenario.id === "two-tenants" || scenario.id === "export";
      const gates = ["ZENITH_LOCAL_TARGETS=1", "ZENITH_LOCAL_RUN_ID", "ZENITH_LOCAL_ROOT", ...(drv1 ? ["ZENITH_LOCAL_DRV1=1", "ZENITH_DEFAULT_JOURNEY=1", "ZENITH_ACCEPTANCE_DEFAULT_STACK=1", "ZENITH_LOCAL_JOURNEY_CONFIG_FILE"] : []), ...(drv2 ? ["ZENITH_LOCAL_JOINED_DRIVERS=1", "ZENITH_ACCEPTANCE_DEFAULT_STACK=1", "ZENITH_ACCEPTANCE_DEFAULT_STACK_DIR", "ZENITH_DEFAULT_JOURNEY=1", "ZENITH_LOCAL_JOURNEY_CONFIG_FILE", "ZENITH_TEST_DRV2_OPERATED=1"] : []), ...(drv3 ? ["ZENITH_LOCAL_OPERATED=1", "ZENITH_LOCAL_JOINED_DRIVERS=1", "ZENITH_ACCEPTANCE_DEFAULT_STACK=1", "ZENITH_DEFAULT_JOURNEY=1", "ZENITH_ACCEPTANCE_DEFAULT_STACK_DIR", "ZENITH_LOCAL_JOURNEY_CONFIG_FILE", ...(scenario.id === "upgrade" ? ["ZENITH_LOCAL_UPGRADE_IMAGES_FILE"] : [])] : []), ...(drv4 ? ["ZENITH_LOCAL_DRIVER_D4=1", "ZENITH_LOCAL_JOINED_DRIVERS=1", "ZENITH_DEFAULT_JOURNEY=1", "ZENITH_ACCEPTANCE_DEFAULT_STACK=1", "ZENITH_ACCEPTANCE_DEFAULT_STACK_DIR", "ZENITH_LOCAL_JOURNEY_CONFIG_FILE"] : []),
        ...(scenario.id === "export" ? ["ZENITH_LOCAL_EXPORT_DATA=1", "ZENITH_LOCAL_EXPORT_POSTGRES_IMAGE", "ZENITH_LOCAL_EXPORT_MYSQL_IMAGE", "ZENITH_LOCAL_EXPORT_MINIO_IMAGE"] : [])];
      expect(localTargetLane(scenario)).toMatchObject({ kind: "local_engine", gates, evidenceLabel: drv1 || drv2 || drv3 || drv4 ? "local_operated_rehearsal" : "local_rehearsal" });
    }
    expect(LOCAL_TARGETS["install"]).toMatchObject({ owner: "J1" });
    expect(LOCAL_TARGETS["machine-schedules"]).toMatchObject({ owner: "J4" });
  });
  it("refuses before accessing engines when the local gate is absent", async () => {
    expect(() => localPaths({})).toThrow("ZENITH_LOCAL_TARGETS=1");
    expect(await localTargetCli(["up"], {} as NodeJS.ProcessEnv)).toBe(2);
    expect(() => localPaths({ ZENITH_LOCAL_TARGETS: "1", ZENITH_LOCAL_RUN_ID: "../foreign", ZENITH_LOCAL_ROOT: temp() })).toThrow("run id");
    expect(() => localPaths({ ZENITH_LOCAL_TARGETS: "1", ZENITH_LOCAL_RUN_ID: runId, ZENITH_LOCAL_ROOT: path.parse(process.cwd()).root })).toThrow("root");
  });
  it("strips real credentials and live gates from child environments", () => {
    const fakeSecret = Array.from({ length: 24 }, (_, n) => n.toString(36)).join("");
    const env = localEnvironment({ PATH: "local", AWS_SECRET_ACCESS_KEY: fakeSecret, GOOGLE_APPLICATION_CREDENTIALS: "/foreign", ZENITH_LIVE_MIXED: "1", ZENITH_LOCAL_TARGETS: "1", ZENITH_LOCAL_ROOT: "/private", ZENITH_TEST_KIND: "1" });
    expect(env).not.toHaveProperty("AWS_SECRET_ACCESS_KEY");
    expect(env).not.toHaveProperty("GOOGLE_APPLICATION_CREDENTIALS");
    expect(env).not.toHaveProperty("ZENITH_LIVE_MIXED");
    expect(env).toMatchObject({ ZENITH_LOCAL_TARGETS: "1", ZENITH_TEST_KIND: "1", AWS_EC2_METADATA_DISABLED: "true" });
  });
  it("requires a literal dedicated loopback endpoint", () => {
    expect(loopbackUrl("http://127.0.0.1:12111", 12111).hostname).toBe("127.0.0.1");
    for (const url of ["https://api.stripe.com", "http://localhost:12111", "http://127.0.0.1:8080", "http://u:p@127.0.0.1:12111"]) expect(() => loopbackUrl(url, 12111)).toThrow();
  });
  it("keeps database private and splits TLS keys and service account authority", () => {
    const objects = mixedObjects({ runId, image: "local:1", postgresImage: "postgres:16.6-alpine", localstackIp: "172.20.0.2", variant: "lambda" });
    const json = JSON.stringify(objects);
    expect(json).not.toContain('"type":"LoadBalancer"');
    expect(json).not.toContain("nodePort");
    expect(json).not.toContain("hostPort");
    expect(json).toContain('"secretName":"web-pki"');
    expect(json).toContain('"secretName":"enricher-pki"');
    expect(json).toContain('"POSTGRES_PASSWORD_FILE"');
    expect(json).not.toContain("ca.key");
    expect(objects.filter(o => o.kind === "Deployment").every(o => JSON.stringify(o).includes('"automountServiceAccountToken":false'))).toBe(true);
  });
});
describe("owned engine setup", () => {
  it("refuses remote Docker before any engine call", async () => {
    const calls: string[][] = [];
    await expect(assertLocalDocker({ NODE_ENV: "test", DOCKER_HOST: "ssh://cloud.example.test" }, async argv => { calls.push([...argv]); return { code: 0, stdout: "", stderr: "" }; })).rejects.toThrow("remote Docker");
    expect(calls).toEqual([]);
    await expect(assertLocalDocker({ NODE_ENV: "test", DOCKER_HOST: "unix:///local.sock" })).resolves.toBeUndefined();
  });
  it("refuses existing clusters and projects before any mutation", async () => {
    for (const collision of ["cluster", "project"]) {
      const root = mkdtempSync(path.join(os.tmpdir(), `zenith-j15-${runId}-`));
      const calls: string[][] = [];
      const exec: Exec = async argv => { calls.push([...argv]); return { code: 0, stdout: argv.includes("context") ? "unix:///local.sock" : argv[0] === "kind" && collision === "cluster" ? `zenith-j15-${runId}\n` : argv[0] === "docker" && collision === "project" ? "owned-by-someone-else" : "", stderr: "" }; };
      await expect(upLocal("mixed", "lambda", { ZENITH_LOCAL_TARGETS: "1", ZENITH_LOCAL_RUN_ID: runId, ZENITH_LOCAL_ROOT: root }, exec)).rejects.toThrow("existing");
      expect(calls.every(c => c.includes("get") || c.includes("ps") || c.includes("context"))).toBe(true);
    }
  });
  it("reads host/none networks with null IPAM config and still refuses an ACME subnet overlap", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), `zenith-j15-${runId}-`));
    const networks = [{ IPAM: { Config: null } }, { IPAM: { Config: [{ Subnet: "172.30.115.0/25" }] } }];
    const exec: Exec = async argv => ({ code: 0, stdout: argv.includes("context") ? "unix:///local.sock" : argv.includes("ls") ? "host\nowned\n" : argv.includes("inspect") ? JSON.stringify(networks) : "", stderr: "" });
    await expect(upLocal("acme", "lambda", { ZENITH_LOCAL_TARGETS: "1", ZENITH_LOCAL_RUN_ID: runId, ZENITH_LOCAL_ROOT: root }, exec)).rejects.toThrow("ACME subnet overlaps");
  });
  it("refuses foreign cleanup state before touching Docker or kind", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), `zenith-j15-${runId}-`));
    writeFileSync(path.join(root, "state.json"), JSON.stringify({ schema: 1, runId, root, cluster: "foreign" }));
    const calls: string[][] = [];
    await expect(downLocal({ ZENITH_LOCAL_TARGETS: "1", ZENITH_LOCAL_RUN_ID: runId, ZENITH_LOCAL_ROOT: root }, async argv => { calls.push([...argv]); return { code: 0, stdout: "", stderr: "" }; })).rejects.toThrow("ownership");
    expect(calls).toEqual([]);
  });
});
describe("strict local receipts", () => {
  it("rejects foreign, missing, duplicate, empty and live-labelled evidence", () => {
    const expected = { scenarioId: "stateful-traffic", runId, sourceCommit: commit };
    expect(validateLocalReceipt(receipt(), expected).checks).toHaveLength(4);
    for (const bad of [
      { ...receipt(), sourceCommit: "b".repeat(40) }, { ...receipt(), runId: "foreign-run" },
      { ...receipt(), evidenceLabel: "live_sandbox" }, { ...receipt(), checks: [] },
      { ...receipt(), checks: receipt().checks.slice(1) },
      { ...receipt(), checks: [...receipt().checks, receipt().checks[0]] },
    ]) expect(() => validateLocalReceipt(bad, expected)).toThrow();
  });
  it("rejects malformed numeric test evidence", () => {
    expect(classifyVitest(0, { numPassedTests: -1 }).status).toBe("failed");
    expect(classifyVitest(0, { numPassedTests: Number.NaN }).status).toBe("failed");
    expect(classifyVitest(0, { numPassedTests: 1.5 }).status).toBe("failed");
  });
  it("requires outage, recovery and outage readback checks for a recovery receipt", () => {
    expect(requiredChecks("mixed-recovery")).toEqual(expect.arrayContaining(["partition-unavailable", "partition-recovered", "outage-readback"]));
  });
});
describe("Lambda and container fixture equivalence", () => {
  const order = { clientKey: "j15-order", sku: "widget", qty: 2 };
  it("uses the same rules for direct Lambda, HTTP Gateway and container payloads", async () => {
    const expected = await enrich(order);
    expect(await handler(order)).toMatchObject(expected);
    expect(await handler({ body: JSON.stringify(order) })).toMatchObject(expected);
    expect(await handler({ body: Buffer.from(JSON.stringify(order)).toString("base64"), isBase64Encoded: true })).toMatchObject(expected);
    expect((await handler({ body: "malformed" })).statusCode).toBe(400);
    expect((await handler({ body: "x".repeat(4097) })).statusCode).toBe(413);
  });
  it("refuses partial TLS configuration without a downgrade or memory fallback", async () => {
    expect(() => createEnricherServer({ env: { NODE_ENV: "test", ENRICHER_SERVER_CA_FILE: "/missing" } as NodeJS.ProcessEnv })).toThrow("All enricher");
    const urlFile = path.join(temp(), "db-url"); writeFileSync(urlFile, "postgres://web@db.invalid/mixed");
    await expect(createStoreFromEnv({ NODE_ENV: "test", DATABASE_URL_FILE: urlFile, DATABASE_CA_FILE: "/missing" } as NodeJS.ProcessEnv)).rejects.toThrow("All database");
  });
});
describe("local targets in the release orchestrator", () => {
  function fakeExec(mode: "pass" | "missing" | "skip" | "foreign" | "failed-check" | "skipped-check" = "pass"): Exec {
    return async argv => {
      if (argv[0] === "git") return { code: 0, stdout: commit, stderr: "" };
      const vitestOut = argv.find(a => a.startsWith("--outputFile="));
      if (vitestOut) writeFileSync(vitestOut.slice(13), JSON.stringify({ numPassedTests: 3, numFailedTests: 0, numPendingTests: 0 }));
      const index = argv.indexOf("--receipt");
      if (index >= 0) {
        if (mode === "skip") return { code: 2, stdout: "", stderr: "" };
        const r = receipt();
        if (mode === "foreign") r.sourceCommit = "b".repeat(40);
        if (mode === "failed-check") r.checks[0]!.status = "failed";
        if (mode === "skipped-check") r.checks[0]!.status = "skipped";
        if (mode !== "missing") writeFileSync(argv[index + 1]!, JSON.stringify(r));
      }
      return { code: index >= 0 && mode === "skipped-check" ? 3 : 0, stdout: "", stderr: "" };
    };
  }
  const options = () => ({ root: process.cwd(), outDir: temp(), runId, only: ["stateful-traffic"], includeLive: false, localTargets: true });
  const env = { ZENITH_LOCAL_TARGETS: "1", ZENITH_LOCAL_RUN_ID: runId, ZENITH_LOCAL_ROOT: temp() };
  it("accepts a bound local receipt but never promotes its deferred live lane", async () => {
    const calls: NodeJS.ProcessEnv[] = [];
    const exec = fakeExec();
    const report = await runAcceptance(options(), { exec: async (argv, options) => { if (options.env) calls.push(options.env); return exec(argv, options); }, env: { ...env, ZENITH_LIVE_MIXED: "1" }, store: memoryStore() });
    expect(calls.every(e => !e.ZENITH_LIVE_MIXED)).toBe(true);
    expect(report.summary).toMatchObject({ local_passed_live_pending: 1, verified_live: 0 });
    expect(report.scenarios[0]!.lanes.at(-1)).toMatchObject({ status: "passed", evidenceLabel: "local_rehearsal", counts: { passed: 4, failed: 0, skipped: 0 } });
  });
  it.each(["missing", "foreign", "failed-check"] as const)("fails %s evidence despite exit zero", async mode => {
    const report = await runAcceptance(options(), { exec: fakeExec(mode), env, store: memoryStore() });
    expect(report.summary.failed).toBe(1);
  });
  it.each(["skip", "skipped-check"] as const)("keeps %s incomplete", async mode => {
    const report = await runAcceptance(options(), { exec: fakeExec(mode), env, store: memoryStore() });
    expect(report.summary.incomplete).toBe(1);
  });
  it("keeps missing local gates deferred and refuses mixing local and live runs", async () => {
    const report = await runAcceptance(options(), { exec: fakeExec(), env: { ZENITH_LOCAL_RUN_ID: runId }, store: memoryStore() });
    expect(report.scenarios[0]!.lanes.at(-1)).toMatchObject({ status: "deferred" });
    await expect(runAcceptance({ ...options(), includeLive: true })).rejects.toThrow("separate runs");
    await expect(runAcceptance(options(), { env: { ...env, ZENITH_LOCAL_RUN_ID: "foreign" } })).rejects.toThrow("Run id");
  });
  it("rejects an empty scenario selection", async () => {
    await expect(runAcceptance({ ...options(), only: [] }, { exec: fakeExec(), env })).rejects.toThrow("No scenario");
  });
  it("refuses resume if a completed result artifact is missing", async () => {
    const opts = options(); const store = memoryStore();
    await runAcceptance(opts, { exec: fakeExec(), env, store });
    unlinkSync(path.join(opts.outDir, runId, "lanes/stateful-traffic.local-target.json"));
    await expect(runAcceptance(opts, { exec: fakeExec(), env, store })).rejects.toThrow("result artifact");
    expect(JSON.parse(readFileSync(path.join(opts.outDir, runId, "acceptance-report.json"), "utf8")).summary.verified_live).toBe(0);
  });
});

describe("live vitest receipt honesty (faked command only, no cloud)", () => {
  it.each(["skipped-tests", "missing-json", "failed-tests", "zero-tests"])("does not promote %s on exit zero", async mode => {
    const scenario: Scenario = {
      id: "receipt-test", title: "Receipt contract", requirements: ["PROD-REL-01"], limits: "Contract-only fake exec.",
      lanes: [
        { id: "component", kind: "contract", files: ["tests/release/acceptance-scenarios.test.ts"] },
        { id: "live", kind: "live_sandbox", command: ["npx", "vitest", "run", "tests/live/mixed-connectivity.live.test.ts"], files: ["tests/live/mixed-connectivity.live.test.ts"],
          scopeHarness: "mixed-connectivity-live", gates: ["LOCAL_LIVE_GATE=1"], skipExitCodes: [], deferredBecause: "Explicit fake contract only" },
      ],
    };
    const exec: Exec = async argv => {
      if (argv[0] === "git") return { code: 0, stdout: commit, stderr: "" };
      const out = argv.find(a => a.startsWith("--outputFile="))!;
      const live = argv.includes("vitest");
      if (!live || mode !== "missing-json") writeFileSync(out.slice(13), JSON.stringify({
        numPassedTests: live && mode === "zero-tests" ? 0 : 2,
        numFailedTests: live && mode === "failed-tests" ? 1 : 0,
        numPendingTests: live && mode === "skipped-tests" ? 1 : 0,
      }));
      return { code: 0, stdout: "", stderr: "" };
    };
    const report = await runAcceptance({ root: process.cwd(), outDir: temp(), runId, includeLive: true, scenarios: [scenario] }, { exec, env: { LOCAL_LIVE_GATE: "1" }, scope: approvedScope(), store: memoryStore() });
    expect(report.summary.verified_live).toBe(0);
    expect(report.scenarios[0]!.lanes[1]!.status).toBe(mode === "failed-tests" ? "failed" : "skipped");
  });
});

describe("J4 owned maintenance environment join", () => {
  const credential = randomBytes(24).toString("hex");
  const base: NodeJS.ProcessEnv = { NODE_ENV: "test", ZENITH_PLATFORM_DB_URL: `postgresql://postgres:${credential}@localhost:6543/postgres`, ZENITH_TEMPORAL_NAMESPACE: "zenith-disposable", ZENITH_J4_API_ORIGIN: "http://127.0.0.1:36400" };
  const overlay = { ZENITH_PLATFORM_DB_URL: `postgresql://postgres:${credential}@127.0.0.1:6543/j4_fresh`, ZENITH_PLATFORM_DB_MAX: "2", ZENITH_TEMPORAL_ADDRESS: "127.0.0.1:17233", ZENITH_TEMPORAL_NAMESPACE: "j4-owned", ZENITH_J4_API_ORIGIN: "http://127.0.0.1:3100", ZENITH_J4_CRON_SECRET_FILE: path.join(os.tmpdir(), "j4-cron.secret"), ZENITH_DATA: path.join(os.tmpdir(), "j4-worker"), ZENITH_SERVERLESS: "1", ZENITH_BILLING: "managed" };
  it("derives one actual product/control database while preserving J1 credentials", () => {
    const env = maintenanceEnvironment(base, overlay);
    expect(env.SUPABASE_DB_URL).toBe(env.ZENITH_PLATFORM_DB_URL);
    expect(env.ZENITH_PLATFORM_MIGRATION_URL).toBe(env.ZENITH_PLATFORM_DB_URL);
    expect(env.ZENITH_TEMPORAL_NAMESPACE).toBe("j4-owned");
  });
  it("does not downgrade NODE_ENV outside explicit owned local J4 gates", () => {
    const env = maintenanceEnvironment({ ...base, NODE_ENV: "production" }, overlay);
    expect(env.NODE_ENV).toBe("production");
    expect(env.ZENITH_TOFU_BIN).toBeUndefined();
    expect(env.ZENITH_TOFU_IDENTITY_FILE).toBeUndefined();
  });
  it("uses test mode and explicit native OpenTofu paths only for owned local J4", () => {
    const root = temp(), bin = path.join(root, "tofu"), identity = path.join(root, "identity.json");
    writeFileSync(bin, "path-only test fixture; never executed", { mode: 0o700 });
    writeFileSync(identity, "path-only test fixture; runtime identity checks remain mandatory", { mode: 0o600 });
    const stack = path.join(root, "stack");
    const ownedBase = { ...base, NODE_ENV: "production" as const, ZENITH_LOCAL_JOINED_DRIVERS: "1", ZENITH_ACCEPTANCE_DEFAULT_STACK: "1",
      ZENITH_ACCEPTANCE_DEFAULT_STACK_DIR: stack, ZENITH_LOCAL_STACK_DIRECTORY: stack, ZENITH_TEST_MAINTENANCE: "1",
      ZENITH_TEMPORAL_ADDRESS: "127.0.0.1:17233", ZENITH_LOCAL_TOFU_BIN: bin, ZENITH_LOCAL_TOFU_IDENTITY_FILE: identity };
    const env = maintenanceEnvironment(ownedBase, overlay);
    expect(env.NODE_ENV).toBe("test");
    expect(env.ZENITH_TOFU_BIN).toBe(bin);
    expect(env.ZENITH_TOFU_IDENTITY_FILE).toBe(identity);
    expect(env.ZENITH_LOCAL_TOFU_BIN).toBe(bin);
  });
  it("refuses missing, relative, or symlinked OpenTofu paths for owned local J4", () => {
    const root = temp(), bin = path.join(root, "tofu"), identity = path.join(root, "identity.json");
    writeFileSync(bin, "path-only test fixture; never executed", { mode: 0o700 });
    writeFileSync(identity, "path-only test fixture; runtime identity checks remain mandatory", { mode: 0o600 });
    const symlink = path.join(root, "tofu-link"); symlinkSync(bin, symlink);
    const stack = path.join(root, "stack");
    const ownedBase = { ...base, NODE_ENV: "production" as const, ZENITH_LOCAL_JOINED_DRIVERS: "1", ZENITH_ACCEPTANCE_DEFAULT_STACK: "1",
      ZENITH_ACCEPTANCE_DEFAULT_STACK_DIR: stack, ZENITH_LOCAL_STACK_DIRECTORY: stack, ZENITH_TEST_MAINTENANCE: "1",
      ZENITH_TEMPORAL_ADDRESS: "127.0.0.1:17233", ZENITH_LOCAL_TOFU_BIN: bin, ZENITH_LOCAL_TOFU_IDENTITY_FILE: identity };
    expect(() => maintenanceEnvironment({ ...ownedBase, ZENITH_LOCAL_TOFU_BIN: undefined }, overlay)).toThrow(/Explicit owned J4 OpenTofu paths/);
    expect(() => maintenanceEnvironment({ ...ownedBase, ZENITH_LOCAL_TOFU_BIN: "tofu" }, overlay)).toThrow(/Explicit owned J4 OpenTofu paths/);
    expect(() => maintenanceEnvironment({ ...ownedBase, ZENITH_LOCAL_TOFU_BIN: symlink }, overlay)).toThrow(/owned regular non-symlink/);
  });
  it.each(["http://127.0.0.1:6543/j4_fresh", `postgresql://postgres:${credential}@example.test:6543/j4_fresh`, `postgresql://postgres:${credential}@localhost:6544/j4_fresh`, `postgresql://foreign:${credential}@localhost:6543/j4_fresh`])("refuses a re-pointed database %s", url => {
    expect(() => maintenanceEnvironment(base, { ...overlay, ZENITH_PLATFORM_DB_URL: url })).toThrow(/exact local server/);
  });
  it("refuses unrelated credentials, ordinary namespace and timer/billing mode changes", () => {
    expect(() => maintenanceEnvironment(base, { ...overlay, AWS_SECRET_ACCESS_KEY: randomBytes(24).toString("hex") })).toThrow(/Unknown/);
    for (const change of [{ ZENITH_TEMPORAL_NAMESPACE: "zenith-disposable" }, { ZENITH_SERVERLESS: "0" }, { ZENITH_BILLING: "stripe" }, { ZENITH_PLATFORM_DB_MAX: "20" }, { ZENITH_J4_API_ORIGIN: "https://example.test" }]) expect(() => maintenanceEnvironment(base, { ...overlay, ...change })).toThrow();
  });
});

describe("deferred J4 readiness routing", () => {
  const deferred = { j4Mode: "deferred" } as Parameters<typeof j4ReadinessRoute>[0];
  it("routes only machine-schedules to J4 prestart readiness", () => {
    expect(j4ReadinessRoute(deferred, "machine-schedules")).toBe("j4");
    for (const scenario of ["install", "plan-approval", "rotation", "revocation", "restore", "billing"]) {
      expect(() => j4ReadinessRoute(deferred, scenario)).toThrow("Deferred J4 stack refuses J1, J2, install and non-J4 scenarios");
    }
  });
  it("refuses J4 machine-schedules without the deferred owner state", () => {
    for (const j4Mode of [undefined, "canonical"]) {
      expect(() => j4ReadinessRoute({ j4Mode } as Parameters<typeof j4ReadinessRoute>[0], "machine-schedules"))
        .toThrow("J4 machine-schedules requires its owned deferred J4 stack");
    }
    expect(j4ReadinessRoute({ j4Mode: "canonical" } as Parameters<typeof j4ReadinessRoute>[0], "install")).toBe("j1");
  });
  it("keeps every readiness route blocked while canonical resume is in progress", () => {
    const resuming = { j4Mode: "resuming" } as Parameters<typeof j4ReadinessRoute>[0];
    for (const scenario of ["machine-schedules", "install", "plan-approval", "rotation", "revocation", "restore", "billing"]) {
      expect(() => j4ReadinessRoute(resuming, scenario))
        .toThrow("J1 and J2 remain blocked until explicit J4 resume passes ordinary readiness");
    }
  });
});
