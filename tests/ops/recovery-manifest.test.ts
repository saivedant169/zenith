/**
 * PROD-OPS-04: the backup manifest, the integrity checks, the restore gates that fire BEFORE any database is
 * touched, the connection hygiene of the tool runner and the RPO/RTO arithmetic. No database, no external tool:
 * these are the contract-level checks. The real pg_dump / pg_restore / Temporal rehearsal is
 * tests/ops/recovery-rehearsal.test.ts.
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  BACKUP_MANIFEST_FORMAT, COMPONENT_IDS, MANIFEST_FILE, describeFile, parseManifest, sealManifest, verifyBackupDirectory,
  type BackupManifest, type ComponentId, type ManifestComponent,
} from "@/lib/ops/recovery/manifest";
import { RecoveryToolError, mustRun, pgArgs, scrub, toolsFromEnv, type CommandRunner } from "@/lib/ops/recovery/process";
import { sloDefinitions } from "@/lib/slo/definitions";
import { deliverReport, measureRecovery, registerRecoveryMeasurementSink, targetsFromEnv } from "@/lib/ops/recovery/report";
import { runRestore, terminateOpenTemporalWorkflows, type RestoreOptions } from "@/lib/ops/recovery/restore";

let dir: string;
beforeEach(async () => { dir = await mkdtemp(path.join(os.tmpdir(), "zenith-recovery-")); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

const temporalListEntry = (workflowId: string, runId: string, status = "WORKFLOW_EXECUTION_STATUS_RUNNING") => ({ execution: { workflowId, runId }, status });
const temporalDescribe = (workflowId: string, runId: string, status = "WORKFLOW_EXECUTION_STATUS_TERMINATED") => ({ workflowExecutionInfo: { execution: { workflowId, runId }, status } });

function temporalCommandRunner(lists: string[], describes: string[] = []) {
  const commands: string[][] = [];
  const run: CommandRunner = async (_file, args) => {
    commands.push([...args]);
    if (args[1] === "list") return { code: 0, stdout: lists.shift() ?? "[]", stderr: "" };
    if (args[1] === "terminate") return { code: 0, stdout: "Workflow terminated", stderr: "" };
    if (args[1] === "describe") return { code: 0, stdout: describes.shift() ?? "{}", stderr: "" };
    return { code: 2, stdout: "", stderr: "unexpected command" };
  };
  return { run, commands };
}

describe("recovery Temporal termination contract", () => {
  it("terminates each exact observed execution and verifies terminal status plus an empty unchanged query", async () => {
    const observed = [temporalListEntry("op-first", "run-1"), temporalListEntry("reconcile-second", "run-2")];
    const runner = temporalCommandRunner(
      [JSON.stringify(observed), "[]"],
      [JSON.stringify(temporalDescribe("op-first", "run-1")), JSON.stringify(temporalDescribe("reconcile-second", "run-2"))],
    );
    await expect(terminateOpenTemporalWorkflows(runner.run, "/temporal", "owned-ns", "127.0.0.1:7239")).resolves.toBe(2);
    const terminations = runner.commands.filter((args) => args[1] === "terminate");
    expect(terminations).toHaveLength(2);
    expect(terminations[0]).toEqual(["workflow", "terminate", "--address", "127.0.0.1:7239", "--namespace", "owned-ns", "--workflow-id", "op-first", "--run-id", "run-1", "--reason", "platform store restored (recovery epoch)"]);
    expect(terminations[1]).toContain("reconcile-second");
    expect(runner.commands.filter((args) => args[1] === "list")).toHaveLength(2);
    expect(runner.commands.filter((args) => args[1] === "describe")).toHaveLength(2);
  });

  it.each([
    ["malformed JSON", "not JSON"],
    ["an out-of-scope workflow id", JSON.stringify([temporalListEntry("other-workflow", "run-1")])],
    ["a missing run id", JSON.stringify([{ execution: { workflowId: "op-first" }, status: "WORKFLOW_EXECUTION_STATUS_RUNNING" }])],
    ["an unexpected execution identity field", JSON.stringify([{ execution: { workflowId: "op-first", runId: "run-1", namespace: "foreign" }, status: "WORKFLOW_EXECUTION_STATUS_RUNNING" }])],
    ["a duplicate identity", JSON.stringify([temporalListEntry("op-first", "run-1"), temporalListEntry("op-first", "run-1")])],
  ])("refuses %s before terminating anything", async (_case, initial) => {
    const runner = temporalCommandRunner([initial, "[]"]);
    await expect(terminateOpenTemporalWorkflows(runner.run, "/temporal", "owned-ns")).rejects.toMatchObject({ code: "refused" });
    expect(runner.commands.some((args) => args[1] === "terminate")).toBe(false);
  });

  it.each([
    ["a mismatched run id", temporalDescribe("op-first", "different-run")],
    ["a mismatched workflow id", temporalDescribe("op-other", "run-1")],
    ["a nonterminal status", temporalDescribe("op-first", "run-1", "WORKFLOW_EXECUTION_STATUS_RUNNING")],
  ])("refuses when describe returns %s", async (_case, description) => {
    const runner = temporalCommandRunner([JSON.stringify([temporalListEntry("op-first", "run-1")]), "[]"], [JSON.stringify(description)]);
    await expect(terminateOpenTemporalWorkflows(runner.run, "/temporal", "owned-ns")).rejects.toMatchObject({ code: "refused" });
  });

  it("refuses when another matching workflow remains open after the observed executions terminate", async () => {
    const runner = temporalCommandRunner(
      [JSON.stringify([temporalListEntry("op-first", "run-1")]), JSON.stringify([temporalListEntry("reconcile-new", "run-2")])],
      [JSON.stringify(temporalDescribe("op-first", "run-1"))],
    );
    await expect(terminateOpenTemporalWorkflows(runner.run, "/temporal", "owned-ns")).rejects.toMatchObject({ code: "refused" });
  });
});

const component = (id: ComponentId, over: Partial<ManifestComponent> = {}): ManifestComponent =>
  ({ id, title: id, status: "covered", method: "none", note: "in the platform dump", files: [], facts: {}, ...over });

async function writeBackup(over: { components?: (files: Awaited<ReturnType<typeof describeFile>>[]) => ManifestComponent[]; keys?: BackupManifest["keys"] } = {}): Promise<BackupManifest> {
  await writeFile(path.join(dir, "database.dump"), Buffer.from("PGDMP-not-really-but-bytes-are-bytes"));
  const dump = await describeFile(dir, "database.dump");
  const components = over.components?.([dump]) ?? COMPONENT_IDS.map((id) => id === "platform"
    ? component("platform", { status: "captured", method: "pg_dump", note: "", files: [dump], facts: { schemas: "platform", "rows.operations": 3 } })
    : id === "customer_state" ? component(id, { status: "referenced", note: "customer's bucket" })
    : component(id, id === "keys" ? { status: "captured", method: "key_registry", note: "" } : {}));
  const manifest = sealManifest({
    format: BACKUP_MANIFEST_FORMAT, backupId: "bk-1", startedAt: "2026-10-07T10:00:00.000Z", finishedAt: "2026-10-07T10:00:05.000Z",
    platform: { schemaVersion: 41, recoveryEpoch: 0, serverVersion: "16.4", snapshotAt: "2026-10-07T10:00:01.000Z" },
    keys: over.keys ?? [], components,
  });
  await writeFile(path.join(dir, MANIFEST_FILE), JSON.stringify(manifest, null, 2));
  return manifest;
}

describe("manifest integrity", () => {
  it("a complete backup verifies, and the digest covers everything but itself", async () => {
    const manifest = await writeBackup();
    const result = await verifyBackupDirectory(dir);
    expect(result).toMatchObject({ ok: true, filesChecked: 1 });
    expect(result.manifest?.digest).toBe(manifest.digest);
    expect(manifest.digest).toMatch(/^[0-9a-f]{64}$/);
  });

  it("an edited file, a missing file, a resized file and an edited manifest are each refused", async () => {
    await writeBackup();
    await writeFile(path.join(dir, "database.dump"), Buffer.from("PGDMP-not-really-but-bytes-are-BYTES"));
    expect((await verifyBackupDirectory(dir)).problems.map((p) => p.code)).toEqual(["file_digest"]);
    await writeFile(path.join(dir, "database.dump"), Buffer.from("short"));
    expect((await verifyBackupDirectory(dir)).problems.map((p) => p.code)).toEqual(["file_size"]);
    await rm(path.join(dir, "database.dump"));
    expect((await verifyBackupDirectory(dir)).problems.map((p) => p.code)).toEqual(["file_missing"]);

    await writeBackup();
    const text = await readFile(path.join(dir, MANIFEST_FILE), "utf8");
    await writeFile(path.join(dir, MANIFEST_FILE), text.replace('"schemaVersion": 41', '"schemaVersion": 40'));
    expect((await verifyBackupDirectory(dir)).problems.map((p) => p.code)).toContain("manifest_digest");
  });

  it("refuses an unreadable manifest, a foreign format and a path that escapes the backup", async () => {
    expect((await verifyBackupDirectory(dir)).problems[0]?.code).toBe("manifest_unreadable");
    await writeFile(path.join(dir, MANIFEST_FILE), "{ not json");
    expect((await verifyBackupDirectory(dir)).problems[0]?.code).toBe("manifest_unreadable");
    expect(parseManifest(JSON.stringify({ format: "other" })).problems[0]?.code).toBe("manifest_format");
    const escaping = sealManifest({
      format: BACKUP_MANIFEST_FORMAT, backupId: "bk-2", startedAt: "2026-10-07T10:00:00.000Z", finishedAt: "2026-10-07T10:00:05.000Z",
      platform: { schemaVersion: 41, recoveryEpoch: 0, serverVersion: "16.4", snapshotAt: "2026-10-07T10:00:01.000Z" }, keys: [],
      components: [component("platform", { status: "captured", method: "pg_dump", note: "", files: [{ path: "../outside.dump", bytes: 1, sha256: "a".repeat(64) }] })],
    });
    await writeFile(path.join(dir, MANIFEST_FILE), JSON.stringify(escaping));
    const result = await verifyBackupDirectory(dir);
    expect(result.ok).toBe(false);
    expect(result.problems.map((p) => p.code)).toContain("file_name");
  });

  it("a captured file component with no files is refused as incomplete", () => {
    const m = sealManifest({
      format: BACKUP_MANIFEST_FORMAT, backupId: "bk-3", startedAt: "2026-10-07T10:00:00.000Z", finishedAt: "2026-10-07T10:00:05.000Z",
      platform: { schemaVersion: 41, recoveryEpoch: 0, serverVersion: "16.4", snapshotAt: "2026-10-07T10:00:01.000Z" }, keys: [],
      components: [component("platform", { status: "captured", method: "pg_dump", note: "", files: [] })],
    });
    expect(parseManifest(JSON.stringify(m)).problems.map((p) => p.code)).toContain("component_incomplete");
  });
});

describe("restore into a new database", () => {
  it("skips CREATE SCHEMA for dumped schemas the target already has (public), restoring everything else", async () => {
    await writeBackup({ components: (files) => COMPONENT_IDS.map((id) => id === "platform"
      ? component("platform", { status: "captured", method: "pg_dump", note: "", files, facts: { schemas: "platform,public" } })
      : id === "customer_state" ? component(id, { status: "referenced", note: "customer's bucket" })
      : component(id, id === "keys" ? { status: "captured", method: "key_registry", note: "" } : {})) });
    const toc = ["; Archive", "6; 2615 25092 SCHEMA - platform postgres", "4; 2615 2200 SCHEMA - public pg_database_owner",
      "3413; 0 0 COMMENT - SCHEMA public pg_database_owner", "220; 1259 25093 TABLE public t postgres"].join("\n");
    let used: { list: string; args: readonly string[]; file: string } | undefined;
    const run: CommandRunner = async (_file, args) => {
      if (args[0] === "--list") return { code: 0, stdout: toc, stderr: "" };
      const file = args[args.indexOf("--use-list") + 1];
      used = { list: await readFile(file, "utf8"), args, file };
      return { code: 1, stdout: "", stderr: "stop here" };
    };
    const target = { query: async (sql: string) => sql.includes("pg_namespace") ? [{ n: "public" }] : [], close: async () => undefined };
    const report = await runRestore({ run, tools: toolsFromEnv({}), openTarget: async () => target as never }, {
      backupDir: dir, targetUrl: "postgres://u:pw@127.0.0.1:5432/target", runId: "restore-list-1", actor: "operator:a", reason: "list test",
      confirmCustomerState: true, keysAvailable: [], reportFile: path.join(dir, "out", "report.json") });
    expect(used?.list.split("\n")).toEqual(["; Archive", "6; 2615 25092 SCHEMA - platform postgres", "3413; 0 0 COMMENT - SCHEMA public pg_database_owner", "220; 1259 25093 TABLE public t postgres"]);
    expect(used?.args.at(-1)).toBe(path.join(dir, "database.dump"));
    await expect(readFile(used!.file)).rejects.toThrow();
    expect(report.steps.at(-1)).toMatchObject({ id: "after_empty", status: "refused" });
  });
});

describe("restore gates (all fire before any database is opened)", () => {
  const neverOpen = (): Promise<never> => { throw new Error("the target database must not be opened"); };
  const noRun: CommandRunner = async () => { throw new Error("no tool must run"); };
  const base = (over: Partial<RestoreOptions> = {}): RestoreOptions => ({
    backupDir: dir, targetUrl: "postgres://u:secret-pw@127.0.0.1:5432/target", runId: "restore-gates-1", actor: "operator:a", reason: "gate test",
    confirmCustomerState: true, keysAvailable: [], reportFile: path.join(dir, "out", "report.json"), ...over,
  });
  const run = (over?: Partial<RestoreOptions>) => runRestore({ run: noRun, tools: toolsFromEnv({}), openTarget: neverOpen }, base(over));

  it("refuses a damaged backup at verify and still writes a report", async () => {
    await writeBackup();
    await writeFile(path.join(dir, "database.dump"), Buffer.from("tampered tampered tampered tampered!"));
    const report = await run();
    expect(report.ok).toBe(false);
    expect(report.steps.at(-1)).toMatchObject({ id: "verify", status: "refused" });
    expect(JSON.parse(await readFile(path.join(dir, "out", "report.json"), "utf8"))).toMatchObject({ ok: false, runId: "restore-gates-1" });
  });

  it("refuses without the customer-state confirmation, with the reason", async () => {
    await writeBackup();
    const report = await run({ confirmCustomerState: false });
    expect(report.steps.at(-1)).toMatchObject({ id: "gates", status: "refused" });
    expect(report.steps.at(-1)?.detail).toMatch(/customer/i);
  });

  it("refuses a skipped component unless the operator accepts that gap by name", async () => {
    await writeBackup({ components: (files) => COMPONENT_IDS.map((id) => id === "platform"
      ? component("platform", { status: "captured", method: "pg_dump", note: "", files, facts: { schemas: "platform" } })
      : id === "temporal" ? component(id, { status: "skipped", note: "unreachable" })
      : id === "customer_state" ? component(id, { status: "referenced" })
      : component(id, id === "keys" ? { status: "captured", method: "key_registry", note: "" } : {})) });
    const refused = await run();
    expect(refused.steps.at(-1)).toMatchObject({ id: "gates", status: "refused" });
    expect(refused.steps.at(-1)?.detail).toContain("--accept-skipped temporal");
    // accepted by name: the next gate (keys) is reached instead
    const accepted = await run({ acceptSkipped: ["temporal"], productDataDir: undefined });
    expect(accepted.steps.map((s) => s.id)).toContain("gates");
    expect(accepted.steps.find((s) => s.id === "gates")?.status).toBe("ok");
  });

  it("refuses a manifest that omits a component", async () => {
    await writeBackup({ components: (files) => [component("platform", { status: "captured", method: "pg_dump", note: "", files })] });
    const report = await run();
    expect(report.steps.at(-1)).toMatchObject({ id: "gates", status: "refused" });
    expect(report.steps.at(-1)?.detail).toMatch(/no entry for/);
  });

  it("refuses to restore when this host lacks a key id the backup needs, naming ids only", async () => {
    await writeBackup({ keys: [{ purpose: "enc:vault", keyId: "k-needed", role: "current" }, { purpose: "signing:control", keyId: "k-sign", role: "verify_only" }] });
    const report = await run({ keysAvailable: [{ purpose: "enc:vault", keyId: "k-needed", role: "current" }] });
    expect(report.steps.at(-1)).toMatchObject({ id: "keys", status: "refused" });
    const detail = report.steps.at(-1)!.detail;
    expect(detail).toContain("signing:control:k-sign");
    expect(detail).not.toContain("k-needed");
    expect(detail).not.toContain("secret-pw");
    expect(report.epoch).toBeNull();
  });

  it("a restore report records the measurement and never a connection string", async () => {
    await writeBackup();
    const report = await run({ confirmCustomerState: false, incidentAt: "2026-10-07T10:30:00.000Z" });
    const text = await readFile(path.join(dir, "out", "report.json"), "utf8");
    expect(text).not.toContain("secret-pw");
    expect(text).not.toContain("postgres://");
    expect(report.measurement).toMatchObject({ rpoSeconds: 1799, incidentAt: "2026-10-07T10:30:00.000Z" });
  });
});

describe("tool hygiene", () => {
  it("never puts a password on a command line", () => {
    const conn = pgArgs("postgres://user:p%40ss@db.example.com:6543/zenith?sslmode=require");
    expect(conn.args.join(" ")).not.toContain("p%40ss");
    expect(conn.args.join(" ")).not.toContain("p@ss");
    expect(conn.env).toMatchObject({ PGPASSWORD: "p@ss", PGSSLMODE: "require" });
    expect(conn.label).toBe("db.example.com:6543/zenith");
    expect(conn.args).toEqual(["--host", "db.example.com", "--port", "6543", "--username", "user", "--dbname", "zenith"]);
  });

  it("hands libpq the operator's PGSSLROOTCERT, since the child sees no other environment", () => {
    const url = "postgres://u:pw@localhost:6543/zenith?sslmode=verify-full";
    expect(pgArgs(url, { PGSSLROOTCERT: "/stack/tls/ca.crt" }).env).toMatchObject({ PGSSLMODE: "verify-full", PGSSLROOTCERT: "/stack/tls/ca.crt" });
    expect(pgArgs(url, {}).env).not.toHaveProperty("PGSSLROOTCERT");
    expect(() => pgArgs(url, { PGSSLROOTCERT: "ca.crt" })).toThrow(/PGSSLROOTCERT must be an absolute path/);
  });

  it("refuses a non-postgres or database-less URL without echoing it", () => {
    for (const bad of ["mysql://u:pw@h/db", "postgres://u:pw@h", "not a url"]) {
      try { pgArgs(bad); throw new Error("accepted"); } catch (e) {
        expect(e).toBeInstanceOf(RecoveryToolError);
        expect((e as Error).message).not.toContain("pw@");
      }
    }
  });

  it("scrubs connection strings and passwords from tool output", () => {
    const out = scrub('connection to postgres://u:hunter2@h:5432/db failed\npassword authentication failed for user "u"');
    expect(out).not.toContain("hunter2");
    expect(out).toContain("postgres://[redacted]");
  });

  it("reports a missing tool as unavailable and a failing tool with a scrubbed tail", async () => {
    const missing: CommandRunner = async () => ({ code: 127, stdout: "", stderr: "" });
    await expect(mustRun(missing, "pg_dump", "/x/pg_dump", [])).rejects.toMatchObject({ code: "tool_unavailable" });
    const failing: CommandRunner = async () => ({ code: 1, stdout: "", stderr: "could not connect to postgres://u:pw@h/db" });
    const error = await mustRun(failing, "pg_dump", "pg_dump", []).catch((e: Error) => e);
    expect(error).toMatchObject({ code: "tool_failed" });
    expect((error as Error).message).not.toContain("pw@");
  });

  it("only accepts absolute tool overrides", () => {
    expect(() => toolsFromEnv({ ZENITH_PG_DUMP_BIN: "pg_dump" })).toThrow(/absolute/);
    expect(toolsFromEnv({}).pgRestore).toBe("pg_restore");
  });
});

describe("RPO / RTO measurement", () => {
  const times = { backupSnapshotAt: "2026-10-07T10:00:00.000Z", backupFinishedAt: "2026-10-07T10:00:09.000Z", restoreStartedAt: "2026-10-07T12:00:00.000Z", restoreFinishedAt: "2026-10-07T12:07:30.000Z" };

  it("measures the loss window and recovery time from recorded instants", () => {
    const m = measureRecovery({ ...times, applicationHealthyAt: "2026-10-07T12:09:00.000Z", incidentAt: "2026-10-07T11:30:00.000Z" });
    expect(m).toMatchObject({ rpoSeconds: 5400, rtoSeconds: 2340, restoreDurationSeconds: 450, backupAgeAtRestoreStartSeconds: 7200, verdict: "no_targets" });
  });

  it("without a loss time it gives the honest upper bound and says so", () => {
    const m = measureRecovery(times);
    expect(m.rpoSeconds).toBeNull();
    expect(m.rtoSeconds).toBeNull();
    expect(m.backupAgeAtRestoreStartSeconds).toBe(7200);
    expect(m.caveats.join(" ")).toMatch(/upper bound/);
  });

  it("never uses database duration to claim an RTO target with an unknown incident time", () => {
    const m = measureRecovery({ ...times, applicationHealthyAt: "2026-10-07T13:00:00.000Z", targets: targetsFromEnv({ ZENITH_RPO_TARGET_SECONDS: "86400", ZENITH_RTO_TARGET_SECONDS: "900" }) });
    expect(m.rtoSeconds).toBeNull();
    expect(m.verdict).toBe("incomplete_measurement");
  });

  it("with unapproved definitions and no environment value there are no targets", () => {
    const unapproved = { ...sloDefinitions(), approval: { status: "not_approved" as const, pendingDecision: "DEC-BUSINESS" as const, note: "custom" } };
    expect(targetsFromEnv({}, unapproved)).toEqual({ rpoSeconds: null, rtoSeconds: null, status: "unset" });
    expect(measureRecovery({ ...times, targets: targetsFromEnv({}, unapproved) }).verdict).toBe("no_targets");
    expect(targetsFromEnv({ ZENITH_RTO_TARGET_SECONDS: "900" }, unapproved)).toEqual({ rpoSeconds: null, rtoSeconds: 900, status: "provisional" });
  });

  it("with approved definitions the targets default to the SLO RPO and RTO, and the environment still wins", () => {
    expect(targetsFromEnv({})).toEqual({ rpoSeconds: 900, rtoSeconds: 14_400, status: "target" });
    expect(targetsFromEnv({ ZENITH_RPO_TARGET_SECONDS: "  " })).toEqual({ rpoSeconds: 900, rtoSeconds: 14_400, status: "target" });
    expect(targetsFromEnv({ ZENITH_RTO_TARGET_SECONDS: "600" })).toEqual({ rpoSeconds: 900, rtoSeconds: 600, status: "provisional" });
    const both = targetsFromEnv({ ZENITH_RPO_TARGET_SECONDS: "60", ZENITH_RTO_TARGET_SECONDS: "120" });
    expect(both).toEqual({ rpoSeconds: 60, rtoSeconds: 120, status: "provisional" });
    // the restore verdict and the SLO objectives agree: 1 h of backup age breaches the 15 minute RPO with no environment at all
    const m = measureRecovery({ ...times, incidentAt: "2026-10-07T11:30:00.000Z", targets: targetsFromEnv({}) });
    expect(m.targets).toMatchObject({ rpoSeconds: 900, rtoSeconds: 14_400 });
    expect(m.verdict).toBe("exceeds_targets");
  });

  it("compares against operator-supplied targets when they are configured", () => {
    const targets = targetsFromEnv({ ZENITH_RPO_TARGET_SECONDS: "3600", ZENITH_RTO_TARGET_SECONDS: "900" });
    expect(targets.status).toBe("provisional");
    expect(measureRecovery({ ...times, incidentAt: "2026-10-07T11:30:00.000Z", targets }).verdict).toBe("exceeds_targets");
    expect(measureRecovery({ ...times, incidentAt: "2026-10-07T10:20:00.000Z", restoreStartedAt: "2026-10-07T10:21:00.000Z", restoreFinishedAt: "2026-10-07T10:25:00.000Z", applicationHealthyAt: "2026-10-07T10:26:00.000Z", targets }).verdict).toBe("within_targets");
  });

  it("delivers to the file and to a registered sink, and a failing sink does not hide the report", async () => {
    const received: unknown[] = [];
    const off = [
      registerRecoveryMeasurementSink({ name: "ops01-hook", record: async (r) => { received.push(r); } }),
      registerRecoveryMeasurementSink({ name: "broken-hook", record: async () => { throw new Error("down"); } }),
    ];
    try {
      const file = path.join(dir, "nested", "report.json");
      const result = await deliverReport({ ok: true }, file);
      expect(result.delivered).toContain("ops01-hook");
      expect(result.failed).toEqual(["broken-hook"]);
      expect(JSON.parse(await readFile(file, "utf8"))).toEqual({ ok: true });
      expect(received).toEqual([{ ok: true }]);
    } finally { for (const f of off) f(); }
    await mkdir(dir, { recursive: true });
  });
});

describe("Temporal CLI connection for authenticated engines", () => {
  it("passes the worker's mTLS files and server name to every Temporal CLI call", async () => {
    const { temporalConnectionArgs, temporalTlsFromEnv } = await import("@/lib/ops/recovery/process");
    expect(temporalTlsFromEnv({})).toBeUndefined();
    const tls = temporalTlsFromEnv({ ZENITH_TEMPORAL_TLS: "true", ZENITH_TEMPORAL_TLS_CA_FILE: "/run/t/ca.crt", ZENITH_TEMPORAL_TLS_CERT_FILE: "/run/t/client.crt",
      ZENITH_TEMPORAL_TLS_KEY_FILE: "/run/t/client.key", ZENITH_TEMPORAL_TLS_SERVER_NAME: "temporal" });
    expect(temporalConnectionArgs("127.0.0.1:27233", tls)).toEqual(["--address", "127.0.0.1:27233", "--tls", "--tls-ca-path", "/run/t/ca.crt",
      "--tls-cert-path", "/run/t/client.crt", "--tls-key-path", "/run/t/client.key", "--tls-server-name", "temporal"]);
    expect(temporalConnectionArgs("temporal:7233")).toEqual(["--address", "temporal:7233"]);
    expect(() => temporalTlsFromEnv({ ZENITH_TEMPORAL_TLS: "true", ZENITH_TEMPORAL_TLS_CERT_FILE: "relative.crt", ZENITH_TEMPORAL_TLS_KEY_FILE: "/k" })).toThrow("absolute");
    expect(() => temporalTlsFromEnv({ ZENITH_TEMPORAL_TLS: "true", ZENITH_TEMPORAL_TLS_CERT_FILE: "/c" })).toThrow("together");
  });
});
