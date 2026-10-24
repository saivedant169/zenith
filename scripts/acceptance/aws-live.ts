/** Acceptance CLI. Defaults to a no-cloud dry run for unconfirmed mutations.
 * Teardown and evidence finalization run in finally, even after partial failure.
 * No dependency installation, implicit approval, or fabricated live evidence. */
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parseArgs, UsageError } from "./args";
import { ambientAccess } from "./aws-access";
import { cleanupRuns } from "./cleanup";
import { loadLiveConfig, defaultStateBucket, LiveConfigError, type EnvLike } from "./config";
import { EvidenceRecorder } from "./evidence";
import { createHttpProbe } from "./http-probe";
import { readRunState } from "./run-state";
import { establishLiveSession, newRunId, resolveLiveTarget, LiveSafetyError, type LiveSession } from "./safety";
import { describeScenario, runScenario } from "./runner";
import { parseScenarioList, scenarioById } from "./scenarios";
import { HttpControlPlaneClient } from "./clients/control-plane";
import { temporalWorkflowClient } from "./clients/workflow";
import { createWorkerController, confirmWorkerChange } from "./clients/worker-control";
import { createMcpClient } from "./clients/mcp";
import type { ScenarioContext, ScenarioDefinition, ScenarioId } from "./types";
import { settleRunOperations, trackControlPlane } from "./lifecycle";
import { redactAcceptance } from "./redact";
import { ScopeError, requireScope } from "../release/scope";
import { runProductionCli } from "./live/cli";
import { SCENARIOS } from "./live/contracts";
import { retentionS3Port } from "./live/product/retention-s3";

export const LIVE_USAGE = `Usage: npx tsx scripts/acceptance/aws-live.ts --scenario A[,B,...] [options]
  --dry-run                 Print actions/prerequisites; no cloud calls
  --confirm-billable         Explicitly allow mutations (otherwise dry run)
  --region <region>          Override ZENITH_LIVE_REGION
  --out <parent directory>   Evidence goes in <parent>/<runId>
  --check-control-plane     In dry run, also check API prerequisites
  --help                    Show this help
Demo J runs locally: --scenario J. Live A–I have external prerequisites.
Approvals are human-only. External cleanup admission is checked after a real run; missing native quiescence authority refuses mutation.`;
export interface CliIO { out(text: string): void; err(text: string): void }
const consoleIO: CliIO = { out: (s) => process.stdout.write(`${s}\n`), err: (s) => process.stderr.write(`${s}\n`) };

/** Separated from CLI parsing for failure-path tests with simulated clients. */
export async function executeScenarios(ctx: ScenarioContext, defs: readonly ScenarioDefinition[], env: EnvLike, _cleanup: () => Promise<boolean>, io: CliIO): Promise<number> {
  let clean = true;
  try {
    const earlier: ScenarioId[] = [];
    for (const def of defs) {
      // A local planning scenario must get no cloud clients even in a mixed run.
      const scoped = def.runsLocally ? { ...ctx, session: undefined, controlPlane: undefined, workflows: undefined, worker: undefined, mcp: undefined } : ctx;
      const outcome = await runScenario(def, scoped, env, earlier);
      io.out(redactAcceptance(`${def.id}: ${outcome.status}${outcome.reason ? ` (${outcome.reason})` : ""}`, [ctx.config.apiToken ?? "", ctx.config.mcpToken ?? ""]));
      earlier.push(def.id);
    }
  } catch (err) {
    ctx.evidence.fail("harness", "execution", "Scenario execution completed", err instanceof Error ? err.message : "unexpected error");
  } finally {
    // Local observation-only runs have no external teardown. They finalize
    // without invoking caller cleanup hooks or a sweep. For external runs,
    // restarting a worker can resume accepted work and requires the same
    // missing native authority as deletion; neither projection nor an empty
    // local inventory supplies it.
    const external = defs.some((d) => !d.runsLocally) || ctx.session !== undefined;
    if (external) {
      await settleRunOperations(ctx);
      clean = false;
      ctx.evidence.note("Cleanup admission refused: authentic native resolution of accepted mutations and worker/provider quiescence is required. Recovery hooks and destructive sweeps were not run; the cleanup CLI retains read-only discovery.");
    }
    // Local J needs no cleanup check: its ten criteria are the whole observation.
    if (defs.some((d) => !d.runsLocally)) {
      if (clean) ctx.evidence.pass("harness", "cleanup", "All cleanup hooks and the applicable tag sweep completed");
      else ctx.evidence.fail("harness", "cleanup", "All cleanup hooks and the applicable tag sweep completed", "Cleanup incomplete; inspect the durable blocker and resolve accepted mutations before authorizing teardown.");
    }
    if (!clean) io.err("*** CLEANUP INCOMPLETE: RESOURCES MAY STILL BE BILLING. Inspect evidence and resolve accepted mutations; repeated cleanup is not clearance. ***");
    const summary = await ctx.evidence.finalize();
    io.out(`${summary.statement}\nEvidence: ${ctx.evidence.dir}\nVerdict: ${summary.verdict}`);
  }
  return clean && ctx.evidence.summary().verdict === "passed" ? 0 : 1;
}

export async function runLiveCli(argv: readonly string[], env: EnvLike = process.env, io: CliIO = consoleIO): Promise<number> {
  // Keep legacy A-J journeys intact. Invocations without --scenario, or naming only
  // production scenarios, use the explicit-budget envelope; --plan is credential-free.
  const named = argv.flatMap((arg, i) => arg === "--scenario" ? [argv[i + 1] ?? ""] : arg.startsWith("--scenario=") ? [arg.slice("--scenario=".length)] : []);
  if (named.every(name => (SCENARIOS as readonly string[]).includes(name))) {
    // The retention-s3 product path runs only when the workflow started the Zenith stack on this runner (ZENITH_LIVE_PRODUCT=1).
    const selected = named.length ? named.join(",") : (env.ZENITH_LIVE_AWS_SCENARIO ?? "fixtures");
    const product = selected === "retention-s3" && env.ZENITH_LIVE_PRODUCT === "1" ? retentionS3Port(env) : undefined;
    return runProductionCli(argv, env, io, { product });
  }
  try {
    const args = parseArgs(argv, { booleans: ["dry-run", "confirm-billable", "check-control-plane", "help"], strings: ["scenario", "region", "out"] });
    if (args.flags.has("help")) { io.out(LIVE_USAGE); return 0; }
    if (args.positional.length) throw new UsageError("Positional arguments are not accepted.");
    const selection = args.values.get("scenario");
    if (!selection) throw new UsageError("--scenario is required.");
    const ids = parseScenarioList(selection);
    const defs = ids.map(scenarioById);
    const config = loadLiveConfig(env, { region: args.values.get("region") });
    const confirm = args.flags.has("confirm-billable");
    const mutating = defs.some((d) => d.mutates);
    const dry = args.flags.has("dry-run") || (mutating && !confirm);
    const runId = newRunId();
    const cpClient = (url: string | undefined) => url ? new HttpControlPlaneClient({ baseUrl: url, token: config.apiToken, workspaceId: config.workspaceId }) : undefined;
    if (dry) {
      if (mutating && !confirm && !args.flags.has("dry-run")) io.out("dry run: pass --confirm-billable to run for real");
      const evidence = new EvidenceRecorder({ runId, scenarios: ids, provenance: "dry_run", outDir: args.values.get("out"), secrets: [config.apiToken ?? "", config.mcpToken ?? ""] });
      await evidence.init();
      try {
        const earlier: ScenarioId[] = [];
        for (const def of defs) {
          const report = await describeScenario(def, { plan: { runId, config, region: config.region, accountId: config.awsAccountId }, env, config, earlier, inRun: ids, checkControlPlane: args.flags.has("check-control-plane"), controlPlane: args.flags.has("check-control-plane") ? cpClient(def.id === "I" ? config.managedApiUrl : config.apiUrl) : undefined }, evidence);
          io.out(report.text); earlier.push(def.id);
        }
      } finally { const s = await evidence.finalize(); io.out(`${s.statement}\nEvidence: ${evidence.dir}`); }
      return 0;
    }
    const local = defs.every((d) => d.runsLocally);
    const aws = defs.some((d) => d.needs.cloud === "aws");
    // PROD-REL-04: a live run loads the approved scope manifest and is granted BEFORE its first cloud call; its budget is clamped to the approved per-run budget.
    if (!local) {
      const scope = requireScope("aws-live", aws ? "aws" : "control_plane", env);
      scope.assertGrant("aws-live", aws ? "aws" : "control_plane", mutating ? "create_disposable" : "read");
      config.maxMonthlyUsd = Math.min(config.maxMonthlyUsd, scope.manifest.budgets.perRunUsd);
    }
    // Legacy AWS clients cannot supply the exact production request envelope.
    // Keep local J and planning reachable; no live path may bypass DEC-CLOUD.
    if (aws) throw new UsageError("Legacy AWS live journeys require the production permission/guard join; use --plan and the gated production harness until that join is assembled.");
    // Mixed non-AWS endpoints need different clients and teardown contracts.
    if (defs.some((d) => d.id === "I") && defs.some((d) => d.needs.controlPlane && d.id !== "I")) throw new UsageError("Run I separately: its managed API origin differs from the other scenarios.");
    let session: LiveSession | undefined;
    if (aws) {
      const target = resolveLiveTarget(config);
      session = await establishLiveSession({ config, access: ambientAccess(target), mutating, confirmBillable: confirm, runId });
    }
    const evidence = new EvidenceRecorder({ runId, scenarios: ids, provenance: local ? "local" : "live", outDir: args.values.get("out"), account: session?.accountId, region: session?.region, secrets: [config.apiToken ?? "", config.mcpToken ?? ""] });
    await evidence.init();
    // Context construction stays inside the protected execution scope too.
    const ctx: ScenarioContext = {
      runId, config, evidence, session, confirmBillable: confirm, probe: createHttpProbe(), state: new Map(), signal: new AbortController().signal,
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)), now: () => new Date(),
      log: (s) => io.out(redactAcceptance(s, [config.apiToken ?? "", config.mcpToken ?? ""])), scratchDir: os.tmpdir(), runStateFile: path.join(evidence.dir, "run-state.json"),
    };
    try {
      ctx.scratchDir = await mkdtemp(path.join(os.tmpdir(), "zenith-live-"));
      if (!local) {
        const client = cpClient(defs.some((d) => d.id === "I") ? config.managedApiUrl : config.apiUrl);
        if (client) ctx.controlPlane = trackControlPlane(client, ctx);
        if (defs.some((d) => d.needs.temporal)) ctx.workflows = temporalWorkflowClient();
        if (config.workerControl) ctx.worker = createWorkerController(config.workerControl, { confirm: (message) => confirmWorkerChange(message, runId) });
        if (config.mcpUrl) ctx.mcp = createMcpClient({ url: config.mcpUrl, token: config.mcpToken });
      }
    } catch (err) { evidence.fail("harness", "setup", "Harness clients initialized", err instanceof Error ? err.message : "error"); }
    const sweep = async () => {
      if (!session) { evidence.note("No AWS session: no AWS sweep applicable. Scenario hooks handle non-AWS teardown."); return true; }
      const report = await cleanupRuns({ access: session.aws(), selector: { runId }, dryRun: false, stateBucket: config.stateBucket ?? defaultStateBucket(session.accountId, session.region), workspaceId: config.workspaceId, stateKmsKeyArn: config.stateKmsKeyArn, loadRunState: () => readRunState(ctx.runStateFile, { runId, accountId: session.accountId, region: session.region }), log: ctx.log });
      evidence.note(`AWS cleanup report: ${JSON.stringify(report)}`);
      // Full JSON report is a structured artifact, not a truncated note.
      const { writeFile } = await import("node:fs/promises");
      const { redactDeep } = await import("@/lib/credentials/redact");
      await writeFile(path.join(evidence.dir, "cleanup.json"), JSON.stringify(redactDeep(report), null, 2), { mode: 0o600 });
      return report.ok;
    };
    return await executeScenarios(ctx, evidence.hasCheck("harness", "setup") ? [] : defs, env, sweep, io);
  } catch (err) {
    io.err(redactAcceptance(`${err instanceof Error ? err.name : "Error"}: ${err instanceof Error ? err.message : "unexpected error"}`, [env.ZENITH_LIVE_API_TOKEN ?? "", env.ZENITH_LIVE_MCP_TOKEN ?? ""]));
    return err instanceof UsageError || err instanceof LiveConfigError || err instanceof LiveSafetyError || err instanceof ScopeError ? 2 : 1;
  }
}

if (process.argv[1] && /(?:^|[/\\])aws-live\.(?:ts|mts|js|mjs|cjs)$/.test(process.argv[1])) void runLiveCli(process.argv.slice(2)).then((code) => { process.exitCode = code; });
