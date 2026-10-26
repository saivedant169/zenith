/**
 * PROD-OPS-06: the sensitive persistence inventory is complete and honest, in both directions, and the at-rest
 * checks accept real ciphertext and reject plain-looking values. Static analysis of the migrations plus real
 * PGlite for the census. Nothing here claims redaction is complete: protections are named by what they are.
 */
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { openPlatformDb, type PlatformDbHandle } from "@/lib/controlplane/db";
import { KEY_PURPOSES } from "@/lib/keycustody/purposes";
import { createAesResultSealer } from "@/lib/runners/seal";
import { AT_REST_CHECKS, atRestCensus, CENSUS_COVERS, verifyOpaqueBytes, verifyResultEnvelope, verifySealedBox, verifySealedColumns } from "@/lib/sensitivedata/at-rest";
import { compareInventory, discoverSensitiveColumns, OTHER_SINKS, SENSITIVE_TEXT_COLUMN, sealedColumns, TABLES, type DiscoveredTable } from "@/lib/sensitivedata/inventory";
import { vaultCipherFromEnv } from "@/lib/secrets";
import { LEAK_PATHS } from "../_support/security/persistence";

const ROOT = process.cwd();
const MIGRATIONS = path.join(ROOT, "src/lib/controlplane/db/migrations");

function discoverAll(): DiscoveredTable[] {
  const platform = fs.readdirSync(MIGRATIONS).filter((f) => f.endsWith(".ts") && f !== "index.ts" && f !== "emit.ts").map((f) => fs.readFileSync(path.join(MIGRATIONS, f), "utf8")).join("\n");
  const product = fs.readdirSync(path.join(ROOT, "supabase/migrations")).filter((f) => f.endsWith(".sql")).sort().map((f) => fs.readFileSync(path.join(ROOT, "supabase/migrations", f), "utf8")).join("\n");
  return [...discoverSensitiveColumns(platform, ["platform"]), ...discoverSensitiveColumns(product, ["public", "hosted", "agent"])];
}

describe("inventory completeness (a new table or sensitive-looking column fails until classified)", () => {
  const discovered = discoverAll();

  it("finds the schema it is supposed to audit, so it cannot pass by reading nothing", () => {
    expect(discovered.length).toBeGreaterThan(90);
    const names = new Set(discovered.map((d) => d.table));
    for (const table of ["platform.runner_jobs", "platform.plan_artifacts", "platform.key_rewrap_jobs", "public.secrets", "hosted.invite_deliveries", "agent.agent_uploads"]) expect(names.has(table), table).toBe(true);
    expect(discovered.find((d) => d.table === "platform.runner_jobs")?.columns).toEqual(expect.arrayContaining(["envelope", "result", "error"]));
    expect(SENSITIVE_TEXT_COLUMN.test("ciphertext")).toBe(true);
    for (const column of ["key_purpose", "restore_key_id", "legacy_reason"]) expect(SENSITIVE_TEXT_COLUMN.test(column)).toBe(true);
  });

  it("every table and every sensitive-looking column is in the inventory, and nothing in it is stale", () => {
    const gaps = compareInventory(discovered);
    expect(gaps, `classify these in src/lib/sensitivedata/inventory.ts:\n${gaps.map((g) => `  ${g.kind} ${g.table}${g.column ? `.${g.column}` : ""}`).join("\n")}`).toEqual([]);
  });

  it("the comparison itself detects a missing table, a missing column and stale entries", () => {
    const synthetic: DiscoveredTable[] = [{ table: "platform.runner_jobs", columns: ["envelope", "result", "error", "surprise"] }, { table: "platform.brand_new", columns: [] }];
    const kinds = compareInventory(synthetic).map((g) => `${g.kind}:${g.table}${g.column ? `.${g.column}` : ""}`);
    expect(kinds).toEqual(expect.arrayContaining(["column_missing:platform.runner_jobs.surprise", "table_missing:platform.brand_new", "table_stale:platform.events"]));
    const dropped = compareInventory([{ table: "platform.runner_jobs", columns: ["envelope", "result"] }]).map((g) => `${g.kind}:${g.table}.${g.column ?? ""}`);
    expect(dropped).toContain("column_stale:platform.runner_jobs.error");
  });
});

describe("what the inventory claims is internally consistent", () => {
  it("anything classified secret or raw plan is sealed (or an artifact held on a protected host volume), never merely write-guarded", () => {
    const offenders: string[] = [];
    for (const [table, entry] of Object.entries(TABLES))
      for (const [column, sink] of Object.entries(entry.columns))
        if ((sink.classification === "secret" || sink.classification === "raw-plan-or-state") && sink.protection.kind !== "sealed") offenders.push(`${table}.${column}`);
    expect(offenders).toEqual([]);
    for (const sink of OTHER_SINKS)
      if ((sink.classification === "secret" || sink.classification === "raw-plan-or-state") && !["sealed", "host-protected"].includes(sink.protection.kind)) offenders.push(sink.id);
    expect(offenders).toEqual([]);
  });

  it("sealed protections name a registered key purpose", () => {
    for (const { table, column, purpose } of sealedColumns()) expect(KEY_PURPOSES as readonly string[], `${table}.${column}`).toContain(purpose);
    for (const sink of OTHER_SINKS) if (sink.protection.kind === "sealed") expect(KEY_PURPOSES as readonly string[], sink.id).toContain(sink.protection.purpose);
  });

  it("every sealed column is covered by the at-rest census", () => {
    const missing = sealedColumns().map((c) => `${c.table}.${c.column}`).filter((key) => !CENSUS_COVERS.has(key));
    expect(missing).toEqual([]);
    for (const check of AT_REST_CHECKS) expect(TABLES[check.table], check.id).toBeDefined();
  });

  it("every leak path an inventory entry names is exercised by the leak suite, and sink ids are unique", () => {
    const ids = OTHER_SINKS.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const sink of OTHER_SINKS) if (sink.leakPath) expect(LEAK_PATHS as readonly string[], sink.id).toContain(sink.leakPath);
  });

  it("the stores that minimization touches are exactly the ones marked minimized", () => {
    const minimized = Object.entries(TABLES).filter(([, t]) => t.retention.policy === "minimized").map(([name]) => name).sort();
    expect(minimized).toEqual(["agent.agent_uploads", "platform.machine_requests", "platform.runner_jobs"]);
    const source = fs.readFileSync(path.join(ROOT, "src/lib/sensitivedata/minimize.ts"), "utf8");
    for (const name of ["runner_jobs", "machine_requests", "agent.agent_uploads"]) expect(source).toContain(name);
  });

  it("honest about limits: no table claims best-effort guards are encryption, and unreviewed entries are counted not hidden", () => {
    const unreviewed = Object.entries(TABLES).flatMap(([table, t]) => Object.entries(t.columns).filter(([, c]) => c.assurance === "unreviewed").map(([column]) => `${table}.${column}`));
    // a ratchet: the count may only go down as columns are reviewed (update the number when you review one)
    // Schema 60 reserves one unreviewed column (platform.cleanup_writer_settlements.sealed) until WP3 writes it.
    expect(unreviewed.length).toBeLessThanOrEqual(26);
    for (const [table, t] of Object.entries(TABLES))
      for (const [column, c] of Object.entries(t.columns)) if (c.protection.kind === "write-guarded") expect(c.protection.guard.length, `${table}.${column}`).toBeGreaterThan(10);
  });

  it("idempotency.complete has exactly one production caller, and it seals", () => {
    const callers: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (/\.tsx?$/.test(entry.name) && /idempotency\.complete\(/.test(fs.readFileSync(full, "utf8"))) callers.push(path.relative(ROOT, full).split(path.sep).join("/"));
      }
    };
    walk(path.join(ROOT, "src"));
    expect(callers).toEqual(["src/lib/machines/persistence.ts"]);
    expect(fs.readFileSync(path.join(ROOT, "src/lib/machines/persistence.ts"), "utf8")).toMatch(/idempotency\.complete\(db, ws, key, sealer\.seal\(/);
  });
});

describe("at-rest shape checks", () => {
  const sealer = createAesResultSealer(randomBytes(32), { keyId: "k" });
  const secret = `opaque-${randomBytes(9).toString("hex")}`;

  it("accept real ciphertext", () => {
    const box = sealer.seal("a", { secret });
    expect(verifySealedBox(box)).toEqual({ ok: true });
    expect(verifySealedBox(JSON.stringify(box))).toEqual({ ok: true });
    expect(verifyResultEnvelope({ sealed: box, exitCode: 0, startedAt: "t", finishedAt: "t" })).toEqual({ ok: true });
    expect(verifyResultEnvelope({ exitCode: 1, minimized: true })).toEqual({ ok: true });
    expect(verifyResultEnvelope(null)).toEqual({ ok: true });
    const columns = vaultCipherFromEnv({ ZENITH_SECRET_KEY: randomBytes(32).toString("hex") }).seal("ws", "vault:a", secret);
    expect(verifySealedColumns({ iv: columns.iv, auth_tag: columns.authTag, ciphertext: columns.ciphertext })).toEqual({ ok: true });
    expect(verifyOpaqueBytes(randomBytes(64))).toEqual({ ok: true });
    expect(verifyOpaqueBytes(null)).toEqual({ ok: true });
  });

  it("reject anything plain-looking in a column that must hold ciphertext, naming the reason and never the value", () => {
    const verdicts = [
      verifySealedBox({ secret }),
      verifySealedBox("plaintext"),
      verifyResultEnvelope({ stdout: secret }),
      verifyResultEnvelope({ sealed: { v: 1 }, exitCode: 0 }),
      verifyResultEnvelope({ password: secret, sealed: sealer.seal("a", 1) }),
      verifyResultEnvelope({ exitCode: 0 }),
      verifyResultEnvelope([secret]),
      verifySealedColumns({ iv: "x", auth_tag: "y", ciphertext: secret }),
      verifySealedColumns({ iv: Buffer.alloc(12).toString("base64"), auth_tag: Buffer.alloc(16).toString("base64"), ciphertext: "" }),
      verifyOpaqueBytes(Buffer.from(JSON.stringify({ token: secret, padding: "x".repeat(40) }))),
      verifyOpaqueBytes(Buffer.from(`readable text with a ${secret} in it, long enough to pass the length floor`)),
      verifyOpaqueBytes(Buffer.alloc(4)),
      verifyOpaqueBytes("not bytes"),
    ];
    expect(verdicts.every((v) => v.ok === false)).toBe(true);
    expect(JSON.stringify(verdicts)).not.toContain(secret);
  });
});

describe("census on a real database", () => {
  let db: PlatformDbHandle;
  beforeAll(async () => { db = await openPlatformDb({ kind: "pglite" }); }, 60_000);
  afterAll(async () => { await db.close(); });
  const sealer = createAesResultSealer(randomBytes(32), { keyId: "k" });
  const insertResponse = (key: string, response: unknown) => db.query(
    "insert into platform.idempotency_keys (workspace_id, key, request_hash, response, expires_at) values ($1, $2, $3, $4::text::jsonb, clock_timestamp() + interval '1 hour')",
    ["ws-census", key, "0".repeat(64), JSON.stringify(response)]);

  it("passes sealed rows, reports plain ones with counts and fixed reasons only, and reports absent schemas as absent", async () => {
    const secret = `opaque-${randomBytes(9).toString("hex")}`;
    await insertResponse("machine-dispatch:ok", sealer.seal("a", { secret }));
    let results = await atRestCensus(db);
    expect(results.find((r) => r.id === "machine-artifacts")).toMatchObject({ absent: false, sampled: 1, violations: 0 });
    expect(results.find((r) => r.id === "vault")).toMatchObject({ absent: true });
    expect(results.find((r) => r.id === "agent-link-secrets")).toMatchObject({ absent: true });
    expect(results.every((r) => r.absent || r.violations === 0)).toBe(true);

    await insertResponse("machine-dispatch:bad", { stdout: secret });
    results = await atRestCensus(db, { sample: 50 });
    const bad = results.find((r) => r.id === "machine-artifacts")!;
    expect(bad.violations).toBe(1);
    expect(bad.reasons).toEqual(["value is not a sealed box"]);
    expect(JSON.stringify(results)).not.toContain(secret);
  });
});
