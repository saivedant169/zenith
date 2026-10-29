/**
 * OPS-04 live: the runner's Zenith stack as a recovery target. Backup and restore are the product's own recovery library
 * (src/lib/ops/recovery), the same calls scripts/ops/recovery.ts makes; the restored database lives beside the original
 * in the stack's PostgreSQL and the API and worker are recreated against it, as the J15 operated restore driver does.
 *
 * Nothing here prints a URL, key or secret; refusals name the step only.
 */
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { EnvLike } from "../../config";
import { openPlatformDb } from "@/lib/controlplane/db";
import type { PlatformDb } from "@/lib/controlplane/types";
import { KeyRing } from "@/lib/keycustody/registry";
import { captureBackup } from "@/lib/ops/recovery/backup";
import { verifyBackupDirectory } from "@/lib/ops/recovery/manifest";
import { runRestore, type RestoreReport } from "@/lib/ops/recovery/restore";
import { execRunner, temporalTlsFromEnv, toolsFromEnv } from "@/lib/ops/recovery/process";
import { compose, docker, readState } from "../../default-stack/runtime.mjs";
import { readPrepared } from "../../../deploy/installation.mjs";
import { refuse } from "./mix-03";

export interface Ops04Readback { status: string; consumed: boolean; epoch: number; current: number }
export interface Ops04Stack {
  stop(services: ("api" | "execution-worker")[]): Promise<void>;
  /** Start a service on the composition in use (original before the restore, replacement after) and wait until healthy. */
  start(service: "api" | "execution-worker"): Promise<void>;
  backup(): Promise<{ snapshotAt: string; epoch: number }>;
  /** Restore the backup into a new database; never into the live one. */
  restore(incidentAt: string): Promise<RestoreReport>;
  readback(workspaceId: string, operationId: string): Promise<Ops04Readback>;
  /** Point the API and worker at the restored database (they stay stopped until start). */
  switchToRestored(): Promise<void>;
  close(): Promise<void>;
}

type State = ReturnType<typeof readState> & { directory: string; compositionSha256: string; applicationInstallationId: string };

export function runnerOps04Stack(env: EnvLike, runId: string): Ops04Stack {
  const directory = env.ZENITH_DEFAULT_STACK_DIRECTORY?.trim() || refuse("no stack directory");
  const platformUrl = env.ZENITH_PLATFORM_DB_URL?.trim() || refuse("no platform database");
  const root = path.join(env.RUNNER_TEMP?.trim() || refuse("no runner temp"), "zenith-ops04");
  const backupDir = path.join(root, "backup"), reportFile = path.join(root, "restore-report.json");
  const database = `ops04_${runId.slice(-4)}_${randomBytes(4).toString("hex")}`;
  const original = readState(directory) as State;
  const prepared = readPrepared(path.join(directory, "installation")) as { environment: Record<string, string> };
  const composition = path.join(directory, "installation/stack.compose.json");
  const originalBytes = readFileSync(composition);
  let active: State = original, db: PlatformDb | undefined, restored: PlatformDb | undefined, manifestEpoch = 0;
  const target = () => { const url = new URL(platformUrl); url.pathname = `/${database}`; return url.href; };
  const keys = () => KeyRing.fromEnv(prepared.environment).descriptors().map(({ purpose, keyId, role }) => ({ purpose, keyId, role }));
  const temporal = () => {
    const tls = temporalTlsFromEnv(env);
    return { address: env.ZENITH_TEMPORAL_ADDRESS, ...(tls ? { tls } : {}), namespace: prepared.environment.ZENITH_TEMPORAL_NAMESPACE ?? refuse("no Temporal namespace") };
  };
  const live = async () => db ??= await openPlatformDb({ kind: "postgres", url: platformUrl, max: 2, migrate: false });
  const healthy = async (service: string) => {
    for (const deadline = Date.now() + 360_000; Date.now() < deadline; await new Promise(r => setTimeout(r, 5_000))) {
      const id = String(await compose(active, ["ps", "-q", service])).trim();
      if (!id) continue;
      const [item] = JSON.parse(String(await docker(["inspect", id]))) as { Config: { Labels?: Record<string, string> }; State: { Health?: { Status?: string } } }[];
      if (item?.Config.Labels?.["io.zenith.installation"] === original.applicationInstallationId && item.State.Health?.Status === "healthy") return;
    }
    refuse(`the ${service} container was not healthy within 6 minutes`);
  };
  return {
    async stop(services) { await compose(active, ["stop", ...services]); },
    async start(service) { await compose(active, ["up", "-d", "--no-deps", service]); await healthy(service); },
    async backup() {
      if (existsSync(backupDir)) refuse("the backup directory already exists");
      mkdirSync(root, { recursive: true, mode: 0o700 });
      const manifest = await captureBackup({ db: await live(), run: execRunner, tools: toolsFromEnv(env) }, {
        outDir: backupDir, platformUrl, product: { kind: "postgres" }, hosted: { kind: "postgres" }, keys: keys(), temporal: { ...temporal(), required: true },
      });
      if (manifest.components.some(c => c.status === "skipped") || !(await verifyBackupDirectory(backupDir)).ok) refuse("the backup is incomplete or does not verify");
      manifestEpoch = manifest.platform.recoveryEpoch;
      return { snapshotAt: manifest.platform.snapshotAt, epoch: manifest.platform.recoveryEpoch };
    },
    async restore(incidentAt) {
      const source = await live();
      if ((await source.query("select datname from pg_database where datname=$1", [database])).length) refuse("the restore database already exists");
      await source.query(`create database "${database}" template template0`);
      return runRestore({ run: execRunner, tools: toolsFromEnv(env), env, openTarget: (url, o) => openPlatformDb({ kind: "postgres", url, max: 2, migrate: o.migrate }) }, {
        backupDir, targetUrl: target(), runId: `ops04-${runId}`, actor: "operator:live-acceptance", reason: "PROD-OPS-04 live restore rehearsal",
        reportFile, confirmCustomerState: true, incidentAt, keysAvailable: keys(), observedEpoch: manifestEpoch,
        temporal: { ...temporal(), terminate: true },
      });
    },
    async readback(workspaceId, operationId) {
      restored ??= await openPlatformDb({ kind: "postgres", url: target(), max: 2, migrate: false });
      const rows = await restored.query<{ epoch: number; current: number; status: string; consumed: boolean }>(
        "select o.recovery_epoch as epoch, platform.current_recovery_epoch() as current, o.status, exists(select 1 from platform.approvals a where a.operation_id=o.id and a.workspace_id=o.workspace_id and a.consumed_at is not null) as consumed from platform.operations o where o.workspace_id=$1 and o.id=$2",
        [workspaceId, operationId]);
      if (rows.length !== 1) refuse("the restored database does not hold the operation");
      return { status: rows[0]!.status, consumed: rows[0]!.consumed, epoch: Number(rows[0]!.epoch), current: Number(rows[0]!.current) };
    },
    async switchToRestored() {
      if (createHash("sha256").update(readFileSync(composition)).digest("hex") !== original.compositionSha256) refuse("the stack composition drifted");
      const document = JSON.parse(readFileSync(composition, "utf8")) as { services: Record<string, { environment: Record<string, string> }> };
      for (const service of ["api", "execution-worker", "platform-migrate"]) {
        const pooled = new URL(prepared.environment.SUPABASE_DB_URL!); pooled.pathname = `/${database}`;
        const direct = new URL(prepared.environment.ZENITH_PLATFORM_MIGRATION_URL!); direct.pathname = `/${database}`;
        Object.assign(document.services[service]!.environment, { SUPABASE_DB_URL: pooled.href, ZENITH_PLATFORM_DB_URL: service === "platform-migrate" ? direct.href : pooled.href,
          ...(service === "platform-migrate" ? { ZENITH_PLATFORM_MIGRATION_URL: direct.href } : {}), ZENITH_PLATFORM_DB_MAX: "2" });
      }
      writeFileSync(composition, JSON.stringify(document), { mode: 0o600 });
      active = { ...original, compositionSha256: createHash("sha256").update(readFileSync(composition)).digest("hex") };
    },
    async close() {
      await restored?.close().catch(() => undefined);
      await db?.close().catch(() => undefined);
      // The workflow's stack teardown verifies the original composition bytes; put them back.
      if (active !== original) {
        await compose(active, ["stop", "api", "execution-worker"]).catch(() => undefined);
        writeFileSync(composition, originalBytes, { mode: 0o600 });
      }
    },
  };
}
