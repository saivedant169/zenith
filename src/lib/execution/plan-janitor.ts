/**
 * Legacy plan directory inspection retains every file. Historical producers do
 * not share the maintenance fence, so unlink cannot safely exclude a producer.
 * Production maintenance marks encrypted database artifacts logically expired;
 * physical retention and pruning require a separate operator policy.
 */
import { lstat, opendir, realpath } from "node:fs/promises";
import type { Dir } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { sha256Hex } from "@/lib/controlplane/digest";
import { repos } from "@/lib/controlplane/db";
import { textArray } from "@/lib/controlplane/db/sql";
import { LeaseUnavailableError, withLease } from "@/lib/controlplane/leases";
import { TERMINAL_OPERATION_STATUSES, type Sql } from "@/lib/controlplane/types";
import type { PlanArtifactRetentionPreviewInput, PlanArtifactRetentionPreview } from "@/lib/controlplane/db/repos/plan-artifacts";

export const PLAN_MAX_AGE_MS = 24 * 3600_000;
export const PLAN_JANITOR_INTERVAL_MS = 5 * 60_000;
const PLAN_NAME = /^([0-9a-f]{64})\.tfplan$/;

export interface PlanJanitorOptions {
  planDir: string;
  maxAgeMs?: number;
  /** Bounds directory entries visited, including entries that cannot be deleted. */
  limit?: number;
  clock?: () => number;
}
export interface PlanJanitorResult {
  status: "ran" | "busy" | "missing";
  scanned: number;
  removed: number;
  retained: number;
  errors: number;
}

export function planMaxAgeFromEnv(env: Readonly<Record<string, string | undefined>> = process.env): number {
  const hours = Number(env.ZENITH_WORKER_PLAN_MAX_AGE_HOURS?.trim() || "24");
  if (!Number.isFinite(hours) || hours < 1 || hours > 8760)
    throw new Error("ZENITH_WORKER_PLAN_MAX_AGE_HOURS must be from 1 to 8760.");
  return hours * 3600_000;
}

/** Opt-in copy-review preview. No default retention duration, deletion mode, arbitrary fields or credential output. */
export function planArtifactRetentionPreviewFromEnv(
  env: Readonly<Record<string, string | undefined>> = process.env,
): PlanArtifactRetentionPreviewInput | undefined {
  const raw = env.ZENITH_WORKER_PLAN_RETENTION_PREVIEW;
  if (raw === undefined) return undefined;
  const refuse = (): never => { throw new Error("ZENITH_WORKER_PLAN_RETENTION_PREVIEW requires explicit bounded dry-run configuration."); };
  try {
    if (!raw || Buffer.byteLength(raw) > 131_072) return refuse();
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== "object" || Array.isArray(value)) return refuse();
    const fields = Object.keys(value).sort();
    if (JSON.stringify(fields) !== JSON.stringify(["createdBefore", "holdOperationIds", "limit", "workspaceId"])) return refuse();
    const own = (key: string): unknown => Object.getOwnPropertyDescriptor(value, key)?.value;
    const workspaceId = own("workspaceId"), createdBefore = own("createdBefore"), limit = own("limit"), rawHolds = own("holdOperationIds");
    const isId = (id: unknown): id is string => typeof id === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(id);
    if (!isId(workspaceId) || typeof createdBefore !== "string"
      || !/^(?!0000)\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(createdBefore)
      || !Number.isFinite(Date.parse(createdBefore)) || new Date(createdBefore).toISOString() !== createdBefore
      || typeof limit !== "number" || !Number.isInteger(limit) || limit < 1 || limit > 1000
      || !Array.isArray(rawHolds) || rawHolds.length > 1000 || !rawHolds.every(isId)
      || new Set(rawHolds).size !== rawHolds.length) return refuse();
    return Object.freeze({ workspaceId, createdBefore, limit, holdOperationIds: Object.freeze([...rawHolds]) });
  } catch { return refuse(); }
}

/** System ownership lookup: tenant ids are discovered, and joins include workspace_id. */
async function terminalOwners(db: Sql, digest: string): Promise<boolean> {
  const rows = await db.query<{ safe: boolean }>(
    `with owners as (
       select workspace_id, id as operation_id from platform.operations where plan_digest = $1
       union
       select workspace_id, operation_id from platform.evidence where kind = 'tofu_plan' and digest = $1
     )
     select exists (select 1 from owners) and not exists (
       select 1 from owners r left join platform.operations o
         on o.workspace_id = r.workspace_id and o.id = r.operation_id
       where o.id is null or not (o.status = any($2::text[]))
     ) as safe`,
    [digest, textArray(TERMINAL_OPERATION_STATUSES)],
  );
  return rows[0]?.safe === true;
}

const missing = (err: unknown): boolean => (err as NodeJS.ErrnoException | undefined)?.code === "ENOENT";

export async function planJanitorPass(db: Sql, options: PlanJanitorOptions): Promise<PlanJanitorResult> {
  return runPlanJanitorPass(db, options);
}

/** A worker keeps one directory cursor so retained entries cannot starve later plans. */
interface ScanCursor { directory?: Dir; root?: string; ino?: number; dev?: number }
async function closeCursor(cursor: ScanCursor): Promise<void> {
  const directory = cursor.directory;
  cursor.directory = undefined;
  await directory?.close();
}

async function runPlanJanitorPass(db: Sql, options: PlanJanitorOptions, cursor?: ScanCursor): Promise<PlanJanitorResult> {
  const age = options.maxAgeMs ?? PLAN_MAX_AGE_MS;
  const limit = options.limit ?? 100;
  if (!options.planDir.trim() || !Number.isFinite(age) || age < 3600_000 || age > 8760 * 3600_000
    || !Number.isInteger(limit) || limit < 1 || limit > 1000)
    throw new Error("Plan janitor requires a directory, retention from 1 hour to 1 year, and limit from 1 to 1000.");
  const result: PlanJanitorResult = { status: "ran", scanned: 0, removed: 0, retained: 0, errors: 0 };
  const configured = path.resolve(options.planDir);
  let root: string;
  try {
    const stat = await lstat(configured);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Plan directory must be a regular directory.");
    root = await realpath(configured);
    if (cursor && (cursor.root !== root || cursor.ino !== stat.ino || cursor.dev !== stat.dev)) {
      await closeCursor(cursor);
      Object.assign(cursor, { root, ino: stat.ino, dev: stat.dev });
    }
  } catch (err) {
    if (cursor) await closeCursor(cursor);
    if (missing(err)) return { ...result, status: "missing" };
    throw new Error("Plan directory is unavailable or unsafe.");
  }
  const cutoff = (options.clock ?? Date.now)() - age;
  if (!Number.isFinite(cutoff)) throw new Error("Plan janitor clock must be finite.");
  try {
    return await withLease(db, { scope: `system:plan-janitor:${sha256Hex(root)}`, holder: `janitor:${randomUUID()}`, ttlMs: 30_000 }, async (lease, signal) => {
      const directory = cursor?.directory ?? await opendir(root);
      if (cursor) cursor.directory = directory;
      let keepCursor = false;
      try {
        while (result.scanned < limit) {
          signal.throwIfAborted();
          const entry = await directory.read();
          if (!entry) break;
          result.scanned++;
          const match = PLAN_NAME.exec(entry.name);
          if (!match || !entry.isFile() || entry.isSymbolicLink()) { result.retained++; continue; }
          const file = path.join(root, entry.name);
          try {
            const before = await lstat(file);
            if (!before.isFile() || before.isSymbolicLink() || before.mtimeMs > cutoff
              || !(await terminalOwners(db, match[1]))) { result.retained++; continue; }
            // Refuse a replaced directory, refreshed file, or newly active owner.
            if (await realpath(configured) !== root || (await lstat(configured)).isSymbolicLink()) { result.errors++; break; }
            if (!(await terminalOwners(db, match[1]))) { result.retained++; continue; }
            await repos.leases.assertFence(db, lease.scope, lease.fenceToken);
            signal.throwIfAborted();
            const after = await lstat(file);
            if (!after.isFile() || after.isSymbolicLink() || after.ino !== before.ino || after.dev !== before.dev
              || after.mtimeMs !== before.mtimeMs || after.size !== before.size) { result.retained++; continue; }
            signal.throwIfAborted();
            // Legacy producers cannot be fenced against unlink. Retain bytes until separately authorized migration/pruning.
            result.retained++;
          } catch {
            // A failed ownership read or filesystem operation never authorizes deletion.
            signal.throwIfAborted();
            result.errors++;
          }
        }
        keepCursor = cursor !== undefined && result.scanned === limit;
      } finally {
        if (!keepCursor) {
          if (cursor) await closeCursor(cursor);
          else await directory.close();
        }
      }
      return result;
    });
  } catch (err) {
    if (err instanceof LeaseUnavailableError) return { ...result, status: "busy" };
    throw new Error("Plan maintenance could not complete; check the plan directory and control store.");
  }
}

/** Immediate then periodic non-deleting legacy inspection, single-flight, with awaited shutdown. */
export function startPlanJanitor(db: Sql, options: PlanJanitorOptions, report: (result?: PlanJanitorResult) => void): { stop(): Promise<void> } {
  let active: Promise<void> | undefined;
  const cursor: ScanCursor = {};
  const reportSafely = (result?: PlanJanitorResult): void => { try { report(result); } catch { /* logging cannot crash the maintenance timer */ } };
  const tick = (): void => {
    if (active) return;
    active = runPlanJanitorPass(db, options, cursor).then(reportSafely, () => reportSafely()).finally(() => { active = undefined; });
  };
  tick();
  const timer = setInterval(tick, PLAN_JANITOR_INTERVAL_MS);
  timer.unref();
  return { async stop() { clearInterval(timer); await active; await closeCursor(cursor); } };
}

export interface PlanArtifactJanitorResult { expired: number; retention?: PlanArtifactRetentionPreview }
/** Durable expiry is unchanged. Optional copy-review counts never remove content or retain execution authority. */
export function startPlanArtifactJanitor(
  db: Sql,
  report: (result?: PlanArtifactJanitorResult) => void,
  options: { retentionPreview?: PlanArtifactRetentionPreviewInput } = {},
): { stop(): Promise<void> } {
  let active: Promise<void> | undefined;
  const preview = options.retentionPreview;
  const tick = () => {
    if (active) return;
    active = (async (): Promise<PlanArtifactJanitorResult> => {
      const expired = await repos.planArtifacts.expire(db);
      await repos.planArtifacts.releaseDrainedHolds(db);
      if (!preview) return { expired };
      const retention = await repos.planArtifacts.previewRetention(db, preview);
      return { expired, retention };
    })().then(result => { try { report(result); } catch {} }, () => { try { report(); } catch {} })
      .finally(() => { active=undefined; });
  };
  tick();
  const timer=setInterval(tick,PLAN_JANITOR_INTERVAL_MS); timer.unref();
  return { async stop() { clearInterval(timer); await active; } };
}
