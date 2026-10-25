/**
 * Operator trigger for the `data-retention` critical job (PROD-OPS-07), for installs without the Temporal
 * critical-maintenance schedule (the schedule runs the same pass every minute).
 *
 *   npx tsx --env-file-if-exists=.env.local scripts/data-retention.ts [--force]
 *
 * One bounded pass under the schedule's own lease and run record (`critical-job:data-retention`). With no policy
 * configured (ZENITH_RETENTION_POLICY_FILE or ZENITH_RETENTION_POLICY) the approved DEC-RETENTION baseline applies
 * (logs archived after 30 days). It archives cold rows to the configured object storage (copy-only, verified by
 * readback) and deletes only when ZENITH_RETENTION_APPLY=1 AND the policy carries a DEC-RETENTION approval record.
 * Without --force it defers (prints {"status":"skipped"}) when the durable schedule ran within the last 90 s; --force
 * runs now under the same lease. Prints counts only. Exit 0 ok (including skipped or busy), 1 failure, 2 usage.
 */
import { pathToFileURL } from "node:url";
import { openPlatformDb, platformDbConfigFromEnv } from "@/lib/controlplane/db";
import type { PlatformDb } from "@/lib/controlplane/types";
import { countsOf, runCriticalJob } from "@/lib/platform/critical-jobs";
import { retentionPass } from "@/lib/retention/job";


/** The error's type and code only (for example `HostedError:policy_unavailable` or `DatabaseError:42P01`). Both are fixed identifiers, never data. */
function failureKind(error: unknown, depth = 0): string {
  const r = (error && typeof error === "object" ? error : {}) as { name?: unknown; code?: unknown; cause?: unknown };
  const name = typeof r.name === "string" && /^[A-Za-z]{1,40}$/.test(r.name) ? r.name : "Error";
  const code = typeof r.code === "string" && /^[A-Za-z0-9_]{1,40}$/.test(r.code) ? `:${r.code}` : "";
  const cause = depth < 2 && r.cause && typeof r.cause === "object" ? `<${failureKind(r.cause, depth + 1)}` : "";
  return `${name}${code}${cause}`;
}
export async function dataRetentionMain(
  args: readonly string[],
  output: (line: string) => void = (line) => process.stdout.write(`${line}\n`),
  error: (line: string) => void = (line) => process.stderr.write(`${line}\n`),
  env: Readonly<Record<string, string | undefined>> = process.env
): Promise<number> {
  const force = args.length === 1 && args[0] === "--force";
  if (args.length > 0 && !force) { error("Usage: npx tsx --env-file-if-exists=.env.local scripts/data-retention.ts [--force]"); return 2; }
  let db: PlatformDb | undefined;
  try {
    const config = platformDbConfigFromEnv(env);
    if (config.kind !== "postgres" || !config.url) { error("A Postgres platform store is required (ZENITH_PLATFORM_DB_URL or SUPABASE_DB_URL)."); return 1; }
    db = await openPlatformDb({ kind: "postgres", url: config.url, max: 1, migrate: false });
    const handle = db;
    const run = await runCriticalJob(handle, "data-retention", "fallback", async () => {
      const value = await retentionPass(handle, { env });
      return { value, performed: true, counts: countsOf(value) };
    }, { force });
    if (run.status === "ok") output(JSON.stringify(run.value));
    else output(JSON.stringify({ status: run.status }));
    return 0;
  } catch (failure) {
    // Connection and query errors can carry URLs or row data; only the error type and code are echoed.
    error(`Data retention failed (${failureKind(failure)}). Check the platform store configuration and that the schema is migrated.`);
    return 1;
  } finally {
    if (db) await db.close().catch(() => undefined);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void dataRetentionMain(process.argv.slice(2)).then((code) => { process.exitCode = code; });
}
