/** PROD-REL-04 drill: planner shape, drill logic over a fake harness, and the offline verifier. CONTRACT ONLY: no AWS. */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { allCalls, buildPlan, digest, scopedRequirementIds } from "../../scripts/acceptance/live/plan";
import { grantsFor } from "../../scripts/acceptance/live/guard";
import { resumeCommand } from "../../scripts/acceptance/live/cli";
import { RunCheckpoint, fileStore } from "../../scripts/release/checkpoint";
import { liveSeams, planFromEnv, rel04Layout, runRel04Drill, type DrillChild, type DrillSeams, type Rel04Layout } from "../../scripts/acceptance/live/drill/rel-04";
import { loadRel04Files, verifyRel04Files } from "../../scripts/acceptance/live/drill/verify-rel-04";
import type { Journal } from "../../scripts/acceptance/live/contracts";

const runId = "zlive-202610080000-abcd";
const commit = "a".repeat(40);
const accountId = "123456789012";
const env = {
  ZENITH_LIVE_AWS_ACCOUNT_ID: accountId, ZENITH_LIVE_REGION: "ap-south-1", ZENITH_LIVE_AWS_RUN_ID: runId, ZENITH_LIVE_AWS_MINUTES: "15",
  ZENITH_LIVE_AWS_DB_SUBNET_GROUP: "zenith-live-sandbox", ZENITH_LIVE_AWS_DB_SECURITY_GROUP: "sg-12345678",
};
const plan = planFromEnv(env);
const bucket = `zenith-${runId}-${accountId}`;
const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

type Behavior = { a: "intent" | "silent"; b: "close" | "creates"; c: "refuse" | "writes" };
const honest: Behavior = { a: "intent", b: "close", c: "refuse" };

/** A fixture directory with the approved permission envelope bound to this exact plan and commit. */
function prepare() {
  const dir = mkdtempSync(path.join(tmpdir(), "rel04-drill-")); directories.push(dir);
  const permissionsFile = path.join(dir, "permissions.json");
  const awsLive = { schema: 1, decision: "DEC-CLOUD", approvedBy: "Owner fixture", approvedAt: "2026-10-07T23:59:00Z", expiresAt: "2026-10-08T01:00:00Z", sourceCommit: commit, accountId, region: "ap-south-1", runId, planSha256: plan.sha256, maxUsd: 10, maxMinutes: 20, grants: grantsFor(plan) };
  writeFileSync(permissionsFile, JSON.stringify({ awsLive }));
  const budgetFile = path.join(dir, "ledger.json");
  const layout = rel04Layout(runId, path.join(dir, "out"));
  return { dir, permissionsFile, budgetFile, layout, permission: awsLive };
}

/** Seams with the real filesystem and a fake harness process. kill() settles the child like SIGKILL would. */
function seamsFor(setup: ReturnType<typeof prepare>, behavior: Behavior, aws?: { headBucket: string; ssmValue?: string }): DrillSeams {
  const resolvers = new Map<DrillChild, (code: number | null) => void>();
  const settled = (code: number | null): DrillChild => ({ exit: Promise.resolve(code) });
  const pending = (): DrillChild => { let resolve!: (code: number | null) => void; const child: DrillChild = { exit: new Promise(r => { resolve = r; }) }; resolvers.set(child, resolve); return child; };
  const flag = (args: readonly string[], name: string) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
  const writeJournal = (file: string, journal: Journal) => { writeFileSync(file, JSON.stringify(journal)); };
  const blank = (): Journal => ({ schema: 1, provenance: "contract", plan, permissionSha256: digest(setup.permission), commit, startedAt: "2026-10-08T00:00:00.000Z", attempted: [], responses: {}, checks: [], counts: {}, closed: false });
  const fake = (args: readonly string[], childEnv: Readonly<Record<string, string | undefined>>): DrillChild => {
    if (args.includes("--cleanup")) {
      const journalFile = flag(args, "--cleanup")!;
      const journal = JSON.parse(readFileSync(journalFile, "utf8")) as Journal;
      if (behavior.b === "creates") journal.counts["s3-create"] = (journal.counts["s3-create"] ?? 0) + 1;
      journal.closed = true;
      writeJournal(journalFile, journal);
      const dir = path.dirname(journalFile);
      writeFileSync(path.join(dir, "evidence.json"), JSON.stringify({ cleanupComplete: true, planSha256: plan.sha256, commit, scope: ["PROD-REL-04"] }));
      const store = fileStore(path.join(dir, "checkpoint.json"));
      const { checkpoint } = RunCheckpoint.open({ store, runId, harness: "aws-live", scopeDigest: digest("scope"), steps: ["run"] });
      checkpoint.begin("run"); checkpoint.setNextCommands([]); checkpoint.complete("run", "journal closed; cleanup complete", digest(journal));
      return settled(0);
    }
    const out = flag(args, "--out")!;
    if (out.endsWith("-refused")) return settled(childEnv.ZENITH_LIVE_BUDGET_FILE === setup.budgetFile ? 2 : 0);
    if (out.endsWith("-replay")) {
      const dir = path.join(out, runId); mkdirSync(dir, { recursive: true });
      const journal = blank();
      if (behavior.c === "writes") { journal.attempted = ["s3"]; journal.counts = { "run-claim": 1, "s3-create": 1 }; journal.responses = { "s3-create": { Bucket: bucket } }; }
      else { journal.counts = { "run-claim": 1 }; journal.checks = [{ id: "execution", status: "failed", scope: "aws_fixture", reason: "refused" }]; journal.closed = true; }
      writeJournal(path.join(dir, "journal.json"), journal);
      return settled(1);
    }
    // The first harness run: a silent one dies before journaling anything.
    if (behavior.a === "silent") return settled(2);
    const dir = path.join(out, runId); mkdirSync(dir, { recursive: true });
    const journalFile = path.join(dir, "journal.json");
    const journal = blank();
    journal.attempted = ["s3"]; journal.responses = { "s3-create": { Bucket: bucket } }; journal.counts = { "run-claim": 1, "s3-create": 1 };
    writeJournal(journalFile, journal);
    // CI-shaped short cwd and FILE references: the shared checkpoint caps each next command at 500 characters.
    const next = resumeCommand({ cwd: "/w/zenith", budgetUsd: 10, scopeFile: "/s/scope.json", sessionFile: "/s/session.json", permissionsFile: setup.permissionsFile, journalFile });
    const { checkpoint } = RunCheckpoint.open({ store: fileStore(path.join(dir, "checkpoint.json")), runId, harness: "aws-live", scopeDigest: digest("scope"), steps: ["run"] });
    checkpoint.begin("run"); checkpoint.setNextCommands([next]);
    writeFileSync(path.join(dir, "next-command.txt"), `${next}\n`);
    const child = pending();
    return child;
  };
  const base2 = liveSeams(process.env);
  return {
    ...base2,
    env: { ...env, ZENITH_LIVE_BUDGET_FILE: setup.budgetFile },
    head: () => commit,
    spawn: (args, childEnv) => fake(args, childEnv),
    kill: (child) => resolvers.get(child)?.(null),
    sleep: async () => undefined,
    now: () => Date.parse("2026-10-08T00:00:00Z"),
    readAws: async () => aws ?? { headBucket: "NotFound", ssmValue: runId },
  };
}
function drill(setup: ReturnType<typeof prepare>, behavior: Behavior, aws?: { headBucket: string; ssmValue?: string }) {
  return runRel04Drill(seamsFor(setup, behavior, aws), setup.layout, { plan, permissionsFile: setup.permissionsFile, budgetFile: setup.budgetFile });
}
const verifyDisk = (setup: ReturnType<typeof prepare>) => verifyRel04Files(runId, loadRel04Files(setup.layout, setup.permissionsFile));

describe("PROD-REL-04 drill plan (offline)", () => {
  const settings = { accountId, region: "ap-south-1", runId, durationMinutes: 15, dbSubnetGroup: "zenith-live-sandbox", dbSecurityGroup: "sg-12345678", workloadBoundaryArn: `arn:aws:iam::${accountId}:policy/ZenithLiveWorkloadBoundary` };
  it("plans rel-04 as one S3 fixture, scoped to PROD-REL-04 only, with retention-s3 pricing and no other family", () => {
    const p = buildPlan({ ...settings, scenario: "rel-04" }), retention = buildPlan({ ...settings, scenario: "retention-s3" });
    expect(p.settings.scenario).toBe("rel-04");
    expect(p.fixtures.map(f => f.family)).toEqual(["s3"]);
    expect(scopedRequirementIds(p.settings, p.requirements.map(r => r.id))).toEqual(["PROD-REL-04"]);
    expect(p.estimate.usd).toBe(retention.estimate.usd);
    expect(p.estimate.cleanupReserveUsd).toBe(retention.estimate.cleanupReserveUsd);
    expect(p.sha256).not.toBe(retention.sha256);
    const calls = allCalls(p);
    expect(calls.some(c => /(^|\:)(rds|lambda|iam|route53|secretsmanager)\b/.test(c.service) || /Create(Role|Function|Cluster|DBInstance|HostedZone)|Delete(Role|Function|Cluster|DBInstance|HostedZone)|Invoke/.test(c.command))).toBe(false);
    expect(calls.filter(c => c.id.startsWith("s3-") && /Create|Put|Delete/.test(c.command)).map(c => c.id)).toEqual(expect.arrayContaining(["s3-create", "s3-tag", "s3-put", "s3-delete-object", "s3-delete"]));
    // rel-04 has no retention drain: that is retention-s3's own teardown.
    expect(p.fixtures[0].teardown.some(c => c.id.startsWith("s3-retention"))).toBe(false);
  });
  it("keeps the rel-04 plan digest distinct from the pinned fixtures and retention-s3 plans", () => {
    expect(buildPlan({ ...settings, scenario: "rel-04" }).sha256).not.toBe(buildPlan({ ...settings }).sha256);
  });
});

describe("PROD-REL-04 drill logic (fake harness, real files)", () => {
  it("passes end to end and the offline verifier re-derives every step from disk", async () => {
    const setup = prepare();
    const receipt = await drill(setup, honest);
    expect(receipt).toMatchObject({ schema: 1, scenario: "rel-04", runId, commit, planSha256: plan.sha256, verdict: "passed" });
    expect(Object.values(receipt.steps).map(s => s.passed)).toEqual([true, true, true, true]);
    expect(receipt.steps.D).toMatchObject({ headBucket: "NotFound", ssmValueMatchesRunId: true });
    expect(receipt.notes).toContain("fresh budget file in C deliberately bypasses the local book");
    expect(verifyDisk(setup)).toEqual([]);
  });
  it("refuses a kill before the s3 create intent, and then runs no resume, replay or readback", async () => {
    const setup = prepare();
    const receipt = await drill(setup, { ...honest, a: "silent" }, { headBucket: "Exists", ssmValue: "other" });
    expect(receipt.verdict).toBe("failed");
    expect(receipt.steps.A).toMatchObject({ passed: false, reason: expect.stringContaining("child ended before the s3 create intent") });
    expect(receipt.steps.B.passed).toBe(false);
    expect(receipt.steps.C.passed).toBe(false);
    expect(receipt.steps.D.passed).toBe(false);
    expect(verifyDisk(setup).length).toBeGreaterThan(0);
  });
  it("refuses a resume that creates anything new, and runs no replay", async () => {
    const setup = prepare();
    const receipt = await drill(setup, { ...honest, b: "creates" });
    expect(receipt.steps.A.passed).toBe(true);
    expect(receipt.steps.B).toMatchObject({ passed: false, reason: "a create counter increased during resume" });
    expect(receipt.steps.C.passed).toBe(false);
    expect(verifyDisk(setup).length).toBeGreaterThan(0);
  });
  it("refuses a replay that writes an s3 create past the account-side run claim", async () => {
    const setup = prepare();
    const receipt = await drill(setup, { ...honest, c: "writes" });
    expect(receipt.steps.B.passed).toBe(true);
    expect(receipt.steps.C).toMatchObject({ passed: false, reason: "replay attempted an s3 create" });
    expect(receipt.verdict).toBe("failed");
  });
  it("refuses to overwrite an earlier drill for the same run id", async () => {
    const setup = prepare();
    await drill(setup, honest);
    await expect(drill(setup, honest)).rejects.toThrow(/already exists/);
  });
  it("fails the readback when the run bucket is still present", async () => {
    const setup = prepare();
    const receipt = await drill(setup, honest, { headBucket: "Exists", ssmValue: runId });
    expect(receipt.steps.D).toMatchObject({ passed: false, headBucket: "Exists", ssmValueMatchesRunId: true });
  });
});

describe("PROD-REL-04 offline verifier (tamper checks)", () => {
  async function passedReceipt() {
    const setup = prepare();
    await drill(setup, honest);
    return setup;
  }
  const edit = (file: string, change: (receipt: Record<string, unknown>) => void) => {
    const receipt = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
    change(receipt);
    writeFileSync(file, JSON.stringify(receipt));
  };
  it("accepts the untouched receipt", async () => {
    expect(verifyDisk(await passedReceipt())).toEqual([]);
  });
  it("rejects a receipt whose plan digest is wrong", async () => {
    const setup = await passedReceipt();
    edit(setup.layout.receipt, r => { r.planSha256 = "c".repeat(64); });
    expect(verifyDisk(setup).length).toBeGreaterThan(0);
  });
  it("rejects a receipt whose commit differs from the journal and the permission", async () => {
    const setup = await passedReceipt();
    edit(setup.layout.receipt, r => { r.commit = "b".repeat(40); });
    expect(verifyDisk(setup)).toEqual(expect.arrayContaining([expect.stringContaining("journal source commit differs from the receipt")]));
  });
  it("rejects a receipt that is missing a step", async () => {
    const setup = await passedReceipt();
    edit(setup.layout.receipt, r => { delete (r.steps as Record<string, unknown>).C; });
    expect(verifyDisk(setup)).toEqual(["receipt is missing or malformed"]);
  });
  it("rejects a passed verdict over a step that does not hold", async () => {
    const setup = await passedReceipt();
    edit(setup.layout.receipt, r => { (r.steps as Record<string, { passed: boolean }>).D.passed = false; });
    expect(verifyDisk(setup).length).toBeGreaterThan(0);
  });
  it("rejects a receipt that drops the deliberate budget-bypass note", async () => {
    const setup = await passedReceipt();
    edit(setup.layout.receipt, r => { r.notes = []; });
    expect(verifyDisk(setup)).toContain("receipt omits the deliberate budget-book bypass note");
  });
  it("rejects a permission file that approves a different plan", async () => {
    const setup = await passedReceipt();
    const doc = JSON.parse(readFileSync(setup.permissionsFile, "utf8")) as { awsLive: { planSha256: string } };
    doc.awsLive.planSha256 = "d".repeat(64);
    writeFileSync(setup.permissionsFile, JSON.stringify(doc));
    expect(verifyDisk(setup).length).toBeGreaterThan(0);
  });
  it("rejects a resume command that does not carry the journal path", async () => {
    const setup = await passedReceipt();
    writeFileSync(setup.layout.killNextCommand, "cd /x && npx tsx scripts/acceptance/aws-live.ts --cleanup '/elsewhere/journal.json'\n");
    expect(verifyDisk(setup).some(f => f.includes("recorded next command"))).toBe(true);
  });
});

describe("PROD-REL-04 layout", () => {
  it("refuses a relative output directory and keeps the replay and refused trees beside the owner OUT", () => {
    expect(() => rel04Layout(runId, "relative/out")).toThrow(/Absolute/);
    const layout: Rel04Layout = rel04Layout(runId, "/owner/out");
    expect(layout.d1).toBe(path.join("/owner/out", runId));
    expect(layout.replayJournal).toBe(path.join("/owner/out-replay", runId, "journal.json"));
    expect(layout.refusedJournal).toBe(path.join("/owner/out-refused", runId, "journal.json"));
  });
});
