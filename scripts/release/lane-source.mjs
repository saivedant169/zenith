#!/usr/bin/env node
/**
 * REL-02: write the original evidence source for one requirement's contract or local engine lane, from a real Vitest run
 * on a clean checkout. The source carries the run's own counts and exit code, the checkout's commit, the command and the
 * environment the caller states, and the digest of each test file. evidence-cli.mjs then binds a receipt to it.
 *
 *   node scripts/release/lane-source.mjs --requirement PROD-MIX-03 --mode contract|local --environment "<text>" \
 *     --out <source.json> [--root <checkout>] -- <vitest file and flag arguments>
 *
 * --root lets a newer copy of this script run an older checkout (for evidence at the commit a live run used). The Vitest
 * JSON report stays in a temporary file and is never written into the repository. A dirty tracked tree is refused.
 * Nothing here converts a failure, a skip or an empty run into a pass: the status comes from the counts and exit code.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

export const LANE_SOURCE_FORMAT = "zenith.release-lane-source.v1";

const git = (root, args) => {
  const result = spawnSync("git", ["-C", root, ...args], { encoding: "utf8" });
  if (result.status !== 0) throw new Error(`git ${args[0]} failed in ${root}`);
  return result.stdout.trim();
};

function vitest(root, args, reportFile) {
  const result = spawnSync(process.execPath, [path.join(root, "node_modules/vitest/vitest.mjs"), "run", ...args, "--reporter=json", "--outputFile", reportFile],
    { cwd: root, stdio: ["ignore", "ignore", "inherit"], env: process.env });
  return result.status ?? 1;
}

/** Counts from a Vitest JSON report: pending and todo tests count as skipped. */
export function countsOf(report) {
  const n = (key) => (Number.isInteger(report[key]) ? report[key] : 0);
  return { passed: n("numPassedTests"), failed: n("numFailedTests"), skipped: n("numPendingTests") + n("numTodoTests") };
}

export function statusOf(counts, exitCode) {
  if (exitCode !== 0 || counts.failed > 0) return "failed";
  if (counts.skipped > 0) return "skipped";
  return counts.passed > 0 ? "passed" : "not_run";
}

export function main(argv, seams = {}) {
  const split = argv.indexOf("--");
  const own = split < 0 ? argv : argv.slice(0, split), args = split < 0 ? [] : argv.slice(split + 1);
  const value = (flag) => { const i = own.indexOf(flag); return i < 0 ? undefined : own[i + 1]; };
  const runGit = seams.git ?? git, runVitest = seams.vitest ?? vitest;
  let scratch;
  try {
    const requirement = value("--requirement"), mode = value("--mode"), environment = value("--environment")?.trim(), out = value("--out");
    const root = path.resolve(value("--root") ?? process.cwd());
    if (!/^PROD-[A-Z]+-\d{2}$/.test(requirement ?? "")) throw new Error("--requirement PROD-XXX-NN is required");
    if (mode !== "contract" && mode !== "local") throw new Error("--mode must be contract or local");
    if (!environment || !out) throw new Error("--environment and --out are required");
    const files = args.filter((arg) => !arg.startsWith("-") && /\.(test|spec)\.[cm]?[jt]s$/.test(arg));
    if (files.length === 0) throw new Error("name at least one test file after --");
    if (runGit(root, ["status", "--porcelain", "--untracked-files=no"]) !== "") throw new Error("the checkout has uncommitted tracked changes");
    const commit = runGit(root, ["rev-parse", "HEAD"]);
    scratch = mkdtempSync(path.join(os.tmpdir(), "zenith-lane-"));
    const reportFile = path.join(scratch, "report.json");
    const exitCode = runVitest(root, args, reportFile);
    let report = {};
    try { report = JSON.parse(readFileSync(reportFile, "utf8")); } catch { /* no report: counts stay zero and the status says so */ }
    const counts = countsOf(report);
    const source = {
      format: LANE_SOURCE_FORMAT, requirements: [requirement], mode, commit, exitCode, status: statusOf(counts, exitCode), counts, environment,
      command: `vitest run ${args.join(" ")}`,
      files: files.map((file) => ({ path: file, sha256: createHash("sha256").update(readFileSync(path.join(root, file))).digest("hex") })),
    };
    writeFileSync(out, `${JSON.stringify(source, null, 2)}\n`, { flag: "wx", mode: 0o644 });
    process.stdout.write(`${JSON.stringify({ requirement, mode, commit, status: source.status, ...counts })}\n`);
    return 0;
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : "refused"}\n`);
    return 1;
  } finally {
    if (scratch) rmSync(scratch, { recursive: true, force: true });
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = main(process.argv.slice(2));
