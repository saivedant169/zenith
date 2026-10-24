import { execFileSync } from "node:child_process";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "../args";
import { newRunId } from "../safety";
import { redactAcceptance } from "../redact";
import { buildPlan, parseScenario, scopedRequirementIds } from "./plan";
import { grantsFor, Guard, readPermission } from "./guard";
import { execute, newJournal } from "./execute";
import { evidencePacket } from "./evidence";
import { sdkTransport } from "./sdk";
import { requireProductionScope } from "./scope";
import { reserveRunBudget } from "./shared";
import { requireScope } from "../../release/scope";
import type { Journal, Plan, ProductScenarioPort, Transport } from "./contracts";
import type { EnvLike } from "../config";

export const PRODUCTION_USAGE = `Production AWS acceptance (DEC-CLOUD is deferred):
  npx tsx scripts/acceptance/aws-live.ts --plan --account <12digits> --region <region> --run-id <zlive-YYYYMMDDHHmm-xxxx>
  ZENITH_LIVE_AWS=1 ZENITH_LIVE_AWS_BUDGET_USD=<USD> npx tsx scripts/acceptance/aws-live.ts --permissions <permissions.json> [same plan inputs]
  ZENITH_LIVE_AWS=1 ZENITH_LIVE_AWS_BUDGET_USD=<USD> npx tsx scripts/acceptance/aws-live.ts --permissions <permissions.json> --cleanup <journal.json>
Options: --minutes <5..20> --db-subnet-group <zenith-live-...> --db-security-group <sg-...> --out <directory> --budget-usd <USD>
  --scenario <fixtures|retention-s3> (or ZENITH_LIVE_AWS_SCENARIO; default fixtures; part of the signed plan digest)
--plan never reads credentials or calls AWS. Live needs approved awsLive in permissions.json and an explicit budget.
Root scope approval is also required (ZENITH_LIVE_SCOPE_FILE, or the shipped manifest).
ProductScenarioPort joins Wave 5 release scenarios; absent product journeys remain pending and exit 3.
Legacy A-J journeys: --scenario A[,B,...] --dry-run (see existing runbook).`;
export interface IO { out(text: string): void; err(text: string): void }
const defaultIO: IO = { out: s => process.stdout.write(`${s}\n`), err: s => process.stderr.write(`${s}\n`) };
async function readJson(file: string): Promise<unknown> {
  const text = await readFile(file, "utf8");
  if (Buffer.byteLength(text) > 256 * 1024) throw new Error("Bounded JSON file required");
  return JSON.parse(text);
}
async function atomic(file: string, data: unknown) {
  const temporary = `${file}.tmp`;
  await writeFile(temporary, JSON.stringify(redactAcceptance(data), null, 2) + "\n", { mode: 0o600 });
  await rename(temporary, file);
}
export async function runProductionCli(argv: readonly string[], env: EnvLike = process.env, io: IO = defaultIO, deps: { transport?: (region: string, env: EnvLike) => Promise<Transport>; source?: () => string; product?: ProductScenarioPort } = {}): Promise<number> {
  let abort: AbortController | undefined;
  const interrupt = () => abort?.abort();
  try {
    const args = parseArgs(argv, { booleans: ["plan", "help"], strings: ["account", "region", "run-id", "minutes", "db-subnet-group", "db-security-group", "permissions", "budget-usd", "out", "cleanup", "scenario"] });
    if (args.flags.has("help")) { io.out(PRODUCTION_USAGE); return 0; }
    if (args.positional.length || (args.flags.has("plan") && args.values.has("cleanup"))) throw new Error("Invalid arguments");
    const value = (key: string, name: string, fallback = "") => args.values.get(key) ?? env[name] ?? fallback;
    const cleanupFile = args.values.get("cleanup");
    let existing: Journal | undefined;
    if (cleanupFile) existing = await readJson(cleanupFile) as Journal;
    const plan: Plan = existing?.plan ?? buildPlan({
      accountId: value("account", "ZENITH_LIVE_AWS_ACCOUNT_ID", "000000000000"),
      region: value("region", "ZENITH_LIVE_REGION", "ap-south-1"),
      runId: value("run-id", "ZENITH_LIVE_AWS_RUN_ID", newRunId()),
      durationMinutes: Number(value("minutes", "ZENITH_LIVE_AWS_MINUTES", "15")),
      dbSubnetGroup: value("db-subnet-group", "ZENITH_LIVE_AWS_DB_SUBNET_GROUP", "zenith-live-sandbox"),
      dbSecurityGroup: value("db-security-group", "ZENITH_LIVE_AWS_DB_SECURITY_GROUP", "sg-00000000"),
      workloadBoundaryArn: `arn:aws:iam::${value("account", "ZENITH_LIVE_AWS_ACCOUNT_ID", "000000000000")}:policy/ZenithLiveWorkloadBoundary`,
      scenario: parseScenario(value("scenario", "ZENITH_LIVE_AWS_SCENARIO", "fixtures")),
    });
    if (args.flags.has("plan")) {
      const proposal = { scenario: plan.settings.scenario ?? "fixtures", scope: scopedRequirementIds(plan.settings, plan.requirements.map(r => r.id)), plan, permissionsProposal: { awsLive: { schema: 1, decision: "DEC-CLOUD", approvedBy: null, approvedAt: null, expiresAt: null, sourceCommit: null, accountId: plan.settings.accountId, region: plan.settings.region, runId: plan.settings.runId, planSha256: plan.sha256, maxUsd: plan.estimate.usd, maxMinutes: plan.settings.durationMinutes, grants: grantsFor(plan) } }, statement: "PLAN ONLY: no credentials read, no calls made, no live evidence. Estimated cost is provisional. Owner approval required." };
      io.out(JSON.stringify(proposal, null, 2));
      if (args.values.has("out")) {
        await mkdir(args.values.get("out")!, { recursive: true, mode: 0o700 });
        await atomic(path.join(args.values.get("out")!, "plan.json"), proposal);
      }
      return 0;
    }
    if (env.ZENITH_LIVE_AWS !== "1") throw new Error("ZENITH_LIVE_AWS=1 is required; live cloud remains deferred");
    if (plan.settings.accountId === "000000000000" || plan.settings.dbSecurityGroup === "sg-00000000") throw new Error("Explicit sandbox account and bootstrap network required");
    const permissionsFile = value("permissions", "ZENITH_LIVE_AWS_PERMISSIONS");
    if (!permissionsFile) throw new Error("Approved permissions.json FILE required");
    const permission = readPermission(await readJson(permissionsFile));
    const budget = Number(value("budget-usd", "ZENITH_LIVE_AWS_BUDGET_USD"));
    const guard = new Guard(plan, permission, budget, () => new Date(), existing?.counts, !!existing);
    const commit = deps.source ? deps.source() : (() => {
      if (execFileSync("git", ["status", "--porcelain"], { encoding: "utf8" }).trim()) throw new Error("Live evidence requires clean committed source");
      return execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    })();
    if (!/^[a-f0-9]{40}$/.test(commit)) throw new Error("Exact source commit required");
    if (commit !== permission.sourceCommit) throw new Error("Permission source commit mismatch");
    if (existing && existing.commit !== commit) throw new Error("Journal source commit mismatch");
    requireProductionScope(plan, budget, env, !!existing);
    if (!existing) reserveRunBudget(env.ZENITH_LIVE_BUDGET_FILE ?? "", { runId: plan.settings.runId, planSha256: plan.sha256, usd: plan.estimate.usd }, requireScope("aws-live", "aws", env).manifest.budgets.totalUsd);
    const journal = existing ?? newJournal(plan, guard, commit);
    if (existing?.closed) throw new Error("Journal already closed; no further cloud calls required");
    const directory = existing ? path.dirname(path.resolve(cleanupFile!)) : path.join(args.values.get("out") ?? env.ZENITH_LIVE_AWS_OUT ?? path.join(os.tmpdir(), "zenith-aws-production"), plan.settings.runId);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    // Finish local setup before resolving credentials or constructing SDK clients.
    await atomic(path.join(directory, "journal.json"), journal);
    const transport = await (deps.transport ?? sdkTransport)(plan.settings.region, env);
    abort = new AbortController();
    process.on("SIGINT", interrupt); process.on("SIGTERM", interrupt);
    await execute(plan, guard, transport, journal, { save: state => atomic(path.join(directory, "journal.json"), state), sleep: ms => new Promise(resolve => setTimeout(resolve, ms)), now: () => new Date() }, { signal: abort.signal, cleanupOnly: !!existing, product: deps.product });
    const packet = evidencePacket(journal);
    await atomic(path.join(directory, "evidence.json"), packet);
    io.out(JSON.stringify({ runId: plan.settings.runId, verdict: packet.verdict, counts: packet.counts, cleanupComplete: packet.cleanupComplete, evidence: path.join(directory, "evidence.json"), nextCommand: packet.cleanupComplete ? null : `npx tsx scripts/acceptance/aws-live.ts --permissions <same-approved-permissions.json> --cleanup ${JSON.stringify(path.join(directory, "journal.json"))}` }));
    return packet.verdict === "passed" ? 0 : packet.verdict === "failed" ? 1 : 3;
  } catch (error) {
    // Only our deterministic guard errors may be printed; SDK/file parse errors
    // could contain secret text. No provider exception or credential value leaves.
    const safe = error instanceof Error && /^(ZENITH_|Explicit |Approved |Permission |Missing bounded permission|Plan integrity|Short-lived |Use an owner|Use one absolute|One absolute|Run already reserved|Persistent total budget|Alternate |Journal |Live evidence|Exact source|Duration |Commercial |Malformed |permissions.json|Invalid arguments|Unknown AWS live scenario)/.test(error.message) ? error.message : "AWS acceptance refused or failed before completion; inspect local configuration and journal";
    io.err(safe);
    return 2;
  } finally {
    process.off("SIGINT", interrupt); process.off("SIGTERM", interrupt);
  }
}
