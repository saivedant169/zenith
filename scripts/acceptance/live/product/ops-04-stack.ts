/**
 * OPS-04 live: the runner's Zenith stack as a recovery target. Backup and restore are the product's own recovery library
 * (src/lib/ops/recovery), the same calls scripts/ops/recovery.ts makes. The loss removes every store the backup holds
 * (platform, agent, hosted and the product tables in public) from the stack's database and the restore writes them back
 * there: the product store is read through Supabase's REST service, which serves only that database, so a restore beside
 * it would leave the API reading the lost rows. Supabase's own schemas (auth, storage, extensions) stay.
 *
 * Nothing here prints a URL, key or secret; refusals name the step only.
 */
import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import type { EnvLike } from "../../config";
import { openPlatformDb } from "@/lib/controlplane/db";
import { KeyRing } from "@/lib/keycustody/registry";
import { captureBackup } from "@/lib/ops/recovery/backup";
import { verifyBackupDirectory } from "@/lib/ops/recovery/manifest";
import { runRestore, type RestoreReport } from "@/lib/ops/recovery/restore";
import { execRunner, temporalTlsFromEnv, toolsFromEnv } from "@/lib/ops/recovery/process";
import { compose, docker, readState } from "../../default-stack/runtime.mjs";
import { readPrepared } from "../../../deploy/installation.mjs";
import { refuse, Refusal, sanitizedError } from "./mix-03";

/** The recovery library's own failure, as a fixed refusal: its code and its scrubbed, elided message (never a URL or path). */
export async function named<T>(what: string, work: () => Promise<T>): Promise<T> {
  try { return await work(); }
  catch (error) {
    if (error instanceof Refusal) throw error;
    const code = (error as { code?: unknown } | null)?.code, name = error instanceof Error ? error.name : "Error";
    const kind = typeof code === "string" && /^[a-z_]{1,40}$/.test(code) ? code : /^[A-Za-z]{1,40}$/.test(name) ? name : "Error";
    refuse(`${what} failed (${kind}${error instanceof Error && sanitizedError(error.message) ? `: ${sanitizedError(error.message)}` : ""})`);
  }
}

export interface Ops04Readback { status: string; consumed: boolean; epoch: number; current: number }
export interface Ops04Stack {
  stop(services: ("api" | "execution-worker")[]): Promise<void>;
  /** Start a service and wait until healthy. */
  start(service: "api" | "execution-worker"): Promise<void>;
  backup(): Promise<{ snapshotAt: string; epoch: number }>;
  /** Lose the stores the backup holds, then restore the backup into the emptied database (API and worker stopped). */
  restore(incidentAt: string): Promise<RestoreReport>;
  readback(workspaceId: string, operationId: string): Promise<Ops04Readback>;
  close(): Promise<void>;
}

/**
 * The loss: every store the backup holds, as the restore's emptiness check counts them, and the product objects in public.
 * Objects an extension owns stay; the schema public and Supabase's grants on it stay, as on a fresh Supabase database.
 */
export const LOSE_STORES = `drop schema if exists platform cascade; drop schema if exists agent cascade; drop schema if exists hosted cascade;
do $$ declare r record; begin
  for r in select c.relname, c.relkind from pg_class c where c.relnamespace = 'public'::regnamespace and c.relkind in ('r','p','v','m','f','S')
      and not exists (select 1 from pg_depend d where d.classid = 'pg_class'::regclass and d.objid = c.oid and d.deptype = 'e') order by c.relkind = 'S' loop
    execute format('drop %s if exists public.%I cascade', case r.relkind when 'v' then 'view' when 'm' then 'materialized view' when 'f' then 'foreign table' when 'S' then 'sequence' else 'table' end, r.relname);
  end loop;
  for r in select p.oid::regprocedure::text as sig, p.prokind from pg_proc p where p.pronamespace = 'public'::regnamespace
      and not exists (select 1 from pg_depend d where d.classid = 'pg_proc'::regclass and d.objid = p.oid and d.deptype = 'e') loop
    execute format('drop %s if exists %s cascade', case r.prokind when 'a' then 'aggregate' when 'p' then 'procedure' else 'function' end, r.sig);
  end loop;
  for r in select t.typname, t.typtype from pg_type t where t.typnamespace = 'public'::regnamespace and t.typtype in ('e','d','r','c')
      and (t.typtype <> 'c' or (select c.relkind from pg_class c where c.oid = t.typrelid) = 'c')
      and not exists (select 1 from pg_depend d where d.classid = 'pg_type'::regclass and d.objid = t.oid and d.deptype = 'e') loop
    execute format('drop %s if exists public.%I cascade', case r.typtype when 'd' then 'domain' else 'type' end, r.typname);
  end loop;
end $$;`;

type State = ReturnType<typeof readState> & { directory: string; compositionSha256: string; applicationInstallationId: string };

export function runnerOps04Stack(env: EnvLike, runId: string): Ops04Stack {
  const directory = env.ZENITH_DEFAULT_STACK_DIRECTORY?.trim() || refuse("no stack directory");
  const platformUrl = env.ZENITH_PLATFORM_DB_URL?.trim() || refuse("no platform database");
  const root = path.join(env.RUNNER_TEMP?.trim() || refuse("no runner temp"), "zenith-ops04");
  const backupDir = path.join(root, "backup"), reportFile = path.join(root, "restore-report.json");
  const active = readState(directory) as State;
  const prepared = readPrepared(path.join(directory, "installation")) as { environment: Record<string, string> };
  let db: Awaited<ReturnType<typeof openPlatformDb>> | undefined, manifestEpoch = 0;
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
      if (item?.Config.Labels?.["io.zenith.installation"] === active.applicationInstallationId && item.State.Health?.Status === "healthy") return;
    }
    refuse(`the ${service} container was not healthy within 6 minutes`);
  };
  return {
    stop: (services) => named(`stopping ${services.join(" and ")}`, async () => { await compose(active, ["stop", ...services]); }),
    start: (service) => named(`starting ${service}`, async () => { await compose(active, ["up", "-d", "--no-deps", service]); await healthy(service); }),
    backup: () => named("the backup", async () => {
      if (existsSync(backupDir)) refuse("the backup directory already exists");
      mkdirSync(root, { recursive: true, mode: 0o700 });
      const manifest = await captureBackup({ db: await live(), run: execRunner, tools: toolsFromEnv(env) }, {
        outDir: backupDir, platformUrl, product: { kind: "postgres" }, hosted: { kind: "postgres" }, keys: keys(), temporal: { ...temporal(), required: true },
      });
      if (manifest.components.some(c => c.status === "skipped") || !(await verifyBackupDirectory(backupDir)).ok) refuse("the backup is incomplete or does not verify");
      manifestEpoch = manifest.platform.recoveryEpoch;
      return { snapshotAt: manifest.platform.snapshotAt, epoch: manifest.platform.recoveryEpoch };
    }),
    restore: (incidentAt) => named("the restore", async () => {
      await named("the database loss", async () => { await (await live()).exec(LOSE_STORES); });
      // Reopen after the loss so no pooled connection holds plans for the dropped objects.
      await db?.close(); db = undefined;
      return runRestore({ run: execRunner, tools: toolsFromEnv(env), env, openTarget: (url, o) => openPlatformDb({ kind: "postgres", url, max: 2, migrate: o.migrate }) }, {
        backupDir, targetUrl: platformUrl, runId: `ops04-${runId}`, actor: "operator:live-acceptance", reason: "PROD-OPS-04 live restore rehearsal",
        reportFile, confirmCustomerState: true, incidentAt, keysAvailable: keys(), observedEpoch: manifestEpoch,
        temporal: { ...temporal(), terminate: true },
      });
    }),
    readback: (workspaceId, operationId) => named("the restored readback", async () => {
      const rows = await (await live()).query<{ epoch: number; current: number; status: string; consumed: boolean }>(
        "select o.recovery_epoch as epoch, platform.current_recovery_epoch() as current, o.status, exists(select 1 from platform.approvals a where a.operation_id=o.id and a.workspace_id=o.workspace_id and a.consumed_at is not null) as consumed from platform.operations o where o.workspace_id=$1 and o.id=$2",
        [workspaceId, operationId]);
      if (rows.length !== 1) refuse("the restored database does not hold the operation");
      return { status: rows[0]!.status, consumed: rows[0]!.consumed, epoch: Number(rows[0]!.epoch), current: Number(rows[0]!.current) };
    }),
    async close() {
      await db?.close().catch(() => undefined);
    },
  };
}
