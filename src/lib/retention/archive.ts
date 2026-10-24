/**
 * The durable archive step and the bounded, archive-gated prune (PROD-OPS-07).
 *
 * Archive (copy only, never touches the source): select a bounded batch of cold rows of one workspace and class
 * beyond the last archived row (stopping BEFORE the first row under a legal hold: a held row is never copied and the
 * watermark never passes it, so it is archived normally after the hold is released), serialize them with an integrity manifest, SEAL the bytes (AES-256-GCM under
 * ZENITH_BACKUP_KEY, the existing backup crypto), write them under a workspace-prefixed key, READ THEM BACK, unseal,
 * recompute the rows digest and compare it with the one computed from the database. Only then is the archive recorded.
 * A failed write, a failed readback or a digest mismatch records nothing and the next tick retries the same batch
 * (the key is derived from the batch content, so a retry rewrites the same object).
 *
 * Prune (the only deletion): needs the apply gate (policy approval + ZENITH_RETENTION_APPLY=1, see policy.ts), and
 * then deletes ONLY rows whose ids are listed in a verified archive that is read back and digest-verified again at
 * prune time, that are old enough, settled, not the latest of their group, and not under a legal hold. Holds are
 * re-checked inside the delete statement under the holds advisory lock.
 */
import { createHash } from "node:crypto";
import type { Sql } from "@/lib/controlplane/types";
import { canonical } from "@/lib/controlplane/digest";
import { FilesystemTarget, S3Target, type S3Like } from "@/lib/hosted/backup/targets";
import { archiveKey } from "./key";
import { keyIdOf, seal, unseal } from "@/lib/hosted/backup/crypto";
import { CLASS_SPECS, assertPrunableClass, type RetentionClass } from "./classes";
import { policyDigest, type RetentionPolicy } from "./policy";
import { acquireHoldLock, archiveWatermark, classSql, markPruned, pruneSql, recordArchive, type ArchiveRecord } from "./store";

export const ARCHIVE_BATCH_ROWS = 500;
export const ARCHIVE_FORMAT = "zenith-retention-archive/1";
const RECHECK_MS = 60 * 60 * 1000;

/** The slice of a backup target the archive needs. */
export interface ArchiveTarget {
  readonly label: string;
  put(key: string, bytes: Buffer): Promise<void>;
  get(key: string): Promise<Buffer | null>;
}

export type ArchiveTargetChoice =
  | { ok: true; target: ArchiveTarget; kind: "filesystem" | "s3" | "injected"; label: string }
  | { ok: false; reason: string };

/**
 * The archive object store, from configuration (it is separate from the backup target so an operator can point
 * archives at storage the tenant owns):
 *   ZENITH_RETENTION_ARCHIVE_TARGET=filesystem  ZENITH_RETENTION_ARCHIVE_DIR=<dir>
 *   ZENITH_RETENTION_ARCHIVE_TARGET=s3          ZENITH_RETENTION_ARCHIVE_S3_BUCKET=<bucket> ZENITH_RETENTION_ARCHIVE_S3_REGION=<region> [ZENITH_RETENTION_ARCHIVE_S3_ENDPOINT=<url>]
 *   (the region falls back to AWS_REGION, then AWS_DEFAULT_REGION; it may be omitted only with a custom endpoint)
 */
export function archiveTargetFromEnv(env: Readonly<Record<string, string | undefined>> = process.env, s3Client?: S3Like): ArchiveTargetChoice {
  const kind = env.ZENITH_RETENTION_ARCHIVE_TARGET?.trim();
  if (!kind || kind === "none") return { ok: false, reason: "No archive storage is configured (ZENITH_RETENTION_ARCHIVE_TARGET)." };
  if (kind === "filesystem") {
    const dir = env.ZENITH_RETENTION_ARCHIVE_DIR?.trim();
    if (!dir) return { ok: false, reason: "ZENITH_RETENTION_ARCHIVE_TARGET=filesystem needs ZENITH_RETENTION_ARCHIVE_DIR." };
    const target = new FilesystemTarget(dir);
    return { ok: true, target, kind: "filesystem", label: target.label };
  }
  if (kind === "s3") {
    const bucket = env.ZENITH_RETENTION_ARCHIVE_S3_BUCKET?.trim();
    if (!bucket) return { ok: false, reason: "ZENITH_RETENTION_ARCHIVE_TARGET=s3 needs ZENITH_RETENTION_ARCHIVE_S3_BUCKET." };
    const endpoint = env.ZENITH_RETENTION_ARCHIVE_S3_ENDPOINT?.trim() || undefined;
    // Without a region the SDK would talk to us-east-1, which fails for a bucket elsewhere (e.g. ap-south-1).
    const region = [env.ZENITH_RETENTION_ARCHIVE_S3_REGION, env.AWS_REGION, env.AWS_DEFAULT_REGION].map((v) => v?.trim()).find(Boolean);
    if (!region && !endpoint) return { ok: false, reason: "ZENITH_RETENTION_ARCHIVE_TARGET=s3 needs ZENITH_RETENTION_ARCHIVE_S3_REGION (or AWS_REGION)." };
    const target = new S3Target({ bucket, endpoint, region, client: s3Client });
    return { ok: true, target, kind: "s3", label: target.label };
  }
  return { ok: false, reason: `ZENITH_RETENTION_ARCHIVE_TARGET must be filesystem or s3, not "${kind.slice(0, 20)}".` };
}

/** Key of the sealed archive object: workspace-prefixed, derived from the content so a retry rewrites the same object. */
export function archiveObjectKey(workspaceId: string, cls: RetentionClass, firstId: string, lastId: string, rowsDigest: string): string {
  const safe = (s: string) => s.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 80);
  return `retention/${safe(workspaceId)}/${cls}/${safe(firstId)}-${safe(lastId)}-${rowsDigest.slice(0, 16)}.zra`;
}

export const rowsDigestOf = (rows: readonly unknown[]): string => createHash("sha256").update(canonical(rows)).digest("hex");

export interface ArchivePayload {
  format: typeof ARCHIVE_FORMAT;
  workspaceId: string;
  dataClass: RetentionClass;
  manifest: { rowCount: number; firstRowId: string; lastRowId: string; lastRecordedAt: string; rowsDigest: string; createdAt: string };
  rows: Record<string, unknown>[];
}

export interface ArchiveContext {
  target: ArchiveTarget;
  /** where `target` is: null id = the operator bucket, else the tenant destination row */
  destination?: { id: string | null; label: string };
  /** 32-byte sealing key; defaults to ZENITH_BACKUP_KEY */
  key?: Buffer;
  now?: Date;
  batchRows?: number;
  policy: RetentionPolicy;
}

export type ArchiveOutcome =
  | { status: "archived"; archive: ArchiveRecord; rows: number; /** the batch stopped before a row under a legal hold */ stoppedAtHold?: true }
  | { status: "nothing_to_archive" }
  /** the next row to archive is under an active legal hold, so nothing is copied for this workspace and class */
  | { status: "blocked"; reason: "legal_hold" }
  | { status: "failed"; reason: "key_unavailable" | "write_failed" | "readback_failed" | "digest_mismatch" };

/** Read the archive object back and prove it holds exactly the expected rows. */
export async function readBack(target: ArchiveTarget, key: Buffer, objectKey: string, expectedDigest: string, expectedIds?: readonly string[]): Promise<ArchivePayload | null> {
  const bytes = await target.get(objectKey);
  if (!bytes) return null;
  let payload: ArchivePayload;
  try { payload = JSON.parse(unseal(bytes, key).plain.toString("utf8")) as ArchivePayload; } catch { return null; }
  if (payload?.format !== ARCHIVE_FORMAT || !Array.isArray(payload.rows)) return null;
  if (rowsDigestOf(payload.rows) !== expectedDigest || payload.manifest?.rowsDigest !== expectedDigest) return null;
  if (expectedIds && (payload.rows.length !== expectedIds.length || payload.rows.some((r, i) => String(r.id) !== expectedIds[i]))) return null;
  return payload;
}

/** Archive one bounded batch. The source rows are never modified here. */
export async function archiveBatch(db: Sql, workspaceId: string, cls: RetentionClass, archiveAfterDays: number, ctx: ArchiveContext): Promise<ArchiveOutcome> {
  assertPrunableClass(cls);
  const now = ctx.now ?? new Date();
  const limit = Math.max(1, Math.min(ARCHIVE_BATCH_ROWS, Math.trunc(ctx.batchRows ?? ARCHIVE_BATCH_ROWS)));
  const s = classSql(cls);
  const wm = await archiveWatermark(db, workspaceId, cls);
  // The candidate batch and its hold flags are read under the holds advisory lock, so a hold cannot be created between
  // the check and the selection. The object write below happens outside the lock: a hold placed while a copy is in
  // flight applies from the next batch (the copy only adds a sealed duplicate; the source rows are never touched here).
  const candidates = await db.tx(async (tx) => {
    await acquireHoldLock(tx);
    return tx.query<{ row: Record<string, unknown>; id: string; ts: string; held: boolean }>(
      `select to_jsonb(l) as row, l.id::text as id, ${s.time}::text as ts, ${s.held} as held from ${s.from}
        where l.workspace_id = $1 and ${s.cold} and ${s.time} < $2::timestamptz - make_interval(days => $3::int)
          and ($4::text::timestamptz is null or (${s.time}, l.id) > ($4::text::timestamptz, $5::${s.idType}))
        order by ${s.time}, l.id limit $6::int`,
      [workspaceId, now.toISOString(), archiveAfterDays, wm?.ts ?? null, wm?.id ?? null, limit]);
  });
  if (!candidates.length) return { status: "nothing_to_archive" };
  // Stop at the first held row: it is never copied and the watermark (the last archived row) never passes it.
  const firstHeld = candidates.findIndex((r) => r.held === true);
  if (firstHeld === 0) return { status: "blocked", reason: "legal_hold" };
  const rows = firstHeld === -1 ? candidates : candidates.slice(0, firstHeld);
  let key: Buffer;
  try { key = ctx.key ?? archiveKey(); } catch { return { status: "failed", reason: "key_unavailable" }; }

  const data = rows.map((r) => (typeof r.row === "string" ? JSON.parse(r.row) : r.row) as Record<string, unknown>);
  const ids = rows.map((r) => r.id);
  const first = rows[0];
  const last = rows[rows.length - 1];
  const rowsDigest = rowsDigestOf(data);
  const payload: ArchivePayload = {
    format: ARCHIVE_FORMAT, workspaceId, dataClass: cls,
    manifest: { rowCount: data.length, firstRowId: first.id, lastRowId: last.id, lastRecordedAt: last.ts, rowsDigest, createdAt: now.toISOString() },
    rows: data,
  };
  const objectKey = archiveObjectKey(workspaceId, cls, first.id, last.id, rowsDigest);
  const sealed = seal(Buffer.from(JSON.stringify(payload), "utf8"), key);
  try { await ctx.target.put(objectKey, sealed.bytes); } catch { return { status: "failed", reason: "write_failed" }; }
  let back: ArchivePayload | null;
  try { back = await readBack(ctx.target, key, objectKey, rowsDigest, ids); } catch { return { status: "failed", reason: "readback_failed" }; }
  if (!back) return { status: "failed", reason: "digest_mismatch" };
  const archive = await recordArchive(db, {
    workspaceId, dataClass: cls, objectKey, rowsDigest, rowCount: data.length, firstRowId: first.id, lastRowId: last.id,
    lastRecordedAt: last.ts, keyId: sealed.keyId, policyDigest: policyDigest(ctx.policy),
    destinationId: ctx.destination?.id ?? null, destinationLabel: ctx.destination?.label ?? ctx.target.label,
  });
  return { status: "archived", archive, rows: data.length, ...(firstHeld > 0 ? { stoppedAtHold: true as const } : {}) };
}

export type PruneOutcome =
  | { status: "pruned"; deleted: number; remaining: number }
  | { status: "skipped"; reason: "archive_unreadable" | "key_unavailable" };

/**
 * Prune the rows of one verified archive that the policy allows. Re-verifies the archive object first: if it cannot be
 * read back and matched, nothing is deleted. `apply` must come from `retentionApplyGate(...).enabled`.
 */
export async function pruneArchive(db: Sql, archive: ArchiveRecord, pruneAfterDays: number, apply: boolean, ctx: Pick<ArchiveContext, "target" | "key" | "now">, recheckMs = RECHECK_MS): Promise<PruneOutcome> {
  if (!apply) throw new Error("pruneArchive requires the apply gate; callers must check retentionApplyGate first.");
  const cls = assertPrunableClass(archive.dataClass);
  let key: Buffer;
  try { key = ctx.key ?? archiveKey(); } catch { return { status: "skipped", reason: "key_unavailable" }; }
  let payload: ArchivePayload | null = null;
  try { payload = await readBack(ctx.target, key, archive.objectKey, archive.rowsDigest); } catch { /* treated as unreadable */ }
  if (!payload || payload.rows.length !== archive.rowCount || keyIdOf(key) !== archive.keyId) return { status: "skipped", reason: "archive_unreadable" };
  const ids = payload.rows.map((r) => String(r.id));
  const spec = CLASS_SPECS[cls];
  const now = (ctx.now ?? new Date()).toISOString();
  const deleted = await db.tx(async (tx) => {
    await acquireHoldLock(tx);
    const gone = await tx.query<{ id: string }>(pruneSql(cls), [archive.workspaceId, JSON.stringify(ids), now, pruneAfterDays]);
    return gone.length;
  });
  const left = await db.query<{ n: number }>(
    `select count(*)::int as n from ${spec.table} l where l.workspace_id = $1 and l.id in (select x::${spec.idType} from jsonb_array_elements_text($2::text::jsonb) x)`,
    [archive.workspaceId, JSON.stringify(ids)]);
  const remaining = Number(left[0]?.n ?? 0);
  await markPruned(db, archive.id, archive.workspaceId, deleted, remaining, recheckMs);
  return { status: "pruned", deleted, remaining };
}
