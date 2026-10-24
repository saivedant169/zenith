/**
 * PROD-MIX-06: the live mixed-application harness, CONTRACT LEVEL. The control plane, the application entry, the probe I/O and the
 * database are all fakes here; what is exercised is the harness's own discipline: it refuses without an approved scope, enforces
 * the explicit budget and the approved per-provider budgets, fails closed when a gating step does not pass, never counts a skipped
 * or unperformed step as a pass, checkpoints and resumes, and reports teardown honestly. The real run is
 * scripts/acceptance/mixed/live-run.ts with ZENITH_LIVE_MIXED=1, deferred by the user; nothing here is evidence of it.
 */
import { mkdtempSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { MixedEconomicsReport } from "@/lib/execution/mixed/economics";
import type { ProbeIo, TlsAttempt } from "../../scripts/acceptance/mixed/connectivity-probe";
import { loadMixedLiveConfig, runMixedLive, teardownVerdict, STEPS, type MixedLiveConfig, type MixedLiveDeps } from "../../scripts/acceptance/mixed/live-run";
import { expectedChecksum, expectedPriceCents, type ReadbackSource, type StoredOrder } from "../../scripts/acceptance/mixed/readback";
import type { Requester } from "../../scripts/acceptance/mixed/traffic";
import { memoryStore } from "../../scripts/release/checkpoint";
import { Scope, ScopeError, loadManifestFile } from "../../scripts/release/scope";
import { approvedScope, unapprovedShippedFile } from "../release/_support";

const RUN = "zlive-202610071200-abcd";
const INSIDE_TTL = new Date("2026-10-07T12:30:00.000Z");
const PAST_TTL = new Date("2026-10-07T20:00:00.000Z");
const HEX = (c: string): string => c.repeat(64);

const ENV = {
  ZENITH_LIVE_MIXED: "1", ZENITH_LIVE_MIXED_API_URL: "https://zenith.example.test", ZENITH_LIVE_MIXED_WORKSPACE_ID: "ws_1", ZENITH_LIVE_MIXED_PLAN_ID: "mpp_1",
  ZENITH_LIVE_MIXED_TOKEN_FILE: path.resolve("/secure/token.txt"), ZENITH_LIVE_MIXED_ENTRY_URL: "https://app.example.test", ZENITH_LIVE_MIXED_READBACK_DB_URL_FILE: path.resolve("/secure/readback.txt"),
  ZENITH_LIVE_MIXED_BUDGET_USD: "20", ZENITH_LIVE_MIXED_TTL_MINUTES: "60", ZENITH_LIVE_MIXED_RUN_ID: RUN,
};

describe("configuration", () => {
  const skip = (over: Record<string, string | undefined>): string => { const r = loadMixedLiveConfig({ ...ENV, ...over }); return "skipReason" in r ? r.skipReason : ""; };

  it("is skipped, with the reason, unless explicitly enabled and fully referenced", () => {
    expect(skip({ ZENITH_LIVE_MIXED: undefined })).toContain("deferred");
    expect(skip({ ZENITH_LIVE_MIXED: "true" })).toContain("deferred");
    expect(skip({ ZENITH_LIVE_MIXED_ENTRY_URL: undefined })).toContain("ZENITH_LIVE_MIXED_ENTRY_URL");
    expect(skip({ ZENITH_LIVE_MIXED_READBACK_DB_URL_FILE: undefined, ZENITH_LIVE_MIXED_BUDGET_USD: undefined })).toMatch(/READBACK_DB_URL_FILE.*BUDGET_USD|BUDGET_USD.*READBACK_DB_URL_FILE/);
  });

  it("requires an explicit positive budget, a lifetime, credential FILES by absolute path and a valid run id", () => {
    expect(skip({ ZENITH_LIVE_MIXED_BUDGET_USD: "0" })).toContain("explicit per-run budget");
    expect(skip({ ZENITH_LIVE_MIXED_BUDGET_USD: "abc" })).toContain("explicit per-run budget");
    expect(skip({ ZENITH_LIVE_MIXED_TTL_MINUTES: "2" })).toContain("time to live");
    expect(skip({ ZENITH_LIVE_MIXED_TTL_MINUTES: "60.5" })).toContain("time to live");
    expect(skip({ ZENITH_LIVE_MIXED_TOKEN_FILE: "relative/token.txt" })).toContain("absolute path");
    expect(skip({ ZENITH_LIVE_MIXED_READBACK_DB_URL_FILE: "readback.txt" })).toContain("absolute path");
    expect(skip({ ZENITH_LIVE_MIXED_RUN_ID: "my-run" })).toContain("live-run id");
    expect(skip({ ZENITH_LIVE_MIXED_ORDERS: "0" })).toContain("ZENITH_LIVE_MIXED_ORDERS");
  });

  it("loads defaults and generates a run id of the disposable form when none is given", () => {
    const loaded = loadMixedLiveConfig({ ...ENV, ZENITH_LIVE_MIXED_RUN_ID: undefined }, () => new Date("2026-10-07T12:00:00Z"));
    expect("config" in loaded).toBe(true);
    if (!("config" in loaded)) return;
    expect(loaded.config).toMatchObject({ orders: 50, dbHostSuffix: ".postgres.database.azure.com", budgetUsd: 20, ttlMinutes: 60, sourceOutsideAllowlist: false });
    expect(loaded.config.runId).toMatch(/^zlive-202610071200-[a-z0-9]{4}$/);
  });
});

describe("teardownVerdict", () => {
  const steps = (...status: string[]) => ({ teardown: { steps: status.map((s) => ({ status: s })) } });
  it("reports what the control plane's own teardown ledger says and nothing more", () => {
    expect(teardownVerdict(undefined)).toBe("not_proposed");
    expect(teardownVerdict({})).toBe("not_proposed");
    expect(teardownVerdict(steps())).toBe("not_proposed");
    expect(teardownVerdict(steps("planned", "planned"))).toBe("pending_human_approval");
    expect(teardownVerdict(steps("destroyed", "released"))).toBe("in_progress");
    expect(teardownVerdict(steps("destroyed", "destroyed"))).toBe("torn_down");
    expect(teardownVerdict(steps("destroyed", "failed"))).toBe("needs_attention");
    expect(teardownVerdict(steps("uncertain", "planned"))).toBe("needs_attention");
  });
});

/* ------------------------------------------------------------------ fakes */

function planView(over: Record<string, unknown> = {}): Record<string, unknown> {
  const child = (ordinal: number, provider: string) => ({
    partitionId: `partition/p${ordinal}`, ordinal, childEnvironmentId: `env-${provider}`, dependsOn: ordinal === 0 ? [] : [`partition/p${ordinal - 1}`], subplanDigest: HEX(String(ordinal + 1)), semanticsDigest: HEX(String(ordinal + 2)),
    partition: { provider, accountId: `acct-${provider}`, region: "r-1", backendKind: "s3", backendDigest: HEX(String(ordinal + 3)), connectionId: `conn-${provider}`, connectionIdentityDigest: HEX(String(ordinal + 4)) },
    nodes: [{ stableAddress: `${provider}:r-1:abc::service/${provider}`, address: `service/${provider}` }], state: "succeeded", childOperationId: `op_${ordinal}`, executableSemanticsDigest: HEX(String(ordinal + 5)),
    receipt: { outcome: "succeeded", childOperationId: `op_${ordinal}`, ordinal, executableSemanticsDigest: HEX(String(ordinal + 5)), receiptDigest: HEX(String(ordinal + 6)) },
  });
  const children = [child(0, "azure"), child(1, "gcp"), child(2, "aws")];
  return {
    parentPlanId: "mpp_1", status: "succeeded", parentOperationId: "op_parent", childSetDigest: HEX("7"), executionOrder: children.map((c) => c.partitionId), teardownOrder: children.map((c) => c.partitionId).reverse(), children,
    connectivity: { digest: HEX("9"), vpnOptIn: false, endpoints: [{ id: "ep1", dataClass: "database", host: "db.mixed.example.com", port: 5432, dnsTargets: ["20.20.20.10"], tlsMinVersion: "1.3", serverNames: ["db.mixed.example.com"], serverSpkiSha256: HEX("a"), allowlist: ["34.1.1.1"] }] },
    ...over,
  };
}

function economics(over: { monthly?: number; byProvider?: Record<string, number>; priced?: boolean } = {}): { report: MixedEconomicsReport } {
  if (over.priced === false) return { report: { kind: "mixed_economics", priced: false, notABillingCap: true, reason: "no price for azure/eastus", residency: { required: [], violations: [], satisfied: true }, notes: [] } };
  return { report: { kind: "mixed_economics", priced: true, notABillingCap: true, catalogVersion: "test", computedAt: "2026-10-07T00:00:00Z", currency: "USD", monthlyUsd: over.monthly ?? 100, byProvider: over.byProvider ?? { gcp: 40, aws: 20, azure: 40 }, transfers: [], transferUsd: 0, transferShare: 0, latency: [], residency: { required: [], violations: [], satisfied: true }, assumptions: {}, excluded: [], notes: [] } };
}

const GOOD_ATTEMPT: TlsAttempt = { outcome: "established", protocol: "TLSv1.3", spkiSha256: HEX("a"), names: ["db.mixed.example.com"], authorized: true, answered: true };
const goodProbeIo: ProbeIo = {
  resolve: async () => ["20.20.20.10"],
  tlsConnect: async (r) => (r.maxVersion === "TLSv1.1" ? { outcome: "refused", reason: "handshake_failed" } : !r.client ? { outcome: "refused", reason: "closed_after_handshake" } : GOOD_ATTEMPT),
};

interface Rig { deps: MixedLiveDeps; calls: string[]; rows: StoredOrder[]; sent: number; config: MixedLiveConfig }

function rig(over: { config?: Partial<MixedLiveConfig>; plan?: Record<string, unknown>; econ?: ReturnType<typeof economics>; run?: unknown; now?: Date; dropRow?: boolean; probeIo?: ProbeIo; store?: ReturnType<typeof memoryStore>; scope?: Scope; failReadback?: () => boolean; outDir?: string } = {}): Rig {
  const calls: string[] = [];
  const rows: StoredOrder[] = [];
  const state = { sent: 0 };
  const outDir = over.outDir ?? mkdtempSync(path.join(os.tmpdir(), "zmixlive-"));
  const loaded = loadMixedLiveConfig({ ...ENV, ZENITH_LIVE_MIXED_OUT_DIR: outDir, ZENITH_LIVE_MIXED_CLIENT_CERT_FILE: path.resolve("/secure/cert.pem"), ZENITH_LIVE_MIXED_CLIENT_KEY_FILE: path.resolve("/secure/key.pem") });
  if (!("config" in loaded)) throw new Error(loaded.skipReason);
  const config = { ...loaded.config, ...over.config };
  const requester: Requester = async (request) => {
    state.sent += 1;
    const order = JSON.parse(request.body!) as { clientKey: string; sku: string; qty: number };
    const priceCents = expectedPriceCents(order.sku, order.qty)!;
    const checksum = expectedChecksum({ ...order, priceCents });
    const existing = rows.find((r) => r.clientKey === order.clientKey);
    if (!existing) rows.push({ ...order, priceCents, checksum, webProvider: "gcp", enricherProvider: "aws" });
    return { status: existing ? 200 : 201, body: JSON.stringify({ ...order, priceCents, checksum, webProvider: "gcp", enricherProvider: "aws" }) };
  };
  const readback = async (): Promise<ReadbackSource & { close?(): Promise<void> }> => {
    if (over.failReadback?.()) throw new Error("database unreachable");
    return { describe: () => ({ channel: "direct_database", kind: "postgres", host: "mixed.postgres.database.azure.com" }), fetchByPrefix: async (prefix) => rows.filter((r) => r.clientKey.startsWith(prefix) && !(over.dropRow && r.clientKey.endsWith("-3"))) };
  };
  const getJson = async (pathname: string): Promise<unknown> => {
    calls.push(pathname);
    if (pathname.includes("/economics")) return over.econ ?? economics();
    if (pathname.includes("/mixed-run")) return { run: over.run ?? {} };
    if (pathname.includes("/mixed/plans/")) return over.plan ?? planView();
    throw new Error(`unexpected request ${pathname}`);
  };
  const now = over.now ?? INSIDE_TTL;
  const deps: MixedLiveDeps = { scope: over.scope ?? approvedScope(undefined, now), getJson, requester, probeIo: over.probeIo ?? goodProbeIo, readback, readFile: () => Buffer.from("not a real credential"), store: over.store ?? memoryStore(), now: () => now, env: {} };
  return { deps, calls, rows, get sent() { return state.sent; }, config } as Rig;
}

const byStep = (report: Awaited<ReturnType<typeof runMixedLive>>, step: string) => report.results.find((r) => r.step === step)!;

/* -------------------------------------------------------------------- runs */

describe("the harness", () => {
  it("refuses without an approved scope and makes no call", async () => {
    const r = rig({ scope: new Scope(loadManifestFile(unapprovedShippedFile()), () => INSIDE_TTL) });
    await expect(runMixedLive(r.config, r.deps)).rejects.toMatchObject({ code: "not_approved" });
    expect(r.calls).toEqual([]);
    expect(r.sent).toBe(0);
  });

  it("runs every step on a consistent deployment, reports teardown as not proposed and never claims it destroyed anything", async () => {
    const r = rig();
    const report = await runMixedLive(r.config, r.deps);
    expect(report.results.map((x) => x.step)).toEqual([...STEPS]);
    expect(report.results.filter((x) => x.step !== "teardown-check").map((x) => x.status)).toEqual(Array(6).fill("passed"));
    expect(byStep(report, "teardown-check")).toMatchObject({ status: "skipped" });
    expect(byStep(report, "teardown-check").detail).toContain("person-approved");
    expect(report).toMatchObject({ ok: true, provenance: "live", teardown: { verdict: "not_proposed", overdue: false }, resumed: false });
    expect(report.ledgerDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(r.sent).toBe(50 + 5);
    expect(r.rows).toHaveLength(50);
    expect(byStep(report, "readback").detail).toContain("50/50");
    expect(byStep(report, "connectivity-probes").detail).toContain("NOT checked from here: allowlist_denial");
    expect(report.nextCommands.join("\n")).toContain(RUN);
    expect(report.nextCommands.join("\n")).toContain("cleanup-cli.ts --run-id");
  });

  it("checkpoints every step, with teardown recorded as not done", async () => {
    const store = memoryStore();
    const r = rig({ store });
    await runMixedLive(r.config, r.deps);
    const state = store.snapshot()!;
    expect(state.unattendedClaims).toBe(false);
    expect(state.steps.filter((s) => s.status === "done").map((s) => s.id)).toEqual(STEPS.filter((s) => s !== "teardown-check"));
    expect(state.steps.find((s) => s.id === "teardown-check")!.status).toBe("failed");
    expect(state.nextCommands.length).toBeGreaterThan(0);
  });

  it("fails closed: a step that did not pass blocks every later acting step", async () => {
    const r = rig({ econ: economics({ priced: false }) });
    const report = await runMixedLive(r.config, r.deps);
    expect(byStep(report, "budget-admission")).toMatchObject({ status: "failed" });
    for (const step of ["verify-plan-evidence", "connectivity-probes", "traffic", "readback"]) expect(byStep(report, step)).toMatchObject({ status: "skipped", detail: expect.stringContaining("budget-admission") });
    expect(r.sent).toBe(0);
    expect(report.ok).toBe(false);
  });

  it("enforces the explicit budget cap and the approved per-provider budgets", async () => {
    const over = rig({ config: { budgetUsd: 0.01 } });
    const a = await runMixedLive(over.config, over.deps);
    expect(byStep(a, "budget-admission").detail).toContain("exceeds the run budget");
    expect(over.sent).toBe(0);
    // aws slice of $20 for the run window is inside the $30 run cap but over the approved $10 aws budget
    const provider = rig({ econ: economics({ monthly: 14_600 + 100, byProvider: { aws: 14_600, gcp: 50, azure: 50 } }), config: { budgetUsd: 30 } });
    const b = await runMixedLive(provider.config, provider.deps);
    expect(byStep(b, "budget-admission")).toMatchObject({ status: "failed" });
    expect(byStep(b, "budget-admission").detail).toContain("budget_exceeded");
    expect(provider.sent).toBe(0);
  });

  it("refuses a run that asks for more than the approved budget or lifetime", async () => {
    const a = rig({ config: { budgetUsd: 31 } });
    expect(byStep(await runMixedLive(a.config, a.deps), "scope-and-gates").detail).toContain("exceeds the approved per-run budget");
    const b = rig({ config: { ttlMinutes: 241 } });
    const report = await runMixedLive(b.config, b.deps);
    expect(byStep(report, "scope-and-gates").detail).toContain("exceeds the approved");
    expect(report.results.filter((x) => x.step !== "teardown-check" && x.step !== "scope-and-gates").every((x) => x.status === "skipped")).toBe(true);
  });

  it("refuses a plan whose evidence is incomplete or that declares no protected endpoints", async () => {
    const incomplete = rig({ plan: planView({ status: "running" }) });
    const a = await runMixedLive(incomplete.config, incomplete.deps);
    expect(byStep(a, "verify-plan-evidence")).toMatchObject({ status: "failed" });
    expect(incomplete.sent).toBe(0);
    const bare = rig({ plan: planView({ connectivity: null }) });
    const b = await runMixedLive(bare.config, bare.deps);
    expect(byStep(b, "connectivity-probes").detail).toContain("no protected-endpoint declaration");
    expect(bare.sent).toBe(0);
  });

  it("does not count failed or skipped connectivity probes as a pass and sends no traffic after them", async () => {
    const stray: ProbeIo = { ...goodProbeIo, resolve: async () => ["6.6.6.6"] };
    const a = rig({ probeIo: stray });
    const report = await runMixedLive(a.config, a.deps);
    expect(byStep(report, "connectivity-probes").status).toBe("failed");
    expect(a.sent).toBe(0);
    const noCert = rig({ config: { clientCertFile: undefined, clientKeyFile: undefined } });
    const b = await runMixedLive(noCert.config, noCert.deps);
    expect(byStep(b, "connectivity-probes").status).toBe("skipped");
    expect(noCert.sent).toBe(0);
    expect(b.ok).toBe(false);
  });

  it("fails when the independent readback disagrees with what was acknowledged", async () => {
    const r = rig({ dropRow: true });
    const report = await runMixedLive(r.config, r.deps);
    expect(byStep(report, "traffic").status).toBe("passed");
    expect(byStep(report, "readback")).toMatchObject({ status: "failed" });
    expect(byStep(report, "readback").problems!.join("|")).toContain("is not in the database");
    expect(report.ok).toBe(false);
  });

  it("is overdue, loudly, when the lifetime passed without a completed teardown", async () => {
    const r = rig({ now: PAST_TTL });
    const report = await runMixedLive(r.config, r.deps);
    expect(report.teardown.overdue).toBe(true);
    expect(report.teardown.deadline).toBe("2026-10-07T13:00:00.000Z");
    expect(report.ok).toBe(false);
    expect(byStep(report, "teardown-check").detail).toContain("OVERDUE");
    const torn = rig({ now: PAST_TTL, run: { teardown: { steps: [{ status: "destroyed" }, { status: "destroyed" }] } } });
    const done = await runMixedLive(torn.config, torn.deps);
    expect(done.teardown).toMatchObject({ verdict: "torn_down", overdue: false });
    expect(done.ok).toBe(true);
  });

  it("resumes after an interruption without repeating steps that passed", async () => {
    const store = memoryStore();
    const outDir = mkdtempSync(path.join(os.tmpdir(), "zmixlive-resume-"));
    let down = true;
    const first = rig({ store, outDir, failReadback: () => down });
    const r1 = await runMixedLive(first.config, first.deps);
    expect(byStep(r1, "traffic").status).toBe("passed");
    expect(byStep(r1, "readback")).toMatchObject({ status: "failed" });
    expect(r1.ok).toBe(false);
    down = false;
    const sentBefore = first.sent;
    const economicsCallsBefore = first.calls.filter((c) => c.includes("/economics")).length;
    const second = rig({ store, outDir });
    // the database is what the first run left behind
    second.rows.push(...first.rows);
    const r2 = await runMixedLive(second.config, second.deps);
    expect(second.calls.filter((c) => c.includes("/economics"))).toHaveLength(0);
    expect(economicsCallsBefore).toBe(1);
    expect(second.sent).toBe(0);
    expect(sentBefore).toBeGreaterThan(0);
    expect(byStep(r2, "readback")).toMatchObject({ status: "passed" });
    expect(r2.resumed).toBe(true);
    expect(r2.ok).toBe(true);
    expect(JSON.parse(readFileSync(path.join(outDir, RUN, "traffic-ledger.json"), "utf8")).runId).toBe(RUN);
  });
});

describe("scope errors are typed", () => {
  it("is a ScopeError that callers can tell apart", async () => {
    const r = rig({ scope: new Scope(loadManifestFile(unapprovedShippedFile()), () => INSIDE_TTL) });
    await expect(runMixedLive(r.config, r.deps)).rejects.toBeInstanceOf(ScopeError);
  });
});
