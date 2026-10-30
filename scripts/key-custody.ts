/**
 * Operator CLI for key custody and Temporal codec diagnostics (PROD-OPS-05).
 *
 *   diagnose  [--json] [--no-db]                    key ids, purposes, roles, ages, retirement, separation findings
 *   codec     --file <path|-> [--verify] [--json]   which key id each Temporal payload in a history needs
 *   sync                                            record the configured key ids (first-seen = key age)
 *   retire-after --purpose P --key-id ID --date ISO|none
 *   retire    --purpose P --key-id ID --by NAME     attest a non-current key is no longer configured anywhere
 *   rewrap    --workspace ID [--run]                queue a durable vault re-wrap; the critical-maintenance schedule runs it,
 *                                                   or --run works it now under the same lease and run record
 *   rewrap-status [--workspace ID]                  durable re-wrap jobs
 *
 * Keys come only from the environment. Output is ids, purposes, roles, source variable NAMES, ages, counts and
 * certificate fingerprints: never key material, secret values, refs or configuration values. `codec --verify`
 * attempts decryption and prints only ok/failed counts. Exit 0 ok, 1 failure or an error-level finding,
 * 2 usage error. Run with: npx tsx --env-file-if-exists=.env.local scripts/key-custody.ts <command> ...
 */
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { openPlatformDb, platformDbConfigFromEnv } from "@/lib/controlplane/db";
import { countsOf, runCriticalJob } from "@/lib/platform/critical-jobs";
import type { PlatformDb, Sql } from "@/lib/controlplane/types";
import { buildKeyReport, inspectTemporalMtls, inspectTemporalPayloads, renderKeyReport, reportExitCode, summarizePayloadFindings } from "@/lib/keycustody/diagnostics";
import { isKeyPurpose } from "@/lib/keycustody/purposes";
import { KeyRing } from "@/lib/keycustody/registry";
import { keyRewrapPass } from "@/lib/keycustody/rewrap-job";
import { enqueueRewrapJob, listKeys, listRewrapJobs, markRetired, recordKeys, rewrapBacklog, setRetireAfter } from "@/lib/keycustody/store";

type Out = (line: string) => void;
const COMMANDS = ["diagnose", "codec", "sync", "retire-after", "retire", "rewrap", "rewrap-status"] as const;
type Command = (typeof COMMANDS)[number];

const USAGE = [
  "Usage: npx tsx --env-file-if-exists=.env.local scripts/key-custody.ts <command> [options]",
  "  diagnose [--json] [--no-db]",
  "  codec --file <path|-> [--verify] [--json]",
  "  sync",
  "  retire-after --purpose <purpose> --key-id <id> --date <ISO date|none>",
  "  retire --purpose <purpose> --key-id <id> --by <name>",
  "  rewrap --workspace <id> [--run]",
  "  rewrap-status [--workspace <id>]",
];

const FLAGS: Record<Command, { value: string[]; bool: string[] }> = {
  diagnose: { value: [], bool: ["--json", "--no-db"] },
  codec: { value: ["--file"], bool: ["--verify", "--json"] },
  sync: { value: [], bool: [] },
  "retire-after": { value: ["--purpose", "--key-id", "--date"], bool: [] },
  retire: { value: ["--purpose", "--key-id", "--by"], bool: [] },
  rewrap: { value: ["--workspace"], bool: ["--run"] },
  "rewrap-status": { value: ["--workspace"], bool: [] },
};

function parse(command: Command, args: readonly string[]): { values: Map<string, string>; bools: Set<string> } | undefined {
  const spec = FLAGS[command];
  const values = new Map<string, string>();
  const bools = new Set<string>();
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (spec.bool.includes(arg) && !bools.has(arg)) { bools.add(arg); continue; }
    if (spec.value.includes(arg) && !values.has(arg)) {
      const value = args[++i];
      if (!value || (value.startsWith("--") && value !== "-")) return undefined;
      values.set(arg, value);
      continue;
    }
    return undefined;
  }
  return { values, bools };
}

async function openDb(env: Readonly<Record<string, string | undefined>>): Promise<PlatformDb> {
  const config = platformDbConfigFromEnv(env);
  if (config.kind !== "postgres" || !config.url) throw new Error("db");
  return openPlatformDb({ kind: "postgres", url: config.url, max: 1, migrate: false });
}

export async function keyCustodyMain(args: readonly string[], output: Out = (line) => process.stdout.write(`${line}\n`), error: Out = (line) => process.stderr.write(`${line}\n`), env: Readonly<Record<string, string | undefined>> = process.env): Promise<number> {
  const command = args[0] as Command | undefined;
  const usage = (): number => { for (const line of USAGE) error(line); return 2; };
  if (!command || !(COMMANDS as readonly string[]).includes(command)) return usage();
  const parsed = parse(command, args.slice(1));
  if (!parsed) return usage();
  const { values, bools } = parsed;
  let db: PlatformDb | undefined;
  const needDb = async (): Promise<PlatformDb> => { db ??= await openDb(env); return db; };
  try {
    if (command === "diagnose") {
      const ring = KeyRing.fromEnv(env);
      let stored: Awaited<ReturnType<typeof listKeys>> | undefined;
      if (!bools.has("--no-db")) {
        try { stored = await listKeys(await needDb()); }
        catch { error("Durable key records are unavailable (Postgres platform store not configured, or migration 39 not applied); ages and retirement dates are unknown."); }
      }
      const mtls = inspectTemporalMtls(env);
      const report = buildKeyReport(ring, stored, new Date(), mtls ? [mtls] : []);
      if (bools.has("--json")) output(JSON.stringify(report));
      else for (const line of renderKeyReport(report)) output(line);
      return reportExitCode(report);
    }

    if (command === "codec") {
      const file = values.get("--file");
      if (!file) return usage();
      let document: unknown;
      try { document = JSON.parse(file === "-" ? readFileSync(0, "utf8") : readFileSync(file, "utf8")); }
      catch { error("The history file could not be read as JSON."); return 1; }
      const ring = KeyRing.fromEnv(env, { purposes: ["enc:temporal-payload"] });
      const findings = inspectTemporalPayloads(ring, document);
      const summary = summarizePayloadFindings(findings);
      let verified: { ok: number; failed: number } | undefined;
      if (bools.has("--verify")) verified = await verifyPayloads(document, env);
      if (bools.has("--json")) output(JSON.stringify({ ...summary, ...(verified ? { verified } : {}) }));
      else {
        output(`Temporal payloads inspected: ${summary.total}`);
        for (const [status, n] of Object.entries(summary.byStatus)) if (n) output(`  ${status}: ${n}`);
        for (const [id, n] of Object.entries(summary.byKeyId)) output(`  key ${id}: ${n} payloads (${ring.descriptors("enc:temporal-payload").find((d) => d.keyId === id)?.role.replace("_", "-") ?? "not configured"})`);
        if (verified) output(`  decrypt check: ${verified.ok} ok, ${verified.failed} failed`);
      }
      return summary.byStatus.key_unavailable || summary.byStatus.invalid_envelope || (verified && verified.failed) ? 1 : 0;
    }

    if (command === "sync") {
      const n = await recordKeys(await needDb(), KeyRing.fromEnv(env).descriptors());
      output(JSON.stringify({ recorded: n }));
      return 0;
    }

    if (command === "retire-after") {
      const purpose = values.get("--purpose"), keyId = values.get("--key-id"), date = values.get("--date");
      if (!purpose || !isKeyPurpose(purpose) || !keyId || !date) return usage();
      const when = date === "none" ? null : date;
      if (when !== null && Number.isNaN(Date.parse(when))) return usage();
      const ok = await setRetireAfter(await needDb(), { purpose, keyId, retireAfter: when === null ? null : new Date(when).toISOString() });
      output(JSON.stringify({ updated: ok }));
      if (!ok) error("No such non-current key record. Run sync first; a current key cannot be given a retirement date.");
      return ok ? 0 : 1;
    }

    if (command === "retire") {
      const purpose = values.get("--purpose"), keyId = values.get("--key-id"), by = values.get("--by");
      if (!purpose || !isKeyPurpose(purpose) || !keyId || !by) return usage();
      const ok = await markRetired(await needDb(), { purpose, keyId, by });
      output(JSON.stringify({ retired: ok }));
      if (!ok) error("No such non-current, un-retired key record.");
      return ok ? 0 : 1;
    }

    if (command === "rewrap") {
      const workspaceId = values.get("--workspace");
      if (!workspaceId || !/^[A-Za-z0-9_-]{1,128}$/.test(workspaceId)) return usage();
      const ring = KeyRing.fromEnv(env, { purposes: ["enc:vault"] });
      const current = ring.descriptors("enc:vault").find((d) => d.role === "current");
      if (!current) { error("No current vault key is configured (ZENITH_SECRET_KEY)."); return 1; }
      const { job, created } = await enqueueRewrapJob(await needDb(), { workspaceId, targetKeyId: current.keyId, requestedBy: "key-custody-cli" });
      output(JSON.stringify({ created, job: { id: job.id, status: job.status, targetKeyId: job.targetKeyId } }));
      // Awaited here so the finally below closes the store only after the run; a bare return closed it mid-run (CONNECTION_ENDED, unhandled).
      if (bools.has("--run")) return await runQueuedRewrap(await needDb(), env, output, error);
      return 0;
    }

    // rewrap-status
    const workspaceId = values.get("--workspace");
    if (workspaceId !== undefined && !/^[A-Za-z0-9_-]{1,128}$/.test(workspaceId)) return usage();
    const jobs = await listRewrapJobs(await needDb(), { workspaceId });
    for (const job of jobs) output(JSON.stringify({ id: job.id, workspaceId: job.workspaceId, status: job.status, inspected: job.inspected, rewrapped: job.rewrapped, unchanged: job.unchanged, batches: job.batches, errorCode: job.errorCode, updatedAt: job.updatedAt, finishedAt: job.finishedAt }));
    if (!jobs.length) output("No re-wrap jobs.");
    return 0;
  } catch {
    // Database and filesystem errors can carry connection strings or paths; none is echoed.
    error("The key custody command failed. Check the platform store configuration (Postgres URL, schema migration 39) and your arguments.");
    return 1;
  } finally {
    if (db) await db.close().catch(() => undefined);
  }
}

/**
 * Work queued re-wrap jobs now, under the scheduler's own lease and run record (critical-job:key-rewrap). A pass is
 * skipped while the durable schedule is current, and another holder gets `busy`; both are reported, not retried.
 */
export async function runQueuedRewrap(db: PlatformDb, env: Readonly<Record<string, string | undefined>>, output: Out, error: Out, product?: () => Promise<Sql | undefined>): Promise<number> {
  for (let pass = 0; pass < 200; pass++) {
    const run = await runCriticalJob(db, "key-rewrap", "fallback", async () => {
      const value = await keyRewrapPass(db, { env, ...(product ? { product } : {}) });
      return { value, performed: true, counts: countsOf(value) };
    });
    if (run.status !== "ok") { error(run.status === "busy" ? "Another process holds the key-rewrap lease; try again shortly." : "The durable scheduler is current and is working the queue."); return 0; }
    const backlog = await rewrapBacklog(db);
    output(JSON.stringify({ pass: pass + 1, batches: run.value.batches, rewrapped: run.value.rewrapped, completed: run.value.completed, failed: run.value.failed, blocked: run.value.blocked, retry: run.value.retry, open: backlog.pending + backlog.running }));
    if (backlog.pending + backlog.running === 0) return run.value.failed + run.value.blocked > 0 ? 1 : 0;
    if (run.value.retry > 0) { error("A store error interrupted the run; the job stays queued and resumes from its cursor."); return 1; }
  }
  error("The re-wrap is still running after 200 passes; check rewrap-status.");
  return 1;
}

/** Decrypt every payload through the configured codec and report only counts. */
async function verifyPayloads(document: unknown, env: Readonly<Record<string, string | undefined>>): Promise<{ ok: number; failed: number }> {
  const { temporalDataConverterFromEnv } = await import("@/lib/workflows/codec");
  const codec = temporalDataConverterFromEnv(env).payloadCodecs[0];
  let ok = 0, failed = 0;
  const payloads: { metadata: Record<string, Uint8Array>; data: Uint8Array }[] = [];
  const visit = (node: unknown, depth: number): void => {
    if (depth > 24 || node === null || typeof node !== "object") return;
    if (Array.isArray(node)) { for (const item of node) visit(item, depth + 1); return; }
    const record = node as { metadata?: unknown; data?: unknown };
    if (record.metadata && typeof record.metadata === "object" && typeof record.data === "string") {
      const metadata: Record<string, Uint8Array> = {};
      for (const [k, v] of Object.entries(record.metadata as Record<string, unknown>)) if (typeof v === "string") metadata[k] = Buffer.from(v, "base64");
      payloads.push({ metadata, data: Buffer.from(record.data, "base64") });
      return;
    }
    for (const value of Object.values(record)) visit(value, depth + 1);
  };
  visit(document, 0);
  for (const payload of payloads) {
    try { if (!codec) { ok++; continue; } await codec.decode([payload]); ok++; }
    catch { failed++; }
  }
  return { ok, failed };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void keyCustodyMain(process.argv.slice(2)).then((code) => { process.exitCode = code; });
}
