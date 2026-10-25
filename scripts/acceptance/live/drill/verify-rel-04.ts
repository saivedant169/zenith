/**
 * Offline verifier for the PROD-REL-04 drill receipt. No AWS, no credentials, no network.
 *
 * It re-derives every step from the journals, checkpoints, evidence and permission file on disk, then
 * compares each derived result with the receipt's recorded booleans. Exit 0 only when every step holds
 * and the receipt says passed. Failures are fixed, sanitized strings.
 */
import { existsSync, readFileSync } from "node:fs";
import { z } from "zod";
import { parseArgs, UsageError } from "../../args";
import { readPermission } from "../guard";
import { buildPlan, digest, scopedRequirementIds } from "../plan";
import type { AwsPermission, Journal } from "../contracts";
import { DELIBERATE_BYPASS_NOTE, RESUME_ENV, rel04Layout, type Rel04Layout } from "./rel-04";

const Step = z.object({ passed: z.boolean(), reason: z.string().min(1).max(300) }).strict();
export const ReceiptSchema = z.object({
  schema: z.literal(1),
  scenario: z.literal("rel-04"),
  runId: z.string().min(4).max(120),
  commit: z.string().regex(/^[a-f0-9]{40}$/),
  planSha256: z.string().regex(/^[a-f0-9]{64}$/),
  permissionSha256: z.string().regex(/^[a-f0-9]{64}$/),
  steps: z.object({
    A: Step, B: Step, C: Step,
    D: Step.extend({ headBucket: z.string().max(40), ssmValueMatchesRunId: z.boolean() }).strict(),
  }).strict(),
  verdict: z.enum(["passed", "failed"]),
  notes: z.array(z.string().max(400)).max(20),
}).strict();

/** Every file the verifier reads, already loaded. Missing files are undefined; they fail the step that needs them. */
export interface Rel04Files {
  receipt?: unknown;
  permission?: unknown;
  journalPath: string;
  journal?: unknown;
  killJournal?: unknown;
  killNextCommand?: string;
  killCheckpoint?: unknown;
  checkpoint?: unknown;
  evidence?: unknown;
  replayJournal?: unknown;
  refusedDirectoryExists: boolean;
}

function readJsonOptional(file: string): unknown {
  if (!existsSync(file)) return undefined;
  try { return JSON.parse(readFileSync(file, "utf8")) as unknown; } catch { return undefined; }
}
function readTextOptional(file: string): string | undefined {
  return existsSync(file) ? readFileSync(file, "utf8") : undefined;
}
export function loadRel04Files(layout: Rel04Layout, permissionsFile: string): Rel04Files {
  return {
    receipt: readJsonOptional(layout.receipt),
    permission: readJsonOptional(permissionsFile),
    journalPath: layout.journal,
    journal: readJsonOptional(layout.journal),
    killJournal: readJsonOptional(layout.killJournal),
    killNextCommand: readTextOptional(layout.killNextCommand),
    killCheckpoint: readJsonOptional(layout.killCheckpoint),
    checkpoint: readJsonOptional(layout.checkpoint),
    evidence: readJsonOptional(layout.evidence),
    replayJournal: readJsonOptional(layout.replayJournal),
    refusedDirectoryExists: existsSync(layout.refusedDirectory),
  };
}

function isJournal(value: unknown): value is Journal {
  const v = value as Partial<Journal> | undefined;
  return !!v && typeof v === "object" && v.schema === 1 && typeof v.plan === "object" && v.plan !== null && typeof v.commit === "string" &&
    typeof v.permissionSha256 === "string" && Array.isArray(v.attempted) && typeof v.responses === "object" && v.responses !== null &&
    Array.isArray(v.checks) && typeof v.closed === "boolean" && typeof v.counts === "object" && v.counts !== null;
}

/** Returns sanitized failures. An empty list means the drill evidence is valid and passed. */
export function verifyRel04Files(runId: string, files: Rel04Files): string[] {
  const parsed = ReceiptSchema.safeParse(files.receipt);
  if (!parsed.success) return ["receipt is missing or malformed"];
  const receipt = parsed.data;
  const failures: string[] = [];
  const derived: Record<"A" | "B" | "C" | "D", string[]> = { A: [], B: [], C: [], D: [] };
  const check = (step: keyof typeof derived, holds: boolean, why: string) => { if (!holds) derived[step].push(why); };

  if (receipt.runId !== runId) failures.push("receipt run id differs from the run directory");
  if (!receipt.notes.includes(DELIBERATE_BYPASS_NOTE)) failures.push("receipt omits the deliberate budget-book bypass note");

  // Permission binding: the receipt must name the exact approved envelope on disk.
  try {
    const permission: AwsPermission = readPermission(files.permission);
    check("A", digest(permission) === receipt.permissionSha256, "receipt permission digest differs from the permission file");
    check("A", permission.planSha256 === receipt.planSha256, "permission file approves a different plan");
    check("A", permission.sourceCommit === receipt.commit, "permission file approves a different source commit");
    check("A", permission.runId === runId, "permission file approves a different run");
  } catch {
    failures.push("permission file is not an approved awsLive envelope");
  }

  // The journal is the authority for the plan, commit and permission digest the drill ran under.
  const journal = isJournal(files.journal) ? files.journal : undefined;
  check("A", journal !== undefined, "final journal is missing or malformed");
  if (journal) {
    let canonical = false;
    try {
      const plan = journal.plan;
      canonical = buildPlan(plan.settings).sha256 === plan.sha256 && plan.sha256 === receipt.planSha256 &&
        plan.settings.runId === runId && plan.settings.scenario === "rel-04" &&
        JSON.stringify(plan.fixtures.map(f => f.family)) === JSON.stringify(["s3"]) &&
        JSON.stringify(scopedRequirementIds(plan.settings, plan.requirements.map(r => r.id))) === JSON.stringify(["PROD-REL-04"]);
    } catch { canonical = false; }
    check("A", canonical, "journal plan is not the canonical rel-04 plan bound to the receipt");
    check("A", journal.commit === receipt.commit, "journal source commit differs from the receipt");
    check("A", journal.permissionSha256 === receipt.permissionSha256, "journal permission digest differs from the receipt");
  }

  // A: the snapshot taken at SIGKILL held an open journal with the s3 create intent and a runnable resume.
  const killed = isJournal(files.killJournal) ? files.killJournal : undefined;
  check("A", killed !== undefined, "kill-time journal snapshot is missing or malformed");
  if (killed) {
    check("A", killed.closed === false, "journal was closed at kill");
    check("A", killed.attempted.includes("s3"), "kill-time journal does not record the s3 family");
    const account = killed.plan.settings.accountId;
    check("A", killed.responses["s3-create"]?.Bucket === `zenith-${runId}-${account}`, "s3 create intent does not name the run bucket");
    check("A", killed.counts["s3-create"] === 1, "s3 create counter is not one at kill");
    check("A", killed.plan.sha256 === receipt.planSha256 && killed.commit === receipt.commit, "kill-time journal is not bound to the receipt plan and commit");
  }
  const next = files.killNextCommand;
  check("A", next !== undefined && next.includes("--cleanup") && next.includes(`'${files.journalPath}'`), "recorded next command does not resume the journal");
  check("A", next !== undefined && RESUME_ENV.every(name => next.includes(`${name}=`)), "recorded next command omits a required env name");
  const killCheckpoint = files.killCheckpoint as { format?: unknown; unattendedClaims?: unknown; nextCommands?: unknown; steps?: { status?: unknown }[] } | undefined;
  check("A", killCheckpoint?.format === "zenith.run-checkpoint.v1" && killCheckpoint.unattendedClaims === false, "kill-time checkpoint is not the bounded checkpoint format");
  const commands = killCheckpoint?.nextCommands;
  check("A", next !== undefined && Array.isArray(commands) && commands.length === 1 && commands[0] === next.trim(), "kill-time checkpoint does not carry the exact next command");
  check("A", killCheckpoint?.steps?.[0]?.status === "in_progress", "kill-time checkpoint run step was not in progress");

  // B: resume closed the journal, created nothing new, and evidence and checkpoint agree.
  if (journal && killed) {
    check("B", journal.closed === true, "final journal is open after resume");
    for (const key of Object.keys(journal.counts).filter(k => k.endsWith("-create")))
      check("B", (journal.counts[key] ?? 0) <= (killed.counts[key] ?? 0), "a create counter increased between kill and resume");
  }
  const evidence = files.evidence as { cleanupComplete?: unknown; planSha256?: unknown; commit?: unknown; scope?: unknown } | undefined;
  check("B", evidence?.cleanupComplete === true, "evidence does not report cleanupComplete");
  check("B", evidence?.planSha256 === receipt.planSha256 && evidence?.commit === receipt.commit, "evidence is not bound to the receipt plan and commit");
  check("B", JSON.stringify(evidence?.scope) === JSON.stringify(["PROD-REL-04"]), "evidence scope is not PROD-REL-04 only");
  const checkpoint = files.checkpoint as { unattendedClaims?: unknown; nextCommands?: unknown; steps?: { status?: unknown }[] } | undefined;
  check("B", checkpoint?.unattendedClaims === false && Array.isArray(checkpoint.nextCommands) && checkpoint.nextCommands.length === 0, "final checkpoint still carries a next command or claims unattended work");
  check("B", checkpoint?.steps?.[0]?.status === "done", "final checkpoint run step is not done");

  // C: the replay refused at the account-side run claim before any create, and the original book refused a second reservation.
  const replay = isJournal(files.replayJournal) ? files.replayJournal : undefined;
  check("C", replay !== undefined, "replay journal is missing or malformed");
  if (replay) {
    check("C", replay.plan.sha256 === receipt.planSha256, "replay plan differs from the receipt plan");
    check("C", replay.counts["run-claim"] === 1, "replay did not attempt the run claim exactly once");
    check("C", replay.counts["run-claim-read"] === undefined, "replay continued past a refused run claim");
    check("C", !replay.attempted.includes("s3") && replay.responses["s3-create"] === undefined && !replay.counts["s3-create"], "replay attempted an s3 create");
    check("C", replay.checks.some(c => c.id === "execution" && c.status === "failed"), "replay did not record a refused execution");
    check("C", !replay.checks.some(c => c.status === "passed" && c.scope === "aws_fixture"), "replay recorded a passed fixture");
    check("C", replay.closed === true, "replay journal is open with nothing attempted");
  }
  check("C", files.refusedDirectoryExists === false, "a refused re-reservation left an output directory");

  // D: the independent readback recorded by the drill, re-checked against its expected values.
  check("D", receipt.steps.D.headBucket === "NotFound", "run bucket was not NotFound after resume");
  check("D", receipt.steps.D.ssmValueMatchesRunId === true, "run receipt parameter did not match the run id");

  // Each recorded step must agree with its re-derived result, and every re-derived failure is reported.
  for (const step of ["A", "B", "C", "D"] as const) {
    const holds = derived[step].length === 0;
    if (receipt.steps[step].passed !== holds) failures.push(`step ${step} is recorded ${receipt.steps[step].passed} but re-derives ${holds}`);
    for (const why of derived[step]) failures.push(`step ${step}: ${why}`);
  }
  if (receipt.verdict !== "passed") failures.push("receipt verdict is not passed");
  return failures;
}

function main(argv: readonly string[]): number {
  const args = parseArgs(argv, { booleans: [], strings: ["run-id", "out", "permissions"] });
  if (args.positional.length) throw new UsageError("Positional arguments are not accepted.");
  const runId = args.values.get("run-id"), out = args.values.get("out"), permissions = args.values.get("permissions");
  if (!runId || !out || !permissions) throw new UsageError("--run-id, --out and --permissions are required.");
  const layout = rel04Layout(runId, out);
  const failures = verifyRel04Files(runId, loadRel04Files(layout, permissions));
  if (failures.length) {
    process.stderr.write(`rel-04 receipt NOT verified (${failures.length} failure(s)):\n${failures.map(f => `  - ${f}`).join("\n")}\n`);
    return 1;
  }
  process.stdout.write(`rel-04 receipt verified for ${runId}: every step re-derived from disk; no cloud call made.\n`);
  return 0;
}

if (/(?:^|[/\\])verify-rel-04\.[cm]?[jt]s$/.test(process.argv[1] ?? "")) {
  try { process.exitCode = main(process.argv.slice(2)); }
  catch (error) {
    process.stderr.write(`${error instanceof UsageError ? error.message : "rel-04 verifier could not read its inputs"}\n`);
    process.exitCode = 2;
  }
}
