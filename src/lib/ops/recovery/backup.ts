/**
 * Take a backup that a clean host can restore from (PROD-OPS-04).
 *
 * What is captured, and how each store is reached, is spelled out in the manifest (`manifest.ts`). The database
 * part is one `pg_dump` per database taken under ONE exported snapshot together with the row counts and the
 * schema version and recovery epoch recorded in the manifest, so the dump and the facts the restore later checks
 * describe the same instant. That instant (`platform.snapshotAt`) is what RPO is measured from.
 *
 * Nothing secret is written: no connection string, no key material (key facts are purpose, id and role), no vault
 * value. Sealed columns stay sealed in the dump and are readable again only with the same keys (the restore checks
 * the target host has them before it restores anything).
 */
import { copyFile, mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { PlatformDb } from "@/lib/controlplane/types";
import {
  BACKUP_MANIFEST_FORMAT, MANIFEST_FILE, describeFile, isSafeRelativePath, sealManifest, sha256File,
  type BackupManifest, type ComponentId, type FactValue, type KeyRequirement, type ManifestComponent, type ManifestFile,
} from "./manifest";
import { RecoveryToolError, mustRun, pgArgs, scrub, temporalConnectionArgs, type CommandRunner, type TemporalCliTls, type Tools } from "./process";

/** Tables whose row counts are recorded and re-checked by the restore. Only tables that exist are counted. */
export const COUNTED_TABLES = [
  "operations", "approvals", "capability_grants", "leases", "durable_intents", "workflow_start_intents", "external_effects",
  "plan_artifacts", "plan_artifact_uses", "runner_jobs", "machine_requests", "key_custody_keys", "recovery_epochs", "recovery_items",
] as const;

export type ProductSource =
  | { kind: "postgres" }
  | { kind: "file"; dir: string; /** the operator attests the process is stopped; the file store is single-writer */ quiesced: boolean }
  | { kind: "not_applicable"; note: string };

export type HostedSource =
  | { kind: "postgres" }
  | { kind: "bundle"; file: string }
  | { kind: "not_applicable"; note: string }
  | { kind: "skipped"; note: string };

export interface BackupOptions {
  outDir: string;
  /** direct (not pooled) connection string of the platform database; never recorded */
  platformUrl: string;
  product: ProductSource;
  hosted: HostedSource;
  artifacts?: { dir: string; includeFiles: boolean };
  temporal?: { address?: string; tls?: TemporalCliTls; namespace: string; dbFile?: string; required: boolean };
  keys: readonly KeyRequirement[];
}

export interface BackupDeps {
  db: PlatformDb;
  run: CommandRunner;
  tools: Tools;
  now?: () => Date;
  newId?: () => string;
}

const q = (s: string): string => `"${s.replace(/"/g, '""')}"`;
const SCHEMA = /^[a-z_][a-z0-9_]{0,62}$/;

async function emptyDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true });
  if ((await readdir(dir)).length > 0) throw new RecoveryToolError("refused", "The backup directory is not empty; a backup never overwrites another.");
}

async function walk(root: string, dir = ""): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(path.join(root, dir), { withFileTypes: true })) {
    const rel = dir ? `${dir}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...(await walk(root, rel)));
    else if (entry.isFile()) out.push(rel);
  }
  return out.sort();
}

async function copyInto(outDir: string, source: string, relative: string): Promise<ManifestFile> {
  if (!isSafeRelativePath(relative)) throw new RecoveryToolError("invalid_input", "That file cannot be placed in a backup under a safe name.");
  await mkdir(path.dirname(path.join(outDir, relative)), { recursive: true });
  await copyFile(source, path.join(outDir, relative));
  return describeFile(outDir, relative);
}

/** The product file store: an allowlist, never the whole data directory (it also holds a live hosted authority and PGlite files). */
const PRODUCT_FILES = ["state.json", "events.jsonl", "audit.jsonl", "secrets.json"];

export async function captureBackup(deps: BackupDeps, options: BackupOptions): Promise<BackupManifest> {
  const now = deps.now ?? (() => new Date());
  const startedAt = now();
  await emptyDir(options.outDir);
  const conn = pgArgs(options.platformUrl);
  if (deps.db.kind !== "postgres") throw new RecoveryToolError("refused", "A backup needs the real PostgreSQL platform database; an embedded PGlite store is dumped by copying its stopped data directory, which this command does not attempt.");

  // Which schemas exist decides which stores live in this database.
  const present = new Set((await deps.db.query<{ schema_name: string }>("select schema_name from information_schema.schemata")).map((r) => r.schema_name));
  const schemas = ["platform", ...(present.has("agent") ? ["agent"] : []), ...(options.product.kind === "postgres" ? ["public"] : []), ...(options.hosted.kind === "postgres" && present.has("hosted") ? ["hosted"] : [])];
  for (const s of schemas) if (!SCHEMA.test(s)) throw new RecoveryToolError("invalid_input", "Unexpected schema name.");
  if (options.hosted.kind === "postgres" && !present.has("hosted")) throw new RecoveryToolError("refused", "The hosted store is configured as postgres but the database has no hosted schema.");

  const dumpFile = "database.dump";
  const facts: Record<string, FactValue> = {};
  let platformFacts!: BackupManifest["platform"];

  // One repeatable-read transaction: the exported snapshot, the facts and the dump all describe the same instant.
  await deps.db.tx(async (tx) => {
    await tx.query("set transaction isolation level repeatable read");
    const snapshot = (await tx.query<{ id: string; at: unknown }>("select pg_export_snapshot() as id, clock_timestamp() as at"))[0];
    if (!snapshot?.id || !/^[0-9A-F-]{3,64}$/i.test(snapshot.id)) throw new RecoveryToolError("tool_failed", "The database did not export a snapshot.");
    const version = (await tx.query<{ v: string }>("select current_setting('server_version') as v"))[0]?.v ?? "unknown";
    const schemaVersion = Number((await tx.query<{ v: number | string | null }>("select max(version) as v from platform.schema_migrations"))[0]?.v ?? 0);
    const epochRow = await tx.query<{ e: number | string }>("select case when to_regproc('platform.current_recovery_epoch') is null then 0 else platform.current_recovery_epoch() end as e");
    for (const table of COUNTED_TABLES) {
      const exists = (await tx.query<{ ok: boolean }>("select to_regclass($1) is not null as ok", [`platform.${table}`]))[0]?.ok;
      if (exists) facts[`rows.${table}`] = Number((await tx.query<{ n: number | string }>(`select count(*)::bigint as n from platform.${q(table)}`))[0]?.n ?? 0);
    }
    platformFacts = {
      schemaVersion, recoveryEpoch: Number(epochRow[0]?.e ?? 0), serverVersion: version, snapshotAt: new Date(snapshot.at as string).toISOString(),
    };
    await mustRun(deps.run, "pg_dump", deps.tools.pgDump, [
      ...conn.args, "--format=custom", "--no-owner", `--snapshot=${snapshot.id}`, "--file", path.join(options.outDir, dumpFile),
      ...schemas.flatMap((s) => ["--schema", s]),
    ], { env: conn.env });
  });

  const components: ManifestComponent[] = [];
  const dump = await describeFile(options.outDir, dumpFile);
  const dbFacts = { ...facts, schemas: schemas.join(","), "schemaVersion": platformFacts.schemaVersion, recoveryEpoch: platformFacts.recoveryEpoch };
  components.push({ id: "platform", title: "Platform control store (operations, approvals, grants, leases, intents, effects, plan artifacts, source snapshots, key records)", status: "captured", method: "pg_dump", note: "", files: [dump], facts: dbFacts });

  const covered = (id: ComponentId, title: string, by: ComponentId, note: string, f: Record<string, FactValue> = {}): void => {
    components.push({ id, title, status: "covered", method: "none", note, coveredBy: by, files: [], facts: f });
  };
  covered("source", "Source stores (GitHub bindings, deliveries, approved source snapshots)", "platform", "These tables live in the platform schema and are in database.dump.");
  covered("plan_artifacts", "Plan artifacts (sealed ciphertext, manifests, uses)", "platform", "Sealed plan bytes live in platform.plan_artifacts. Local worker plan directories are transient and are re-planned, never restored.", {
    rows: typeof facts["rows.plan_artifacts"] === "number" ? (facts["rows.plan_artifacts"] as number) : 0,
  });

  if (present.has("agent")) covered("agent", "Agent access store (credentials, links, operations, uploads)", "platform", "The agent schema is in database.dump (same database, same snapshot).", { schema: "agent" });
  else components.push({ id: "agent", title: "Agent access store", status: "not_applicable", method: "none", note: "The database has no agent schema.", files: [], facts: {} });

  // Product store.
  if (options.product.kind === "postgres") covered("product", "Product store (workspaces, projects, environments, audit)", "platform", "The public schema is in database.dump (same database, same snapshot).", { schema: "public" });
  else if (options.product.kind === "file") {
    const files: ManifestFile[] = [];
    for (const name of PRODUCT_FILES) {
      const source = path.join(options.product.dir, name);
      if (await exists(source)) files.push(await copyInto(options.outDir, source, `product/${name}`));
    }
    const revisions = path.join(options.product.dir, "revisions");
    if (await exists(revisions)) for (const rel of await walk(revisions)) files.push(await copyInto(options.outDir, path.join(revisions, rel), `product/revisions/${rel}`));
    if (files.length === 0) throw new RecoveryToolError("refused", "The product data directory has no state to back up.");
    components.push({ id: "product", title: "Product store (file store)", status: "captured", method: "file_tree", note: options.product.quiesced ? "" : "Taken without the operator attesting the process was stopped; the file store is single-writer, so a live copy may be torn.", files, facts: { quiesced: options.product.quiesced, files: files.length } });
  } else components.push({ id: "product", title: "Product store", status: "not_applicable", method: "none", note: options.product.note, files: [], facts: {} });

  // Hosted store.
  if (options.hosted.kind === "postgres") covered("hosted", "Hosted-apps store", "platform", "The hosted schema is in database.dump (same database, same snapshot).", { schema: "hosted" });
  else if (options.hosted.kind === "bundle") {
    const file = await copyInto(options.outDir, options.hosted.file, "hosted/hosted-backup.zbk");
    components.push({ id: "hosted", title: "Hosted-apps store (sealed ZBK1 bundle from hosted:backup)", status: "captured", method: "hosted_bundle", note: "Sealed under ZENITH_BACKUP_KEY; restore it with hosted:restore, which reconciles revocations before anything reopens.", files: [file], facts: { sealed: true } });
  } else components.push({ id: "hosted", title: "Hosted-apps store", status: options.hosted.kind, method: "none", note: options.hosted.note, files: [], facts: {} });

  // Artifacts (content addressed): an index always, bytes on request.
  if (options.artifacts) {
    const root = options.artifacts.dir;
    const listing: { path: string; bytes: number; sha256: string }[] = [];
    if (await exists(root)) for (const rel of await walk(root)) {
      const { sha256, bytes } = await sha256File(path.join(root, rel));
      listing.push({ path: rel, bytes, sha256 });
    }
    await writeFile(path.join(options.outDir, "artifacts-index.json"), JSON.stringify({ files: listing }, null, 2));
    const files: ManifestFile[] = [await describeFile(options.outDir, "artifacts-index.json")];
    if (options.artifacts.includeFiles) for (const f of listing) if (isSafeRelativePath(`artifacts/${f.path}`)) files.push(await copyInto(options.outDir, path.join(root, f.path), `artifacts/${f.path}`));
    components.push({ id: "artifacts", title: "Hosted artifact store (content-addressed)", status: "captured", method: "artifact_index", note: options.artifacts.includeFiles ? "" : "Index only: artifacts are content-addressed and rebuildable from source; restore re-verifies the target store against this index.", files, facts: { files: listing.length, bytes: listing.reduce((n, f) => n + f.bytes, 0), copied: options.artifacts.includeFiles } });
  } else components.push({ id: "artifacts", title: "Hosted artifact store", status: "not_applicable", method: "none", note: "No artifact directory was named; hosted artifacts are not in use or live in object storage.", files: [], facts: {} });

  // Temporal: evidence of what was running, and (dev server only) the database file.
  components.push(await captureTemporal(deps, options));

  // Customer OpenTofu state is the customer's, in the customer's bucket; Zenith holds only pointers.
  components.push({ id: "customer_state", title: "Customer OpenTofu state and cloud resources", status: "referenced", method: "none", note: "Held in the customer's own storage (S3, GCS, Azure Blob, OCI). Zenith never copies it. A restore needs the operator to confirm the backend's versioning is intact (--confirm-customer-state).", files: [], facts: {} });

  // Keys: ids and roles only.
  components.push({ id: "keys", title: "Key registry (purpose-bound key ids; no key material)", status: "captured", method: "key_registry", note: "Material lives in your secret manager. The restore refuses to proceed when the target host lacks a listed key id.", files: [], facts: { keys: options.keys.length } });

  const finishedAt = now();
  const manifest = sealManifest({
    format: BACKUP_MANIFEST_FORMAT,
    backupId: (deps.newId ?? randomUUID)(),
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    platform: platformFacts,
    keys: [...options.keys].sort((a, b) => (a.purpose + a.keyId < b.purpose + b.keyId ? -1 : 1)),
    components,
  });
  await writeFile(path.join(options.outDir, MANIFEST_FILE), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
  return manifest;
}

async function exists(file: string): Promise<boolean> {
  try { await stat(file); return true; } catch { return false; }
}

async function captureTemporal(deps: BackupDeps, options: BackupOptions): Promise<ManifestComponent> {
  const t = options.temporal;
  const base = { id: "temporal" as const, title: "Temporal namespace (open workflows, namespace description, dev database file)", method: "temporal_cli" };
  if (!t) return { ...base, status: "not_applicable", method: "none", note: "No Temporal namespace was named for this backup.", files: [], facts: {} };
  const address = temporalConnectionArgs(t.address, t.tls);
  const ns = ["--namespace", t.namespace];
  const files: ManifestFile[] = [];
  const facts: Record<string, FactValue> = { namespace: t.namespace };
  try {
    const list = await mustRun(deps.run, "temporal workflow list", deps.tools.temporal, ["workflow", "list", ...address, ...ns, "--query", 'ExecutionStatus="Running"', "--output", "json"]);
    const describe = await mustRun(deps.run, "temporal namespace describe", deps.tools.temporal, ["operator", "namespace", "describe", ...address, "--namespace", t.namespace, "--output", "json"]);
    await mkdir(path.join(options.outDir, "temporal"), { recursive: true });
    await writeFile(path.join(options.outDir, "temporal/open-workflows.json"), list.stdout || "[]");
    await writeFile(path.join(options.outDir, "temporal/namespace.json"), describe.stdout || "{}");
    files.push(await describeFile(options.outDir, "temporal/open-workflows.json"), await describeFile(options.outDir, "temporal/namespace.json"));
    try { const parsed = JSON.parse(list.stdout || "[]") as unknown; facts.openWorkflows = Array.isArray(parsed) ? parsed.length : null; } catch { facts.openWorkflows = null; }
  } catch (error) {
    if (t.required) throw error;
    return { ...base, status: "skipped", note: `Temporal could not be inventoried (${scrub(error instanceof Error ? error.message : "unknown")}). A restore refuses this gap unless the operator accepts it by name.`, files: [], facts };
  }
  if (t.dbFile) {
    files.push(await copyInto(options.outDir, t.dbFile, "temporal/dev-server.db"));
    facts.devDatabaseCopied = true;
  }
  return { ...base, status: "captured", note: t.dbFile ? "The dev-server database file was copied; it is consistent only if the dev server was stopped." : "Inventory only: history lives in Temporal (Cloud retention or the cluster's database). Nothing permanent exists only there; the ledger holds every operation.", files, facts };
}

export async function readManifestFile(dir: string): Promise<string> {
  return readFile(path.join(dir, MANIFEST_FILE), "utf8");
}
