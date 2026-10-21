/** DRV-3: actual snapshot, post-snapshot approval consumption and fresh recovery. */
import { cpSync, existsSync, lstatSync, realpathSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { openPlatformDb } from "@/lib/controlplane/db";
import { KeyRing } from "@/lib/keycustody/registry";
import { captureBackup } from "@/lib/ops/recovery/backup";
import { verifyBackupDirectory, type BackupManifest } from "@/lib/ops/recovery/manifest";
import { runRestore, type RestoreOptions, type RestoreReport } from "@/lib/ops/recovery/restore";
import { RECOVERY_REPORT_FORMAT } from "@/lib/ops/recovery/report";
import { execRunner, pgArgs, temporalTlsFromEnv, toolsFromEnv } from "@/lib/ops/recovery/process";
import { compose } from "../../acceptance/default-stack/runtime.mjs";
import { browserRequest, ensure, kindReadback, ok } from "../../../tests/e2e/default/support.mjs";
import { restoreDatabaseName } from "./contracts";
import { operatedRun, driverCli, type DriverInput } from "./operated";

const RESTORE_CLI_OUTPUT_LIMIT = 64 * 1024;
interface RestoreCliResult { exitCode: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string; overflow: boolean; timedOut: boolean; launchFailed: boolean; streamFailed: boolean }
/** Capture complete bounded streams and resolve only after the direct child emits `close`. */
function runRestoreCli(argv: readonly string[], env: NodeJS.ProcessEnv): Promise<RestoreCliResult> {
  const child = spawn(argv[0]!, argv.slice(1), {
    cwd: process.cwd(), env, stdio: ["ignore", "pipe", "pipe"], shell: false, windowsHide: true, detached: false,
  });
  return new Promise(resolve => {
    const stdout: Buffer[] = [], stderr: Buffer[] = [];
    let stdoutBytes = 0, stderrBytes = 0;
    let overflow = false, timedOut = false, launchFailed = false, streamFailed = false;
    let terminationStarted = false;
    let forceTimer: NodeJS.Timeout | undefined;
    const terminate = () => {
      if (terminationStarted) return;
      terminationStarted = true;
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
      forceTimer = setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      }, 5_000);
    };
    const timeout = setTimeout(() => { timedOut = true; terminate(); }, 1_080_000);
    const capture = (chunks: Buffer[], chunk: Buffer, stream: "stdout" | "stderr") => {
      const current = stream === "stdout" ? stdoutBytes : stderrBytes;
      if (current + chunk.length > RESTORE_CLI_OUTPUT_LIMIT) { overflow = true; terminate(); return; }
      chunks.push(Buffer.from(chunk));
      if (stream === "stdout") stdoutBytes += chunk.length; else stderrBytes += chunk.length;
    };
    child.stdout.on("data", (chunk: Buffer) => capture(stdout, chunk, "stdout"));
    child.stderr.on("data", (chunk: Buffer) => capture(stderr, chunk, "stderr"));
    child.stdout.on("error", () => { streamFailed = true; terminate(); });
    child.stderr.on("error", () => { streamFailed = true; terminate(); });
    child.once("error", () => { launchFailed = true; });
    child.once("close", (exitCode, signal) => {
      clearTimeout(timeout);
      if (forceTimer) clearTimeout(forceTimer);
      resolve({ exitCode, signal, stdout: Buffer.concat(stdout).toString("utf8"), stderr: Buffer.concat(stderr).toString("utf8"), overflow, timedOut, launchFailed, streamFailed });
    });
  });
}

export function requireRefusal(report: Pick<RestoreReport, "ok" | "steps">, step: string): void {
  if (report.ok || !report.steps.some(s => s.id === step && s.status === "refused")
    || report.steps.some(s => s.id === "restore" && s.status === "ok")) throw new Error("operated:expected-prewrite-refusal");
}
if (process.argv[1] && /[/\\]drivers[/\\]restore\.(?:ts|js)$/.test(process.argv[1])) void driverCli("restore", runRestoreScenario).then(code => { process.exitCode = code; });
/** Bound private dump cleanup; reject symlinks anywhere before recursive removal. */
export function removePrivateTree(root: string, directory: string): void {
  const relative = path.relative(root, directory);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative) || lstatSync(root).isSymbolicLink()) throw new Error("operated:cleanup-path");
  if (!existsSync(directory)) return;
  const resolved = path.relative(realpathSync(root), realpathSync(directory));
  if (!resolved || resolved.startsWith("..") || path.isAbsolute(resolved)) throw new Error("operated:cleanup-real-path");
  const inspect = (file: string): void => {
    const stat = lstatSync(file); if (stat.isSymbolicLink()) throw new Error("operated:cleanup-symlink");
    if (stat.isDirectory()) for (const name of readdirSync(file)) inspect(path.join(file, name));
  };
  inspect(directory); rmSync(directory, { recursive: true });
}
export async function runRestoreScenario(input: DriverInput): Promise<number> {
  ensure(input.scenarioId === "restore", "scenario-binding");
  return operatedRun(input, async session => {
    const root = input.env.ZENITH_LOCAL_ROOT!;
    const backup = path.join(root, "restore-backup"), damaged = path.join(root, "restore-damaged");
    ensure(!existsSync(backup) && !existsSync(damaged), "fresh-backup-path");
    session.finalizers.unshift(async () => { removePrivateTree(root, damaged); removePrivateTree(root, backup); });
    const tools = toolsFromEnv(session.environment), connection = pgArgs(session.environment.ZENITH_PLATFORM_DB_URL!);
    const server = Number((await session.db.query<{ version: string }>("select current_setting('server_version_num') as version"))[0].version);
    for (const tool of [tools.pgDump, tools.pgRestore]) {
      const result = await execRunner(tool, ["--version"]);
      ensure(result.code === 0 && Number(result.stdout.match(/(\d+)\./)?.[1]) === Math.floor(server / 10000), "matching-pg-client-major");
    }
    const namespace = session.prepared.environment.ZENITH_TEMPORAL_NAMESPACE;
    const tls = temporalTlsFromEnv(session.environment);
    const temporal = { address: session.environment.ZENITH_TEMPORAL_ADDRESS, ...(tls ? { tls } : {}), namespace, required: true };
    const keys = KeyRing.fromEnv(session.prepared.environment).descriptors().map(({ purpose, keyId, role }) => ({ purpose, keyId, role }));
    ensure(keys.length > 0, "real-key-custody");
    let operationId = "", manifest!: BackupManifest, report!: RestoreReport;
    await session.step("browser-approved-snapshot", async () => {
      await session.completeDeploy((await session.deployReview()).operationId);
      operationId = await session.proposeScale(2); await session.approve(operationId);
      ensure((await session.detail(operationId)).operation.status === "approved", "approved-before-snapshot");
    });
    await session.step("backup-verified", async () => {
      manifest = await captureBackup({ db: session.db, run: execRunner, tools }, {
        outDir: backup, platformUrl: session.environment.ZENITH_PLATFORM_DB_URL!, product: { kind: "postgres" },
        hosted: { kind: "postgres" }, keys, temporal,
      });
      ensure(manifest.components.every(c => c.status !== "skipped") && (await verifyBackupDirectory(backup)).ok, "complete-backup");
    });
    await session.step("post-snapshot-consumption", async () => {
      await session.scaleComplete(operationId, 2);
      const rows = await session.db.query<{ n: number }>("select count(*)::int as n from platform.approvals where workspace_id=$1 and operation_id=$2 and consumed_at is not null", [session.workspaceId, operationId]);
      ensure(rows[0].n > 0, "post-snapshot-consumed-approval");
    });
    await compose(session.activeState, ["stop", "execution-worker", "api"]);
    const name = restoreDatabaseName(input.runId), owner = `DRV3:${session.state.installationId}:${input.runId}:${randomBytes(8).toString("hex")}`;
    ensure((await session.db.query("select datname from pg_database where datname=$1", [name])).length === 0, "target-absent");
    // Register immediately after CREATE succeeds, before any following write.
    await session.db.query(`create database "${name}" template template0`);
    session.finalizers.unshift(async () => {
      await compose(session.activeState, ["stop", "api", "execution-worker"]);
      const rows = await session.db.query<{ comment: string }>("select shobj_description(oid,'pg_database') as comment from pg_database where datname=$1", [name]);
      ensure(rows.length === 1 && rows[0].comment === owner, "cleanup-database-owner");
      await session.db.query(`drop database "${name}" with (force)`);
      ensure((await session.db.query("select datname from pg_database where datname=$1", [name])).length === 0, "restored-database-absence");
    });
    // Comment is trusted only after this invocation proved absence and created it.
    await session.db.query(`comment on database "${name}" is '${owner}'`);
    const target = new URL(session.environment.ZENITH_PLATFORM_DB_URL!); target.pathname = `/${name}`;
    const options: RestoreOptions = { backupDir: backup, targetUrl: target.href, runId: `j15-restore-${input.runId}`, actor: "operator:local-rehearsal",
      reason: "Owned local operated restore", reportFile: path.join(root, "restore-private-report.json"), confirmCustomerState: true,
      keysAvailable: keys, observedEpoch: manifest.platform.recoveryEpoch,
      temporal: { address: temporal.address, ...(tls ? { tls } : {}), namespace, terminate: true } };
    const deps = { run: execRunner, tools, env: session.environment,
      openTarget: (url: string, options: { migrate: boolean }) => openPlatformDb({ kind: "postgres" as const, url, max: 2, migrate: options.migrate }) };
    session.privateFiles.push(options.reportFile);
    await session.step("damaged-backup-refused", async () => {
      cpSync(backup, damaged, { recursive: true });
      const dump = path.join(damaged, "database.dump"); writeFileSync(dump, Buffer.concat([readFileSync(dump), randomBytes(1)]), { mode: 0o600 });
      requireRefusal(await runRestore(deps, { ...options, backupDir: damaged }), "verify");
    });
    await session.step("missing-keys-refused", async () => { requireRefusal(await runRestore(deps, { ...options, keysAvailable: [] }), "keys"); });
    await session.step("nonempty-target-refused", async () => {
      requireRefusal(await runRestore(deps, { ...options, targetUrl: session.environment.ZENITH_PLATFORM_DB_URL! }), "empty");
      const rows = await session.db.query<{ n: number }>("select count(*)::int as n from platform.operations where workspace_id=$1 and id=$2 and status='succeeded'", [session.workspaceId, operationId]);
      ensure(rows[0].n === 1, "source-not-overwritten");
    });
    await session.step("operator-cli-route", async () => {
      // Recovery's product/public snapshot references real Auth users and extensions.
      // Copy those prerequisites to the same fresh DB, not a second modeled identity.
      const authDump = path.join(root, "restore-auth.dump"); session.privateFiles.push(authDump);
      const dumped = await execRunner(tools.pgDump, [...connection.args, "--format=custom", "--no-owner", "--schema=auth", "--schema=extensions", "--file", authDump], { env: connection.env });
      ensure(dumped.code === 0, "auth-prerequisite-backup");
      const targetConnection = pgArgs(target.href);
      const fresh = await openPlatformDb({ kind: "postgres", url: target.href, max: 2, migrate: false });
      try { await fresh.query("drop schema public"); } finally { await fresh.close(); }
      const auth = await execRunner(tools.pgRestore, [...targetConnection.args, "--no-owner", "--exit-on-error", "--single-transaction", authDump], { env: targetConnection.env });
      ensure(auth.code === 0, "auth-prerequisites-restored");
      const targetUrlEnv = "ZENITH_OPERATED_RESTORE_TARGET_URL";
      const argv = ["restore", "--backup", backup, "--target-url-env", targetUrlEnv,
        "--run-id", options.runId, "--actor", options.actor, "--reason", options.reason,
        "--report", options.reportFile, "--confirm-customer-state",
        "--observed-epoch", String(options.observedEpoch), "--temporal-namespace", namespace,
        "--temporal-address", temporal.address!, "--terminate-temporal"];
      const sourceUrl = session.environment.ZENITH_PLATFORM_DB_URL!;
      const privateValues = Object.entries(session.environment)
        .filter(([key, value]) => value !== undefined && value !== "" && /(PASSWORD|TOKEN|SECRET|CREDENTIAL|KEY|JWK|SUPABASE.*DB_URL|ZENITH_PLATFORM_DB_URL|DATABASE_URL|POSTGRES.*URL)/i.test(key))
        .map(([, value]) => value!);
      ensure(argv[argv.indexOf("--target-url-env") + 1] === targetUrlEnv
        && !argv.some(arg => arg.includes(target.href) || arg.includes(sourceUrl) || privateValues.some(value => arg.includes(value))), "restore-cli-target-env-only");
      // No detached child/session: direct exit/signal are recorded only from `close`.
      // This is not descendant custody; the outer R17 acceptance must prove CLI descendants closed before cleanup.
      const result = await runRestoreCli(
        [process.execPath, "node_modules/tsx/dist/cli.mjs", "scripts/ops/recovery.ts", ...argv],
        { ...session.environment, [targetUrlEnv]: target.href },
      );
      ensure(result.exitCode === 0 && result.signal === null && !result.timedOut && !result.overflow
        && !result.launchFailed && !result.streamFailed, "restore-cli-closed-without-overflow");
      const transcript = `${result.stdout}\n${result.stderr}`;
      ensure(!transcript.includes(target.href) && !transcript.includes(sourceUrl)
        && privateValues.every(value => !transcript.includes(value)), "restore-cli-output-redaction");
      const parsedReport: unknown = JSON.parse(readFileSync(options.reportFile, "utf8"));
      ensure(parsedReport !== null && typeof parsedReport === "object" && !Array.isArray(parsedReport), "restore-cli-report-shape");
      const candidate = parsedReport as Partial<RestoreReport>;
      ensure(candidate.format === RECOVERY_REPORT_FORMAT && candidate.runId === options.runId
        && candidate.backupId === manifest.backupId && candidate.manifestDigest === manifest.digest, "restore-cli-report-binding");
      report = candidate as RestoreReport;
      const reportText = JSON.stringify(report);
      ensure(!reportText.includes(target.href) && !reportText.includes(sourceUrl)
        && privateValues.every(value => !reportText.includes(value)), "restore-cli-report-redaction");
    });
    await session.step("fresh-restore", async () => {
      ensure(report.ok && report.epoch! > manifest.platform.recoveryEpoch
        && ["verify", "keys", "empty", "restore", "facts", "epoch", "temporal"].every(id => report.steps.some(s => s.id === id && s.status === "ok")), "actual-fresh-restore");
    });
    const restored = await openPlatformDb({ kind: "postgres", url: target.href, max: 2, migrate: false });
    session.finalizers.unshift(() => restored.close());
    await session.step("epoch-and-ledger-readback", async () => {
      const rows = await restored.query<{ epoch: number; current: number; status: string; consumed: boolean }>(
        "select o.recovery_epoch as epoch, platform.current_recovery_epoch() as current, o.status, exists(select 1 from platform.approvals a where a.operation_id=o.id and a.workspace_id=o.workspace_id and a.consumed_at is not null) as consumed from platform.operations o where o.workspace_id=$1 and o.id=$2", [session.workspaceId, operationId]);
      ensure(rows.length === 1 && rows[0].status === "approved" && !rows[0].consumed && rows[0].epoch < rows[0].current && rows[0].current === report.epoch, "snapshot-epoch-fence");
    });
    const recoveryState = await session.replacement(undefined, name);
    await compose(recoveryState, ["up", "-d", "--no-deps", "api"]); await session.healthy(recoveryState, "api");
    await session.step("old-approval-refused", async () => {
      const denied = await session.execute(operationId, true);
      ensure(/recovery_epoch_stale|recovery.epoch|recovery epoch/i.test(JSON.stringify(denied)), "old-approval-denial-reason");
      await kindReadback(session.config, 2, session.marker);
      const row = await restored.query<{ status: string }>("select status from platform.operations where workspace_id=$1 and id=$2", [session.workspaceId, operationId]);
      ensure(row[0].status !== "succeeded" && row[0].status !== "running", "no-resurrected-execution");
    });
    await session.step("browser-continuation", async () => {
      const recovery = ok(await browserRequest(session.b, "/api/platform/v1/recovery?state=pending", undefined, "GET", session.workspaceId));
      ensure(recovery.status.epoch === report.epoch, "api-is-restored-database");
      const items = recovery.items;
      const item = items.find((value: { kind: string; ref: string }) => value.kind === "operation" && value.ref === operationId);
      ensure(item && item.allowed.includes("resume") && /^[a-f0-9]{64}$/.test(item.bindingDigest), "real-recovery-item");
      const wrong = (item.bindingDigest[0] === "0" ? "1" : "0") + item.bindingDigest.slice(1);
      const stale = await browserRequest(session.b, `/api/platform/v1/recovery/items/${item.id}/decide`,
        { decision: "resume", bindingDigest: wrong, reason: "Local stale-binding refusal" }, "POST", session.workspaceId);
      ensure(stale.status === 409, "stale-continuation-refused");
      // This administrative recovery operation has a browser API, no UI form.
      // Use a real authenticated same-origin AAL2 page, never a bearer or SQL decision.
      const decided = ok(await browserRequest(session.b, `/api/platform/v1/recovery/items/${item.id}/decide`,
        { decision: "resume", bindingDigest: item.bindingDigest, reason: "Reviewed local provider state independently" }, "POST", session.workspaceId));
      ensure(decided.item.state === "resumed" && (await session.detail(operationId)).operation.status === "awaiting_approval", "fresh-review-required");
    });
    await compose(recoveryState, ["up", "-d", "--no-deps", "execution-worker"]); await session.healthy(recoveryState, "execution-worker");
    await session.step("fresh-approval-readback", async () => {
      await session.approve(operationId); await session.scaleComplete(operationId, 2);
      const fresh = await session.proposeScale(1); await session.approve(fresh); await session.scaleComplete(fresh, 1);
      const rows = await restored.query<{ n: number }>("select count(*)::int as n from platform.approvals where workspace_id=$1 and operation_id=$2 and consumed_at is not null and recovery_epoch=platform.current_recovery_epoch()", [session.workspaceId, operationId]);
      ensure(rows[0].n > 0, "current-epoch-approval-consumed");
    });
  });
}
