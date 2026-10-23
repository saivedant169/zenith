import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { DATA_KINDS, DataProofSchema, WitnessSchema, assertEqualContent, fixtureContainerName, knownData, objectWitness, pinnedFixtureImages, rowWitness } from "../../../scripts/release/drivers/export-data-plan";
import { postgresEndpoint, postgresLeg } from "../../../scripts/release/drivers/export-data-postgres";
import { DRIVER_CHECKS, DRIVER_LIMITS, OPERATED_LABEL, CleanupBlocker, OwnedCleanup, settleAfterQuiescence, validateOperatedReceipt, type OperatedReceipt } from "../../../scripts/release/drivers/protocol";

const runId = "drv4-data", sourceCommit = "a".repeat(40), sourceDigest = "b".repeat(64);
const witness = (kind: string, tenant: "a" | "b") => kind === "object_store" ? objectWitness(knownData(runId, tenant).objects) : rowWitness(knownData(runId, tenant).rows);
function receipt(): OperatedReceipt {
  return { schema: 1, evidenceLabel: OPERATED_LABEL, scenarioId: "export", runId, sourceCommit, sourceDigest,
    checks: DRIVER_CHECKS.export.map(id => ({ id, status: "passed" })), readbacks: Object.fromEntries(["source", "bundle", "portable-plan", "portable"].map(k => [k, sourceDigest])),
    dataRoundtrips: Object.fromEntries(DATA_KINDS.map(kind => [kind, { source: witness(kind, "a"), target: witness(kind, "a"), otherTenant: witness(kind, "b"),
      exportedContentDigest: sourceDigest, restoredContentDigest: sourceDigest, tenantIsolation: true, mysqlTls: kind === "mysql" ? "verified_identity" : "not_applicable" }])),
    limits: [...DRIVER_LIMITS.export] };
}
const binding = { scenarioId: "export", runId, sourceCommit, sourceDigest } as const;
const exporterSource = readFileSync(new URL("../../../scripts/release/drivers/export-data.ts", import.meta.url), "utf8");
const driverSource = readFileSync(new URL("../../../scripts/release/drivers/export.ts", import.meta.url), "utf8");
const operatedSource = readFileSync(new URL("../../../scripts/release/drivers/operated.ts", import.meta.url), "utf8");
const protocolSource = readFileSync(new URL("../../../scripts/release/drivers/protocol.ts", import.meta.url), "utf8");
const localRunnerSource = readFileSync(new URL("../../../scripts/release/local-target-runner.ts", import.meta.url), "utf8");
const acceptanceSource = readFileSync(new URL("../../../scripts/release/acceptance-orchestrator.ts", import.meta.url), "utf8");
function ordered(source: string, fragments: string[]): void {
  let previous = -1;
  for (const fragment of fragments) {
    const position = source.indexOf(fragment, previous + 1);
    expect(position, `missing or out-of-order source contract: ${fragment}`).toBeGreaterThan(previous);
    previous = position;
  }
}
describe("DRV4 customer-data witness planners", () => {
  it("locks the exact export receipt graph and keeps data fixtures ahead of the separate infrastructure leg", () => {
    expect(DRIVER_CHECKS.export).toEqual([
      "preconditions", "browser-approved-deployment", "provider-readback", "revision-export", "working-copy-divergence",
      "export-file-readback", "credential-absence", "browser-approved-teardown", "portable-plan", "portable-apply-readback",
      "data-preconditions", "postgres-data-roundtrip", "mysql-data-roundtrip", "object-store-data-roundtrip", "data-tenant-scoping",
      "source-stable", "owned-cleanup",
    ]);
    ordered(driverSource.slice(driverSource.indexOf("export async function runExport")), [
      "await operatedDataRoundtrips(ctx)", "const target = await localstack(ctx)", "await ctx.step(\"browser-approved-deployment\"",
    ]);
    ordered(exporterSource.slice(exporterSource.indexOf("export async function operatedDataRoundtrips")), [
      "await leg.seedSource(legContext)", "const exportOp = await operation(", "const importOp = await operation(",
      "const observed = await leg.readTarget(legContext)", "ctx.dataRoundtrips[kind] = DataProofSchema.parse(",
    ]);
    expect(exporterSource).toContain("data-export-record-binding");
    expect(exporterSource).toContain("data-restore-record-binding");
    expect(exporterSource).toContain("foreign-export-not-visible");
    expect(exporterSource).toContain("fresh-empty-data-targets");
  });
  it("binds the operated receipt to the exact checkout content and rechecks source stability", () => {
    expect(operatedSource).toContain("const source = sourceBinding()");
    expect(localRunnerSource).toContain("sourceDigest: source.contentSha256");
    expect(acceptanceSource).toContain("sourceDigest: sourceBinding().contentSha256");
    expect(acceptanceSource).toContain("sourceDigest: ctx.sourceDigest");
    expect(operatedSource).toContain("sourceCommit: source.head, sourceDigest: source.contentSha256");
    expect(operatedSource).toContain("await step(\"source-stable\", async () => { ensure(JSON.stringify(sourceBinding()) === JSON.stringify(source), \"source-drift\")");
    expect(validateOperatedReceipt(receipt(), binding)).toEqual(receipt());
    expect(() => validateOperatedReceipt(receipt(), { ...binding, sourceDigest: "c".repeat(64) })).toThrow("binding");
  });
  it("registers export recovery before mutation and quiesces an unsettled worker before fixture cleanup", () => {
    ordered(exporterSource.slice(exporterSource.indexOf("async function ownedContainer")), [
      "cleanup.add(close)", "const id = (await command(\"docker\", [\"run\"",
    ]);
    ordered(exporterSource.slice(exporterSource.indexOf("async function operation(")), [
      "ctx.quiescence.add(async () =>", "if (!startedAttempt)", "await browserRequest(tenant.owner, `/api/platform/v1/operations/${id}/cancel`",
      "await command(\"docker\", [\"stop\", \"--time\", \"15\", ctx.stack.worker])", "await approveOperation(ctx, tenant, id)",
      "const started = ok(await browserRequest(tenant.owner, `/api/platform/v1/operations/${id}/start-portability`",
    ]);
    ordered(exporterSource.slice(exporterSource.indexOf("export async function operatedDataRoundtrips")), [
      "ctx.cleanup.add(async () => { ensure(await cleanup.settle()", "engines.add(() => leg.cleanup(legContext))", "await leg.seedSource(legContext)",
    ]);
    // An `uncertain` operation projection is not proof the mutation worker is quiescent.
    expect(exporterSource).not.toMatch(/const terminal = \[.*"uncertain"/);
    expect(protocolSource).toContain("while (this.jobs.length)");
    ordered(protocolSource.slice(protocolSource.indexOf("async settle()")), ["if (this.blocker?.isBlocked)", "const work = this.jobs.pop()!", "try { await work(); } catch"]);
    ordered(operatedSource.slice(operatedSource.indexOf("async function runTenantExportOperated")), [
      "const quiescence = new TenantExportCleanup()", "const settled = await settleAfterQuiescence(quiescence, cleanup, cleanupBlocked)",
      "if (!settled.quiesced)", "receipt.checks.find(item => item.id === \"owned-cleanup\")!.status",
    ]);
  });
  it("keeps fixture credentials in the vault path and raw values out of the closed receipt schema", () => {
    expect(exporterSource).toContain('action(tenant.owner, "system.setSecret"');
    expect(exporterSource).toContain('await action(tenant.owner, "project.updateManifest"');
    expect(exporterSource).toContain("ctx.dataRoundtrips[kind] = DataProofSchema.parse(");
    expect(protocolSource).toContain("dataRoundtrips: z.object({ postgres: DataProofSchema.optional(), mysql: DataProofSchema.optional(), object_store: DataProofSchema.optional() }).strict().optional()");
    const marker = randomBytes(32).toString("base64url");
    const leaked = { ...receipt(), credential: marker };
    expect(() => validateOperatedReceipt(leaked, binding)).toThrow();
    expect(JSON.stringify(receipt())).not.toContain(marker);
  });
  it("plans three deterministic SQL rows and three binary/empty/unicode objects per tenant", () => {
    const a = knownData(runId, "a"), b = knownData(runId, "b");
    expect(a.rows).toHaveLength(3); expect(a.objects).toHaveLength(3);
    expect(a).toEqual(knownData(runId, "a")); expect(a.rows).not.toEqual(b.rows);
    expect(a.objects.some(o => o.bytes.length === 0)).toBe(true);
    expect(a.objects.some(o => o.bytes.includes(255))).toBe(true);
    expect(() => knownData("../escape", "a")).toThrow();
  });
  it("produces order-independent per-row digests without conflating null, empty, delimiters or foreign data", () => {
    const rows = knownData(runId, "a").rows;
    const base = rowWitness(rows);
    expect(base.count).toBe(3); expect(base.items).toHaveLength(3);
    expect(rowWitness([...rows].reverse())).toEqual(base);
    for (const altered of [rows.slice(1), [...rows, rows[0]], rows.map((r, i) => i === 0 ? { ...r, note: "" } : r), knownData(runId, "b").rows])
      expect(() => assertEqualContent(base, rowWitness(altered))).toThrow();
    const ambiguous = [{ id: "1", tenant: "a", payload: "b|c", note: "d" }];
    expect(rowWitness(ambiguous)).not.toEqual(rowWitness([{ ...ambiguous[0], payload: "b", note: "c|d" }]));
  });
  it("object witnesses bind exact key, body, byte count and content type", () => {
    const objects = knownData(runId, "a").objects, base = objectWitness(objects);
    expect(objectWitness([...objects].reverse())).toEqual(base);
    for (const changed of [objects.slice(1), objects.map((o, i) => i === 0 ? { ...o, key: "renamed" } : o),
      objects.map((o, i) => i === 1 ? { ...o, bytes: Buffer.from([0]) } : o), objects.map((o, i) => i === 2 ? { ...o, contentType: "text/plain" } : o), knownData(runId, "b").objects])
      expect(() => assertEqualContent(base, objectWitness(changed))).toThrow();
  });
  it("rejects tampered count, item digest, duplicate identity and item ordering", () => {
    const base = rowWitness(knownData(runId, "a").rows);
    for (const bad of [{ ...base, count: 2 }, { ...base, digest: "c".repeat(64) }, { ...base, items: [...base.items].reverse() },
      { ...base, items: [base.items[0], base.items[0], base.items[2]] }]) expect(WitnessSchema.safeParse(bad).success).toBe(false);
  });
  it("requires three explicit immutable image pins and never accepts floating or missing fixtures", () => {
    const env = Object.fromEntries(["POSTGRES", "MYSQL", "MINIO"].map(kind => [`ZENITH_LOCAL_EXPORT_${kind}_IMAGE`, `local/${kind.toLowerCase()}@sha256:${sourceDigest}`]));
    expect(Object.keys(pinnedFixtureImages(env))).toEqual(DATA_KINDS);
    for (const change of [{ ZENITH_LOCAL_EXPORT_MYSQL_IMAGE: "mysql:8.4" }, { ZENITH_LOCAL_EXPORT_MINIO_IMAGE: undefined }]) expect(() => pinnedFixtureImages({ ...env, ...change })).toThrow();
  });
  it("keeps source, target and negative-TLS DNS aliases valid at the longest supported run ID", () => {
    const entropy = randomBytes(12).toString("hex");
    const names = [];
    for (const engine of ["postgres", "mysql", "minio"]) for (const role of ["source", "target"]) {
      const name = fixtureContainerName("r".repeat(20), `${engine}-${role}`, entropy);
      expect(name + "-wrong").toMatch(/^[a-z0-9-]{1,63}$/); names.push(name);
    }
    expect(new Set(names).size).toBe(6);
    expect(() => fixtureContainerName("r".repeat(21), "mysql-source", entropy)).toThrow();
    expect(() => fixtureContainerName(runId, "foreign-source", entropy)).toThrow();
  });
  it("PostgreSQL leg refuses foreign endpoints and ownership before opening a connection", async () => {
    const password = randomBytes(32).toString("hex");
    const endpoint = { url: "postgres://127.0.0.1:49152/postgres", user: "postgres", password };
    expect(new URL(postgresEndpoint(endpoint, "tenant_a")).pathname).toBe("/tenant_a");
    for (const url of ["postgres://example.test:5432/postgres", "postgres://127.0.0.1/postgres", "mysql://127.0.0.1:49152/mysql"]) expect(() => postgresEndpoint({ ...endpoint, url })).toThrow();
    await expect(postgresLeg.seedSource({ runId, tenant: "a", ownerLabel: "foreign", source: endpoint, target: endpoint })).rejects.toThrow("ownership");
  });
  it("does not destroy owned fixtures when worker quiescence cannot be proved", async () => {
    const order: string[] = [], blocker = new CleanupBlocker(), quiescence = new OwnedCleanup(), cleanup = new OwnedCleanup(blocker);
    quiescence.add(async () => { order.push("worker-stop"); throw new Error("worker may still use fixtures"); });
    cleanup.add(async () => { order.push("fixture-delete"); });
    cleanup.add(async () => { order.push("stack-delete"); });
    const result = await settleAfterQuiescence(quiescence, cleanup, blocker);
    expect(result).toEqual({ quiesced: false, clean: false });
    expect(order).toEqual(["worker-stop"]);
  });
});
describe("DRV4 sanitized customer-data receipts", () => {
  it("requires all three independently matched source/target and foreign witnesses", () => {
    expect(validateOperatedReceipt(receipt(), binding)).toEqual(receipt());
    for (const kind of DATA_KINDS) {
      const raw = receipt(); delete raw.dataRoundtrips![kind];
      expect(() => validateOperatedReceipt(raw, binding)).toThrow("Missing data");
    }
  });
  it("rejects digest-only, count-only, mismatched, unscoped and falsely TLS-labelled evidence", () => {
    const proof = receipt().dataRoundtrips!.mysql!;
    for (const bad of [{ ...proof, target: rowWitness([]) }, { ...proof, otherTenant: proof.source }, { ...proof, tenantIsolation: false },
      { ...proof, restoredContentDigest: "c".repeat(64) }, { ...proof, password: randomBytes(32).toString("hex") }]) expect(DataProofSchema.safeParse(bad).success).toBe(false);
    const raw = receipt(); raw.dataRoundtrips!.mysql!.mysqlTls = "not_applicable";
    expect(() => validateOperatedReceipt(raw, binding)).toThrow("TLS");
    const json = JSON.stringify(receipt()); expect(json).not.toContain(knownData(runId, "a").rows[0].payload); expect(json).not.toContain("connectionRef");
  });
  it("refuses raw rows, object bodies, credentials, sessions, certificates and vault refs in receipt metadata", () => {
    const markers = [
      knownData(runId, "a").rows[0]!.payload, knownData(runId, "a").objects[0]!.bytes.toString(),
      "mysql://fixture-user:fixture-password@fixture:3306/db", "session-token-fixture", "-----BEGIN CERTIFICATE-----",
      "vault:project-fixture/connection-uri",
    ];
    for (const marker of markers) expect(() => validateOperatedReceipt({ ...receipt(), limits: [marker] }, binding)).toThrow();
  });
  it("retains failed partial evidence without promoting a skipped data check", () => {
    const raw = receipt(); delete raw.dataRoundtrips!.object_store;
    raw.checks.find(c => c.id === "object-store-data-roundtrip")!.status = "failed";
    expect(validateOperatedReceipt(raw, binding).checks.some(c => c.status === "failed")).toBe(true);
  });
});
