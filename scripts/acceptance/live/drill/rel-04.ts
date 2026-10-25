/**
 * PROD-REL-04 live crash-and-resume drill (scenario rel-04, owner-approved sandbox only).
 *
 *   A  SIGKILL the harness process group right after the s3 create intent is journaled, then
 *      snapshot the journal, next-command.txt and checkpoint.json. Nothing is awaited after the kill.
 *   B  Resume exactly as the recorded next command does: `aws-live.ts --cleanup <journal>`.
 *      Journal must close, no create counter may grow, and evidence must report cleanupComplete.
 *   C  Replay refusal: a fresh budget book (deliberate bypass of the local book) reaches the
 *      account-side SSM run claim, which must refuse before any S3 create. Then the ORIGINAL budget
 *      book must refuse the same run before any journal is written.
 *   D  Read-only account readback: HeadBucket on the run bucket is NotFound and the run receipt
 *      parameter still holds the run id.
 *
 * Every step is recorded in a drill log. The receipt is written even when a step fails. No product
 * port is joined here, so the PROD-REL-04 product checks stay pending by design. The drill never
 * edits permissions or scope, and never calls anything but the harness and read-only SDK calls.
 */
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { assertRunId } from "../../safety";
import { buildPlan, digest } from "../plan";
import { missing } from "../execute";
import { sdkTransport } from "../sdk";
import type { Journal, Json, Plan } from "../contracts";

export const REL04 = "rel-04" as const;
export const DELIBERATE_BYPASS_NOTE = "fresh budget file in C deliberately bypasses the local book";
/** Env names the recorded resume command must carry. Values are never copied into the receipt. */
export const RESUME_ENV = ["ZENITH_LIVE_AWS", "ZENITH_LIVE_AWS_BUDGET_USD", "ZENITH_LIVE_SCOPE_FILE", "ZENITH_LIVE_AWS_SESSION_FILE"] as const;
const SCRIPT = "scripts/acceptance/aws-live.ts";
const POLL_MS = 250, INTENT_DEADLINE_MS = 10 * 60_000, CLEANUP_MS = 40 * 60_000, REPLAY_MS = 15 * 60_000, REFUSAL_MS = 2 * 60_000;

export interface Rel04Layout {
  runId: string; out: string; d1: string; refusedDirectory: string;
  journal: string; nextCommand: string; checkpoint: string; evidence: string;
  killJournal: string; killNextCommand: string; killCheckpoint: string;
  receipt: string; log: string; replayJournal: string; replayEvidence: string; refusedJournal: string;
}
/** Shared by the drill and the offline verifier, so both read the same paths. `out` is the owner OUT parent. */
export function rel04Layout(runId: string, out: string): Rel04Layout {
  if (!path.isAbsolute(out)) throw new Error("Absolute output directory required");
  assertRunId(runId);
  const base = path.resolve(out);
  const d1 = path.join(base, runId), d2 = path.join(`${base}-replay`, runId), d3 = path.join(`${base}-refused`, runId);
  return {
    runId, out: base, d1, refusedDirectory: d3,
    journal: path.join(d1, "journal.json"), nextCommand: path.join(d1, "next-command.txt"), checkpoint: path.join(d1, "checkpoint.json"), evidence: path.join(d1, "evidence.json"),
    killJournal: path.join(d1, "kill-journal.json"), killNextCommand: path.join(d1, "kill-next-command.txt"), killCheckpoint: path.join(d1, "kill-checkpoint.json"),
    receipt: path.join(d1, "rel-04-receipt.json"), log: path.join(d1, "rel-04-drill-log.json"),
    replayJournal: path.join(d2, "journal.json"), replayEvidence: path.join(d2, "evidence.json"), refusedJournal: path.join(d3, "journal.json"),
  };
}
/** The same plan the harness builds from the same environment, with the same defaults as live/cli.ts, so the digests match. */
export function planFromEnv(env: Readonly<Record<string, string | undefined>>): Plan {
  const accountId = env.ZENITH_LIVE_AWS_ACCOUNT_ID ?? "000000000000";
  return buildPlan({
    accountId, region: env.ZENITH_LIVE_REGION ?? "ap-south-1", runId: env.ZENITH_LIVE_AWS_RUN_ID ?? "",
    durationMinutes: Number(env.ZENITH_LIVE_AWS_MINUTES ?? "15"), dbSubnetGroup: env.ZENITH_LIVE_AWS_DB_SUBNET_GROUP ?? "zenith-live-sandbox",
    dbSecurityGroup: env.ZENITH_LIVE_AWS_DB_SECURITY_GROUP ?? "sg-00000000", workloadBoundaryArn: `arn:aws:iam::${accountId}:policy/ZenithLiveWorkloadBoundary`, scenario: REL04,
  });
}

export interface DrillChild { readonly pid?: number; readonly exit: Promise<number | null> }
export interface DrillSeams {
  readonly env: Readonly<Record<string, string | undefined>>;
  head(): string;
  spawn(args: readonly string[], env: Readonly<Record<string, string | undefined>>): DrillChild;
  kill(child: DrillChild): void;
  read(file: string): string | undefined;
  write(file: string, text: string): void;
  exists(file: string): boolean;
  sleep(ms: number): Promise<void>;
  now(): number;
  readAws(plan: Plan): Promise<{ headBucket: string; ssmValue?: string }>;
}
export interface StepResult { passed: boolean; reason: string }
export interface Rel04Receipt {
  schema: 1; scenario: typeof REL04; runId: string; commit: string; planSha256: string; permissionSha256: string;
  steps: { A: StepResult; B: StepResult; C: StepResult; D: StepResult & { headBucket: string; ssmValueMatchesRunId: boolean } };
  verdict: "passed" | "failed"; notes: string[];
}
export interface DrillLogEntry { at: string; step: string; event: string; ok: boolean }

class Refused extends Error {}
function need(condition: unknown, reason: string): asserts condition {
  if (!condition) throw new Refused(reason);
}
function readJournal(seams: DrillSeams, file: string): Journal | undefined {
  const text = seams.read(file);
  if (text === undefined) return undefined;
  try { return JSON.parse(text) as Journal; } catch { return undefined; }
}
/** Bounded wait for a child; the caller decides whether a timeout means kill. */
async function bounded(exit: Promise<number | null>, ms: number): Promise<{ timedOut: boolean; code: number | null }> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<{ timedOut: boolean; code: number | null }>(resolve => { timer = setTimeout(() => resolve({ timedOut: true, code: null }), ms); });
  try { return await Promise.race([exit.then(code => ({ timedOut: false, code })), timeout]); } finally { clearTimeout(timer); }
}

/** Runs the drill over injected seams. The only AWS calls are the harness processes and `seams.readAws`. */
export async function runRel04Drill(seams: DrillSeams, layout: Rel04Layout, input: { plan: Plan; permissionsFile: string; budgetFile: string }): Promise<Rel04Receipt> {
  const { plan, permissionsFile, budgetFile } = input;
  const runId = layout.runId;
  need(plan.settings.runId === runId && plan.settings.scenario === REL04, "plan is not the rel-04 plan for this run id");
  // Refuse before touching anything: a receipt must never overwrite an earlier drill.
  if (seams.exists(layout.d1)) throw new Error("Drill output already exists for this run id; use a new run id");
  const log: DrillLogEntry[] = [];
  const event = (step: string, text: string, ok: boolean) => log.push({ at: new Date(seams.now()).toISOString(), step, event: text, ok });
  const commit = seams.head();
  if (!/^[a-f0-9]{40}$/.test(commit)) throw new Error("Exact source commit required");
  const permissionSha256 = digest((JSON.parse(seams.read(permissionsFile) ?? "{}") as { awsLive?: unknown }).awsLive);
  const bucket = `zenith-${runId}-${plan.settings.accountId}`;
  const replayBudget = `${budgetFile}.replay.json`;
  const skipped = (why: string): StepResult => ({ passed: false, reason: `not run: ${why}` });
  const attempt = async (step: string, body: () => Promise<void>): Promise<StepResult> => {
    try { await body(); event(step, "step passed", true); return { passed: true, reason: "all assertions hold" }; }
    catch (error) {
      const reason = error instanceof Refused ? error.message : "unexpected error in this step";
      event(step, reason, false);
      return { passed: false, reason };
    }
  };

  // Mutable drill state lives on one object: closures assign it, and control-flow narrowing cannot hide those writes.
  const run = { child: undefined as DrillChild | undefined, ended: false, exitCode: null as number | null, killedAfterIntent: false, snapshot: undefined as Journal | undefined };
  const a = await attempt("A", async () => {
    const harness = seams.spawn(["--scenario", REL04, "--run-id", runId, "--permissions", permissionsFile, "--out", layout.out], seams.env);
    run.child = harness;
    harness.exit.then(code => { run.ended = true; run.exitCode = code; });
    const begun = seams.now();
    let intent = false;
    for (;;) {
      if (readJournal(seams, layout.journal)?.responses?.["s3-create"]) { intent = true; break; }
      if (run.ended || seams.now() - begun >= INTENT_DEADLINE_MS) break;
      await seams.sleep(POLL_MS);
    }
    need(intent, run.ended ? `child ended before the s3 create intent (exit ${run.exitCode})` : "s3 create intent not seen within 10 minutes");
    run.killedAfterIntent = true;
    seams.kill(harness);
    await bounded(harness.exit, 10_000);
    const text = seams.read(layout.journal);
    const next = seams.read(layout.nextCommand), checkpointText = seams.read(layout.checkpoint);
    need(text !== undefined && next !== undefined && checkpointText !== undefined, "journal, next command or checkpoint missing after kill");
    seams.write(layout.killJournal, text); seams.write(layout.killNextCommand, next); seams.write(layout.killCheckpoint, checkpointText);
    const killed = JSON.parse(text) as Journal;
    run.snapshot = killed;
    event("A", `journal at kill: attempted=${killed.attempted.join(",")} closed=${killed.closed} counts=${JSON.stringify(killed.counts)}`, true);
    need(buildPlan(killed.plan.settings).sha256 === killed.plan.sha256 && killed.plan.sha256 === plan.sha256, "journal plan is not the rel-04 plan");
    need(killed.closed === false, "journal was closed at kill");
    need(killed.attempted.includes("s3") && killed.responses["s3-create"]?.Bucket === bucket, "s3 create intent does not name the run bucket");
    need(killed.counts["s3-create"] === 1, "s3 create counter is not one at kill");
    need(RESUME_ENV.every(name => next.includes(`${name}=`)) && next.includes("--cleanup") && next.includes(`'${layout.journal}'`), "recorded next command is not runnable");
    const checkpoint = JSON.parse(checkpointText) as { nextCommands?: string[]; unattendedClaims?: unknown; steps?: { status?: string }[] };
    need(checkpoint.unattendedClaims === false && checkpoint.nextCommands?.[0] === next.trim() && checkpoint.steps?.[0]?.status === "in_progress", "checkpoint does not carry the recorded next command");
  });
  // Once the intent exists, cloud state may exist: cleanup runs even when an assertion above failed.
  if (run.child && !run.ended) seams.kill(run.child);

  let b: StepResult = skipped("no kill and no open journal to resume");
  const open = readJournal(seams, layout.journal);
  if (run.killedAfterIntent || (open && !open.closed && open.attempted.length > 0)) {
    const baseline = run.snapshot ?? open!;
    b = await attempt("B", async () => {
      const resume = seams.spawn(["--permissions", permissionsFile, "--cleanup", layout.journal], seams.env);
      const outcome = await bounded(resume.exit, CLEANUP_MS);
      if (outcome.timedOut) seams.kill(resume);
      event("B", `resume finished: timedOut=${outcome.timedOut} exit=${outcome.code}`, !outcome.timedOut);
      need(!outcome.timedOut, "resume did not finish within its bound");
      const final = readJournal(seams, layout.journal);
      need(final !== undefined && final.closed === true, "resume left the journal open");
      for (const key of Object.keys(final.counts).filter(k => k.endsWith("-create")))
        need((final.counts[key] ?? 0) <= (baseline.counts[key] ?? 0), "a create counter increased during resume");
      const evidence = JSON.parse(seams.read(layout.evidence) ?? "{}") as { cleanupComplete?: unknown };
      need(evidence.cleanupComplete === true, "evidence does not report cleanupComplete");
      const checkpoint = JSON.parse(seams.read(layout.checkpoint) ?? "{}") as { steps?: { status?: string }[] };
      need(checkpoint.steps?.[0]?.status === "done", "checkpoint run step is not done after resume");
    });
  }

  let c: StepResult = skipped("A or B did not pass");
  let d: StepResult = skipped("A or B did not pass");
  let readback = { headBucket: "not read", ssmValueMatchesRunId: false };
  if (a.passed && b.passed) {
    c = await attempt("C", async () => {
      need(!seams.exists(replayBudget), "replay budget book already exists");
      const replay = seams.spawn(["--scenario", REL04, "--run-id", runId, "--permissions", permissionsFile, "--out", `${layout.out}-replay`], { ...seams.env, ZENITH_LIVE_BUDGET_FILE: replayBudget });
      const outcome = await bounded(replay.exit, REPLAY_MS);
      if (outcome.timedOut) seams.kill(replay);
      need(!outcome.timedOut, "replay did not finish within its bound");
      const journal = readJournal(seams, layout.replayJournal);
      need(journal !== undefined, "replay wrote no journal");
      need(journal.plan.sha256 === plan.sha256, "replay plan differs from the approved plan");
      need((journal.counts["run-claim"] ?? 0) === 1, "replay did not reach the account-side run claim exactly once");
      need(journal.counts["run-claim-read"] === undefined, "replay continued past a refused run claim");
      need(!journal.attempted.includes("s3") && journal.responses["s3-create"] === undefined && !journal.counts["s3-create"], "replay attempted an s3 create");
      need(journal.checks.some(check => check.id === "execution" && check.status === "failed"), "replay did not record a refused execution");
      need(!journal.checks.some(check => check.status === "passed" && check.scope === "aws_fixture"), "replay recorded a passed fixture");
      need(journal.closed === true, "replay journal left open with nothing attempted");
      event("C", `replay refused at run-claim: exit=${outcome.code}`, true);
      // Second refusal, with the ORIGINAL book (which already holds this run): reservation must refuse before any journal.
      const refused = seams.spawn(["--scenario", REL04, "--run-id", runId, "--permissions", permissionsFile, "--out", `${layout.out}-refused`], seams.env);
      const again = await bounded(refused.exit, REFUSAL_MS);
      if (again.timedOut) seams.kill(refused);
      need(!again.timedOut && again.code === 2, "re-reserving the original budget book was not refused with exit 2");
      need(!seams.exists(layout.refusedJournal), "refused re-reservation wrote a journal");
    });
    d = await attempt("D", async () => {
      const read = await seams.readAws(plan);
      readback = { headBucket: read.headBucket, ssmValueMatchesRunId: read.ssmValue === runId };
      need(read.headBucket === "NotFound", "run bucket is still present or unreadable");
      need(read.ssmValue === runId, "run receipt parameter is missing or differs");
    });
  }

  const receipt: Rel04Receipt = {
    schema: 1, scenario: REL04, runId, commit, planSha256: plan.sha256, permissionSha256,
    steps: { A: a, B: b, C: c, D: { ...d, ...readback } },
    verdict: [a, b, c, d].every(step => step.passed) ? "passed" : "failed",
    notes: [
      DELIBERATE_BYPASS_NOTE,
      "A SIGKILLs the harness process group after the s3 create intent; the kill may land before or after the provider accepted CreateBucket, and resume handles both sides (kill timing races the s3-tag step)",
      "D reads use the planned HeadBucket and SSM GetParameter call shapes through the native SDK transport, read-only, outside the journal counters",
      "No product port is joined: PROD-REL-04 product checks stay pending, so this drill never makes the packet verdict passed",
    ],
  };
  seams.write(layout.log, `${JSON.stringify(log, null, 2)}\n`);
  seams.write(layout.receipt, `${JSON.stringify(receipt, null, 2)}\n`);
  return receipt;
}

/** Production seams: real processes, real filesystem, the owner's SDK transport for the two readbacks. */
export function liveSeams(env: NodeJS.ProcessEnv): DrillSeams {
  const clean = (values: Readonly<Record<string, string | undefined>>): NodeJS.ProcessEnv => Object.fromEntries(Object.entries(values).filter(([, v]) => v !== undefined)) as NodeJS.ProcessEnv;
  return {
    env,
    head: () => execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
    spawn(args, values) {
      // Own process group, so SIGKILL reaches npx, tsx and the harness together.
      const child = spawn("npx", ["tsx", SCRIPT, ...args], { env: clean(values), detached: true, stdio: "inherit" });
      const exit = new Promise<number | null>(resolve => { child.once("exit", code => resolve(code)); child.once("error", () => resolve(null)); });
      return { pid: child.pid, exit };
    },
    kill(child) { if (child.pid !== undefined) { try { process.kill(-child.pid, "SIGKILL"); } catch { /* already gone */ } } },
    read(file) { try { return readFileSync(file, "utf8"); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; } },
    write(file, text) {
      mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
      const temporary = `${file}.tmp`;
      writeFileSync(temporary, text, { mode: 0o600 });
      renameSync(temporary, file);
    },
    exists: (file) => existsSync(file),
    sleep: (ms) => new Promise(resolve => setTimeout(resolve, ms)),
    now: () => Date.now(),
    async readAws(plan) {
      const transport = await sdkTransport(plan.settings.region, env);
      // The planned leak call for the S3 fixture is HeadBucket (ListBucket); the planned run-claim-read is SSM GetParameter.
      const head = plan.fixtures[0]!.leak[0]!;
      let headBucket: string;
      try { await transport.send(head, head.input as Record<string, Json>); headBucket = "Exists"; }
      catch (error) { headBucket = missing(error) ? "NotFound" : "Error"; }
      const claim = plan.preflight.find(call => call.id === "run-claim-read")!;
      let ssmValue: string | undefined;
      try {
        const out = await transport.send(claim, claim.input);
        const value = (out.Parameter as { Value?: unknown } | undefined)?.Value;
        ssmValue = typeof value === "string" ? value : undefined;
      } catch { ssmValue = undefined; }
      return { headBucket, ssmValue };
    },
  };
}

async function main(): Promise<number> {
  const env = process.env;
  const out = env.ZENITH_LIVE_AWS_OUT, budget = env.ZENITH_LIVE_BUDGET_FILE, permissions = env.ZENITH_LIVE_AWS_PERMISSIONS;
  if (!out || !budget || !permissions || !path.isAbsolute(budget) || !path.isAbsolute(permissions)) throw new Error("Absolute owner FILE and OUT paths required");
  const layout = rel04Layout(env.ZENITH_LIVE_AWS_RUN_ID ?? "", out);
  const receipt = await runRel04Drill(liveSeams(env), layout, { plan: planFromEnv(env), permissionsFile: permissions, budgetFile: budget });
  process.stdout.write(`rel-04 drill verdict: ${receipt.verdict}; receipt written to ${layout.receipt}\n`);
  return receipt.verdict === "passed" ? 0 : 1;
}

if (/(?:^|[/\\])rel-04\.[cm]?[jt]s$/.test(process.argv[1] ?? "")) {
  main().then(code => { process.exitCode = code; }, () => {
    process.stderr.write("rel-04 drill refused or failed before a receipt could be written; no cloud state is claimed\n");
    process.exitCode = 2;
  });
}
