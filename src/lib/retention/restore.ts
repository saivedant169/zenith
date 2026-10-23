/**
 * Archive verification and restore (PROD-OPS-07).
 *
 * `verifyArchive` proves an archive is intact: the object is read from the destination it was written to, unsealed
 * (GCM authentication fails on any change, and a wrong key fails), parsed, and its rows digest, row count, id range and
 * workspace are compared with the platform's verified record.
 *
 * `restoreArchive` puts selected records back, only after `verifyArchive` passes:
 *   - `staging`: into a fresh schema `retention_stage_<suffix>` (a table per class shaped like the source, no foreign keys),
 *     for inspection with plain SQL. Nothing in `platform` changes.
 *   - `source`: back into the source table. It inserts `ON CONFLICT DO NOTHING`, so an existing row, including a newer
 *     one, is never overwritten; rows whose parent no longer exists are skipped and counted rather than failing the
 *     batch; only rows of the archive's own workspace are inserted. Re-running changes nothing (idempotent).
 * Every run reads the restored rows back from the target and compares them with the archive, then writes an
 * append-only `platform.retention_restores` audit row (including refusals).
 *
 * Tenancy: every statement is bound by the archive's workspace_id; the archive is looked up by (workspace_id, id) pair as
 * recorded, never from caller-supplied row data.
 */
import { assertNoSecretValues } from "@/lib/controlplane/db/secrets";
import { randomUUID } from "node:crypto";
import type { Sql } from "@/lib/controlplane/types";
import { canonical } from "@/lib/controlplane/digest";
import { KeyRing } from "@/lib/keycustody/registry";
import { archiveKey } from "./key";
import { keyIdOf } from "@/lib/hosted/backup/crypto";
import { CLASS_SPECS, assertPrunableClass } from "./classes";
import { readBack, type ArchivePayload, type ArchiveTarget } from "./archive";
import { resolveDestination, type ResolveDeps } from "./destination";
import { getArchive, type ArchiveRecord } from "./store";

export const RESTORE_BATCH = 500;
const STAGING_SUFFIX = /^[a-z0-9_]{1,40}$/;
const legacyAuditReason = (reason: string | undefined): string | null => {
  if (!reason || !/^[A-Za-z0-9 ._:/()-]{1,200}$/.test(reason)) return null;
  try { assertNoSecretValues(reason); return reason; } catch { return null; }
};

export type RestoreMode = "staging" | "source";

export interface VerifyResult { ok: boolean; problems: string[]; archive: ArchiveRecord | null; rows: number }

export interface RestoreContext {
  deps: ResolveDeps;
  key?: Buffer;
  /** Set only by the authenticated operator route or the database-credential CLI. */
  privileged?: boolean;
  env?: Readonly<Record<string, string | undefined>>;

}

async function loadVerified(db: Sql, archive: ArchiveRecord, ctx: RestoreContext, legacy?: RestoreInput["legacyKey"]): Promise<{ payload: ArchivePayload } | { problems: string[] }> {
  const dest = await resolveDestination(db, archive.workspaceId, ctx.deps, { destinationId: archive.destinationId });
  if (!dest.ok) return { problems: [dest.detail] };
  let key: Buffer;
  try {
    if (legacy) {
      if (!ctx.privileged || legacy.originalPurpose !== "enc:backup" || legacy.keyId !== archive.keyId
        || !legacyAuditReason(legacy.reason))
        return { problems: ["Legacy restore requires operator privilege, original purpose enc:backup, the recorded key id and a plain audit reason."] };
      // Explicit purpose and exact key id only. Never try other purposes after authentication failure.
      // Archive headers use the historical 8-hex fingerprint, while the custody registry uses its own key ids.
      const matches = KeyRing.fromEnv(ctx.env ?? process.env, { purposes: [legacy.originalPurpose] }).materialFor(legacy.originalPurpose, "decrypt").filter(k => keyIdOf(k.key) === legacy.keyId);
      if (matches.length !== 1) throw new Error("Named legacy key missing or ambiguous");
      key = matches[0].key;
    } else key = ctx.key ?? archiveKey(ctx.env);
  } catch { return { problems: ["The named restore key is unavailable for its explicit purpose."] }; }
  if (keyIdOf(key) !== archive.keyId) return { problems: ["The archive key does not match. Pre-purpose-separation archives require an explicit privileged legacy restore naming enc:backup and the recorded key id; keys are never guessed."] };
  let payload: ArchivePayload | null = null;
  try { payload = await readBack(dest.destination.target as ArchiveTarget, key, archive.objectKey, archive.rowsDigest); } catch { /* unreadable */ }
  if (!payload) return { problems: ["The archive object is missing, cannot be unsealed, or its rows digest does not match the verified record."] };
  const problems: string[] = [];
  if (payload.workspaceId !== archive.workspaceId || payload.dataClass !== archive.dataClass) problems.push("The archive object belongs to a different workspace or data class.");
  if (payload.rows.length !== archive.rowCount || payload.manifest.rowCount !== archive.rowCount) problems.push("The archive row count does not match the record.");
  if (String(payload.rows[0]?.id) !== archive.firstRowId || String(payload.rows[payload.rows.length - 1]?.id) !== archive.lastRowId) problems.push("The archive row-id range does not match the record.");
  if (payload.rows.some((r) => r.workspace_id !== archive.workspaceId)) problems.push("The archive holds rows of another workspace.");
  return problems.length ? { problems } : { payload };
}

export async function verifyArchive(db: Sql, archiveId: string, ctx: RestoreContext, workspaceId?: string): Promise<VerifyResult> {
  const archive = await getArchive(db, archiveId, workspaceId);
  if (!archive) return { ok: false, problems: ["No such archive."], archive: null, rows: 0 };
  const r = await loadVerified(db, archive, ctx);
  return "payload" in r ? { ok: true, problems: [], archive, rows: r.payload.rows.length } : { ok: false, problems: r.problems, archive, rows: 0 };
}

export interface RestoreInput {
  /** Pre-purpose-separation archives only. This is an audited, privileged decrypt operation. */
  legacyKey?: { originalPurpose: "enc:backup"; keyId: string; reason: string };
  archiveId: string;
  mode: RestoreMode;
  /** staging mode: the schema becomes `retention_stage_<suffix>` */
  stagingSuffix?: string;
  /** restore only these row ids (must be in the archive); default all */
  rowIds?: readonly string[];
  actor: string;
  workspaceId?: string;
}

export interface RestoreResult {
  verdict: "verified" | "mismatch" | "refused";
  detail: string;
  mode: RestoreMode;
  stagingSchema: string | null;
  selected: number;
  inserted: number;
  existingIdentical: number;
  existingDiffer: number;
  skippedNoParent: number;
  auditId: string | null;
}

async function audit(db: Sql, archive: ArchiveRecord, input: RestoreInput, r: Omit<RestoreResult, "auditId">): Promise<string> {
  assertNoSecretValues(r.detail);
  const id = `rrest_${randomUUID()}`;
  await db.query(
    `insert into platform.retention_restores (id, workspace_id, archive_id, data_class, mode, staging_schema, requested_by, rows_selected, rows_inserted, rows_existing_identical, rows_existing_differ, rows_skipped_no_parent, verdict, detail, key_purpose, restore_key_id, legacy_reason)
     values ($1, $2, $3, $4, $5, $6, $7, $8::int, $9::int, $10::int, $11::int, $12::int, $13, $14, $15, $16, $17)`,
    [id, archive.workspaceId, archive.id, archive.dataClass, r.mode, r.stagingSchema, input.actor.slice(0, 128), r.selected, r.inserted, r.existingIdentical, r.existingDiffer, r.skippedNoParent, r.verdict, r.detail.slice(0, 500), input.legacyKey?.originalPurpose === "enc:backup" ? "enc:backup" : "enc:archive", input.legacyKey?.keyId?.slice(0, 128) || archive.keyId, legacyAuditReason(input.legacyKey?.reason)]);
  return id;
}

const q = (ident: string): string => `"${ident.replace(/"/g, '""')}"`;

export async function restoreArchive(db: Sql, input: RestoreInput, ctx: RestoreContext): Promise<RestoreResult> {
  const mode = input.mode;
  const base = { mode, stagingSchema: null as string | null, selected: 0, inserted: 0, existingIdentical: 0, existingDiffer: 0, skippedNoParent: 0 };
  const archive = await getArchive(db, input.archiveId, input.workspaceId);
  if (!archive) return { ...base, verdict: "refused", detail: "No such archive.", auditId: null };
  const refuse = async (detail: string): Promise<RestoreResult> => {
    const r = { ...base, verdict: "refused" as const, detail };
    return { ...r, auditId: await audit(db, archive, input, r) };
  };
  if (input.legacyKey && (!ctx.privileged || input.legacyKey.originalPurpose !== "enc:backup"
    || !/^[A-Za-z0-9_-]{1,128}$/.test(input.legacyKey.keyId) || input.legacyKey.keyId !== archive.keyId
    || !legacyAuditReason(input.legacyKey.reason)))
    return refuse("Legacy restore requires operator privilege, original purpose enc:backup, the recorded key id and a plain audit reason.");
  const cls = assertPrunableClass(archive.dataClass);
  const spec = CLASS_SPECS[cls];
  let stagingSchema: string | null = null;
  if (mode === "staging") {
    if (!input.stagingSuffix || !STAGING_SUFFIX.test(input.stagingSuffix)) return refuse("stagingSuffix must be 1 to 40 characters of a-z, 0-9 and underscore.");
    stagingSchema = `retention_stage_${input.stagingSuffix}`;
  } else if (mode !== "source") return refuse("mode must be staging or source.");

  const loaded = await loadVerified(db, archive, ctx, input.legacyKey);
  if (!("payload" in loaded)) return refuse(`The archive failed verification: ${loaded.problems.join(" ")}`);
  let rows = loaded.payload.rows;
  if (input.rowIds) {
    const want = new Set(input.rowIds.map(String));
    const have = new Set(rows.map((r) => String(r.id)));
    const unknown = [...want].filter((id) => !have.has(id));
    if (unknown.length) return refuse(`${unknown.length} requested row id(s) are not in this archive.`);
    rows = rows.filter((r) => want.has(String(r.id)));
  }
  const expected = new Map(rows.map((r) => [String(r.id), canonical(r)]));
  const target = stagingSchema ? `${q(stagingSchema)}.${q(cls)}` : spec.table;

  let inserted = 0;
  let skippedNoParent = 0;
  await db.tx(async (tx) => {
    if (stagingSchema) {
      await tx.query(`create schema if not exists ${q(stagingSchema)}`);
      await tx.query(`create table if not exists ${target} (like ${spec.table} including defaults, primary key (id))`);
    }
    for (let i = 0; i < rows.length; i += RESTORE_BATCH) {
      const chunk = JSON.stringify(rows.slice(i, i + RESTORE_BATCH));
      const overriding = !stagingSchema && spec.idType === "bigint" ? " overriding system value" : "";
      const parent = !stagingSchema && spec.restoreParent
        ? ` and exists (select 1 from ${spec.restoreParent.table} p where p.workspace_id = r.workspace_id and p.id = r.${spec.restoreParent.fk})`
        : "";
      const done = await tx.query<{ id: string }>(
        `insert into ${target}${overriding} select r.* from jsonb_populate_recordset(null::${spec.table}, $1::text::jsonb) r where r.workspace_id = $2${parent}
         on conflict do nothing returning id::text as id`,
        [chunk, archive.workspaceId]);
      inserted += done.length;
    }
    if (!stagingSchema && spec.restoreParent) {
      const missing = await tx.query<{ n: number }>(
        `select count(*)::int as n from jsonb_populate_recordset(null::${spec.table}, $1::text::jsonb) r
          where not exists (select 1 from ${spec.restoreParent.table} p where p.workspace_id = r.workspace_id and p.id = r.${spec.restoreParent.fk})`,
        [JSON.stringify(rows)]);
      skippedNoParent = Number(missing[0]?.n ?? 0);
    }
  });

  // Read back from the target and compare with the archive, row by row.
  const present = new Map<string, string>();
  for (let i = 0; i < rows.length; i += RESTORE_BATCH) {
    const ids = JSON.stringify(rows.slice(i, i + RESTORE_BATCH).map((r) => String(r.id)));
    const back = await db.query<{ id: string; row: Record<string, unknown> }>(
      `select t.id::text as id, to_jsonb(t) as row from ${target} t where t.workspace_id = $2 and t.id::text in (select jsonb_array_elements_text($1::text::jsonb))`,
      [ids, archive.workspaceId]);
    for (const b of back) present.set(b.id, canonical(typeof b.row === "string" ? JSON.parse(b.row) : b.row));
  }
  let identical = 0;
  let differ = 0;
  let missing = 0;
  for (const [id, want] of expected) {
    const got = present.get(id);
    if (got === undefined) missing++;
    else if (got === want) identical++;
    else differ++;
  }
  // Rows we inserted are identical by construction; rows that already existed and differ are kept as they are (never overwritten).
  const existingIdentical = Math.max(0, identical - inserted);
  const unexplainedMissing = Math.max(0, missing - skippedNoParent);
  const verdict = unexplainedMissing > 0 || (stagingSchema !== null && differ > 0) ? "mismatch" : "verified";
  const detail = verdict === "verified"
    ? `Read back ${identical + differ} of ${rows.length} row(s); ${inserted} inserted, ${existingIdentical} already present and identical, ${differ} already present and different (kept), ${skippedNoParent} skipped (parent missing).`
    : `Read-back mismatch: ${unexplainedMissing} row(s) missing${stagingSchema ? ` and ${differ} different` : ""} after restore.`;
  const result = { verdict, detail, mode, stagingSchema, selected: rows.length, inserted, existingIdentical, existingDiffer: differ, skippedNoParent } as const;
  return { ...result, auditId: await audit(db, archive, input, result) };
}
