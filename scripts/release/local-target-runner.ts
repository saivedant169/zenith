/** Gated local scenario CLI. Join drivers use the same strict receipt protocol as built-in targets. */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { defaultExec, classifyVitest } from "./acceptance-orchestrator";
import { LOCAL_TARGETS, localEnvironment, validateLocalReceipt, requiredChecks, type LocalReceipt } from "./local-targets";
import { command, localPaths, upLocal, downLocal, readState, waitFor, type Profile } from "./local-environment";
import { mixedRehearsal } from "./local-mixed";
import { pebbleIssuance } from "./local-pebble";
import { referenceEconomics } from "../acceptance/mixed/cost-report";
import { StripeTestInvoiceProvider } from "@/lib/billing/stripe";
import { SCENARIOS } from "./scenarios";
import { runJoinedScenario } from "./local-joined";
import { readState as defaultStackState } from "../acceptance/default-stack/runtime.mjs";
import { hostEnvironment } from "../acceptance/default-stack/env.mjs";
import { sourceBinding } from "../deploy/installation.mjs";

export async function billingRehearsal(env: NodeJS.ProcessEnv): Promise<void> {
  if (readState(env).profile !== "billing") throw new Error("Needs the billing profile");
  const secretKey = ["sk", "test", randomBytes(20).toString("hex")].join("_");
  const base = "http://127.0.0.1:12111";
  await waitFor(async () => (await fetch(`${base}/v1/customers`, { headers: { authorization: `Bearer ${secretKey}` }, redirect: "error", signal: AbortSignal.timeout(3000) })).ok);
  const provider = new StripeTestInvoiceProvider({
    secretKey, apiBase: base,
    fetch: (url, init) => fetch(url, { ...init, redirect: "error" }),
  });
  const { customerId } = await provider.ensureCustomer({ workspaceId: "j15-local", idempotencyKey: `${env.ZENITH_LOCAL_RUN_ID}-customer` });
  const { providerInvoiceId } = await provider.createInvoice({
    invoiceId: "j15-local", workspaceId: "j15-local", customerId, period: "2026-10", currency: "usd", dueDays: 14,
    lines: [{ key: "base", description: "Local fixture", quantity: 1, unit: "period", unitCents: 1, amountCents: 1 }],
    idempotencyKey: `${env.ZENITH_LOCAL_RUN_ID}-invoice`,
  });
  const response = await fetch(`${base}/v1/invoices/${providerInvoiceId}`, { headers: { authorization: `Bearer ${secretKey}` }, redirect: "error", signal: AbortSignal.timeout(5000) });
  const invoice = await response.json() as { id?: string; object?: string };
  if (!response.ok || invoice.id !== providerInvoiceId || invoice.object !== "invoice" || !response.headers.has("stripe-mock-version")) throw new Error("Independent stripe-mock invoice schema read failed");
}
export async function runLocalScenario(scenarioId: string, receiptFile: string, rawEnv: Readonly<Record<string, string | undefined>>): Promise<number> {
  const { runId, root } = localPaths(rawEnv);
  const env = localEnvironment(rawEnv);
  const target = scenarioId === "billing" ? { target: "billing" } : LOCAL_TARGETS[scenarioId];
  if (!target) throw new Error("Unknown local scenario");
  if ("owner" in target && target.owner === "DRV-1") {
    const driver = scenarioId === "private-source" ? await import("./drivers/private-source") : await import("./drivers/update-rollback");
    return driver.run(receiptFile, env);
  }
  const sourceCommit = (await command(["git", "rev-parse", "HEAD"], env)).trim();
  if (!/^[a-f0-9]{40}$/.test(sourceCommit)) throw new Error("Source commit unavailable");
  if (target.target === "operated-drv2") {
    // Dedicated scenarios cannot be projected from the generic J2 journey.
    if (scenarioId === "drift-repair") return (await import("./drivers/drift-repair")).driftRepairDriver(receiptFile, env);
    if (scenarioId === "crash-partition") return (await import("./drivers/crash-partition")).crashPartitionDriver(receiptFile, env);
    throw new Error("Unknown operated driver");
  }
  if ("driver" in target && target.driver) {
    if (!existsSync(target.driver) || rawEnv.ZENITH_LOCAL_JOINED_DRIVERS !== "1") {
      process.stderr.write(`not run: needs ${target.driver} (${"owner" in target ? target.owner : "join"}), ZENITH_LOCAL_JOINED_DRIVERS=1, and the default local stack\n`);
      return 2;
    }
    if (scenarioId === "two-tenants" || scenarioId === "export") {
      if (env.ZENITH_LOCAL_DRIVER_D4 !== "1" || env.ZENITH_ACCEPTANCE_DEFAULT_STACK !== "1" || !env.ZENITH_ACCEPTANCE_DEFAULT_STACK_DIR) return 2;
      const child = await defaultExec([process.execPath, "node_modules/tsx/dist/cli.mjs", target.driver, "--run-id", runId, "--receipt", receiptFile],
        { cwd: process.cwd(), env: { ...env, ...hostEnvironment(defaultStackState(env.ZENITH_ACCEPTANCE_DEFAULT_STACK_DIR)) }, timeoutMs: 2_400_000 });
      if (child.code === 2) return 2;
      const source = sourceBinding();
      if (source.head !== sourceCommit) throw new Error("Source changed during operated run");
      const receipt = validateLocalReceipt(JSON.parse(readFileSync(receiptFile, "utf8")), { scenarioId, runId, sourceCommit, sourceDigest: source.contentSha256 });
      return child.code === 0 && receipt.checks.every(check => check.status === "passed") ? 0 : 1;
    }
    return await runJoinedScenario({ scenarioId, runId, sourceCommit, receiptFile, env });
  }
  const checks: LocalReceipt["checks"] = [];
  const pass = (id: string) => { checks.push({ id, status: "passed" }); };
  const limits = ["Local rehearsal only. No live provider/account, VPN, peering, cloud identity or cloud price measurement is established."];
  if (target.target === "mixed") {
    checks.push(...await mixedRehearsal(readState(rawEnv), scenarioId === "mixed-recovery", env));
    limits.push("Fixture deployment uses local admin setup, not a Zenith mixed-parent execution or browser approval.");
    limits.push("ClusterIP and PostgreSQL certificate authentication are checked. NetworkPolicy enforcement needs a policy-capable CNI; kindnet alone does not enforce it.");
  } else if (target.target === "pebble") {
    if (readState(rawEnv).profile !== "acme") throw new Error("Needs the ACME profile");
    await pebbleIssuance(root, env); for (const id of requiredChecks(scenarioId)) pass(id);
    limits.push("Pebble is a disposable test CA. CoreDNS validates local HTTP-01, not public DNS ownership or provider DNS writes.");
  } else if (target.target === "billing") {
    await billingRehearsal(env); for (const id of requiredChecks(scenarioId)) pass(id);
    limits.push("stripe-mock checks wire schemas only: no payment, invoice persistence, webhook delivery or durable billing schedule is proven.");
  } else if (target.target === "economics") {
    const report = referenceEconomics({ egressGb: 10, fraction: 0.5, residency: ["us"], latencyBudgetMs: 120 });
    writeFileSync(path.join(root, "economics.json"), JSON.stringify(report, null, 2), { mode: 0o600 });
    checks.push({ id: "priced", status: report.priced ? "passed" : "failed" });
    checks.push({ id: "residency", status: report.residency.satisfied ? "passed" : "failed" });
    checks.push({ id: "transfer", status: report.priced && report.transfers.length > 0 && report.transferUsd > 0 ? "passed" : "failed" });
    checks.push({ id: "latency", status: report.priced && report.latency.length > 0 ? "passed" : "failed" });
    limits.push("Dated catalog estimates of the live container-equivalent manifest; approximate latency tables. Not emulator spend, measurements or billing caps.");
  } else if (target.target === "contracts") {
    const scenario = SCENARIOS.find(s => s.id === scenarioId)!;
    const output = path.join(root, "contracts.json");
    const result = await defaultExec(["node", "node_modules/vitest/vitest.mjs", "run", ...scenario.lanes.filter(l => l.kind !== "live_sandbox").flatMap(l => [...l.files]), "--no-file-parallelism", "--maxWorkers=2", "--reporter=json", `--outputFile=${output}`], { cwd: process.cwd(), env, timeoutMs: 240_000 });
    const verdict = classifyVitest(result.code, JSON.parse(readFileSync(output, "utf8")));
    checks.push({ id: "contracts", status: verdict.status === "passed" ? "passed" : verdict.status === "failed" ? "failed" : "skipped" });
    limits.push("Tooling contract tests, not an end-to-end product journey.");
  } else throw new Error("Local target is not implemented");
  const receipt: LocalReceipt = { schema: 1, scenarioId, runId, sourceCommit, evidenceLabel: "local_rehearsal", checks, limits };
  validateLocalReceipt(receipt, { scenarioId, runId, sourceCommit });
  writeFileSync(receiptFile, JSON.stringify(receipt, null, 2), { mode: 0o600 });
  return checks.some(c => c.status === "failed") ? 1 : checks.some(c => c.status === "skipped") ? 3 : 0;
}
export async function localTargetCli(argv: readonly string[], env = process.env): Promise<number> {
  const [action, ...args] = argv;
  const value = (flag: string) => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : undefined; };
  try {
    localPaths(env); // refuse before any engine, cloud or subprocess access.
    if (action === "up") { await upLocal((value("--profile") ?? "mixed") as Profile, (value("--variant") ?? "lambda") as "lambda" | "container", env); return 0; }
    if (action === "down") { await downLocal(env); return 0; }
    if (action === "run") {
      const scenario = value("--scenario");
      if (!scenario) throw new Error("Scenario required");
      const namedRunId = value("--run-id");
      if (namedRunId && namedRunId !== env.ZENITH_LOCAL_RUN_ID) throw new Error("Run id differs from local target");
      const receipt = path.resolve(value("--receipt") ?? path.join(env.ZENITH_LOCAL_ROOT!, `${scenario}.json`));
      return await runLocalScenario(scenario, receipt, env);
    }
    process.stderr.write("usage: local-target-runner <up --profile mixed|acme|billing [--variant lambda|container]|run --scenario ID [--receipt FILE]|down>\n"); return 2;
  } catch {
    process.stderr.write("Local target refused or failed. Check the local gate, scratch ownership, profile readiness and owned engine logs. No result was accepted.\n");
    return env.ZENITH_LOCAL_TARGETS === "1" ? 1 : 2;
  }
}
if (process.argv[1] && /(?:^|[/\\])local-target-runner\.(?:ts|js)$/.test(process.argv[1])) void localTargetCli(process.argv.slice(2)).then(code => { process.exitCode = code; });
