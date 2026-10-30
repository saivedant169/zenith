/**
 * PROD-OPS-05: the durable `key-rewrap` job and the key custody store, on real PGlite SQL (the platform schema is
 * migrated, including migration 39; the product vault tables come from the shipped supabase migration). Contract
 * level: no live Postgres claim. Keys and values are generated at runtime.
 *
 * Needs migration 39 registered: run after the assembler has merged migrations 30-41 or on this branch alone
 * (the migrator does not require contiguous versions; only tests/controlplane/migrations.test.ts does).
 */
import { randomBytes, randomUUID } from "node:crypto";
import fs from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openPlatformDb, type PlatformDbHandle } from "@/lib/controlplane/db";
import { MAINTENANCE_JOBS, CRITICAL_JOBS, runCriticalJob } from "@/lib/platform/critical-jobs";
import { keyRewrapPass } from "@/lib/keycustody/rewrap-job";
import { advanceRewrapJob, claimRewrapJob, enqueueRewrapJob, finishRewrapJob, getRewrapJob, listKeys, listRewrapJobs, markRetired, recordKeys, rewrapBacklog, setRetireAfter } from "@/lib/keycustody/store";
import { KeyRing } from "@/lib/keycustody/registry";
import { vaultCipherFromEnv } from "@/lib/secrets";
import { keyCustodyMain, runQueuedRewrap } from "../../scripts/key-custody";

// The CLI opens its own Postgres store; here that store is this test's PGlite, refusing every call once the CLI closes it.
const cliStore = vi.hoisted(() => ({ db: undefined as unknown, closedAt: 0 }));
vi.mock("@/lib/controlplane/db", async (original) => {
  const real = await original<typeof import("@/lib/controlplane/db")>();
  return { ...real, openPlatformDb: async (config: Parameters<typeof real.openPlatformDb>[0]) => {
    if (config.kind !== "postgres") return real.openPlatformDb(config);
    let closed = false;
    return new Proxy(cliStore.db as object, { get(target, name) {
      if (name === "close") return async () => { closed = true; cliStore.closedAt++; };
      const value = Reflect.get(target, name) as unknown;
      return typeof value === "function" ? (...args: unknown[]) => { if (closed) throw new Error("CONNECTION_ENDED"); return (value as (...a: unknown[]) => unknown).apply(target, args); } : value;
    } });
  } };
});

const hex = (): string => randomBytes(32).toString("hex");
const WS = `ws-${randomUUID()}`;
const OTHER = `ws-${randomUUID()}`;
const OLD = hex();
const NEW = hex();
const env = { ZENITH_SECRET_KEY: NEW, ZENITH_VAULT_PREVIOUS_SECRET_KEYS: JSON.stringify([OLD]) };

let db: PlatformDbHandle;
beforeEach(async () => {
  db = await openPlatformDb({ kind: "pglite" });
  const migration = fs.readFileSync("supabase/migrations/0001_system_of_record.sql", "utf8");
  for (const table of ["secrets", "audit_events"]) {
    const ddl = migration.match(new RegExp(`create table if not exists public\\.${table} \\([\\s\\S]*?\\n\\);`))?.[0];
    if (!ddl) throw new Error("Product vault schema was not found.");
    await db.exec(ddl);
  }
}, 60_000);
afterEach(async () => { await db.close(); });

async function seed(ref: string, value: string, key = OLD, workspaceId = WS): Promise<void> {
  const sealed = vaultCipherFromEnv({ ZENITH_SECRET_KEY: key }).seal(workspaceId, ref, value);
  await db.query(
    `INSERT INTO public.secrets (workspace_id, ref, iv, auth_tag, ciphertext, key_version, meta, version, updated_at)
     VALUES ($1,$2,$3,$4,$5,1,$6::text::jsonb,3,$7::timestamptz)`,
    [workspaceId, ref, sealed.iv, sealed.authTag, sealed.ciphertext, JSON.stringify({ createdAt: "2026-09-01T00:00:00.000Z", updatedAt: "2026-09-02T00:00:00.000Z", createdBy: "a", updatedBy: "b" }), "2026-09-02T00:00:00.000Z"]);
}

async function openUnder(workspaceId: string, ref: string, keyEnv: Record<string, string>): Promise<{ value: string; current: boolean } | undefined> {
  const [row] = await db.query<{ iv: string; auth_tag: string; ciphertext: string }>("SELECT iv, auth_tag, ciphertext FROM public.secrets WHERE workspace_id = $1 AND ref = $2", [workspaceId, ref]);
  try { return vaultCipherFromEnv(keyEnv).open(workspaceId, ref, { iv: row.iv, authTag: row.auth_tag, ciphertext: row.ciphertext }); } catch { return undefined; }
}

const pass = (options: Parameters<typeof keyRewrapPass>[1] = {}) => keyRewrapPass(db, { env, product: async () => db, ...options });
const refs = (n: number): string[] => Array.from({ length: n }, (_, i) => `vault:p/s/KEY_${String(i).padStart(2, "0")}`);

describe("durable vault re-wrap", () => {
  it("re-wraps every row of the workspace under the current key in bounded batches, and records the key facts", async () => {
    const values = new Map(refs(5).map((r) => [r, `value-${randomBytes(6).toString("hex")}`]));
    for (const [ref, value] of values) await seed(ref, value);
    await seed("vault:p/s/OTHER", "other-value", OLD, OTHER);
    const { job, created } = await enqueueRewrapJob(db, { workspaceId: WS, targetKeyId: KeyRing.fromEnv(env, { purposes: ["enc:vault"] }).descriptors()[0].keyId, requestedBy: "test" });
    expect(created).toBe(true);
    expect(job.status).toBe("pending");

    const result = await pass({ batchSize: 2 });
    expect(result).toMatchObject({ completed: 1, failed: 0, blocked: 0, rewrapped: 5 });
    const done = await getRewrapJob(db, WS, job.id);
    expect(done).toMatchObject({ status: "completed", inspected: 5, rewrapped: 5, unchanged: 0, batches: 3, errorCode: null });
    expect(done?.finishedAt).not.toBeNull();

    for (const [ref, value] of values) {
      expect(await openUnder(WS, ref, { ZENITH_SECRET_KEY: NEW })).toEqual({ value, current: true });
      expect(await openUnder(WS, ref, { ZENITH_SECRET_KEY: OLD })).toBeUndefined();
    }
    // another workspace is never touched by this job
    expect(await openUnder(OTHER, "vault:p/s/OTHER", { ZENITH_SECRET_KEY: OLD })).toMatchObject({ current: true });
    const audits = await db.query<{ action_id: string; data: unknown }>("SELECT action_id, data FROM public.audit_events WHERE workspace_id = $1", [WS]);
    expect(audits.length).toBeGreaterThan(0);
    expect(audits.every((a) => a.action_id === "system.rewrapVault")).toBe(true);
    for (const value of values.values()) expect(JSON.stringify(audits)).not.toContain(value);

    const keys = await listKeys(db);
    expect(keys.filter((k) => k.purpose === "enc:vault").map((k) => k.role).sort()).toEqual(["current", "decrypt_only"]);
  });

  it("resumes from its durable cursor across ticks and never double-counts rewrapped rows", async () => {
    for (const ref of refs(5)) await seed(ref, `v-${ref}`);
    await enqueueRewrapJob(db, { workspaceId: WS, targetKeyId: "t", requestedBy: "test" });
    const first = await pass({ batchSize: 2, maxBatches: 1 });
    expect(first).toMatchObject({ batches: 1, completed: 0 });
    const [running] = await listRewrapJobs(db, { workspaceId: WS });
    expect(running).toMatchObject({ status: "running", rewrapped: 2, inspected: 2 });
    expect(running.cursorRef).toBe(refs(5)[1]);
    expect(await rewrapBacklog(db)).toEqual({ pending: 0, running: 1 });
    for (let i = 0; i < 10 && (await listRewrapJobs(db, { workspaceId: WS }))[0].status !== "completed"; i++) await pass({ batchSize: 2, maxBatches: 1 });
    expect((await listRewrapJobs(db, { workspaceId: WS }))[0]).toMatchObject({ status: "completed", inspected: 5, rewrapped: 5, unchanged: 0 });
  });

  it("is idempotent: a second job over rewrapped rows changes nothing", async () => {
    for (const ref of refs(3)) await seed(ref, `v-${ref}`, NEW);
    await enqueueRewrapJob(db, { workspaceId: WS, targetKeyId: "t", requestedBy: "test" });
    const result = await pass();
    expect(result).toMatchObject({ completed: 1, rewrapped: 0 });
    expect((await listRewrapJobs(db, { workspaceId: WS }))[0]).toMatchObject({ status: "completed", inspected: 3, rewrapped: 0, unchanged: 3 });
  });

  it("an unreadable row fails the job with a fixed code and writes nothing in that batch", async () => {
    await seed("vault:p/s/A_BAD", "bad", hex());
    await seed("vault:p/s/B_GOOD", "good");
    await enqueueRewrapJob(db, { workspaceId: WS, targetKeyId: "t", requestedBy: "test" });
    const result = await pass({ batchSize: 10 });
    expect(result).toMatchObject({ failed: 1, completed: 0 });
    const [job] = await listRewrapJobs(db, { workspaceId: WS });
    expect(job).toMatchObject({ status: "failed", errorCode: "unreadable_row" });
    // the readable row of the failing batch is still under the old key: nothing was written
    expect(await openUnder(WS, "vault:p/s/B_GOOD", { ZENITH_SECRET_KEY: OLD })).toMatchObject({ value: "good", current: true });
    expect(JSON.stringify(job)).not.toContain("A_BAD");
  });

  it("the file store is blocked (the quiesced operator CLI owns it), and a missing key fails the job without echoing anything", async () => {
    await enqueueRewrapJob(db, { workspaceId: WS, targetKeyId: "t", requestedBy: "test" });
    expect(await pass({ product: async () => undefined })).toMatchObject({ blocked: 1 });
    expect((await listRewrapJobs(db, { workspaceId: WS }))[0]).toMatchObject({ status: "blocked", errorCode: "file_store_requires_cli" });
    await enqueueRewrapJob(db, { workspaceId: OTHER, targetKeyId: "t", requestedBy: "test" });
    expect(await keyRewrapPass(db, { env: {}, product: async () => db })).toMatchObject({ failed: 1 });
    expect((await listRewrapJobs(db, { workspaceId: OTHER }))[0]).toMatchObject({ status: "failed", errorCode: "key_unavailable" });
  });

  it("a transient store error leaves the job running for the next tick", async () => {
    await seed("vault:p/s/A", "v");
    await enqueueRewrapJob(db, { workspaceId: WS, targetKeyId: "t", requestedBy: "test" });
    const result = await pass({ product: async () => { throw new Error("connection refused postgres://u:p@h/db"); } });
    expect(result.retry).toBeGreaterThan(0);
    const [job] = await listRewrapJobs(db, { workspaceId: WS });
    expect(job.status).toBe("running");
    expect(JSON.stringify(result)).not.toContain("postgres://");
    expect(await pass()).toMatchObject({ completed: 1 });
  });

  it("reports overdue and unscheduled historical keys in the job counts", async () => {
    await pass();
    const old = (await listKeys(db)).find((k) => k.role === "decrypt_only" && k.purpose === "enc:vault")!;
    expect((await pass()).unscheduled).toBeGreaterThanOrEqual(1);
    expect(await setRetireAfter(db, { purpose: "enc:vault", keyId: old.keyId, retireAfter: "2026-01-01T00:00:00.000Z" })).toBe(true);
    expect((await pass()).overdue).toBeGreaterThanOrEqual(1);
  });

  it("runs as a critical job on the durable scheduler contract (lease, run record, health)", async () => {
    expect(CRITICAL_JOBS["key-rewrap"]).toMatchObject({ cadenceMs: 60_000 });
    expect(Object.keys(MAINTENANCE_JOBS)).toEqual(expect.arrayContaining(["key-rewrap", "data-minimize"]));
    const run = await runCriticalJob(db, "key-rewrap", "temporal", async () => {
      const value = await keyRewrapPass(db, { env, product: async () => db });
      return { value, performed: true, counts: { keys: value.keys } };
    });
    expect(run.status).toBe("ok");
    const [row] = await db.query<{ job: string; last_status: string; last_success_source: string }>("select job, last_status, last_success_source from platform.scheduled_job_runs where job = 'key-rewrap'");
    expect(row).toMatchObject({ last_status: "ok", last_success_source: "temporal" });
  });
});

describe("the operator CLI works the queue without Temporal", () => {
  it("runs queued jobs under the scheduler lease and run record, and exits non-zero when a job fails", async () => {
    for (const ref of refs(3)) await seed(ref, `v-${ref}`);
    await enqueueRewrapJob(db, { workspaceId: WS, targetKeyId: "t", requestedBy: "cli" });
    const out: string[] = [], err: string[] = [];
    expect(await runQueuedRewrap(db, env, (l) => out.push(l), (l) => err.push(l), async () => db)).toBe(0);
    expect((await listRewrapJobs(db, { workspaceId: WS }))[0]).toMatchObject({ status: "completed", rewrapped: 3 });
    expect(JSON.parse(out[out.length - 1])).toMatchObject({ completed: 1, open: 0 });
    const [row] = await db.query<{ last_status: string; last_success_source: string }>("select last_status, last_success_source from platform.scheduled_job_runs where job = 'key-rewrap'");
    expect(row).toMatchObject({ last_status: "ok", last_success_source: "fallback" });
    await seed("vault:p/s/Z_BAD", "bad", hex());
    await enqueueRewrapJob(db, { workspaceId: WS, targetKeyId: "t", requestedBy: "cli" });
    expect(await runQueuedRewrap(db, env, (l) => out.push(l), (l) => err.push(l), async () => db)).toBe(1);
    expect((await listRewrapJobs(db, { workspaceId: WS }))[0]).toMatchObject({ status: "failed", errorCode: "unreadable_row" });
  });

  it("rewrap --run finishes the run before closing its store (PROD-OPS-05 live: a bare return closed it mid-run)", async () => {
    cliStore.db = db;
    for (const ref of refs(2)) await seed(ref, `v-${ref}`);
    const url = "postgres://cli.invalid/zenith";
    const cliEnv = { ...env, ZENITH_STORE: "postgres", ZENITH_PLATFORM_DB: "postgres", ZENITH_PLATFORM_DB_URL: url, SUPABASE_DB_URL: url };
    const out: string[] = [], err: string[] = [];
    expect(await keyCustodyMain(["rewrap", "--workspace", WS, "--run"], (l) => out.push(l), (l) => err.push(l), cliEnv)).toBe(0);
    expect(err).toEqual([]);
    expect(cliStore.closedAt).toBe(1);
    expect((await listRewrapJobs(db, { workspaceId: WS }))[0]).toMatchObject({ status: "completed", rewrapped: 2 });
  });
});

describe("key custody store", () => {
  const key = { purpose: "enc:vault" as const, keyId: "abcdef0123456789", role: "decrypt_only" as const, source: "ZENITH_VAULT_PREVIOUS_SECRET_KEYS", derivation: "direct" as const, algorithm: "AES-256-GCM" };

  it("first-seen is stable, role follows the configuration, and retirement applies only to non-current keys", async () => {
    await recordKeys(db, [key]);
    const [first] = await listKeys(db);
    await recordKeys(db, [{ ...key, role: "decrypt_only" }]);
    const [second] = await listKeys(db);
    expect(second.firstSeenAt).toBe(first.firstSeenAt);
    expect(await setRetireAfter(db, { purpose: "enc:vault", keyId: key.keyId, retireAfter: "2027-01-01T00:00:00.000Z" })).toBe(true);
    expect(await setRetireAfter(db, { purpose: "enc:vault", keyId: key.keyId, retireAfter: null })).toBe(true);
    await recordKeys(db, [{ ...key, keyId: "cur0123456789abc", role: "current" }]);
    expect(await setRetireAfter(db, { purpose: "enc:vault", keyId: "cur0123456789abc", retireAfter: "2027-01-01T00:00:00.000Z" })).toBe(false);
    expect(await markRetired(db, { purpose: "enc:vault", keyId: "cur0123456789abc", by: "ops" })).toBe(false);
    expect(await markRetired(db, { purpose: "enc:vault", keyId: key.keyId, by: "ops" })).toBe(true);
    expect(await markRetired(db, { purpose: "enc:vault", keyId: key.keyId, by: "ops" })).toBe(false);
    await expect(setRetireAfter(db, { purpose: "enc:nope", keyId: "x", retireAfter: null })).rejects.toMatchObject({ code: "invalid_input" });
    await expect(setRetireAfter(db, { purpose: "enc:vault", keyId: key.keyId, retireAfter: "not a date" })).rejects.toMatchObject({ code: "invalid_input" });
  });

  it("one open re-wrap job per workspace, oldest-first claiming, workspace-scoped reads and fixed-code finishing", async () => {
    const a = await enqueueRewrapJob(db, { workspaceId: WS, targetKeyId: "t", requestedBy: "u" });
    const again = await enqueueRewrapJob(db, { workspaceId: WS, targetKeyId: "t", requestedBy: "u" });
    expect(again).toMatchObject({ created: false, job: { id: a.job.id } });
    const b = await enqueueRewrapJob(db, { workspaceId: OTHER, targetKeyId: "t", requestedBy: "u" });
    await expect(enqueueRewrapJob(db, { workspaceId: "bad id", targetKeyId: "t", requestedBy: "u" })).rejects.toMatchObject({ code: "invalid_input" });
    expect(await getRewrapJob(db, OTHER, a.job.id)).toBeNull();
    expect((await claimRewrapJob(db))?.id).toBe(a.job.id);
    expect(await advanceRewrapJob(db, { workspaceId: OTHER, id: a.job.id, cursorRef: "x", targetKeyId: "t", inspected: 1, rewrapped: 1, unchanged: 0, batches: 1 })).toBe(false);
    expect(await finishRewrapJob(db, { workspaceId: WS, id: a.job.id, status: "completed" })).toMatchObject({ status: "completed" });
    expect(await finishRewrapJob(db, { workspaceId: WS, id: a.job.id, status: "failed", errorCode: "rewrap_failed" })).toBeNull();
    expect((await claimRewrapJob(db))?.id).toBe(b.job.id);
    expect((await listRewrapJobs(db, { workspaceId: WS })).map((j) => j.id)).toEqual([a.job.id]);
    expect((await listRewrapJobs(db)).length).toBe(2);
    // a completed workspace may queue a new job
    expect((await enqueueRewrapJob(db, { workspaceId: WS, targetKeyId: "t", requestedBy: "u" })).created).toBe(true);
  });

  it("the tables carry no workspace-free secret fields and row level security is on", async () => {
    const columns = await db.query<{ table_name: string; column_name: string }>("select table_name, column_name from information_schema.columns where table_schema = 'platform' and table_name in ('key_custody_keys','key_rewrap_jobs')");
    expect(columns.map((c) => c.column_name).filter((c) => /material|secret|value|key_bytes|ciphertext/.test(c))).toEqual([]);
    const rls = await db.query<{ relname: string; relrowsecurity: boolean }>("select relname, relrowsecurity from pg_class where relname in ('key_custody_keys','key_rewrap_jobs')");
    expect(rls.every((r) => r.relrowsecurity)).toBe(true);
    expect(rls).toHaveLength(2);
  });
});
