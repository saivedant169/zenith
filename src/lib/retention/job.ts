/**
 * The `data-retention` critical job (PROD-OPS-07): one bounded pass over the configured retention policy.
 *
 * DEC-RETENTION is approved (2026-10-13) and its baseline (logs 30 days) is the default policy, so wherever archive
 * storage and the sealing key are configured this ARCHIVES the two log classes by default. It ARCHIVES (copies to object storage, verified by readback; the source is untouched). It PRUNES
 * only when `retentionApplyGate` is open (ZENITH_RETENTION_APPLY=1 AND the policy carries a DEC-RETENTION approval),
 * and then only rows of a verified archive. Runs on the durable critical-maintenance schedule under the
 * `critical-job:data-retention` lease (the operator CLI scripts/data-retention.ts uses the same lease and record).
 * Counts only leave this module.
 */
import type { Sql } from "@/lib/controlplane/types";
import { RETENTION_CLASSES } from "./classes";
import { loadRetentionPolicy, resolveWindow, retentionApplyGate, widestScan, type PolicyLoad } from "./policy";
import { archiveBatch, archiveTargetFromEnv, pruneArchive, type ArchiveTarget } from "./archive";
import { archivesToPrune, classSql, deferArchive } from "./store";
import { resolveDestination, type DestinationResolution, type ResolveDeps } from "./destination";

export const RETENTION_WORKSPACES_PER_CLASS = 10;
export const RETENTION_BATCHES_PER_TICK = 5;
/** Pages of workspaces scanned per class per tick, so workspaces that are blocked (legal hold, unavailable destination) cannot starve the rest; bounded so a tick never loops unboundedly. */
export const RETENTION_WORKSPACE_PAGES_PER_CLASS = 5;

export interface RetentionOptions {
  env?: Readonly<Record<string, string | undefined>>;
  now?: Date;
  /** inject a loaded policy (tests); otherwise loaded from the environment */
  load?: PolicyLoad;
  /** the operator archive target (tests); otherwise from ZENITH_RETENTION_ARCHIVE_* */
  target?: ArchiveTarget;
  /** tenant destination seams (tests) */
  tenant?: Pick<ResolveDeps, "openTenant" | "secret" | "s3Client" | "allowPrivate">;
  key?: Buffer;
  batchRows?: number;
  recheckMs?: number;
  /** archive batches per tick (default 5) */
  maxBatches?: number;
  /** archives examined for pruning per tick (default 5) */
  maxPrunes?: number;
  /** workspaces per candidate page (default 10); tests only */
  workspacesPerPage?: number;
}

export interface RetentionResult {
  /** 1 when a policy with at least one window is in force */
  policyActive: number;
  /** 1 when the configured policy was invalid and everything is retained */
  policyInvalid: number;
  archiveBatches: number;
  archivedRows: number;
  prunedRows: number;
  /** archive steps that failed (write, readback or digest) and will be retried */
  archiveFailed: number;
  /** workspaces skipped because their own configured archive destination could not be opened (never falls back to the operator bucket) */
  destinationUnavailable: number;
  /** workspace and class pairs where archiving stopped at a row under an active legal hold this tick */
  archiveHeld: number;
  /** archives whose object could not be re-verified at prune time; nothing was deleted for them */
  pruneSkipped: number;
  /** true only when the delete gate was open this tick; otherwise archiving (if any) is copy-only */
  applied: boolean;
  /** why nothing was archived or deleted, when that is a configuration matter */
  note: string;
}

export async function retentionPass(db: Sql, options: RetentionOptions = {}): Promise<RetentionResult> {
  const env = options.env ?? process.env;
  const now = options.now ?? new Date();
  const load = options.load ?? loadRetentionPolicy(env);
  const gate = retentionApplyGate(env, load);
  const out: RetentionResult = { policyActive: 0, policyInvalid: load.ok ? 0 : 1, archiveBatches: 0, archivedRows: 0, prunedRows: 0, archiveFailed: 0, archiveHeld: 0, destinationUnavailable: 0, pruneSkipped: 0, applied: gate.enabled, note: gate.reason };
  if (!load.ok) return out;
  const policy = load.policy;
  const classesInUse = RETENTION_CLASSES.filter((c) => widestScan(policy, c, "archiveAfterDays") !== null);
  if (classesInUse.length === 0) { out.note = "No retention windows are configured: everything is retained."; return out; }
  out.policyActive = 1;
  // Operator bucket: the fallback for workspaces without their own destination.
  let operator: ArchiveTarget | undefined = options.target;
  let operatorNote = "";
  if (!operator) {
    const choice = archiveTargetFromEnv(env);
    if (choice.ok) operator = choice.target; else operatorNote = choice.reason;
  }
  const deps: ResolveDeps = { operator, ...options.tenant };
  const resolved = new Map<string, DestinationResolution>();
  const destinationFor = async (ws: string): Promise<DestinationResolution> => {
    let r = resolved.get(ws);
    if (!r) { r = await resolveDestination(db, ws, deps); resolved.set(ws, r); }
    return r;
  };

  let budget = options.maxBatches ?? RETENTION_BATCHES_PER_TICK;
  for (const cls of classesInUse) {
    const s = classSql(cls);
    // Each workspace is judged by its own window: a per-workspace override (including null = retain forever) wins over the
    // class default, and rows already covered by an archive are not candidates, so nothing starves the queue.
    const defaultDays = policy.classes[cls]?.archiveAfterDays ?? null;
    const overrides: Record<string, number | null> = {};
    for (const ws of Object.keys(policy.workspaces)) overrides[ws] = resolveWindow(policy, ws, cls).archiveAfterDays;
    const pageSize = Math.max(1, Math.trunc(options.workspacesPerPage ?? RETENTION_WORKSPACES_PER_CLASS));
    let cursor: { ts: string; ws: string } | null = null;
    for (let page = 0; page < RETENTION_WORKSPACE_PAGES_PER_CLASS && budget > 0; page++) {
    // Keyset paging on (oldest candidate time, workspace id): blocked workspaces stay first in order, so later pages reach the rest.
    const candidates: { workspace_id: string; first_ts: string }[] = await db.query<{ workspace_id: string; first_ts: string }>(
      `select l.workspace_id, min(${s.time})::text as first_ts from ${s.from}
        where ${s.cold}
          and ${s.time} < $1::timestamptz - make_interval(days => case when jsonb_exists($3::text::jsonb, l.workspace_id) then ($3::text::jsonb ->> l.workspace_id)::int else $2::int end)
          and not exists (select 1 from platform.retention_archives a where a.workspace_id = l.workspace_id and a.data_class = '${cls}'
                           and (a.last_recorded_at, a.last_row_id::${s.idType}) >= (${s.time}, l.id))
        group by l.workspace_id
        having ($5::text::timestamptz is null or (min(${s.time}), l.workspace_id) > ($5::text::timestamptz, $6::text))
        order by min(${s.time}), l.workspace_id limit $4::int`,
      [now.toISOString(), defaultDays, JSON.stringify(overrides), pageSize, cursor?.ts ?? null, cursor?.ws ?? null]);
    for (const { workspace_id: ws } of candidates) {
      if (budget <= 0) break;
      const w = resolveWindow(policy, ws, cls);
      if (w.archiveAfterDays === null) continue;
      const dest = await destinationFor(ws);
      if (!dest.ok) {
        if (dest.reason === "tenant_unavailable") out.destinationUnavailable++;
        else out.note = `${operatorNote || dest.detail} Nothing is archived or deleted for workspaces without a destination.`;
        continue;
      }
      const r = await archiveBatch(db, ws, cls, w.archiveAfterDays, { target: dest.destination.target, destination: { id: dest.destination.id, label: dest.destination.label }, key: options.key, now, policy, batchRows: options.batchRows });
      if (r.status === "archived") { budget--; out.archiveBatches++; out.archivedRows += r.rows; if (r.stoppedAtHold) out.archiveHeld++; }
      else if (r.status === "blocked") out.archiveHeld++;
      else if (r.status === "failed") { budget--; out.archiveFailed++; if (r.reason === "key_unavailable") { out.note = "ZENITH_BACKUP_KEY is not usable, so archives cannot be sealed."; return out; } }
    }
    if (candidates.length < pageSize) break;
    const lastRow = candidates[candidates.length - 1];
    cursor = { ts: lastRow.first_ts, ws: lastRow.workspace_id };
    }
  }

  if (gate.enabled) {
    for (const archive of await archivesToPrune(db, options.maxPrunes ?? RETENTION_BATCHES_PER_TICK)) {
      const w = resolveWindow(policy, archive.workspaceId, archive.dataClass);
      const recheck = options.recheckMs ?? 3_600_000;
      if (w.pruneAfterDays === null) { await deferArchive(db, archive.id, archive.workspaceId, recheck); continue; }
      const dest = await resolveDestination(db, archive.workspaceId, deps, { destinationId: archive.destinationId });
      if (!dest.ok) { out.pruneSkipped++; await deferArchive(db, archive.id, archive.workspaceId, recheck); continue; }
      const r = await pruneArchive(db, archive, w.pruneAfterDays, true, { target: dest.destination.target, key: options.key, now }, recheck);
      if (r.status === "pruned") out.prunedRows += r.deleted;
      else { out.pruneSkipped++; await deferArchive(db, archive.id, archive.workspaceId, recheck); }
    }
  }
  return out;
}
