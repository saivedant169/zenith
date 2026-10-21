/**
 * PROD-REL-01: the acceptance orchestrator. Contract level: the command runner is a fake that records argv and writes the
 * JSON a vitest run would write; nothing is executed and no cloud is reached. What is asserted is the honesty of the
 * report: a skip, a deferral or a missing gate is never a pass.
 */
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { classifyVitest, runAcceptance, runOrchestratorCli, scenarioStatus, type Exec, type LaneResult } from "../../scripts/release/acceptance-orchestrator";
import { memoryStore } from "../../scripts/release/checkpoint";
import { SCENARIOS, type Scenario } from "../../scripts/release/scenarios";
import { Scope, loadManifestFile } from "../../scripts/release/scope";
import { NOW, approvedScope, shippedManifestPath } from "./_support";

interface Plan { fail?: string[]; skip?: string[]; empty?: string[]; liveExit?: number }

function fakeExec(plan: Plan = {}): { exec: Exec; calls: string[][] } {
  const calls: string[][] = [];
  const exec: Exec = async (argv) => {
    calls.push([...argv]);
    const out = argv.find((a) => a.startsWith("--outputFile="));
    if (argv[0] === "git") return { code: 0, stdout: "0123456789abcdef0123456789abcdef01234567\n", stderr: "" };
    if (!out) return { code: plan.liveExit ?? 0, stdout: "", stderr: "" };
    const file = out.slice("--outputFile=".length);
    const failing = (plan.fail ?? []).some((id) => file.includes(`-${id}-`));
    const skipping = (plan.skip ?? []).some((id) => file.includes(`-${id}-`));
    const empty = (plan.empty ?? []).some((id) => file.includes(`-${id}-`));
    writeFileSync(file, JSON.stringify({ numPassedTests: empty ? 0 : 5, numFailedTests: failing ? 1 : 0, numPendingTests: skipping ? 2 : 0, numTodoTests: 0 }));
    return { code: failing ? 1 : 0, stdout: "", stderr: "" };
  };
  return { exec, calls };
}

const outDir = (): string => mkdtempSync(path.join(os.tmpdir(), "zaccept-"));
const base = (over: Partial<Parameters<typeof runAcceptance>[0]> = {}) => ({ root: process.cwd(), outDir: outDir(), runId: "run-1", includeLive: false, ...over });
const byId = (r: Awaited<ReturnType<typeof runAcceptance>>, id: string) => r.scenarios.find((s) => s.id === id)!;

describe("classifyVitest", () => {
  it("never calls skips, missing output or zero tests a clean pass", () => {
    expect(classifyVitest(0, { numPassedTests: 4 }).status).toBe("passed");
    expect(classifyVitest(0, { numPassedTests: 4, numPendingTests: 1 }).status).toBe("passed_with_skips");
    expect(classifyVitest(0, { numPassedTests: 4, numTodoTests: 1 }).status).toBe("passed_with_skips");
    expect(classifyVitest(0, { numPassedTests: 0, numPendingTests: 3 }).status).toBe("no_tests");
    expect(classifyVitest(0, undefined).status).toBe("no_tests");
    expect(classifyVitest(1, undefined).status).toBe("failed");
    expect(classifyVitest(1, { numPassedTests: 9, numFailedTests: 1 }).status).toBe("failed");
    expect(classifyVitest(0, { numPassedTests: 9, numFailedTests: 1 }).status).toBe("failed");
  });
});

describe("scenarioStatus", () => {
  const lane = (status: LaneResult["status"], kind: LaneResult["kind"] = "local_engine"): LaneResult => ({ scenarioId: "s", laneId: "l", kind, status, detail: "" });
  const withLive: Pick<Scenario, "lanes"> = { lanes: [{ id: "a", kind: "contract", files: [] }, { id: "b", kind: "live_sandbox", command: [], files: [], scopeHarness: "x", gates: [], skipExitCodes: [], deferredBecause: "because" }] };
  const withoutLive: Pick<Scenario, "lanes"> = { lanes: [{ id: "a", kind: "contract", files: [] }] };
  it("derives a status that is only verified_live when the live lane passed", () => {
    expect(scenarioStatus(withLive, [lane("passed", "contract"), lane("passed_live", "live_sandbox")])).toBe("verified_live");
    expect(scenarioStatus(withLive, [lane("passed", "contract"), lane("deferred", "live_sandbox")])).toBe("local_passed_live_pending");
    expect(scenarioStatus(withLive, [lane("passed", "contract"), lane("skipped", "live_sandbox")])).toBe("local_passed_live_pending");
    expect(scenarioStatus(withoutLive, [lane("passed", "contract")])).toBe("local_passed");
    expect(scenarioStatus(withoutLive, [lane("passed_with_skips", "contract")])).toBe("incomplete");
    expect(scenarioStatus(withoutLive, [lane("failed", "contract")])).toBe("failed");
    expect(scenarioStatus(withLive, [lane("passed", "contract"), lane("failed", "live_sandbox")])).toBe("failed");
    expect(scenarioStatus(withoutLive, [lane("not_run", "contract")])).toBe("not_run");
  });
});

describe("runAcceptance", () => {
  it("runs local lanes, defers live lanes and never reports a deferred lane as a pass", async () => {
    const { exec, calls } = fakeExec();
    const report = await runAcceptance(base({ only: ["install", "stateful-traffic"] }), { exec, store: memoryStore(), now: () => NOW });
    expect(byId(report, "install").status).toBe("local_passed");
    const stateful = byId(report, "stateful-traffic");
    expect(stateful.status).toBe("local_passed_live_pending");
    expect(stateful.lanes.find((l) => l.kind === "live_sandbox")).toMatchObject({ status: "deferred" });
    expect(report.summary).toMatchObject({ total: 2, local_passed: 1, local_passed_live_pending: 1, verified_live: 0 });
    expect(report.statement).toContain("not-run lane is not evidence");
    expect(calls.some((c) => c.includes("scripts/acceptance/mixed/live-run.ts"))).toBe(false);
    expect(calls.filter((c) => c[0] === "node").every((c) => c.includes("--maxWorkers=1") && c.includes("--reporter=json"))).toBe(true);
    expect(report.sourceCommit).toBe("0123456789abcdef0123456789abcdef01234567");
  });

  it("records a failing lane as failed and a skipping lane as incomplete", async () => {
    const { exec } = fakeExec({ fail: ["drift-repair"], skip: ["rotation"], empty: ["export"] });
    const report = await runAcceptance(base({ only: ["drift-repair", "rotation", "export", "install"] }), { exec, store: memoryStore(), now: () => NOW });
    expect(byId(report, "drift-repair").status).toBe("failed");
    expect(byId(report, "rotation").status).toBe("incomplete");
    expect(byId(report, "rotation").lanes[0]!.detail).toContain("SKIPPED");
    expect(byId(report, "export").status).toBe("incomplete");
    expect(byId(report, "install").status).toBe("local_passed");
    expect(report.summary.failed).toBe(1);
  });

  it("does not run live lanes without --include-live, an approved scope and the harness gates", async () => {
    const unapproved = new Scope(loadManifestFile(shippedManifestPath()), () => NOW);
    const a = fakeExec();
    const r1 = await runAcceptance(base({ only: ["mixed-recovery"], includeLive: true }), { exec: a.exec, store: memoryStore(), now: () => NOW, scope: unapproved, env: {} });
    const live1 = byId(r1, "mixed-recovery").lanes.find((l) => l.kind === "live_sandbox")!;
    expect(live1.status).toBe("deferred");
    expect(live1.detail).toContain("scope manifest refuses");
    expect(a.calls.some((c) => c.includes("scripts/acceptance/mixed/live-recovery.ts"))).toBe(false);

    const b = fakeExec();
    const r2 = await runAcceptance(base({ only: ["mixed-recovery"], includeLive: true }), { exec: b.exec, store: memoryStore(), now: () => NOW, scope: approvedScope(), env: {} });
    const live2 = byId(r2, "mixed-recovery").lanes.find((l) => l.kind === "live_sandbox")!;
    expect(live2.status).toBe("deferred");
    expect(live2.missingGates).toContain("ZENITH_LIVE_MIXED=1");
    expect(b.calls.some((c) => c.includes("scripts/acceptance/mixed/live-recovery.ts"))).toBe(false);
  });

  it("runs a live lane only when everything is in place, and keeps a declined harness a skip", async () => {
    const env = { ZENITH_LIVE_MIXED: "1", ZENITH_LIVE_MIXED_RECOVERY: "1", ZENITH_LIVE_MIXED_FAULT: "blackhole", ZENITH_LIVE_MIXED_RUN_ID: "zlive-202610071200-abcd", ZENITH_LIVE_MIXED_ENTRY_URL: "https://x.example", ZENITH_LIVE_MIXED_READBACK_DB_URL_FILE: "/f" };
    const declined = fakeExec({ liveExit: 2 });
    const r1 = await runAcceptance(base({ only: ["mixed-recovery"], includeLive: true }), { exec: declined.exec, store: memoryStore(), now: () => NOW, scope: approvedScope(), env });
    expect(byId(r1, "mixed-recovery").lanes.find((l) => l.kind === "live_sandbox")).toMatchObject({ status: "skipped" });
    expect(byId(r1, "mixed-recovery").status).toBe("local_passed_live_pending");

    const ok = fakeExec({ liveExit: 0 });
    const r2 = await runAcceptance(base({ only: ["mixed-recovery"], includeLive: true }), { exec: ok.exec, store: memoryStore(), now: () => NOW, scope: approvedScope(), env });
    expect(ok.calls.some((c) => c.includes("scripts/acceptance/mixed/live-recovery.ts"))).toBe(true);
    expect(byId(r2, "mixed-recovery").status).toBe("verified_live");

    const failed = fakeExec({ liveExit: 1 });
    const r3 = await runAcceptance(base({ only: ["mixed-recovery"], includeLive: true }), { exec: failed.exec, store: memoryStore(), now: () => NOW, scope: approvedScope(), env });
    expect(byId(r3, "mixed-recovery").status).toBe("failed");
  });

  it("resumes: a lane that passed is not run again; a failed one is", async () => {
    const store = memoryStore();
    const dir = outDir();
    const first = fakeExec({ fail: ["rotation"] });
    const r1 = await runAcceptance({ root: process.cwd(), outDir: dir, runId: "resume-1", includeLive: false, only: ["install", "rotation"] }, { exec: first.exec, store, now: () => NOW });
    expect(byId(r1, "rotation").status).toBe("failed");
    const second = fakeExec();
    const r2 = await runAcceptance({ root: process.cwd(), outDir: dir, runId: "resume-1", includeLive: false, only: ["install", "rotation"] }, { exec: second.exec, store, now: () => NOW });
    expect(byId(r2, "install").status).toBe("local_passed");
    expect(byId(r2, "rotation").status).toBe("local_passed");
    const reran = second.calls.filter((c) => c[0] === "node");
    expect(reran).toHaveLength(1);
    expect(reran[0]!.some((a) => a.includes("-rotation-"))).toBe(true);
    const saved = JSON.parse(readFileSync(path.join(dir, "resume-1", "acceptance-report.json"), "utf8")) as { summary: { failed: number } };
    expect(saved.summary.failed).toBe(0);
  });

  it("rejects unknown scenarios and unsafe run ids", async () => {
    await expect(runAcceptance(base({ only: ["nope"] }), { exec: fakeExec().exec, store: memoryStore() })).rejects.toThrow("Unknown scenario");
    await expect(runAcceptance(base({ runId: "bad id & x" }), { exec: fakeExec().exec, store: memoryStore() })).rejects.toThrow("run id");
  });

  it("covers every scenario in the map when run unrestricted", async () => {
    const { exec } = fakeExec();
    const report = await runAcceptance(base({ runId: "all-1" }), { exec, store: memoryStore(), now: () => NOW });
    expect(report.scenarios.map((s) => s.id)).toEqual(SCENARIOS.map((s) => s.id));
    expect(report.summary.verified_live).toBe(0);
    expect(report.scenarios.every((s) => s.lanes.filter((l) => l.kind === "live_sandbox").every((l) => l.status === "deferred"))).toBe(true);
  });
});

describe("cli", () => {
  const io = () => { const out: string[] = []; const err: string[] = []; return { out, err, io: { out: (s: string) => { out.push(s); }, err: (s: string) => { err.push(s); } } }; };
  it("lists and checks the map", async () => {
    const a = io();
    expect(await runOrchestratorCli(["list"], a.io)).toBe(0);
    expect(a.out.join("")).toContain("stateful-traffic");
    const b = io();
    expect(await runOrchestratorCli(["check"], b.io)).toBe(0);
    expect(b.out.join("")).toContain("all present");
    const c = io();
    expect(await runOrchestratorCli(["nope"], c.io)).toBe(2);
  });
});

describe("forwardOperatedDiagnostics", () => {
  it("forwards only fixed-format diagnostic lines, and only with the opt-in flag", async () => {
    const { forwardOperatedDiagnostics } = await import("../../scripts/release/acceptance-orchestrator");
    const stderr = ["operated step browser-approved-deployments failed: journey:approval-required", "secret=hunter2 at /etc/zenith/key", "command-failed docker compose up exit=1 []", "operated outside-step failed: unclassified Error"].join("\n");
    const lines: string[] = [];
    forwardOperatedDiagnostics({}, stderr, line => lines.push(line));
    expect(lines).toEqual([]);
    forwardOperatedDiagnostics({ ZENITH_OPERATED_DIAGNOSTICS: "1" }, stderr, line => lines.push(line));
    expect(lines.join("")).not.toContain("hunter2");
    expect(lines).toHaveLength(3);
  });
});
