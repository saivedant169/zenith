/**
 * Backup, clean-host restore and operator continuation (PROD-OPS-04).
 *
 *   backup   --out DIR [--product-dir DIR [--quiesced] | --product-store postgres | --product-store none:<why>]
 *            [--hosted-bundle FILE | --hosted-store postgres | --hosted none:<why> | --hosted skip:<why>]
 *            [--artifact-dir DIR [--include-artifact-files]]
 *            [--temporal-namespace NS [--temporal-address HOST:PORT] [--temporal-db-file FILE] [--require-temporal]]
 *   verify   --backup DIR
 *   restore  --backup DIR --target-url-env VAR --run-id ID --actor NAME --reason TEXT --report FILE
 *            --confirm-customer-state [--accept-skipped ID]... [--observed-epoch N] [--incident-at ISO]
 *            [--product-data-dir DIR] [--hosted-bundle-out FILE] [--artifact-dir DIR]
 *            [--temporal-namespace NS [--temporal-address HOST:PORT] --terminate-temporal] [--no-privileges]
 *   status   [--workspace ID]
 *   continue list   --workspace ID [--state pending|resumed|abandoned|kept_uncertain]
 *   continue resume|abandon|keep --workspace ID --item ID --binding DIGEST --actor NAME --reason TEXT
 *
 * Database URLs come from the environment (backup: ZENITH_PLATFORM_DB_URL or SUPABASE_DB_URL, a DIRECT connection;
 * restore: the variable NAMED by --target-url-env) and are never accepted on the command line, printed, logged or
 * recorded. Output is ids, counts, digests and step results. Exit 0 ok, 1 refused or failed, 2 usage.
 * `continue ... resume|abandon|keep` is the operator's break-glass path with database credentials; the same
 * decisions are available to a signed-in admin in the browser (POST /api/platform/v1/recovery/items/:id/decide).
 */
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { openPlatformDb, platformDbConfigFromEnv } from "@/lib/controlplane/db";
import { decideItem, getRecoveryItem, listRecoveryItems, recoveryStatus, type RecoveryItemState } from "@/lib/controlplane/recovery";
import type { PlatformDb } from "@/lib/controlplane/types";
import { KeyRing } from "@/lib/keycustody/registry";
import { captureBackup, type HostedSource, type ProductSource } from "@/lib/ops/recovery/backup";
import { COMPONENT_IDS, verifyBackupDirectory, type ComponentId, type KeyRequirement } from "@/lib/ops/recovery/manifest";
import { RecoveryToolError, execRunner, temporalTlsFromEnv, toolsFromEnv } from "@/lib/ops/recovery/process";

/** The authenticated Temporal client settings the worker uses, when configured. */
const temporalTls = (env: Readonly<Record<string, string | undefined>>) => { const tls = temporalTlsFromEnv(env); return tls ? { tls } : {}; };
import { measureContinuation } from "@/lib/ops/recovery/report";
import { runRestore } from "@/lib/ops/recovery/restore";

type Out = (line: string) => void;
type Env = Readonly<Record<string, string | undefined>>;

const USAGE = [
  "Usage: npx tsx --env-file-if-exists=.env.local scripts/ops/recovery.ts <command> [options]",
  "  backup   --out DIR [--product-dir DIR [--quiesced] | --product-store postgres | --product-store none:<why>]",
  "           [--hosted-bundle FILE | --hosted-store postgres | --hosted none:<why> | --hosted skip:<why>]",
  "           [--artifact-dir DIR [--include-artifact-files]] [--temporal-namespace NS [--temporal-address A] [--temporal-db-file F] [--require-temporal]]",
  "  verify   --backup DIR",
  "  restore  --backup DIR --target-url-env VAR --run-id ID --actor NAME --reason TEXT --report FILE --confirm-customer-state",
  "           [--accept-skipped ID]... [--observed-epoch N] [--incident-at ISO] [--product-data-dir DIR] [--hosted-bundle-out FILE]",
  "           [--artifact-dir DIR] [--temporal-namespace NS [--temporal-address A] --terminate-temporal] [--no-privileges]",
  "  health --report FILE --readiness-url URL --token-file FILE --target-url-env VAR --actor NAME [--timeout-seconds N]",
  "  status   [--workspace ID]",
  "  continue list   --workspace ID [--state pending|resumed|abandoned|kept_uncertain]",
  "  continue resume|abandon|keep --workspace ID --item ID --binding DIGEST --actor NAME --reason TEXT",
];

interface Parsed { values: Map<string, string[]>; bools: Set<string> }

function parse(args: readonly string[], valueFlags: readonly string[], boolFlags: readonly string[], repeatable: readonly string[] = []): Parsed | undefined {
  const values = new Map<string, string[]>();
  const bools = new Set<string>();
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (boolFlags.includes(arg)) { bools.add(arg); continue; }
    if (valueFlags.includes(arg)) {
      const value = args[++i];
      if (value === undefined || value.startsWith("--")) return undefined;
      const list = values.get(arg) ?? [];
      if (list.length > 0 && !repeatable.includes(arg)) return undefined;
      list.push(value);
      values.set(arg, list);
      continue;
    }
    return undefined;
  }
  return { values, bools };
}
const one = (p: Parsed, name: string): string | undefined => p.values.get(name)?.[0];

function keyRequirements(env: Env): KeyRequirement[] {
  return KeyRing.fromEnv(env).descriptors().map((d) => ({ purpose: d.purpose, keyId: d.keyId, role: d.role }));
}

function reasoned(value: string, prefix: string): string | undefined {
  return value.startsWith(`${prefix}:`) && value.length > prefix.length + 1 ? value.slice(prefix.length + 1) : undefined;
}

async function openCurrentDb(env: Env, migrate = false): Promise<PlatformDb> {
  const config = platformDbConfigFromEnv(env);
  if (config.kind !== "postgres" || !config.url) throw new RecoveryToolError("invalid_input", "This command needs the real PostgreSQL platform database (set ZENITH_PLATFORM_DB_URL or SUPABASE_DB_URL).");
  return openPlatformDb({ kind: "postgres", url: config.url, max: 2, migrate });
}

export async function recoveryMain(
  args: readonly string[],
  output: Out = (line) => process.stdout.write(`${line}\n`),
  error: Out = (line) => process.stderr.write(`${line}\n`),
  env: Env = process.env,
): Promise<number> {
  const usage = (): number => { for (const line of USAGE) error(line); return 2; };
  const command = args[0];
  try {
    if (command === "verify") {
      const p = parse(args.slice(1), ["--backup"], []);
      const dir = p && one(p, "--backup");
      if (!dir) return usage();
      const result = await verifyBackupDirectory(dir);
      if (result.manifest) output(`Backup ${result.manifest.backupId}: ${result.filesChecked} file(s) checked, manifest digest ${result.manifest.digest}.`);
      for (const problem of result.problems) error(`PROBLEM ${problem.code}${problem.component ? ` [${problem.component}]` : ""}${problem.file ? ` ${problem.file}` : ""}: ${problem.detail}`);
      output(result.ok ? "Verified: every listed file matches the manifest." : "NOT verified.");
      return result.ok ? 0 : 1;
    }

    if (command === "backup") {
      const p = parse(args.slice(1), ["--out", "--product-dir", "--product-store", "--hosted-bundle", "--hosted-store", "--hosted", "--artifact-dir", "--temporal-namespace", "--temporal-address", "--temporal-db-file"], ["--quiesced", "--include-artifact-files", "--require-temporal"]);
      const out = p && one(p, "--out");
      if (!p || !out) return usage();
      const config = platformDbConfigFromEnv(env);
      if (config.kind !== "postgres" || !config.url) throw new RecoveryToolError("invalid_input", "A backup needs the real PostgreSQL platform database (a DIRECT connection in ZENITH_PLATFORM_DB_URL or SUPABASE_DB_URL).");
      let product: ProductSource;
      const productStore = one(p, "--product-store");
      if (one(p, "--product-dir")) product = { kind: "file", dir: path.resolve(one(p, "--product-dir")!), quiesced: p.bools.has("--quiesced") };
      else if (productStore === "postgres") product = { kind: "postgres" };
      else if (productStore && reasoned(productStore, "none")) product = { kind: "not_applicable", note: reasoned(productStore, "none")! };
      else throw new RecoveryToolError("invalid_input", "Name the product store: --product-dir DIR, --product-store postgres, or --product-store none:<why>.");
      let hosted: HostedSource;
      const hostedFlag = one(p, "--hosted");
      if (one(p, "--hosted-bundle")) hosted = { kind: "bundle", file: path.resolve(one(p, "--hosted-bundle")!) };
      else if (one(p, "--hosted-store") === "postgres") hosted = { kind: "postgres" };
      else if (hostedFlag && reasoned(hostedFlag, "none")) hosted = { kind: "not_applicable", note: reasoned(hostedFlag, "none")! };
      else if (hostedFlag && reasoned(hostedFlag, "skip")) hosted = { kind: "skipped", note: reasoned(hostedFlag, "skip")! };
      else throw new RecoveryToolError("invalid_input", "Name the hosted store: --hosted-bundle FILE, --hosted-store postgres, --hosted none:<why>, or --hosted skip:<why>.");
      const namespace = one(p, "--temporal-namespace");
      const db = await openCurrentDb(env);
      try {
        const manifest = await captureBackup({ db, run: execRunner, tools: toolsFromEnv(env) }, {
          outDir: path.resolve(out), platformUrl: config.url, product, hosted,
          ...(one(p, "--artifact-dir") ? { artifacts: { dir: path.resolve(one(p, "--artifact-dir")!), includeFiles: p.bools.has("--include-artifact-files") } } : {}),
          ...(namespace ? { temporal: { namespace, ...(one(p, "--temporal-address") ? { address: one(p, "--temporal-address") } : {}), ...temporalTls(env), ...(one(p, "--temporal-db-file") ? { dbFile: path.resolve(one(p, "--temporal-db-file")!) } : {}), required: p.bools.has("--require-temporal") } } : {}),
          keys: keyRequirements(env),
        });
        output(`Backup ${manifest.backupId} written to ${path.resolve(out)}; snapshot ${manifest.platform.snapshotAt}, schema ${manifest.platform.schemaVersion}, epoch ${manifest.platform.recoveryEpoch}.`);
        for (const c of manifest.components) output(`  ${c.id.padEnd(15)} ${c.status}${c.note ? ` - ${c.note}` : ""}`);
        output(`Manifest digest ${manifest.digest} (record it off-host: a restore compares against it).`);
        return manifest.components.some((c) => c.status === "skipped") ? 1 : 0;
      } finally { await db.close(); }
    }

    if (command === "health") {
      const p = parse(args.slice(1), ["--report", "--readiness-url", "--token-file", "--timeout-seconds", "--target-url-env", "--actor"], []);
      if (!p || ["--report", "--readiness-url", "--token-file", "--target-url-env", "--actor"].some(f => !one(p, f))) return usage();
      const targetUrl = env[one(p, "--target-url-env")!]?.trim();
      if (!targetUrl) throw new RecoveryToolError("invalid_input", "The target database URL variable is unset.");
      const { completeRestoreHealth } = await import("@/lib/ops/recovery/health");
      const { registerRecoveryMeasurementSink } = await import("@/lib/ops/recovery/report");
      const { restoreSloSink } = await import("@/lib/slo/restore-sink");
      const { reportRestoreCompletion } = await import("@/lib/slo/recovery");
      const unregister = registerRecoveryMeasurementSink(restoreSloSink(async m => {
        const db = await openPlatformDb({ kind: "postgres", url: targetUrl, max: 2, migrate: false });
        try { return await reportRestoreCompletion(db, m); } finally { await db.close(); }
      }, one(p, "--actor")!));
      const report = await completeRestoreHealth({ reportFile: path.resolve(one(p, "--report")!), readinessUrl: one(p, "--readiness-url")!, tokenFile: path.resolve(one(p, "--token-file")!),
        ...(one(p, "--timeout-seconds") ? { timeoutSeconds: Number(one(p, "--timeout-seconds")) } : {}) }).finally(unregister);
      output(`First healthy application readiness: ${report.measurement!.applicationHealthyAt}; RTO ${report.measurement!.rtoSeconds ?? "not measured (incident time missing)"}.`);
      return 0;
    }

    if (command === "restore") {
      const p = parse(args.slice(1), ["--backup", "--target-url-env", "--run-id", "--actor", "--reason", "--report", "--accept-skipped", "--observed-epoch", "--incident-at", "--product-data-dir", "--hosted-bundle-out", "--artifact-dir", "--temporal-namespace", "--temporal-address"],
        ["--confirm-customer-state", "--terminate-temporal", "--no-privileges"], ["--accept-skipped"]);
      const required = p && ["--backup", "--target-url-env", "--run-id", "--actor", "--reason", "--report"].map((f) => one(p, f));
      if (!p || !required || required.some((v) => !v)) return usage();
      const [backup, urlEnv, runId, actor, reason, report] = required as string[];
      const targetUrl = env[urlEnv]?.trim();
      if (!targetUrl) throw new RecoveryToolError("invalid_input", `${urlEnv} is not set; it must hold the DIRECT URL of the empty target database.`);
      const accept = (p.values.get("--accept-skipped") ?? []).map((id) => {
        if (!(COMPONENT_IDS as readonly string[]).includes(id)) throw new RecoveryToolError("invalid_input", `Unknown component ${id}.`);
        return id as ComponentId;
      });
      const observed = one(p, "--observed-epoch");
      if (observed !== undefined && !/^\d{1,4}$/.test(observed)) throw new RecoveryToolError("invalid_input", "--observed-epoch must be a whole number.");
      const namespace = one(p, "--temporal-namespace");
      if (p.bools.has("--terminate-temporal") && !namespace) throw new RecoveryToolError("invalid_input", "--terminate-temporal needs --temporal-namespace.");
      await mkdir(path.dirname(path.resolve(report)), { recursive: true });
      const { registerRecoveryMeasurementSink } = await import("@/lib/ops/recovery/report");
      const { restoreSloSink } = await import("@/lib/slo/restore-sink");
      const { reportRestoreCompletion } = await import("@/lib/slo/recovery");
      const unregister = registerRecoveryMeasurementSink(restoreSloSink(async measurement => {
        const sql = await openPlatformDb({ kind: "postgres", url: targetUrl, max: 2, migrate: false });
        try { return await reportRestoreCompletion(sql, measurement); } finally { await sql.close(); }
      }, actor));
      const result = await runRestore({
        run: execRunner, tools: toolsFromEnv(env), env,
        openTarget: (url, o) => openPlatformDb({ kind: "postgres", url, max: 2, migrate: o.migrate }),
      }, {
        backupDir: path.resolve(backup), targetUrl, runId, actor, reason, reportFile: path.resolve(report),
        ...(observed !== undefined ? { observedEpoch: Number(observed) } : {}),
        ...(one(p, "--incident-at") ? { incidentAt: one(p, "--incident-at") } : {}),
        noPrivileges: p.bools.has("--no-privileges"), acceptSkipped: accept, confirmCustomerState: p.bools.has("--confirm-customer-state"),
        keysAvailable: keyRequirements(env),
        ...(one(p, "--product-data-dir") ? { productDataDir: path.resolve(one(p, "--product-data-dir")!) } : {}),
        ...(one(p, "--hosted-bundle-out") ? { hostedBundleOut: path.resolve(one(p, "--hosted-bundle-out")!) } : {}),
        ...(one(p, "--artifact-dir") ? { artifactDir: path.resolve(one(p, "--artifact-dir")!) } : {}),
        ...(namespace ? { temporal: { namespace, ...(one(p, "--temporal-address") ? { address: one(p, "--temporal-address") } : {}), ...temporalTls(env), terminate: p.bools.has("--terminate-temporal") } } : {}),
      }).finally(unregister);
      for (const s of result.steps) output(`${s.status.toUpperCase().padEnd(10)} ${s.id.padEnd(10)} ${s.detail}`);
      if (result.measurement) output(`RPO ${result.measurement.rpoSeconds ?? `<= ${result.measurement.backupAgeAtRestoreStartSeconds}`}s, restore ${result.measurement.restoreDurationSeconds}s, verdict ${result.measurement.verdict} (targets: see the SLO definitions).`);
      for (const line of result.needsPerson) output(`NEEDS A PERSON: ${line}`);
      output(`Report written to ${path.resolve(report)}.`);
      return result.ok ? 0 : 1;
    }

    if (command === "status") {
      const p = parse(args.slice(1), ["--workspace"], []);
      if (!p) return usage();
      const db = await openCurrentDb(env);
      try {
        const workspace = one(p, "--workspace");
        const epoch = (await db.query<{ e: number | string }>("select platform.current_recovery_epoch() as e"))[0]?.e;
        output(`Recovery epoch ${Number(epoch ?? 0)}.`);
        const m = await measureContinuation(db, Number(epoch ?? 0));
        output(`Epoch ${m.epoch}: ${m.opened} item(s) opened, ${m.decided} decided, ${m.pending} pending${m.durationSeconds !== null ? `, continuation took ${m.durationSeconds}s` : ""}.`);
        if (workspace) { const s = await recoveryStatus(db, workspace); output(`Workspace ${workspace}: ${s.pending} pending, ${s.decided} decided.`); }
        return m.pending > 0 ? 1 : 0;
      } finally { await db.close(); }
    }

    if (command === "continue") {
      const sub = args[1];
      if (sub === "list") {
        const p = parse(args.slice(2), ["--workspace", "--state"], []);
        const workspace = p && one(p, "--workspace");
        const state = p && one(p, "--state");
        if (!p || !workspace || (state !== undefined && !["pending", "resumed", "abandoned", "kept_uncertain"].includes(state))) return usage();
        const db = await openCurrentDb(env);
        try {
          const items = await listRecoveryItems(db, workspace, { state: state as RecoveryItemState | undefined });
          for (const i of items) output(`${i.id} ${i.state.padEnd(14)} ${i.kind.padEnd(9)} ${i.ref} (was ${i.priorState}; allowed ${i.allowed.join("/")}) binding ${i.bindingDigest}${i.resumeBlockedBy.length ? ` | resume blocked: ${i.resumeBlockedBy.join("; ")}` : ""}`);
          output(`${items.length} item(s).`);
          return 0;
        } finally { await db.close(); }
      }
      const decision = sub === "resume" ? "resume" : sub === "abandon" ? "abandon" : sub === "keep" ? "keep_uncertain" : undefined;
      if (!decision) return usage();
      const p = parse(args.slice(2), ["--workspace", "--item", "--binding", "--actor", "--reason"], []);
      const need = p && ["--workspace", "--item", "--binding", "--actor", "--reason"].map((f) => one(p, f));
      if (!p || !need || need.some((v) => !v)) return usage();
      const [workspaceId, itemId, bindingDigest, actor, reason] = need as string[];
      const db = await openCurrentDb(env);
      try {
        if (!(await getRecoveryItem(db, workspaceId, itemId))) throw new RecoveryToolError("refused", "No such recovery item in that workspace.");
        const item = await decideItem(db, { workspaceId, itemId, decision, actor: `operator:${actor}`, reason, bindingDigest });
        output(`${item.id} is now ${item.state}.`);
        return 0;
      } finally { await db.close(); }
    }
    return usage();
  } catch (e) {
    error(e instanceof RecoveryToolError || (e instanceof Error && "code" in e) ? (e as Error).message : "The command failed.");
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  recoveryMain(process.argv.slice(2)).then((code) => process.exit(code), () => process.exit(1));
}
