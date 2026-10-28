/** Credential-free workflow preflight. Reuses the same planner and guard; a
 * credential provider that throws proves this step cannot reach any AWS API. */
import { readFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { buildPlan, parseLane, parseScenario } from "./plan";
import { Guard, readPermission } from "./guard";
import { requireProductionScope } from "./scope";
import type { EnvLike } from "../config";

export async function preflight(env: EnvLike) {
  if (env.ZENITH_LIVE_AWS !== "1" || !env.ZENITH_LIVE_AWS_PERMISSIONS) throw new Error("Explicit AWS gate and permissions file required");
  const document = await readFile(env.ZENITH_LIVE_AWS_PERMISSIONS, "utf8");
  if (document.length > 256 * 1024) throw new Error("Bounded permissions file required");
  const plan = buildPlan({ accountId: env.ZENITH_LIVE_AWS_ACCOUNT_ID ?? "", region: env.ZENITH_LIVE_REGION ?? "", runId: env.ZENITH_LIVE_AWS_RUN_ID ?? "", durationMinutes: Number(env.ZENITH_LIVE_AWS_MINUTES ?? "15"), dbSubnetGroup: env.ZENITH_LIVE_AWS_DB_SUBNET_GROUP ?? "", dbSecurityGroup: env.ZENITH_LIVE_AWS_DB_SECURITY_GROUP ?? "", workloadBoundaryArn: `arn:aws:iam::${env.ZENITH_LIVE_AWS_ACCOUNT_ID}:policy/ZenithLiveWorkloadBoundary`, scenario: parseScenario(env.ZENITH_LIVE_AWS_SCENARIO ?? "fixtures"), lane: parseLane(env.ZENITH_LIVE_AWS_LANE) });
  const permission = readPermission(JSON.parse(document));
  new Guard(plan, permission, Number(env.ZENITH_LIVE_AWS_BUDGET_USD));
  requireProductionScope(plan, Number(env.ZENITH_LIVE_AWS_BUDGET_USD), env);
  if (execFileSync("git", ["status", "--porcelain"], { encoding: "utf8" }).trim() || execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim() !== permission.sourceCommit) throw new Error("Clean approved source required before OIDC");
  return plan.sha256;
}
if (/(?:^|[/\\])preflight\.[cm]?[jt]s$/.test(process.argv[1] ?? "")) {
  void preflight(process.env).then(hash => process.stdout.write(`Permission/budget preflight passed for plan ${hash}; no AWS calls\n`)).catch(() => { process.stderr.write("Owner-approved AWS plan/permission/budget preflight refused; no credentials requested\n"); process.exitCode = 2; });
}
