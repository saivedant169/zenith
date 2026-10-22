/**
 * End-to-end release acceptance orchestrator (PROD-REL-01).
 *
 *   npx tsx scripts/release/acceptance-orchestrator.ts list
 *   npx tsx scripts/release/acceptance-orchestrator.ts check                      every mapped file exists; required scenarios present
 *   npx tsx scripts/release/acceptance-orchestrator.ts run [--only a,b] [--out DIR] [--run-id ID] [--include-live]
 *
 * `run` executes the LOCAL lanes of each scenario with vitest (one process per lane, one worker), records what really
 * happened (passed, failed, how many tests skipped) and writes `acceptance-report.json`. LIVE lanes are never run
 * unless `--include-live` is given AND the scope manifest is approved by a person AND the harness's own gates are set;
 * otherwise they are recorded as `deferred` with the reason. A live harness that declines to run (exit code 2) is
 * `skipped`. Nothing here converts a deferred, skipped or unperformed lane into a pass.
 *
 * Scenario status (never plain "passed"):
 *   failed                      a lane failed
 *   not_run                     nothing ran
 *   incomplete                  a local lane skipped tests or ran none
 *   local_passed                every local lane passed and the scenario has no live lane
 *   local_passed_live_pending   every local lane passed; the live lane is deferred or skipped
 *   verified_live               every local lane passed AND every live lane passed
 *
 * Resumable: lane results are checkpointed (`checkpoint.json` in the run directory) and a resumed run does not repeat
 * a lane that finished. The checkpoint never claims unattended work.
 */
import { mkdirSync, existsSync, readFileSync, writeFileSync, unlinkSync, readdirSync, realpathSync } from "node:fs";
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { digest } from "@/lib/controlplane/digest";
import { RunCheckpoint, fileStore, type CheckpointStore } from "./checkpoint";
import { REQUIRED_SCENARIO_IDS, SCENARIOS, allLaneFiles, type Lane, type LiveLane, type LocalCommandLane, type Scenario } from "./scenarios";
import { Scope, ScopeError, defaultManifestPath, loadScope } from "./scope";
import { localTargetLane, validateLocalReceipt, localEnvironment } from "./local-targets";
import { sourceBinding } from "../deploy/installation.mjs";

export type LaneStatus = "passed" | "passed_with_skips" | "no_tests" | "failed" | "not_run" | "deferred" | "skipped" | "passed_live";
export interface LaneResult { scenarioId: string; laneId: string; kind: Lane["kind"]; status: LaneStatus; detail: string; counts?: { passed: number; failed: number; skipped: number }; command?: string[]; missingGates?: string[]; evidenceLabel?: LocalCommandLane["evidenceLabel"]; limits?: string[] }

export type ScenarioStatus = "failed" | "not_run" | "incomplete" | "local_passed" | "local_passed_live_pending" | "verified_live";
export interface ScenarioResult { id: string; title: string; requirements: readonly string[]; status: ScenarioStatus; lanes: LaneResult[]; limits: string }

export interface AcceptanceReport {
  schema: 1;
  runId: string;
  generatedAt: string;
  sourceCommit: string | null;
  /** Current harness/fixture/config bytes, also bound into the checkpoint. */
  harnessDigest?: string;
  scenarios: ScenarioResult[];
  summary: Record<ScenarioStatus, number> & { total: number };
  /** always present: what this report is not */
  statement: string;
}

export interface ExecResult { code: number; stdout: string; stderr: string }
export type Exec = (argv: readonly string[], options: { cwd: string; timeoutMs: number; env?: NodeJS.ProcessEnv }) => Promise<ExecResult>;

export const defaultExec: Exec = (argv, options) => new Promise((resolve) => {
  const child = spawn(argv[0]!, argv.slice(1), { cwd: options.cwd, env: options.env ?? process.env, stdio: ["ignore", "pipe", "pipe"], shell: process.platform === "win32" && argv[0] === "npx" });
  let stdout = ""; let stderr = "";
  const timer = setTimeout(() => child.kill("SIGKILL"), options.timeoutMs);
  child.stdout.on("data", (c: Buffer) => { stdout = (stdout + c.toString()).slice(-20_000); });
  // Diagnostics only: relay the child's fixed-format diagnostic lines as they arrive, so a hung child still reports.
  const env = options.env ?? process.env;
  let pending = "";
  child.stderr.on("data", (c: Buffer) => {
    stderr = (stderr + c.toString()).slice(-20_000);
    if (env.ZENITH_OPERATED_DIAGNOSTICS !== "1") return;
    pending = (pending + c.toString()).slice(-8_192);
    const lines = pending.split("\n"); pending = lines.pop() ?? "";
    forwardOperatedDiagnostics(env, lines.join("\n"));
  });
  child.on("close", (code) => { clearTimeout(timer); resolve({ code: code ?? 1, stdout, stderr }); });
  child.on("error", () => { clearTimeout(timer); resolve({ code: 127, stdout, stderr: `${stderr}\ncould not start ${argv[0]}` }); });
});

/** Diagnostics only: forward a child's already-sanitized fixed-format diagnostic lines, never any other output. */
export function forwardOperatedDiagnostics(env: Readonly<Record<string, string | undefined>>, stderr: string, write: (line: string) => void = line => { process.stderr.write(line); }): void {
  if (env.ZENITH_OPERATED_DIAGNOSTICS !== "1") return;
  for (const line of stderr.split("\n")) {
    if (/^(?:operated (?:step [a-z0-9-]+|outside-step) failed: |command-failed |peer-unready |http-refused |restore-cli |mcp-refused )/.test(line)) { write(line.slice(0, 600) + "\n"); continue; }
    // An uncaught error bypasses the driver's own diagnosis: relay only its class and Node code, never message or stack.
    const uncaught = /^\s*(?:Uncaught )?([A-Z][A-Za-z]{0,40}Error)(?: \[([A-Z0-9_]{1,60})\])?:/.exec(line);
    if (uncaught) write(`child-uncaught ${uncaught[1]}${uncaught[2] ? " " + uncaught[2] : ""}\n`);
  }
}

const STATEMENT = "Local target results are local rehearsal, never live or production signoff. Component lanes alone do not establish an end-to-end journey. This report records which lanes actually ran. A deferred, skipped or not-run lane is not evidence of anything. A scenario is verified_live only when every lane, including the live harness, passed.";

export function missingFiles(root: string, scenarios: readonly Scenario[] = SCENARIOS, exists: (p: string) => boolean = existsSync): string[] {
  return allLaneFiles(scenarios).filter((file) => !exists(path.join(root, file)));
}

export function gateName(gate: string): { name: string; value?: string } | undefined {
  const m = /^([A-Z][A-Z0-9_]+)(?:=(\S+))?/.exec(gate);
  return m ? { name: m[1]!, ...(m[2] ? { value: m[2] } : {}) } : undefined;
}

export function missingGates(lane: Pick<LiveLane, "gates">, env: Readonly<Record<string, string | undefined>>): string[] {
  const out: string[] = [];
  for (const gate of lane.gates) {
    const parsed = gateName(gate);
    if (!parsed || gate.includes("(")) continue; // annotations such as "(approved)" are checked by the scope manifest
    const actual = env[parsed.name];
    if (!actual || (parsed.value !== undefined && actual !== parsed.value)) out.push(gate);
  }
  return out;
}

interface VitestJson { numPassedTests?: number; numFailedTests?: number; numPendingTests?: number; numTodoTests?: number }

export function classifyVitest(code: number, json: VitestJson | undefined): { status: LaneStatus; detail: string; counts?: { passed: number; failed: number; skipped: number } } {
  if (json && [json.numPassedTests, json.numFailedTests, json.numPendingTests, json.numTodoTests].some(n => n !== undefined && (!Number.isSafeInteger(n) || n < 0))) return { status: "failed", detail: "vitest counts are malformed; no evidence accepted" };
  if (!json) return { status: code === 0 ? "no_tests" : "failed", detail: code === 0 ? "vitest produced no readable result" : `vitest exited ${code} without a readable result` };
  const counts = { passed: json.numPassedTests ?? 0, failed: json.numFailedTests ?? 0, skipped: (json.numPendingTests ?? 0) + (json.numTodoTests ?? 0) };
  if (code !== 0 || counts.failed > 0) return { status: "failed", detail: `${counts.failed} failed, ${counts.passed} passed, ${counts.skipped} skipped (exit ${code})`, counts };
  if (counts.passed === 0) return { status: "no_tests", detail: `no test ran (${counts.skipped} skipped)`, counts };
  if (counts.skipped > 0) return { status: "passed_with_skips", detail: `${counts.passed} passed, ${counts.skipped} SKIPPED (a skip is not a pass)`, counts };
  return { status: "passed", detail: `${counts.passed} passed`, counts };
}

export function scenarioStatus(scenario: Pick<Scenario, "lanes">, lanes: readonly LaneResult[]): ScenarioStatus {
  if (lanes.some((l) => l.status === "failed")) return "failed";
  const local = lanes.filter((l) => l.kind !== "live_sandbox");
  const live = lanes.filter((l) => l.kind === "live_sandbox");
  if (lanes.every((l) => l.status === "not_run")) return "not_run";
  if (local.length === 0 || local.some((l) => l.status !== "passed")) return "incomplete";
  if (live.length === 0) return scenario.lanes.some((l) => l.kind === "live_sandbox") ? "incomplete" : "local_passed";
  return live.every((l) => l.status === "passed_live") ? "verified_live" : "local_passed_live_pending";
}

export interface RunOptions {
  root: string;
  outDir: string;
  runId: string;
  only?: readonly string[];
  includeLive: boolean;
  /** Adds genuine gated local scenario targets alongside the component lanes. */
  localTargets?: boolean;
  timeoutMs?: number;
  scenarios?: readonly Scenario[];
}
export interface RunDeps {
  exec?: Exec;
  env?: Readonly<Record<string, string | undefined>>;
  now?: () => Date;
  store?: CheckpointStore;
  readFile?: (file: string) => string;
  scope?: Scope | ScopeError;
}

export async function runAcceptance(options: RunOptions, deps: RunDeps = {}): Promise<AcceptanceReport> {
  const exec = deps.exec ?? defaultExec;
  const env = options.localTargets ? localEnvironment(deps.env ?? process.env) : deps.env ?? process.env;
  const now = deps.now ?? (() => new Date());
  const readFile = deps.readFile ?? ((file: string) => readFileSync(file, "utf8"));
  if (options.localTargets && options.includeLive) throw new Error("Local targets and live execution must use separate runs.");
  const scenarios = (options.scenarios ?? SCENARIOS).filter((s) => !options.only || options.only.includes(s.id)).map(s =>
    options.localTargets ? { ...s, lanes: [...s.lanes, localTargetLane(s)] } : s);
  const sourceCommit = await exec(["git", "rev-parse", "HEAD"], { cwd: options.root, timeoutMs: 10_000 }).then(r => r.code === 0 ? r.stdout.trim() : null).catch(() => null);
  if (options.localTargets && env.ZENITH_LOCAL_RUN_ID !== options.runId) throw new Error("Run id must match ZENITH_LOCAL_RUN_ID for local targets.");
  if (options.only) {
    const unknown = options.only.filter((id) => !(options.scenarios ?? SCENARIOS).some((s) => s.id === id));
    if (unknown.length) throw new Error(`Unknown scenario ${unknown.join(", ").slice(0, 80)}.`);
  }
  if (!scenarios.length) throw new Error("No scenario selected; no evidence can be recorded.");
  const harnessDigest = sourceFingerprint(options.root);
  if (!/^[A-Za-z0-9_-]{1,60}$/.test(options.runId)) throw new Error("The run id must be 1 to 60 letters, digits, dashes or underscores.");
  const runDir = path.join(options.outDir, options.runId);
  mkdirSync(path.join(runDir, "lanes"), { recursive: true });
  let scope: Scope | undefined;
  let scopeRefusal = "";
  if (options.includeLive) {
    try { scope = deps.scope instanceof Scope ? deps.scope : deps.scope instanceof ScopeError ? (() => { throw deps.scope; })() : loadScope(defaultManifestPath(env), now); scope.assertApproved(); }
    catch (error) { scope = undefined; scopeRefusal = error instanceof ScopeError ? `${error.code}: ${error.message}` : "the scope manifest could not be loaded"; }
  }
  const laneIds = scenarios.flatMap((s) => s.lanes.map((l) => `${s.id}.${l.id}`));
  const { checkpoint } = RunCheckpoint.open({ store: deps.store ?? fileStore(path.join(runDir, "checkpoint.json")), runId: options.runId, harness: "release-acceptance", scopeDigest: digest({ scope: scope?.digest ?? "no-live-scope", sourceCommit, lanes: scenarios, source: harnessDigest, localRun: options.localTargets ? { root: env.ZENITH_LOCAL_ROOT, joined: env.ZENITH_LOCAL_JOINED_DRIVERS } : null }), steps: laneIds, now });
  const cachePath = (id: string): string => path.join(runDir, "lanes", `${id}.json`);

  const results: ScenarioResult[] = [];
  for (const scenario of scenarios) {
    const lanes: LaneResult[] = [];
    for (const lane of scenario.lanes) {
      const id = `${scenario.id}.${lane.id}`;
      const prior = checkpoint.state.steps.find((s) => s.id === id);
      if (prior?.status === "done") {
        // A checkpoint note cannot substitute for a missing or changed result artifact.
        try {
          const restored = JSON.parse(readFile(cachePath(id))) as LaneResult;
          if (restored.scenarioId === scenario.id && restored.laneId === lane.id && restored.kind === lane.kind
            && (restored.status === "passed" || restored.status === "passed_live") && digest(restored) === prior.evidenceDigest) {
            lanes.push(restored);
            continue;
          }
        } catch { /* rerun without accepting a missing receipt */ }
        throw new Error("Completed result artifact is missing or changed; refuse resume and use a fresh run.");
      }
      let result: LaneResult;
      if (lane.kind === "live_sandbox") result = await liveLane(scenario, lane, { options, exec, env, scope, scopeRefusal, readFile });
      else {
        checkpoint.begin(id);
        result = "command" in lane ? await localCommandLane(scenario, lane, { options, exec, env, readFile, sourceCommit, ...(scenario.id === "two-tenants" || scenario.id === "export" ? { sourceDigest: sourceBinding().contentSha256 } : {}) }) : await localLane(scenario, lane, { options, exec, env, readFile });
      }
      lanes.push(result);
      if (result.status === "passed" || result.status === "passed_live") {
        writeFileSync(cachePath(id), JSON.stringify(result));
        if (lane.kind === "live_sandbox") checkpoint.begin(id);
        checkpoint.complete(id, result.detail.slice(0, 300), digest(result));
      } else {
        // Anything that is not a plain pass is never `done`, so a resume runs it again (or reports it again).
        if (lane.kind === "live_sandbox") checkpoint.begin(id);
        checkpoint.fail(id, `${result.status}: ${result.detail}`.slice(0, 300));
      }
    }
    results.push({ id: scenario.id, title: scenario.title, requirements: scenario.requirements, status: scenarioStatus(scenario, lanes), lanes, limits: scenario.limits });
  }
  const summary = { total: results.length, failed: 0, not_run: 0, incomplete: 0, local_passed: 0, local_passed_live_pending: 0, verified_live: 0 } as AcceptanceReport["summary"];
  for (const r of results) summary[r.status] += 1;
  const commit = sourceCommit;
  checkpoint.setNextCommands([
    "Re-run the scenarios that did not pass: npx tsx scripts/release/acceptance-orchestrator.ts run --only <ids> --run-id " + options.runId,
    "Live lanes (a person approves the scope first): npx tsx scripts/release/permissions-cli.ts approve --by <name>, then run with --include-live",
  ]);
  const report: AcceptanceReport = { schema: 1, runId: options.runId, generatedAt: now().toISOString(), sourceCommit: commit, harnessDigest, scenarios: results, summary, statement: STATEMENT };
  writeFileSync(path.join(runDir, "acceptance-report.json"), JSON.stringify(report, null, 2));
  return report;
}

async function localLane(scenario: Scenario, lane: Exclude<Extract<Lane, { kind: "contract" | "local_engine" }>, LocalCommandLane>, ctx: { options: RunOptions; exec: Exec; env: Readonly<Record<string, string | undefined>>; readFile: (file: string) => string }): Promise<LaneResult> {
  const out = path.join(os.tmpdir(), `zenith-acceptance-${ctx.options.runId}-${scenario.id}-${lane.id}.json`);
  const argv = ["node", "node_modules/vitest/vitest.mjs", "run", ...lane.files, "--project=node", "--no-file-parallelism", "--maxWorkers=1", "--reporter=json", `--outputFile=${out}`];
  if (existsSync(out)) unlinkSync(out);
  const run = await ctx.exec(argv, { cwd: ctx.options.root, timeoutMs: ctx.options.timeoutMs ?? 30 * 60_000, env: ctx.options.localTargets ? localEnvironment(ctx.env) : { ...process.env, ...(ctx.env as NodeJS.ProcessEnv) } });
  let json: VitestJson | undefined;
  try { json = JSON.parse(ctx.readFile(out)) as VitestJson; } catch { json = undefined; }
  const verdict = classifyVitest(run.code, json);
  return { scenarioId: scenario.id, laneId: lane.id, kind: lane.kind, ...verdict, command: argv.slice(0, 5) };
}

async function liveLane(scenario: Scenario, lane: LiveLane, ctx: { options: RunOptions; exec: Exec; env: Readonly<Record<string, string | undefined>>; scope: Scope | undefined; scopeRefusal: string; readFile: (file: string) => string }): Promise<LaneResult> {
  const base = { scenarioId: scenario.id, laneId: lane.id, kind: "live_sandbox" as const, command: [...lane.command] };
  if (!ctx.options.includeLive) return { ...base, status: "deferred", detail: `Deferred: ${lane.deferredBecause}. Not run, not counted.` };
  if (!ctx.scope) return { ...base, status: "deferred", detail: `Deferred: the scope manifest refuses live work (${ctx.scopeRefusal}).` };
  try { ctx.scope.authorize({ harness: lane.scopeHarness, provider: "control_plane", action: "read" }); }
  catch (error) { return { ...base, status: "deferred", detail: `Deferred: the scope grants nothing to ${lane.scopeHarness} (${error instanceof ScopeError ? error.code : "refused"}).` }; }
  const gates = missingGates(lane, ctx.env);
  if (gates.length) return { ...base, status: "deferred", detail: `Deferred: ${gates.length} gate(s) not set.`, missingGates: gates };
  const vitest = lane.command.includes("vitest");
  const out = path.join(os.tmpdir(), `zenith-live-${ctx.options.runId}-${scenario.id}-${lane.id}.json`);
  if (vitest && existsSync(out)) unlinkSync(out);
  const argv = vitest ? [...lane.command, "--no-file-parallelism", "--maxWorkers=2", "--reporter=json", `--outputFile=${out}`] : lane.command;
  const run = await ctx.exec(argv, { cwd: ctx.options.root, timeoutMs: ctx.options.timeoutMs ?? 4 * 60 * 60_000, env: { ...process.env, ...(ctx.env as NodeJS.ProcessEnv) } });
  if (vitest) {
    let json: VitestJson | undefined;
    try { json = JSON.parse(ctx.readFile(out)); } catch { /* missing output is not evidence */ }
    const verdict = classifyVitest(run.code, json);
    return { ...base, command: [...argv], counts: verdict.counts,
      status: verdict.status === "passed" ? "passed_live" : verdict.status === "no_tests" || verdict.status === "passed_with_skips" ? "skipped" : "failed",
      detail: `Live vitest receipt: ${verdict.detail}. Skipped cases never establish live verification.` };
  }
  if (run.code === 0) return { ...base, status: "passed_live", detail: "The live harness exited 0." };
  if (lane.skipExitCodes.includes(run.code)) return { ...base, status: "skipped", detail: `The live harness declined to run (exit ${run.code}); a skip is not a pass.` };
  return { ...base, status: "failed", detail: `The live harness exited ${run.code}.` };
}

export function renderList(scenarios: readonly Scenario[] = SCENARIOS): string {
  return scenarios.map((s) => `${s.id}  ${s.title}\n  requirements: ${s.requirements.join(", ")}\n${s.lanes.map((l) => `  - ${l.id} [${l.kind}] ${l.kind === "live_sandbox" ? `live harness ${l.scopeHarness}` : `${l.files.length} file(s)`}`).join("\n")}`).join("\n");
}

export function checkScenarios(root: string, scenarios: readonly Scenario[] = SCENARIOS, exists: (p: string) => boolean = existsSync): string[] {
  const problems: string[] = [];
  for (const id of REQUIRED_SCENARIO_IDS) if (!scenarios.some((s) => s.id === id)) problems.push(`required scenario "${id}" is missing`);
  for (const file of missingFiles(root, scenarios, exists)) problems.push(`mapped file does not exist: ${file}`);
  for (const s of scenarios) if (!s.lanes.some((l) => l.kind !== "live_sandbox")) problems.push(`scenario "${s.id}" has no local lane`);
  return problems;
}

export async function runOrchestratorCli(argv: readonly string[], io: { out: (s: string) => void; err: (s: string) => void } = { out: (s) => { process.stdout.write(s); }, err: (s) => { process.stderr.write(s); } }, root: string = process.cwd()): Promise<number> {
  const [command, ...rest] = argv;
  const value = (flag: string): string | undefined => { const i = rest.indexOf(flag); return i >= 0 ? rest[i + 1] : undefined; };
  if (command === "list") { io.out(`${renderList(rest.includes("--local-targets") ? SCENARIOS.map(s => ({ ...s, lanes: [...s.lanes, localTargetLane(s)] })) : SCENARIOS)}\n`); return 0; }
  if (command === "check") {
    const problems = checkScenarios(root);
    io.out(problems.length ? `${problems.join("\n")}\n` : `${SCENARIOS.length} scenarios, ${allLaneFiles().length} mapped files, all present.\n`);
    return problems.length ? 1 : 0;
  }
  if (command === "run") {
    const only = value("--only")?.split(",").map((s) => s.trim()).filter(Boolean);
    const runId = value("--run-id") ?? `accept-${new Date().toISOString().replace(/[-:T]/g, "").slice(0, 12)}`;
    try {
      const report = await runAcceptance({ root, outDir: path.resolve(value("--out") ?? ".data-live/acceptance"), runId, includeLive: rest.includes("--include-live"), localTargets: rest.includes("--local-targets"), ...(only ? { only } : {}) });
      io.out(`${report.scenarios.map((s) => `${s.status.padEnd(26)} ${s.id}`).join("\n")}\n${JSON.stringify(report.summary)}\n${report.statement}\n`);
      return report.summary.failed > 0 ? 1 : report.summary.incomplete > 0 || report.summary.not_run > 0 ? 2 : 0;
    } catch (error) { io.err(`${error instanceof Error ? error.message : "unexpected error"}\n`); return 2; }
  }
  io.err("usage: acceptance-orchestrator <list|check|run [--only a,b] [--out DIR] [--run-id ID] [--include-live|--local-targets]>\n");
  return 2;
}

if (process.argv[1] && /(?:^|[/\\])acceptance-orchestrator\.(?:ts|mts|js|mjs)$/.test(process.argv[1])) void runOrchestratorCli(process.argv.slice(2)).then((code) => { process.exitCode = code; });

/** Bind resumable lanes to the current harness, fixture and local-target configuration bytes. */
export function sourceFingerprint(root: string): string {
  const files: { file: string; hash: string }[] = [];
  const walk = (relative: string): void => {
    const full = path.join(root, relative);
    if (!existsSync(full)) return;
    for (const entry of readdirSync(full, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.isSymbolicLink() || entry.name === "node_modules") continue;
      const name = `${relative}/${entry.name}`;
      if (entry.isDirectory()) walk(name);
      else files.push({ file: name, hash: digest(readFileSync(path.join(root, name)).toString("base64")) });
    }
  };
  for (const dir of ["scripts/release", "fixtures/mixed-app", "deploy/acceptance/local-targets"]) walk(dir);
  return digest(files);
}

async function localCommandLane(scenario: Scenario, lane: LocalCommandLane, ctx: {
  options: RunOptions; exec: Exec; env: Readonly<Record<string, string | undefined>>; readFile: (file: string) => string; sourceCommit: string | null; sourceDigest?: string;
}): Promise<LaneResult> {
  const base = { scenarioId: scenario.id, laneId: lane.id, kind: "local_engine" as const, evidenceLabel: lane.evidenceLabel };
  const gates = missingGates(lane, ctx.env);
  if (gates.length) return { ...base, status: "deferred", detail: "Local target not run: missing explicit local gate or target prerequisites.", missingGates: gates };
  const out = path.join(realpathSync(os.tmpdir()), `zenith-local-${ctx.options.runId}-${scenario.id}.json`);
  if (existsSync(out)) unlinkSync(out);
  const argv = [...lane.command, "--run-id", ctx.options.runId, "--receipt", out];
  const run = await ctx.exec(argv, { cwd: ctx.options.root, timeoutMs: ctx.options.timeoutMs ?? (lane.evidenceLabel === "local_operated_rehearsal" ? 45 : 30) * 60_000, env: localEnvironment(ctx.env) });
  if (run.code === 2) return { ...base, command: argv, status: "skipped", detail: "Local target declined: needs its joined scenario driver and prerequisites. Not run, not counted." };
  let receipt;
  try {
    receipt = validateLocalReceipt(JSON.parse(ctx.readFile(out)), { scenarioId: scenario.id, runId: ctx.options.runId, sourceCommit: ctx.sourceCommit ?? "", ...(scenario.id === "two-tenants" || scenario.id === "export" ? { sourceDigest: ctx.sourceDigest } : {}) });
    if (receipt.evidenceLabel !== lane.evidenceLabel) throw new Error("Local evidence label mismatch");
  } catch {
    return { ...base, command: argv, status: "failed", detail: `Local target exited ${run.code} without a valid source/run/scenario-bound receipt.` };
  }
  const counts = { passed: receipt.checks.filter(c => c.status === "passed").length, failed: receipt.checks.filter(c => c.status === "failed").length, skipped: receipt.checks.filter(c => c.status === "skipped").length };
  const status = counts.failed || (run.code !== 0 && !(run.code === 3 && counts.skipped > 0)) ? "failed" : counts.skipped ? "passed_with_skips" : "passed";
  return { ...base, command: argv, status, counts, limits: receipt.limits, detail: `Local rehearsal: ${counts.passed} checks passed, ${counts.failed} failed, ${counts.skipped} skipped; no live acceptance.` };
}
