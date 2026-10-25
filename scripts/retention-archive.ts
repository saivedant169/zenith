/**
 * Operator CLI for retention archives (PROD-OPS-07): list, verify and restore.
 *
 *   npx tsx --env-file-if-exists=.env.local scripts/retention-archive.ts list [--workspace ID]
 *   npx tsx --env-file-if-exists=.env.local scripts/retention-archive.ts verify ARCHIVE_ID
 *   npx tsx --env-file-if-exists=.env.local scripts/retention-archive.ts restore ARCHIVE_ID --staging SUFFIX [--ids ID,ID]
 *   npx tsx --env-file-if-exists=.env.local scripts/retention-archive.ts restore ARCHIVE_ID --source [--ids ID,ID]
 *
 * `verify` reads the object back from where it was written, unseals it (needs ZENITH_BACKUP_KEY) and compares it with
 * the verified record. `restore --staging` writes schema `retention_stage_<SUFFIX>`; `restore --source` re-inserts into
 * the source table without overwriting any existing row (idempotent). Every restore is read back and audited in
 * platform.retention_restores. Prints counts and verdicts only, never row data. Exit 0 ok, 1 failure or refusal, 2 usage.
 */
import { pathToFileURL } from "node:url";
import { openPlatformDb, platformDbConfigFromEnv } from "@/lib/controlplane/db";
import type { PlatformDb } from "@/lib/controlplane/types";
import { restoreArchive, verifyArchive } from "@/lib/retention/restore";
import { restoreDepsFromEnv } from "@/lib/retention/runtime";
import { listArchives } from "@/lib/retention/store";

const USAGE = "Usage: scripts/retention-archive.ts list [--workspace ID] | verify ARCHIVE_ID | restore ARCHIVE_ID (--staging SUFFIX | --source) [--ids ID,ID] [--legacy-purpose enc:backup --legacy-key-id ID --reason TEXT]";

function flag(args: readonly string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}


/** The error's type and code only (for example `HostedError:policy_unavailable` or `DatabaseError:42P01`). Both are fixed identifiers, never data. */
function failureKind(error: unknown, depth = 0): string {
  const r = (error && typeof error === "object" ? error : {}) as { name?: unknown; code?: unknown; cause?: unknown };
  const name = typeof r.name === "string" && /^[A-Za-z]{1,40}$/.test(r.name) ? r.name : "Error";
  const code = typeof r.code === "string" && /^[A-Za-z0-9_]{1,40}$/.test(r.code) ? `:${r.code}` : "";
  const cause = depth < 2 && r.cause && typeof r.cause === "object" ? `<${failureKind(r.cause, depth + 1)}` : "";
  return `${name}${code}${cause}`;
}
export async function retentionArchiveMain(
  args: readonly string[],
  output: (line: string) => void = (line) => process.stdout.write(`${line}\n`),
  error: (line: string) => void = (line) => process.stderr.write(`${line}\n`),
  env: Readonly<Record<string, string | undefined>> = process.env
): Promise<number> {
  const [command, id] = args;
  const known = new Set(["list", "verify", "restore"]);
  if (!command || !known.has(command) || (command !== "list" && (!id || id.startsWith("--")))) { error(USAGE); return 2; }
  const staging = flag(args, "--staging");
  const source = args.includes("--source");
  if (command === "restore" && (!!staging === source)) { error(USAGE); return 2; }
  const legacyPurpose = flag(args, "--legacy-purpose");
  const legacyId = flag(args, "--legacy-key-id");
  const legacyReason = flag(args, "--reason");
  const legacyRequested = args.some(a => ["--legacy-purpose", "--legacy-key-id", "--reason"].includes(a));
  if (legacyRequested && (command !== "restore" || legacyPurpose !== "enc:backup" || !legacyId || !legacyReason)) { error(USAGE); return 2; }
  let db: PlatformDb | undefined;
  try {
    const config = platformDbConfigFromEnv(env);
    if (config.kind !== "postgres" || !config.url) { error("A Postgres platform store is required (ZENITH_PLATFORM_DB_URL or SUPABASE_DB_URL)."); return 1; }
    db = await openPlatformDb({ kind: "postgres", url: config.url, max: 1, migrate: false });
    const deps = restoreDepsFromEnv(env);
    if (command === "list") {
      const rows = await listArchives(db, { workspaceId: flag(args, "--workspace"), limit: 200 });
      for (const a of rows) output(JSON.stringify({ id: a.id, workspaceId: a.workspaceId, dataClass: a.dataClass, keyId: a.keyId, rows: a.rowCount, prunedRows: a.prunedRows, destination: a.destinationLabel, verifiedAt: a.verifiedAt, completed: a.completedAt !== null }));
      return 0;
    }
    if (command === "verify") {
      const r = await verifyArchive(db, id!, { deps });
      output(JSON.stringify({ ok: r.ok, rows: r.rows, problems: r.problems }));
      return r.ok ? 0 : 1;
    }
    const ids = flag(args, "--ids")?.split(",").map((s) => s.trim()).filter(Boolean);
    const r = await restoreArchive(db, { archiveId: id!, mode: source ? "source" : "staging", stagingSuffix: staging, rowIds: ids, actor: "cli:operator", ...(legacyRequested ? { legacyKey: { originalPurpose: "enc:backup", keyId: legacyId!, reason: legacyReason! } as const } : {}) }, { deps, privileged: true, env });
    output(JSON.stringify(r));
    return r.verdict === "verified" ? 0 : 1;
  } catch (failure) {
    // Connection and query errors can carry URLs or row data; only the error type and code are echoed.
    error(`Retention archive command failed (${failureKind(failure)}). Check the platform store configuration and that the schema is migrated.`);
    return 1;
  } finally {
    if (db) await db.close().catch(() => undefined);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void retentionArchiveMain(process.argv.slice(2)).then((code) => { process.exitCode = code; });
}
